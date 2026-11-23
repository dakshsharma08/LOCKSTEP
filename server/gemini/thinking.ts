/**
 * How much Gemini "thinks" before it answers, for plan generation.
 *
 * Why (for learners): Gemini 2.5+ models can reason silently before writing the first
 * visible word. That is great for hard problems and terrible for latency: at the default
 * level a model may think for a long time and send NOTHING, so a "no first chunk within
 * 30 s" timeout fires even though Google is working fine.
 * A LOCKSTEP plan is a constrained, schema-checked extraction task (dates come from an
 * allowed list and our own code validates the result), so it does not need deep reasoning.
 * We therefore ask for a LOW level explicitly instead of inheriting the model's default.
 *
 *   • Gemini 3.x models  → `thinkingLevel` (MINIMAL | LOW | MEDIUM | HIGH)
 *   • Gemini 2.5 models  → `thinkingBudget` (a token count)
 *   • aliases / unknown  → we don't guess; only `includeThoughts` (as before)
 *
 * Operators can override with GEMINI_THINKING_LEVEL=minimal|low|medium|high|default
 * (`default` = let the model decide, the old behaviour).
 */
import { ThinkingLevel, type ThinkingConfig } from '@google/genai';
import { AppError } from '../lib/errors';
import { supportsThinking } from './client';

export type PlanThinking = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'default';
const SETTINGS: readonly PlanThinking[] = ['auto', 'minimal', 'low', 'medium', 'high', 'default'];

export function parsePlanThinking(raw: string | null | undefined): PlanThinking {
  const v = raw?.trim().toLowerCase();
  return (SETTINGS as readonly string[]).includes(v ?? '') ? (v as PlanThinking) : 'auto';
}

export type ModelFamily = 'gemini-3+' | 'gemini-2.5' | 'unknown';

/** Aliases such as `gemini-flash-latest` can point at any generation, so they are "unknown". */
export function modelFamily(model: string): ModelFamily {
  if (/latest/.test(model)) return 'unknown';
  const m = /gemini-(\d+)(?:\.(\d+))?/.exec(model);
  if (!m) return 'unknown';
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  if (major >= 3) return 'gemini-3+';
  if (major === 2 && minor >= 5) return 'gemini-2.5';
  return 'unknown';
}

const LEVELS: Record<Exclude<PlanThinking, 'auto' | 'default'>, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};
const BUDGETS: Record<Exclude<PlanThinking, 'auto' | 'default'>, number> = {
  minimal: 128,
  low: 1024,
  medium: 4096,
  high: 8192,
};

/** The thinkingConfig to send for a plan request, or undefined if the model can't think. */
export function planThinkingConfig(
  model: string,
  setting: PlanThinking = 'auto',
): ThinkingConfig | undefined {
  if (!supportsThinking(model)) return undefined;
  // Thought SUMMARIES stream early, which also shows Gemini is alive (we never show or store them).
  const base: ThinkingConfig = { includeThoughts: true };
  if (setting === 'default') return base;
  const level = setting === 'auto' ? 'low' : setting;
  switch (modelFamily(model)) {
    case 'gemini-3+':
      return { ...base, thinkingLevel: LEVELS[level] };
    case 'gemini-2.5':
      return { ...base, thinkingBudget: BUDGETS[level] };
    default:
      return base;
  }
}

/**
 * If Google answers 400 and blames thinking ("Unknown name thinkingLevel", "thinking level not
 * supported…"), retry with progressively plainer configs instead of failing the whole plan.
 */
export function thinkingFallbacks(cfg: ThinkingConfig | undefined): (ThinkingConfig | undefined)[] {
  if (!cfg) return [undefined];
  const out: (ThinkingConfig | undefined)[] = [cfg];
  if (cfg.thinkingLevel !== undefined || cfg.thinkingBudget !== undefined)
    out.push({ includeThoughts: true });
  out.push(undefined);
  return out;
}

/**
 * True when Google rejected the request with HTTP 400 AND blamed the thinking settings
 * ("Unknown name thinkingLevel", "thinking level not supported…"). `streamGemini` has already
 * mapped the SDK error, so we read the details it kept: "Gemini status 400" + "Google said: …".
 */
export function isThinkingRejection(err: unknown): boolean {
  if (!(err instanceof AppError) || !err.details) return false;
  return (
    err.details.some((d) => /status 400/.test(d)) && err.details.some((d) => /^Google said:.*think/i.test(d))
  );
}
