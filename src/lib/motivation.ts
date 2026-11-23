/**
 * The AI motivation line: at most ONE Gemini request per goal, day and progress step, shared by every
 * screen that shows it (Home, Goal, Studio, Cover).
 *
 * Why (for learners): the line used to be requested by each screen on mount, before the stored line had
 * even been read, and the request was aborted whenever React re-rendered with new objects. On a first
 * load that meant several requests (each one a Gemini call on the free tier) and often no line at all.
 * Now: the caller reads the stored line first; a request that is already running is shared; an answer is
 * kept even if the screen changed meanwhile; and after a failure (Gemini busy, quota, offline) the same
 * line is not asked for again for a while. The plain line from the real numbers is shown meanwhile.
 */
import type { MotivationRequest } from '@shared/api';
import { getMotivation } from '@/lib/api';
import { recordRuns, setKv } from '@/db/repo';

/** After a failed request, don't ask for the same line again for this long (this page session). */
export const MOTIVATION_RETRY_MS = 10 * 60_000;

const inflight = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();

/** Ask the server for the line stored under `key` (deduplicated, backed off after failures). */
export function requestMotivation(
  key: string,
  req: MotivationRequest,
  goalId: string,
): Promise<string | null> {
  const running = inflight.get(key);
  if (running) return running;
  const failed = failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < MOTIVATION_RETRY_MS) return Promise.resolve(null);

  // No AbortSignal on purpose: once Gemini has been asked, the answer is stored rather than thrown away.
  const request = getMotivation(req)
    .then(async (r) => {
      failedAt.delete(key);
      await setKv(key, r.line);
      await recordRuns([r.run], goalId);
      return r.line;
    })
    .catch(() => {
      failedAt.set(key, Date.now());
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Tests only: forget running requests and failures. */
export function resetMotivationRequests(): void {
  inflight.clear();
  failedAt.clear();
}
