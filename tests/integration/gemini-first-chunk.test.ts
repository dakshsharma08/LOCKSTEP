/**
 * REGRESSION: "Gemini took too long. No first chunk within 30 s."
 *
 * The real @google/genai SDK talks to a local fake Gemini over real HTTP/SSE (tests/helpers/fakeGemini.ts),
 * so these tests reproduce the failure shapes with real sockets. Gemini is NOT mocked in the app; the
 * fake exists only in tests.
 *
 * Root cause covered: plan requests never set a thinking level, so a Gemini 3.x model used its default
 * (long, silent) thinking and sent nothing for 30+ s. The fix requests a LOW level, reports the two kinds
 * of stall differently, logs where the time went, and keeps Google's real error text (redacted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../server/app';
import { startFakeGemini, type FakeGemini, type FakeReply, type FakeRequest } from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const PREFIX = ['AI', 'za'].join('');
const KEY = `${PREFIX}SyFAKE-test-key-0123456789abcdefghij`;
const NOW = new Date('2026-11-23T12:00:00Z'); // a Monday

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

async function start(decide: (r: FakeRequest) => FakeReply | void, env: Record<string, string> = {}) {
  fake = await startFakeGemini(decide);
  const app = createApp({
    now: () => NOW,
    env: { GEMINI_API_KEY: KEY, GEMINI_MODEL: 'gemini-3.8-flash', ALLOWED_ORIGINS: '', ...env },
    gemini: new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: fake.baseUrl } }) as never,
    // 300 ms stands in for the real 30 s limit so the tests are fast.
    tuning: {
      firstChunkTimeoutMs: 300,
      retryBaseMs: 1,
      retryMaxMs: 2,
      rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
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
  const text = await res.text();
  return text
    .split(/\r?\n\r?\n/)
    .map((raw) => ({ event: /^event:\s*(.+)$/m.exec(raw)?.[1], data: /^data:\s*(.+)$/m.exec(raw)?.[1] }))
    .filter((e): e is { event: string; data: string } => !!e.event && !!e.data)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

const planStream = (r: FakeRequest) => r.stream && !!r.body?.generationConfig?.responseJsonSchema;
const levelOf = (r: FakeRequest) =>
  r.body?.generationConfig?.thinkingConfig?.thinkingLevel as string | undefined;
const diagLines = () => logs.filter((l) => l.startsWith('{"type":"ai_diag"')).map((l) => JSON.parse(l));
const runLines = () => logs.filter((l) => l.startsWith('{"type":"ai_run"')).map((l) => JSON.parse(l));

/** A model that, like Gemini 3.x at its default level, thinks silently for a long time unless told to think LOW. */
const thinksSilentlyUnlessLow = (r: FakeRequest): FakeReply =>
  planStream(r) ? { firstChunkDelayMs: levelOf(r) === 'LOW' ? 10 : 1500 } : {};

describe('plan requests ask for a LOW thinking level (the fix)', () => {
  it('sends thinkingConfig {includeThoughts, thinkingLevel: LOW} for a Gemini 3.x model and the plan succeeds', async () => {
    const base = await start(thinksSilentlyUnlessLow);
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    const sent = fake!.requests.find(planStream)!;
    expect(sent.body!.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'LOW',
    });
    expect(sent.version).toBe('v1'); // the SDK's default API version
    expect(sent.hasKey).toBe(true); // the key travels as a header…
    expect(sent.path).not.toContain(KEY); // …never in the URL
  });

  it('GEMINI_THINKING_LEVEL overrides the level, and "default" restores the model-decides behaviour', async () => {
    const base = await start(() => ({}), { GEMINI_THINKING_LEVEL: 'medium' });
    await plan(base);
    expect(fake!.requests.find(planStream)!.body!.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'MEDIUM',
    });
  });
});

