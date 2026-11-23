/**
 * googleErrorInfo turns Google's error body (kept by the SDK as JSON in error.message) into safe log
 * fields: HTTP status, status name, message, reason, field violations, quota ids, retry delay.
 * It must redact secrets, shorten long text and leave out metadata that can identify the project.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../server/lib/errors';
import { googleErrorInfo } from '../../server/lib/redact';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-unit-key-0123456789abcdefghijk`;

/** What the @google/genai SDK throws for an HTTP error: an Error with .status and Google's JSON. */
const sdkError = (status: number, error: Record<string, unknown>) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, ...error } })), { status });

describe('googleErrorInfo', () => {
  it('an invalid API key: status, name, message and reason; no project metadata', () => {
    const info = googleErrorInfo(
      sdkError(400, {
        status: 'INVALID_ARGUMENT',
        message: 'API key not valid. Please pass a valid API key.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com', consumer: 'projects/123456789' },
          },
          { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ url: 'https://example.test/help' }] },
        ],
      }),
    );
    expect(info).toEqual({
      httpStatus: 400,
      googleStatus: 'INVALID_ARGUMENT',
      googleMessage: 'API key not valid. Please pass a valid API key.',
      googleReason: 'API_KEY_INVALID',
    });
    expect(JSON.stringify(info)).not.toMatch(/123456789|example\.test/);
  });

  it('a bad request: the field violations (at most 3)', () => {
    const info = googleErrorInfo(
      sdkError(400, {
        status: 'INVALID_ARGUMENT',
        message: 'Invalid JSON payload received.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: Array.from({ length: 5 }, (_, i) => ({
              field: `generation_config.f${i}`,
              description: `Cannot find field ${i}.`,
            })),
          },
        ],
      }),
    );
    expect(info?.fieldViolations).toHaveLength(3);
    expect(info?.fieldViolations?.[0]).toEqual({
      field: 'generation_config.f0',
      description: 'Cannot find field 0.',
    });
  });

  it('a quota error: quota ids and retry delay', () => {
    const info = googleErrorInfo(
      sdkError(429, {
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaMetric: 'm', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
        ],
      }),
    );
    expect(info).toMatchObject({
      httpStatus: 429,
      googleStatus: 'RESOURCE_EXHAUSTED',
      quotaIds: ['GenerateRequestsPerDayPerProjectPerModel-FreeTier'],
      retryDelay: '37s',
    });
  });

  it('never lets a key through, even if Google echoed one, and shortens long messages', () => {
    const info = googleErrorInfo(
      sdkError(400, { status: 'INVALID_ARGUMENT', message: `Bad key ${KEY} ${'x'.repeat(600)}` }),
    );
    expect(JSON.stringify(info)).not.toContain(KEY);
    expect(info?.googleMessage).toMatch(/^Bad key \[redacted\]/);
    expect(info!.googleMessage!.length).toBeLessThanOrEqual(301);
  });

  it("our own errors (AppError) are not Google's: no fake HTTP status", () => {
    expect(googleErrorInfo(new AppError('TIMEOUT', undefined, { details: ['Stream paused'] }))).toBeNull();
  });

  it('errors without a Google body: only the status, or nothing', () => {
    expect(googleErrorInfo(Object.assign(new Error('fetch failed'), { status: 502 }))).toEqual({
      httpStatus: 502,
    });
    expect(googleErrorInfo(new Error('fetch failed'))).toBeNull();
    expect(googleErrorInfo(undefined)).toBeNull();
  });
});
