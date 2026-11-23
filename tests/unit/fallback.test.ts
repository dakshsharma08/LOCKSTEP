import { describe, expect, it, vi } from 'vitest';
import { AppError, toAppError } from '../../server/lib/errors';
import { TOO_MANY_STATES } from '../helpers/fakeGemini';
import {
  DEFAULT_MODEL_PLAN_LIMITS,
  allowedFallbackCount,
  isModelUnavailable,
  isTemporaryUnavailable,
  maxUpstreamCalls,
  parseFallbackList,
  pickFallbacks,
  PREFERRED_FALLBACKS,
  EXCLUDED_FALLBACKS,
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
  // What the developer's key really lists (real diagnostics, 2026-11-23) plus noise that must never be picked.
  const list = [
    'models/gemini-3.8-flash',
    'models/gemini-3.7-flash', // 503 / timeout in real diagnostics: excluded from the default chain
    'models/gemini-3.6-flash', // small requests OK, but the full plan stream stalled: second
    'models/gemini-3.5-flash', // full plan request OK (~78 s): first
    'models/gemini-3.5-flash-lite',
    'models/gemini-2.5-flash', // 404, "not available to new users": excluded from the default chain
    'models/gemini-3-flash-preview', // preview: never auto-picked
    'models/gemini-3.8-flash-image', // image model
    'models/gemini-flash-latest', // moving alias: could be the same overloaded model
    'models/gemini-3.6-flash-001', // pinned revision: only the alias name is used
    'models/gemini-embedding-001',
  ];

  it('default order after gemini-3.8-flash: gemini-3.5-flash, then gemini-3.6-flash', () => {
    expect(pickFallbacks(list, 'gemini-3.8-flash', 2)).toEqual(['gemini-3.5-flash', 'gemini-3.6-flash']);
  });
  it('3.5 comes first even though 3.6 is the newer version (preferred order beats recency)', () => {
    expect(pickFallbacks(['gemini-3.6-flash', 'gemini-3.5-flash'], 'gemini-3.8-flash', 1)).toEqual([
      'gemini-3.5-flash',
    ]);
  });
  it("the order does not depend on the order of the key's list", () => {
    expect(pickFallbacks([...list].reverse(), 'gemini-3.8-flash', 2)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.6-flash',
    ]);
  });
  it('gemini-3.7-flash and gemini-2.5-flash are never picked automatically, even with room to spare', () => {
    const all = pickFallbacks(list, 'gemini-3.8-flash', 10);
    expect(all).not.toContain('gemini-3.7-flash');
    expect(all).not.toContain('gemini-2.5-flash');
    // …and the rest is still ordered: preferred first, then other Flash, Flash-Lite last.
    expect(all).toEqual(['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  });
  it('a preferred model the key does not list is skipped (a retired model drops out by itself)', () => {
    expect(pickFallbacks(['gemini-3.8-flash', 'gemini-3.5-flash'], 'gemini-3.8-flash', 2)).toEqual([
      'gemini-3.5-flash',
    ]);
    expect(pickFallbacks(['gemini-3.8-flash', 'gemini-3.6-flash'], 'gemini-3.8-flash', 2)).toEqual([
      'gemini-3.6-flash',
    ]);
  });
  it('fills a free slot with another stable Flash model, newest first, but never an excluded one', () => {
    const names = [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.4-flash',
      'gemini-2.5-flash',
    ];
    expect(pickFallbacks(names, 'gemini-3.8-flash', 2)).toEqual(['gemini-3.6-flash', 'gemini-3.4-flash']);
    expect(
      pickFallbacks(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash'], 'gemini-3.8-flash', 2),
    ).toEqual([]);
  });
  it('respects the maximum, including 1 and 0', () => {
    expect(pickFallbacks(list, 'gemini-3.8-flash', 1)).toEqual(['gemini-3.5-flash']);
    expect(pickFallbacks(list, 'gemini-3.8-flash', 0)).toEqual([]);
  });
  it('never returns the primary, even if the primary is a preferred model', () => {
    expect(pickFallbacks(list, 'gemini-3.6-flash', 2)).toEqual(['gemini-3.5-flash', 'gemini-3.8-flash']);
  });
  it('never invents models: a list without alternatives gives none', () => {
    expect(
      pickFallbacks(['models/gemini-3.8-flash', 'models/gemini-3-flash-preview'], 'gemini-3.8-flash', 2),
    ).toEqual([]);
    expect(pickFallbacks([], 'gemini-3.8-flash', 2)).toEqual([]);
  });
  it('works when the primary is an alias', () => {
    expect(pickFallbacks(list, 'gemini-flash-latest', 1)).toEqual(['gemini-3.5-flash']);
  });
  it('the constants say exactly what was verified', () => {
    expect([...PREFERRED_FALLBACKS]).toEqual(['gemini-3.5-flash', 'gemini-3.6-flash']);
    expect([...EXCLUDED_FALLBACKS]).toEqual(['gemini-3.7-flash', 'gemini-2.5-flash']);
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

  it('a schema rejection (400) on an alternative STOPS the chain: accurate error, not AI_BUSY, no 3rd model', async () => {
    // The owner's real case: primary over quota (429), then gemini-3.6-flash rejected the schema (400).
    const quota429 = new AppError('AI_BUSY', undefined, {
      details: ['Gemini status 429', 'Google said: RESOURCE_EXHAUSTED: You exceeded your current quota.'],
    });
    const schema400 = toAppError(
      Object.assign(
        new Error(
          JSON.stringify({ error: { code: 400, message: TOO_MANY_STATES, status: 'INVALID_ARGUMENT' } }),
        ),
        { status: 400 },
      ),
    );
    const run = vi.fn(async (m: string) => {
      if (m === 'gemini-3.8-flash') throw quota429;
      throw schema400;
    });
    const e = (await runWithFallback(pool(['gemini-3.6-flash', 'gemini-3.5-flash']), run).catch(
      (x) => x,
    )) as AppError;

    expect(run.mock.calls.map((c) => c[0])).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash']);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('INTERNAL');
    expect(e.code).not.toBe('AI_BUSY');
    expect(e.retryable).toBe(false);
    expect(e.message).toBe(schema400.message);
    expect(e.message).not.toMatch(/busy/i);
    expect(e.details![0]).toMatch(
      /^gemini-3\.6-flash: Gemini status 400 — Google said: INVALID_ARGUMENT: The specified schema .*too many states/,
    );
    expect(e.details![1]).toMatch(
      /^gemini-3\.8-flash \(tried first\): Gemini status 429 — Google said: RESOURCE_EXHAUSTED/,
    );
    expect(e.details).toContain('Not a temporary error, so no further model was tried.');
  });

  it('any other permanent error on an alternative (400, 403) also stops the chain', async () => {
    const forbidden = new AppError('AI_NOT_CONFIGURED', 'key rejected', {
      details: ['Gemini status 403', 'Google said: PERMISSION_DENIED: nope'],
    });
    for (const err of [bad400(), forbidden]) {
      const run = vi.fn(async (m: string) => {
        if (m === 'gemini-3.8-flash') throw busy503();
        throw err;
      });
      const e = (await runWithFallback(pool(['gemini-3.6-flash', 'gemini-3.5-flash']), run).catch(
        (x) => x,
      )) as AppError;
      expect(run).toHaveBeenCalledTimes(2);
      expect(e.code).toBe(err.code);
    }
  });

  it('only a temporary error or a 404 on an alternative moves on to the next one', async () => {
    const run = vi.fn(async (m: string) => {
      if (m === 'gemini-3.8-flash') throw busy503();
      if (m === 'gemini-3.6-flash') throw busy503();
      return 'ok';
    });
    const r = await runWithFallback(pool(['gemini-3.6-flash', 'gemini-3.5-flash']), run);
    expect(r.model).toBe('gemini-3.5-flash');
    expect(isModelUnavailable(missing404())).toBe(true);
    expect(isModelUnavailable(bad400())).toBe(false);
    expect(isModelUnavailable(busy503())).toBe(false);
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
