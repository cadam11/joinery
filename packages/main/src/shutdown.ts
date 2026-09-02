/**
 * The graceful-shutdown sequence, as an ordering that can be asserted (J-74).
 *
 * It used to live inline in `index.ts`'s `before-quit` handler, where the one property that matters
 * was unassertable: **the renderer is asked to flush its debounced writes before main writes its
 * own stores to disk, and nothing exits before that write.** Backwards, and main persists the state
 * it held a moment before the renderer sent the new values — the J-74 bug with an extra IPC round
 * trip for decoration.
 *
 * Every step is injected, so `shutdown.spec.ts` records the order rather than mocking Electron.
 * `index.ts` supplies the real ones and keeps the handler down to "latch, preventDefault, run this".
 *
 * ── The two orderings ────────────────────────────────────────────────────────────────────────
 *
 * 1. `requestRendererFlush` is STARTED first, while the window and every IPC handler are still
 *    alive, and AWAITED after the in-flight work has been cancelled — so the bounded wait overlaps
 *    with cleanup that has nothing to do with it, and the renderer's values are in main's cache
 *    before `flushStoreWrites` runs.
 * 2. The force-exit net now flushes before it exits. It is the one path that used to terminate with
 *    pending writes still in memory, and the flush is idempotent (`TrailingDebounce.flush()` is a
 *    no-op with nothing pending), so arriving there after a normal flush writes nothing.
 *
 * Nothing here throws: a rejected flush request, a failing store write and a hung pool close each
 * get logged and the sequence carries on, because every one of them is a reason to keep going
 * rather than a reason to strand the user's state in memory.
 */

import { createLogger } from './utils/logger';
import type { RendererFlushOutcome } from './services/config/renderer-flush';

const log = createLogger('Shutdown');

export interface ShutdownSteps {
  /**
   * Asks the renderer to empty its debounced `AppState` writes. Bounded by its own timeout and
   * resolves rather than rejecting; see `services/config/renderer-flush.ts`.
   */
  requestRendererFlush: () => Promise<RendererFlushOutcome>;
  /** Cancels in-flight work: pool timer, file watchers, queries, backups, AI streams, sidecars. */
  cancelInFlightWork: () => void;
  /** Writes main's debounced stores to disk. MUST run after the renderer has flushed. */
  flushStoreWrites: () => void;
  /** Closes SQL pools and SSH tunnels. */
  closeConnections: () => Promise<void>;
  /** Terminates the process. Called exactly once. */
  exit: () => void;
  /** The last-resort bound on the whole sequence. */
  forceExitTimeoutMs: number;
}

/** Runs the sequence. Resolves once the process has been told to exit. */
export function runShutdown(steps: ShutdownSteps): Promise<void> {
  // Synchronously, not as a rejection: a shutdown that rejects is a shutdown that never exits.
  if (steps.forceExitTimeoutMs <= 0) {
    throw new Error(`runShutdown: forceExitTimeoutMs must be > 0, got ${steps.forceExitTimeoutMs}`);
  }
  return runSequence(steps);
}

async function runSequence(steps: ShutdownSteps): Promise<void> {
  const startedAt = Date.now();
  log.info('starting graceful cleanup...');

  let exited = false;
  /** Exactly once, from whichever path gets there first. */
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    steps.exit();
  };

  const forceExitTimer = setTimeout(() => {
    log.warn(`timed out after ${steps.forceExitTimeoutMs}ms, forcing exit`);
    // Flush first: this is the path that used to exit with pending writes still in memory.
    runStep('force-exit store flush', steps.flushStoreWrites);
    exitOnce();
  }, steps.forceExitTimeoutMs);

  // Sent before anything is torn down, awaited after the cancellations below, so the bounded wait
  // costs the quit only what the renderer actually needs.
  const rendererFlush = steps.requestRendererFlush().catch((error: unknown) => {
    log.error('the renderer flush request failed:', error);
    return 'timed-out' as const;
  });

  runStep('cancel in-flight work', steps.cancelInFlightWork);

  logFlushOutcome(await rendererFlush);
  runStep('store flush', steps.flushStoreWrites);

  try {
    await steps.closeConnections();
    log.info('closed all SQL pools and SSH tunnels');
  } catch (error) {
    log.error('error closing SQL pools/SSH tunnels:', error);
  }

  clearTimeout(forceExitTimer);
  log.info(`complete in ${Date.now() - startedAt}ms`);
  exitOnce();
}

/** Runs one synchronous step, reporting a failure instead of stranding the rest of the sequence. */
function runStep(name: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    log.error(`${name} failed:`, error);
  }
}

function logFlushOutcome(outcome: RendererFlushOutcome): void {
  if (outcome === 'flushed') {
    log.info('the renderer flushed its pending writes');
    return;
  }
  if (outcome === 'no-window') {
    log.info('no window left to flush — it emptied itself on unload');
    return;
  }
  log.warn(
    'the renderer did not answer the flush request in time; ' +
      'persisting whatever reached main before the bound elapsed'
  );
}
