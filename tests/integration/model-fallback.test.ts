/**
 * MODEL FALLBACK for temporary outages (HTTP 503 "high demand").
 *
 * The real @google/genai SDK talks to a local fake Gemini over real HTTP/SSE (tests/helpers/fakeGemini.ts).
 * IMPORTANT: this proves OUR logic against the documented API shape. It does NOT prove that real Google
 * behaves this way, which can only be shown against the real API (`npm run diagnose:gemini`, or planning
 * while the primary model is overloaded).
 *
 * These tests pin gemini-3.8-flash as the primary (GEMINI_MODEL); alternatives come from the key's model list
 * (gemini-3.1-flash-lite, then gemini-3.5-flash) or GEMINI_MODEL_FALLBACKS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../server/app';
import {
  TOO_MANY_STATES,
  fixturePlan,
  heavySchemaReason,
  startFakeGemini,
  type FakeGemini,
  type FakeReply,
  type FakeRequest,
} from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-fallback-key-0123456789abcdef`;
const NOW = new Date('2026-11-23T12:00:00Z');
const PRIMARY = 'gemini-3.8-flash';
// What the fake says THIS key can call: the developer's real list (2026-11-23). 3.7 (timeouts), 3.6 (stalls,
// 503s) and 2.5 (404 for new users) are listed on purpose: the automatic chain must never use them.
const KEY_MODELS = [
  PRIMARY,
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
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
  it('primary 503 → NO same-model retry → straight to the next model → a validated plan', async () => {
    const base = await start(only(PRIMARY));
    const events = await plan(base);
    const result = events.at(-1)!;

    expect(result.event).toBe('result');
    // gemini-3.8-flash is tried first, ONCE (a 503 is not retried on the same model); then ONE call to the alternative.
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']);
    expect(listCalls()).toBe(1); // warmed once and cached: the fallback reuses it instead of asking again

    // The plan is validated exactly as before, whichever model wrote it.
    expect(result.data.plan.milestones).toHaveLength(4);
    expect(result.data.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(result.data.plan.feasibility).toBe('Achievable');
    // The honest label: the LAST run is the model that actually produced the plan.
    expect(result.data.runs.at(-1)).toMatchObject({ model: 'gemini-3.1-flash-lite', ok: true });
    expect(
      result.data.runs.filter((r: { ok: boolean }) => !r.ok).map((r: { model: string }) => r.model),
    ).toEqual([PRIMARY]);

    // The user is told, and the log says why.
    const note = events.find(
      (e) => e.event === 'status' && /Trying gemini-3\.1-flash-lite/.test(e.data.message),
    );
    expect(note?.data.message).toMatch(/busy right now/);
    expect(diag().find((d) => d.event === 'model_fallback')).toMatchObject({
      from: PRIMARY,
      to: 'gemini-3.1-flash-lite',
    });
    // The alternative still gets a thinking setting that suits ITS generation.
    const fbReq = fake!.requests.find((r) => r.stream && r.model === 'gemini-3.1-flash-lite')!;
    expect(levelOf(fbReq)).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
  });

  it('first alternative (3.1-flash-lite) also 503 → gemini-3.5-flash is next, never 3.6, 3.7 or 2.5 (one call each)', async () => {
    const base = await start(only(PRIMARY, 'gemini-3.1-flash-lite'));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
    const fbReq = fake!.requests.find((r) => r.stream && r.model === 'gemini-3.5-flash')!;
    expect(levelOf(fbReq)).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.5-flash');
  });

  it('everything 503 while 3.6, 3.7 and 2.5 are listed: they are never called (only 3.1-flash-lite and 3.5 are)', async () => {
    const base = await start((r) => (r.stream ? OVERLOADED : undefined));
    const events = await plan(base);

    expect(events.at(-1)!.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
    expect(streams()).not.toContain('gemini-3.7-flash');
    expect(streams()).not.toContain('gemini-3.6-flash');
    expect(streams()).not.toContain('gemini-2.5-flash');
    expect(
      diag()
        .filter((d) => d.event === 'model_fallback')
        .map((d) => d.to),
    ).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash']);
  });

  it('GEMINI_MODEL_FALLBACKS can still name an excluded model on purpose (the override wins)', async () => {
    const base = await start(only(PRIMARY), { GEMINI_MODEL_FALLBACKS: 'gemini-3.7-flash' });
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.7-flash']);
  });

  it('a primary that never answers (stall) also falls back, without being retried', async () => {
    const base = await start((r) => (r.stream && r.model === PRIMARY ? { headersDelayMs: 1500 } : undefined));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']); // a timeout is not retried on the same model
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.1-flash-lite');
  });

  it('a retired / unknown alternative (404) is skipped, not shown as the error', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY
        ? OVERLOADED
        : r.stream && r.model === 'gemini-3.1-flash-lite'
          ? {
              error: { status: 404, code: 'NOT_FOUND', message: 'models/gemini-3.1-flash-lite is not found' },
            }
          : undefined,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
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
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.1-flash-lite');
    expect(listCalls()).toBe(1); // the cached list was used: no second call into the failing endpoint
  });
});

describe('total failure', () => {
  it('every model 503: an honest AI_BUSY, one detail line per model, one call each (within the 4-call cap)', async () => {
    const base = await start(only(PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash'));
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
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
    ]);

    expect(streams()).toHaveLength(3); // one call per model: a 503 is not retried on the same model
    expect(diag().filter((d) => d.event === 'model_fallback')).toHaveLength(2);
    expect((err.data.details as string[]).join() + JSON.stringify(err) + logs.join('\n')).not.toContain(KEY);
  });

  it('the call cap holds even if many alternatives are configured (GEMINI_MODEL_FALLBACKS)', async () => {
    const base = await start((r) => (r.stream ? OVERLOADED : undefined), {
      GEMINI_MODEL_FALLBACKS:
        'gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.4-flash,gemini-3.3-flash,gemini-3.2-flash',
    });
    const events = await plan(base);

    expect(events.at(-1)!.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
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
    expect(streams()).toEqual([PRIMARY]);
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

// ─── The owner's real-key results (2026-11-23): primary over quota, alternatives reject the old schema ───

const QUOTA: FakeReply = {
  error: {
    status: 429,
    code: 'RESOURCE_EXHAUSTED',
    message:
      'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash',
  },
};
const SCHEMA_400: FakeReply = { error: { status: 400, code: 'INVALID_ARGUMENT', message: TOO_MANY_STATES } };

describe('response schema compatibility (the fake rejects state-heavy schemas, like Google)', () => {
  it('primary over quota (429) → gemini-3.1-flash-lite ACCEPTS the plan schema → a validated plan', async () => {
    const base = await start((r) => (r.stream && r.model === PRIMARY ? QUOTA : undefined));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']);
    const sent = fake!.requests.find((r) => r.stream && r.model === 'gemini-3.1-flash-lite')!;
    expect(heavySchemaReason(sent.body?.generationConfig?.responseJsonSchema)).toBeNull();
    expect(events.at(-1)!.data.runs.at(-1)).toMatchObject({ model: 'gemini-3.1-flash-lite', ok: true });
    // The plan really passed the server's own checks: dates from the allowed list, chronological, in capacity.
    expect(events.filter((e) => e.event === 'milestone').length).toBeGreaterThan(0);
  });

  it('gemini-3.5-flash gets the SAME accepted schema when 3.1-flash-lite is busy', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY
        ? QUOTA
        : r.stream && r.model === 'gemini-3.1-flash-lite'
          ? OVERLOADED
          : undefined,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
    const schemaFor = (m: string) =>
      fake!.requests.find((r) => r.stream && r.model === m)!.body?.generationConfig?.responseJsonSchema;
    expect(schemaFor('gemini-3.5-flash')).toEqual(schemaFor('gemini-3.1-flash-lite'));
    expect(schemaFor('gemini-3.5-flash')).toEqual(schemaFor(PRIMARY));
    expect(heavySchemaReason(schemaFor('gemini-3.5-flash'))).toBeNull();
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.5-flash');
  });

  it('every plan request the app sends passes the fake schema check (no 400 anywhere in a normal run)', async () => {
    const base = await start(() => undefined);
    expect((await plan(base)).at(-1)?.event).toBe('result');
    const planReqs = fake!.requests.filter((r) => r.body?.generationConfig?.responseJsonSchema);
    expect(planReqs.length).toBeGreaterThan(0);
    for (const r of planReqs)
      expect(heavySchemaReason(r.body!.generationConfig.responseJsonSchema)).toBeNull();
  });
});

describe('HTTP 400 schema rejection: accurate error, no model fallback', () => {
  it('429 on the primary, then 400 "too many states" on 3.1-flash-lite: the 400 is reported, 3.5 is never called', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY
        ? QUOTA
        : r.stream && r.model === 'gemini-3.1-flash-lite'
          ? SCHEMA_400
          : undefined,
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.event).toBe('error');
    expect(err.data.code).not.toBe('AI_BUSY');
    expect(err.data.code).toBe('INTERNAL');
    expect(err.data.retryable).toBe(false);
    expect(err.data.message).toMatch(
      /rejected LOCKSTEP's plan format \(HTTP 400: the response schema is too complex/,
    );
    expect(err.data.message).not.toMatch(/busy/i);
    expect(err.data.details[0]).toMatch(
      /^gemini-3\.1-flash-lite: Gemini status 400 — Google said: INVALID_ARGUMENT: The specified schema/,
    );
    expect(err.data.details[1]).toMatch(
      /^gemini-3\.8-flash \(tried first\): Gemini status 429 — Google said: RESOURCE_EXHAUSTED/,
    );
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']); // no 3rd model, no retry of the 400 (nor of the quota 429)
    expect(diag().filter((d) => d.event === 'model_fallback')).toHaveLength(1);
    expect(diag().filter((d) => d.event === 'thinking_fallback')).toHaveLength(0); // not mistaken for a thinking problem
    expect(JSON.stringify(err) + logs.join('\n')).not.toContain(KEY);
  });

  it('400 "too many states" on the primary: reported at once, no retry, no other model', async () => {
    const base = await start((r) => (r.stream && r.model === PRIMARY ? SCHEMA_400 : undefined));
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('INTERNAL');
    expect(err.data.message).toMatch(/response schema is too complex/);
    expect(streams()).toEqual([PRIMARY]);
    expect(diag().filter((d) => d.event === 'model_fallback')).toHaveLength(0);
  });

  it('regression: the OLD schema constructs really are what the fake rejects (so the tests above are meaningful)', async () => {
    // Send an old-style schema straight to the fake, through the real SDK.
    fake = await startFakeGemini(() => undefined, { models: KEY_MODELS });
    const ai = new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } });
    const old = {
      type: 'object',
      properties: {
        milestones: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: { type: 'object', properties: { targetDate: { type: 'string', format: 'date' } } },
        },
      },
    };
    await expect(
      ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: 'x',
        config: { responseMimeType: 'application/json', responseJsonSchema: old },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('HTTP 429 quota exhausted: no same-model retry (other temporary errors keep theirs)', () => {
  it('quota 429 on the primary: exactly ONE primary call, then straight to gemini-3.1-flash-lite', async () => {
    const base = await start((r) => (r.stream && r.model === PRIMARY ? QUOTA : undefined));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']);
    const runs = events.at(-1)!.data.runs as { model: string; ok: boolean }[];
    expect(runs.filter((r) => r.model === PRIMARY)).toHaveLength(1);
    const fb = diag().find((d) => d.event === 'model_fallback')!;
    expect(fb.reason).toMatch(/Gemini status 429/);
  });

  it('a 503 on the primary is NOT retried on the same model: straight to the next one', async () => {
    const base = await start(only(PRIMARY));
    await plan(base);
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']);
  });

  it('a 429 that is NOT about quota is still retried once', async () => {
    const busy429: FakeReply = {
      error: { status: 429, code: 'RESOURCE_EXHAUSTED', message: 'Too many concurrent requests. Slow down.' },
    };
    const base = await start((r) => (r.stream && r.model === PRIMARY ? busy429 : undefined));
    await plan(base);
    expect(streams()).toEqual([PRIMARY, PRIMARY, 'gemini-3.1-flash-lite']);
  });

  it('quota 429 everywhere: 3 calls in total (one per model), an honest AI_BUSY, within the 4-call cap', async () => {
    const base = await start((r) => (r.stream ? QUOTA : undefined));
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
    expect(err.data.details.map((d: string) => d.split(':')[0])).toEqual([
      PRIMARY,
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
    ]);
  });
});

// ─── Repair: plan-sized time limit and the plan's thinking setting; the shared plan time limit ───

/** A plan that fails validation: the first milestone lands on Saturday 2026-11-28 (Mon–Fri only). */
const weekendPlan = (r: FakeRequest): FakeReply => {
  const p = fixturePlan(r.body) as { milestones: { targetDate: string }[] };
  p.milestones[0]!.targetDate = '2026-11-28';
  return { text: JSON.stringify(p) };
};
const repairs = () => fake!.requests.filter((r) => !r.stream && r.model);

