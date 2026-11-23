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
