/**
 * Read an installed package's version WITHOUT importing "<pkg>/package.json".
 *
 * Why (for learners): many packages (including @google/genai) ship an `exports` map in their
 * package.json. Node then ONLY allows the import paths listed there, and `./package.json` is
 * usually not listed, so `require('@google/genai/package.json')` crashes with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Instead we:
 *   1. resolve the package's main entry (the "." export, which is always allowed),
 *   2. walk up from that file to the package.json whose `name` matches, and read it from disk,
 *   3. as a fallback, look in node_modules directly,
 *   4. and if all of that fails, return "unknown". It never throws: a version label in a bug
 *      report is nice to have, never worth crashing a diagnostic for.
 * Only `node:path`/`node:fs` are used for the walk, so it works the same on Windows.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readIfNamed(dir: string, name: string): string | null {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
    return pkg.name === name && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Walk from `start` up to the filesystem root, calling `visit` on each directory until it returns a value. */
function walkUp(start: string, visit: (dir: string) => string | null): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const hit = visit(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) break; // reached "/" or "C:\"
    dir = parent;
  }
  return null;
}

export function packageVersion(name: string, fromUrl: string = import.meta.url): string {
  // 1 + 2: via the package's main entry.
  try {
    const entry = createRequire(fromUrl).resolve(name);
    const hit = walkUp(dirname(entry), (dir) => readIfNamed(dir, name));
    if (hit) return hit;
  } catch {
    /* ESM-only or unusual package: try the fallback below */
  }
  // 3: node_modules/<name>/package.json, searched upwards from the caller.
  try {
    const hit = walkUp(dirname(fileURLToPath(fromUrl)), (dir) =>
      readIfNamed(join(dir, 'node_modules', ...name.split('/')), name),
    );
    if (hit) return hit;
  } catch {
    /* fall through */
  }
  return 'unknown';
}
