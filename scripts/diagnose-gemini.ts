/**
 * npm run diagnose:gemini [-- --model gemini-3.8-flash] [--api-version v1beta] [--skip-plan] [--plan-timeout 90]
 *
 * Makes REAL calls to Google with the GEMINI_API_KEY from your .env (never printed) and tells you
 * why planning is slow or failing. See server/gemini/diagnose.ts for what each step does.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runDiagnostics } from '../server/gemini/diagnose';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set. Put it in .env (see .env.example) and run this again.');
  process.exit(2);
}

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const sdkVersion = (createRequire(import.meta.url)('@google/genai/package.json') as { version: string })
  .version;

console.log('LOCKSTEP · Gemini diagnostic (real API calls; your key is never printed)\n');
const report = await runDiagnostics({
  apiKey,
  sdkVersion,
  model: arg('model'),
  apiVersion: arg('api-version') ?? process.env.GEMINI_API_VERSION?.trim() ?? undefined,
  skipPlan: args.includes('--skip-plan'),
  planTimeoutMs: arg('plan-timeout') ? Number(arg('plan-timeout')) * 1000 : undefined,
  onLine: (l) => console.log(l),
});

const bad =
  report.reach.every((r) => !r.ok) || report.flow?.ok === false || report.plan.every((p) => !p.timing.ok);
process.exit(bad ? 1 : 0);
