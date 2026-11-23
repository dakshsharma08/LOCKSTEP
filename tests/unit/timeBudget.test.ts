/**
 * The worst-case execution time of ONE /api/plan request must stay under Vercel's maxDuration (300 s),
 * otherwise the platform kills the function half way and the user only sees a dropped connection.
 *
 * How the limit holds: every model attempt and the repair run under one shared AbortSignal that fires at
 * tuning.planBudgetMs (270 s). After it fires nothing new is started; what is left is sending one SSE
 * error event. So: worst case ≈ planBudgetMs + a few seconds (cold start, request parsing, SSE close).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_PLAN_LIMITS,
  maxUpstreamCalls,
  runWithFallback,
  type ModelPool,
} from '../../server/gemini/fallback';
import { withoutThoughtSummaries } from '../../server/gemini/plan';
import { DEFAULT_TUNING } from '../../server/lib/config';
import { AppError } from '../../server/lib/errors';

const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
  functions: Record<string, { maxDuration?: number }>;
};
const maxDurationMs = (vercel.functions['api/index.js']?.maxDuration ?? 0) * 1000;
/** Time outside Gemini calls: cold start, body parsing, rate limit check, SSE writes. Generous. */
const OVERHEAD_MS = 20_000;

describe('worst-case time of one plan request vs Vercel maxDuration', () => {
  const t = DEFAULT_TUNING;

  it('vercel.json gives the API function 300 s', () => {
    expect(maxDurationMs).toBe(300_000);
  });
  it('the plan time limit plus overhead fits inside maxDuration', () => {
    expect(t.planBudgetMs).toBe(270_000);
    expect(t.planBudgetMs + OVERHEAD_MS).toBeLessThanOrEqual(maxDurationMs);
  });
  it('WITHOUT the shared limit the steps alone could exceed it (which is why the limit exists)', () => {
    // 1 primary stream (+1 retry, both inside one stream's total cap), 2 alternatives, 1 repair.
    const unbounded =
      t.streamTotalTimeoutMs * (1 + DEFAULT_MODEL_PLAN_LIMITS.maxFallbacks) + t.repairTimeoutMs;
    expect(unbounded).toBeGreaterThan(maxDurationMs);
  });
  it('each single step fits inside the limit, and a started attempt gets at least its first-chunk window', () => {
    expect(t.streamTotalTimeoutMs).toBeLessThan(t.planBudgetMs);
    expect(t.repairTimeoutMs).toBeLessThan(t.planBudgetMs);
    expect(t.minAttemptMs).toBeGreaterThanOrEqual(t.firstChunkTimeoutMs);
  });
  it('the four-call cap on plan generation is unchanged', () => {
    expect(maxUpstreamCalls(DEFAULT_MODEL_PLAN_LIMITS)).toBe(4);
  });
  it('the repair gets a plan-sized limit (120 s), not the 30 s used for small calls', () => {
    expect(t.repairTimeoutMs).toBe(120_000);
    expect(t.callTimeoutMs).toBe(30_000);
  });
});

describe('repair thinking setting', () => {
  it('reuses the level that worked for the plan, without thought summaries (the repair is not streamed)', () => {
    expect(withoutThoughtSummaries({ includeThoughts: true, thinkingLevel: 'LOW' as never })).toEqual({
      thinkingLevel: 'LOW',
    });
    expect(withoutThoughtSummaries({ includeThoughts: true, thinkingBudget: 1024 })).toEqual({
      thinkingBudget: 1024,
    });
    expect(withoutThoughtSummaries({ includeThoughts: true })).toBeUndefined();
    expect(withoutThoughtSummaries(undefined)).toBeUndefined();
  });
});

describe('runWithFallback respects the time left', () => {
  const busy503 = () =>
    new AppError('AI_BUSY', undefined, { details: ['Gemini status 503', 'Google said: UNAVAILABLE'] });
  const pool = (left: number): ModelPool => ({
    primary: 'gemini-3.8-flash',
    fallbacks: async () => ['gemini-3.5-flash', 'gemini-3.6-flash'],
    limits: DEFAULT_MODEL_PLAN_LIMITS,
    remainingMs: () => left,
    minAttemptMs: 30_000,
  });

  it('does not START another model with less than minAttemptMs left, and says why', async () => {
    const run = vi.fn(async () => Promise.reject(busy503()));
    const e = (await runWithFallback(pool(12_000), run).catch((x) => x)) as AppError;
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.code).toBe('AI_BUSY');
    expect(e.details?.at(-1)).toBe(
      'No further model was tried: only 12 s of the planning time limit was left.',
    );
  });
  it('with enough time left it moves on as usual', async () => {
    const run = vi.fn(async (m: string) => (m === 'gemini-3.8-flash' ? Promise.reject(busy503()) : 'plan'));
    const r = await runWithFallback(pool(200_000), run);
    expect(r.model).toBe('gemini-3.5-flash');
  });
  it('the plan time limit itself is never a reason to try another model', async () => {
    const limitHit = new AppError('TIMEOUT', 'Planning took longer than 270 s', {
      details: ['phase: plan-time-limit (…)'],
    });
    const run = vi.fn(async () => Promise.reject(limitHit));
    await expect(runWithFallback(pool(200_000), run)).rejects.toBe(limitHit);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
