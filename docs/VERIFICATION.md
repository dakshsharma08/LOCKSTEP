# LOCKSTEP — Final verification report

Run 2026-11-23 ~05:30–06:10 UTC in the original development repository (branch `ccr-d3fe6a20-92epng`, final commit `ee2b0e9`), against the production build. This repository contains exactly that verified source; §11 records the re-verification after migration. Every number below was produced by a command run in this pass.

**Verdict:** all critical issues found by testing and review are fixed and the app is safe to merge **as software**. Two things were **not** verified and cannot be from this sandbox: real Gemini API calls (no key) and a live deployment (Vercel/Supabase hosts are blocked). They are listed under §9 so the merge decision is made knowingly. The branch has **not** been merged.

---

## 1. Test results

| Suite | Command | Result |
|---|---|---|
| Unit + integration (Vitest) | `npx vitest run` | **249 passed, 3 skipped**, 16 files passed, 1 skipped |
| Browser E2E + accessibility (Playwright, production build) | `npm run build && npx playwright test --trace off` | **20 / 20 passed** (5 tests × 4 widths) |
| Typecheck | `npx tsc -b` | clean |
| Lint | `npx eslint .` | clean (0 errors, 0 warnings) |

**The 3 skipped tests** are the live Gemini smoke tests in `tests/live/gemini.live.test.ts`. They are reported as **SKIPPED, not passed**, because `GEMINI_API_KEY` is not set here:
1. `health resolves a real model`
2. `streams a plan that passes every hard check`
3. `writes a motivation line and answers a coach question with tools`

Run them with a key: `GEMINI_API_KEY=… npm run test:live`.

**Browser tests per width (360 / 390 / 430 / 1440):**
1. Full acceptance journey, brief §C3: guest → goal + deadline + zone → hours + working days → plan passes 7/7 code checks → edit one milestone → approve → live countdown → Studio template → preview shows real days left / next milestone / progress → export, PNG size read from the header → wallpaper guide → tick tasks, progress updates → refresh wallpaper reflects it → **offline reload, data persists**.
2. Android 1080×2400 export has native dimensions.
3. Living Wallpaper link: create → URL returns today's PNG → revoke → URL returns 404.
4. Countdown accuracy (new): countdown read from the page vs an independent calculation from the stored UTC deadline, within 2 minutes.
5. Every screen (12, in dark and light): axe-core WCAG 2.2 AA with no serious/critical violations, and no horizontal overflow.

Caveat: in E2E, Gemini is a **test fixture** (`e2e/mock-api.ts`, model name `gemini-e2e-mock`). It exercises the real server and the real SDK request path, but the model's answers are canned.

## 2. The 15 review findings (independent reviewer, all fixed)

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Wallpaper routes unthrottled and unbounded (30 × 5 MB POSTs stored 150 MB; one 4096² GET cost 5.9 s CPU) | Own rate limits, 64 KB body cap (→ 413), hex-only colours, phone-sized custom dimensions, per-day PNG cache |
| 2 | High | AI rate limit bypassable with a forged `X-Forwarded-For` | Client IP uses Vercel's own headers there, otherwise `TRUST_PROXY` hops (default 0). Tested live: 25 spoofed IPs → 20 allowed, 6 blocked |
| 3 | Med | Mid-plan feasibility compared the whole plan with remaining capacity | Judges remaining work only; fixes recomputed |
| 4 | Med | Ticking a task re-opened a milestone completed by hand | Only un-ticking re-opens |
| 5 | Med | "Today's focus" could never finish | Today's done minutes count toward the budget |
| 6 | Med | Deleting a goal left its public wallpaper link live | Links are revoked first; failures keep the secret so Settings can retry |
| 7 | Low | Task delete/Undo lost logged minutes and skipped completion | `restoreTask` restores logs and re-syncs completion |
| 8 | Low | Adding/deleting milestones skipped goal-completion check | Re-checked on add, delete, restore |
| 9 | Low | Wizard accepted deadlines with no plannable working day | Blocked with a clear message |
| 10 | Low | No limit on deadline distance (9999-12-31 blocked the server 1.65 s) | Capped at 3 years; fix search scales with horizon |
| 11 | Low | Reminders mixed UTC date with local hours | Local date |
| 12 | Low | Coach failed above 20 milestones | Client sends at most 20 (open ones first) |
| 13 | Low | Living link counted days from a different start | Same start as the app |
| 14 | Low | Export "Refresh" didn't re-render | Re-renders when data or design changes |
| 15 | Low | Studio preview aspect hard-coded; autosave race between goals | Real device aspect; design saved with its goal id, flushed on switch/leave |

