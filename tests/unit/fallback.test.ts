import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../server/lib/errors';
import {
  DEFAULT_MODEL_PLAN_LIMITS,
  allowedFallbackCount,
  isTemporaryUnavailable,
  maxUpstreamCalls,
  parseFallbackList,
  pickFallbacks,
  runWithFallback,
  type ModelPool,
} from '../../server/gemini/fallback';

const busy503 = () =>
  new AppError('AI_BUSY', undefined, {
    details: ['Gemini status 503', 'Google said: UNAVAILABLE: The model is overloaded.'],
  });
const bad400 = () =>
  new AppError('INTERNAL', 'x', {
    retryable: false,
    details: ['Gemini status 400', 'Google said: INVALID_ARGUMENT: bad'],
  });
const missing404 = () =>
  new AppError('INTERNAL', 'x', { retryable: false, details: ['Gemini status 404 — check GEMINI_MODEL'] });

describe('parseFallbackList', () => {
  it('empty = automatic, "none" = disabled, otherwise the validated list', () => {
    expect(parseFallbackList(undefined)).toEqual({ models: null, rejected: [] });
    expect(parseFallbackList('  ')).toEqual({ models: null, rejected: [] });
    expect(parseFallbackList('none')).toEqual({ models: [], rejected: [] });
    expect(parseFallbackList('OFF')).toEqual({ models: [], rejected: [] });
    expect(parseFallbackList('gemini-3.6-flash, models/gemini-3.5-flash ,gemini-3.6-flash')).toEqual({
      models: ['gemini-3.6-flash', 'gemini-3.5-flash'],
      rejected: [],
    });
  });
  it('rejects anything that is not a plain model name (they end up in URL paths)', () => {
    const r = parseFallbackList('gemini-3.6-flash,../etc/passwd,has space,UPPER,x');
    expect(r.models).toEqual(['gemini-3.6-flash']);
    expect(r.rejected).toEqual(['../etc/passwd', 'has space', 'UPPER', 'x']);
  });
});

describe('pickFallbacks (from the models THIS key can call)', () => {
  const list = [
    'models/gemini-3.8-flash',
    'models/gemini-3.6-flash',
    'models/gemini-3.5-flash',
    'models/gemini-3.5-flash-lite',
    'models/gemini-2.5-flash',
    'models/gemini-3-flash-preview', // preview: never auto-picked
    'models/gemini-3.8-flash-image', // image model
    'models/gemini-flash-latest', // moving alias: could be the same overloaded model
    'models/gemini-3.6-flash-001', // pinned revision: only the alias name is used
    'models/gemini-embedding-001',
  ];
  it('newest stable Flash first, then a different generation, never the primary', () => {
    expect(pickFallbacks(list, 'gemini-3.8-flash', 2)).toEqual(['gemini-3.6-flash', 'gemini-2.5-flash']);
  });
  it('fills the rest by recency, with Flash-Lite after all Flash models', () => {
    expect(pickFallbacks(list, 'gemini-3.8-flash', 4)).toEqual([
      'gemini-3.6-flash',
      'gemini-2.5-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
    ]);
  });
  it('never invents models: a list without alternatives gives none (e.g. 2.5 was retired)', () => {
    expect(
      pickFallbacks(['models/gemini-3.8-flash', 'models/gemini-3-flash-preview'], 'gemini-3.8-flash', 2),
    ).toEqual([]);
    expect(pickFallbacks([], 'gemini-3.8-flash', 2)).toEqual([]);
  });
  it('works when the primary is an alias', () => {
    expect(pickFallbacks(list, 'gemini-flash-latest', 1)).toEqual(['gemini-3.8-flash']);
  });
});

describe('call limits', () => {
  it('defaults: 1 try + 1 retry on the primary + 2 alternatives = 4 calls at most', () => {
    expect(allowedFallbackCount(DEFAULT_MODEL_PLAN_LIMITS)).toBe(2);
    expect(maxUpstreamCalls(DEFAULT_MODEL_PLAN_LIMITS)).toBe(4);
  });
  it('the cap wins over maxFallbacks, and never goes negative', () => {
    expect(allowedFallbackCount({ primaryRetries: 1, maxAttempts: 4, maxFallbacks: 9 })).toBe(2);
    expect(allowedFallbackCount({ primaryRetries: 1, maxAttempts: 2, maxFallbacks: 2 })).toBe(0);
    expect(allowedFallbackCount({ primaryRetries: 3, maxAttempts: 2, maxFallbacks: 2 })).toBe(0);
    expect(maxUpstreamCalls({ primaryRetries: 0, maxAttempts: 3, maxFallbacks: 5 })).toBe(3);
  });
});

describe('isTemporaryUnavailable', () => {
  it('is true for Google HTTP outages and for "Google never answered"', () => {
    expect(isTemporaryUnavailable(busy503())).toBe(true);
    expect(
      isTemporaryUnavailable(
        new AppError('TIMEOUT', 'x', { details: ['phase: waiting-for-first-chunk (…)'] }),
      ),
    ).toBe(true);
    expect(
      isTemporaryUnavailable(
        new AppError('TIMEOUT', 'x', { details: ['phase: waiting-for-http-response (…)'] }),
      ),
    ).toBe(true);
  });
  it('is false for permanent problems, which another model would not fix', () => {
    expect(isTemporaryUnavailable(bad400())).toBe(false);
    expect(isTemporaryUnavailable(missing404())).toBe(false);
    expect(
      isTemporaryUnavailable(new AppError('AI_NOT_CONFIGURED', 'key', { details: ['Gemini status 403'] })),
    ).toBe(false);
    expect(isTemporaryUnavailable(new AppError('INVALID_INPUT', 'blocked'))).toBe(false);
    expect(isTemporaryUnavailable(new AppError('CANCELLED'))).toBe(false);
  });
  it('is false for a network failure (no HTTP status) and for a stream that broke half way', () => {
    expect(isTemporaryUnavailable(new AppError('AI_BUSY', "We couldn't reach Gemini right now"))).toBe(false);
    expect(
      isTemporaryUnavailable(new AppError('TIMEOUT', 'x', { details: ['Stream paused for more than 30 s'] })),
    ).toBe(false);
    expect(isTemporaryUnavailable(new Error('boom'))).toBe(false);
  });
});

