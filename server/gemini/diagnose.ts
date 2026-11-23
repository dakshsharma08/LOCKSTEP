/**
 * Gemini connection + latency diagnostic (the engine behind `npm run diagnose:gemini`).
 *
 * Why (for learners): "Gemini took too long" can mean four very different things, and each
 * needs a different fix. Instead of guessing we measure, in order, from the cheapest test to
 * the full planning flow, using REAL calls with YOUR key:
 *
 *   1. Can this machine reach Google at all, and does the key work?   (raw HTTP, v1 and v1beta)
 *   2. Is the chosen model listed for this key, and does it do generateContent?
 *   3. How long does a tiny request take (normal + streaming)?
 *   4. How long does the REAL plan request take with different thinking settings?
 *   5. Does the complete /api/plan flow of this app work?
 *
 * Everything printed passes through redactSecrets(), so the key never reaches the screen.
 * The library takes a `baseUrl` so tests can point it at a local fake server; the CLI uses Google.
 */
import { GoogleGenAI, type GenerateContentConfig, type ThinkingConfig } from '@google/genai';
import type { AddressInfo } from 'node:net';
import type { ApiError, PlanStreamEvent } from '../../shared/api';
import { createApp } from '../app';
import { upstreamStatus } from '../lib/errors';
import { redactSecrets, registerSecrets, upstreamReason } from '../lib/redact';
import { partsText } from './call';
import { pickNewestStableFlash } from './client';
import { parseFallbackList, pickFallbacks } from './fallback';
import { buildPlanSystemInstruction, buildPlanUserParts } from './prompts';
import { preparePlanJob } from './plan';
import { buildPlanJsonSchema } from './schema';
import { planThinkingConfig } from './thinking';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

export interface DiagOptions {
  apiKey: string;
  /** Default: Google. Tests pass a local fake server. */
  baseUrl?: string;
  /** Model to test. Default: GEMINI_MODEL, else the newest stable Flash model the key can list. */
  model?: string;
  /** API version for the plan + full-flow steps (default: the SDK's own default). */
  apiVersion?: string;
  skipPlan?: boolean;
  skipFlow?: boolean;
  /** Per-step caps (ms). */
  reachTimeoutMs?: number;
  callTimeoutMs?: number;
  planTimeoutMs?: number;
  /** The app's own first-chunk timeout during the full-flow step (ms). Default 30 000. */
  firstChunkTimeoutMs?: number;
  /** Live progress lines (the CLI prints them as they happen). */
  onLine?: (line: string) => void;
  sdkVersion?: string;
}

export interface StreamTiming {
  ok: boolean;
  /** Time until Google's HTTP response headers arrived. */
  headersMs?: number;
  firstChunkMs?: number;
  firstTextMs?: number;
  totalMs: number;
  chunks?: number;
  thoughtChunks?: number;
  tokens?: number;
  thoughtTokens?: number;
  jsonOk?: boolean;
  /** Where it stalled, if it did not finish. */
  stalledIn?: 'waiting-for-http-response' | 'waiting-for-first-chunk' | 'streaming';
  timedOut?: boolean;
  status?: number;
  reason?: string;
  error?: string;
}

export interface ReachResult {
  version: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  reason?: string;
  models?: number;
  modelListed?: boolean;
  methods?: string[];
}

export interface DiagReport {
  env: {
    node: string;
    sdk: string;
    baseUrl: string;
    keyLength: number;
    proxies: string[];
    modelEnv: string | null;
  };
  model: string;
  modelSource: 'option' | 'GEMINI_MODEL' | 'auto-picked' | 'fallback';
  reach: ReachResult[];
  minimal: { version: string; kind: 'generate' | 'stream'; timing: StreamTiming }[];
  plan: { variant: 'A' | 'B' | 'C'; label: string; thinking: ThinkingConfig | null; timing: StreamTiming }[];
  /** Flash-family models this key can call (live list from Google). */
  modelsListed: string[];
  /** Where the fallback chain comes from. */
  chainSource: 'auto' | 'GEMINI_MODEL_FALLBACKS' | 'disabled';
  /** Real minimal request to each alternative the app would fall back to. */
  alternatives: { model: string; timing: StreamTiming }[];
  flow: null | {
    ok: boolean;
    ms: number;
    /** The model that wrote the plan (from the app's own run log), and whether the app fell back to it. */
    model?: string;
    fellBack?: boolean;
    events: { atMs: number; event: string; note?: string }[];
    error?: ApiError;
    logLines: string[];
  };
  verdict: string[];
}

