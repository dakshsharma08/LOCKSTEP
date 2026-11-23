/**
 * MODEL FALLBACK for temporary outages (HTTP 503 "high demand").
 *
 * The real @google/genai SDK talks to a local fake Gemini over real HTTP/SSE (tests/helpers/fakeGemini.ts).
 * IMPORTANT: this proves OUR logic against the documented API shape. It does NOT prove that real Google
 * behaves this way, which can only be shown against the real API (`npm run diagnose:gemini`, or planning
 * while the primary model is overloaded).
 *
 * gemini-3.8-flash stays the primary; alternatives come from the key's model list (or GEMINI_MODEL_FALLBACKS).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../server/app';
import { startFakeGemini, type FakeGemini, type FakeReply, type FakeRequest } from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-fallback-key-0123456789abcdef`;
const NOW = new Date('2026-11-23T12:00:00Z');
const PRIMARY = 'gemini-3.8-flash';
// What the fake says THIS key can call: the developer's real list (2026-11-23). 3.7 (503/timeout) and
// 2.5 (404 for new users) are listed on purpose: they must still never be used by the automatic chain.
const KEY_MODELS = [
  PRIMARY,
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.8-flash-image',
  'gemini-flash-latest',
];

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

const OVERLOADED: FakeReply = {
  error: {
    status: 503,
    code: 'UNAVAILABLE',
    message: 'This model is currently experiencing high demand. Please try again later.',
  },
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

async function start(
  decide: (r: FakeRequest) => FakeReply | void,
  env: Record<string, string> = {},
  tuning: Record<string, unknown> = {},
) {
  fake = await startFakeGemini(decide, { models: KEY_MODELS });
  const app = createApp({
    now: () => NOW,
    env: { GEMINI_API_KEY: KEY, GEMINI_MODEL: PRIMARY, ALLOWED_ORIGINS: '', ...env },
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Sse {
  event: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function plan(base: string): Promise<Sse[]> {
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
const listCalls = () => fake!.requests.filter((r) => !r.model).length;
const levelOf = (r: FakeRequest) => r.body?.generationConfig?.thinkingConfig;
const diag = () => logs.filter((l) => l.startsWith('{"type":"ai_diag"')).map((l) => JSON.parse(l));
const only =
  (...models: string[]) =>
  (r: FakeRequest): FakeReply | void =>
    r.stream && models.includes(r.model) ? OVERLOADED : undefined;

describe('happy path costs nothing extra', () => {
  it('primary works: exactly one generation call (the model list is only warmed once, in the background)', async () => {
    const base = await start(() => ({}));
    const events = await plan(base);
    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY]);
    expect(listCalls()).toBeLessThanOrEqual(1); // the background warm-up, cached for an hour
  });
});

describe('503 fallback', () => {
  it('primary 503 → one retry → falls back to the next model → a validated plan', async () => {
    const base = await start(only(PRIMARY));
    const events = await plan(base);
    const result = events.at(-1)!;

    expect(result.event).toBe('result');
    // gemini-3.8-flash is still tried first (and retried once); then ONE call to the alternative.
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.6-flash']);
    expect(listCalls()).toBe(1); // warmed once and cached: the fallback reuses it instead of asking again

    // The plan is validated exactly as before, whichever model wrote it.
    expect(result.data.plan.milestones).toHaveLength(4);
    expect(result.data.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(result.data.plan.feasibility).toBe('Achievable');
    // The honest label: the LAST run is the model that actually produced the plan.
    expect(result.data.runs.at(-1)).toMatchObject({ model: 'gemini-3.6-flash', ok: true });
    expect(
      result.data.runs.filter((r: { ok: boolean }) => !r.ok).map((r: { model: string }) => r.model),
    ).toEqual([PRIMARY, PRIMARY]);

    // The user is told, and the log says why.
    const note = events.find((e) => e.event === 'status' && /Trying gemini-3\.6-flash/.test(e.data.message));
    expect(note?.data.message).toMatch(/busy right now/);
    expect(diag().find((d) => d.event === 'model_fallback')).toMatchObject({
      from: PRIMARY,
      to: 'gemini-3.6-flash',
    });
    // The alternative still gets a thinking setting that suits ITS generation.
    const fbReq = fake!.requests.find((r) => r.stream && r.model === 'gemini-3.6-flash')!;
    expect(levelOf(fbReq)).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
  });

  it('first alternative (3.6) also 503 → gemini-3.5-flash is next, never 3.7 or 2.5 (4 calls = the cap)', async () => {
    const base = await start(only(PRIMARY, 'gemini-3.6-flash'));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.6-flash', 'gemini-3.5-flash']);
    const fbReq = fake!.requests.find((r) => r.stream && r.model === 'gemini-3.5-flash')!;
    expect(levelOf(fbReq)).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.5-flash');
  });

  it('everything 503 while 3.7 and 2.5 are listed: they are never called (only 3.6 and 3.5 are)', async () => {
    const base = await start((r) => (r.stream ? OVERLOADED : undefined));
    const events = await plan(base);

    expect(events.at(-1)!.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.6-flash', 'gemini-3.5-flash']);
    expect(streams()).not.toContain('gemini-3.7-flash');
    expect(streams()).not.toContain('gemini-2.5-flash');
    expect(
      diag()
        .filter((d) => d.event === 'model_fallback')
        .map((d) => d.to),
    ).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
  });

  it('GEMINI_MODEL_FALLBACKS can still name an excluded model on purpose (the override wins)', async () => {
    const base = await start(only(PRIMARY), { GEMINI_MODEL_FALLBACKS: 'gemini-3.7-flash' });
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.7-flash']);
  });

  it('a primary that never answers (stall) also falls back, without being retried', async () => {
    const base = await start((r) => (r.stream && r.model === PRIMARY ? { headersDelayMs: 1500 } : undefined));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.6-flash']); // a timeout is not retried on the same model
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.6-flash');
  });

  it('a retired / unknown alternative (404) is skipped, not shown as the error', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY
        ? OVERLOADED
        : r.stream && r.model === 'gemini-3.6-flash'
          ? { error: { status: 404, code: 'NOT_FOUND', message: 'models/gemini-3.6-flash is not found' } }
          : undefined,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.6-flash', 'gemini-3.5-flash']);
  });
});

describe('an overloaded model list', () => {
  it('alternatives are still known when models.list itself returns 503 later (warmed and cached earlier)', async () => {
    let outage = false;
    const base = await start((r) => {
      if (!outage) return undefined;
      if (!r.model) return OVERLOADED; // the model list is down too
      return r.stream && r.model === PRIMARY ? OVERLOADED : undefined;
    });

    expect((await plan(base)).at(-1)?.event).toBe('result'); // healthy: warms the list in the background
    await vi.waitFor(() => expect(listCalls()).toBe(1));

    outage = true;
    const events = await plan(base);
    expect(events.at(-1)?.event).toBe('result');
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.6-flash');
    expect(listCalls()).toBe(1); // the cached list was used: no second call into the failing endpoint
  });
});

describe('total failure', () => {
  it('every model 503: an honest AI_BUSY, one detail line per model, and never more than 4 upstream calls', async () => {
    const base = await start(only(PRIMARY, 'gemini-3.6-flash', 'gemini-3.5-flash'));
    const events = await plan(base);
    const err = events.at(-1)!;

    expect(err.event).toBe('error');
    expect(err.data.code).toBe('AI_BUSY');
    expect(err.data.retryable).toBe(true);
    expect(err.data.message).toMatch(/very busy right now \(3 models tried\)\. Your saved plan still works/);
    expect(err.data.details).toHaveLength(3);
    expect(err.data.details[0]).toMatch(
      /^gemini-3\.8-flash: Gemini status 503 — Google said: UNAVAILABLE: This model is currently experiencing high demand/,
    );
    expect(err.data.details.map((d: string) => d.split(':')[0])).toEqual([
      PRIMARY,
      'gemini-3.6-flash',
      'gemini-3.5-flash',
    ]);

    expect(streams()).toHaveLength(4); // 2 on the primary + 1 + 1: the hard cap
    expect(diag().filter((d) => d.event === 'model_fallback')).toHaveLength(2);
    expect((err.data.details as string[]).join() + JSON.stringify(err) + logs.join('\n')).not.toContain(KEY);
  });

  it('the call cap holds even if many alternatives are configured (GEMINI_MODEL_FALLBACKS)', async () => {
    const base = await start((r) => (r.stream ? OVERLOADED : undefined), {
      GEMINI_MODEL_FALLBACKS:
        'gemini-3.6-flash,gemini-3.5-flash,gemini-3.4-flash,gemini-3.3-flash,gemini-3.2-flash',
    });
    const events = await plan(base);

    expect(events.at(-1)!.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.6-flash', 'gemini-3.5-flash']);
    expect(listCalls()).toBe(0); // an explicit list needs no lookup
  });

  it("GEMINI_MODEL_FALLBACKS=none: no alternatives, the primary's own busy error plus a note", async () => {
    const base = await start((r) => (r.stream ? OVERLOADED : undefined), { GEMINI_MODEL_FALLBACKS: 'none' });
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('AI_BUSY');
    expect(err.data.message).toMatch(/Gemini is busy right now/);
    expect(err.data.details).toContain(
      'No alternative model was available to try (see GEMINI_MODEL_FALLBACKS).',
    );
    expect(streams()).toEqual([PRIMARY, PRIMARY]);
  });
});

describe('what must NOT fall back', () => {
  it('a bad request (400) is shown as-is and not retried on another model', async () => {
    const base = await start((r) =>
      r.stream
        ? { error: { status: 400, message: "Invalid value at 'generation_config.response_json_schema'" } }
        : undefined,
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('INTERNAL');
    expect(err.data.details.join('\n')).toMatch(/Google said: INVALID_ARGUMENT: Invalid value at/);
    expect(streams()).toEqual([PRIMARY]);
    expect(listCalls()).toBeLessThanOrEqual(1); // never used: nothing is tried on another model
  });

  it('a rejected key (403) is a configuration problem, not a reason to try other models', async () => {
    const base = await start((r) =>
      r.stream
        ? { error: { status: 403, code: 'PERMISSION_DENIED', message: `API key not valid. ${KEY}` } }
        : undefined,
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('AI_NOT_CONFIGURED');
    expect(streams()).toEqual([PRIMARY]);
    expect(JSON.stringify(err) + logs.join('\n')).not.toContain(KEY);
  });
});
