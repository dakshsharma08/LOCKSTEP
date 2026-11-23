/**
 * The build's secret-leak guard (scripts/check-bundle-secrets.mjs) must find dist/ and .env from ITS OWN
 * location, on every OS, and must still catch leaks.
 *
 * Regression: on Windows it derived the project root with `new URL('..', import.meta.url).pathname`,
 * which is "/C:/…" there, so `npm run build` failed with "dist/ not found" right after Vite had built
 * dist/, and .env (hence the GEMINI_API_KEY value check) could not be read either.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(repo, 'scripts/check-bundle-secrets.mjs');
// Built at runtime: a key-shaped literal in source could trip GitHub secret scanning.
const KEY_SHAPED = `${['AI', 'za'].join('')}${'x'.repeat(35)}`;

let project: string | null = null;
afterEach(() => {
  if (project) rmSync(project, { recursive: true, force: true });
  project = null;
});

/** A throwaway project: <tmp>/scripts/check-bundle-secrets.mjs (the real script) + <tmp>/dist/… */
function fakeProject(files: Record<string, string>, env?: string) {
  project = mkdtempSync(join(tmpdir(), 'lockstep-secrets-'));
  mkdirSync(join(project, 'scripts'));
  copyFileSync(SCRIPT, join(project, 'scripts/check-bundle-secrets.mjs'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  if (env !== undefined) writeFileSync(join(project, '.env'), env);
  return project;
}

/** Run the script from a DIFFERENT working directory, with no inherited secrets. */
function run(dir: string) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/check-bundle-secrets.mjs')], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-bundle-secrets: finds dist/ and .env from its own location', () => {
  it('a clean bundle passes, whatever the working directory', () => {
    const r = run(
      fakeProject({ 'dist/index.html': '<html></html>', 'dist/assets/app.js': 'console.log(1)' }),
    );
    expect(r.out).toMatch(/✓ Secret leak check passed \(2 files scanned, 0 secret value\(s\) checked\)/);
    expect(r.code).toBe(0);
  });

  it('no dist/: fails with the clear message', () => {
    const r = run(fakeProject({}));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dist\/ not found/);
  });
});

describe('check-bundle-secrets: still catches leaks (not weakened)', () => {
  it('a Google-API-key-shaped string in the bundle fails the build', () => {
    const r = run(fakeProject({ 'dist/assets/app.js': `const k = "${KEY_SHAPED}";` }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Secret leak check FAILED[\s\S]*app\.js: matches Google API key/);
  });

  it('the real GEMINI_API_KEY value from .env is found in the bundle (proves .env is read)', () => {
    const secret = 'not-a-real-key-but-long-enough-0123';
    const r = run(
      fakeProject({ 'dist/assets/app.js': `fetch("x", { h: "${secret}" })` }, `GEMINI_API_KEY=${secret}\n`),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/contains the value of GEMINI_API_KEY/);
  });

  it('with the same .env and a clean bundle it passes, and says it checked 1 secret value', () => {
    const r = run(
      fakeProject({ 'dist/assets/app.js': 'console.log(1)' }, 'GEMINI_API_KEY=not-a-real-key-0123456789\n'),
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 secret value\(s\) checked/);
  });
});

describe('Windows paths', () => {
  it('why URL.pathname was wrong on Windows, and fileURLToPath is right (Node’s own Windows rules)', () => {
    const meta = 'file:///C:/Users/me/lockstep/scripts/check-bundle-secrets.mjs';
    expect(win32.join(new URL('..', meta).pathname, 'dist')).toBe('\\C:\\Users\\me\\lockstep\\dist');
    expect(win32.join(fileURLToPath(new URL('..', meta), { windows: true }), 'dist')).toBe(
      'C:\\Users\\me\\lockstep\\dist',
    );
  });

  it('no script, server or e2e file derives a filesystem path from URL.pathname of import.meta.url', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(join(repo, dir))) {
        const rel = join(dir, f);
        if (statSync(join(repo, rel)).isDirectory()) walk(rel);
        else if (
          /\.(m?js|ts)$/.test(f) &&
          /import\.meta\.url\)\.pathname/.test(readFileSync(join(repo, rel), 'utf8'))
        )
          offenders.push(rel);
      }
    };
    for (const dir of ['scripts', 'server', 'api', 'e2e']) walk(dir);
    expect(offenders).toEqual([]);
  });
});
