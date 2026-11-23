/**
 * TEST-ONLY API server for Playwright E2E runs.
 *
 * It starts the real LOCKSTEP Express app and points its Gemini SDK client at a small LOCAL HTTP server
 * that answers with deterministic fixtures (real HTTP + Server-Sent Events, like Google). This file is
 * never used by `npm run dev`, `npm start` or the deployed app. The fake model is named
 * "gemini-e2e-mock" so evidence screenshots can't be mistaken for real Gemini output.
 *
 * Why a local server and not MSW: the app aborts a Gemini stream that stalls mid-answer, and with
 * MSW 3 on Node 22 aborting a mocked response body crashes the process (undici: assert(!this.aborted)).
 * A real socket behaves like Google does.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleGenAI } from '@google/genai';

process.env.GEMINI_API_KEY = 'e2e-fake-key-not-real';
process.env.GEMINI_MODEL = 'gemini-e2e-mock';
process.env.ALLOWED_ORIGINS = 'http://localhost:4173,http://localhost:5173';
// One fake alternative model, so the "stall → reset → next model" scenario can run in the browser.
process.env.GEMINI_MODEL_FALLBACKS = 'gemini-e2e-fallback';

/**
 * Scenario marker: a goal containing this text makes the primary fake model stream part of a STALE plan and
 * then go silent; the app must abandon it, send `reset`, and get the plan from gemini-e2e-fallback.
 */
const STALL_MARKER = 'e2e-stall';
/** Scenario marker: Google rejects the plan request with HTTP 400 (to test the error card). */
const REJECT_MARKER = 'e2e-reject';

/** /v1beta/models, /v1beta/models/<model>:generateContent, /v1beta/models/<model>:streamGenerateContent */
const ROUTE = /^\/(v1[a-z0-9]*)\/models(?:\/([^/:]+):(generateContent|streamGenerateContent))?$/;

type Body = {
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: {
    responseJsonSchema?: {
      properties?: Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>;
    };
  };
};

/** The dates the app allowed: the prompt line "Allowed milestone dates …" (the schema has no date list). */
function allowedDates(body: Body): string[] {
  const sys = body.systemInstruction?.parts.map((p) => p.text).join('\n') ?? '';
  const line = /Allowed milestone dates[^\n]*/.exec(sys)?.[0] ?? sys;
  return [...new Set(line.match(/\d{4}-\d{2}-\d{2}/g) ?? [])].sort();
}

function capacity(body: Body): number {
  const sys = body.systemInstruction?.parts.map((p) => p.text).join('\n') ?? '';
  const m = /capacity[^0-9]{0,40}([0-9]+(?:\.[0-9]+)?)\s*h/i.exec(sys);
  return m ? Number(m[1]) : 40;
}

