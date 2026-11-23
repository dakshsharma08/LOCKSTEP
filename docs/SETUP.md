# LOCKSTEP — Setup, keys and deployment

Everything in the app works as a guest, offline, with no keys at all: the manual plan, the countdown, Focus Mode, the Studio, PNG export, Insights and Settings. The AI features (planning, coach, motivation line, weekly summary) need a Gemini API key on the **server**.

> Why the manual steps? This project was built in a cloud sandbox with no Gemini key, and its network policy blocks `api.vercel.com` and `supabase.com`. The code is ready; the steps below are the only things a human has to do.

---

## 1. Run it locally (2 minutes)

```bash
git clone https://github.com/dakshsharma08/LOCKSTEP.git
cd LOCKSTEP
npm ci
cp .env.example .env          # then put your key in .env (step 2)
npm run dev                   # web on http://localhost:5173, API on :8787
```

Production-like run (one Node process that serves the built app and the API):

```bash
npm run build && npm start    # http://localhost:8080
```

## 2. Add your Gemini key (required for AI)

1. Create a key at **https://aistudio.google.com/apikey**.
2. Put it in `lockstep/.env`:
   ```
   GEMINI_API_KEY=your-key-here
   ```
   Do **not** prefix it with `VITE_`: anything with that prefix is shipped to browsers. `npm run build` fails if the key ever appears in `dist/` (`scripts/check-bundle-secrets.mjs`).
3. Optional: `GEMINI_MODEL` (leave it empty and the server uses the default `gemini-3.5-flash-lite` if your key lists it, otherwise the newest stable Flash model your key can use) and `GEMINI_MODEL_HEAVY` (a Pro model for coach replanning; it falls back to the default model on failure).
4. Check it: `curl localhost:8787/api/health` should show `"configured": true`.
5. Run the live smoke test: `npm run test:live`. Without a key it reports **SKIPPED**, never PASSED.

### Troubleshooting: "Gemini took too long" / planning fails after ~30 s

Run the diagnostic. It makes **real** calls to Google with your key (never printed), from the cheapest test to the full planning flow, and tells you which problem it found:

```bash
npm run diagnose:gemini                       # uses GEMINI_API_KEY from .env
npm run diagnose:gemini -- --model gemini-3.8-flash --api-version v1beta
```

The diagnostic uses the same `GEMINI_MODEL_FALLBACKS` and `GEMINI_THINKING_LEVEL` as the app (from `.env` or the shell) in every step, including the full `/api/plan` flow.

