/**
 * Which upstream errors are retried ON THE SAME MODEL (withRetry), and which go straight on.
 * A quota-exhausted 429 must not be retried: the free-tier limit is per minute or per day, so a retry a
 * second later cannot succeed (owner's real run: gemini-3.8-flash, "limit: 20").
 */
import { describe, expect, it } from 'vitest';
import { isTemporaryUnavailable } from '../../server/gemini/fallback';
import { AppError, isQuotaExhausted, isRetryableUpstream, toAppError } from '../../server/lib/errors';

/** What the @google/genai SDK throws for an HTTP error: an Error with a numeric status and Google's JSON. */
const googleError = (status: number, message: string, code: string) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, message, status: code } })), { status });

const quota = googleError(
  429,
  'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash',
  'RESOURCE_EXHAUSTED',
);
const plain429 = googleError(429, 'Too many concurrent requests. Slow down.', 'RESOURCE_EXHAUSTED');
const overloaded = googleError(503, 'This model is currently experiencing high demand.', 'UNAVAILABLE');

describe('same-model retries', () => {
  it('a quota-exhausted 429 is NOT retried', () => {
    expect(isQuotaExhausted(quota)).toBe(true);
    expect(isRetryableUpstream(quota)).toBe(false);
  });
  it('a 429 that is not about quota, a 503 and a 500 are still retried', () => {
    expect(isQuotaExhausted(plain429)).toBe(false);
    expect(isRetryableUpstream(plain429)).toBe(true);
    expect(isRetryableUpstream(overloaded)).toBe(true);
    expect(isRetryableUpstream(googleError(500, 'Internal error', 'INTERNAL'))).toBe(true);
  });
  it('400, 403 and 404 are never retried', () => {
    for (const s of [400, 403, 404]) expect(isRetryableUpstream(googleError(s, 'no', 'X'))).toBe(false);
  });
  it('our own errors (timeouts, cancellations) are never retried by withRetry', () => {
    expect(isRetryableUpstream(new AppError('TIMEOUT'))).toBe(false);
    expect(isRetryableUpstream(new AppError('CANCELLED'))).toBe(false);
  });
  it('a quota 429 is still a TEMPORARY failure, so the plan still falls back to another model', () => {
    const mapped = toAppError(quota);
    expect(mapped.code).toBe('AI_BUSY');
    expect(isTemporaryUnavailable(mapped)).toBe(true);
  });
});