const sec = (ms: number | undefined) =>
  ms === undefined ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

// ───────────────────────────── helpers ─────────────────────────────

async function reach(
  opts: Required<Pick<DiagOptions, 'apiKey' | 'reachTimeoutMs'>> & { base: string; model: string | null },
  version: string,
): Promise<ReachResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${opts.base}/${version}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': opts.apiKey },
      signal: AbortSignal.timeout(opts.reachTimeoutMs),
    });
    const ms = performance.now() - t0;
    const text = await res.text();
    if (!res.ok) {
      return { version, ok: false, status: res.status, ms, reason: upstreamReason(new Error(text)) };
    }
    const body = JSON.parse(text) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    const list = body.models ?? [];
    const hit = opts.model ? list.find((m) => m.name?.replace(/^models\//, '') === opts.model) : undefined;
    return {
      version,
      ok: true,
      status: res.status,
      ms,
      models: list.length,
      ...(opts.model ? { modelListed: !!hit, methods: hit?.supportedGenerationMethods } : {}),
    };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    const name =
      (e as Error).name === 'TimeoutError'
        ? `no response within ${sec(opts.reachTimeoutMs)}`
        : (e as Error).message;
    return { version, ok: false, ms: performance.now() - t0, error: cause ? `${name} (${cause})` : name };
  }
}