| It says | What it means | Fix |
|---|---|---|
| `NETWORK PROBLEM` | This machine gets no HTTP response from Google. Not the model, not the app. | VPN / proxy / firewall / DNS / IPv6. Behind a proxy: set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`. For IPv6 trouble: `NODE_OPTIONS=--dns-result-order=ipv4first`. |
| `KEY PROBLEM` | Google answered but rejected the key. | Check `GEMINI_API_KEY`; make sure the Gemini API is enabled for that key. |
| `MODEL NOT AVAILABLE` | The model isn't listed for your key. | Set `GEMINI_MODEL` to a listed model, or leave it empty to auto-pick. |
| `ROOT CAUSE (thinking latency)` | Google accepted the request but the model thought silently past the 30 s limit. | Fixed by default (planning asks for a LOW thinking level). Tune with `GEMINI_THINKING_LEVEL`. |
| `API VERSION` | Requests work on `v1beta` but not `v1`. | `GEMINI_API_VERSION=v1beta`. |
| `OVERLOADED` / `FALLBACK READY` | Google answered HTTP 503 ("high demand") for your model, and the alternative named in the next line answered. | Nothing to do: planning falls back automatically. Re-run later to see if the primary recovered. |
| `NO WORKING ALTERNATIVE` | The primary and every alternative returned 503 right now. | Wait a few minutes and retry. Or name other models: `GEMINI_MODEL_FALLBACKS=model-a,model-b` (use the list the diagnostic printed). |
| `REQUEST REJECTED` | Google answered HTTP 400 for the plan request; the exact reason is printed. | That reason names the offending field. |
| `SCHEMA TOO COMPLEX` | Google rejected the plan's response schema (HTTP 400 "too many states"). Another model will not help. | A bug in this app's request: report it with the printed reason. |
| `STREAM STALL` / `THINKING STALL` | A model accepted the plan request, sent some chunks, then went silent. The line shows how many chunks were thinking vs plan text, and for how long it was silent. | THINKING STALL: try `GEMINI_THINKING_LEVEL=minimal`. STREAM STALL: Google-side; put another model first with `GEMINI_MODEL_FALLBACKS`. |
| `CUT OFF` | The answer ended without `finishReason STOP` (output limit, or the stream closed early). The app never uses such an answer; it starts over on the next model. | Report it with the printed token counts. |
| `CONTINUATION` | Google split a long answer into several requests; the SDK resumed automatically. Each resume is a pause and an extra request against the quota. | Informational. If its pauses are long, they show up as stalls. |
| `KEEP-ALIVES` | The connection carried SSE comment lines the SDK hides; with "the connection was still sending" a reported stall was a live connection. | Report it: the app's gap timer would then need to count bytes, not chunks. |
| `SPEED` | First text time, output tokens, tokens/s and thinking tokens for a plan request. | Informational: tells slow thinking from slow writing. |
| `LONG PAUSE` | The request finished, but paused longer between two chunks than the app allows (30 s). | Same as STREAM STALL. |
| `QUOTA / RATE LIMIT` | Google answered HTTP 429 for your model (for example the free-tier daily limit). | Planning falls back to the alternatives automatically; the quota resets later. |
| `PLAN SCHEMA OK on <model>` | That alternative accepted the real plan request (prompt + schema). | Nothing to do. |

**Model fallback (503 "high demand").** The primary is `GEMINI_MODEL`, or by default `gemini-3.5-flash-lite`. If it is *temporarily* unavailable (HTTP 503/500/502/504/429, or Google accepts the request but never answers), planning retries it once (not when the 429 says the quota is used up: that retry could not succeed) and then tries up to two alternatives, and never makes more than **4 upstream calls** per plan. A whole plan request, all models and the repair together, is stopped with an honest TIMEOUT at **270 s** (under Vercel's 300 s limit), and no new model or repair is started with less than 30 s left. The repair call gets 120 s and the same LOW thinking level as the plan. By default the alternatives are `gemini-3.1-flash-lite` first, then `gemini-3.5-flash` (both have produced valid plans), but only if your own key lists them (so a model Google retires drops out by itself); `gemini-3.6-flash`, `gemini-3.7-flash` and `gemini-2.5-flash` are left out of the automatic chain, and previews, aliases and image models are never picked. If one of the two is missing from your key's list, a free slot is filled with the newest other stable Flash model. Override with `GEMINI_MODEL_FALLBACKS=a,b` or turn off with `none`. Permanent errors (400, 401/403, 404 on the primary) are shown as they are and never retried on another model; on an alternative, only a temporary error or a 404 moves on to the next model, anything else (such as a 400 schema rejection) is reported as it is. A model that **stalls mid-answer** (no new chunk for 30 s, or its own 120 s stream limit used up) is abandoned and the next model starts from scratch, within the same 4-call cap: the browser first receives a `reset` event and clears the half-shown milestones and feasibility, and nothing from the abandoned attempt is validated or saved. If everything is busy, the app says so honestly and your saved plan keeps working. The plan is validated exactly the same whichever model wrote it, and the "Generated by Gemini" label names the model that really produced it.

The server log also helps. Every Gemini call writes an `ai_run` line **and** an `ai_diag` line with where the time went (`headersMs` = Google's HTTP response arrived, `firstChunkMs` = first data, `firstTextMs` = first visible text), the HTTP `status` and Google's own error text (secrets redacted). The in-app error says which wait timed out: *"Google didn't answer the request"* (network) versus *"Gemini accepted the request but sent no output"* (the model is thinking).

## 3. Deploy to Vercel (frontend + API in one project)

The repo is already set up for Vercel: `vercel.json` rewrites `/api/*` to the Express app in `api/index.js` (which imports the API bundled by `npm run build`) and serves the SPA for every other route.

1. Install the CLI and log in: `npm i -g vercel && vercel login`.
2. From the repository root: `vercel link` (create a new project; the root directory is the repo root).
3. Add the environment variables (Production + Preview):
   ```bash
   vercel env add GEMINI_API_KEY
   vercel env add ALLOWED_ORIGINS        # e.g. https://your-app.vercel.app
   vercel env add PUBLIC_APP_URL         # e.g. https://your-app.vercel.app
   # optional, recommended on serverless:
   vercel env add UPSTASH_REDIS_REST_URL
   vercel env add UPSTASH_REDIS_REST_TOKEN
   ```
4. Deploy: `vercel --prod`. Build command `npm run build`, output `dist`. Both are picked up from `package.json` and `vercel.json`.
5. Open `https://<your-app>/api/health` and confirm Gemini is `configured`.

**Fallback: Google Cloud Run** (if Vercel isn't an option). `server/prod.ts` serves `dist/` and the API from one container:

```bash
gcloud run deploy lockstep --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=...,TRUST_PROXY=1,ALLOWED_ORIGINS=https://<service-url>,PUBLIC_APP_URL=https://<service-url>
```

(Cloud Run builds with Google's Node buildpack: `npm run build`, then `npm start`. `TRUST_PROXY=1` lets rate limiting see the real client IP behind Google's front end. Without it, all clients share one bucket, which is safe but strict.)

### Troubleshooting a failed plan in production (Vercel logs)

`/api/plan` answers as an event stream, so Vercel shows **200** even when planning failed: the error travels inside the stream. In the runtime logs, search for:

- `api_result`: one line per plan request with the real outcome (`"outcome":"error"`, `code`, `errorStatus`, `upstreamStatus`, `modelsTried`).
- `ai_error`: one line per failed Gemini request with `model`, `stage` (`http-error`, `waiting-for-first-chunk`, `streaming`, `incomplete-answer`…), `httpStatus`, `googleStatus`, `googleMessage`, `googleReason` (e.g. `API_KEY_INVALID`), `fieldViolations`, `quotaIds`, `retryDelay`, and the app's `appCode`/`appStatus`.

These lines never contain the API key, the prompt or the user's goal. Typical readings: `googleReason: API_KEY_INVALID` → fix `GEMINI_API_KEY` in Vercel (no quotes, Production scope) and redeploy; `httpStatus: 404` → the model isn't available to this key (set `GEMINI_MODEL`); `httpStatus: 429` + `quotaIds` → free-tier quota; a 400 with `fieldViolations` → a request field this model/API version rejects (compare `GEMINI_API_VERSION` locally and on Vercel).

## 4. Durable rate limiting + Living Wallpaper storage (recommended for serverless)

Serverless instances don't share memory, so in-memory rate limits and wallpaper links don't survive between requests. Create a free **Upstash Redis** database (https://console.upstash.com), copy the REST URL and token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, and redeploy. `GET /api/health` then reports `"rateLimit": "upstash"` and `"wallpaperStore": "upstash"`.

## 5. Optional: Supabase (cloud sync, sign-in, ai_runs logging)

1. Create a project at https://supabase.com.
2. Run `supabase/migrations/*.sql` in the SQL editor. This creates the tables with Row Level Security on every one.
3. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (public by design; RLS protects the data) and, server-only, `SUPABASE_SERVICE_ROLE_KEY`.

## 6. Regenerate the submission assets from a real Gemini run

With the key in `.env`:

```bash
npm run submission -- --url https://<your-live-url>
```

This starts the app, creates the sample goal through the **real** Gemini planner, approves it, exports the lock screens from the real Studio, captures the 2400×1600 cover, writes `submission/description.txt` from the real run (milestone count, goal), verifies every PNG's pixel size, and prints the character count. Then write your own lesson in `description.txt` where it says `[DEVELOPER: write your own lesson]`.

## 7. iPhone "Living Wallpaper" automation (for users)

Studio → Export → **Create Living Wallpaper link**. Then in Shortcuts → Automation → + → Time of Day (e.g. 06:00, daily, Run Immediately) → add **Get Contents of URL** (paste the link) → add **Set Wallpaper** (Lock Screen, Show Preview off). LOCKSTEP never changes the phone by itself; the user sets this up once.
