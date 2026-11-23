/**
 * Model fallback for TEMPORARY Gemini outages (HTTP 503 "high demand", 500/502/504, 429, or a request
 * that Google accepted but never answered).
 *
 * Why (for learners): `gemini-3.8-flash` stays the primary model. But Google sometimes answers 503
 * UNAVAILABLE for a model while other models work fine, and a deadline-driven app should not just give
 * up. So when the primary is temporarily unavailable we try a small number of alternatives, then stop.
 *
 * Rules (each one is covered by a test):
 *   • Only TEMPORARY failures on the primary trigger a fallback. A 400 (bad request), 401/403 (key) or
 *     404 (model missing) would fail on every model, so we show it instead of hiding it.
 *   • The alternatives come from the models YOUR key can actually call (models.list): a preferred order
 *     (gemini-3.5-flash, then gemini-3.6-flash) is applied only to models the key lists, so a retired model
 *     drops out by itself. GEMINI_MODEL_FALLBACKS overrides it.
 *   • Hard cap on upstream calls per plan: 1 + primaryRetries + fallbacks (default 4 calls in total).
 *     503s also count against rate limits, so hammering a struggling API makes things worse.
 *   • A model that STALLS mid-answer (no chunk within the limit, or its own stream time used up) is
 *     abandoned and the next model starts from scratch; the browser is told to drop the partial output.
 *   • An alternative that is itself temporarily unavailable, or not available to this key (404), is
 *     skipped. Any OTHER error from an alternative (a 400 such as "schema has too many states", a 403…)
 *     stops the chain and is reported as it is, with the earlier attempts listed: trying yet another
 *     model would hide a real problem behind a misleading "Gemini is busy".
 */
import { AppError } from '../lib/errors';
import { redactSecrets } from '../lib/redact';

/** Model ids go into URL paths, so only plain names are accepted. */
export const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{2,62}$/;

export interface FallbackConfig {
  /** null = not set (pick automatically); [] = explicitly disabled; otherwise the user's list. */
  models: string[] | null;
  /** Entries that were ignored because they are not plain model names. */
  rejected: string[];
}

