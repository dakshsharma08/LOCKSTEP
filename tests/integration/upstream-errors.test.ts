/**
 * When Gemini fails, the server log must say WHY (one searchable `ai_error` line per failed request, and
 * one `api_result` line per /api/plan request), without ever logging keys, prompts or the user's text;
 * and the browser must get an accurate error (code, status, Google's reason).
 *
 * Real SDK against a local fake Google over real HTTP (tests/helpers/fakeGemini.ts).
 */
import { GoogleGenAI } from '@google/genai';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app';
import { startFakeGemini, type FakeGemini, type FakeReply, type FakeRequest } from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-upstream-key-0123456789abcdefg`;
const MODEL = 'gemini-3.1-flash-lite';
const GOAL = 'Pass the AWS Cloud Practitioner exam for my secret promotion';
const CONSTRAINTS = 'Only evenings, my manager Dana must not know';

let fake: FakeGemini | null = null;
let server: Server | null = null;
let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  server?.close();
  await fake?.close();
  fake = server = null;
});

async function planWith(decide: (r: FakeRequest) => FakeReply | void, tuning: Record<string, unknown> = {}) {
  fake = await startFakeGemini(decide, { models: [MODEL, 'gemini-3.5-flash', 'gemini-3.6-flash'] });
  const app = createApp({
    now: () => new Date('2026-11-23T12:00:00Z'),
    env: { GEMINI_API_KEY: KEY, ALLOWED_ORIGINS: '' },
    gemini: new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } }) as never,
    tuning: {
      firstChunkTimeoutMs: 300,
      retryBaseMs: 1,
      retryMaxMs: 2,
      rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
      ...tuning,
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: GOAL,
      deadlineDate: '2026-12-18',
      deadlineTime: '10:00',
      timezone: 'UTC',
      level: 'Beginner',
      hoursPerDay: 2,
      workingDays: [1, 2, 3, 4, 5],
      constraints: CONSTRAINTS,
      pace: 'Balanced',
    }),
  });
  const text = await res.text();
  const events = text
    .split(/\r?\n\r?\n/)
    .map((raw) => ({ event: /^event:\s*(.+)$/m.exec(raw)?.[1], data: /^data:\s*(.+)$/m.exec(raw)?.[1] }))
    .filter((e): e is { event: string; data: string } => !!e.event && !!e.data)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
  return { status: res.status, events };
}
const lines = (type: string) =>
  logs.filter((l) => l.startsWith(`{"type":"${type}"`)).map((l) => JSON.parse(l) as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
const noSecretsOrUserText = () => {
  const all = logs.join('\n');
  expect(all).not.toContain(KEY);
  expect(all).not.toContain('secret promotion');
  expect(all).not.toContain('Dana');
};

describe('a Google 400 (request rejected)', () => {
  const reject: FakeReply = {
    error: {
      status: 400,
      code: 'INVALID_ARGUMENT',
      message: "Invalid value at 'generation_config.response_mime_type'.",
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'generation_config.response_mime_type', description: 'Invalid value.' }],
        },
      ],
    },
  };

  it('logs ONE ai_error line with the status, Google status, message, field violation, model, stage and code', async () => {
    await planWith((r) => (r.stream ? reject : undefined));
    const [err, ...more] = lines('ai_error');

    expect(more).toHaveLength(0); // a 400 is not retried and not sent to another model
    expect(err).toMatchObject({
      type: 'ai_error',
      kind: 'plan',
      model: MODEL,
      stage: 'http-error',
      attempt: 1,
      httpStatus: 400,
      googleStatus: 'INVALID_ARGUMENT',
      googleMessage: "Invalid value at 'generation_config.response_mime_type'.",
      fieldViolations: [{ field: 'generation_config.response_mime_type', description: 'Invalid value.' }],
      appCode: 'INTERNAL',
      appStatus: 502,
      thinking: { includeThoughts: true, thinkingLevel: 'LOW' },
    });
    expect(typeof err!.latencyMs).toBe('number');
    noSecretsOrUserText();
  });

  it('logs an api_result line that says the 200 stream carried an error, with the real statuses', async () => {
    await planWith((r) => (r.stream ? reject : undefined));
    expect(lines('api_result')).toEqual([
      expect.objectContaining({
        route: '/api/plan',
        transport: 'sse',
        httpStatus: 200,
        outcome: 'error',
        code: 'INTERNAL',
        errorStatus: 502,
        upstreamStatus: 400,
        retryable: false,
        modelsTried: [MODEL],
      }),
    ]);
  });

  it('the browser gets an accurate error: status 502, an honest message and Google’s reason', async () => {
    const { status, events } = await planWith((r) => (r.stream ? reject : undefined));
    const err = events.at(-1)!;

    expect(status).toBe(200); // the event stream was already open
    expect(err.event).toBe('error');
    expect(err.data).toMatchObject({ code: 'INTERNAL', status: 502, retryable: false });
    expect(err.data.message).toMatch(/^Gemini rejected this request \(HTTP 400\), so no plan was made/);
    expect(err.data.details).toEqual([
      'Gemini status 400',
      "Google said: INVALID_ARGUMENT: Invalid value at 'generation_config.response_mime_type'.",
    ]);
  });
});

describe('other failures', () => {
  it('an invalid API key: reason API_KEY_INVALID in the log; the browser is told the server key was rejected', async () => {
    const { events } = await planWith((r) =>
      r.stream
        ? {
            error: {
              status: 400,
              code: 'INVALID_ARGUMENT',
              message: 'API key not valid. Please pass a valid API key.',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'API_KEY_INVALID',
                  domain: 'googleapis.com',
                  metadata: { service: 'generativelanguage.googleapis.com', consumer: 'projects/987654321' },
                },
              ],
            },
          }
        : undefined,
    );

    expect(lines('ai_error')[0]).toMatchObject({
      httpStatus: 400,
      googleReason: 'API_KEY_INVALID',
      appCode: 'AI_NOT_CONFIGURED',
      appStatus: 503,
    });
    expect(logs.join('\n')).not.toContain('987654321'); // project metadata is never logged
    expect(events.at(-1)!.data).toMatchObject({ code: 'AI_NOT_CONFIGURED', status: 503 });
    expect(events.at(-1)!.data.message).toMatch(/Gemini API key was rejected/);
    noSecretsOrUserText();
  });

  it('a quota 429: quota id and retry delay in the log, then the next model', async () => {
    await planWith((r) =>
      r.stream && r.model === MODEL
        ? {
            error: {
              status: 429,
              code: 'RESOURCE_EXHAUSTED',
              message: 'You exceeded your current quota.',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
                },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
              ],
            },
          }
        : undefined,
    );
    expect(lines('ai_error')).toEqual([
      expect.objectContaining({
        model: MODEL,
        httpStatus: 429,
        quotaIds: ['GenerateRequestsPerDayPerProjectPerModel-FreeTier'],
        retryDelay: '37s',
        appCode: 'AI_BUSY',
      }),
    ]);
    expect(lines('api_result')[0]).toMatchObject({ outcome: 'ok', model: 'gemini-3.5-flash' });
  });

  it('a stream that stalls (our own timeout): stage, chunk counts and the cause, no Google fields', async () => {
    await planWith((r) => (r.stream && r.model === MODEL ? { stallAfterChunks: 2 } : undefined), {
      chunkIdleTimeoutMs: 200,
    });
    const [stall] = lines('ai_error');
    expect(stall).toMatchObject({
      model: MODEL,
      stage: 'streaming',
      appCode: 'TIMEOUT',
      chunks: 2,
      textChunks: 2,
    });
    expect(stall!.cause).toMatch(/Stream paused for more than/);
    expect(stall!.httpStatus).toBeUndefined();
    noSecretsOrUserText();
  });

  it('a success logs no ai_error, and api_result says ok with the model', async () => {
    await planWith(() => undefined);
    expect(lines('ai_error')).toHaveLength(0);
    expect(lines('api_result')).toEqual([
      expect.objectContaining({ outcome: 'ok', model: MODEL, httpStatus: 200, modelsTried: [MODEL] }),
    ]);
    noSecretsOrUserText();
  });
});