async function listNames(
  base: string,
  apiKey: string,
  version: string,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const res = await fetch(`${base}/${version}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    return (body.models ?? [])
      .filter(
        (m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'),
      )
      .map((m) => m.name ?? '');
  } catch {
    return [];
  }
}

type Request = { contents: unknown; config?: GenerateContentConfig };

async function timeGenerate(
  ai: GoogleGenAI,
  model: string,
  req: Request,
  capMs: number,
): Promise<StreamTiming> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), capMs);
  const t0 = performance.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: req.contents as never,
      config: { ...req.config, abortSignal: ctrl.signal },
    });
    return {
      ok: true,
      totalMs: performance.now() - t0,
      tokens: res.usageMetadata?.totalTokenCount,
      thoughtTokens: res.usageMetadata?.thoughtsTokenCount,
    };
  } catch (e) {
    return failed(e, ctrl.signal.aborted, undefined, undefined, t0);
  } finally {
    clearTimeout(timer);
  }
}

async function timeStream(
  ai: GoogleGenAI,
  model: string,
  req: Request,
  capMs: number,
  expectJson = false,
): Promise<StreamTiming> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), capMs);
  const t0 = performance.now();
  let headersMs: number | undefined;
  let firstChunkMs: number | undefined;
  try {
    const stream = await ai.models.generateContentStream({
      model,
      contents: req.contents as never,
      config: { ...req.config, abortSignal: ctrl.signal },
    });
    headersMs = performance.now() - t0;
    let firstTextMs: number | undefined;
    let chunks = 0;
    let thoughtChunks = 0;
    let text = '';
    let usage: { totalTokenCount?: number; thoughtsTokenCount?: number } | undefined;
    for await (const chunk of stream) {
      chunks++;
      firstChunkMs ??= performance.now() - t0;
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      if (parts.some((p) => p.thought)) thoughtChunks++;
      const d = partsText(parts);
      if (d) {
        firstTextMs ??= performance.now() - t0;
        text += d;
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    let jsonOk: boolean | undefined;
    if (expectJson) {
      try {
        JSON.parse(text);
        jsonOk = true;
      } catch {
        jsonOk = false;
      }
    }
    return {
      ok: true,
      headersMs,
      firstChunkMs,
      firstTextMs,
      totalMs: performance.now() - t0,
      chunks,
      thoughtChunks,
      tokens: usage?.totalTokenCount,
      thoughtTokens: usage?.thoughtsTokenCount,
      jsonOk,
    };
  } catch (e) {
    return failed(e, ctrl.signal.aborted, headersMs, firstChunkMs, t0);
  } finally {
    clearTimeout(timer);
  }
}

function failed(
  e: unknown,
  aborted: boolean,
  headersMs: number | undefined,
  firstChunkMs: number | undefined,
  t0: number,
): StreamTiming {
  const status = upstreamStatus(e);
  return {
    ok: false,
    headersMs,
    firstChunkMs,
    totalMs: performance.now() - t0,
    timedOut: aborted,
    stalledIn:
      headersMs === undefined
        ? 'waiting-for-http-response'
        : firstChunkMs === undefined
          ? 'waiting-for-first-chunk'
          : 'streaming',
    ...(status !== undefined
      ? { status, reason: upstreamReason(e) }
      : { error: redactSecrets((e as Error).message ?? String(e)).slice(0, 200) }),
  };
}

function timingLine(t: StreamTiming): string {
  if (t.ok) {
    const parts = [`total ${sec(t.totalMs)}`];
    if (t.headersMs !== undefined)
      parts.unshift(
        `HTTP ${sec(t.headersMs)}`,
        `first chunk ${sec(t.firstChunkMs)}`,
        `first text ${sec(t.firstTextMs)}`,
      );
    if (t.chunks !== undefined) parts.push(`${t.chunks} chunks (${t.thoughtChunks ?? 0} thought)`);
    if (t.thoughtTokens) parts.push(`${t.thoughtTokens} thinking tokens`);
    if (t.jsonOk !== undefined) parts.push(t.jsonOk ? 'valid JSON' : 'INVALID JSON');
    return parts.join(' · ');
  }
  if (t.status !== undefined) return `HTTP ${t.status}${t.reason ? ` — Google said: ${t.reason}` : ''}`;
  if (t.timedOut)
    return `NO ANSWER in ${sec(t.totalMs)} — stalled ${t.stalledIn?.replace(/-/g, ' ')}${t.headersMs !== undefined ? ` (HTTP response came after ${sec(t.headersMs)})` : ''}`;
  return `failed after ${sec(t.totalMs)}: ${t.error ?? 'unknown error'}`;
}

// ───────────────────────────── the run ─────────────────────────────

export async function runDiagnostics(o: DiagOptions): Promise<DiagReport> {
  registerSecrets([o.apiKey]);
  const say = (line: string) => o.onLine?.(redactSecrets(line, [o.apiKey]));
  const base = (o.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const reachCap = o.reachTimeoutMs ?? 15_000;
  const callCap = o.callTimeoutMs ?? 45_000;
  const planCap = o.planTimeoutMs ?? 90_000;
  const mk = (apiVersion?: string) =>
    new GoogleGenAI({
      apiKey: o.apiKey,
      ...(apiVersion ? { apiVersion } : {}),
      ...(o.baseUrl ? { httpOptions: { baseUrl: base } } : {}),
    });

  const report: DiagReport = {
    env: {
      node: process.version,
      sdk: o.sdkVersion ?? 'unknown',
      baseUrl: base,
      keyLength: o.apiKey.length,
      proxies: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'].filter(
        (k) => process.env[k] || process.env[k.toLowerCase()],
      ),
      modelEnv: process.env.GEMINI_MODEL?.trim() || null,
    },
    model: '',
    modelSource: 'fallback',
    reach: [],
    minimal: [],
    modelsListed: [],
    chainSource: 'auto',
    alternatives: [],
    plan: [],
    flow: null,
    verdict: [],
  };
  say(
    `Node ${report.env.node} · @google/genai ${report.env.sdk} · key present (${report.env.keyLength} chars, not shown) · ${report.env.baseUrl}`,
  );
  if (report.env.proxies.length)
    say(`Proxy-related environment variables set: ${report.env.proxies.join(', ')}`);

  // Which model? Same rule as the server: GEMINI_MODEL, else the newest stable Flash the key can list.
  if (o.model) [report.model, report.modelSource] = [o.model, 'option'];
  else if (report.env.modelEnv) [report.model, report.modelSource] = [report.env.modelEnv, 'GEMINI_MODEL'];
  else {
    const picked = pickNewestStableFlash(await listNames(base, o.apiKey, 'v1beta', reachCap));
    [report.model, report.modelSource] = picked
      ? [picked.replace(/^models\//, ''), 'auto-picked']
      : ['gemini-flash-latest', 'fallback'];
  }

  // 1 + 2. Reachability, key and model availability on both API versions.
  say('\n[1/6] Reaching Google and checking the key + model (raw HTTP, no SDK)');
  for (const version of ['v1', 'v1beta']) {
    const r = await reach({ apiKey: o.apiKey, reachTimeoutMs: reachCap, base, model: report.model }, version);
    report.reach.push(r);
    say(
      r.ok
        ? `  ${version.padEnd(7)} OK ${sec(r.ms)} · ${r.models} models · ${report.model} ${r.modelListed ? `listed (${(r.methods ?? []).join(', ') || 'methods not reported'})` : 'NOT LISTED'}`
        : `  ${version.padEnd(7)} FAILED ${sec(r.ms)} · ${r.status ? `HTTP ${r.status}${r.reason ? ` — ${r.reason}` : ''}` : r.error}`,
    );
  }

  // 3. Minimal real requests.
  // A version counts as reachable if Google ANSWERED with data, or with a temporary error (503 etc.):
  // "overloaded" is not "unreachable", and the generation requests below may behave differently.
  const temporary = (r: ReachResult) => r.status !== undefined && (r.status >= 500 || r.status === 429);
  const reachable = report.reach.filter((r) => r.ok || temporary(r)).map((r) => r.version);
  if (reachable.length === 0) {
    // Nothing else can work (no HTTP answer at all, or the key was rejected): don't make the user wait.
    say('\nStopping here: no later step can work until Google is reachable.');
    report.verdict = diagnose(report, o.firstChunkTimeoutMs ?? 30_000);
    say('\nDiagnosis');
    for (const line of report.verdict) say(`  ${line}`);
    return report;
  }
  say(`\n[2/6] Minimal request to ${report.model} (“Reply with the single word OK.”)`);
  const tiny: Request = { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] };
  for (const version of reachable) {
    for (const kind of ['generate', 'stream'] as const) {
      const timing =
        kind === 'generate'
          ? await timeGenerate(mk(version), report.model, tiny, callCap)
          : await timeStream(mk(version), report.model, tiny, callCap);
      report.minimal.push({ version, kind, timing });
      say(`  ${version.padEnd(7)} ${kind.padEnd(8)} ${timing.ok ? 'OK ' : 'FAIL'} ${timingLine(timing)}`);
    }
  }

  // 3. The alternative models the app falls back to when the primary is temporarily unavailable (503).
  say('\n[3/6] Alternative models: what the app falls back to if the primary returns 503');
  const listed = await listNames(base, o.apiKey, 'v1beta', reachCap);
  report.modelsListed = listed
    .map((n) => n.replace(/^models\//, ''))
    .filter((n) => /^gemini-.*flash/.test(n))
    .sort();
  say(`  Flash-family models this key can call: ${report.modelsListed.join(', ') || '(none listed)'}`);
  const fb = parseFallbackList(process.env.GEMINI_MODEL_FALLBACKS);
  report.chainSource =
    fb.models === null ? 'auto' : fb.models.length === 0 ? 'disabled' : 'GEMINI_MODEL_FALLBACKS';
  const chain =
    fb.models === null
      ? pickFallbacks(listed, report.model, 2)
      : fb.models.filter((m) => m !== report.model).slice(0, 2);
  say(
    chain.length > 0
      ? `  Fallback chain: ${[report.model, ...chain].join(' → ')}  (${report.chainSource === 'auto' ? 'picked automatically from that list' : 'from GEMINI_MODEL_FALLBACKS'})`
      : `  Fallback chain: none (${report.chainSource === 'disabled' ? 'disabled by GEMINI_MODEL_FALLBACKS=none' : 'this key lists no other stable Flash model'})`,
  );
  for (const model of chain) {
    const timing = await timeGenerate(mk(o.apiVersion), model, tiny, callCap);
    report.alternatives.push({ model, timing });
    say(`  ${model.padEnd(24)} ${timing.ok ? 'OK ' : 'FAIL'} ${timingLine(timing)}`);
  }

  // 4. The REAL plan request with different thinking settings.
  if (!o.skipPlan) {
    say('\n[4/6] The real plan request (this app’s prompt + schema) with different thinking settings');
    const now = new Date();
    const deadline = new Date(now.getTime() + 35 * 86_400_000).toISOString().slice(0, 10);
    const job = preparePlanJob(
      {
        goal: 'Pass the AWS Certified Cloud Practitioner exam',
        deadlineDate: deadline,
        deadlineTime: '10:00',
        timezone: 'UTC',
        level: 'Beginner',
        hoursPerDay: 1.5,
        workingDays: [1, 2, 3, 4, 5, 6],
        constraints: 'I study in the evenings.',
        pace: 'Balanced',
        adjustment: 'none',
      },
      now,
    );
    const system = buildPlanSystemInstruction({
      intake: job.intake,
      todayKey: job.todayKey,
      deadlineUtc: job.deadlineUtc,
      capacity: job.capacity,
      allowedDates: job.allowedDates,
    });
    const schema = buildPlanJsonSchema(job.allowedDates);
    const auto = planThinkingConfig(report.model, 'auto');
    type Variant = { variant: 'A' | 'B' | 'C'; label: string; thinking: ThinkingConfig | null };
    const variants: Variant[] = [
      {
        variant: 'A' as const,
        label: 'before the fix: includeThoughts only (model decides how long to think)',
        thinking: planThinkingConfig(report.model, 'default') ?? null,
      },
      { variant: 'B' as const, label: 'the fix: low thinking level', thinking: auto ?? null },
      { variant: 'C' as const, label: 'no thinkingConfig at all', thinking: null },
    ].filter(
      (v, i, all) => all.findIndex((w) => JSON.stringify(w.thinking) === JSON.stringify(v.thinking)) === i,
    );
    const ai = mk(o.apiVersion);
    for (const v of variants) {
      const timing = await timeStream(
        ai,
        report.model,
        {
          contents: [{ role: 'user', parts: buildPlanUserParts(job.intake) }],
          config: {
            systemInstruction: system,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            ...(v.thinking ? { thinkingConfig: v.thinking } : {}),
          },
        },
        planCap,
        true,
      );
      report.plan.push({ ...v, timing });
      say(`  ${v.variant} ${v.label}\n    ${timing.ok ? 'OK ' : 'FAIL'} ${timingLine(timing)}`);
    }
  }

  // 5. The complete flow through this app's own /api/plan route.
  if (!o.skipFlow && !o.skipPlan) {
    say('\n[5/6] The complete planning flow through this app’s /api/plan route (SSE)');
    report.flow = await runFlow(o, report.model, say);
    say(
      `  ${report.flow.ok ? 'OK ' : 'FAIL'} ${sec(report.flow.ms)}${report.flow.error ? ` · ${report.flow.error.code}: ${report.flow.error.message}` : ''}`,
    );
    for (const d of report.flow.error?.details ?? []) say(`    · ${d}`);
  }

  report.verdict = diagnose(report, o.firstChunkTimeoutMs ?? 30_000);
  say('\n[6/6] Diagnosis');
  for (const line of report.verdict) say(`  ${line}`);
  return report;
}

async function runFlow(
  o: DiagOptions,
  model: string,
  say: (l: string) => void,
): Promise<NonNullable<DiagReport['flow']>> {
  const logLines: string[] = [];
  const origLog = console.log;
  // Capture the app's own structured log lines (already redacted) so they can be shown.
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('{"type":"ai_')) logLines.push(redactSecrets(line, [o.apiKey]));
    else origLog(...args);
  };
  const events: { atMs: number; event: string; note?: string }[] = [];
  const t0 = performance.now();
  const app = createApp({
    env: {
      GEMINI_API_KEY: o.apiKey,
      GEMINI_MODEL: model,
      ALLOWED_ORIGINS: '',
      ...(o.apiVersion ? { GEMINI_API_VERSION: o.apiVersion } : {}),
    },
    ...(o.baseUrl
      ? { gemini: new GoogleGenAI({ apiKey: o.apiKey, httpOptions: { baseUrl: o.baseUrl } }) as never }
      : {}),
    tuning: {
      ...(o.firstChunkTimeoutMs ? { firstChunkTimeoutMs: o.firstChunkTimeoutMs } : {}),
      rateLimit: { windowMax: 1000, dayMax: 10000, windowSec: 600 },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  let error: ApiError | undefined;
  let ok = false;
  let usedModel: string | undefined;
  try {
    const deadline = new Date(Date.now() + 35 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(`http://127.0.0.1:${port}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Pass the AWS Certified Cloud Practitioner exam',
        deadlineDate: deadline,
        deadlineTime: '10:00',
        timezone: 'UTC',
        level: 'Beginner',
        hoursPerDay: 1.5,
        workingDays: [1, 2, 3, 4, 5, 6],
        constraints: 'I study in the evenings.',
        pace: 'Balanced',
      }),
    });
    if (!res.ok || !res.body) {
      error = (await res.json().catch(() => null)) as ApiError | undefined;
    } else {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const name = /^event:\s*(.+)$/m.exec(raw)?.[1];
          const data = /^data:\s*(.+)$/m.exec(raw)?.[1];
          if (!name || !data) continue;
          const ev = { event: name, data: JSON.parse(data) } as PlanStreamEvent;
          const atMs = performance.now() - t0;
          if (ev.event === 'status')
            events.push({
              atMs,
              event: `status:${ev.data.phase}`,
              ...(/Trying /.test(ev.data.message) ? { note: ev.data.message } : {}),
            });
          else if (ev.event === 'milestone')
            events.push({
              atMs,
              event: 'milestone',
              note: `#${ev.data.index + 1} ${ev.data.milestone.title}`,
            });
          else if (ev.event === 'result') {
            ok = true;
            usedModel = ev.data.runs.at(-1)?.model;
            events.push({
              atMs,
              event: 'result',
              note: `${ev.data.plan.milestones.length} milestones, ${ev.data.checks.filter((c) => c.ok).length}/${ev.data.checks.length} code checks passed, written by ${usedModel ?? 'unknown'}`,
            });
          } else if (ev.event === 'error') {
            error = ev.data;
            events.push({ atMs, event: 'error', note: ev.data.code });
          } else events.push({ atMs, event: ev.event });
        }
      }
    }
  } finally {
    console.log = origLog;
    server.close();
  }
  for (const e of events.slice(0, 14))
    say(`    +${sec(e.atMs).padStart(7)}  ${e.event}${e.note ? ` — ${e.note}` : ''}`);
  for (const l of logLines) say(`    log ${l}`);
  return {
    ok,
    ms: performance.now() - t0,
    model: usedModel,
    fellBack: events.some((e) => /Trying /.test(e.note ?? '')),
    events,
    error,
    logLines,
  };
}