/** Parse GEMINI_MODEL_FALLBACKS ("gemini-3.6-flash,gemini-3.5-flash" | "none" | empty). */
export function parseFallbackList(raw: string | null | undefined): FallbackConfig {
  const t = raw?.trim();
  if (!t) return { models: null, rejected: [] };
  if (/^(none|off|disabled?)$/i.test(t)) return { models: [], rejected: [] };
  const all = t
    .split(',')
    .map((s) => s.trim().replace(/^models\//, ''))
    .filter(Boolean);
  const models = [...new Set(all.filter((m) => MODEL_NAME.test(m)))];
  return { models, rejected: all.filter((m) => !MODEL_NAME.test(m)) };
}

// Un-suffixed stable names only (gemini-3.6-flash, gemini-3.5-flash-lite): never preview/exp/latest/image/tts/live.
const STABLE = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/;

interface Candidate {
  name: string;
  major: number;
  minor: number;
  lite: boolean;
}

function parseCandidate(raw: string): Candidate | null {
  const name = raw.replace(/^models\//, '');
  const m = STABLE.exec(name);
  return m ? { name, major: Number(m[1]), minor: Number(m[2] ?? 0), lite: !!m[3] } : null;
}

/**
 * The default fallback order, from REAL diagnostics on the developer's key (2026-11-23):
 *   • with the primary `gemini-3.8-flash` answering 503 / later 429 (free-tier quota):
 *       gemini-3.7-flash 503 / timeout; gemini-2.5-flash 404 (not available to new users);
 *   • with the full plan request (prompt + response schema, commit ba2deac):
 *       gemini-3.5-flash  valid plan JSON in ~78 s;
 *       gemini-3.6-flash  answers small requests, but the plan stream stalled after 13 chunks.
 * So 3.5 is tried first, then 3.6. A preferred model is only used if the key's own model list contains
 * it, so a model Google retires later drops out by itself. GEMINI_MODEL_FALLBACKS overrides all of this.
 */
export const PREFERRED_FALLBACKS: readonly string[] = ['gemini-3.5-flash', 'gemini-3.6-flash'];

/** Never part of the AUTOMATIC chain for now (see above). Still usable via GEMINI_MODEL_FALLBACKS. */
export const EXCLUDED_FALLBACKS: readonly string[] = ['gemini-3.7-flash', 'gemini-2.5-flash'];

/**
 * Choose up to `max` alternatives from the key's model list.
 * Order: the PREFERRED models that this key lists (in that order), then, only if there is still room, the
 * newest remaining stable Flash model; Flash-Lite models come after all Flash models. Models in
 * EXCLUDED_FALLBACKS are never picked automatically.
 */
export function pickFallbacks(names: readonly string[], primary: string, max: number): string[] {
  const primaryName = primary.replace(/^models\//, '');
  const byNewest = (a: Candidate, b: Candidate) => b.major - a.major || b.minor - a.minor;
  const seen = new Set<string>();
  const pool = names
    .map(parseCandidate)
    .filter(
      (c): c is Candidate =>
        !!c &&
        c.name !== primaryName &&
        !EXCLUDED_FALLBACKS.includes(c.name) &&
        !seen.has(c.name) &&
        !!seen.add(c.name),
    );

  const preferred = PREFERRED_FALLBACKS.flatMap((n) => pool.filter((c) => c.name === n)).slice(
    0,
    Math.max(0, max),
  );
  const rest = pool.filter((c) => !preferred.includes(c));
  const ordered = [
    ...rest.filter((c) => !c.lite).sort(byNewest),
    ...rest.filter((c) => c.lite).sort(byNewest),
  ];
  return [...preferred, ...ordered].slice(0, Math.max(0, max)).map((c) => c.name);
}

/** Limits that keep the number of upstream calls small. */
export interface ModelPlanLimits {
  /** Extra tries on the primary for a 429/500/503 before moving on. */
  primaryRetries: number;
  /** Hard cap on upstream calls for one plan, across all models. */
  maxAttempts: number;
  /** Most alternatives to try. */
  maxFallbacks: number;
}

export const DEFAULT_MODEL_PLAN_LIMITS: ModelPlanLimits = {
  primaryRetries: 1,
  maxAttempts: 4,
  maxFallbacks: 2,
};

/** Each fallback gets exactly one call, so this many fit under the cap (never negative). */
export function allowedFallbackCount(l: ModelPlanLimits): number {
  return Math.max(0, Math.min(l.maxFallbacks, l.maxAttempts - (1 + l.primaryRetries)));
}

/** Upstream calls one plan can make at most. */
export function maxUpstreamCalls(l: ModelPlanLimits): number {
  return 1 + l.primaryRetries + allowedFallbackCount(l);
}

/**
 * Was this failure TEMPORARY, i.e. worth trying another model for?
 *   • AI_BUSY from a Google HTTP status (429/500/502/503/504), and
 *   • TIMEOUT while waiting for Google's response or the first chunk (Google never answered).
 * Not: 400, 401/403, 404, safety blocks, cancellation, or a stream that broke half way.
 */
export function isTemporaryUnavailable(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  const d = err.details ?? [];
  if (err.code === 'AI_BUSY') return d.some((x) => /^Gemini status \d+/.test(x));
  if (err.code === 'TIMEOUT') return d.some((x) => /phase: waiting-for-(http-response|first-chunk)/.test(x));
  return false;
}

/**
 * A model that accepted the request and started answering, then went silent longer than the app allows
 * between chunks, or used up its own per-stream time. Its partial output is thrown away (the browser gets a
 * `reset` event) and the next model starts from scratch. NOT the shared plan time limit
 * ("phase: plan-time-limit"): when that fires, nothing new is started.
 */
export function isStreamStall(err: unknown): boolean {
  return (
    err instanceof AppError &&
    err.code === 'TIMEOUT' &&
    (err.details ?? []).some((x) => /^phase: streaming\b/.test(x))
  );
}

/** A 404 from Google: this model is not available to this key (retired, or not offered to new users). */
export function isModelUnavailable(err: unknown): boolean {
  return err instanceof AppError && (err.details ?? []).some((x) => /^Gemini status 404/.test(x));
}

export interface ModelPool {
  primary: string;
  /** Alternatives, resolved lazily: only looked up once the primary has failed. Never throws. */
  fallbacks(): Promise<string[]>;
  limits: ModelPlanLimits;
  /** Time left in the request's time limit (ms). Omitted = no limit. */
  remainingMs?: () => number;
  /** Don't START another model with less than this left (default 0). */
  minAttemptMs?: number;
}

export interface FallbackInfo {
  from: string;
  to: string;
  error: unknown;
}

/** One-line summary of why a model failed (redacted, short). */
function why(err: unknown): string {
  const raw =
    err instanceof AppError
      ? (err.details ?? []).join(' — ') || err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const clean = redactSecrets(raw.replace(/\s+/g, ' ').trim());
  return clean.length > 220 ? `${clean.slice(0, 220)}…` : clean;
}

function totalFailure(tried: { model: string; error: unknown }[]): AppError {
  return new AppError(
    'AI_BUSY',
    `Gemini is very busy right now (${tried.length} models tried). Your saved plan still works. Try again in a minute, or build the plan yourself.`,
    { details: tried.map((t) => `${t.model}: ${why(t.error)}`), retryable: true },
  );
}

/**
 * A permanent error from an alternative model: the same error (code, message, status), plus what was tried
 * before it, so the log and the UI details show the whole story.
 */
function stoppedAt(err: unknown, model: string, before: { model: string; error: unknown }[]): unknown {
  if (!(err instanceof AppError)) return err;
  return new AppError(err.code, err.message, {
    details: [
      `${model}: ${why(err)}`,
      ...before.map((t) => `${t.model} (tried first): ${why(t.error)}`),
      `Not a temporary error, so no further model was tried.`,
    ],
    retryable: err.retryable,
    status: err.status,
    ...(err.headers ? { headers: err.headers } : {}),
  });
}

/** The error to report when there is no time left to try another model. */
function outOfTime(err: unknown, tried: { model: string; error: unknown }[], leftMs: number): unknown {
  const base = tried.length > 1 ? totalFailure(tried) : err;
  if (!(base instanceof AppError)) return base;
  return new AppError(base.code, base.message, {
    details: [
      ...(base.details ?? []),
      `No further model was tried: only ${Math.max(0, Math.round(leftMs / 1000))} s of the planning time limit was left.`,
    ],
    retryable: base.retryable,
    status: base.status,
    ...(base.headers ? { headers: base.headers } : {}),
  });
}

/** Same error, plus a note that no alternative model was available. */
function noAlternative(err: unknown): unknown {
  if (!(err instanceof AppError)) return err;
  return new AppError(err.code, err.message, {
    details: [
      ...(err.details ?? []),
      'No alternative model was available to try (see GEMINI_MODEL_FALLBACKS).',
    ],
    retryable: err.retryable,
    status: err.status,
    ...(err.headers ? { headers: err.headers } : {}),
  });
}

/**
 * Run `run` on the primary model; on a temporary failure, on each alternative in turn (at most one call
 * each). Resolves with the first success and the model that produced it. Throws:
 *   • the primary's own error when it is not temporary (nothing is hidden),
 *   • an alternative's own error when it is neither temporary nor a 404, with the earlier attempts,
 *   • "Gemini is very busy (N models tried)" with one detail line per model when everything failed,
 *   • the primary's error plus a note when there was nothing to fall back to.
 */
export async function runWithFallback<T>(
  pool: ModelPool,
  run: (model: string, retries: number) => Promise<T>,
  hooks: { onFallback?: (info: FallbackInfo) => void } = {},
): Promise<{ value: T; model: string; tried: { model: string; error: unknown }[] }> {
  const tried: { model: string; error: unknown }[] = [];
  let model = pool.primary;
  let retries = pool.limits.primaryRetries;
  let queue: string[] | null = null;

  for (;;) {
    try {
      return { value: await run(model, retries), model, tried };
    } catch (err) {
      if (err instanceof AppError && err.code === 'CANCELLED') throw err;
      // Switching models is justified only by a TEMPORARY failure or a STALL (any model), or, on an
      // alternative, a 404 (that model is not available to this key). Anything else (400, 403…) is real.
      const movesOn =
        isTemporaryUnavailable(err) ||
        isStreamStall(err) ||
        (model !== pool.primary && isModelUnavailable(err));
      if (!movesOn) throw model === pool.primary ? err : stoppedAt(err, model, tried);
      tried.push({ model, error: err });

      queue ??= (await pool.fallbacks().catch(() => [] as string[]))
        .filter((m) => m !== pool.primary)
        .slice(0, allowedFallbackCount(pool.limits));
      const next = queue.shift();
      if (!next) throw tried.length === 1 ? noAlternative(err) : totalFailure(tried);
      const left = pool.remainingMs?.() ?? Number.POSITIVE_INFINITY;
      if (left < (pool.minAttemptMs ?? 0)) throw outOfTime(err, tried, left);

      hooks.onFallback?.({ from: model, to: next, error: err });
      model = next;
      retries = 0; // one call per alternative: keeps the total small
    }
  }
}
