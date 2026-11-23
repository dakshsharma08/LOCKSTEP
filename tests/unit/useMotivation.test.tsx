// @vitest-environment jsdom
/**
 * useMotivation (src/features/goals/components.tsx) on a first load.
 * Regressions: (1) the request effect depended on the goal/metrics OBJECTS, which change identity on
 * almost every render while the app starts, so each re-render aborted the request in flight and a guard
 * then blocked a retry (the AI line never arrived until a refresh); (2) it asked Gemini BEFORE the stored
 * line had been read, so every screen visit sent a request.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  getKv: vi.fn<(key: string) => Promise<string | undefined>>(),
  toggleTask: vi.fn(),
  logMinutes: vi.fn(),
}));
const api = vi.hoisted(() => ({ getHealth: vi.fn() }));
const mot = vi.hoisted(() => ({ requestMotivation: vi.fn<(...a: unknown[]) => Promise<string | null>>() }));
vi.mock('@/db/repo', () => repo);
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/motivation', () => mot);

import { useMotivation } from '../../src/features/goals/components';

const goal = () => ({ id: 'g1', title: 'Pass the exam', status: 'active' }) as never;
const metrics = () =>
  ({
    countdown: { todayKey: '2026-11-23', daysLeft: 30, state: 'active' },
    progress: 0,
    nextMilestone: { title: 'Get set up' },
    streak: 0,
    pace: 'on-track',
  }) as never;

function Line() {
  // New objects on EVERY render, exactly like the live database hooks during startup.
  const { line, source } = useMotivation(goal(), metrics());
  return <p data-testid="line">{`${source}: ${line}`}</p>;
}
function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  repo.getKv.mockReset();
  mot.requestMotivation.mockReset();
  api.getHealth.mockResolvedValue({ ok: true, ai: { configured: true } });
});

describe('useMotivation on a first load', () => {
  it('re-renders with new objects do not cancel or repeat the request; the AI line arrives', async () => {
    repo.getKv.mockResolvedValue(undefined);
    let answer!: (v: string) => void;
    mot.requestMotivation.mockReturnValue(new Promise((r) => (answer = r)));
    const { rerender } = render(wrap(<Line />));
    await waitFor(() => expect(mot.requestMotivation).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) rerender(wrap(<Line />)); // startup churn
    answer('One focused session today.');
    await waitFor(() =>
      expect(screen.getByTestId('line').textContent).toBe('ai: One focused session today.'),
    );
    expect(mot.requestMotivation).toHaveBeenCalledTimes(1);
  });

  it('a stored line is used as is: no request at all', async () => {
    repo.getKv.mockResolvedValue('Stored line.');
    render(wrap(<Line />));
    await waitFor(() => expect(screen.getByTestId('line').textContent).toBe('ai: Stored line.'));
    expect(mot.requestMotivation).not.toHaveBeenCalled();
  });

  it('even when reading the stored line is slow, nothing is requested before it has been read', async () => {
    let stored!: (v: string) => void;
    repo.getKv.mockReturnValue(new Promise((r) => (stored = r)));
    render(wrap(<Line />));
    // The plain line from the real numbers shows meanwhile.
    expect(screen.getByTestId('line').textContent).toMatch(/^local: 30 days left/);
    await new Promise((r) => setTimeout(r, 30)); // health has answered by now
    expect(mot.requestMotivation).not.toHaveBeenCalled();
    stored('Stored line.');
    await waitFor(() => expect(screen.getByTestId('line').textContent).toBe('ai: Stored line.'));
    expect(mot.requestMotivation).not.toHaveBeenCalled();
  });

  it('Gemini unavailable: the plain line stays, nothing breaks', async () => {
    repo.getKv.mockResolvedValue(undefined);
    mot.requestMotivation.mockResolvedValue(null);
    render(wrap(<Line />));
    await waitFor(() => expect(mot.requestMotivation).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('line').textContent).toMatch(/^local: /);
  });
});
