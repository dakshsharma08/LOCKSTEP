/**
 * The diagnostic (`npm run diagnose:gemini`) must reach the RIGHT conclusion from measurements.
 * It runs against the local fake Gemini (tests/helpers/fakeGemini.ts); against Google it is the same code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runDiagnostics } from '../../server/gemini/diagnose';
import {
  TOO_MANY_STATES,
  startFakeGemini,
  type FakeGemini,
  type FakeReply,
  type FakeRequest,
} from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-diagnostic-key-0123456789abcd`;
let fake: FakeGemini | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

const planStream = (r: FakeRequest) => r.stream && !!r.body?.generationConfig?.responseJsonSchema;
const levelOf = (r: FakeRequest) =>
  r.body?.generationConfig?.thinkingConfig?.thinkingLevel as string | undefined;

async function diagnose(
  decide: (r: FakeRequest) => FakeReply | void,
  extra: Parameters<typeof runDiagnostics>[0] extends infer O ? Partial<O> : never = {},
  /** Models the fake key can call (default: just gemini-3.8-flash). */
  models?: string[],
) {
  fake = await startFakeGemini(decide, models ? { models } : {});
  const lines: string[] = [];
  const report = await runDiagnostics({
    apiKey: KEY,
    baseUrl: fake.baseUrl,
    model: 'gemini-3.8-flash',
    reachTimeoutMs: 400,
    callTimeoutMs: 2000,
    planTimeoutMs: 3000,
    firstChunkTimeoutMs: 300, // stands in for the real 30 s limit
    onLine: (l) => lines.push(l),
    ...extra,
  });
  return { report, lines, text: lines.join('\n') };
}

describe('diagnose: reaches the right conclusion', () => {
  it('finds thinking latency as the root cause when only the default-thinking plan request is slow', async () => {
    const { report, text } = await diagnose((r) =>
      planStream(r) ? { firstChunkDelayMs: levelOf(r) === 'LOW' ? 10 : 900 } : {},
    );

    expect(report.reach.every((x) => x.ok && x.modelListed)).toBe(true);
    expect(report.minimal.every((m) => m.timing.ok)).toBe(true);
    const [A, B] = [report.plan.find((p) => p.variant === 'A')!, report.plan.find((p) => p.variant === 'B')!];
    expect(A.timing.firstChunkMs).toBeGreaterThan(300);
    expect(B.timing.firstChunkMs).toBeLessThan(300);
    expect(B.timing.jsonOk).toBe(true);
    expect(report.verdict.join('\n')).toMatch(/ROOT CAUSE \(thinking latency\)/);
    // …and the complete /api/plan flow of the app works with the fix.
    expect(report.flow?.ok).toBe(true);
    expect(report.verdict.join('\n')).toMatch(/FULL FLOW OK/);
    expect(text).not.toContain(KEY);
  });

  it('reports a NETWORK PROBLEM, and stops early, when Google never answers', async () => {
    const t0 = Date.now();
    const { report, text } = await diagnose(() => ({ neverRespond: true }));

    expect(report.reach.every((x) => !x.ok)).toBe(true);
    expect(report.verdict.join('\n')).toMatch(/NETWORK PROBLEM.*could not get an HTTP response/);
    expect(report.verdict.join('\n')).toMatch(/proxy|firewall|VPN/i);
    expect(report.minimal).toHaveLength(0); // later steps were skipped
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(text).toMatch(/Stopping here/);
  });

  it('suggests GEMINI_API_VERSION=v1beta when requests only work on v1beta', async () => {
    const { report } = await diagnose(
      (r) =>
        r.version === 'v1' && r.model
          ? { error: { status: 400, message: 'Unknown name "thinkingConfig": Cannot find field.' } }
          : {},
      { skipPlan: true },
    );
    expect(report.verdict.join('\n')).toMatch(/GEMINI_API_VERSION=v1beta/);
  });

  it("reports a KEY PROBLEM with Google's reason, and never prints the key", async () => {
    const { report, text } = await diagnose(() => ({
      error: { status: 403, code: 'PERMISSION_DENIED', message: `API key not valid. ${KEY}` },
    }));
    expect(report.verdict.join('\n')).toMatch(/KEY PROBLEM.*HTTP 403.*PERMISSION_DENIED/);
    expect(text + JSON.stringify(report)).not.toContain(KEY);
  });

  it("flags a model that is not in the key's model list", async () => {
    const { report } = await diagnose(() => ({}), { model: 'gemini-9.9-flash', skipPlan: true });
    expect(report.verdict.join('\n')).toMatch(/MODEL NOT AVAILABLE/);
  });
});