describe('REGRESSION: the exact symptom from the bug report', () => {
  it('without a thinking level, silent thinking past the first-chunk limit times out, and the error says so', async () => {
    // GEMINI_THINKING_LEVEL=default reproduces the OLD request (includeThoughts only).
    const base = await start(thinksSilentlyUnlessLow, { GEMINI_THINKING_LEVEL: 'default' });
    const events = await plan(base);
    const err = events.at(-1)!;

    expect(err.event).toBe('error');
    expect(err.data.code).toBe('TIMEOUT');
    expect(err.data.message).toMatch(/accepted the request but sent no output within \d+ s/);
    expect(err.data.details.join('\n')).toMatch(/phase: waiting-for-first-chunk/);
    expect(err.data.details.join('\n')).toMatch(/GEMINI_THINKING_LEVEL/);
    expect(err.data.details.join('\n')).toMatch(/diagnose:gemini/);

    // The log says WHERE the time went: HTTP response arrived at once, then silence.
    const diag = diagLines().find((d) => d.ok === false)!;
    expect(diag).toMatchObject({
      kind: 'plan',
      model: 'gemini-3.8-flash',
      phase: 'waiting-for-first-chunk',
      streaming: true,
      attempts: 1,
      chunks: 0,
    });
    expect(typeof diag.headersMs).toBe('number');
    expect(diag.firstChunkMs).toBeUndefined();
    expect(diag.thinking).toEqual({ includeThoughts: true });
    expect(runLines()[0]).toMatchObject({ kind: 'plan', ok: false });
    expect(fake!.requests.filter(planStream)).toHaveLength(1); // a timeout is not retried
  });

  it('when Google never answers the HTTP request, the error blames the network, not the model', async () => {
    const base = await start((r) => (planStream(r) ? { headersDelayMs: 1500 } : {}));
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('TIMEOUT');
    expect(err.data.message).toMatch(/Google didn't answer the request within \d+ s/);
    expect(err.data.details.join('\n')).toMatch(/phase: waiting-for-http-response/);
    expect(err.data.details.join('\n')).toMatch(/network|proxy|firewall/i);
    const diag = diagLines().find((d) => d.ok === false)!;
    expect(diag.phase).toBe('waiting-for-http-response');
    expect(diag.headersMs).toBeUndefined();
  });

  it('a thought-summary chunk counts as the first chunk, so a long-thinking model that streams summaries is not timed out', async () => {
    const base = await start((r) => (planStream(r) ? { thoughtAfterMs: 50, firstChunkDelayMs: 700 } : {}));
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    const ok = diagLines().find((d) => d.ok === true && d.kind === 'plan')!;
    expect(ok.thoughtChunks).toBe(1);
    expect(ok.firstChunkMs).toBeLessThan(300);
    expect(ok.firstTextMs).toBeGreaterThan(300);
  });
});

describe('if Google rejects the thinking settings, plan generation falls back instead of failing', () => {
  it('retries once with plainer settings after "Unknown name thinkingLevel"', async () => {
    const base = await start((r) =>
      planStream(r) && levelOf(r)
        ? {
            error: {
              status: 400,
              message: `Invalid JSON payload received. Unknown name "thinkingLevel" at 'generation_config.thinking_config': Cannot find field.`,
            },
          }
        : {},
    );
    const events = await plan(base);

    expect(events.at(-1)?.event).toBe('result');
    const sent = fake!.requests.filter(planStream);
    expect(sent).toHaveLength(2);
    expect(levelOf(sent[0]!)).toBe('LOW');
    expect(sent[1]!.body!.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect(diagLines().some((d) => d.event === 'thinking_fallback')).toBe(true);
  });
});

describe('real upstream errors are visible, and the API key never leaks', () => {
  it("shows Google's own reason for a 400 (not retried), with the key redacted everywhere", async () => {
    const base = await start((r) =>
      planStream(r)
        ? {
            error: {
              status: 400,
              message: `Invalid value at 'generation_config.response_json_schema' (key=${KEY})`,
            },
          }
        : {},
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('INTERNAL');
    expect(err.data.details).toContain('Gemini status 400');
    expect(err.data.details.join('\n')).toMatch(
      /Google said: INVALID_ARGUMENT: Invalid value at 'generation_config\.response_json_schema'/,
    );
    expect(fake!.requests.filter(planStream)).toHaveLength(1); // a non-thinking 400 is not retried

    const diag = diagLines().find((d) => d.ok === false)!;
    expect(diag).toMatchObject({ phase: 'http-error', status: 400 });
    expect(diag.upstream).toMatch(/Invalid value at/);

    const everything = JSON.stringify(err) + logs.join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(`${PREFIX}SyFAKE`);
    expect(everything).toContain('[redacted]');
  });

  it("a rejected key (403) is reported as a configuration problem with Google's reason, key redacted", async () => {
    const base = await start((r) =>
      planStream(r)
        ? {
            error: {
              status: 403,
              code: 'PERMISSION_DENIED',
              message: `API key not valid. Please pass a valid API key. ${KEY}`,
            },
          }
        : {},
    );
    const err = (await plan(base)).at(-1)!;

    expect(err.data.code).toBe('AI_NOT_CONFIGURED');
    expect(err.data.details.join('\n')).toMatch(/Google said: PERMISSION_DENIED: API key not valid/);
    expect(JSON.stringify(err) + logs.join('\n')).not.toContain(KEY);
  });
});