Each has a regression test or is covered by an existing E2E; see `tests/unit/{metrics,plan,liveChecks}.test.ts` and `tests/integration/{api,living}.test.ts`. One edge the reviewer found was **left as is** and documented: a 00:00 deadline on a day whose midnight falls in a DST gap (e.g. Santiago, September) counts one day late.

**Design critique (12 findings, separate pass):** applied the low-risk, high-visibility ones: toasts (one at a time, clear of the header, no white close disc), stat-chip type and wording, review bar copy, Focus top bar on phones, Studio inspector width ("Background" no longer cut off), export sheet (Download above the fold on phones, tidy filename), and the flat grey widget slabs removed from the cover and landing mockups. **Not applied** (visual consistency work, none functional): unifying heading/eyebrow type scale, one shared content-column width, mobile hero ring layout, Coach card eyebrow/chip grid, Insights chart palette, hiding the tab bar inside the mobile Studio, planning-screen skeleton → staged checklist.

## 3. Mobile responsiveness (360 / 390 / 430)

Evidence: the test run writes screenshots for every screen and width into `docs/evidence/` (generated, not committed).
- All 12 screens × dark/light × 3 phone widths: **no horizontal scroll** (asserted), **no axe serious/critical violations** (asserted).
- Full journey passes at 360, 390 and 430, including the draggable bottom-sheet Studio and the export flow.
- Lighthouse mobile on the final build (simulated slow 4G):

| Page | Performance | Accessibility | Best practices | LCP |
|---|---|---|---|---|
| `/` landing | 94 | 100 | 100 | 0.8 s |
| `/new` | 99 | 100 | 100 | 0.8 s |
| `/guide` | 100 | 100 | 100 | 0.8 s |
| `/app` (empty dashboard, cold profile) | **85** | 100 | 100 | 4.2 s |

`/app` is below the 90 target: its first headline waits for the local database. Known limitation (§9).

## 4. Wallpaper dimensions and visual quality

Checked by an independent Python header reader, not the app's own code:

| File | Size | Expected | Result |
|---|---|---|---|
| `submission/lockscreen.png` | 1206 × 2622 (iPhone Pro) | 1206 × 2622 | ✅ 4.1 MB |
| `submission/lockscreen-android.png` | 1080 × 2400 | 1080 × 2400 | ✅ 3.4 MB |
| `submission/cover.png` | 2400 × 1600 (3:2) | 2400 × 1600 | ✅ 1.0 MB |

Also: the renderer's 70 tests check every template × themes × SE / Pro Max / Pixel at native size, content inside safe zones, and automatic ≥ 4.5:1 contrast scrims. I looked at the final images: text is crisp and legible, content sits inside the safe band, no private data (goal title only). **Visual caveats:** the exported wallpapers show *Day 1 · 0% done* because the goal is new, and their quote line is the app's own built-from-numbers sentence, not Gemini output (§5). Device sizes for 2026 phones came from search results (apple.com was blocked) and the safe zones are estimates; check on a real phone.

## 5. Gemini integration with real API calls — **NOT VERIFIED**

