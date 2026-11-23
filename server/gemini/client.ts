/**
 * The Gemini client and model selection.
 *
 * Why (for learners):
 * - `GeminiLike` is the small slice of the @google/genai SDK we actually use.
 *   The real `GoogleGenAI` object fits it, and tests could pass a fake. (Our
 *   integration tests use the REAL SDK and mock the network with MSW instead.)
 * - Which model plans (see chooseDefaultModel): GEMINI_MODEL if set; otherwise the
 *   default `gemini-3.1-flash-lite` if THIS key lists it (`models.list()`, cached for
 *   an hour); otherwise the newest STABLE Flash model the key lists (`gemini-X.Y-flash`,
 *   no -lite/-preview/-exp/-image/-tts/-live); otherwise Google's alias `gemini-flash-latest`.
 */
import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type ListModelsParameters,
  type Model,
} from '@google/genai';
import { pickFallbacks } from './fallback';

export interface GeminiLike {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
    list(params?: ListModelsParameters): Promise<AsyncIterable<Model>>;
  };
}

/** The ONLY place the API key is used. It goes to the SDK, which sends it as the x-goog-api-key header. */
export function createGeminiClient(
  apiKey: string,
  opts: { apiVersion?: string; baseUrl?: string } = {},
): GeminiLike {
  return new GoogleGenAI({
    apiKey,
    ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}),
    ...(opts.baseUrl ? { httpOptions: { baseUrl: opts.baseUrl } } : {}),
  });
}

export const FALLBACK_MODEL = 'gemini-flash-latest';

/**
 * The default model for this submission: on the developer's key (2026-11-23) it wrote a valid plan and
 * the whole /api/plan flow passed in 7.3 s with 7/7 code checks, while the larger Flash models' free-tier
 * quotas were used up. GEMINI_MODEL overrides it; if a key does not list it, the newest stable Flash
 * model is used as before.
 */
export const DEFAULT_PRIMARY_MODEL = 'gemini-3.1-flash-lite';

/**
 * The model to use when GEMINI_MODEL is not set.
 *   names = the models this key lists, or null when listing failed.
 * Listing failed → the default (a verified model is a better bet than the moving alias, which can point
 * at a model whose quota is used up). Default listed → the default. Otherwise the newest stable Flash
 * model, else the alias.
 */