describe('repair call', () => {
  it('gets the plan-sized time limit: a repair slower than the small-call limit still succeeds', async () => {
    const base = await start(
      (r) => (r.stream ? weekendPlan(r) : r.model ? { firstChunkDelayMs: 400 } : undefined),
      {},
      { callTimeoutMs: 100, repairTimeoutMs: 3000 },
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(events.at(-1)!.data.repaired).toBe(true);
    expect(repairs()).toHaveLength(1);
  });

  it('uses the thinking level that worked for the plan (LOW), without thought summaries, on the same model', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY ? OVERLOADED : r.stream ? weekendPlan(r) : undefined,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    const [repair] = repairs();
    expect(repair!.model).toBe('gemini-3.1-flash-lite'); // the model that wrote the plan
    expect(repair!.body?.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(repair!.body?.generationConfig?.responseJsonSchema).toBeTruthy();
  });

  it('the old 30 s-style limit would have cut the same repair off (control: proves the test above means something)', async () => {
    const base = await start(
      (r) => (r.stream ? weekendPlan(r) : r.model ? { firstChunkDelayMs: 400 } : undefined),
      {},
      { callTimeoutMs: 100, repairTimeoutMs: 100 },
    );
    const err = (await plan(base)).at(-1)!;
    expect(err.event).toBe('error');
    expect(err.data.code).toBe('TIMEOUT');
  });
});

describe("plan time limit (keeps one request under Vercel's 300 s)", () => {
  it('stops everything at the limit with an honest TIMEOUT, and starts no other model', async () => {
    const t0 = Date.now();
    const base = await start(
      (r) => (r.stream ? { neverRespond: true } : undefined),
      {},
      {
        planBudgetMs: 700,
        minAttemptMs: 100,
        firstChunkTimeoutMs: 5000,
        chunkIdleTimeoutMs: 5000,
        streamTotalTimeoutMs: 5000,
      },
    );
    const err = (await plan(base)).at(-1)!;
    const elapsed = Date.now() - t0;

    expect(err.data.code).toBe('TIMEOUT');
    expect(err.data.message).toMatch(/^Planning took longer than 1 s, so we stopped/);
    expect(err.data.details.join(' ')).toMatch(/plan-time-limit/);
    expect(streams()).toEqual([PRIMARY]);
    expect(elapsed).toBeLessThan(2500);
  });

  it('does not start another model with too little time left', async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? { ...OVERLOADED, headersDelayMs: 150 } : undefined),
      {},
      { planBudgetMs: 1500, minAttemptMs: 1400 },
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('AI_BUSY');
    expect(err.data.details.at(-1)).toMatch(
      /^No further model was tried: only \d+ s of the planning time limit was left\.$/,
    );
    expect(streams()).toEqual([PRIMARY]);
  });

  it('skips the repair (honest PLAN_INVALID, no call) when too little time is left for it', async () => {
    const base = await start(
      (r) => (r.stream ? { ...weekendPlan(r), firstChunkDelayMs: 200 } : undefined),
      {},
      { planBudgetMs: 1500, minAttemptMs: 1400 },
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('PLAN_INVALID');
    expect(err.data.message).toMatch(/no time left to repair it/);
    expect(err.data.details.at(-1)).toBe('Repair skipped: the planning time limit was nearly used up.');
    expect(err.data.details.join(' ')).toMatch(/2026-11-28/);
    expect(repairs()).toHaveLength(0);
  });
});

