/**
 * The half of a cancel that actually stops work.
 *
 * All three services carried `try { process.kill(pid) } catch { /* ignore *\/ }`. An already-exited
 * child is expected and fine; EPERM is not, and that bare catch made the two indistinguishable —
 * the app would report a cancellation while the dump kept running.
 */

import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { killProcess } from './kill-process';

const spawned: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) child.kill('SIGKILL');
});

/** A real child, so "the signal was delivered" is not a claim about a mock. */
function sleeper(): { pid: number; exited: Promise<void> } {
  const child = spawn('sleep', ['30']);
  spawned.push(child);
  if (child.pid === undefined) throw new Error('spawn returned no pid');

  return {
    pid: child.pid,
    exited: new Promise<void>(resolve => child.once('close', () => resolve())),
  };
}

describe('killProcess', () => {
  it('signals a running child, which then exits', async () => {
    const child = sleeper();
    expect(killProcess(child.pid, 'op-1')).toBe(true);
    await expect(child.exited).resolves.toBeUndefined();
  });

  it('reports false for a process that has already exited, rather than throwing', async () => {
    const child = sleeper();
    killProcess(child.pid, 'op-1');
    await child.exited;

    // ESRCH. The operation is over, which is what the cancel asked for.
    expect(killProcess(child.pid, 'op-1')).toBe(false);
  });

  it('reports false for pid 1, which this process may not signal', () => {
    // EPERM rather than ESRCH: launchd is running and is not ours to kill. The old bare catch
    // swallowed this case identically to "already exited"; here it is logged and reported.
    expect(killProcess(1, 'op-1')).toBe(false);
  });
});
