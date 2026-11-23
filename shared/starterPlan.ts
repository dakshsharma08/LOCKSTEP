/**
 * A STARTER PLAN built by fixed rules, with NO AI. It is offered when Gemini can't plan right now.
 *
 * Why (for learners): on the free tier Gemini can be overloaded (HTTP 503) or out of quota (429) for a
 * while. An empty page is a dead end, so the user can start from an editable skeleton instead:
 * set up → core work → final review. Dates land on their working days and the hours fit their capacity.
 * It is NEVER presented as Gemini's work: it is saved as a 'manual' plan marked as a starter (plan_meta),
 * and it passes the same code checks as a Gemini plan (validatePlan, tested in starterPlan.test.ts).
 */
import {
  allowedMilestoneDates,
  codeFeasibility,
  computeCapacity,
  round1,
  type Difficulty,
  type PaceStyle,
  type Plan,
  type ValidationContext,
} from './plan';

interface Phase {
  title: string;
  description: string;
  difficulty: Difficulty;
  /** [task title, share of the milestone's time] */
  tasks: [string, number][];
}

const SETUP: Phase = {
  title: 'Get set up',
  description: 'Decide what “done” looks like, break the goal into its main parts and gather what you need.',
  difficulty: 'Easy',
  tasks: [
    ['Write down what “done” looks like and how you will check it', 0.3],
    ['Break the goal into its main parts', 0.4],
    ['Gather the materials, tools and resources you need', 0.3],
  ],
};
const CORE_1: Phase = {
  title: 'Core work: first half',
  description: 'Work through the first half of the main parts, one at a time.',
  difficulty: 'Medium',
  tasks: [
    ['Work on the first main part', 0.45],
    ['Work on the next main part', 0.4],
    ['Check your progress against your definition of done', 0.15],
  ],
};
const CORE_2: Phase = {
  title: 'Core work: second half',
  description: 'Finish the remaining parts and close the gaps you found.',
  difficulty: 'Medium',
  tasks: [
    ['Work on the remaining main parts', 0.6],
    ['Fix the gaps you noted so far', 0.25],
    ['Get feedback or test yourself', 0.15],
  ],
};
const CORE: Phase = {
  title: 'Core work',
  description: 'Work through the main parts one at a time and check your progress as you go.',
  difficulty: 'Medium',
  tasks: [
    ['Work through the main parts, one at a time', 0.7],
    ['Check your progress and fix the gaps', 0.3],
  ],
};
const SETUP_AND_CORE: Phase = {
  title: 'Set up and do the core work',
  description: 'Decide what “done” looks like, then work through the main parts one at a time.',
  difficulty: 'Medium',
  tasks: [
    ['Decide what “done” looks like and list the main parts', 0.2],
    ['Work through the main parts, one at a time', 0.65],
    ['Check your progress and fix the gaps', 0.15],
  ],
};
const FINISH: Phase = {
  title: 'Final review and finish',
  description: 'Review everything against your definition of done, polish what is left and finish on time.',
  difficulty: 'Medium',
  tasks: [
    ['Review everything against your definition of done', 0.4],
    ['Fix and polish what is left', 0.4],
    ['Final check, then finish', 0.2],
  ],
};
const SINGLE: Phase = {
  title: 'Do the work and finish',
  description: 'Decide what “done” looks like, do the main work, then review and finish.',
  difficulty: 'Medium',
  tasks: [
    ['Decide what “done” looks like and list the main parts', 0.15],
    ['Do the main work', 0.65],
    ['Review and finish', 0.2],
  ],
};

/** Milestone shapes by how many milestone dates are possible, with each one's share of the calendar. */
const SHAPES: Record<1 | 2 | 3 | 4, { phases: Phase[]; until: number[] }> = {
  1: { phases: [SINGLE], until: [1] },
  2: { phases: [SETUP_AND_CORE, FINISH], until: [0.7, 1] },
  3: { phases: [SETUP, CORE, FINISH], until: [0.2, 0.75, 1] },
  4: { phases: [SETUP, CORE_1, CORE_2, FINISH], until: [0.15, 0.5, 0.8, 1] },
};

/** Share of the available hours the starter plan uses: always "Achievable" (≤ 85 %), with slack for bad days. */
const SHARE: Record<PaceStyle, number> = { Steady: 0.6, Balanced: 0.7, Sprint: 0.8 };

/**
 * Build a starter plan for a goal, or null when no milestone date is possible (no working day left before
 * the deadline). Pure and deterministic: the same input gives the same plan.
 */
export function buildStarterPlan(
  input: { goal: string; pace: PaceStyle },
  ctx: ValidationContext,
): Plan | null {
  const cap = computeCapacity(ctx);
  const dates = allowedMilestoneDates(cap);
  if (dates.length === 0) return null;
  const n = Math.min(4, dates.length) as 1 | 2 | 3 | 4;
  const { phases, until } = SHAPES[n];
  const share = SHARE[input.pace];

  // Milestone dates spread over the allowed dates by each phase's share; the last one is the last possible day.
  const picked: string[] = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const want = i === n - 1 ? dates.length - 1 : Math.ceil(until[i]! * dates.length) - 1;
    const idx = Math.min(Math.max(want, prev + 1), dates.length - (n - i));
    picked.push(dates[idx]!);
    prev = idx;
  }

  const milestones = phases.map((phase, i) => {
    // Hours = this milestone's working days (since the previous milestone; today counts for the first) × h/day × share.
    const from = i === 0 ? '' : picked[i - 1]!;
    const days = cap.workingDates.filter((d) => d > from && d <= picked[i]!).length;
    const hours = Math.min(2000, Math.max(0.1, round1(days * ctx.hoursPerDay * share)));
    const minutes = hours * 60;
    const id = `m${i + 1}`;
    return {
      id,
      title: phase.title,
      description: phase.description,
      targetDate: picked[i]!,
      estimatedHours: hours,
      difficulty: phase.difficulty,
      tasks: phase.tasks.map(([title, part], j) => ({
        id: `${id}-t${j + 1}`,
        title,
        estimatedMinutes: Math.min(600, Math.max(5, Math.round((minutes * part) / 5) * 5)),
      })),
    };
  });

  const total = round1(milestones.reduce((s, m) => s + m.estimatedHours, 0));
  const code = codeFeasibility(total, cap);
  const pct = cap.capacityHours > 0 ? Math.round((total / cap.capacityHours) * 100) : 0;
  return {
    goal: input.goal.trim().slice(0, 400),
    deadline: cap.toKey,
    timezone: ctx.timezone,
    feasibility: code.feasibility,
    feasibilityReason: `Starter plan made by LOCKSTEP's rules (no AI). ${code.reason}`.slice(0, 600),
    totalEstimatedHours: total,
    fullScopeHours: null,
    milestones,
    risks: [
      'The tasks are generic: replace them with the real parts of your goal in your first session.',
      'Missed days add up: if you fall behind, move the next milestone rather than skipping the review.',
    ],
    recoveryStrategy: `If you miss a day, don't double up: move the task to your next working day. The plan uses about ${pct}% of your available hours, so there is slack for bad days.`,
    dailyRitual: 'Start each session by picking one task, work on it, then tick what you finished.',
  };
}