No `GEMINI_API_KEY` exists in this environment, so **no real Gemini request has been made**. What is true:
- `generativelanguage.googleapis.com` is reachable from the sandbox, but without a key nothing can be called. `ai.google.dev` (docs) is **not** reachable, so schema support could not be checked against Google's docs.
- 53 integration tests drive the real Express routes and the real `@google/genai` SDK over HTTP, with MSW answering as Gemini (streaming SSE, repair call, function-calling coach, retry/backoff, timeouts, cancel, rate limit, prompt-injection delimiters). These prove **our code and the SDK request shapes**; the mock responses are written from the documented format, **not captured from Google**.
- Without a key the app says so honestly ("Gemini isn't connected"), offers the manual plan, and never fakes AI output.
- **Highest-risk unverified item:** the response schema (`responseJsonSchema`) uses `enum` dates, `format: "date"`, `minimum`/`minItems`/`maxItems` and `propertyOrdering`. If Gemini rejects any of these, planning fails. This pass removed one such risk (a nullable union type). First thing to run after adding a key: `npm run test:live`, then one plan in the app. **Update: this risk was real; Google rejected the schema with "too many states". Fixed in §14.**
- The submission description is therefore marked `[PENDING REAL GEMINI RUN …]` and `submission/CHECKLIST.md` says re-run `npm run submission` with a key.

## 6. Countdown accuracy and milestones

