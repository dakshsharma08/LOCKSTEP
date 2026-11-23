/**
 * Plan generation: intake → streamed preview events → validated PlanResult.
 *
 * The flow (for learners):
 *   1. preparePlanJob(): turn the wizard input into hard facts with plain code:
 *      deadline in UTC (DST-aware), today's date in the user's zone, capacity
 *      and the list of allowed milestone dates. Bad input stops here (400).
 *   2. generatePlan(): stream Gemini's JSON. While it streams, the incremental
 *      parser emits `feasibility` and one `milestone` event per finished
 *      milestone, so the UI fills in live.
 *   3. When the stream ends: JSON.parse + validatePlan. Hard errors (dates,
 *      order, working days, shape) trigger exactly ONE repair call. If that
 *      also fails → PLAN_INVALID. Going over capacity is NOT a hard error: the
 *      plan is still returned with feasibility "Unrealistic" and one-tap fixes.
 */
import type { PlanResult, PlanStreamEvent } from '../../shared/api';
import {
  allowedMilestoneDates,
  computeCapacity,
  suggestFixes,
  validatePlan,
  type Capacity,
  type Intake,
  type ValidationContext,
  type ValidationResult,
} from '../../shared/plan';
import { dayKey, localToUtcIso, type DstAdjustment } from '../../shared/time';
import { AppError } from '../lib/errors';
import { streamGemini, type CallContext } from './call';
import { runWithFallback, type ModelPool } from './fallback';
import { isThinkingRejection, planThinkingConfig, thinkingFallbacks, type PlanThinking } from './thinking';
import { buildPlanSystemInstruction, buildPlanUserParts } from './prompts';
import { repairPlan } from './repair';
import { buildPlanJsonSchema } from './schema';
import { PlanStreamParser, tryParseJson } from './streamParser';

export interface PlanJob {
  intake: Intake;
  deadlineUtc: string;
  dst: { adjustment: DstAdjustment; note?: string };
  todayKey: string;
  ctx: ValidationContext;
  capacity: Capacity;
  allowedDates: string[];
}

/** Compute the facts for a plan, or throw INVALID_INPUT. Pure apart from `now`. */
export function preparePlanJob(intake: Intake, now: Date): PlanJob {
  let conv: ReturnType<typeof localToUtcIso>;
  try {
    conv = localToUtcIso(intake.deadlineDate, intake.deadlineTime, intake.timezone);
  } catch {
    throw new AppError('INVALID_INPUT', "That deadline date or time isn't valid.", {
      details: ['deadlineDate/deadlineTime'],
    });
  }
  if (conv.utc.getTime() <= now.getTime()) {
    throw new AppError(
      'INVALID_INPUT',
      'That deadline has already passed. Pick a date and time in the future.',
      {
        details: [`deadline ${conv.iso} is not after now (${now.toISOString()})`],
      },
    );
  }
  const todayKey = dayKey(now, intake.timezone);
  const ctx: ValidationContext = {
    todayKey,
    deadlineUtc: conv.iso,
    timezone: intake.timezone,
    hoursPerDay: intake.hoursPerDay,
    workingDays: intake.workingDays,
  };
  const capacity = computeCapacity(ctx);
  const allowedDates = allowedMilestoneDates(capacity);
  if (allowedDates.length === 0) {
    throw new AppError(
      'INVALID_INPUT',
      'There are no working days between today and your deadline. Add a working day or move the deadline later.',
      { details: [`working days ${capacity.fromKey}…${capacity.toKey}: none usable`] },
    );
  }
  const dst: PlanJob['dst'] = { adjustment: conv.adjustment };
  if (conv.note) dst.note = conv.note;
  return { intake, deadlineUtc: conv.iso, dst, todayKey, ctx, capacity, allowedDates };
}

const INVALID_JSON_ERROR =
  'The response was not one complete, valid JSON object (it may have been cut off). Return the whole plan as a single JSON object.';

function validateText(
  text: string,
  ctx: ValidationContext,
): ValidationResult | { ok: false; errors: string[] } {
  const raw = tryParseJson(text);
  if (raw === undefined) return { ok: false, errors: [INVALID_JSON_ERROR] };
  return validatePlan(raw, ctx);
}

/**
 * Stream, validate and (at most once) repair a plan. Emits status / feasibility /
 * milestone events; returns the final result, or throws an AppError.
 */