describe("the app's ai_diag line shows how the stream went (thinking vs text, timing)", () => {
  it('records chunks, thinking chunks, text chunks, the last chunk time and the longest gap', async () => {
    const base = await start((r) =>
      r.stream ? { thoughtAfterMs: 5, pauseAfterChunk: 2, pauseMs: 60 } : undefined,
    );
    expect((await plan(base)).at(-1)?.event).toBe('result');

    const done = diag().find((d) => d.kind === 'plan' && d.phase === 'done')!;
    expect(done).toMatchObject({ thoughtChunks: 1, textChunks: 4, chunks: 5 });
    expect(done.maxGapMs).toBeGreaterThanOrEqual(50);
    expect(done.lastChunkMs).toBeGreaterThanOrEqual(done.firstTextMs);
  });
});

// ─── Stage 2: a model that stalls mid-answer is abandoned; the browser is told to drop its partial output ───

/** A plan whose titles say STALE, streamed in 4 pieces; only the first `n` pieces are sent, then silence. */
const staleThenStall = (r: FakeRequest, n = 2): FakeReply => {
  const p = fixturePlan(r.body) as {
    feasibility: string;
    feasibilityReason: string;
    milestones: { title: string; tasks: { title: string }[] }[];
  };
  p.feasibility = 'Tight';
  p.feasibilityReason = 'STALE reason from the model that stalled.';
  for (const m of p.milestones) {
    m.title = `STALE ${m.title}`;
    for (const t of m.tasks) t.title = `STALE ${t.title}`;
  }
  return { text: JSON.stringify(p), stallAfterChunks: n };
};
const STALL_TUNING = { chunkIdleTimeoutMs: 200 };
const isStale = (e: Sse) =>
  (e.event === 'milestone' && /STALE/.test(e.data.milestone.title)) ||
  (e.event === 'feasibility' && /STALE/.test(e.data.feasibilityReason));