describe('runWithFallback', () => {
  const pool = (
    fallbacks: string[] | (() => Promise<string[]>),
    limits = DEFAULT_MODEL_PLAN_LIMITS,
  ): ModelPool => ({
    primary: 'gemini-3.8-flash',
    fallbacks: typeof fallbacks === 'function' ? fallbacks : vi.fn(async () => fallbacks),
    limits,
  });

  it('happy path: one call on the primary, and the alternatives are never even looked up', async () => {
    const p = pool(['gemini-3.6-flash']);
    const run = vi.fn(async () => 'plan');
    const r = await runWithFallback(p, run);
    expect(r).toMatchObject({ value: 'plan', model: 'gemini-3.8-flash', tried: [] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('gemini-3.8-flash', 1); // the primary may retry once
    expect(p.fallbacks).not.toHaveBeenCalled();
  });

  it('a temporary failure moves to the next model, with no extra retries on alternatives', async () => {
    const run = vi.fn(async (m: string) => {
      if (m === 'gemini-3.8-flash') throw busy503();
      return `plan-from-${m}`;
    });
    const seen: string[] = [];
    const r = await runWithFallback(pool(['gemini-3.6-flash', 'gemini-2.5-flash']), run, {
      onFallback: (i) => seen.push(`${i.from}->${i.to}`),
    });
    expect(r.model).toBe('gemini-3.6-flash');
    expect(r.value).toBe('plan-from-gemini-3.6-flash');
    expect(run.mock.calls).toEqual([
      ['gemini-3.8-flash', 1],
      ['gemini-3.6-flash', 0],
    ]);
    expect(seen).toEqual(['gemini-3.8-flash->gemini-3.6-flash']);
  });

  it('a permanent error on the primary is shown, not hidden behind another model', async () => {
    const p = pool(['gemini-3.6-flash']);
    const err = bad400();
    await expect(runWithFallback(p, async () => Promise.reject(err))).rejects.toBe(err);
    expect(p.fallbacks).not.toHaveBeenCalled();
  });

  it('total failure: AI_BUSY listing every model tried, honest and retryable', async () => {
    const run = vi.fn(async () => Promise.reject(busy503()));
    const e = (await runWithFallback(pool(['gemini-3.6-flash', 'gemini-2.5-flash']), run).catch(
      (x) => x,
    )) as AppError;
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('AI_BUSY');
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/very busy right now \(3 models tried\)/);
    expect(e.details).toHaveLength(3);
    expect(e.details![0]).toMatch(/^gemini-3\.8-flash: Gemini status 503 — Google said: UNAVAILABLE/);
    expect(e.details![2]).toMatch(/^gemini-2\.5-flash: /);
    expect(run).toHaveBeenCalledTimes(3); // one `run` per model (the primary's retry happens inside it)
  });

  it('a retired alternative (404) is skipped and the next one is tried', async () => {
    const run = vi.fn(async (m: string) => {
      if (m === 'gemini-3.8-flash') throw busy503();
      if (m === 'gemini-2.5-flash') throw missing404();
      return 'ok';
    });
    const r = await runWithFallback(pool(['gemini-2.5-flash', 'gemini-3.6-flash']), run);
    expect(r.model).toBe('gemini-3.6-flash');
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      'gemini-3.8-flash',
      'gemini-2.5-flash',
      'gemini-3.6-flash',
    ]);
  });

  it('never tries more alternatives than the cap allows', async () => {
    const run = vi.fn(async (_model: string) => Promise.reject(busy503()));
    await runWithFallback(pool(['a-model-1', 'a-model-2', 'a-model-3', 'a-model-4']), run).catch(
      () => undefined,
    );
    expect(run.mock.calls.map((c) => c[0])).toEqual(['gemini-3.8-flash', 'a-model-1', 'a-model-2']);
  });

  it("no alternatives at all: the primary's own error, plus a note", async () => {
    const e = (await runWithFallback(pool([]), async () => Promise.reject(busy503())).catch(
      (x) => x,
    )) as AppError;
    expect(e.code).toBe('AI_BUSY');
    expect(e.details).toContain('No alternative model was available to try (see GEMINI_MODEL_FALLBACKS).');
    expect(e.details).toContain('Gemini status 503');
  });

  it('a failing model-list lookup is treated as "no alternatives", never as a crash', async () => {
    const e = (await runWithFallback(
      pool(async () => {
        throw new Error('list failed');
      }),
      async () => Promise.reject(busy503()),
    ).catch((x) => x)) as AppError;
    expect(e.code).toBe('AI_BUSY');
    expect(e.details).toContain('No alternative model was available to try (see GEMINI_MODEL_FALLBACKS).');
  });

  it('cancellation stops immediately, with no further calls', async () => {
    const p = pool(['gemini-3.6-flash']);
    const run = vi.fn(async () => Promise.reject(new AppError('CANCELLED')));
    await expect(runWithFallback(p, run)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(p.fallbacks).not.toHaveBeenCalled();
  });
});
