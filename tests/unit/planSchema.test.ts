/**
 * The plan schema sent to Gemini must stay SMALL: Google rejected the old one with HTTP 400
 * "The specified schema produces a constraint that has too many states for serving" on gemini-3.6-flash
 * and gemini-3.5-flash (the owner's real diagnostics, 2026-11-23). These tests guard that, check that the
 * plan structure is unchanged, and check that every rule taken OUT of the schema is still enforced by the
 * server's own validation.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEMA_ENUM_VALUES,
  PLAN_PROPERTY_ORDER,
  STATE_HEAVY_KEYWORDS,
  buildPlanJsonSchema,
} from '../../server/gemini/schema';
import { isTemporaryUnavailable } from '../../server/gemini/fallback';
import { isThinkingRejection } from '../../server/gemini/thinking';
import { SCHEMA_REJECTION, toAppError } from '../../server/lib/errors';
import { LIMITS, PlanSchema, TaskSchema, MilestoneSchema, validatePlan, type Plan } from '../../shared/plan';
import { TOO_MANY_STATES, heavySchemaReason } from '../helpers/fakeGemini';

type Node = Record<string, unknown>;

/** Every [path, key, value] in a JSON value. */
function* walk(v: unknown, path = '$'): Generator<[string, string, unknown]> {
  if (!v || typeof v !== 'object') return;
  for (const [k, child] of Object.entries(v as Node)) {
    yield [path, k, child];
    yield* walk(child, `${path}.${k}`);
  }
}

const schema = buildPlanJsonSchema();
const props = (n: unknown) => (n as { properties: Node }).properties;
const milestoneNode = (props(schema).milestones as { items: Node }).items;
const taskNode = (props(milestoneNode).tasks as { items: Node }).items;

describe('Gemini-facing plan schema: small enough for serving', () => {
  it('uses none of the state-heavy keywords (bounded arrays, number ranges, formats, patterns)', () => {
    const found = [...walk(schema)].filter(([, k]) =>
      (STATE_HEAVY_KEYWORDS as readonly string[]).includes(k),
    );
    expect(found.map(([p, k]) => `${p}.${k}`)).toEqual([]);
  });

  it('has only tiny enums (feasibility and difficulty, 3 values each)', () => {
    const enums = [...walk(schema)]
      .filter(([, k]) => k === 'enum')
      .map(([p, , v]) => [p, (v as unknown[]).length]);
    expect(enums).toEqual([
      ['$.properties.feasibility', 3],
      ['$.properties.milestones.items.properties.difficulty', 3],
    ]);
    expect(Math.max(...enums.map((e) => e[1] as number))).toBeLessThanOrEqual(MAX_SCHEMA_ENUM_VALUES);
  });

  it('never contains the list of allowed dates (no date enum, whatever the deadline)', () => {
    const json = JSON.stringify(schema);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(props(milestoneNode).targetDate).toEqual({
      type: 'string',
      description: expect.stringMatching(/YYYY-MM-DD.*allowed milestone dates/),
    });
  });

  it('is the same, small schema for every plan (size does not grow with the deadline)', () => {
    expect(buildPlanJsonSchema()).toEqual(schema);
    expect(JSON.stringify(schema).length).toBeLessThan(4000);
  });

  it('is accepted by the test fake, which rejects what Google names as typical causes', () => {
    expect(heavySchemaReason(schema)).toBeNull();
    // The fake really does reject the constructs the OLD schema used (so the integration tests mean something).
    const old = structuredClone(schema) as Node;
    (props(old).milestones as Node).maxItems = LIMITS.maxMilestones;
    expect(heavySchemaReason(old)).toBe('$.properties.milestones.maxItems');
    const oldDates = structuredClone(schema) as Node;
    (props((props(oldDates).milestones as { items: Node }).items).targetDate as Node).enum = Array.from(
      { length: 90 },
      (_, i) => `2027-01-${String((i % 28) + 1).padStart(2, '0')}`,
    );
    expect(heavySchemaReason(oldDates)).toMatch(/targetDate\.enum \(90 values\)/);
    const oldMinutes = structuredClone(schema) as Node;
    const oldTask = (props((props(oldMinutes).milestones as { items: Node }).items).tasks as { items: Node })
      .items;
    (props(oldTask).estimatedMinutes as Node).minimum = 5;
    expect(heavySchemaReason(oldMinutes)).toMatch(/estimatedMinutes\.minimum$/);
    expect(heavySchemaReason(schema)).toBeNull(); // the real schema was not touched
  });
});