export async function generatePlan(
  call: CallContext,
  job: PlanJob,
  pool: ModelPool,
  emit: (e: PlanStreamEvent) => void,
  opts: { thinking?: PlanThinking } = {},
): Promise<PlanResult> {
  const systemInstruction = buildPlanSystemInstruction({
    intake: job.intake,
    todayKey: job.todayKey,
    deadlineUtc: job.deadlineUtc,
    capacity: job.capacity,
    allowedDates: job.allowedDates,
  });
  const responseJsonSchema = buildPlanJsonSchema(job.allowedDates);

  emit({ event: 'status', data: { phase: 'thinking', message: 'Gemini is thinking about your plan…' } });

  /**
   * Stream the plan from ONE model. Plan generation asks for a LOW thinking level (see gemini/thinking.ts);
   * if Google rejects the thinking settings for this model/API version, retry once with plainer settings
   * rather than failing the whole plan (the rejection and the retry are both logged).
   */
  const streamFrom = async (model: string, retries: number): Promise<string> => {
    const configs = thinkingFallbacks(planThinkingConfig(model, opts.thinking));
    for (let i = 0; i < configs.length; i++) {
      const thinkingConfig = configs[i];
      const parser = new PlanStreamParser(); // a fresh parser per attempt
      try {
        return await streamGemini(call, {
          kind: 'plan',
          model,
          retries,
          request: {
            contents: [{ role: 'user', parts: buildPlanUserParts(job.intake) }],
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseJsonSchema,
              ...(thinkingConfig ? { thinkingConfig } : {}),
            },
          },
          onFirstChunk: () =>
            emit({ event: 'status', data: { phase: 'streaming', message: 'Writing your milestones…' } }),
          onText: (delta) => {
            for (const ev of parser.push(delta)) {
              if (ev.type === 'feasibility') {
                emit({
                  event: 'feasibility',
                  data: { feasibility: ev.feasibility, feasibilityReason: ev.feasibilityReason },
                });
              } else {
                emit({ event: 'milestone', data: { index: ev.index, milestone: ev.milestone } });
              }
            }
          },
        });
      } catch (err) {
        if (i < configs.length - 1 && isThinkingRejection(err)) {
          call.recorder.diag({
            event: 'thinking_fallback',
            kind: 'plan',
            model,
            from: thinkingConfig ?? null,
            to: configs[i + 1] ?? null,
          });
          continue;
        }
        throw err;
      }
    }
    throw new AppError('INTERNAL'); // unreachable: the last config either returns or throws
  };

  // The primary model first; if it is TEMPORARILY unavailable (503 "high demand", 429, 5xx, no answer),
  // a small, capped number of alternatives (see gemini/fallback.ts). Everything after this point
  // (validation, repair, feasibility) is identical whichever model produced the plan.
  const { value: text, model } = await runWithFallback(pool, streamFrom, {
    onFallback: ({ from, to, error }) => {
      call.recorder.diag({
        event: 'model_fallback',
        kind: 'plan',
        from,
        to,
        reason: error instanceof AppError ? (error.details ?? [error.message]).join(' | ') : 'unknown',
      });
      emit({
        event: 'status',
        data: { phase: 'thinking', message: `Gemini is busy right now. Trying ${to} instead…` },
      });
    },
  });

  emit({ event: 'status', data: { phase: 'validating', message: 'Checking dates, order and hours…' } });
  let validation = validateText(text, job.ctx);
  let repaired = false;

  if (!validation.ok) {
    const n = validation.errors.length;
    emit({
      event: 'status',
      data: { phase: 'repairing', message: `Fixing ${n} issue${n === 1 ? '' : 's'} in the plan…` },
    });
    const fixedText = await repairPlan(call, {
      model,
      systemInstruction,
      responseJsonSchema,
      intake: job.intake,
      previousText: text,
      errors: validation.errors,
      allowedDates: job.allowedDates,
    });
    repaired = true;
    emit({ event: 'status', data: { phase: 'validating', message: 'Re-checking the repaired plan…' } });
    validation = validateText(fixedText, job.ctx);
    if (!validation.ok) {
      throw new AppError('PLAN_INVALID', undefined, { details: validation.errors.slice(0, 12) });
    }
  }

  if (!('plan' in validation) || !validation.plan) {
    // Unreachable in practice (ok === true always carries a plan), but keeps the types honest.
    throw new AppError('PLAN_INVALID');
  }

  const plan = validation.plan;
  return {
    plan,
    checks: validation.checks,
    capacity: validation.capacity,
    code: validation.code,
    model: validation.model,
    agrees: validation.agrees,
    fixes: suggestFixes(validation.scopeHours, job.ctx),
    repaired,
    deadlineUtc: job.deadlineUtc,
    dst: job.dst,
    todayKey: job.todayKey,
    runs: call.runs,
  };
}
