/**
 * Terminate a spawned CLI child, distinguishing "already gone" from "could not signal it".
 *
 * The three backup services each carried `try { process.kill(pid) } catch { /* ignore *\/ }`. An
 * already-exited child is genuinely fine and expected — the operation is over, which is what the
 * caller wanted — but that bare catch also swallowed EPERM, which is not fine: the dump keeps
 * running while the app reports a cancellation.
 */

import { createLogger } from '../../utils/logger';

const log = createLogger('KillProcess');

/**
 * Send SIGTERM to `pid`.
 *
 * Returns whether a signal was actually delivered — `false` means the process had already exited.
 * Anything other than ESRCH is logged: the caller is about to tell a user the operation stopped.
 */
export function killProcess(pid: number, operationId: string): boolean {
  try {
    process.kill(pid);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: no such process. It exited between the map lookup and the signal, so the cancel got
    // what it asked for.
    if (code === 'ESRCH') return false;

    log.error(
      `Could not signal pid ${pid} for operation ${operationId} (${code ?? 'unknown'}): the ` +
        `process may still be running despite the cancellation.`
    );
    return false;
  }
}
