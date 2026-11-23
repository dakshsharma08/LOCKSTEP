/**
 * Browser API client (src/lib/api.ts): failures are real errors (so React Query retries and keeps the
 * last good answer), and no request can leave the UI waiting forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiCallError, CLIENT_LIMITS, getHealth, getMotivation, streamPlan } from '../../src/lib/api';
import type { PlanStreamEvent } from '../../shared/api';

const DEFAULTS = { ...CLIENT_LIMITS };
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(CLIENT_LIMITS, DEFAULTS);
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** fetch that never answers until aborted (a dead mobile connection). */
const hanging = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      ),
  );

describe('getHealth', () => {
  it('returns the health body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { ok: true, ai: { configured: true } })),
    );
    expect((await getHealth()).ai.configured).toBe(true);
  });
  it('THROWS on an error status (it used to return null, which was cached as "no server" until reload)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway timeout', { status: 504 })),
    );
    await expect(getHealth()).rejects.toBeInstanceOf(ApiCallError);
  });
  it('throws when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(getHealth()).rejects.toMatchObject({ error: { code: 'AI_BUSY' } });
  });
  it('gives up after its time limit instead of hanging', async () => {
    CLIENT_LIMITS.healthMs = 50;
    vi.stubGlobal('fetch', hanging());
    await expect(getHealth()).rejects.toMatchObject({ error: { retryable: true } });
  });
});

describe('JSON calls (motivation, coach, insights)', () => {
  const REQ = {
    goal: 'G',
    daysLeft: 3,
    percentDone: 10,
    nextMilestone: null,
    streak: 0,
    pace: 'on-track' as const,
    state: 'active' as const,
    dateKey: '2026-11-23',
  };
  it('a silent connection ends with a clear, retryable error after the limit', async () => {
    CLIENT_LIMITS.jsonMs = 50;
    vi.stubGlobal('fetch', hanging());
    const err = await getMotivation(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).error).toMatchObject({ retryable: true });
    expect((err as ApiCallError).error.message).toMatch(/stopped answering/);
  });
  it('the caller cancelling is still a plain AbortError (not reported as a failure)', async () => {
    vi.stubGlobal('fetch', hanging());
    const ctrl = new AbortController();
    const p = getMotivation(REQ, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('a Gemini 503 from the server is passed through as the server said it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(503, { code: 'AI_BUSY', message: 'Gemini is busy', retryable: true, status: 503 }),
      ),
    );
    await expect(getMotivation(REQ)).rejects.toMatchObject({ status: 503, error: { code: 'AI_BUSY' } });
  });
});

describe('streamPlan watchdog', () => {
  const enc = new TextEncoder();
  /** An SSE response whose body is written by `write` (it may stay open forever). */
  const sse = (write: (push: (s: string) => void, close: () => void) => void) =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          write(
            (s) => c.enqueue(enc.encode(s)),
            () => c.close(),
          );
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
  const STATUS =
    'event: status\ndata: {"phase":"thinking","message":"Gemini is thinking about your plan…"}\n\n';

  it('a stream that goes silent ends with a clear error instead of an endless spinner', async () => {
    vi.stubGlobal(
      'fetch',
      sse((push) => push(STATUS)),
    ); // one event, then nothing ever again
    const events: PlanStreamEvent[] = [];
    const err = await streamPlan({} as never, (e) => events.push(e), new AbortController().signal, {
      silenceMs: 80,
    }).catch((e: unknown) => e);
    expect(events.map((e) => e.event)).toEqual(['status']);
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).error).toMatchObject({ retryable: true });
  });

  it('keep-alive comments count as signs of life (a long but alive plan is not cut off)', async () => {
    vi.stubGlobal(
      'fetch',
      sse((push, close) => {
        let n = 0;
        const t = setInterval(() => {
          push(': keep-alive\n\n');
          if (++n === 6) {
            clearInterval(t);
            push('event: result\ndata: {"ok":true}\n\n');
            close();
          }
        }, 30);
      }),
    );
    const events: PlanStreamEvent[] = [];
    // 6 × 30 ms = 180 ms in total, far longer than the 80 ms silence limit, but never silent for 80 ms.
    await streamPlan({} as never, (e) => events.push(e), new AbortController().signal, { silenceMs: 80 });
    expect(events.map((e) => e.event)).toEqual(['result']);
  });

  it('no response at all (the request itself hangs) also ends with the error', async () => {
    vi.stubGlobal('fetch', hanging());
    await expect(
      streamPlan({} as never, () => undefined, new AbortController().signal, { silenceMs: 60 }),
    ).rejects.toBeInstanceOf(ApiCallError);
  });

  it('the user cancelling is an AbortError, not a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      sse((push) => push(STATUS)),
    );
    const ctrl = new AbortController();
    const p = streamPlan({} as never, () => ctrl.abort(), ctrl.signal, { silenceMs: 5_000 });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