describe('diagnose: overloaded primary (HTTP 503) and the fallback chain', () => {
  const overloaded = {
    error: { status: 503, code: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' },
  };
  const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash'];

  it('primary 503 + a working alternative: says so, and the full flow really falls back', async () => {
    const { report, text } = await diagnose(
      (r) => (r.model === 'gemini-3.8-flash' ? overloaded : {}),
      {},
      MODELS,
    );

    expect(report.modelsListed).toEqual(['gemini-3.5-flash', 'gemini-3.8-flash']);
    expect(report.alternatives.map((a) => [a.model, a.timing.ok])).toEqual([['gemini-3.5-flash', true]]);
    expect(report.minimal.every((m) => m.timing.status === 503)).toBe(true);
    const v = report.verdict.join('\n');
    expect(v).toMatch(/OVERLOADED: Google answered HTTP 503 for gemini-3\.8-flash/);
    expect(v).toMatch(/FALLBACK READY: gemini-3\.5-flash answered/);
    // The app's own /api/plan flow, end to end, used the alternative.
    expect(report.flow).toMatchObject({ ok: true, fellBack: true, model: 'gemini-3.5-flash' });
    expect(v).toMatch(/FULL FLOW OK.*written by gemini-3\.5-flash after falling back/);
    expect(text).toMatch(/Fallback chain: gemini-3\.8-flash → gemini-3\.5-flash/);
    expect(text).toMatch(/Trying gemini-3\.5-flash instead/);
    expect(text).not.toContain(KEY);
  });

  it("with the developer's real model list the chain is 3.8 → 3.5 → 3.6, and 3.7 / 2.5 are never tried", async () => {
    const REAL = [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-2.5-flash',
    ];
    const { report, text } = await diagnose(
      (r) => (r.model === 'gemini-3.8-flash' ? overloaded : {}),
      { skipPlan: true },
      REAL,
    );

    expect(report.alternatives.map((a) => a.model)).toEqual(['gemini-3.5-flash', 'gemini-3.6-flash']);
    expect(text).toMatch(/Fallback chain: gemini-3\.8-flash → gemini-3\.5-flash → gemini-3\.6-flash/);
    expect(text).not.toMatch(/gemini-3\.7-flash +(OK|FAIL)/);
    expect(text).not.toMatch(/gemini-2\.5-flash +(OK|FAIL)/);
  });

  it('generation 503 everywhere but the list works: NO WORKING ALTERNATIVE, and the flow fails honestly with AI_BUSY', async () => {
    const { report, text } = await diagnose((r) => (r.model ? overloaded : {}), {}, MODELS);

    const v = report.verdict.join('\n');
    expect(v).toMatch(/OVERLOADED/);
    expect(v).toMatch(/NO WORKING ALTERNATIVE right now: gemini-3\.5-flash \(HTTP 503\)/);
    expect(report.flow?.ok).toBe(false);
    expect(report.flow?.error?.code).toBe('AI_BUSY');
    expect(v).toMatch(/FULL FLOW FAILED: AI_BUSY/);
    expect(text).not.toContain(KEY);
  });

  it('even the model list returns 503: "Google unavailable", never "network problem"', async () => {
    const { report, text } = await diagnose(() => overloaded, { skipPlan: true }, MODELS);

    const v = report.verdict.join('\n');
    expect(v).toMatch(/GOOGLE UNAVAILABLE: even listing models returned HTTP 503/);
    expect(v).not.toMatch(/NETWORK PROBLEM/);
    expect(v).toMatch(/NO ALTERNATIVE KNOWN: the model list itself is unavailable/);
    expect(text).toMatch(/\[2\/6\] Minimal request/); // it kept diagnosing instead of stopping
  });

  it('primary 503 and the key lists no other stable Flash model: says so', async () => {
    // The list works (only one model is on it); generation is what is overloaded.
    const { report } = await diagnose((r) => (r.model ? overloaded : {}), { skipPlan: true }, [
      'gemini-3.8-flash',
    ]);
    expect(report.alternatives).toHaveLength(0);
    expect(report.verdict.join('\n')).toMatch(
      /NO ALTERNATIVE MODEL: this key lists no other stable Flash model/,
    );
  });
});

describe("diagnose: the owner's real case (primary over quota, plan schema on the alternatives)", () => {
  const REAL = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-2.5-flash',
  ];
  const quota = {
    error: {
      status: 429,
      code: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota. Quota exceeded for metric: …free_tier_requests, limit: 20',
    },
  };

  it('primary 429: says QUOTA, spends no more calls on it, and checks the real plan schema on 3.5 and 3.6', async () => {
    const { report, text } = await diagnose((r) => (r.model === 'gemini-3.8-flash' ? quota : {}), {}, REAL);
    const v = report.verdict.join('\n');

    expect(v).toMatch(/QUOTA \/ RATE LIMIT: Google answered HTTP 429 for gemini-3\.8-flash/);
    expect(v).not.toMatch(/OVERLOADED/);
    expect(report.plan).toHaveLength(1); // the other thinking variants were skipped: they would only burn quota
    expect(text).toMatch(/other thinking settings skipped: gemini-3\.8-flash answered HTTP 429/);
    expect(report.planAlternatives.map((p) => [p.model, p.timing.ok, p.timing.jsonOk])).toEqual([
      ['gemini-3.5-flash', true, true],
      ['gemini-3.6-flash', true, true],
    ]);
    expect(v).toMatch(/PLAN SCHEMA OK on gemini-3\.5-flash/);
    expect(v).toMatch(/PLAN SCHEMA OK on gemini-3\.6-flash/);
    expect(v).not.toMatch(/SCHEMA TOO COMPLEX/);
    expect(report.flow).toMatchObject({ ok: true, fellBack: true, model: 'gemini-3.5-flash' });
    // The plan request each alternative got is the app's real one: prompt + response schema.
    const sent = fake!.requests.filter((r) => planStream(r) && r.model === 'gemini-3.6-flash');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.body?.systemInstruction).toBeTruthy();
    expect(text).not.toContain(KEY);
  });

  it('alternatives reject the plan schema (400 too many states): SCHEMA TOO COMPLEX, and the flow says so, not AI_BUSY', async () => {
    const { report } = await diagnose(
      (r) =>
        r.model === 'gemini-3.8-flash'
          ? quota
          : planStream(r)
            ? { error: { status: 400, code: 'INVALID_ARGUMENT', message: TOO_MANY_STATES } }
            : {},
      {},
      REAL,
    );
    const v = report.verdict.join('\n');

    expect(v).toMatch(
      /SCHEMA TOO COMPLEX: Google rejected the plan's response schema \(HTTP 400\) on gemini-3\.5-flash, gemini-3\.6-flash/,
    );
    expect(v).toMatch(/another model will not help/);
    expect(report.flow?.ok).toBe(false);
    expect(report.flow?.error?.code).toBe('INTERNAL');
    expect(report.flow?.error?.message).toMatch(/response schema is too complex/);
    expect(v).not.toMatch(/FULL FLOW FAILED: AI_BUSY/);
  });
});