describe('Gemini-facing plan schema: the plan structure is unchanged', () => {
  it('has every PlanSchema field, all required, in streaming order', () => {
    expect(Object.keys(props(schema)).sort()).toEqual(Object.keys(PlanSchema.shape).sort());
    expect(schema.required).toEqual([...PLAN_PROPERTY_ORDER]);
    expect(schema.propertyOrdering).toEqual([...PLAN_PROPERTY_ORDER]);
    expect(props(schema).feasibility).toMatchObject({ enum: ['Achievable', 'Tight', 'Unrealistic'] });
  });
  it('milestones and tasks keep every field, required and ordered', () => {
    expect(Object.keys(props(milestoneNode)).sort()).toEqual(Object.keys(MilestoneSchema.shape).sort());
    expect(milestoneNode.required).toEqual(milestoneNode.propertyOrdering);
    expect(Object.keys(props(taskNode)).sort()).toEqual(Object.keys(TaskSchema.shape).sort());
    expect(taskNode.required).toEqual(['id', 'title', 'estimatedMinutes']);
    expect(props(taskNode).estimatedMinutes).toMatchObject({ type: 'integer' });
    expect(props(milestoneNode).difficulty).toMatchObject({ enum: ['Easy', 'Medium', 'Hard'] });
  });
  it('the removed limits are still told to the model, in the descriptions', () => {
    expect((props(schema).milestones as Node).description).toMatch(/never more than 12/);
    expect((props(milestoneNode).tasks as Node).description).toMatch(/never more than 8/);
    expect((props(taskNode).estimatedMinutes as Node).description).toMatch(/5 to 600/);
  });
});

// Mon 2026-11-23, deadline Fri 2026-12-04 18:00 UTC, Mon–Fri, 2 h/day (capacity 20 h).
const ctx = {
  todayKey: '2026-11-23',
  deadlineUtc: '2026-12-04T18:00:00.000Z',
  timezone: 'UTC',
  hoursPerDay: 2,
  workingDays: [1, 2, 3, 4, 5],
};
const task = (i: number, minutes = 60) => ({ id: `t${i}`, title: `Task ${i}`, estimatedMinutes: minutes });
const milestone = (i: number, date: string, over: Partial<Plan['milestones'][number]> = {}) => ({
  id: `m${i}`,
  title: `Milestone ${i}`,
  description: 'Done when it is done.',
  targetDate: date,
  estimatedHours: 1,
  difficulty: 'Medium' as const,
  tasks: [task(1)],
  ...over,
});
const plan = (milestones: Plan['milestones']): Plan => ({
  goal: 'Ship it',
  deadline: ctx.deadlineUtc,
  timezone: 'UTC',
  feasibility: 'Achievable',
  feasibilityReason: 'Fits.',
  totalEstimatedHours: milestones.reduce((s, m) => s + m.estimatedHours, 0),
  milestones,
  risks: ['Scope creep'],
  recoveryStrategy: 'Cut extras.',
  dailyRitual: 'Start at 9.',
});

