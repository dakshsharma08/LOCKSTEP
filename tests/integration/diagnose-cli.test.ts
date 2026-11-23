/**
 * REGRESSION: run the REAL `scripts/diagnose-gemini.ts` as a separate process.
 *
 * `npm run diagnose:gemini` once crashed at startup (ERR_PACKAGE_PATH_NOT_EXPORTED) in a line that no
 * test executed, because the library had tests but the CLI wrapper around it did not. This test runs
 * the wrapper end to end, against the local fake Gemini (via --base-url), so it never needs a key or
 * the internet.
 */
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { packageVersion } from '../../server/lib/packageVersion';
import { startFakeGemini, type FakeGemini } from '../helpers/fakeGemini';

// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY = `${['AI', 'za'].join('')}SyFAKE-cli-test-key-0123456789abcdef`;
let fake: FakeGemini | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function runCli(args: string[], env: Record<string, string | undefined>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/diagnose-gemini.ts', ...args],
      {
        cwd: process.cwd(),
        // 127.0.0.1 must never go through a developer's proxy (NODE_USE_ENV_PROXY): the fake is local.
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...env },
        timeout: 90_000,
        windowsHide: true,
      },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` }),
    );
  });
}

// Deliberately no "no key set" test: the CLI loads ./.env, which on a developer's machine holds a REAL key,
// so such a test could end up making a real call. The key in this test is non-empty, and a variable that is
// already set always wins over .env.
describe('diagnose:gemini CLI (end to end, local fake Gemini)', () => {
  it('starts, prints the real SDK version, runs every step and exits 0 on a healthy connection', async () => {
    fake = await startFakeGemini(() => ({}));
    const { code, out } = await runCli(['--base-url', fake.baseUrl, '--model', 'gemini-3.8-flash'], {
      GEMINI_API_KEY: KEY,
    });

    expect(out).not.toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED|Error \[/);
    const sdk = /@google\/genai (\S+) /.exec(out)?.[1];
    expect(sdk).toBe(packageVersion('@google/genai')); // the real version, not "unknown"
    expect(sdk).toMatch(/^\d+\.\d+\.\d+/);
    expect(out).toContain('[1/5] Reaching Google');
    expect(out).toContain('[4/5] The complete planning flow');
    expect(out).toContain('[5/5] Diagnosis');
    expect(out).toMatch(/FULL FLOW OK/);
    expect(out).not.toContain(KEY); // the key is never printed
    expect(code).toBe(0);
  }, 90_000);
});