describe('stall after partial output → reset → next model', () => {
  it('primary stalls after streaming part of a plan: reset comes BEFORE anything from the next model', async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? staleThenStall(r) : undefined),
      {},
      STALL_TUNING,
    );
    const events = await plan(base);
    const reset = events.findIndex((e) => e.event === 'reset');

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']); // no same-model retry after output started
    // The abandoned attempt really had shown something (so the reset matters)…
    expect(events.slice(0, reset).some(isStale)).toBe(true);
    // …the reset names the switch, and is followed by the status, then the new model's events only.
    expect(events[reset]!.data).toEqual({ reason: 'stalled', from: PRIMARY, to: 'gemini-3.1-flash-lite' });
    expect(events[reset + 1]).toMatchObject({
      event: 'status',
      data: { message: `${PRIMARY} stopped responding. Starting over with gemini-3.1-flash-lite…` },
    });
    expect(events.slice(reset + 1).some(isStale)).toBe(false);
    expect(events.slice(reset + 1).some((e) => e.event === 'milestone')).toBe(true);
  });

  it("the abandoned output is never validated or saved: the result is entirely the new model's plan", async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? staleThenStall(r) : undefined),
      {},
      STALL_TUNING,
    );
    const events = await plan(base);
    const result = events.at(-1)!.data;

    expect(JSON.stringify(result.plan)).not.toMatch(/STALE/);
    expect(result.repaired).toBe(false);
    expect(repairs()).toHaveLength(0); // the partial text was never sent anywhere
    const validating = events.filter((e) => e.event === 'status' && e.data.phase === 'validating');
    expect(validating).toHaveLength(1); // validated once: the successful attempt only
    expect(result.runs.map((r: { model: string; ok: boolean }) => [r.model, r.ok])).toEqual([
      [PRIMARY, false],
      ['gemini-3.1-flash-lite', true],
    ]);
    const fb = diag().find((d) => d.event === 'model_fallback')!;
    expect(fb).toMatchObject({ from: PRIMARY, to: 'gemini-3.1-flash-lite', stalled: true });
    expect(fb.reason).toMatch(
      /Stream paused for more than 0 s \| phase: streaming \(no new chunk after 2 chunks: 0 thinking, 2 text\)/,
    );
  });

  it('a model that only thought and then went silent also counts as a stall', async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? { thoughtAfterMs: 10, stallAfterChunks: 0 } : undefined),
      {},
      STALL_TUNING,
    );
    const events = await plan(base);
    expect(events.at(-1)?.event).toBe('result');
    expect(events.find((e) => e.event === 'reset')?.data.reason).toBe('stalled');
  });

  it('quota 429 on the primary, then 3.1-flash-lite stalls mid-answer: 3.5 writes the plan (3 calls, two resets in order)', async () => {
    const base = await start(
      (r) =>
        r.stream && r.model === PRIMARY
          ? QUOTA
          : r.stream && r.model === 'gemini-3.1-flash-lite'
            ? staleThenStall(r)
            : undefined,
      {},
      STALL_TUNING,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
    expect(events.filter((e) => e.event === 'reset').map((e) => [e.data.reason, e.data.to])).toEqual([
      ['unavailable', 'gemini-3.1-flash-lite'],
      ['stalled', 'gemini-3.5-flash'],
    ]);
    const lastReset = events.map((e) => e.event).lastIndexOf('reset');
    expect(events.slice(lastReset).some(isStale)).toBe(false);
    expect(events.at(-1)!.data.runs.at(-1)).toMatchObject({ model: 'gemini-3.5-flash', ok: true });
  });

  it('every model stalls: an honest error, never more than the 4-call cap', async () => {
    const base = await start((r) => (r.stream ? staleThenStall(r) : undefined), {}, STALL_TUNING);
    const err = (await plan(base)).at(-1)!;

    expect(err.event).toBe('error');
    expect(err.data.code).toBe('AI_BUSY');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite', 'gemini-3.5-flash']);
    expect(streams().length).toBeLessThanOrEqual(4);
  });

  it('400 and 403 never trigger a fallback or a reset', async () => {
    for (const error of [
      { status: 400, code: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' },
      { status: 403, code: 'PERMISSION_DENIED', message: 'Permission denied.' },
    ]) {
      const base = await start((r) => (r.stream ? { error } : undefined), {}, STALL_TUNING);
      const events = await plan(base);
      expect(events.at(-1)?.event).toBe('error');
      expect(events.some((e) => e.event === 'reset')).toBe(false);
      expect(streams()).toEqual([PRIMARY]);
      server?.close();
      await fake?.close();
    }
  });

  it('after a 429 on the primary, a 400 on 3.1-flash-lite stops the chain: no reset towards 3.5', async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? QUOTA : r.stream ? SCHEMA_400 : undefined),
      {},
      STALL_TUNING,
    );
    const events = await plan(base);
    expect(events.at(-1)?.data.code).toBe('INTERNAL');
    expect(events.filter((e) => e.event === 'reset').map((e) => e.data.to)).toEqual([
      'gemini-3.1-flash-lite',
    ]);
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']);
  });

  it('a stall when too little of the plan time limit is left: no next model, no reset', async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? staleThenStall(r) : undefined),
      {},
      {
        chunkIdleTimeoutMs: 300,
        planBudgetMs: 1500,
        minAttemptMs: 1400,
      },
    );
    const events = await plan(base);
    const err = events.at(-1)!;

    expect(err.event).toBe('error');
    expect(err.data.details.at(-1)).toMatch(
      /^No further model was tried: only \d+ s of the planning time limit was left\.$/,
    );
    expect(events.some((e) => e.event === 'reset')).toBe(false);
    expect(streams()).toEqual([PRIMARY]);
  });

  it('the plan time limit firing mid-stream is not a stall: TIMEOUT, no next model, no reset', async () => {
    const base = await start(
      (r) => (r.stream ? staleThenStall(r) : undefined),
      {},
      {
        chunkIdleTimeoutMs: 5000,
        streamTotalTimeoutMs: 5000,
        planBudgetMs: 600,
        minAttemptMs: 100,
      },
    );
    const events = await plan(base);
    const err = events.at(-1)!;

    expect(err.data.code).toBe('TIMEOUT');
    expect(err.data.details.join(' ')).toMatch(/plan-time-limit/);
    expect(events.some((e) => e.event === 'reset')).toBe(false);
    expect(streams()).toEqual([PRIMARY]);
  });
});

