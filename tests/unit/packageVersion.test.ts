/**
 * REGRESSION: `npm run diagnose:gemini` crashed with
 *   ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './package.json' is not defined by "exports" in @google/genai
 * because the script did require('@google/genai/package.json'). packageVersion() must never do that.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../../server/lib/packageVersion';

const root = process.cwd();
const diskVersion = (name: string) =>
  (
    JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

describe('packageVersion', () => {
  it('reads the version of @google/genai, whose exports map blocks ./package.json', () => {
    const v = packageVersion('@google/genai');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).toBe(diskVersion('@google/genai'));
  });

  it('works for other packages with export maps (scoped and unscoped)', () => {
    expect(packageVersion('zod')).toBe(diskVersion('zod'));
    expect(packageVersion('@playwright/test')).toBe(diskVersion('@playwright/test'));
  });

  it('returns "unknown" instead of throwing when the package is not installed', () => {
    expect(() => packageVersion('definitely-not-an-installed-package-xyz')).not.toThrow();
    expect(packageVersion('definitely-not-an-installed-package-xyz')).toBe('unknown');
  });
});

describe('guard: no code imports "<pkg>/package.json" through the package exports', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs|js)$/.test(f) ? [p] : [];
    });
  // Any quoted bare specifier ("zod/package.json", "@scope/pkg/package.json"), however it is loaded
  // (require, createRequire(...)(), import, import()). Relative paths start with "." or "/" and don't match.
  const bare = /['"`](?:@[\w.-]+\/)?[\w.-]+\/package\.json['"`]/;

  it('scripts/ and server/ contain none (comments are ignored)', () => {
    const offenders: string[] = [];
    for (const dir of ['scripts', 'server']) {
      for (const file of files(join(root, dir))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
            if (bare.test(line)) offenders.push(`${file.replace(root, '')}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
