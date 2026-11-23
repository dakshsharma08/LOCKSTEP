/**
 * The AI motivation line is requested at most once per goal/day/progress step (src/lib/motivation.ts):
 * shared while running, never aborted, stored when it arrives, and not asked again for a while after a
 * failure. Regression: a first load used to send one request per screen (6 in a short walk through the
 * app), several of them aborted mid-flight, each one a potential free-tier Gemini call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getMotivation: vi.fn() }));
const repo = vi.hoisted(() => ({
  setKv: vi.fn(async () => undefined),
  recordRuns: vi.fn(async () => undefined),
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/db/repo', () => repo);

import { MOTIVATION_RETRY_MS, requestMotivation, resetMotivationRequests } from '../../src/lib/motivation';

const REQ = {
  goal: 'Pass the exam',
  daysLeft: 30,
  percentDone: 0,
  nextMilestone: 'Get set up',
  streak: 0,
  pace: 'on-track' as const,
  state: 'active' as const,
  dateKey: '2026-11-23',
};
const RUN = { kind: 'motivation', model: 'gemini-3.5-flash-lite', ok: true, at: '2026-11-23T12:00:00Z' };

beforeEach(() => {
  resetMotivationRequests();
  api.getMotivation.mockReset();
  repo.setKv.mockClear();
  repo.recordRuns.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('requestMotivation', () => {
  it('screens asking at the same time share ONE request, and the answer is stored', async () => {
    let answer!: (v: unknown) => void;
    api.getMotivation.mockReturnValue(new Promise((r) => (answer = r)));
    const a = requestMotivation('motivation:g1:2026-11-23:0', REQ, 'g1');
    const b = requestMotivation('motivation:g1:2026-11-23:0', REQ, 'g1');
    const c = requestMotivation('motivation:g1:2026-11-23:0', REQ, 'g1');
    answer({ line: 'One focused session today.', run: RUN });
    expect(await Promise.all([a, b, c])).toEqual(Array(3).fill('One focused session today.'));
    expect(api.getMotivation).toHaveBeenCalledTimes(1);
    expect(repo.setKv).toHaveBeenCalledWith('motivation:g1:2026-11-23:0', 'One focused session today.');
  });

  it('is never aborted: the request carries no AbortSignal', async () => {
    api.getMotivation.mockResolvedValue({ line: 'x', run: RUN });
    await requestMotivation('k', REQ, 'g1');
    expect(api.getMotivation).toHaveBeenCalledWith(REQ);
  });

  it('after a failure (Gemini 503 / 429 / offline) the same line is not asked again for a while', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-23T12:00:00Z') });
    api.getMotivation.mockRejectedValue(new Error('AI_BUSY'));
    expect(await requestMotivation('k', REQ, 'g1')).toBeNull();
    expect(await requestMotivation('k', REQ, 'g1')).toBeNull(); // e.g. the next screen
    expect(api.getMotivation).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + MOTIVATION_RETRY_MS + 1);
    api.getMotivation.mockResolvedValue({ line: 'Back on track.', run: RUN });
    expect(await requestMotivation('k', REQ, 'g1')).toBe('Back on track.');
    expect(api.getMotivation).toHaveBeenCalledTimes(2);
  });

  it('a different goal or day is a different line (its own request)', async () => {
    api.getMotivation.mockResolvedValue({ line: 'x', run: RUN });
    await requestMotivation('motivation:g1:2026-11-23:0', REQ, 'g1');
    await requestMotivation('motivation:g2:2026-11-23:0', REQ, 'g2');
    expect(api.getMotivation).toHaveBeenCalledTimes(2);
  });
});