// ─── Transport hardening: a COMPLETE answer ends with finishReason STOP; Google's continuation hops ───

describe('a cut-off answer is never used', () => {
  it('no finishReason (stream closed early): reset "incomplete" → next model; never validated or repaired', async () => {
    const base = await start((r) => (r.stream && r.model === PRIMARY ? { noFinish: true } : undefined));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual([PRIMARY, 'gemini-3.1-flash-lite']);
    expect(events.find((e) => e.event === 'reset')?.data).toEqual({
      reason: 'incomplete',
      from: PRIMARY,
      to: 'gemini-3.1-flash-lite',
    });
    expect(
      events.find(
        (e) => e.event === 'status' && /stopped before finishing\. Starting over/.test(e.data.message),
      ),
    ).toBeTruthy();
    expect(repairs()).toHaveLength(0);
    const cut = diag().find((d) => d.kind === 'plan' && d.phase === 'incomplete-answer')!;
    expect(cut).toMatchObject({ model: PRIMARY, ok: false });
    expect(cut.finishReason).toBeUndefined();
  });

  it('finishReason MAX_TOKENS: the same, and the log says why', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY ? { finishReason: 'MAX_TOKENS' } : undefined,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    const cut = diag().find((d) => d.kind === 'plan' && d.phase === 'incomplete-answer')!;
    expect(cut.finishReason).toBe('MAX_TOKENS');
    const fb = diag().find((d) => d.event === 'model_fallback')!;
    expect(fb).toMatchObject({ incomplete: true, stalled: false });
    expect(fb.reason).toMatch(/Incomplete answer: finishReason MAX_TOKENS \(the output limit was reached\)/);
    expect(repairs()).toHaveLength(0);
  });

  it('every model cut off: an honest message (not "very busy"), 3 calls', async () => {
    const base = await start((r) => (r.stream ? { noFinish: true } : undefined));
    const err = (await plan(base)).at(-1)!;

    expect(err.event).toBe('error');
    expect(err.data.message).toMatch(
      /couldn't finish the plan: every model was busy, stopped mid-answer or was cut off \(3 models tried\)/,
    );
    expect(
      err.data.details.every((d: string) =>
        /Incomplete answer: the stream ended without a finish reason/.test(d),
      ),
    ).toBe(true);
    expect(streams()).toHaveLength(3);
  });

  it('the completed run logs finishReason STOP and the token breakdown', async () => {
    const base = await start(() => undefined);
    expect((await plan(base)).at(-1)?.event).toBe('result');
    const done = diag().find((d) => d.kind === 'plan' && d.phase === 'done')!;
    expect(done).toMatchObject({
      finishReason: 'STOP',
      promptTokens: 10,
      outputTokens: 20,
      thoughtsTokens: 0,
    });
  });
});