- `tests/unit/time.test.ts` (19): DST gap and overlap (New York, Berlin), leap day, month ends, zone change, past / same-day / midnight deadlines.
- Reviewer probed DST and extreme zones (New York, St John's, Lord Howe, London, Kiritimati): correct.
- Browser: countdown matches an independent calculation from the stored UTC deadline (within the 1-minute refresh) at all 4 widths.
- Milestones: create / edit ("Edited by you") / delete + Undo / reorder / live re-validation / approve / tick tasks → milestone and goal completion → progress, streak, pace, insights. Covered by unit tests, the acceptance journey and review-fix tests.

## 7. Security audit

| Check | Result |
|---|---|
| Secret patterns (Google key, private key, JWT, GitHub token) in tracked files | none |
| Same patterns across all 24 commits on the branch | none |
| Tracked env files | only `.env.example`, and every secret there is empty |
| `.env` ignored | yes; no `.env` exists |
| `VITE_` variables | only Supabase URL + **anon** key (public by design) |
| Client code reading `process.env` / API key / service role | none |
| Built bundle scan (`check-bundle-secrets`) | pass (55 files). **Caveat:** with no key set it matches patterns only; I proved earlier that it fails on a planted key |
| Production server logs mention key/secret/token | 0 lines |
| Security headers | CSP (`frame-ancestors 'none'`), HSTS, nosniff, COOP/CORP, `Referrer-Policy: no-referrer`; no `X-Powered-By` |
| CORS from an unlisted origin | no `Access-Control-Allow-Origin` returned |
| AI routes without key | `503 AI_NOT_CONFIGURED`, no stack trace or details leaked |
| Rate limit vs 25 spoofed IPs | 20 allowed, 6 blocked (not bypassable) |
| Wallpaper API | oversized body → 413; unknown token → 404; tokens 192-bit random, only SHA-256 hashes stored, wrong secret → 404 |
| `DELETE /api/account` | needs a valid user token; verified server-side before deleting that user only (2 tests) |
| Supabase RLS | the real migration run in PGlite: 16 tests prove cross-user reads, writes and inserts fail and `anon` sees nothing |
| `npm audit --omit=dev` | **0** vulnerabilities |
| `npm audit` (all) | 4 moderate, all one chain in dev tooling: `vite-plugin-pwa → workbox-build → glob/minimatch`. Build-time only, not shipped. npm's suggested fix is a *downgrade* (`vite-plugin-pwa@1.1.0`), so I did not apply it |

Not tested: a real Supabase project (blocked host), Upstash, and a deployed environment's header behaviour.

## 8. Production build

`rm -rf dist dist-server && npm run build` → success in **10.6 s**: typecheck → Vite build (79 precache entries, 2.3 MB) → API bundle for Vercel → secret-leak check. The bundled API (`dist-server/app.mjs`) starts under plain Node ESM and answers `/api/health` 200. `vercel.json` + `api/index.js` are ready, but **no deployment was made**.

## 9. Known limitations and remaining risks

**Needs you (cannot be done from this sandbox):**
1. **Real Gemini run.** Add `GEMINI_API_KEY`, run `npm run test:live`, then `npm run submission -- --url <live-url>` to regenerate the three submission images and description from a real plan. Replace `[DEVELOPER: write your own lesson]` yourself.
2. **Deploy** (`docs/SETUP.md`, ~5 min on Vercel; Cloud Run fallback documented, needs `TRUST_PROXY=1`). Set `GEMINI_API_KEY`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, and ideally Upstash (otherwise rate limits and Living Wallpaper links live in memory on serverless; the app warns about this).
3. **Supabase** (optional): run the migration, add the redirect URL, set the two public env vars. Sync and account deletion are untested against a real project.

**Known limitations:**
- Empty-dashboard performance 85 (cold profile); 3D hero and Studio chunks are large but lazy/not precached.
- Remaining design-critique items in §2 (consistency polish, not functional).
- Web Push is not built (needs VAPID keys); in-app and local notifications work.
- Living Wallpaper text is Latin-only on the server renderer; safe zones are estimates.
- Wallpapers need a manual one-time setup on the phone: a website cannot change a lock screen (the app says so).
- The Santiago DST-midnight edge (§2).
- **Repository weight:** resolved by the migration. This repository has a fresh history and a ~11 MB working tree. The ~490 MB of historical render and screenshot data stayed in the original repository.
- Evidence screenshots show test-fixture text ("Fixture…", `gemini-e2e-mock`); they are test data, not Gemini output.

## 10. Provenance and repository state

- Source: the verified tree of the original development branch (commit `ee2b0e9`), carried over as this repository's root. **Nothing from the cricket-analytics project was transferred** (checked in §11).
- Left behind on purpose: `docs/evidence/` (generated screenshots and sample renders, ~28 MB) and a stray `_archive/` file.
- Original development repository: untouched (no branch rewritten, deleted or merged).
- Still to do before treating the submission as final: the real-Gemini run (§5, §9).

## 11. Re-verification after migration to this repository

Run 2026-11-23 05:49 UTC from a **fresh clone** of `https://github.com/dakshsharma08/LOCKSTEP` at commit `26a0d01` (nothing but what is on GitHub: `npm ci`, no cached files).

| Check | Command | Result |
|---|---|---|
| Install from lockfile | `npm ci` | 841 packages, OK |
| Typecheck | `npx tsc -b` | clean |
| Lint | `npx eslint .` | clean |
| Unit + integration | `npx vitest run` | **249 passed, 3 skipped** (16 files passed, 1 skipped) |
| Production build | `npm run build` | OK in 10.5 s, secret-leak check passed |
| Browser E2E + accessibility | `npx playwright test --trace off` | **20 / 20 passed** at 360 / 390 / 430 / 1440 px |
| Working tree after install, build and tests | `git status` | clean (all generated output is git-ignored) |

The 3 skipped tests are the live Gemini smoke tests (`tests/live/gemini.live.test.ts`), reported as SKIPPED rather than passed because no `GEMINI_API_KEY` is set: `health resolves a real model`, `streams a plan that passes every hard check`, `writes a motivation line and answers a coach question with tools`. Run them with `GEMINI_API_KEY=… npm run test:live`.

Migration checks: 174 files / ~10 MB; no secret patterns; `.env.example` has no values; no cricket-project keywords; **0** file blobs in common with the original repository's non-LOCKSTEP files.

## 12. First real-key run: planning timed out (found by the owner after §11)

The owner's first run with a real key failed: planning stopped after ~30 s with *"Gemini took too long. No first chunk within 30 s."* (model `gemini-3.8-flash`). This is exactly the risk flagged in §5, and it confirms that the mocked tests could not catch it.

- **Not the model name:** `gemini-3.8-flash` is a real GA model; a bad name would fail at once with a 404.
- **Most likely cause:** plan requests never set a thinking level, so the model used its default silent thinking and sent nothing for 30+ s. **This was inferred from the code and the symptom, not reproduced** (no key in the build environment).
- **Fix:** explicit LOW thinking level for planning, a one-time fallback if Google rejects thinking settings, phase-specific timeout messages, an `ai_diag` log line with timings and Google's redacted error text, and `npm run diagnose:gemini` (see `docs/SETUP.md`, Troubleshooting). The timeout was not raised.
- **Regression tests:** `tests/integration/gemini-first-chunk.test.ts` (the real SDK against a local fake Gemini over real HTTP/SSE reproduces silent thinking, a never-answering network, thought-summary first chunks, a thinking-field 400 with fallback, and key redaction), `tests/integration/diagnose.test.ts`, `tests/unit/thinking.test.ts`.
- **Still unverified until you run it:** that the fix removes the timeout against real Google. Run `npm run diagnose:gemini`.

## 13. Gemini returned HTTP 503 for every generation request: model fallback

After the diagnostic fixes (§12), the owner's real-key run showed the key valid, Google reachable, `gemini-3.8-flash` listed, and **every generation request returning 503 UNAVAILABLE** ("high demand") on both `v1` and `v1beta`, with LOW thinking and with no thinking config. That is capacity on Google's side, not a defect in this app.

- **Change:** a capped model fallback (see `docs/SETUP.md` and `docs/DECISIONS.md`): primary kept, one retry, at most two alternatives chosen from the key's live model list, never more than 4 upstream calls per plan, permanent errors never retried elsewhere, total failure reported honestly.
- **Tested (local fake Gemini over real HTTP, real SDK):** primary 503 → fallback succeeds with the plan fully validated; first fallback also 503 → next one used; stall → fallback; retired fallback (404) skipped; all models 503 → AI_BUSY with one detail line per model and exactly 4 calls; call cap holds for long fallback lists; 400/403 are not retried elsewhere; the model list cached before an outage is reused while the list endpoint itself returns 503; no key in any log or response. Verified to fail when the fallback logic or the call cap is broken.
- **NOT verified against real Gemini.** No key exists in the build environment, so no fallback has run against a real Google response. `npm run diagnose:gemini` now sends a real request to each alternative and runs the full planning flow, so the owner can see real results: `FALLBACK READY` plus a plan `written by <model> after falling back` is the evidence. Which alternatives exist today is decided by the key's live model list, which I could not see.
- **Real diagnostic results reported by the owner (their run, not mine), 2026-11-23:** `gemini-3.8-flash` HTTP 503; `gemini-3.7-flash` 503 / timeout; `gemini-2.5-flash` HTTP 404 (unavailable to new users); `gemini-3.6-flash` success in 5 s; `gemini-3.5-flash` success in 23.2 s. The default chain was changed to `gemini-3.6-flash` then `gemini-3.5-flash`, with 3.7 and 2.5 excluded. The order is tested against a local fake that lists all five models (3.7 and 2.5 are never called). That the *whole planning flow* completes through the fallback on the owner's key has still to be confirmed with `npm run diagnose:gemini` (step 6) or a real plan.
- **Known limits:** if every model is overloaded the fallback cannot help (users report 503s across models); an alternative may produce a plan of lower quality (the code validation and one repair call still apply); the coach, motivation line and weekly summary do not fall back.

## 14. Gemini rejected the plan schema: HTTP 400 "too many states for serving"

The owner's real-key run of commit `7083e99` (their run, not mine): `gemini-3.8-flash` HTTP 429 (free-tier quota, limit 20); a simple request to `gemini-3.6-flash` OK in 8.6 s and to `gemini-3.5-flash` OK in 10.2 s; the full planning request to **both** returned HTTP 400 "The specified schema produces a constraint that has too many states for serving". The app then reported "Gemini is very busy (3 models tried)", which was wrong.

- **Root cause 1 (schema):** Gemini compiles `responseJsonSchema` into a state machine. The plan schema combined bounded arrays (`milestones` 1–12 with nested `tasks` 1–8: the item is copied per allowed count, ~96 task copies), a date `enum` of up to 90 values inside every milestone, number ranges (`estimatedMinutes` 5–600, `estimatedHours` ≥ 0.25) and `format: "date"`, all multiplied by the nesting. **Fix:** the Gemini-facing schema keeps every field, type, `required`, `propertyOrdering` and the two 3-value enums, and drops `minItems`/`maxItems`, `minimum`/`maximum`, `format` and the date enum. Those rules are in the field descriptions and the prompt (which already lists the allowed dates), and the server still enforces all of them (zod `PlanSchema` + `validatePlan`, then one repair call). Trade-off: the model can now write a wrong date; validation catches it and the repair call fixes it.
- **Root cause 2 (error handling):** an alternative model's failure was always "skip to the next model", so a permanent 400 was hidden behind "very busy". **Fix:** an alternative is skipped only for a temporary error (429/5xx/no answer) or a 404; any other error stops the chain and is reported as is, with the earlier attempts listed. A 400 that names the schema now says "Gemini rejected LOCKSTEP's plan format (HTTP 400: the response schema is too complex for this model)" (code `INTERNAL`, not retryable), never `AI_BUSY`, and it is not mistaken for a thinking-settings rejection.
- **Diagnostic:** `npm run diagnose:gemini` now sends the real plan request (prompt + schema) to each alternative and prints `PLAN SCHEMA OK on <model>` or `SCHEMA TOO COMPLEX`; a 429 is reported as `QUOTA / RATE LIMIT`, and after a 429/503 on the primary the remaining thinking variants are skipped so the diagnostic does not burn quota.
- **Tested (local fake Gemini over real HTTP, real SDK):** the fake now rejects schemas containing the constructs Google lists as typical causes (an approximation; Google's real limit is a state count we cannot see), and the app's schema passes it on every request; 429 on the primary → 3.6 accepts the schema → validated plan; 3.6 busy → 3.5 gets the identical schema; 429 then 400 on 3.6 → accurate error, 3.5 never called; 400 on the primary → no retry, no fallback; every rule removed from the schema is still rejected by server validation. Mutation-checked: restoring a bounded array, the old fallback rule or the old 400 message each makes tests fail.
- **NOT verified against real Gemini.** Whether 3.6 and 3.5 accept the new schema is decided by Google; `npm run diagnose:gemini` (`PLAN SCHEMA OK on …` and `FULL FLOW OK`) is the evidence.

## 15. Quota 429 on the primary, a stalled fallback, a slow repair: Stage 1

The owner's real-key run of `ba2deac` (their run, not mine): `gemini-3.8-flash` HTTP 429 (free-tier quota); `gemini-3.6-flash` answered small requests but its plan stream stalled after 13 chunks and the full `/api/plan` flow ended in TIMEOUT; `gemini-3.5-flash` accepted the plan schema and wrote valid JSON in 78.3 s.

- **Why the flow failed:** the app allows 30 s to the first chunk, 30 s between chunks and 120 s per stream, and does not retry once output has started; and since `ba2deac` a non-temporary error on an alternative (which includes a timeout after output started) stops the chain, so 3.5 was never tried. Why 3.6 went silent is not proven: the logs did not record per-chunk timing or thinking vs text. Stage 1 adds exactly that, so the next run can tell a thinking pause from a stopped answer.
- **Changes:** fallback order `gemini-3.5-flash` → `gemini-3.6-flash`; no same-model retry for a quota-exhausted 429 (503/500 and other 429s keep theirs; it still falls back); repair gets 120 s and the plan's thinking level (LOW) instead of 30 s and the model default; one plan request is limited to 270 s in total (no new model or repair is started with < 30 s left), which keeps the worst case under Vercel's 300 s; the diagnostic applies `GEMINI_MODEL_FALLBACKS` / `GEMINI_THINKING_LEVEL` in every step (the full-flow step ignored them), runs the app's own thinking setting first, uses the app's 120 s stream cap, and reports thinking vs text chunks, last-chunk time and longest gap, with `STREAM STALL`, `THINKING STALL` and `LONG PAUSE` verdicts. The app's `ai_diag` line carries the same chunk fields.
- **Tested (local fake Gemini over real HTTP, real SDK; timings scaled down):** quota 429 → exactly one primary call → 3.5; plain 429 and 503 still retried once; quota 429 on all models → 3 calls, honest AI_BUSY; a repair slower than the small-call limit succeeds (and fails with the old limit, as a control); the repair uses the plan model and `{ thinkingLevel: LOW }`; the time limit stops a never-answering model with an honest TIMEOUT and no further model; no fallback or repair is started with too little time left; worst-case numbers checked against `vercel.json`; diagnostic env, chunk statistics and all three stall verdicts.
- **Not verified against real Gemini.**

## 16. Start over on another model after a mid-answer stall, with a `reset` event: Stage 2

- **Change:** a model that stalls after it started answering (no chunk for 30 s, or its own 120 s stream limit) is abandoned and the next model is tried, within the 4-call cap and the 270 s plan limit. Before the next model's request is sent, the server emits `reset`; the planning page then clears the half-shown milestones and feasibility. Only the successful attempt's text is validated, repaired, saved or returned. 400 and 403 never trigger a fallback; the plan time limit is never treated as a stall.
- **Tested:** unit (the stall rule: gap or stream cap after output = stall; plan time limit, first-chunk waits, no-phase timeouts, 400/403 = not; stall on primary or alternative moves on; stalls everywhere stop at 3 models); integration over real HTTP (primary streams part of a STALE plan then stalls → `reset` comes before anything from the next model, the status line follows it, nothing STALE after it, the result contains nothing STALE, validated once, no repair; thinking-only stall; 429 → 3.5 stalls → 3.6 writes the plan with two resets in order; all stall → honest error with 3 calls; 400 and 403 → no fallback and no reset; a 400 after a 429 stops the chain; too little time left → no next model; plan time limit mid-stream → TIMEOUT, no reset); browser (all four widths): the stale preview is visible, then after the switch and BEFORE the next model sends anything the page shows nothing stale (milestones, reason, "Gemini: Tight" badge), then the next model's plan is saved with nothing stale.
- **A test that first proved too weak:** the first version of the browser test passed against a build WITHOUT the page's reset handler, because the next model's milestones eventually overwrote the stale ones. It now checks the 1.5 s gap before the next model's first chunk; it fails against the old build and passes against the new one. Server-side mutations (no stall rule, no reset, reset after the status line, plan limit treated as a stall) each fail the tests.
- **E2E harness:** the Playwright mock now serves Gemini from a local HTTP server instead of MSW (MSW 3 + Node 22 crash when a mocked response body is aborted; reproduced in isolation). All earlier browser tests pass unchanged.
- **NOT verified against real Gemini.**

## 17. Transport investigation: SDK streaming vs raw REST vs non-streaming

Goal: a reliable plan without lowering its quality. No real API calls were used (free-tier quota); everything below is measured with the real `@google/genai` 3.6.1 SDK against a local server that behaves like Google in each scenario, or read from the SDK source.

| Scenario | SDK stream | Raw REST stream | Consequence |
|---|---|---|---|
| Events 1 s apart | delivered at 25 / 1022 / 2024 ms | 5 / 1006 / 2006 ms | no buffering in the SDK |
| 3 s gap kept alive by SSE comments | nothing for 3 s | 3 comment reads | the SDK hides keep-alives; a live connection can look silent |
| Server ends a hop with `CONTINUATION` + token | 2 HTTP requests, the reconnect shows as a pause | stream ends; resuming is our job | hidden extra requests; reconnects count against the gap limit |
| Clean close, no `finishReason` | ends **without an error** | same | a cut-off answer looked complete (fixed) |
| `finishReason: MAX_TOKENS` | yielded, no error | — | was ignored (fixed) |
| Error event mid-stream | throws ApiError 503 | sees it | already mapped to a fallback |
| Non-streaming | all data at the end | — | no progress; a stall is only detected at the total timeout |

Also from the source: the SDK retries HTTP errors only when `httpOptions.retryOptions` is set (we don't), so there are no hidden SDK retries; automatic continuation is on by default and applies to the Gemini Developer API.

Sizes (the app's own prompt builders): input ≈ 1,400 tokens; a rich plan (7 milestones × 5 tasks) ≈ 1,650 output tokens compact, ≈ 2,270 pretty-printed. 78 s for one plan on `gemini-3.5-flash` therefore means ~20–30 output tokens/s plus thinking: slow generation on Google's side (or long thinking), not the prompt.

- **Confirmed:** SDK streaming is not the bottleneck and does not buffer; our code accepted cut-off answers; the SDK can add hidden requests and pauses (continuation) and hides keep-alive comments.
- **Not confirmed (needs one real diagnostic run):** why `gemini-3.6-flash` went silent after 13 chunks: a thinking pause, a continuation reconnect, keep-alives during a live connection, or slow generation. The diagnostic now distinguishes all four (THINKING STALL / CONTINUATION / KEEP-ALIVES / STREAM STALL, plus SPEED).
- **Changed:** answers are used only with `finishReason STOP` (cut-off → next model, `reset` reason `incomplete`, never validated or repaired); `ai_diag` logs `finishReason`, `hops` and prompt/output/thinking tokens; the diagnostic adds a wire probe and the four verdicts; an all-models failure says "busy" only when every model was busy.
- **Tested:** cut-off (no finish, MAX_TOKENS) → next model with no repair; all cut off → honest message; continuation across 2 hops completes and is logged; a resume slower than the gap limit becomes a stall; diagnostic wire probe (requests, bytes, comments), CUT OFF, CONTINUATION, KEEP-ALIVES, SPEED. Mutation-checked.
- **NOT verified against real Gemini.**

## 18. Default primary model: `gemini-3.1-flash-lite`

- **Real evidence (the owner's Windows run, not mine):** `gemini-3.1-flash-lite` generated a valid plan; the complete `/api/plan` flow passed in 7.3 s with 7/7 code checks. The larger Flash models had used up their free-tier quotas.
- **Change:** without `GEMINI_MODEL`, the app uses `gemini-3.1-flash-lite` if the key lists it, otherwise the newest stable Flash model (as before); if listing fails, the default. `GEMINI_MODEL` and `GEMINI_MODEL_FALLBACKS` still override. Fallbacks, retries, time limits, prompt, schema and validation are unchanged. No key in code.
- **Tested:** the selection rule (listed, not listed, no usable model, listing failed, custom default); `ModelResolver` (GEMINI_MODEL wins; default; old rule on a key without it; listing failure; fallbacks after the default are 3.5 then 3.6); `/api/health` reports the default, GEMINI_MODEL overrides it, listing failure gives the default; a full plan is written by the default with LOW thinking in one call; default busy → `gemini-3.5-flash` with a reset; the diagnostic picks and names the same model. Mutation-checked.

## 19. Production debugging: structured Gemini failure logs

- **Reported (production, Vercel):** `POST /api/plan` 200, `ai_run` with `gemini-3.1-flash-lite`, 766 ms, `ok:false`, `tokens:null`; the page showed "Gemini status 400"; the logs did not show Google's reason.
- **Finding (reproduced locally):** Google's message WAS logged, but in a separate `ai_diag` line, not in the `ai_run` line; Google's structured details (reason, field violations, quota) were dropped; the 200 is the event stream's status (the error is an event inside it); the 400 message ("try a different file") and the card's "What failed the checks" label were misleading. A single `ai_run` line (no thinking retries) means Google's 400 did NOT name the thinking settings. **The exact root cause of the production 400 can't be identified from the evidence given**; the new `ai_error` line will name it (e.g. `googleReason: API_KEY_INVALID`, or a `fieldViolations` entry).
- **Change:** `ai_error` (one per failed request) and `api_result` (one per plan) log lines; `googleErrorInfo` parser; upstream 400 → `INTERNAL`, status 502, honest message; `ApiError.status`; error card title/label.
- **Tested:** parser on realistic Google bodies (invalid key, bad request, quota, echoed key, long text, no body, our own error); over real HTTP: a 400 logs one `ai_error` with all fields and the thinking setting, one `api_result` (200 stream, error 502, upstream 400), the browser gets status 502 and Google's reason; invalid key → `API_KEY_INVALID`, 503, and the project number is not logged; quota 429 → quota id + retry delay, then the next model; a stall → stage `streaming`, chunk counts, no Google fields; success → no `ai_error`, `api_result` ok; no key, goal or constraint text in any log line; browser (4 widths): the card shows "Gemini rejected the request", the honest message and Google's reason under "Technical details". Mutation-checked.

