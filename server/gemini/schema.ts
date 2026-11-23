/**
 * JSON Schemas sent to Gemini as `config.responseJsonSchema`.
 *
 * Why (for learners): with `responseMimeType: 'application/json'` plus a schema, Gemini's decoder is
 * constrained to produce JSON of exactly this shape. Google compiles the schema into a state machine,
 * and REJECTS a schema whose machine gets too big with HTTP 400 "The specified schema produces a
 * constraint that has too many states for serving". What makes it big, and multiplies when nested:
 *   • bounded arrays (minItems/maxItems): the item is copied once per allowed count instead of looping,
 *     so 12 milestones × 8 tasks became ~96 copies of the task;
 *   • long enums (we listed up to 90 allowed dates, inside every milestone copy);
 *   • number ranges (minimum/maximum) and formats ("date"), inside every copy.
 * So the schema sent to Gemini carries only the STRUCTURE: every field, its type, `required`, key order and
 * two 3-value enums. The rules that were constraints (how many milestones/tasks, minute ranges, which
 * dates) are in the field descriptions and the system prompt, and the server still ENFORCES all of them:
 * PlanSchema (zod) + validatePlan in shared/plan.ts re-check every plan, and one repair call fixes
 * violations. Nothing the model writes is trusted blindly.
 *
 * `propertyOrdering` is a Gemini extension: it makes the model write the keys in this order. We want
 * feasibility FIRST and milestones before the long trailing text, so the streaming parser can show them
 * as early as possible. (A fixed order also makes the state machine smaller, not bigger.)
 */
import { DIFFICULTY, FEASIBILITY, LIMITS } from '../../shared/plan';

export const PLAN_PROPERTY_ORDER = [
  'goal',
  'deadline',
  'timezone',
  'feasibility',
  'feasibilityReason',
  'totalEstimatedHours',
  'fullScopeHours',
  'milestones',
  'risks',
  'recoveryStrategy',
  'dailyRitual',
] as const;

const MILESTONE_ORDER = [
  'id',
  'title',
  'description',
  'targetDate',
  'estimatedHours',
  'difficulty',
  'tasks',
] as const;
const TASK_ORDER = ['id', 'title', 'estimatedMinutes'] as const;

/**
 * Above this many allowed dates the PROMPT describes the date rule instead of listing every date.
 * (Dates are never an enum in the schema any more; see the note at the top.)
 */
export const MAX_ENUM_DATES = 90;

/**
 * Keywords that make Gemini's schema state machine grow (and multiply when nested). The plan schema must
 * not use any of them; a unit test walks the schema to make sure.
 */
export const STATE_HEAVY_KEYWORDS = [
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
] as const;

/** Largest enum allowed in a Gemini-facing schema (feasibility and difficulty have 3 values). */
export const MAX_SCHEMA_ENUM_VALUES = 3;

/**
 * The plan schema sent to Gemini. The same for every plan: the allowed dates are in the prompt (and
 * enforced by validatePlan), never in the schema.
 */
export function buildPlanJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      goal: { type: 'string', description: "The user's goal restated in one short line." },
      deadline: { type: 'string', description: 'The deadline exactly as given (ISO 8601, UTC).' },
      timezone: { type: 'string', description: 'The IANA time zone exactly as given.' },
      feasibility: { type: 'string', enum: [...FEASIBILITY] },
      feasibilityReason: { type: 'string', description: 'One or two sentences with the real numbers.' },
      totalEstimatedHours: {
        type: 'number',
        description: 'Sum of the milestone estimatedHours (0 or more).',
      },
      fullScopeHours: {
        type: 'number',
        description:
          'Hours the COMPLETE goal would need when that exceeds the capacity (so this plan keeps only the essentials). Use 0 when the full goal fits.',
      },
      milestones: {
        type: 'array',
        description: `3–8 milestones (at least 1, never more than ${LIMITS.maxMilestones}), in chronological order.`,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'm1, m2, …' },
            title: { type: 'string', description: 'Specific and measurable outcome.' },
            description: { type: 'string' },
            targetDate: {
              type: 'string',
              description:
                'YYYY-MM-DD. ONLY one of the allowed milestone dates from the instructions: a working day after today, on or before the deadline day.',
            },
            estimatedHours: { type: 'number', description: 'Hours for this milestone, at least 0.25.' },
            difficulty: { type: 'string', enum: [...DIFFICULTY] },
            tasks: {
              type: 'array',
              description: `2–6 concrete tasks (at least 1, never more than ${LIMITS.maxTasksPerMilestone}).`,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'm1-t1, m1-t2, …' },
                  title: { type: 'string' },
                  estimatedMinutes: { type: 'integer', description: 'Whole minutes, from 5 to 600.' },
                },
                required: [...TASK_ORDER],
                propertyOrdering: [...TASK_ORDER],
              },
            },
          },
          required: [...MILESTONE_ORDER],
          propertyOrdering: [...MILESTONE_ORDER],
        },
      },
      risks: {
        type: 'array',
        description: '2–5 specific risks (never more than 8).',
        items: { type: 'string' },
      },
      recoveryStrategy: { type: 'string' },
      dailyRitual: { type: 'string' },
    },
    required: [...PLAN_PROPERTY_ORDER],
    propertyOrdering: [...PLAN_PROPERTY_ORDER],
  };
}

/** `{ "line": "…" }` for the motivation line. */
export const LINE_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
} as const;

/** `{ "summary": "…" }` for the weekly insight. */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
} as const;