export function chooseDefaultModel(
  names: readonly string[] | null,
  defaultModel: string = DEFAULT_PRIMARY_MODEL,
): string {
  if (names === null) return defaultModel;
  if (names.some((n) => n.replace(/^models\//, '') === defaultModel)) return defaultModel;
  return pickNewestStableFlash(names) ?? FALLBACK_MODEL;
}

// gemini-3.8-flash, gemini-3-flash and pinned stable revisions like gemini-2.0-flash-001.
const STABLE_FLASH = /^gemini-(\d+)(?:\.(\d+))?-flash(?:-(\d{3}))?$/;

/** Pick the newest stable Flash model from a list of names ("models/…" prefixes allowed). */
export function pickNewestStableFlash(names: readonly string[]): string | null {
  let best: { name: string; key: [number, number, number] } | null = null;
  for (const raw of names) {
    const name = raw.replace(/^models\//, '');
    const m = STABLE_FLASH.exec(name);
    if (!m) continue;
    const key: [number, number, number] = [Number(m[1]), Number(m[2] ?? 0), m[3] ? Number(m[3]) : 1000];
    // The un-suffixed name (rank 1000) is the always-current alias of that version, so prefer it.
    if (!best || compareKey(key, best.key) > 0) best = { name, key };
  }
  return best?.name ?? null;
}

function compareKey(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Gemini 2.5+ and the moving aliases can "think"; older models reject thinkingConfig. */
export function supportsThinking(model: string): boolean {
  if (/latest/.test(model)) return true;
  const m = /gemini-(\d+)(?:\.(\d+))?/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 5);
}

export interface ModelResolverOptions {
  pinned: string | null;
  heavy: string | null;
  cacheMs: number;
  /** How long to remember a FAILED lookup before trying models.list() again. */
  failCacheMs?: number;
  nowMs?: () => number;
  /** Explicit alternatives (GEMINI_MODEL_FALLBACKS). null = pick automatically; [] = disabled. */
  fallbacks?: string[] | null;
  /** The model used when GEMINI_MODEL is not set and this key lists it (default DEFAULT_PRIMARY_MODEL). */
  defaultModel?: string;
  /** Most alternatives to return. */
  maxFallbacks?: number;
}

export class ModelResolver {
  private cached: { model: string; until: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly nowMs: () => number;

  constructor(
    private readonly gemini: GeminiLike,
    private readonly opts: ModelResolverOptions,
  ) {
    this.nowMs = opts.nowMs ?? Date.now;
  }

  get heavy(): string | null {
    return this.opts.heavy;
  }

  /**
   * Alternatives to try if `primary` is temporarily unavailable. Never throws.
   * Explicit list (GEMINI_MODEL_FALLBACKS) wins; otherwise they are picked from the models THIS key can
   * call, so a retired model can never end up in the chain. Looked up lazily (only after a failure).
   */
  async fallbacksFor(primary: string): Promise<string[]> {
    const max = this.opts.maxFallbacks ?? 2;
    const explicit = this.opts.fallbacks;
    if (explicit) return explicit.filter((m) => m !== primary).slice(0, max);
    if (explicit !== undefined && explicit !== null) return []; // an empty list = disabled
    try {
      return pickFallbacks(await this.listedNames(), primary, max);
    } catch {
      return [];
    }
  }

  /**
   * Load the key's model list in the background, so alternatives are already known if an outage hits.
   * Why: during heavy overload even models.list can return 503, which is the worst time to discover that
   * we don't know any alternatives. No-op if the list is cached (it is, in auto mode) or if the alternatives
   * are explicit / disabled. Costs at most one cached call per hour.
   */
  warmFallbacks(): void {
    const explicit = this.opts.fallbacks;
    if (explicit !== undefined && explicit !== null) return;
    if (this.names && this.names.until > this.nowMs()) return;
    void this.listedNames().catch(() => undefined);
  }

  /** The default model name. Never throws: falls back to the alias. */
  async resolve(): Promise<string> {
    if (this.opts.pinned) return this.opts.pinned;
    if (this.cached && this.cached.until > this.nowMs()) return this.cached.model;
    // If several requests arrive at once, they share one models.list() call.
    this.inflight ??= this.lookup().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async lookup(): Promise<string> {
    const defaultModel = this.opts.defaultModel ?? DEFAULT_PRIMARY_MODEL;
    let names: string[] | null;
    try {
      names = await this.listedNames();
    } catch {
      names = null; // listing failed (network, permissions, overload…)
    }
    const model = chooseDefaultModel(names, defaultModel);
    // A choice made without the list is re-checked sooner.
    const ttl = names === null ? (this.opts.failCacheMs ?? 5 * 60 * 1000) : this.opts.cacheMs;
    this.cached = { model, until: this.nowMs() + ttl };
    return model;
  }

  private names: { list: string[]; until: number } | null = null;
  private namesInflight: Promise<string[]> | null = null;

  /**
   * Model names this key can call (cached). Shared by the text-model choice and the
   * image-model discovery, so /api/health lists models at most once per cache period.
   */
  async listedNames(): Promise<string[]> {
    if (this.names && this.names.until > this.nowMs()) return this.names.list;
    this.namesInflight ??= this.fetchNames().finally(() => {
      this.namesInflight = null;
    });
    return this.namesInflight;
  }

  private async fetchNames(): Promise<string[]> {
    const names: string[] = [];
    // A timeout so /api/health can never hang on a slow listing.
    const pager = await this.gemini.models.list({
      config: { pageSize: 100, abortSignal: AbortSignal.timeout(10_000) },
    });
    for await (const model of pager) {
      const actions = model.supportedActions;
      if (model.name && (!actions || actions.includes('generateContent'))) names.push(model.name);
      if (names.length > 500) break;
    }
    this.names = { list: names, until: this.nowMs() + this.opts.cacheMs };
    return names;
  }
}
