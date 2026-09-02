/**
 * The structural guard that every workspace package declares what its own source imports.
 *
 * `packages/main` used to import `electron`, `@azure/msal-node`, `pg`, `mysql2` and the Aurora DSQL
 * connector without listing one of them in its own manifest, and `packages/preload` did the same
 * with `electron`. They resolved anyway: the ROOT `package.json` declares them and Node walks up
 * the directory tree out of `packages/<pkg>/src`. That is invisible until the day the layout
 * changes — pnpm's isolated linker, a package extracted to its own repository, a `pnpm deploy` —
 * and then the failure is a runtime `MODULE_NOT_FOUND` in a shipped build, not a build error.
 *
 * The root manifest keeps its copies. It is the Electron app manifest (`main` points at
 * `packages/main/dist/index.js`) and electron-builder collects the production dependency tree from
 * it, so removing an entry there would drop the package out of `app.asar`. This spec asks only that
 * the importing package ALSO says what it uses. See J-27.
 *
 * Scope, deliberately: production sources only. Spec files import `vitest`, which is a root
 * devDependency the runner injects for every package, and declaring it four more times would be
 * churn with no failure mode behind it.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Repo root's `packages/`, from this file at `packages/main/src/`. */
const PACKAGES_DIR = join(__dirname, '..', '..');

/**
 * Specifiers a package may import without declaring, with the reason.
 *
 * `electron-squirrel-startup` is a Windows Squirrel installer hook that `packages/main/src/index.ts`
 * `require()`s inside a try/catch and works without — it is not installed in this workspace at all,
 * so declaring it would ADD a dependency rather than describe one.
 */
const UNDECLARED_BY_DESIGN = new Set(['electron-squirrel-startup']);

/** Directory listing; a package without `src/` is normal, an unreadable one is not. */
function readEntries(dir: string): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Depth-bounded so a symlink cycle cannot spin this forever. */
function walk(dir: string, prefix: string, out: Array<[string, string]>, depth = 0): void {
  if (depth > 12) throw new Error(`dependency scan exceeded depth 12 at ${dir}`);

  for (const entry of readEntries(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.name === '__tests__' || entry.name === '__mocks__' || entry.name === 'test')
        continue;
      walk(full, `${prefix}/${entry.name}`, out, depth + 1);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
    if (/\.(spec|test)\.tsx?$/.test(entry.name)) continue;
    out.push([`${prefix}/${entry.name}`, readFileSync(full, 'utf8')]);
  }
}

/**
 * Comments out, so prose cannot be mistaken for code. Both false positives this cost on the first
 * pass were doc comments: `"Docker is not running"` after the word `from`, and a `* ... 'pending'`
 * line. Stripping is line-shaped and never touches an import's own quotes.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

/** Every way this workspace names a module it does not own. */
const SPECIFIER_PATTERNS = [
  /^\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/gm,
  /^\s*@import\s+['"]([^'"]+)['"]/gm,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * The npm package a specifier names, or `null` for anything that is not one: a relative path, a
 * Node builtin, or a subpath of either. `pg-query-stream` stays whole; `mysql2/promise` and
 * `@radix-ui/react-dialog` collapse to their package.
 */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const path = specifier.split('?')[0];
  const segments = path.split('/');
  const name = path.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!name || name.startsWith('node:') || builtinModules.includes(name)) return null;
  return name;
}

/** `[packageName, sourceFile]` for every bare specifier the package's production sources import. */
function importsOf(pkg: string): Array<[string, string]> {
  const sources: Array<[string, string]> = [];
  walk(join(PACKAGES_DIR, pkg, 'src'), pkg, sources);

  const found: Array<[string, string]> = [];
  for (const [path, text] of sources) {
    const code = stripComments(text);
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        const name = packageNameOf(match[1]);
        if (name) found.push([name, path]);
      }
    }
  }
  return found;
}

/** Every dependency field of a manifest, flattened. Which field is not this spec's business. */
function declaredIn(pkg: string): Set<string> {
  const manifest = JSON.parse(readFileSync(join(PACKAGES_DIR, pkg, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/** The workspace packages, by directory name. `packages/.gitkeep` is not one. */
function workspacePackages(): string[] {
  return readEntries(PACKAGES_DIR)
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name =>
      readEntries(join(PACKAGES_DIR, name)).some(entry => entry.name === 'package.json')
    );
}

describe('workspace dependency declarations', () => {
  it('found the four workspace packages, so an empty pass cannot be vacuous', () => {
    expect(workspacePackages().sort()).toEqual(['main', 'preload', 'renderer', 'shared']);
  });

  it.each(workspacePackages())('packages/%s declares every package its source imports', pkg => {
    const declared = declaredIn(pkg);
    const undeclared = importsOf(pkg)
      .filter(([name]) => !declared.has(name) && !UNDECLARED_BY_DESIGN.has(name))
      .map(([name, path]) => `${name} (imported by ${path})`);

    expect([...new Set(undeclared)].sort()).toEqual([]);
  });

  it('reads real imports, not prose that happens to contain the word from', () => {
    expect(packageNameOf('mysql2/promise')).toBe('mysql2');
    expect(packageNameOf('@azure/msal-node')).toBe('@azure/msal-node');
    expect(packageNameOf('./connection-pool')).toBeNull();
    expect(packageNameOf('node:fs')).toBeNull();
    expect(packageNameOf('fs')).toBeNull();
    expect(stripComments('/** from "pg" */\nimport x from "pg";')).not.toContain('from "pg" */');
  });

  it('sees the imports packages/main actually has', () => {
    const names = new Set(importsOf('main').map(([name]) => name));
    expect([...names].sort()).toContain('electron');
    expect([...names].sort()).toContain('pg');
    expect([...names].sort()).toContain('mysql2');
  });
});
