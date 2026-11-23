/**
 * Per-model cooldown (server/gemini/modelHealth.ts): after a failure a model is skipped for a while, with
 * exponential backoff and jitter; quota errors follow Google's retryDelay or the daily reset (midnight
 * Pacific, re-checked hourly); configuration errors never cool a model down.
 */
import { describe, expect, it } from 'vitest';
import { ModelHealth, nextPacificMidnight } from '../../server/gemini/modelHealth';
import { AppError, toAppError } from '../../server/lib/errors';

const SETTINGS = { baseMs: 30_000, maxMs: 600_000, dailyRecheckMs: 3_600_000 };
/** What the SDK throws for an HTTP error: an Error with .status and Google's JSON body. */
const googleError = (status: number, error: Record<string, unknown>) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, ...error } })), { status });
const overloaded = () =>
  googleError(503, { status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' });
const quota = (quotaId: string, retryDelay?: string) =>
  googleError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
      ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
    ],
  });
const fail = (h: ModelHealth, raw: unknown) => h.markFailure('m', raw, toAppError(raw));

describe('ModelHealth: temporary failures (503, no answer, stall, cut-off)', () => {
  it('exponential backoff with equal jitter: up to 30 s, 60 s, 120 s …, capped at 10 min', () => {
    let now = 0;
    const lo = new ModelHealth(
      SETTINGS,
      () => now,
      () => 0,
    ); // lowest jitter
    const hi = new ModelHealth(
      SETTINGS,
      () => now,
      () => 0.999999,
    ); // highest jitter
    expect([1, 2, 3].map(() => fail(lo, overloaded()))).toEqual([15_000, 30_000, 60_000]);
    expect([1, 2, 3].map(() => Math.round(fail(hi, overloaded()) / 1000))).toEqual([30, 60, 120]);
    for (let i = 0; i < 10; i++) fail(hi, overloaded());
    expect(Math.round(fail(hi, overloaded()) / 1000)).toBe(600); // capped
    now = 1;
    expect(hi.coolingFor('m')).toBeGreaterThan(0);
  });

  it('cooling ends on time, and the first success resets the backoff', () => {
    let now = 0;
    const h = new ModelHealth(
      SETTINGS,
      () => now,
      () => 0.999999,
    );
    fail(h, overloaded());
    fail(h, overloaded()); // second consecutive failure: ~60 s
    expect(Math.round(h.coolingFor('m') / 1000)).toBe(60);
    expect(h.reasonFor('m')).toBe('HTTP 503');
    now = 61_000;
    expect(h.coolingFor('m')).toBe(0); // available again: one request may try it
    h.markSuccess('m');
    expect(Math.round(fail(h, overloaded()) / 1000)).toBe(30); // back to the first step
  });

  it('a stall, no answer and a cut-off answer also cool the model down', () => {
    const h = new ModelHealth(
      SETTINGS,
      () => 0,
      () => 0,
    );
    const stall = new AppError('TIMEOUT', undefined, { details: ['Stream paused', 'phase: streaming (…)'] });
    const noAnswer = new AppError('TIMEOUT', undefined, { details: ['phase: waiting-for-first-chunk (…)'] });
    const cut = new AppError('INTERNAL', 'x', { details: ['phase: incomplete-answer (…)'] });
    for (const e of [stall, noAnswer, cut]) expect(h.markFailure('m', e, e)).toBeGreaterThan(0);
  });

  it('never sooner than Google asked (retryDelay on a temporary error)', () => {
    const h = new ModelHealth(
      SETTINGS,
      () => 0,
      () => 0,
    );
    const err = googleError(503, {
      status: 'UNAVAILABLE',
      message: 'high demand',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' }],
    });
    expect(fail(h, err)).toBe(90_000);
  });
});

describe('ModelHealth: quota (429)', () => {
  it('a per-minute quota: exactly Google’s retryDelay', () => {
    const h = new ModelHealth(
      SETTINGS,
      () => 0,
      () => 0.5,
    );
    expect(fail(h, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '37s'))).toBe(37_000);
    expect(h.reasonFor('m')).toBe('quota');
  });
  it('a quota without a retryDelay: 60 s', () => {
    const h = new ModelHealth(
      SETTINGS,
      () => 0,
      () => 0.5,
    );
    expect(fail(h, quota('SomeQuota'))).toBe(60_000);
  });
  it('a DAILY quota: until midnight Pacific, but re-checked at most once an hour', () => {
    const at = (iso: string) => new Date(iso).getTime();
    // 23:30 PST (07:30 UTC): midnight Pacific is 30 min away → 30 min.
    const late = new ModelHealth(
      SETTINGS,
      () => at('2026-11-24T07:30:00Z'),
      () => 0.5,
    );
    expect(
      late.markFailure(
        'm',
        quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '37s'),
        toAppError(quota('x')),
      ),
    ).toBe(30 * 60_000);
    expect(late.reasonFor('m')).toBe('daily quota');
    // Noon UTC: midnight Pacific is 20 h away → the hourly re-check wins.
    const noon = new ModelHealth(
      SETTINGS,
      () => at('2026-11-23T12:00:00Z'),
      () => 0.5,
    );
    expect(
      noon.markFailure(
        'm',
        quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
        toAppError(quota('x')),
      ),
    ).toBe(3_600_000);
  });
});

describe('ModelHealth: no cooldown for configuration errors, cancellations, or when disabled', () => {
  it('400, 403 and 404 do not cool a model down (they are reported, not waited out)', () => {
    const h = new ModelHealth(
      SETTINGS,
      () => 0,
      () => 0.5,
    );
    for (const s of [400, 403, 404]) {
      expect(fail(h, googleError(s, { status: 'X', message: 'no' }))).toBe(0);
    }
    expect(h.coolingFor('m')).toBe(0);
    const cancelled = new AppError('CANCELLED');
    expect(h.markFailure('m', cancelled, cancelled)).toBe(0);
  });
  it('baseMs 0 disables cooldowns', () => {
    const h = new ModelHealth(
      { ...SETTINGS, baseMs: 0 },
      () => 0,
      () => 0.5,
    );
    expect(fail(h, overloaded())).toBe(0);
    expect(h.coolingFor('m')).toBe(0);
  });
});

describe('nextPacificMidnight (when Google resets daily quotas)', () => {
  const next = (iso: string) => new Date(nextPacificMidnight(new Date(iso).getTime())).toISOString();
  it('winter (PST, UTC−8) and summer (PDT, UTC−7)', () => {
    expect(next('2026-11-23T12:00:00Z')).toBe('2026-11-24T08:00:00.000Z');
    expect(next('2026-07-01T12:00:00Z')).toBe('2026-07-02T07:00:00.000Z');
  });
  it('just before and just after midnight Pacific', () => {
    expect(next('2026-11-24T07:59:00Z')).toBe('2026-11-24T08:00:00.000Z');
    expect(next('2026-11-24T08:01:00Z')).toBe('2026-11-25T08:00:00.000Z');
  });
  it('across the daylight-saving changes', () => {
    expect(next('2026-03-08T12:00:00Z')).toBe('2026-03-09T07:00:00.000Z'); // after spring forward
    expect(next('2026-10-31T12:00:00Z')).toBe('2026-11-01T07:00:00.000Z'); // the night before fall back
  });
});
