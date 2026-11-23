/**
 * Secret redaction for anything we log or send back about an upstream failure.
 *
 * Why (for learners): when Google rejects a request, its error text is the single
 * most useful clue ("Unknown name 'thinkingLevel'…"). We want to LOG it, but we must
 * never let an API key leak into a log line, a screenshot or a bug report. So every
 * upstream message passes through here first:
 *   1. the exact secrets we know about (e.g. GEMINI_API_KEY) are masked wherever they appear,
 *   2. anything that merely LOOKS like a Google key, a `key=` query value or a Bearer token is masked too.
 */

const MASK = '[redacted]';

/** Secrets registered once at startup (see createApp); masked on every code path, not just where a caller remembers. */
const registered = new Set<string>();
export function registerSecrets(secrets: readonly (string | null | undefined)[]): void {
  for (const s of secrets) if (typeof s === 'string' && s.length >= 8) registered.add(s);
}

/** Escape a string for use inside a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  // Longest first, so a secret that contains another one is masked as a whole.
  const known = [
    ...new Set([
      ...registered,
      ...secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8),
    ]),
  ].sort((a, b) => b.length - a.length);
  for (const s of known) out = out.replace(new RegExp(esc(s), 'g'), MASK);
  return out
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, MASK) //            Google API keys
    .replace(/([?&;\s"']key=)[^&\s"']+/gi, `$1${MASK}`) //   ?key=… in URLs
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, `$1${MASK}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${MASK}`);
}

/**
 * The human-readable reason inside a @google/genai ApiError, redacted and shortened.
 * The SDK puts Google's JSON body in `error.message`:
 *   '{"error":{"code":400,"message":"Invalid value at …","status":"INVALID_ARGUMENT"}}'
 */
export function upstreamReason(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
  max = 400,
): string | undefined {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return undefined;
  let reason = raw;
  const start = raw.indexOf('{');
  if (start >= 0) {
    try {
      const body = JSON.parse(raw.slice(start)) as { error?: { message?: unknown; status?: unknown } };
      const m = typeof body.error?.message === 'string' ? body.error.message : '';
      const st = typeof body.error?.status === 'string' ? body.error.status : '';
      if (m) reason = st ? `${st}: ${m}` : m;
    } catch {
      /* not JSON: use the raw text */
    }
  }
  const clean = redactSecrets(reason.replace(/\s+/g, ' ').trim(), secrets);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** What Google's error body says, in a form that is safe to log (redacted, shortened, no metadata). */
export interface GoogleErrorInfo {
  /** HTTP status Google answered with. */
  httpStatus?: number;
  /** Google's status name, e.g. INVALID_ARGUMENT, RESOURCE_EXHAUSTED, PERMISSION_DENIED. */
  googleStatus?: string;
  /** Google's human-readable message (redacted, ≤ 300 chars). */
  googleMessage?: string;
  /** google.rpc.ErrorInfo reason, e.g. API_KEY_INVALID, SERVICE_DISABLED. */
  googleReason?: string;
  /** google.rpc.BadRequest field violations (≤ 3; the field path and Google's description). */
  fieldViolations?: { field: string; description: string }[];
  /** google.rpc.QuotaFailure quota ids (≤ 3), e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier. */
  quotaIds?: string[];
  /** google.rpc.RetryInfo retryDelay, e.g. "37s". */
  retryDelay?: string;
}

const short = (s: unknown, max: number, secrets: readonly (string | null | undefined)[]) => {
  if (typeof s !== 'string' || !s.trim()) return undefined;
  const clean = redactSecrets(s.replace(/\s+/g, ' ').trim(), secrets);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

/**
 * Parse the error body Google returned (the SDK keeps it as JSON in `error.message`) into the fields that
 * explain a failure. Deliberately NOT included: ErrorInfo.metadata (it can name the Google project), help
 * links, and anything from our own request. Every string is redacted and shortened. Returns null when
 * there is no Google error body (e.g. our own timeout).
 */
export function googleErrorInfo(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
): GoogleErrorInfo | null {
  // Our own errors (AppError: timeouts, cut-off answers…) have a `.status` too, but it is OUR status
  // (e.g. 504), not Google's. Checked by name to avoid importing errors.ts (which imports this file).
  if ((err as { name?: unknown } | null)?.name === 'AppError') return null;
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const start = raw.indexOf('{');
  const status = (err as { status?: unknown } | null)?.status;
  if (start < 0) return typeof status === 'number' ? { httpStatus: status } : null;
  let body: { error?: Record<string, unknown> };
  try {
    body = JSON.parse(raw.slice(start)) as { error?: Record<string, unknown> };
  } catch {
    return typeof status === 'number'
      ? { httpStatus: status, googleMessage: short(raw, 300, secrets) }
      : null;
  }
  const e = body.error;
  if (!e || typeof e !== 'object') return typeof status === 'number' ? { httpStatus: status } : null;

  const out: GoogleErrorInfo = {};
  const code = typeof status === 'number' ? status : typeof e.code === 'number' ? e.code : undefined;
  if (code !== undefined) out.httpStatus = code;
  if (typeof e.status === 'string') out.googleStatus = short(e.status, 40, secrets);
  const message = short(e.message, 300, secrets);
  if (message) out.googleMessage = message;

  for (const d of Array.isArray(e.details) ? (e.details as Record<string, unknown>[]) : []) {
    const type = typeof d?.['@type'] === 'string' ? (d['@type'] as string) : '';
    if (type.endsWith('google.rpc.ErrorInfo')) {
      const reason = short(d.reason, 60, secrets);
      if (reason) out.googleReason = reason;
    } else if (type.endsWith('google.rpc.BadRequest') && Array.isArray(d.fieldViolations)) {
      out.fieldViolations = (d.fieldViolations as Record<string, unknown>[]).slice(0, 3).map((v) => ({
        field: short(v.field, 120, secrets) ?? '',
        description: short(v.description, 160, secrets) ?? '',
      }));
    } else if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(d.violations)) {
      const ids = (d.violations as Record<string, unknown>[])
        .map((v) => short(v.quotaId, 100, secrets))
        .filter((v): v is string => !!v)
        .slice(0, 3);
      if (ids.length) out.quotaIds = ids;
    } else if (type.endsWith('google.rpc.RetryInfo')) {
      const delay = short(d.retryDelay, 20, secrets);
      if (delay) out.retryDelay = delay;
    }
  }
  return out;
}
