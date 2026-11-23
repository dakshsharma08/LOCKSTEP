/**
 * The two ways we call Gemini, with all the robustness rules in one place:
 *
 *   callGemini()   — one request, one answer. 30 s timeout per attempt,
 *                    retries 429/500/503 with backoff, logs an ai_run per attempt.
 *   streamGemini() — streaming. 30 s to the first chunk, 30 s between chunks,
 *                    120 s overall. Retries only while NOTHING has been received
 *                    yet (once text is streaming to the user, a silent restart
 *                    would show them duplicate milestones).
 *
 * Both take the request's AbortSignal, so a closed browser tab stops the
 * Gemini request immediately (config.abortSignal is how the SDK accepts it).
 */
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
import type { AiKind, AiRunMeta } from '../../shared/api';
import type { RunRecorder } from '../lib/aiRuns';
import { runMeta } from '../lib/aiRuns';
import type { AiTuning } from '../lib/config';
import { AppError, isRetryableUpstream, toAppError, upstreamStatus } from '../lib/errors';
import { withRetry } from '../lib/retry';
import { upstreamReason } from '../lib/redact';
import { raceAbort, withTimeout } from '../lib/timeout';
import type { GeminiLike } from './client';

/** Everything a Gemini call needs, bundled per HTTP request. */
export interface CallContext {
  gemini: GeminiLike;
  recorder: RunRecorder;
  tuning: AiTuning;
  /** Aborts when the client disconnects (and, for /api/plan, when the plan time limit is reached). */
  signal: AbortSignal;
  /** When the plan time limit ends (epoch ms), if this request has one. Used to avoid STARTING work that can't finish. */
  deadlineMs?: number;
  /** Every attempt is appended here and returned to the client. */
  runs: AiRunMeta[];
}

export interface CallArgs {
  kind: AiKind;
  model: string;
  request: Omit<GenerateContentParameters, 'model'>;
  /** Override the retry count (e.g. 0 for a heavy model that has a fallback). */
  retries?: number;
  /** Override the per-attempt timeout (default tuning.callTimeoutMs), e.g. for the plan repair. */
  timeoutMs?: number;
}

/** Milliseconds left before ctx.deadlineMs (Infinity when there is no deadline). */
export function remainingMs(ctx: Pick<CallContext, 'deadlineMs'>, now = Date.now()): number {
  return ctx.deadlineMs === undefined ? Number.POSITIVE_INFINITY : ctx.deadlineMs - now;
}

/** Visible text of a response: text parts only, skipping "thought" summaries. */
export function partsText(parts: readonly Part[] | undefined): string {
  let out = '';
  for (const p of parts ?? []) if (typeof p.text === 'string' && !p.thought) out += p.text;
  return out;
}

export function responseText(r: GenerateContentResponse): string {
  return partsText(r.candidates?.[0]?.content?.parts);
}

export function responseContent(r: GenerateContentResponse): Content | undefined {
  return r.candidates?.[0]?.content;
}

function tokensOf(r: GenerateContentResponse | undefined): number | null {
  const t = r?.usageMetadata?.totalTokenCount;
  return typeof t === 'number' ? t : null;
}

const SAFETY_FINISH = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
]);

/** Why Gemini refused to answer (prompt blocked or answer stopped for safety), if it did. */
export function blockReason(r: GenerateContentResponse): string | null {
  const prompt = r.promptFeedback?.blockReason;
  if (prompt) return String(prompt);
  const finish = r.candidates?.[0]?.finishReason;
  return finish && SAFETY_FINISH.has(String(finish)) ? String(finish) : null;
}

/** A refusal is not a server fault and retrying won't help, so it gets its own clear message. */
function blockedError(reason: string): AppError {
  return new AppError(
    'INVALID_INPUT',
    'Gemini declined this request for safety reasons. Try rephrasing it.',
    {
      details: [`blocked: ${reason}`],
    },
  );
}