// ───────────────────────────── verdict (pure; unit-tested) ─────────────────────────────

/** Turn the measurements into plain-language conclusions. */
export function diagnose(r: DiagReport, firstChunkLimitMs = 30_000): string[] {
  const out: string[] = [];
  const okReach = r.reach.filter((x) => x.ok);
  const stalledNet = (t: StreamTiming) => !t.ok && t.stalledIn === 'waiting-for-http-response' && t.timedOut;

  const listUnavailable = r.reach.find(
    (x) => !x.ok && x.status !== undefined && (x.status >= 500 || x.status === 429),
  );
  if (okReach.length === 0 && listUnavailable) {
    // Google answered, just not with data. Say that, then keep diagnosing with the remaining measurements.
    out.push(
      `GOOGLE UNAVAILABLE: even listing models returned HTTP ${listUnavailable.status}${listUnavailable.reason ? ` (${listUnavailable.reason})` : ''}. The API is reachable but temporarily overloaded or down; this is not your key, network or this app.`,
    );
  } else if (okReach.length === 0) {
    const auth = r.reach.find((x) => x.status === 400 || x.status === 401 || x.status === 403);
    if (auth) {
      out.push(
        `KEY PROBLEM: Google answered but rejected the request (HTTP ${auth.status}${auth.reason ? `: ${auth.reason}` : ''}). Check GEMINI_API_KEY (and that the Gemini API is enabled for it).`,
      );
    } else {
      out.push(
        `NETWORK PROBLEM: this machine could not get an HTTP response from ${r.env.baseUrl} (${r.reach.map((x) => x.error).filter(Boolean)[0] ?? 'no response'}). The model name and your code are not the cause.`,
      );
      out.push(
        'Check: VPN / corporate proxy (set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 if you need one), firewall, DNS, and IPv6 (try NODE_OPTIONS=--dns-result-order=ipv4first).',
      );
      if (r.env.proxies.length)
        out.push(
          `Proxy variables are set here (${r.env.proxies.join(', ')}); Node's built-in fetch only honours them when NODE_USE_ENV_PROXY=1.`,
        );
    }
    return out;
  }

  const listed = r.reach.find((x) => x.ok && x.modelListed !== undefined);
  if (listed && listed.modelListed === false) {
    out.push(
      `MODEL NOT AVAILABLE: ${r.model} is not in the model list for this key. Set GEMINI_MODEL to one that is (leave it empty to auto-pick).`,
    );
  } else if (listed?.methods && !listed.methods.includes('generateContent')) {
    out.push(`MODEL CAN'T GENERATE: ${r.model} does not list generateContent for this key.`);
  }
  const betaRuns = r.minimal.filter((m) => m.version === 'v1beta');
  if (
    r.minimal.some((m) => m.version === 'v1' && !m.timing.ok) &&
    betaRuns.length &&
    betaRuns.every((m) => m.timing.ok)
  ) {
    out.push('API VERSION: requests work on v1beta but fail on v1. Set GEMINI_API_VERSION=v1beta in .env.');
  }
  if (r.minimal.length && r.minimal.every((m) => stalledNet(m.timing))) {
    out.push(
      'NETWORK PROBLEM: the host is reachable for listing models, but model requests never get an HTTP response. Check proxy / firewall rules for POST requests and streaming responses.',
    );
  }

  const slowMinimal = r.minimal.find(
    (m) => m.timing.ok && (m.timing.firstChunkMs ?? m.timing.totalMs) > 10_000,
  );
  if (slowMinimal)
    out.push(
      `SLOW MODEL: even a one-word request took ${sec(slowMinimal.timing.firstChunkMs ?? slowMinimal.timing.totalMs)}. That is Google-side latency for this model/region/quota, not this app.`,
    );

  const slow = (t: StreamTiming) => !t.ok || (t.firstChunkMs ?? t.totalMs) > firstChunkLimitMs;
  const A = r.plan.find((p) => p.variant === 'A');
  const B = r.plan.find((p) => p.variant === 'B');
  const C = r.plan.find((p) => p.variant === 'C');
  if (A && B && slow(A.timing) && !slow(B.timing)) {
    out.push(
      `ROOT CAUSE (thinking latency): with the model's default thinking the first output took ${A.timing.ok ? sec(A.timing.firstChunkMs) : `longer than ${sec(A.timing.totalMs)}`} (limit ${sec(firstChunkLimitMs)}), but with a low thinking level it took ${sec(B.timing.firstChunkMs)}. This app now requests the low level for planning, so the timeout should be gone.`,
    );
  } else if (A && slow(A.timing) && C && !slow(C.timing)) {
    out.push(
      'THINKING SETTINGS: the request is only fast without any thinkingConfig. Set GEMINI_THINKING_LEVEL=default or use a model that supports it.',
    );
  } else if (r.plan.length && r.plan.every((p) => slow(p.timing)) && r.minimal.every((m) => m.timing.ok)) {
    const rejected = r.plan.find((p) => p.timing.status === 400);
    if (rejected)
      out.push(
        `REQUEST REJECTED: Google answered HTTP 400 for the plan request: ${rejected.timing.reason ?? 'no reason given'}. This is the plan schema/prompt, not timing.`,
      );
    else
      out.push(
        'PLAN REQUEST SLOW: tiny requests are fast, but the plan request is slow with every thinking setting. The cause is the request itself (large schema / long prompt / quota). Try GEMINI_MODEL=<another flash model>.',
      );
  }

  // Google answered 503: temporary capacity trouble on ITS side. Say so, and say whether the fallback chain works.
  const all503 = [...r.minimal.map((m) => m.timing), ...r.plan.map((p) => p.timing)].find(
    (t) => t.status === 503,
  );
  if (all503) {
    out.push(
      `OVERLOADED: Google answered HTTP 503 for ${r.model} (${all503.reason ?? 'UNAVAILABLE'}). That is temporary capacity trouble on Google's side, not your key, your network or this app.`,
    );
    const working = r.alternatives.find((a) => a.timing.ok);
    if (working) {
      out.push(
        `FALLBACK READY: ${working.model} answered in ${sec(working.timing.totalMs)} while ${r.model} was unavailable. The app switches to it automatically (after one retry on ${r.model}).`,
      );
    } else if (r.alternatives.length > 0) {
      out.push(
        `NO WORKING ALTERNATIVE right now: ${r.alternatives.map((a) => `${a.model} (${a.timing.status ? `HTTP ${a.timing.status}` : (a.timing.error ?? 'no answer')})`).join(', ')}. Wait a few minutes and re-run, or set GEMINI_MODEL_FALLBACKS to other models from the list above.`,
      );
    } else {
      out.push(
        r.chainSource === 'disabled'
          ? 'NO ALTERNATIVE: fallbacks are disabled (GEMINI_MODEL_FALLBACKS=none).'
          : listUnavailable
            ? 'NO ALTERNATIVE KNOWN: the model list itself is unavailable right now, so alternatives could not be chosen. Set GEMINI_MODEL_FALLBACKS=<model>,<model> in .env to name them yourself.'
            : 'NO ALTERNATIVE MODEL: this key lists no other stable Flash model. Set GEMINI_MODEL_FALLBACKS to a model you can use.',
      );
    }
  }

  if (r.flow) {
    if (r.flow.ok)
      out.push(
        `FULL FLOW OK: the planning flow of this app finished in ${sec(r.flow.ms)} and passed the code checks${r.flow.model ? `, written by ${r.flow.model}${r.flow.fellBack ? ' after falling back from the primary model' : ''}` : ''}.`,
      );
    else
      out.push(
        `FULL FLOW FAILED: ${r.flow.error?.code ?? 'unknown'} — ${r.flow.error?.message ?? 'see the log lines above'}`,
      );
  }
  if (out.length === 0) out.push('No problem found: connection, model and requests all behaved normally.');
  return out;
}
