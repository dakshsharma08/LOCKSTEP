/**
 * The diagnostic (`npm run diagnose:gemini`) must reach the RIGHT conclusion from measurements.
 * It runs against the local fake Gemini (tests/helpers/fakeGemini.ts); against Google it is the same code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runDiagnostics } from '../../server/gemini/diagnose';
import { startFakeGemini, type FakeGemini, type FakeReply, type FakeRequest } from '../helpers/fakeGemini';

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
  const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];

  it('primary 503 + a working alternative: says so, and the full flow really falls back', async () => {
    const { report, text } = await diagnose(
      (r) => (r.model === 'gemini-3.8-flash' ? overloaded : {}),
      {},
      MODELS,
    );

    expect(report.modelsListed).toEqual(['gemini-3.6-flash', 'gemini-3.8-flash']);
    expect(report.alternatives.map((a) => [a.model, a.timing.ok])).toEqual([['gemini-3.6-flash', true]]);
    expect(report.minimal.every((m) => m.timing.status === 503)).toBe(true);
    const v = report.verdict.join('\n');
    expect(v).toMatch(/OVERLOADED: Google answered HTTP 503 for gemini-3\.8-flash/);
    expect(v).toMatch(/FALLBACK READY: gemini-3\.6-flash answered/);
    // The app's own /api/plan flow, end to end, used the alternative.
    expect(report.flow).toMatchObject({ ok: true, fellBack: true, model: 'gemini-3.6-flash' });
    expect(v).toMatch(/FULL FLOW OK.*written by gemini-3\.6-flash after falling back/);
    expect(text).toMatch(/Fallback chain: gemini-3\.8-flash → gemini-3\.6-flash/);
    expect(text).toMatch(/Trying gemini-3\.6-flash instead/);
    expect(text).not.toContain(KEY);
  });

  it("with the developer's real model list the chain is 3.8 → 3.6 → 3.5, and 3.7 / 2.5 are never tried", async () => {
    const REAL = [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
    ];
    const { report, text } = await diagnose(
      (r) => (r.model === 'gemini-3.8-flash' ? overloaded : {}),
      { skipPlan: true },
      REAL,
    );

    expect(report.alternatives.map((a) => a.model)).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
    expect(text).toMatch(/Fallback chain: gemini-3\.8-flash → gemini-3\.6-flash → gemini-3\.5-flash/);
    expect(text).not.toMatch(/gemini-3\.7-flash +(OK|FAIL)/);
    expect(text).not.toMatch(/gemini-2\.5-flash +(OK|FAIL)/);
  });

  it('generation 503 everywhere but the list works: NO WORKING ALTERNATIVE, and the flow fails honestly with AI_BUSY', async () => {
    const { report, text } = await diagnose((r) => (r.model ? overloaded : {}), {}, MODELS);

    const v = report.verdict.join('\n');
    expect(v).toMatch(/OVERLOADED/);
    expect(v).toMatch(/NO WORKING ALTERNATIVE right now: gemini-3\.6-flash \(HTTP 503\)/);
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
