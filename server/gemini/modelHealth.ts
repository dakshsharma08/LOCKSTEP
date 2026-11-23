/**
 * Per-model cooldown ("don't call a model we know is failing").
 *
 * Why (for learners): on the free tier Google often answers 503 "high demand" or 429 "quota exceeded"
 * for a while. Calling the same model again on every new plan only burns quota and time. So after a
 * failure we remember the model as COOLING for a while, and the fallback chain skips it WITHOUT making a
 * request (gemini/fallback.ts):
 *   • 503 / 500 / 502 / 504, a non-quota 429, no answer, a stall or a cut-off answer:
 *       exponential backoff with jitter: up to 30 s, 60 s, 120 s … (max 10 min), reset on the first success;
 *   • a quota 429: Google's own retryDelay when it gives one; a DAILY quota (quota id "…PerDay…") resets at
 *       midnight Pacific time, but we check again at most once an hour in case the reset is late;
 *   • 400 / 401 / 403 / 404 and cancellations: no cooldown (they are not about load; they are reported).
 * The memory is per server instance (a fresh serverless instance may spend one request re-checking).
 */
import { addDays, dayKey, localToUtcIso } from '../../shared/time';
import type { AppError } from '../lib/errors';
import { googleErrorInfo } from '../lib/redact';
import { isIncompleteAnswerError } from './call';
import { isStreamStall, isTemporaryUnavailable } from './fallback';

export interface CooldownSettings {
  /** First cooldown after a temporary failure; doubles per consecutive failure. 0 disables cooldowns. */
  baseMs: number;
  /** Longest cooldown for temporary failures. */
  maxMs: number;
  /** A daily quota is re-checked at most this often (Google's reset can be late). */
  dailyRecheckMs: number;
}

export const DEFAULT_COOLDOWN: CooldownSettings = {
  baseMs: 30_000,
  maxMs: 10 * 60_000,
  dailyRecheckMs: 60 * 60_000,
};

interface Entry {
  /** Consecutive temporary failures (drives the exponential backoff). */
  failures: number;
  /** Epoch ms until which the model is skipped. */
  until: number;
  /** Short, log-safe reason, e.g. "HTTP 503" or "daily quota". */
  reason: string;
}

/** "37s" / "1.5s" (google.rpc.RetryInfo) → ms. */
function parseDelay(d: string | undefined): number | null {
  const m = d ? /^(\d+(?:\.\d+)?)s$/.exec(d.trim()) : null;
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** The next midnight in Pacific time (when Google resets requests-per-day quotas), as epoch ms. */
export function nextPacificMidnight(nowMs: number): number {
  const tz = 'America/Los_Angeles';
  return new Date(localToUtcIso(addDays(dayKey(nowMs, tz), 1), '00:00', tz).iso).getTime();
}

export class ModelHealth {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly settings: CooldownSettings = DEFAULT_COOLDOWN,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** Milliseconds this model is still cooling down (0 = available). */
  coolingFor(model: string): number {
    const e = this.entries.get(model);
    return e ? Math.max(0, e.until - this.now()) : 0;
  }

  reasonFor(model: string): string | null {
    return this.entries.get(model)?.reason ?? null;
  }

  markSuccess(model: string): void {
    this.entries.delete(model);
  }

  /**
   * Record a failed request. `raw` is the error as thrown (it carries Google's body), `mapped` our AppError.
   * Returns the cooldown applied in ms (0 = none).
   */
  markFailure(model: string, raw: unknown, mapped: AppError): number {
    if (this.settings.baseMs <= 0) return 0;
    const now = this.now();
    const google = googleErrorInfo(raw);
    const prev = this.entries.get(model);

    let ms: number;
    let reason: string;
    if (
      google?.httpStatus === 429 &&
      /quota/i.test(`${google.googleMessage ?? ''} ${(google.quotaIds ?? []).join(' ')}`)
    ) {
      if ((google.quotaIds ?? []).some((q) => /PerDay/i.test(q))) {
        ms = Math.min(nextPacificMidnight(now) - now, this.settings.dailyRecheckMs);
        reason = 'daily quota';
      } else {
        ms = parseDelay(google.retryDelay) ?? 60_000;
        reason = 'quota';
      }
      ms = Math.max(1_000, ms);
      this.entries.set(model, { failures: (prev?.failures ?? 0) + 1, until: now + ms, reason });
      return ms;
    }

    const temporary =
      isTemporaryUnavailable(mapped) || isStreamStall(mapped) || isIncompleteAnswerError(mapped);
    if (!temporary) return 0;
    const failures = (prev?.failures ?? 0) + 1;
    const exp = Math.min(this.settings.maxMs, this.settings.baseMs * 2 ** (failures - 1));
    ms = Math.round(exp / 2 + this.random() * (exp / 2)); // "equal jitter", like lib/retry.ts
    const retryDelay = parseDelay(google?.retryDelay);
    if (retryDelay !== null) ms = Math.max(ms, retryDelay); // never sooner than Google asked
    reason = google?.httpStatus
      ? `HTTP ${google.httpStatus}`
      : mapped.code === 'TIMEOUT'
        ? 'no answer'
        : 'cut off';
    this.entries.set(model, { failures, until: now + ms, reason });
    return ms;
  }
}
