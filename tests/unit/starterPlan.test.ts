/**
 * The starter plan (shared/starterPlan.ts) is built by rules, without AI, when Gemini can't plan.
 * It must pass the SAME code checks as a Gemini plan (validatePlan), for every kind of schedule.
 */
import { describe, expect, it } from 'vitest';
import { validatePlan, type ValidationContext } from '../../shared/plan';
import { buildStarterPlan } from '../../shared/starterPlan';
import { addDays, localToUtcIso } from '../../shared/time';
import { SAMPLE_GOALS } from '../../src/features/wizard/samples';

const TODAY = '2026-11-23'; // a Monday
function ctx(daysOut: number, opts: Partial<ValidationContext> & { time?: string } = {}): ValidationContext {
  const timezone = opts.timezone ?? 'UTC';
  return {
    todayKey: opts.todayKey ?? TODAY,
    deadlineUtc: localToUtcIso(addDays(TODAY, daysOut), opts.time ?? '18:00', timezone).iso,
    timezone,
    hoursPerDay: opts.hoursPerDay ?? 2,
    workingDays: opts.workingDays ?? [1, 2, 3, 4, 5],
  };
}
function expectValid(c: ValidationContext, pace: 'Steady' | 'Balanced' | 'Sprint' = 'Balanced') {
  const plan = buildStarterPlan({ goal: 'Ship my portfolio website', pace }, c);
  expect(plan).not.toBeNull();
  const v = validatePlan(plan, c);
  expect(v.errors).toEqual([]);
  expect(v.ok).toBe(true);
  for (const check of v.checks) expect(check, check.id).toMatchObject({ ok: true });
  // Its own feasibility claim is the code's (nothing to disagree with), and it always leaves slack.
  expect(v.agrees).toBe(true);
  expect(v.code.feasibility).toBe('Achievable');
  return { plan: v.plan!, v };
}

describe('buildStarterPlan passes every LOCKSTEP check', () => {
  it.each(SAMPLE_GOALS.map((s) => [s.goal, s] as const))('sample goal: %s', (_, s) => {
    const c = ctx(s.daysOut, { time: s.time, hoursPerDay: s.hoursPerDay, workingDays: s.workingDays });
    const { plan } = expectValid(c, s.pace);
    expect(plan.milestones.map((m) => m.title)).toEqual([
      'Get set up',
      'Core work: first half',
      'Core work: second half',
      'Final review and finish',
    ]);
    expect(plan.feasibilityReason).toMatch(/^Starter plan made by LOCKSTEP's rules \(no AI\)\./);
  });

  it('uses the pace: Steady < Balanced < Sprint, all under 85 % of capacity', () => {
    const c = ctx(28);
    const ratio = (p: 'Steady' | 'Balanced' | 'Sprint') => expectValid(c, p).v.code.ratio;
    expect(ratio('Steady')).toBeLessThan(ratio('Balanced'));
    expect(ratio('Balanced')).toBeLessThan(ratio('Sprint'));
    expect(ratio('Sprint')).toBeLessThanOrEqual(0.85);
  });

  it('the last milestone is the last possible day; dates strictly increase', () => {
    const c = ctx(30);
    const { plan, v } = expectValid(c);
    const dates = plan.milestones.map((m) => m.targetDate);
    expect(dates.at(-1)).toBe(v.capacity.workingDates.at(-1));
    expect([...new Set(dates)]).toEqual(dates);
  });

  it('few dates left: 1, 2 or 3 milestones', () => {
    // Deadline tomorrow (Tue): one possible date.
    expect(expectValid(ctx(1)).plan.milestones.map((m) => m.title)).toEqual(['Do the work and finish']);
    expect(expectValid(ctx(2)).plan.milestones).toHaveLength(2);
    expect(expectValid(ctx(3)).plan.milestones).toHaveLength(3);
  });

  it('a same-day deadline: one milestone today', () => {
    const { plan } = expectValid(ctx(0, { time: '23:00' }));
    expect(plan.milestones.map((m) => m.targetDate)).toEqual([TODAY]);
  });

  it('weekends only, another time zone, and a midnight deadline (it belongs to the day before)', () => {
    expectValid(ctx(40, { workingDays: [0, 6], timezone: 'Asia/Kolkata', time: '00:00' }));
  });

  it('a very long, very full schedule still fits the schema limits (≤ 2000 h a milestone, ≤ 600 min a task)', () => {
    const { plan } = expectValid(ctx(1000, { hoursPerDay: 16, workingDays: [0, 1, 2, 3, 4, 5, 6] }));
    for (const m of plan.milestones) {
      expect(m.estimatedHours).toBeLessThanOrEqual(2000);
      for (const t of m.tasks) expect(t.estimatedMinutes).toBeLessThanOrEqual(600);
    }
  });

  it('no working day left before the deadline: null (the user builds it by hand instead)', () => {
    // Deadline Saturday, Mon–Fri working days, and today is Saturday too.
    const c = ctx(5, { todayKey: addDays(TODAY, 5), workingDays: [1, 2, 3, 4, 5] });
    expect(buildStarterPlan({ goal: 'x goal', pace: 'Balanced' }, c)).toBeNull();
  });

  it('is deterministic', () => {
    const c = ctx(21);
    expect(buildStarterPlan({ goal: 'Goal', pace: 'Steady' }, c)).toEqual(
      buildStarterPlan({ goal: 'Goal', pace: 'Steady' }, c),
    );
  });
});
