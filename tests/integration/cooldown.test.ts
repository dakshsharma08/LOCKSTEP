/**
 * Per-model cooldown across requests on ONE running app (how production sees consecutive plans): a model
 * that just failed is skipped WITHOUT a request until its cooldown ends; manual planning is unaffected.
 * Real SDK against a local fake Google over real HTTP.
 */
import { GoogleGenAI } from '@google/genai';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app';
import { startFakeGemini, type FakeGemini, type FakeReply, type FakeRequest } from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-cooldown-key-0123456789abcdefg`;
const LITE = 'gemini-3.5-flash-lite'; // default primary
const FIRST = 'gemini-3.1-flash-lite';
const SECOND = 'gemini-3.5-flash';
const MODELS = [LITE, FIRST, SECOND, 'gemini-3.6-flash', 'gemini-3.7-flash'];
const OVERLOADED: FakeReply = {
  error: { status: 503, code: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' },
};
const DAILY_QUOTA: FakeReply = {
  error: {
    status: 429,
    code: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota.',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
      },
    ],
  },
};
const INTAKE = {
  goal: 'Pass the AWS Cloud Practitioner exam',
  deadlineDate: '2026-12-18',
  deadlineTime: '10:00',
  timezone: 'UTC',
  level: 'Beginner',
  hoursPerDay: 2,
  workingDays: [1, 2, 3, 4, 5],
  constraints: '',
  pace: 'Balanced',
};

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

let decide: (r: FakeRequest) => FakeReply | void = () => undefined;
async function start(cooldown: Record<string, number> = {}) {
  fake = await startFakeGemini((r) => decide(r), { models: MODELS });
  const app = createApp({
    now: () => new Date('2026-11-23T12:00:00Z'),
    env: { GEMINI_API_KEY: KEY, ALLOWED_ORIGINS: '' },
    gemini: new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } }) as never,
    tuning: {
      firstChunkTimeoutMs: 300,
      retryBaseMs: 1,
      retryMaxMs: 2,
      rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
      cooldown,
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function plan(base: string) {
  const res = await fetch(`${base}/api/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(INTAKE),
  });
  return (await res.text())
    .split(/\r?\n\r?\n/)
    .map((raw) => ({ event: /^event:\s*(.+)$/m.exec(raw)?.[1], data: /^data:\s*(.+)$/m.exec(raw)?.[1] }))
    .filter((e): e is { event: string; data: string } => !!e.event && !!e.data)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}
const streams = () => fake!.requests.filter((r) => r.stream).map((r) => r.model);

describe('a model that just failed is skipped without a request', () => {
  it('503 on the primary: plan 1 falls back; plan 2 goes straight to the fallback (no request to the primary)', async () => {
    decide = (r) => (r.stream && r.model === LITE ? OVERLOADED : undefined);
    const base = await start();

    expect((await plan(base)).at(-1)?.event).toBe('result');
    expect(streams()).toEqual([LITE, FIRST]); // one call to the primary (a 503 is not retried)

    const second = await plan(base);
    expect(second.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([LITE, FIRST, FIRST]); // plan 2: NO request to the cooling primary
    expect(second.at(-1)!.data.runs.at(-1)).toMatchObject({ model: FIRST, ok: true });

    const skip = logs
      .filter((l) => l.startsWith('{"type":"ai_diag"'))
      .map((l) => JSON.parse(l))
      .filter((d) => d.event === 'model_fallback')
      .at(-1);
    expect(skip.reason).toMatch(
      /^Skipped without a request: gemini-3\.5-flash-lite is cooling down for \d+ s after HTTP 503\.$/,
    );
    const err = logs.filter((l) => l.startsWith('{"type":"ai_error"')).map((l) => JSON.parse(l));
    expect(err).toHaveLength(1); // only the one real failure is logged as a request error
    expect(err[0]).toMatchObject({ model: LITE, httpStatus: 503 });
    expect(err[0].cooldownSec).toBeGreaterThanOrEqual(15);
  });

  it('every model failed moments ago: the next plan makes ZERO Gemini requests and says so honestly', async () => {
    decide = (r) => (r.stream ? OVERLOADED : undefined);
    const base = await start();
    expect((await plan(base)).at(-1)?.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([LITE, FIRST, SECOND]); // one call each

    const err = (await plan(base)).at(-1)!;
    expect(streams()).toHaveLength(3); // nothing new was sent
    expect(err.event).toBe('error');
    expect(err.data).toMatchObject({ code: 'AI_BUSY', retryable: true });
    expect(err.data.details).toHaveLength(3);
    for (const d of err.data.details)
      expect(d).toMatch(/Skipped without a request: .* is cooling down for \d+ s after HTTP 503/);
  });

  it('a daily-quota 429: the model is skipped on the next plan as well', async () => {
    decide = (r) => (r.stream && r.model === LITE ? DAILY_QUOTA : undefined);
    const base = await start();
    await plan(base);
    await plan(base);
    expect(streams()).toEqual([LITE, FIRST, FIRST]);
  });

  it('when the cooldown is over the model is tried again, and a success clears it', async () => {
    let liteDown = true;
    decide = (r) => (r.stream && r.model === LITE && liteDown ? OVERLOADED : undefined);
    const base = await start({ baseMs: 60, maxMs: 60 });
    await plan(base); // LITE 503 → FIRST
    liteDown = false;
    await new Promise((r) => setTimeout(r, 120)); // cooldown (≤ 60 ms) is over
    expect((await plan(base)).at(-1)!.data.runs.at(-1).model).toBe(LITE);
    expect(streams()).toEqual([LITE, FIRST, LITE]);
  });

  it('a 400 does NOT cool a model down (it is reported, and the next plan tries the model again)', async () => {
    decide = (r) =>
      r.stream && r.model === LITE
        ? { error: { status: 400, code: 'INVALID_ARGUMENT', message: 'Bad field.' } }
        : undefined;
    const base = await start();
    await plan(base);
    await plan(base);
    expect(streams()).toEqual([LITE, LITE]); // no fallback on a 400, and no cooldown either
  });
});

describe('the other AI features share the cooldown', () => {
  it('motivation: after a 503 the same model is not called again during its cooldown (no request)', async () => {
    decide = (r) => (!r.stream && r.model === LITE ? OVERLOADED : undefined);
    const base = await start();
    const body = JSON.stringify({
      goal: 'Ship my portfolio website',
      daysLeft: 11,
      percentDone: 33,
      nextMilestone: 'Build pages',
      streak: 2,
      pace: 'behind',
      state: 'active',
      dateKey: '2026-11-23',
    });
    const post = () =>
      fetch(`${base}/api/motivation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    const first = await post();
    expect(first.status).toBe(503);
    const calls = () => fake!.requests.filter((r) => !r.stream && r.model === LITE).length;
    expect(calls()).toBe(1); // a 503 is not retried

    const second = await post();
    expect(second.status).toBe(503);
    expect(((await second.json()) as { details: string[] }).details[0]).toMatch(/^Skipped without a request/);
    expect(calls()).toBe(1); // still one: the cooling model was not called
  });
});

describe('manual planning is unaffected', () => {
  it('with every model cooling down, the app still serves the manual-plan path (no AI needed)', async () => {
    decide = (r) => (r.stream ? OVERLOADED : undefined);
    const base = await start();
    await plan(base);
    // Manual planning is done in the browser (no AI route). The server stays healthy and answers.
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.ok).toBe(true);
  });
});
