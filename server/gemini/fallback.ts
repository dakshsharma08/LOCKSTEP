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
 *   • The alternatives come from the models YOUR key can actually call (models.list), never from a
 *     hard-coded list: Google retires models (gemini-2.5-* are being shut down), and a list written in
 *     advance could point at models that no longer exist. GEMINI_MODEL_FALLBACKS overrides it.
 *   • Hard cap on upstream calls per plan: 1 + primaryRetries + fallbacks (default 4 calls in total).
 *     503s also count against rate limits, so hammering a struggling API makes things worse.
 *   • A fallback that fails (even with a 404) is skipped, and the overall error stays an honest
 *     "Gemini is busy" instead of a confusing error about the last model tried.
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
 * Choose up to `max` alternatives from the key's model list.
 * Order: the newest remaining stable Flash model first (best quality); the next pick prefers a
 * different model GENERATION than the ones already chosen (capacity is often per generation);
 * Flash-Lite models come after all Flash models.
 */
export function pickFallbacks(names: readonly string[], primary: string, max: number): string[] {
  const primaryName = primary.replace(/^models\//, '');
  const primaryMajor = parseCandidate(primaryName)?.major ?? Number.NaN;
  const byNewest = (a: Candidate, b: Candidate) => b.major - a.major || b.minor - a.minor;
  const seen = new Set<string>();
  const pool = names
    .map(parseCandidate)
    .filter((c): c is Candidate => !!c && c.name !== primaryName && !seen.has(c.name) && !!seen.add(c.name));
  const ordered = [
    ...pool.filter((c) => !c.lite).sort(byNewest),
    ...pool.filter((c) => c.lite).sort(byNewest),
  ];

  const out: Candidate[] = [];
  const majors = new Set<number>([primaryMajor]);
  while (out.length < max && ordered.length > 0) {
    // The first pick is simply the best remaining; later picks prefer a generation not used yet.
    const i =
      out.length === 0
        ? 0
        : Math.max(
            0,
            ordered.findIndex((c) => !majors.has(c.major)),
          );
    const [pick] = ordered.splice(i, 1);
    if (!pick) break;
    out.push(pick);
    majors.add(pick.major);
  }
  return out.map((c) => c.name);
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

export interface ModelPool {
  primary: string;
  /** Alternatives, resolved lazily: only looked up once the primary has failed. Never throws. */
  fallbacks(): Promise<string[]>;
  limits: ModelPlanLimits;
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
      // On the primary only a TEMPORARY failure justifies switching models.
      if (model === pool.primary && !isTemporaryUnavailable(err)) throw err;
      tried.push({ model, error: err });

      queue ??= (await pool.fallbacks().catch(() => [] as string[]))
        .filter((m) => m !== pool.primary)
        .slice(0, allowedFallbackCount(pool.limits));
      const next = queue.shift();
      if (!next) throw tried.length === 1 ? noAlternative(err) : totalFailure(tried);

      hooks.onFallback?.({ from: model, to: next, error: err });
      model = next;
      retries = 0; // one call per alternative: keeps the total small
    }
  }
}
