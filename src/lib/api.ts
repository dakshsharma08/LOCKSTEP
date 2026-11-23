/**
 * Browser-side API client. The browser never talks to Gemini directly and never
 * sees the API key: every AI call goes through our own /api server.
 */
import type {
  ApiError,
  BackgroundRequestBody,
  BackgroundResponse,
  CoachRequest,
  CoachResponse,
  HealthResponse,
  MotivationRequest,
  MotivationResponse,
  PlanStreamEvent,
  WeeklyInsightRequest,
  WeeklyInsightResponse,
} from '@shared/api';
import type { IntakeInput } from '@shared/plan';

export class ApiCallError extends Error {
  constructor(
    public readonly error: ApiError,
    public readonly status: number,
  ) {
    super(error.message);
  }
}

const OFFLINE: ApiError = {
  code: 'AI_BUSY',
  message: "You're offline. Your saved plan still works — AI features return when you're back online.",
  retryable: true,
};

function toApiError(status: number, body: unknown): ApiError {
  const b = body as Partial<ApiError> | null;
  if (b && typeof b.code === 'string' && typeof b.message === 'string') return b as ApiError;
  if (status === 404)
    return {
      code: 'NOT_FOUND',
      message: 'The LOCKSTEP API is not reachable on this deployment.',
      retryable: false,
    };
  return {
    code: 'INTERNAL',
    message: 'Something went wrong on our side. Please try again.',
    retryable: true,
  };
}

/**
 * Last-resort client limits, so no request can leave the UI waiting forever (e.g. a phone connection that
 * dies silently). They sit ABOVE the server's own limits (30 s per Gemini call, retries and up to two
 * alternative models; Vercel stops a function at 300 s), so they never cut off an answer that is coming.
 */
export const CLIENT_LIMITS = {
  /** One JSON API call (motivation, coach, weekly insight, background). */
  jsonMs: 180_000,
  /** GET /api/health (the server bounds its own model listing). */
  healthMs: 10_000,
  /** The plan stream: the server sends a keep-alive every 15 s, so this much silence means the connection is gone. */
  planSilenceMs: 45_000,
};

/** Marks a client-side "no answer" (as opposed to the server's own TIMEOUT for a slow Gemini). */
export const NO_DATA_DETAIL = 'No data from the LOCKSTEP server (the connection may have dropped).';

const NO_ANSWER: ApiError = {
  code: 'TIMEOUT',
  message:
    'The LOCKSTEP server stopped answering (the connection may have dropped). Your saved plans still work. Please try again.',
  retryable: true,
  details: [NO_DATA_DETAIL],
};

/**
 * A signal that aborts when the caller's signal does OR after `ms`, and tells the two apart afterwards.
 * Plain AbortController + setTimeout on purpose: AbortSignal.any / AbortSignal.timeout are missing on
 * older iOS Safari, where they would break every AI call. Call `done()` when the request has finished.
 */
function withLimit(ms: number, signal?: AbortSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const follow = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', follow, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', follow);
    },
  };
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiCallError(OFFLINE, 0);
  const limit = withLimit(CLIENT_LIMITS.jsonMs, signal);
  let res: Response;
  let data: unknown;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: limit.signal,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    if (limit.timedOut()) throw new ApiCallError(NO_ANSWER, 0);
    if (signal?.aborted || (e as Error).name === 'AbortError') throw e;
    throw new ApiCallError(OFFLINE, 0);
  } finally {
    limit.done();
  }
  if (!res.ok) throw new ApiCallError(toApiError(res.status, data), res.status);
  return data as T;
}

/**
 * GET /api/health. THROWS when the server can't be reached or answers with an error, so React Query
 * retries it and keeps the last good answer, instead of caching "no server" as a success (which used to
 * hide Gemini planning until the page was reloaded after one failed check).
 */
export async function getHealth(): Promise<HealthResponse> {
  const limit = withLimit(CLIENT_LIMITS.healthMs);
  let res: Response;
  let data: unknown;
  try {
    res = await fetch('/api/health', { signal: limit.signal });
    data = await res.json().catch(() => null);
  } catch {
    throw new ApiCallError(limit.timedOut() ? NO_ANSWER : OFFLINE, 0);
  } finally {
    limit.done();
  }
  if (!res.ok || !data) throw new ApiCallError(toApiError(res.status, data), res.status);
  return data as HealthResponse;
}

export const getMotivation = (req: MotivationRequest, signal?: AbortSignal) =>
  postJson<MotivationResponse>('/api/motivation', req, signal);

export const generateBackground = (req: BackgroundRequestBody, signal?: AbortSignal) =>
  postJson<BackgroundResponse>('/api/background', req, signal);

export const askCoach = (req: CoachRequest, signal?: AbortSignal) =>
  postJson<CoachResponse>('/api/coach', req, signal);

export const getWeeklyInsight = (req: WeeklyInsightRequest, signal?: AbortSignal) =>
  postJson<WeeklyInsightResponse>('/api/insights/weekly', req, signal);

/**
 * Stream a plan from POST /api/plan (Server-Sent Events over fetch, because
 * EventSource can't POST). Calls `onEvent` for each event. Abort with the signal.
 *
 * A watchdog ends the wait if NOTHING arrives (not even the server's 15 s keep-alive) for
 * `silenceMs`: the connection is gone, so the user gets a clear error instead of an endless spinner.
 */
export async function streamPlan(
  intake: IntakeInput,
  onEvent: (e: PlanStreamEvent) => void,
  signal: AbortSignal,
  opts: { silenceMs?: number } = {},
): Promise<void> {
  if (navigator.onLine === false) throw new ApiCallError(OFFLINE, 0);
  const silenceMs = opts.silenceMs ?? CLIENT_LIMITS.planSilenceMs;
  // One controller for both reasons to stop: the caller's signal, or the watchdog (no AbortSignal.any:
  // older iOS Safari lacks it).
  const both = new AbortController();
  const follow = () => both.abort();
  if (signal.aborted) both.abort();
  else signal.addEventListener('abort', follow, { once: true });
  let silent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent = true;
      both.abort();
    }, silenceMs);
  };
  arm();
  try {
    let res: Response;
    try {
      res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(intake),
        signal: both.signal,
      });
    } catch (e) {
      if (silent) throw new ApiCallError(NO_ANSWER, 0);
      if (signal.aborted || (e as Error).name === 'AbortError') throw e;
      throw new ApiCallError(OFFLINE, 0);
    }
    if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await res.json().catch(() => null);
      throw new ApiCallError(toApiError(res.status, data), res.status);
    }
    await readEvents(res.body, onEvent, arm).catch((e: unknown) => {
      if (silent) throw new ApiCallError(NO_ANSWER, 0);
      throw e;
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', follow);
  }
}

/** Read SSE messages; `onBytes` is called for every chunk (keep-alives included) to re-arm the watchdog. */
async function readEvents(
  body: NonNullable<Response['body']>,
  onEvent: (e: PlanStreamEvent) => void,
  onBytes: () => void,
): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onBytes();
    buffer += value;
    let idx: number;
    // SSE messages are separated by a blank line.
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      const parsed = parseSse(raw);
      if (parsed) onEvent(parsed);
    }
  }
}

function parseSse(raw: string): PlanStreamEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // keep-alive comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) } as PlanStreamEvent;
  } catch {
    return null;
  }
}
