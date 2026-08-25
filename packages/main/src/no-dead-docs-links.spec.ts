/**
 * The structural guard on where the app sends people for documentation.
 *
 * Until J-100 both documentation entry points — Help ▸ Joinery Documentation and the welcome
 * panel's CTA — opened `github.com/cadam11/joinery/wiki`, a wiki that has never existed
 * (`git ls-remote joinery.wiki.git` → "Repository not found"). Two separate files held the same
 * dead URL as their own literal, which is exactly how the second one survived the ticket that
 * was filed about the first.
 *
 * So the URL now lives in one exported constant, and this spec is the check that it stays that
 * way. It is deliberately about source text rather than behaviour: a behaviour test can only
 * cover the entry points someone remembered to test, and the failure mode here is precisely the
 * entry point nobody remembered.
 */

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOCS_SITE_URL } from '@joinery/shared';

/** Repo root, from this file at `packages/main/src/`. */
const PACKAGES_DIR = join(__dirname, '..', '..');

/** The wiki that never existed. Anything pointing here is a dead end for a user. */
const DEAD_WIKI = 'github.com/cadam11/joinery/wiki';

/**
 * A directory listing, treating "no such directory" as empty and every other failure as a
 * failure — a package without `src/` is normal here; an unreadable one is not.
 */
function readEntries(dir: string): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every production source file across the workspace packages, as `[relativePath, text]`. */
function collectSources(): Array<[string, string]> {
  const collected: Array<[string, string]> = [];
  const packages = readEntries(PACKAGES_DIR)
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  for (const pkg of packages) {
    walk(join(PACKAGES_DIR, pkg, 'src'), pkg, collected);
  }
  return collected;
}

/** Depth-bounded so a symlink cycle cannot spin this forever. */
function walk(dir: string, prefix: string, out: Array<[string, string]>, depth = 0): void {
  if (depth > 12) throw new Error(`docs-link scan exceeded depth 12 at ${dir}`);

  for (const entry of readEntries(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, `${prefix}/${entry.name}`, out, depth + 1);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes('.spec.')) continue;
    out.push([`${prefix}/${entry.name}`, readFileSync(full, 'utf8')]);
  }
}

describe('documentation links', () => {
  it('names the published docs site, not a wiki that does not exist', () => {
    expect(DOCS_SITE_URL).toBe('https://usejoinery.com/');
  });

  it('is not hardcoded to the dead wiki anywhere in the workspace', () => {
    const offenders = collectSources()
      .filter(([, text]) => text.includes(DEAD_WIKI))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('scanned a plausible number of files, so an empty pass cannot be vacuous', () => {
    expect(collectSources().length).toBeGreaterThan(100);
  });
});
