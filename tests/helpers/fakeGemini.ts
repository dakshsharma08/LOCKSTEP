/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies from a fake server are untyped by nature */
/**
 * A local fake of Google's Gemini REST API, for TESTS ONLY (never imported by the app).
 *
 * It speaks real HTTP + Server-Sent Events on a real socket, so the real @google/genai SDK
 * can be pointed at it with `httpOptions.baseUrl`. That lets tests reproduce the failure
 * modes that matter for "No first chunk within 30 s":
 *   • HTTP headers that arrive late, or never          (a network problem)
 *   • headers right away but the first chunk very late (a model that "thinks" silently)
 *   • HTTP 400/403 errors with Google's JSON error body
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  /** "v1" or "v1beta" */
  version: string;
  model: string;
  stream: boolean;
  /** Parsed JSON body (POST), else null. */
  body: Record<string, any> | null;
  hasKey: boolean;
}

export interface FakeReply {
  /** Reply with Google's JSON error shape instead of an answer. */
  error?: { status: number; message: string; code?: string };
  /** Never answer at all (a black-holed connection). */
  neverRespond?: boolean;
  /** Wait this long before sending the HTTP headers. */
  headersDelayMs?: number;
  /** After the headers, wait this long before the first SSE chunk (silent "thinking"). */
  firstChunkDelayMs?: number;
  /** Send a thought-summary chunk (not visible text) this long after the headers, before the text. */
  thoughtAfterMs?: number;
  /** Override the answer text. Default: a valid plan for plan requests, else "OK". */
  text?: string;
}

export interface FakeGemini {
  baseUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A valid plan for the dates/capacity the app put into its request (so the app's own checks pass). */
export function fixturePlan(body: Record<string, any> | null): Record<string, unknown> {
  const enumDates: string[] =
    body?.generationConfig?.responseJsonSchema?.properties?.milestones?.items?.properties?.targetDate?.enum ??
    [];
  const dates = [...enumDates].sort();
  const pick = (f: number) =>
    dates[Math.min(dates.length - 1, Math.max(0, Math.round(f * (dates.length - 1))))]!;
  const sys: string = (body?.systemInstruction?.parts ?? []).map((p: { text: string }) => p.text).join('\n');
  const cap = Number(/CAPACITY:\s*([0-9.]+)\s*hours/i.exec(sys)?.[1] ?? 40);
  const per = Math.max(1, Math.floor((cap * 0.7) / 4));
  const titles = [
    'Map the exam domains',
    'Core services deep-dive',
    'Practice question sprint',
    'Full mock exam + review',
  ];
  return {
    goal: 'Fixture goal',
    deadline: 'fixture',
    timezone: 'UTC',
    feasibility: 'Achievable',
    feasibilityReason: 'Fixture: fits within 70% of the available hours.',
    totalEstimatedHours: per * 4,
    fullScopeHours: 0,
    milestones: titles.map((title, i) => ({
      id: `m${i + 1}`,
      title,
      description: `Fixture milestone ${i + 1}.`,
      targetDate: pick((i + 1) / 4),
      estimatedHours: per,
      difficulty: 'Medium',
      tasks: [
        { id: `m${i + 1}-t1`, title: `${title}: A`, estimatedMinutes: 60 },
        { id: `m${i + 1}-t2`, title: `${title}: B`, estimatedMinutes: 45 },
      ],
    })),
    risks: ['Fixture risk'],
    recoveryStrategy: 'Fixture recovery.',
    dailyRitual: 'Fixture ritual.',
  };
}

export async function startFakeGemini(
  decide: (r: FakeRequest) => FakeReply | void,
  opts: { models?: string[] } = {},
): Promise<FakeGemini> {
  const requests: FakeRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const models = opts.models ?? ['gemini-3.8-flash'];

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/(v1[a-z0-9]*)\/models(?:\/([^/:]+):(generateContent|streamGenerateContent))?$/.exec(
      url.pathname,
    );
    if (!m) {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const fr: FakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      version: m[1]!,
      model: m[2] ?? '',
      stream: m[3] === 'streamGenerateContent',
      body: raw ? JSON.parse(raw) : null,
      hasKey: !!req.headers['x-goog-api-key'],
    };
    requests.push(fr);
    const reply = decide(fr) ?? {};
    if (reply.neverRespond) return; // hang: the socket stays open, nothing is sent
    if (reply.headersDelayMs) await wait(reply.headersDelayMs);
    if (res.destroyed) return;

    if (reply.error) {
      res.writeHead(reply.error.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: reply.error.status,
            message: reply.error.message,
            status: reply.error.code ?? 'INVALID_ARGUMENT',
          },
        }),
      );
      return;
    }
    if (!fr.model) {
      // GET /vX/models
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          models: models.map((n) => ({
            name: `models/${n}`,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          })),
        }),
      );
      return;
    }
    const isPlan = !!fr.body?.generationConfig?.responseJsonSchema;
    const text = reply.text ?? (isPlan ? JSON.stringify(fixturePlan(fr.body)) : 'OK');
    const usage = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
      thoughtsTokenCount: 0,
    };

    if (!fr.stream) {
      if (reply.firstChunkDelayMs) await wait(reply.firstChunkDelayMs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: usage,
        }),
      );
      return;
    }

    // Streaming: headers first (flushed immediately), then silence, then chunks.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const send = (parts: unknown[], last = false) =>
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, index: 0, ...(last ? { finishReason: 'STOP' } : {}) }], ...(last ? { usageMetadata: usage } : {}) })}\r\n\r\n`,
      );
    let elapsed = 0;
    if (reply.thoughtAfterMs !== undefined) {
      await wait(reply.thoughtAfterMs);
      elapsed = reply.thoughtAfterMs;
      if (res.destroyed) return;
      send([{ text: 'Thinking about the plan…', thought: true }]);
    }
    if (reply.firstChunkDelayMs) await wait(Math.max(0, reply.firstChunkDelayMs - elapsed));
    if (res.destroyed) return;
    const size = Math.ceil(text.length / 4);
    const pieces = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [text];
    pieces.forEach((p, i) => send([{ text: p }], i === pieces.length - 1));
    res.end();
  };

  const server: Server = createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
