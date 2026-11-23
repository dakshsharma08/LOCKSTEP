/**
 * Server configuration, read from environment variables ONCE when the app is created.
 *
 * Why (for learners): reading env in one place means we can see every knob at a
 * glance, tests can pass their own `env` object, and secrets (the Gemini key,
 * the Supabase service key) live in exactly one object that is never logged or
 * sent anywhere except to the service it belongs to.
 */

export interface ServerConfig {
  /** Secret. Only ever handed to the @google/genai constructor. */
  geminiApiKey: string | null;
  /** Pinned default model (GEMINI_MODEL); null → auto-pick via models.list(). */
  model: string | null;
  /** Optional "Pro" model used for coach replanning (GEMINI_MODEL_HEAVY). */
  heavyModel: string | null;
  /** GEMINI_MODEL_FALLBACKS: comma-separated alternatives, "none" to disable, empty = pick automatically. */
  fallbackModels: string | null;
  /** GEMINI_API_VERSION (v1 | v1beta | v1alpha). null = the SDK's own default. */
  apiVersion: string | null;
  /** GEMINI_THINKING_LEVEL for plan generation (see gemini/thinking.ts). */
  planThinking: string | null;
  allowedOrigins: string[];
  upstash: { url: string; token: string } | null;
  supabase: { url: string; serviceKey: string } | null;
}

function clean(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const upstashUrl = clean(env.UPSTASH_REDIS_REST_URL);
  const upstashToken = clean(env.UPSTASH_REDIS_REST_TOKEN);
  const supabaseUrl = clean(env.SUPABASE_URL) ?? clean(env.VITE_SUPABASE_URL);
  const supabaseKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  return {
    geminiApiKey: clean(env.GEMINI_API_KEY),
    model: clean(env.GEMINI_MODEL),
    heavyModel: clean(env.GEMINI_MODEL_HEAVY),
    fallbackModels: clean(env.GEMINI_MODEL_FALLBACKS),
    apiVersion: /^v1(alpha|beta)?$/.test(clean(env.GEMINI_API_VERSION) ?? '')
      ? clean(env.GEMINI_API_VERSION)
      : null,
    planThinking: clean(env.GEMINI_THINKING_LEVEL),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    upstash: upstashUrl && upstashToken ? { url: upstashUrl.replace(/\/+$/, ''), token: upstashToken } : null,
    supabase:
      supabaseUrl && supabaseKey ? { url: supabaseUrl.replace(/\/+$/, ''), serviceKey: supabaseKey } : null,
  };
}

/**
 * Timing and limit knobs. The defaults are the product spec; tests shrink them
 * (e.g. 1 ms backoff) so the suite stays fast without changing any logic.
 */
export interface AiTuning {
  /** Non-streaming Gemini calls. */
  callTimeoutMs: number;
  /** Streaming: max wait for the first chunk… */
  firstChunkTimeoutMs: number;
  /** …and between two chunks… */
  chunkIdleTimeoutMs: number;
  /** …and for the whole stream. */
  streamTotalTimeoutMs: number;
  /**
   * The plan repair call rewrites the WHOLE plan (not streamed), so it needs a plan-sized limit:
   * gemini-3.5-flash took ~78 s to write a plan in real diagnostics.
   */
  repairTimeoutMs: number;
  /**
   * Hard limit for one /api/plan request: every model attempt and the repair together. Kept well under
   * Vercel's maxDuration (300 s in vercel.json) so the platform never kills a request half way.
   */
  planBudgetMs: number;
  /** Don't START another model attempt or the repair with less than this much of planBudgetMs left. */
  minAttemptMs: number;
  /** Retries after the first attempt for 429/500/503. */
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** SSE comment interval that keeps proxies from closing idle connections. */
  keepAliveMs: number;
  /** How long the auto-picked model name is cached. */
  modelCacheMs: number;
  rateLimit: { windowSec: number; windowMax: number; dayMax: number };
  /** Limits for trying alternative models when the primary is temporarily unavailable (see gemini/fallback.ts). */
  modelFallback: { primaryRetries: number; maxAttempts: number; maxFallbacks: number };
}

export const DEFAULT_TUNING: AiTuning = {
  callTimeoutMs: 30_000,
  firstChunkTimeoutMs: 30_000,
  chunkIdleTimeoutMs: 30_000,
  streamTotalTimeoutMs: 120_000,
  repairTimeoutMs: 120_000,
  planBudgetMs: 270_000,
  minAttemptMs: 30_000,
  maxRetries: 2,
  retryBaseMs: 800,
  retryMaxMs: 6_000,
  keepAliveMs: 15_000,
  modelCacheMs: 60 * 60 * 1000,
  rateLimit: { windowSec: 10 * 60, windowMax: 20, dayMax: 150 },
  // 1 call + 1 retry on the primary, then at most 2 alternatives: 4 upstream calls in the worst case.
  modelFallback: { primaryRetries: 1, maxAttempts: 4, maxFallbacks: 2 },
};

export type TuningOverrides = Partial<Omit<AiTuning, 'rateLimit' | 'modelFallback'>> & {
  rateLimit?: Partial<AiTuning['rateLimit']>;
  modelFallback?: Partial<AiTuning['modelFallback']>;
};

export function resolveTuning(over: TuningOverrides = {}): AiTuning {
  return {
    ...DEFAULT_TUNING,
    ...over,
    rateLimit: { ...DEFAULT_TUNING.rateLimit, ...over.rateLimit },
    modelFallback: { ...DEFAULT_TUNING.modelFallback, ...over.modelFallback },
  };
}
