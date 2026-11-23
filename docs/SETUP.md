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
3. Optional: `GEMINI_MODEL` (leave it empty and the server picks the newest stable Flash model your key can use) and `GEMINI_MODEL_HEAVY` (a Pro model for coach replanning; it falls back to the default model on failure).
4. Check it: `curl localhost:8787/api/health` should show `"configured": true`.
5. Run the live smoke test: `npm run test:live`. Without a key it reports **SKIPPED**, never PASSED.

### Troubleshooting: "Gemini took too long" / planning fails after ~30 s

Run the diagnostic. It makes **real** calls to Google with your key (never printed), from the cheapest test to the full planning flow, and tells you which problem it found:

```bash
npm run diagnose:gemini                       # uses GEMINI_API_KEY from .env
npm run diagnose:gemini -- --model gemini-3.8-flash --api-version v1beta
```

| It says | What it means | Fix |
|---|---|---|
| `NETWORK PROBLEM` | This machine gets no HTTP response from Google. Not the model, not the app. | VPN / proxy / firewall / DNS / IPv6. Behind a proxy: set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`. For IPv6 trouble: `NODE_OPTIONS=--dns-result-order=ipv4first`. |
| `KEY PROBLEM` | Google answered but rejected the key. | Check `GEMINI_API_KEY`; make sure the Gemini API is enabled for that key. |
| `MODEL NOT AVAILABLE` | The model isn't listed for your key. | Set `GEMINI_MODEL` to a listed model, or leave it empty to auto-pick. |
| `ROOT CAUSE (thinking latency)` | Google accepted the request but the model thought silently past the 30 s limit. | Fixed by default (planning asks for a LOW thinking level). Tune with `GEMINI_THINKING_LEVEL`. |
| `API VERSION` | Requests work on `v1beta` but not `v1`. | `GEMINI_API_VERSION=v1beta`. |
| `REQUEST REJECTED` | Google answered HTTP 400 for the plan request; the exact reason is printed. | That reason names the offending field. |

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
