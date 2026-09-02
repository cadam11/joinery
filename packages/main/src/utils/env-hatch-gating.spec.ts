import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The structural half of J-161: an environment hatch may only be read where it is gated.
 *
 * J-161's fix is one gated read of `JOINERY_KEYCHAIN_SERVICE`; the cycle-9 review then found the
 * identical ungated shape one file over (`window.ts` reading `JOINERY_TEST`). That is the decay
 * this guard exists to stop, and it is the same argument as
 * `services/keychain/keychain-service-isolation.spec.ts`: a rule that lives only in a comment
 * does not survive the next refactor, and the thing at stake — a shipped, signed app doing what
 * the environment tells it — is worth a failing test rather than a convention.
 *
 * So: the hatch variables below may be read from `process.env` in `utils/runtime-mode.ts` and
 * nowhere else. `runtime-mode.ts` is where the `app.isPackaged` gate is applied, so a read
 * anywhere else is by definition an ungated one.
 */

/**
 * Vitest is configured at the repo root and runs from it, so `cwd` is the root — the same
 * derivation, for the same reason, as `keychain-service-isolation.spec.ts` (this package compiles
 * as CommonJS, where `import.meta.url` is a type error, but vitest loads it as ESM, where
 * `__dirname` does not exist). `beforeAll` asserts the assumption rather than trusting it.
 */
const REPO_ROOT = process.cwd();
const MAIN_SRC = join(REPO_ROOT, 'packages', 'main', 'src');

/** Guards against a runaway walk if this ever runs somewhere unexpected. */
const MAX_TREE_DEPTH = 12;

/**
 * Environment variables that change what the app DOES and exist for development or testing, each
 * with the exhaustive list of files allowed to read it.
 *
 * `logger.ts` is a deliberate exception for `NODE_ENV`: it picks the default log level from it,
 * which changes only how much the app says, never what it does — and that file's header commits
 * to importing no electron so it stays safe to import from unit-tested code, which a gate here
 * would break. A louder log in a packaged app is not a security boundary.
 */
const GATED_HATCHES = [
  { variable: 'JOINERY_TEST', allowedIn: ['utils/runtime-mode.ts'] },
  { variable: 'NODE_ENV', allowedIn: ['utils/runtime-mode.ts', 'utils/logger.ts'] },
] as const;

beforeAll(() => {
  expect(statSync(join(REPO_ROOT, 'pnpm-workspace.yaml')).isFile()).toBe(true);
  expect(statSync(MAIN_SRC).isDirectory()).toBe(true);
});

/** Every non-spec TypeScript source file in the main package, repo-relative-ish paths. */
function collectSources(dir: string, depth = 0): string[] {
  if (depth > MAX_TREE_DEPTH) {
    throw new Error(`${dir} is deeper than ${MAX_TREE_DEPTH} levels — refusing to walk further`);
  }
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectSources(full, depth + 1));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue;
    collected.push(full);
  }
  return collected;
}

/**
 * Lines that actually read the variable, ignoring prose. Comments are stripped first because the
 * files that no longer read a hatch are exactly the files most likely to explain why in a comment
 * — a guard that failed on its own documentation would be worse than no guard.
 */
function readsVariable(source: string, variable: string): boolean {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
    .some(line => line.includes(`process.env.${variable}`) || line.includes(`env.${variable}`));
}

describe.each(GATED_HATCHES)(
  '$variable is read only where it is gated',
  ({ variable, allowedIn }) => {
    it(`is read in exactly ${allowedIn.join(', ')}`, () => {
      const readers = collectSources(MAIN_SRC)
        .filter(file => readsVariable(readFileSync(file, 'utf8'), variable))
        .map(file => relative(MAIN_SRC, file))
        .sort();

      expect(readers).toEqual([...allowedIn].sort());
    });
  }
);
