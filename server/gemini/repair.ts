/**
 * The single repair call.
 *
 * Why (for learners): even with a schema, a model can pick a Saturday or put
 * milestones out of order. Our validator (shared/plan.ts → validatePlan) finds
 * those mistakes as exact sentences. We send the model its own previous JSON
 * plus that exact error list and ask for the corrected FULL plan, ONCE. A
 * second failure is reported honestly as PLAN_INVALID instead of looping and
 * burning quota.
 *
 * The conversation we send is:
 *   user:  the original request (goal + constraints as data; the attachment is
 *          left out to save tokens — the previous plan already reflects it)
 *   model: the previous JSON, exactly as it came back
 *   user:  "these are the errors, return the corrected full plan"
 *
 * It rewrites the WHOLE plan, so it gets a plan-sized time limit (tuning.repairTimeoutMs, 120 s) and the
 * same thinking setting that just worked for the plan on this model (LOW by default). Without that it ran
 * with a 30 s limit and the model's default thinking, which a model that needs ~78 s per plan cannot meet.
 */
import type { ThinkingConfig } from '@google/genai';
import type { Intake } from '../../shared/plan';
import { callGemini, responseText, type CallContext } from './call';
import { buildPlanUserParts, buildRepairMessage } from './prompts';

export interface RepairArgs {
  model: string;
  systemInstruction: string;
  responseJsonSchema: Record<string, unknown>;
  intake: Intake;
  previousText: string;
  errors: string[];
  allowedDates: string[];
  /** The thinking setting the plan stream used successfully on this model (none = model default). */
  thinkingConfig?: ThinkingConfig;
}

/** Returns the raw text of the repaired plan (not yet validated). */
export async function repairPlan(ctx: CallContext, a: RepairArgs): Promise<string> {
  // Very long or truncated output is clipped: the model only needs enough to fix it.
  const previous = a.previousText.length > 60_000 ? a.previousText.slice(0, 60_000) : a.previousText;
  const response = await callGemini(ctx, {
    kind: 'repair',
    model: a.model,
    request: {
      contents: [
        { role: 'user', parts: buildPlanUserParts(a.intake, { includeAttachment: false }) },
        { role: 'model', parts: [{ text: previous || '{}' }] },
        { role: 'user', parts: [{ text: buildRepairMessage(a.errors, a.allowedDates) }] },
      ],
      config: {
        systemInstruction: a.systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: a.responseJsonSchema,
        ...(a.thinkingConfig ? { thinkingConfig: a.thinkingConfig } : {}),
      },
    },
    timeoutMs: ctx.tuning.repairTimeoutMs,
  });
  return responseText(response);
}
