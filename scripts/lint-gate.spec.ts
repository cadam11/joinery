/**
 * Guards the repo's cached gates against reporting green without running.
 *
 * `pnpm run lint` and `pnpm run typecheck` are cached turbo tasks, one per package. Turbo's
 * default input set is the package's OWN files, so a config that lives at the repo root — two
 * directories above `packages/*` — is not part of any task's cache key unless it is named. Every
 * such config was measured to produce a false green before being listed in `ROOT_CONFIGS` below:
 * mutate it, re-run the gate, get `N successful, N cached … FULL TURBO` and exit 0 while the same
 * tool run uncached exits 1.
 *
 * The invariant, stated once: a cached task's cache key must contain every config that decides
 * what that task MEANS. Assertions name the exact files rather than pattern-matching the input
 * keys — a substring match was the first spelling here, and it is what let `.prettierrc.json`
 * through (PR #125 review, B1).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TURBO = `${REPO_ROOT}node_modules/.bin/turbo`;

/**
 * Repo-root config files each task must hash, as turbo reports them: `$TURBO_ROOT$/x` resolves
 * to a package-relative path in the input map, which from `packages/*` is `../../x`.
 *
 *  - `lint`: `.eslintrc.json` is the config for main/preload/shared, and it sets
 *    `"prettier/prettier": "error"`, so `.prettierrc.json` governs those three too — flipping
 *    `singleQuote` there produced 36 ESLint errors in `packages/preload` behind a FULL TURBO
 *    green. `.prettierignore` is deliberately NOT here: measured, `eslint-plugin-prettier`
 *    ignores it (adding `packages/preload/src/**` to it changed nothing).
 *  - `typecheck`: `packages/main` and `packages/preload` extend the root `tsconfig.json`.
 *    Adding `exactOptionalPropertyTypes` to it left the gate FULL TURBO green while
 *    `turbo run typecheck --force` failed `@joinery/main#typecheck`.
 *
 * The renderer and shared do not read every file listed for their task; an input they ignore
 * only widens their cache key, which is harmless.
 */
const ROOT_CONFIGS: Record<string, readonly string[]> = {
  lint: ['../../.eslintrc.json', '../../.prettierrc.json'],
  typecheck: ['../../tsconfig.json'],
};

interface DryRunTask {
  taskId: string;
  task: string;
  inputs: Record<string, string>;
}

function tasksFor(task: string): DryRunTask[] {
  const stdout = execFileSync(TURBO, ['run', task, '--dry=json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // stderr piped rather than inherited: turbo writes a version banner there on every run,
    // which would otherwise land in the middle of the test reporter's output. On a non-zero
    // exit execFileSync attaches it to the thrown error, so nothing is swallowed.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const plan = JSON.parse(stdout) as { tasks: DryRunTask[] };
  // `typecheck` dependsOn `^build`, so its plan carries build tasks too.
  return plan.tasks.filter(candidate => candidate.task === task);
}

describe('the repo-root gates', () => {
  it('runs a lint task for every package in the workspace', () => {
    expect(
      tasksFor('lint')
        .map(task => task.taskId)
        .sort()
    ).toEqual([
      '@joinery/main#lint',
      '@joinery/preload#lint',
      '@joinery/renderer#lint',
      '@joinery/shared#lint',
    ]);
  });

  for (const [task, configs] of Object.entries(ROOT_CONFIGS)) {
    it(`hashes every governing repo-root config into each ${task} task`, () => {
      const tasks = tasksFor(task);
      expect(tasks.length).toBeGreaterThan(0);

      const missing = tasks
        .map(candidate => ({
          taskId: candidate.taskId,
          absent: configs.filter(config => !(config in candidate.inputs)),
        }))
        .filter(entry => entry.absent.length > 0);

      expect(missing).toEqual([]);
    });
  }
});