describe('diagnose: uses the same settings as the app, and shows how a stream stalled', () => {
  const REAL = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
  ];
  const quota = {
    error: { status: 429, code: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. limit: 20' },
  };
  const primaryOverQuota = (r: FakeRequest) => (r.model === 'gemini-3.8-flash' ? quota : undefined);
  const planStreamTo = (m: string) => fake!.requests.filter((r) => planStream(r) && r.model === m);

  it('GEMINI_MODEL_FALLBACKS reaches EVERY step, including the full /api/plan flow', async () => {
    const { report, text } = await diagnose(
      primaryOverQuota,
      { env: { GEMINI_MODEL_FALLBACKS: 'gemini-3.6-flash' } },
      REAL,
    );

    expect(report.chainSource).toBe('GEMINI_MODEL_FALLBACKS');
    expect(text).toMatch(
      /Fallback chain: gemini-3\.8-flash → gemini-3\.6-flash +\(from GEMINI_MODEL_FALLBACKS\)/,
    );
    // Before the fix the flow ignored the variable and used the automatic chain (3.5 first).
    expect(report.flow).toMatchObject({ ok: true, fellBack: true, model: 'gemini-3.6-flash' });
    expect(planStreamTo('gemini-3.5-flash')).toHaveLength(0);
  });

  it('GEMINI_MODEL_FALLBACKS=none reaches the flow too: no alternative is tried', async () => {
    const { report } = await diagnose(primaryOverQuota, { env: { GEMINI_MODEL_FALLBACKS: 'none' } }, REAL);
    expect(report.chainSource).toBe('disabled');
    expect(report.flow?.ok).toBe(false);
    expect(report.flow?.error?.details).toContain(
      'No alternative model was available to try (see GEMINI_MODEL_FALLBACKS).',
    );
  });

  it("GEMINI_THINKING_LEVEL reaches the plan requests and the flow (the app's setting is sent first)", async () => {
    const { report, text } = await diagnose(
      primaryOverQuota,
      { env: { GEMINI_THINKING_LEVEL: 'minimal' } },
      REAL,
    );

    expect(text).toMatch(/Thinking setting used by the app: minimal \(GEMINI_THINKING_LEVEL\)/);
    expect(report.plan.map((p) => p.variant)).toEqual(['B']); // the app's own setting first; 429 stops the rest
    const levels = fake!.requests.filter(planStream).map((r) => levelOf(r));
    expect(levels.length).toBeGreaterThanOrEqual(4); // primary + 2 alternatives + the flow
    expect(new Set(levels)).toEqual(new Set(['MINIMAL']));
    expect(report.flow?.ok).toBe(true);
  });

  it('a stream that stops after a few TEXT chunks: STREAM STALL with the chunk split and the silence', async () => {
    const { report, text } = await diagnose(
      (r) =>
        r.model === 'gemini-3.8-flash'
          ? quota
          : planStream(r) && r.model === 'gemini-3.6-flash'
            ? { stallAfterChunks: 2 }
            : undefined,
      { planTimeoutMs: 600 },
      REAL,
    );

    const t = report.planAlternatives.find((p) => p.model === 'gemini-3.6-flash')!.timing;
    expect(t).toMatchObject({ ok: false, timedOut: true, stalledIn: 'streaming', chunks: 2, textChunks: 2 });
    expect(t.lastChunkMs).toBeLessThan(t.totalMs);
    expect(text).toMatch(/gemini-3\.6-flash +FAIL STALLED after 2 chunks — 2 chunks \(0 thinking, 2 text\)/);
    expect(report.verdict.join('\n')).toMatch(
      /STREAM STALL on gemini-3\.6-flash: 2 chunks \(0 thinking, 2 text\), then nothing for [\d.]+ (ms|s)/,
    );
  });

  it('a stream that only ever THINKS and then goes silent: THINKING STALL, with a suggestion', async () => {
    const { report } = await diagnose(
      (r) =>
        r.model === 'gemini-3.8-flash'
          ? quota
          : planStream(r) && r.model === 'gemini-3.6-flash'
            ? { thoughtAfterMs: 10, stallAfterChunks: 0 }
            : undefined,
      { planTimeoutMs: 600 },
      REAL,
    );

    const t = report.planAlternatives.find((p) => p.model === 'gemini-3.6-flash')!.timing;
    expect(t).toMatchObject({ chunks: 1, thoughtChunks: 1, textChunks: 0, stalledIn: 'streaming' });
    expect(report.verdict.join('\n')).toMatch(/THINKING STALL on gemini-3\.6-flash: 1 chunks, all thinking/);
    expect(report.verdict.join('\n')).toMatch(/GEMINI_THINKING_LEVEL=minimal/);
  });

  it('a stream that finishes but pauses longer than the app allows between chunks: LONG PAUSE', async () => {
    const { report, text } = await diagnose(
      (r) =>
        r.model === 'gemini-3.8-flash'
          ? quota
          : planStream(r) && r.model === 'gemini-3.5-flash'
            ? { pauseAfterChunk: 2, pauseMs: 250 }
            : undefined,
      { chunkIdleTimeoutMs: 100, skipFlow: true },
      REAL,
    );

    const t = report.planAlternatives.find((p) => p.model === 'gemini-3.5-flash')!.timing;
    expect(t.ok).toBe(true);
    expect(t.maxGapMs).toBeGreaterThanOrEqual(200);
    expect(t.maxGapAfterChunk).toBe(2);
    expect(text).toMatch(/longest gap [\d.]+ (ms|s) after chunk 2/);
    expect(report.verdict.join('\n')).toMatch(/LONG PAUSE on gemini-3\.5-flash: it finished, but paused/);
  });
});