function record(ctx: CallContext, meta: AiRunMeta) {
  ctx.runs.push(meta);
  ctx.recorder.record(meta);
}

/** One non-streaming call with timeout, retries and logging. */
export async function callGemini(ctx: CallContext, args: CallArgs): Promise<GenerateContentResponse> {
  const t = ctx.tuning;
  const timeoutMs = args.timeoutMs ?? t.callTimeoutMs;
  let response: GenerateContentResponse;
  try {
    response = await withRetry(
      async () => {
        const started = Date.now();
        try {
          const response = await withTimeout(
            (signal) =>
              ctx.gemini.models.generateContent({
                ...args.request,
                model: args.model,
                config: { ...args.request.config, abortSignal: signal },
              }),
            timeoutMs,
            ctx.signal,
            `No answer within ${Math.round(timeoutMs / 1000)} s`,
          );
          record(ctx, runMeta(args.kind, args.model, started, true, tokensOf(response)));
          return response;
        } catch (err) {
          record(ctx, runMeta(args.kind, args.model, started, false, null));
          ctx.recorder.diag({
            kind: args.kind,
            model: args.model,
            ok: false,
            streaming: false,
            totalMs: Date.now() - started,
            ...failureInfo(err),
          });
          throw err;
        }
      },
      {
        retries: args.retries ?? t.maxRetries,
        baseMs: t.retryBaseMs,
        maxMs: t.retryMaxMs,
        signal: ctx.signal,
        shouldRetry: isRetryableUpstream,
      },
    );
  } catch (err) {
    throw toAppError(err, ctx.signal);
  }
  const blocked = blockReason(response);
  if (blocked) throw blockedError(blocked);
  return response;
}

/**
 * HTTP status of an error that came FROM Google. Our own AppError also has a `.status` (the HTTP
 * status we would answer with, e.g. 504 for a timeout), so it must not be mistaken for Google's.
 */
const googleStatus = (err: unknown): number | undefined =>
  err instanceof AppError ? undefined : upstreamStatus(err);

/** What we log about a failed upstream call: HTTP status and Google's own (redacted) reason. */
function failureInfo(err: unknown): Record<string, unknown> {
  const status = googleStatus(err);
  return {
    ...(status !== undefined ? { status, upstream: upstreamReason(err) } : {}),
    error: err instanceof AppError ? err.code : err instanceof Error ? err.name : 'unknown',
  };
}

/** Where the time went in one streaming attempt (milliseconds since the request was sent). */
interface Phases {
  /** HTTP response headers received (Google accepted the request). */
  headersMs?: number;
  /** First SSE chunk of any kind (a thought summary counts). */
  firstChunkMs?: number;
  /** First chunk that carried visible text (the JSON we parse). */
  firstTextMs?: number;
  chunks: number;
  thoughtChunks: number;
  /** Chunks with visible text (the JSON). Thinking vs text tells a thinking pause from a stalled answer. */
  textChunks: number;
  /** When the last chunk arrived, and the longest silence between two chunks (ms). */
  lastChunkMs?: number;
  maxGapMs?: number;
}

type StallPhase = 'waiting-for-http-response' | 'waiting-for-first-chunk' | 'streaming';
const stallPhase = (ph: Phases): StallPhase =>
  ph.headersMs === undefined
    ? 'waiting-for-http-response'
    : ph.firstChunkMs === undefined
      ? 'waiting-for-first-chunk'
      : 'streaming';

/** A TIMEOUT that says which phase it hit ("phase: streaming (…)", "phase: waiting-for-first-chunk (…)"). */
function stageTimeout(what: string, phase: string): AppError {
  return new AppError('TIMEOUT', undefined, { details: [what, `phase: ${phase}`] });
}

/**
 * The first-chunk timeout, worded by WHICH wait timed out. "No first chunk" alone hides the
 * difference between "Google never answered" (network) and "Google answered but the model
 * is still thinking" (model latency); they need different fixes.
 */
