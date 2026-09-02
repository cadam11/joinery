/**
 * Guards the repo's lint gate against reporting green without running.
 *
 * `pnpm run lint` is `turbo run lint`, a cached task per package. Turbo's default input set
 * is the package's own files, so the ESLint config that decides what "lint" MEANS for
 * `@joinery/main`, `@joinery/preload` and `@joinery/shared` — the repo-root `.eslintrc.json`,
 * two directories above them — was not part of their cache key. Measured on J-34: adding a
 * rule to that file and re-running the gate produced `4 successful, 4 cached … FULL TURBO`,
 * so the run reported green having executed no ESLint at all.
 *
 * The invariant, stated once for all four packages: a lint task's cache key must contain the
 * config that governs it. The renderer satisfies it through its in-package flat config; the
 * other three need the root file declared explicitly.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TURBO = `${REPO_ROOT}node_modules/.bin/turbo`;

interface DryRunTask {
  taskId: string;
  task: string;
  inputs: Record<string, string>;
}

function lintTasks(): DryRunTask[] {
  const stdout = execFileSync(TURBO, ['run', 'lint', '--dry=json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // stderr piped rather than inherited: turbo writes a version banner there on every run,
    // which would otherwise land in the middle of the test reporter's output. On a non-zero
    // exit execFileSync attaches it to the thrown error, so nothing is swallowed.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const plan = JSON.parse(stdout) as { tasks: DryRunTask[] };
  return plan.tasks.filter(task => task.task === 'lint');
}

describe('the root lint gate', () => {
  it('runs a lint task for every package in the workspace', () => {
    expect(
      lintTasks()
        .map(task => task.taskId)
        .sort()
    ).toEqual([
      '@joinery/main#lint',
      '@joinery/preload#lint',
      '@joinery/renderer#lint',
      '@joinery/shared#lint',
    ]);
  });

  it('hashes the governing ESLint config into every lint task', () => {
    const withoutConfig = lintTasks()
      .filter(task => !Object.keys(task.inputs).some(path => /eslint/i.test(path)))
      .map(task => task.taskId);

    expect(withoutConfig).toEqual([]);
  });
});