describe("Google's continuation protocol (SDK automatic continuation)", () => {
  it('a long answer split into 2 hops completes normally; the hidden extra request is logged (hops: 1)', async () => {
    const base = await start((r) =>
      r.stream && r.model === PRIMARY ? { continueAfterChunks: 2, resumeDelayMs: 50 } : undefined,
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    const hops = fake!.requests.filter((r) => r.stream && r.model === PRIMARY);
    expect(hops).toHaveLength(2); // one call from the app, one resume request from the SDK
    expect(hops[1]!.body?.continuationToken).toBe('tok-1');
    expect(diag().find((d) => d.kind === 'plan' && d.phase === 'done')).toMatchObject({
      hops: 1,
      finishReason: 'STOP',
    });
    expect(events.some((e) => e.event === 'reset')).toBe(false);
  });

  it('a resume that takes longer than the gap limit counts as a stall (documents the trade-off)', async () => {
    const base = await start(
      (r) => (r.stream && r.model === PRIMARY ? { continueAfterChunks: 2, resumeDelayMs: 500 } : undefined),
      {},
      { chunkIdleTimeoutMs: 200 },
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    expect(events.find((e) => e.event === 'reset')?.data.reason).toBe('stalled');
    expect(events.at(-1)!.data.runs.at(-1).model).toBe('gemini-3.1-flash-lite');
  });
});

describe('default primary model (GEMINI_MODEL not set)', () => {
  const LISTED = [...KEY_MODELS, 'gemini-3.5-flash-lite'];

  it('the plan is written by gemini-3.5-flash-lite when the key lists it: one call, no fallback', async () => {
    fake = await startFakeGemini(() => undefined, { models: LISTED });
    const app = createApp({
      now: () => NOW,
      env: { GEMINI_API_KEY: KEY, ALLOWED_ORIGINS: '' },
      gemini: new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } }) as never,
      tuning: {
        firstChunkTimeoutMs: 300,
        retryBaseMs: 1,
        retryMaxMs: 2,
        rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    const events = await plan(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual(['gemini-3.5-flash-lite']);
    expect(events.at(-1)!.data.runs.at(-1)).toMatchObject({ model: 'gemini-3.5-flash-lite', ok: true });
    const sent = fake.requests.find((r) => r.stream)!;
    expect(levelOf(sent)).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' }); // same settings as before
  });

  it('the whole default chain: 3.5-flash-lite → 3.1-flash-lite → 3.5-flash (one call each); 3.6 and 3.7 are never called', async () => {
    fake = await startFakeGemini((r) => (r.stream ? OVERLOADED : undefined), { models: LISTED });
    const app = createApp({
      now: () => NOW,
      env: { GEMINI_API_KEY: KEY, ALLOWED_ORIGINS: '' },
      gemini: new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } }) as never,
      tuning: {
        firstChunkTimeoutMs: 300,
        retryBaseMs: 1,
        retryMaxMs: 2,
        rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    const err = (await plan(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)).at(-1)!;

    expect(LISTED).toEqual(expect.arrayContaining(['gemini-3.6-flash', 'gemini-3.7-flash'])); // offered by the key…
    expect(streams()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash']); // …but never used; one call each
    expect(err.data.code).toBe('AI_BUSY');
    expect(err.data.details.map((d: string) => d.split(':')[0])).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
    ]);
  });

  it('default busy → gemini-3.1-flash-lite (the existing fallback logic, new order)', async () => {
    fake = await startFakeGemini(
      (r) => (r.stream && r.model === 'gemini-3.5-flash-lite' ? OVERLOADED : undefined),
      {
        models: LISTED,
      },
    );
    const app = createApp({
      now: () => NOW,
      env: { GEMINI_API_KEY: KEY, ALLOWED_ORIGINS: '' },
      gemini: new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } }) as never,
      tuning: {
        firstChunkTimeoutMs: 300,
        retryBaseMs: 1,
        retryMaxMs: 2,
        rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    const events = await plan(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    expect(events.at(-1)?.event).toBe('result');
    expect(streams()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    expect(events.find((e) => e.event === 'reset')?.data).toMatchObject({
      from: 'gemini-3.5-flash-lite',
      to: 'gemini-3.1-flash-lite',
    });
  });
});