function firstChunkTimeout(phase: StallPhase, ms: number): AppError {
  const s = Math.round(ms / 1000);
  if (phase === 'waiting-for-http-response') {
    return new AppError('TIMEOUT', `Google didn't answer the request within ${s} s.`, {
      details: [
        'phase: waiting-for-http-response (no HTTP response from generativelanguage.googleapis.com)',
        'This points at the network between this server and Google (proxy, firewall, VPN, DNS or IPv6), not at the model.',
        'Run `npm run diagnose:gemini` to test the connection directly.',
      ],
    });
  }
  return new AppError('TIMEOUT', `Gemini accepted the request but sent no output within ${s} s.`, {
    details: [
      'phase: waiting-for-first-chunk (HTTP response received, no data yet)',
      'The model is most likely still "thinking". Lower it with GEMINI_THINKING_LEVEL=low (or minimal).',
      'Run `npm run diagnose:gemini` to measure it.',
    ],
  });
}

export interface StreamArgs extends CallArgs {
  /** Called with each new piece of visible text, in order. */
  onText: (delta: string) => void;
  /** Called once, when the first chunk (text or thought) arrives. */
  onFirstChunk?: () => void;
}

/** Stream a response, enforcing first-chunk / between-chunk / total timeouts. Returns the full text. */
export async function streamGemini(ctx: CallContext, args: StreamArgs): Promise<string> {
  const t = ctx.tuning;
  // `total` aborts everything after the overall cap; it is also aborted by the client disconnecting.
  const totalCtrl = new AbortController();
  const total = AbortSignal.any([ctx.signal, totalCtrl.signal]);
  const totalTimer = setTimeout(
    () =>
      totalCtrl.abort(
        // The phase at the moment the cap hit: "streaming" means this model started answering and ran out
        // of its own time (gemini/fallback.ts treats that as a stall and may start over on another model).
        stageTimeout(
          `Stream exceeded ${Math.round(t.streamTotalTimeoutMs / 1000)} s`,
          `${stallPhase(ph)} (stream time limit)`,
        ),
      ),
    t.streamTotalTimeoutMs,
  );

  let started = Date.now();
  let attempts = 0;
  let ph: Phases = { chunks: 0, thoughtChunks: 0, textChunks: 0 };
  let lastUsage: GenerateContentResponse | undefined;
  let text = '';
  let attemptSignal: AbortSignal = total;

  // `as` widens the type: TypeScript can't see the assignment inside consume().
  let blocked = null as string | null;
  const consume = (chunk: GenerateContentResponse) => {
    const at = Date.now() - started;
    if (ph.lastChunkMs !== undefined) ph.maxGapMs = Math.max(ph.maxGapMs ?? 0, at - ph.lastChunkMs);
    ph.lastChunkMs = at;
    ph.chunks++;
    if (chunk.candidates?.[0]?.content?.parts?.some((p) => p.thought)) ph.thoughtChunks++;
    if (chunk.usageMetadata) lastUsage = chunk;
    blocked = blockReason(chunk) ?? blocked;
    const delta = responseText(chunk);
    if (delta) {
      ph.textChunks++;
      ph.firstTextMs ??= at;
      text += delta;
      args.onText(delta);
    }
  };

  /** One structured log line about how this call went (timings by phase, HTTP status, Google's reason). */
  const diag = (ok: boolean, extra: Record<string, unknown> = {}) =>
    ctx.recorder.diag({
      kind: args.kind,
      model: args.model,
      ok,
      streaming: true,
      attempts,
      ...(ph.headersMs !== undefined ? { headersMs: ph.headersMs } : {}),
      ...(ph.firstChunkMs !== undefined ? { firstChunkMs: ph.firstChunkMs } : {}),
      ...(ph.firstTextMs !== undefined ? { firstTextMs: ph.firstTextMs } : {}),
      chunks: ph.chunks,
      thoughtChunks: ph.thoughtChunks,
      textChunks: ph.textChunks,
      ...(ph.lastChunkMs !== undefined ? { lastChunkMs: ph.lastChunkMs } : {}),
      ...(ph.maxGapMs !== undefined ? { maxGapMs: ph.maxGapMs } : {}),
      totalMs: Date.now() - started,
      thinking: args.request.config?.thinkingConfig ?? null,
      ...extra,
    });

  try {
    // Phase 1 (retryable): open the stream and wait for the first chunk.
    const { stream, attemptCtrl } = await withRetry(
      async () => {
        started = Date.now();
        attempts++;
        ph = { chunks: 0, thoughtChunks: 0, textChunks: 0 };
        const attemptCtrl = new AbortController();
        attemptSignal = AbortSignal.any([total, attemptCtrl.signal]);
        const firstTimer = setTimeout(
          () => attemptCtrl.abort(firstChunkTimeout(stallPhase(ph), t.firstChunkTimeoutMs)),
          t.firstChunkTimeoutMs,
        );
        try {
          const stream = await raceAbort(
            ctx.gemini.models.generateContentStream({
              ...args.request,
              model: args.model,
              config: { ...args.request.config, abortSignal: attemptSignal },
            }),
            attemptSignal,
          );
          // The SDK resolves once Google's HTTP response headers have arrived.
          ph.headersMs = Date.now() - started;
          const first = await raceAbort(stream.next(), attemptSignal);
          if (!first.done) {
            ph.firstChunkMs = Date.now() - started;
            args.onFirstChunk?.();
            consume(first.value);
          }
          return { stream: first.done ? null : stream, attemptCtrl };
        } catch (err) {
          record(ctx, runMeta(args.kind, args.model, started, false, null));
          throw err;
        } finally {
          clearTimeout(firstTimer);
        }
      },
      {
        retries: args.retries ?? t.maxRetries,
        baseMs: t.retryBaseMs,
        maxMs: t.retryMaxMs,
        signal: total,
        shouldRetry: isRetryableUpstream,
      },
    );

    // Phase 2 (not retryable): read the rest, resetting the idle timer per chunk.
    try {
      while (stream) {
        const idle = setTimeout(
          () =>
            attemptCtrl.abort(
              stageTimeout(
                `Stream paused for more than ${Math.round(t.chunkIdleTimeoutMs / 1000)} s`,
                `streaming (no new chunk after ${ph.chunks} chunks: ${ph.thoughtChunks} thinking, ${ph.textChunks} text)`,
              ),
            ),
          t.chunkIdleTimeoutMs,
        );
        let next: IteratorResult<GenerateContentResponse>;
        try {
          next = await raceAbort(stream.next(), attemptSignal);
        } finally {
          clearTimeout(idle);
        }
        if (next.done) break;
        consume(next.value);
      }
    } catch (err) {
      record(ctx, runMeta(args.kind, args.model, started, false, tokensOf(lastUsage)));
      // Let the SDK's generator finish cleaning up; its late rejection is expected.
      stream?.return(undefined).catch(() => {});
      throw err;
    }
    record(ctx, runMeta(args.kind, args.model, started, true, tokensOf(lastUsage)));
    diag(true, { phase: 'done', tokens: tokensOf(lastUsage) });
    if (blocked) throw blockedError(blocked);
    return text;
  } catch (err) {
    // attemptSignal carries our abort reason (TIMEOUT / CANCELLED) if we pressed stop.
    const mapped = toAppError(err, attemptSignal);
    const status = googleStatus(err);
    if (!(mapped.code === 'INVALID_INPUT' && ph.chunks > 0)) {
      diag(false, {
        phase:
          status !== undefined ? 'http-error' : mapped.code === 'CANCELLED' ? 'cancelled' : stallPhase(ph),
        ...failureInfo(err instanceof AppError ? err : (err as unknown)),
        ...(mapped.code === 'TIMEOUT' ? { error: 'TIMEOUT' } : {}),
      });
    }
    throw mapped;
  } finally {
    clearTimeout(totalTimer);
  }
}