describe('rules taken out of the schema are still ENFORCED by the server', () => {
  it('a valid plan passes (control)', () => {
    expect(validatePlan(plan([milestone(1, '2026-11-25'), milestone(2, '2026-12-02')]), ctx).ok).toBe(true);
  });
  it('more than 12 milestones is rejected', () => {
    const many = Array.from({ length: LIMITS.maxMilestones + 1 }, (_, i) =>
      milestone(i + 1, '2026-12-01', { estimatedHours: 0.5 }),
    );
    expect(validatePlan(plan(many), ctx).ok).toBe(false);
  });
  it('more than 8 tasks, or none, is rejected', () => {
    const nine = Array.from({ length: LIMITS.maxTasksPerMilestone + 1 }, (_, i) => task(i + 1, 5));
    expect(validatePlan(plan([milestone(1, '2026-11-25', { tasks: nine })]), ctx).ok).toBe(false);
    expect(validatePlan(plan([milestone(1, '2026-11-25', { tasks: [] })]), ctx).ok).toBe(false);
  });
  it('task minutes outside 5–600, or not whole, are rejected', () => {
    for (const m of [4, 601, 30.5]) {
      expect(validatePlan(plan([milestone(1, '2026-11-25', { tasks: [task(1, m)] })]), ctx).ok).toBe(false);
    }
  });
  it('a date outside the allowed working days is rejected (weekend, past, after the deadline, not a date)', () => {
    for (const d of ['2026-11-28', '2026-11-20', '2026-12-07', '25/11/2026']) {
      const r = validatePlan(plan([milestone(1, d)]), ctx);
      expect(r.ok, d).toBe(false);
    }
  });
  it('a bad difficulty or feasibility value is rejected', () => {
    expect(validatePlan(plan([milestone(1, '2026-11-25', { difficulty: 'Extreme' as never })]), ctx).ok).toBe(
      false,
    );
    expect(validatePlan({ ...plan([milestone(1, '2026-11-25')]), feasibility: 'Maybe' }, ctx).ok).toBe(false);
  });
});

/** What the @google/genai SDK throws for an HTTP error: an Error with a numeric status and Google's JSON. */
const googleError = (status: number, message: string, code = 'INVALID_ARGUMENT') =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, message, status: code } })), { status });

describe('a schema rejection (HTTP 400 "too many states") is reported accurately', () => {
  const err = toAppError(googleError(400, TOO_MANY_STATES));

  it("recognises Google's wording", () => {
    expect(SCHEMA_REJECTION.test(TOO_MANY_STATES)).toBe(true);
    expect(SCHEMA_REJECTION.test('Unknown name "thinkingLevel": Cannot find field.')).toBe(false);
  });
  it('is NOT "Gemini is busy", and says what really happened', () => {
    expect(err.code).not.toBe('AI_BUSY');
    expect(err.code).toBe('INTERNAL');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(
      /rejected LOCKSTEP's plan format \(HTTP 400: the response schema is too complex/,
    );
    expect(err.message).not.toMatch(/attached a file/);
    expect(err.details?.[0]).toBe('Gemini status 400');
    expect(err.details?.[1]).toMatch(
      /^Google said: INVALID_ARGUMENT: The specified schema produces a constraint that has too many states/,
    );
  });
  it('is not a temporary error (no model fallback) and not a thinking rejection (no thinking retry)', () => {
    expect(isTemporaryUnavailable(err)).toBe(false);
    expect(isThinkingRejection(err)).toBe(false);
  });
  it('other 400s: an accurate message and status 502; 429 quota is still temporary', () => {
    const other = toAppError(googleError(400, 'Request contains an invalid argument.'));
    expect(other.message).toMatch(/^Gemini rejected this request \(HTTP 400\), so no plan was made/);
    expect(other.status).toBe(502); // an upstream rejection of the server's request, not the user's input
    expect(other.toJSON()).toMatchObject({ code: 'INTERNAL', status: 502 });
    const quota = toAppError(
      googleError(
        429,
        'You exceeded your current quota. Quota exceeded for metric … limit: 20',
        'RESOURCE_EXHAUSTED',
      ),
    );
    expect(quota.code).toBe('AI_BUSY');
    expect(isTemporaryUnavailable(quota)).toBe(true);
  });
});