function fixturePlan(body: Body) {
  const dates = allowedDates(body).filter((d) => d > new Date().toISOString().slice(0, 10));
  const pick = (f: number) =>
    dates[Math.min(dates.length - 1, Math.max(0, Math.round(f * (dates.length - 1))))]!;
  const cap = capacity(body);
  const per = Math.max(1, Math.floor((cap * 0.7) / 4));
  const titles = [
    'Map the exam domains',
    'Core services deep-dive',
    'Practice question sprint',
    'Full mock exam + review',
  ];
  return {
    goal: 'E2E fixture goal',
    deadline: 'fixture',
    timezone: 'fixture',
    feasibility: 'Achievable',
    feasibilityReason: 'Fixture: fits within 70% of the available hours.',
    totalEstimatedHours: per * 4,
    milestones: titles.map((title, i) => ({
      id: `m${i + 1}`,
      title,
      description: `Fixture milestone ${i + 1} for the end-to-end test.`,
      targetDate: pick((i + 1) / 4),
      estimatedHours: per,
      difficulty: i === 3 ? 'Hard' : 'Medium',
      tasks: [
        { id: `m${i + 1}-t1`, title: `${title}: part A`, estimatedMinutes: 60 },
        { id: `m${i + 1}-t2`, title: `${title}: part B`, estimatedMinutes: 45 },
      ],
    })),
    risks: ['Fixture risk: busy weeks'],
    recoveryStrategy: 'Fixture: move the practice sprint one day later.',
    dailyRitual: 'Fixture: 25 focused minutes after dinner.',
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream `text` as SSE chunks (180 characters, one every 60 ms), like Google's streamGenerateContent.
 * stallAfter: send only that many chunks, then go silent with the connection open (the app's idle limit
 * ends it by aborting the request). firstDelayMs: wait this long before the first chunk.
 */
async function streamText(
  req: IncomingMessage,
  res: ServerResponse,
  text: string,
  opts: { stallAfter?: number; firstDelayMs?: number } = {},
) {
  const parts = text.match(/.{1,180}/gs) ?? [text];
  let gone = false;
  req.on('close', () => (gone = true));
  res.on('close', () => (gone = true));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
  for (let i = 0; i < parts.length; i++) {
    await wait(i === 0 && opts.firstDelayMs ? opts.firstDelayMs : 60);
    if (gone) return;
    if (opts.stallAfter !== undefined && i >= opts.stallAfter) return; // silence: no more chunks, no end
    const last = i === parts.length - 1;
    res.write(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: parts[i] }] },
            index: 0,
            ...(last ? { finishReason: 'STOP' } : {}),
          },
        ],
        ...(last ? { usageMetadata: { totalTokenCount: 1234 } } : {}),
        modelVersion: 'gemini-e2e-mock',
      })}\r\n\r\n`,
    );
  }
  res.end();
}

function sendJson(res: ServerResponse, obj: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
}

/** One non-streamed answer whose text is `obj` as JSON. */
function answer(res: ServerResponse, obj: unknown) {
  sendJson(res, {
    candidates: [
      { content: { role: 'model', parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP', index: 0 },
    ],
    usageMetadata: { totalTokenCount: 120 },
    modelVersion: 'gemini-e2e-mock',
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = ROUTE.exec(url.pathname);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!route) {
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end('{"error":{"code":404,"status":"NOT_FOUND"}}');
    return;
  }
  const [, , model, method] = route;

  if (!model) {
    // The app lists the key's models (model choice, image discovery). Only the e2e model exists.
    sendJson(res, {
      models: [{ name: 'models/gemini-e2e-mock', supportedGenerationMethods: ['generateContent'] }],
    });
    return;
  }

  const body = (raw ? JSON.parse(raw) : {}) as Body & { tools?: unknown };
  if (method === 'streamGenerateContent') {
    if (raw.includes(REJECT_MARKER)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: "Invalid value at 'generation_config.response_mime_type'.",
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: [
                  { field: 'generation_config.response_mime_type', description: 'Invalid value.' },
                ],
              },
            ],
          },
        }),
      );
      return;
    }
    const plan = fixturePlan(body);
    if (!raw.includes(STALL_MARKER)) return streamText(req, res, JSON.stringify(plan));
    if (model === 'gemini-e2e-fallback') {
      // The alternative: a short pause first, so the browser test can see the cleared preview.
      return streamText(req, res, JSON.stringify(plan), { firstDelayMs: 1500 });
    }
    // The primary: part of a STALE plan (feasibility + the first two milestones), then silence.
    const stale = {
      ...plan,
      feasibility: 'Tight',
      feasibilityReason: 'STALE reason from the model that stalled.',
      milestones: plan.milestones.map((m) => ({ ...m, title: `STALE ${m.title}` })),
    };
    const text = JSON.stringify(stale);
    return streamText(req, res, text, { stallAfter: Math.ceil(text.indexOf('"id":"m3"') / 180) });
  }

  const keys = Object.keys(body.generationConfig?.responseJsonSchema?.properties ?? {});
  if (keys.includes('line')) return answer(res, { line: 'Fixture line: one focused session today.' });
  if (keys.includes('summary')) return answer(res, { summary: 'Fixture summary: steady week.' });
  if (keys.includes('milestones')) return answer(res, fixturePlan(body));
  sendJson(res, {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'Fixture coach reply: you are on track.' }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { totalTokenCount: 80 },
  });
}

const fakeGemini = createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
await new Promise<void>((r) => fakeGemini.listen(0, '127.0.0.1', r));
const geminiBase = `http://127.0.0.1:${(fakeGemini.address() as AddressInfo).port}`;

const { createApp } = await import('../server/app');
const port = Number(process.env.PORT) || 8787;
createApp({
  gemini: new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { baseUrl: geminiBase },
  }) as never,
  // chunkIdleTimeoutMs: 1.5 s instead of 30 s so the stall scenario is quick (normal chunks come every 60 ms).
  // Cooldowns off: every browser test is an independent scenario against this ONE shared server, so a model
  // that "failed" in one test must not be skipped in the next (cooldowns are tested in cooldown.test.ts).
  tuning: {
    rateLimit: { windowMax: 1000, dayMax: 10000 },
    chunkIdleTimeoutMs: 1500,
    cooldown: { baseMs: 0 },
  },
}).listen(port, () => console.log(`E2E mock API (fixtures, NOT real Gemini) on :${port}`));