describe('diagnose: what the SDK hides (wire probe), cut-off answers and speed', () => {
  const REAL = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
  const quota = {
    error: { status: 429, code: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. limit: 20' },
  };
  const onAlt = (m: string, reply: FakeReply) => (r: FakeRequest) =>
    r.model === 'gemini-3.8-flash' ? quota : planStream(r) && r.model === m ? reply : undefined;
  const altTiming = (report: Awaited<ReturnType<typeof diagnose>>['report'], m: string) =>
    report.planAlternatives.find((p) => p.model === m)!.timing;

  it('a normal plan request: finish STOP, token counts, speed, and what came over the wire', async () => {
    const { report, text } = await diagnose(onAlt('none', {}), { skipFlow: true }, REAL);
    const t = altTiming(report, 'gemini-3.5-flash');

    expect(t).toMatchObject({ ok: true, finishReason: 'STOP', outputTokens: 20, promptTokens: 10 });
    expect(t.wire).toMatchObject({ requests: 1, commentLines: 0 });
    expect(t.wire!.bytes).toBeGreaterThan(500);
    expect(text).toMatch(
      /plan request on gemini-3\.5-flash +OK .*finish STOP · 20 output tokens.*wire: 1 request\(s\)/,
    );
    expect(report.verdict.join('\n')).toMatch(/SPEED on gemini-3\.5-flash: first text at/);
  });

  it('an answer that ends without STOP: CUT OFF', async () => {
    const { report } = await diagnose(
      onAlt('gemini-3.5-flash', { noFinish: true }),
      { skipFlow: true },
      REAL,
    );
    expect(altTiming(report, 'gemini-3.5-flash').finishReason).toBeUndefined();
    expect(report.verdict.join('\n')).toMatch(
      /CUT OFF on gemini-3\.5-flash: the answer ended without a finish reason/,
    );
  });

  it('Google splits the answer: CONTINUATION, with the extra request counted', async () => {
    const { report } = await diagnose(
      onAlt('gemini-3.5-flash', { continueAfterChunks: 2, resumeDelayMs: 50 }),
      { skipFlow: true },
      REAL,
    );
    const t = altTiming(report, 'gemini-3.5-flash');
    expect(t).toMatchObject({ ok: true, hops: 1, finishReason: 'STOP' });
    expect(t.wire?.requests).toBe(2);
    expect(report.verdict.join('\n')).toMatch(
      /CONTINUATION on gemini-3\.5-flash: Google split the answer into 2 requests/,
    );
  });

  it('a "stall" during which the connection kept sending SSE comments: KEEP-ALIVES, a live connection', async () => {
    const { report } = await diagnose(
      onAlt('gemini-3.6-flash', { stallAfterChunks: 2, keepAliveMs: 80 }),
      { skipFlow: true, planTimeoutMs: 1500 },
      REAL,
    );
    const t = altTiming(report, 'gemini-3.6-flash');
    expect(t).toMatchObject({ ok: false, stalledIn: 'streaming', chunks: 2 });
    expect(t.wire!.commentLines).toBeGreaterThan(5);
    expect(t.wire!.lastByteMs!).toBeGreaterThan(t.lastChunkMs! + 1000);
    expect(report.verdict.join('\n')).toMatch(
      /KEEP-ALIVES on gemini-3\.6-flash: \d+ SSE comment line\(s\) arrived that the SDK hides; the connection was still sending/,
    );
  });
});

describe('diagnose: chooses the model the same way as the app', () => {
  it('no --model and no GEMINI_MODEL: the default gemini-3.1-flash-lite, because this key lists it', async () => {
    const { report, text } = await diagnose(() => undefined, { model: undefined, env: {}, skipPlan: true }, [
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
    ]);
    expect(report).toMatchObject({ model: 'gemini-3.1-flash-lite', modelSource: 'default' });
    expect(text).toMatch(
      /Model under test: gemini-3\.1-flash-lite \(this app's default model, listed for this key\)/,
    );
  });

  it('a key without the default: the newest stable Flash model, as before', async () => {
    const { report } = await diagnose(() => undefined, { model: undefined, env: {}, skipPlan: true }, [
      'gemini-3.8-flash',
      'gemini-3.5-flash',
    ]);
    expect(report).toMatchObject({ model: 'gemini-3.8-flash', modelSource: 'auto-picked' });
  });
});
