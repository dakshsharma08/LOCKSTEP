/**
 * FIRST-LOAD and NAVIGATION regressions (no page reloads anywhere in these tests).
 * Real-device report: some features worked only after a manual refresh, the UI could look stuck or
 * incomplete on a first load, and a Gemini status line could stay up for a long time.
 * Gemini is mocked by e2e/mock-api.ts; slow / failed API answers are injected with page.route.
 */
import { expect, test, type Page } from '@playwright/test';

// page.route can miss requests that a service worker handles; these tests are about the app, not the cache.
test.use({ serviceWorkers: 'block' });

/** Record API calls and anything that went wrong in the page. */
function watch(page: Page) {
  const calls: string[] = [];
  const problems: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) calls.push(`${r.method()} ${u.pathname}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    // A request the browser gave up on (aborted) is a request whose answer was thrown away.
    if (new URL(r.url()).pathname.startsWith('/api/motivation')) problems.push(`aborted: ${r.url()}`);
  });
  return { calls, problems, count: (path: string) => calls.filter((c) => c.endsWith(path)).length };
}

async function wizardToLastStep(page: Page) {
  await page.goto('/new');
  await page.getByRole('button', { name: 'Try a sample goal' }).click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Continue' }).click();
}

async function approvedGoal(page: Page) {
  await wizardToLastStep(page);
  await page.getByRole('button', { name: 'Plan with Gemini' }).click();
  await page.waitForURL(/\/review$/, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await page.waitForURL(/\/goals\/[^/]+$/);
}

/** Client-side navigation (bottom bar on phones, sidebar on desktop): no reload. */
async function go(page: Page, name: 'Home' | 'Goals' | 'Studio' | 'Insights') {
  await page.getByRole('link', { name, exact: true }).filter({ visible: true }).first().click();
}

const PAGES = {
  Home: async (page: Page) => {
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText(/days left/i).first()).toBeVisible();
  },
  Goals: async (page: Page) => {
    await expect(page.getByRole('heading', { name: 'Goals', level: 1 })).toBeVisible();
  },
  Studio: async (page: Page) => {
    await expect(page.getByText('Lock Screen Studio', { exact: true })).toBeVisible();
    const phone = page.getByRole('img', { name: /Wallpaper preview:/ }).first();
    await expect(phone).toBeVisible();
    // The phone sits below the title (it used to keep a default size and cover it on some first loads).
    const title = (await page.getByText('Lock Screen Studio', { exact: true }).boundingBox())!;
    const frame = (await phone.locator('xpath=../..').boundingBox())!;
    expect(frame.y).toBeGreaterThanOrEqual(title.y + title.height);
  },
  Insights: async (page: Page) => {
    await expect(page.getByRole('heading', { name: "How it's going" })).toBeVisible();
  },
};

test('first visit: every main page works by navigation and by cold load, with no refresh', async ({
  page,
}) => {
  const w = watch(page);
  await approvedGoal(page);
  for (let round = 0; round < 2; round++) {
    for (const name of ['Home', 'Goals', 'Studio', 'Insights'] as const) {
      await go(page, name);
      await PAGES[name](page);
    }
  }
  // Cold loads (a fresh document each time, same device storage).
  for (const [path, name] of [
    ['/app', 'Home'],
    ['/goals', 'Goals'],
    ['/studio', 'Studio'],
    ['/insights', 'Insights'],
  ] as const) {
    await page.goto(path);
    await PAGES[name](page);
  }
  // ONE motivation request for this goal today, however many screens showed it (it used to be one per screen).
  expect(w.count('/api/motivation')).toBe(1);
  expect(w.problems).toEqual([]);
});

test('a failed, then slow health check does not hide Gemini planning (it retries by itself)', async ({
  page,
}) => {
  let n = 0;
  await page.route('**/api/health', async (route) => {
    n++;
    if (n === 1) return route.fulfill({ status: 504, body: 'gateway timeout' }); // a cold start / blip
    await new Promise((r) => setTimeout(r, 2000)); // then slow
    return route.continue();
  });
  await wizardToLastStep(page);
  await expect(page.getByRole('button', { name: 'Plan with Gemini' })).toBeVisible();
  await expect(page.getByText("Can't reach the LOCKSTEP server right now.")).toHaveCount(0);
  expect(n).toBeGreaterThanOrEqual(2);
});

test('server unreachable: an honest notice, manual planning, and "Check again" recovers without a reload', async ({
  page,
}) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await wizardToLastStep(page);
  await expect(page.getByText("Can't reach the LOCKSTEP server right now.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build my plan' })).toBeVisible();
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('button', { name: 'Plan with Gemini' })).toBeVisible();
  await expect(page.getByText("Can't reach the LOCKSTEP server right now.")).toHaveCount(0);
});

test('Gemini busy (503) for the motivation line: the plain line shows, and Gemini is not asked again per screen', async ({
  page,
}) => {
  const w = watch(page);
  await page.route('**/api/motivation', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'AI_BUSY',
        message: 'Gemini is busy right now.',
        retryable: true,
        status: 503,
      }),
    }),
  );
  await approvedGoal(page);
  for (const name of ['Home', 'Studio', 'Home', 'Goals', 'Home'] as const) {
    await go(page, name);
    await PAGES[name](page);
  }
  await expect(page.getByText(/days left · \d+% done/).first()).toBeVisible(); // the plain line
  expect(w.count('/api/motivation')).toBe(1);
});

test('a slow motivation answer is not cancelled by navigating away; it shows when it arrives', async ({
  page,
}) => {
  const w = watch(page);
  await page.route('**/api/motivation', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await approvedGoal(page); // the goal page asks for the line…
  await go(page, 'Studio'); // …and the user moves on before it arrives
  await go(page, 'Home');
  await expect(page.getByText('Fixture line: one focused session today.').first()).toBeVisible({
    timeout: 15_000,
  });
  expect(w.count('/api/motivation')).toBe(1);
  expect(w.problems).toEqual([]); // nothing aborted
});

test.describe('planning when the connection goes silent (one width: these wait for real time limits)', () => {
  test('after 20 s there is a way out: a labelled starter plan (no AI)', async ({ page }) => {
    test.skip(test.info().project.name !== 'w390', 'time-based: once is enough');
    await page.route('**/api/plan', () => undefined); // never answers
    await wizardToLastStep(page);
    await page.getByRole('button', { name: 'Plan with Gemini' }).click();
    await expect(page.getByText(/· \d+ s/)).toBeVisible({ timeout: 10_000 }); // elapsed time while waiting
    const out = page.getByRole('button', { name: 'Use a starter plan instead' });
    await expect(out).toBeVisible({ timeout: 25_000 });
    await out.click();
    await page.waitForURL(/\/review$/);
    await expect(
      page.getByText('Starter plan made by LOCKSTEP’s rules, not by Gemini.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(/Generated by Gemini/)).toHaveCount(0);
  });

  test('no data for 45 s: a clear error instead of an endless spinner, and Retry works', async ({ page }) => {
    test.skip(test.info().project.name !== 'w390', 'time-based: once is enough');
    test.setTimeout(150_000);
    await page.route('**/api/plan', () => undefined); // the connection silently died
    await wizardToLastStep(page);
    await page.getByRole('button', { name: 'Plan with Gemini' }).click();
    const card = page.getByRole('alert');
    await expect(card.getByText('Lost contact with the server')).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole('button', { name: 'Use a starter plan (no AI)' })).toBeVisible();
    await page.unroute('**/api/plan');
    await card.getByRole('button', { name: 'Retry' }).click();
    await page.waitForURL(/\/review$/, { timeout: 60_000 });
    await expect(page.getByText(/Generated by Gemini/)).toBeVisible();
  });
});
