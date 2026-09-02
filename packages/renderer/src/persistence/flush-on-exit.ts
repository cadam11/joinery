/**
 * The one place a debounced renderer write is emptied before the window goes away (J-74).
 *
 * ── The bug this closes ───────────────────────────────────────────────────────────────────────
 *
 * Three things in this renderer debounce a write to main-process `AppState`, because each of them
 * is driven by an event that fires per frame or per keystroke and each write ends in a synchronous
 * `electron-store` write on the main thread:
 *
 *   `state/workbench.ts`  shell geometry (sidebar, chat panel, editor split)   250ms
 *   `state/tab.ts`        the open query tabs and their SQL                     500ms
 *   `persistence/layout.ts` the Dockview arrangement                            500ms
 *
 * None of them had a flush. A drag, a keystroke or a panel move inside its own debounce window,
 * followed by the window going away, dropped the value on the floor: the timer died with the page
 * and the IPC call was never made, so main never even had the value in memory to flush to disk on
 * `before-quit`. Reported for geometry (J-74, from the Task 20+21 helper consolidation); the tab
 * one is the same shape and loses the user's last-typed SQL rather than a sidebar width.
 *
 * ── Why a registry rather than three listeners ────────────────────────────────────────────────
 *
 * Each writer could add its own `beforeunload` listener, and then "did anyone remember?" would be a
 * property of three separate files. Here it is one list, `installExitFlush()` installs one pair of
 * listeners, and `registeredExitFlushNames()` makes the shell's wiring assertable in a test rather
 * than reviewable by eye.
 *
 * ── Two ways out, because one is not enough ───────────────────────────────────────────────────
 *
 * **Unload.** `beforeunload` / `pagehide` cover a window close and a reload. Nothing can be awaited
 * there — the page is going away — so those writes are fire-and-forget and rely on main receiving
 * them before it is told to quit.
 *
 * **The quit request.** Unload events do NOT fire for a macOS ⌘Q, which is the ordinary quit
 * gesture: `main/src/index.ts`'s `before-quit` handler calls `event.preventDefault()` so it can run
 * its own cleanup and ends at `app.exit(0)`, and `app.exit` closes windows *immediately without
 * emitting `close`*. So main asks instead, over `APP.FLUSH_BEFORE_QUIT`, and waits (bounded) for
 * the answer this module sends back. Here the flush IS awaited before the reply, which is what
 * makes the reply mean something: when main sees it, the values are already in its cache and its
 * own `AppStateStore.flush()` will write them.
 *
 * Both paths can fire in one quit (a window close on Windows/Linux does), and the second is a
 * no-op: every writer returns early with no pending timer.
 */

import { ipc, isIpcAvailable } from '../ipc';
import { diagnostics } from '../state/diagnostics';

/**
 * Sends a writer's pending debounced write now, and resolves once it has landed. Must be a no-op
 * when nothing is pending — this runs on the way out, and a spurious write is a write racing a
 * bridge that is being torn down.
 *
 * The `Promise` is what the quit path awaits before answering main; the unload path cannot await
 * anything and ignores it.
 */
export type PendingWriteFlush = () => Promise<void> | void;

/** Registered writers, by the name that identifies them in a diagnostic. Insertion-ordered. */
const flushers = new Map<string, PendingWriteFlush>();

/**
 * Registers a writer and returns its unregister. `name` must be unique: two owners under one name
 * means one of them is silently dropped, which is exactly the lost write this module exists to
 * prevent, so it throws rather than replacing.
 */
export function registerExitFlush(name: string, flush: PendingWriteFlush): () => void {
  if (name.trim() === '') throw new Error('registerExitFlush: a flusher needs a name');
  if (flushers.has(name)) {
    throw new Error(`registerExitFlush: "${name}" is already registered`);
  }

  flushers.set(name, flush);
  return () => {
    // Identity-checked: a stale teardown from a replaced registration must not remove the live one.
    if (flushers.get(name) === flush) flushers.delete(name);
  };
}

/** The names currently registered, in registration order. For the shell's wiring assertion. */
export function registeredExitFlushNames(): readonly string[] {
  return [...flushers.keys()];
}

/**
 * Empties every registered writer once, and resolves when they have all landed.
 *
 * The bridge check is the guard the ticket asks for: every flush ends in an IPC call, `ipc()`
 * throws synchronously when the preload bridge has gone, and a throw inside an unload listener has
 * no caller to catch it. Each writer re-checks for itself; this is the single place that says so.
 *
 * One writer's failure must not cost the others theirs, so each is called inside its own `try`,
 * the async ones are settled rather than raced, and every failure is reported rather than
 * swallowed. Never rejects: on the quit path a rejection here would strand main's bounded wait.
 */
export async function flushPendingWritesOnExit(): Promise<void> {
  if (!isIpcAvailable()) return;

  const landings: Promise<void>[] = [];
  for (const [name, flush] of [...flushers]) {
    try {
      const landing = flush();
      if (isThenable(landing)) landings.push(landing.catch(reportFailure(name)));
    } catch (error) {
      reportFailure(name)(error);
    }
  }

  await Promise.all(landings);
}

/**
 * A thenable check rather than a truthiness one. The union return type does reject a stray value at
 * compile time — a `Promise<void> | void` parameter is not bare `void`, so TypeScript's
 * void-return relaxation does not apply and `() => list.push(x)` is an error, which is how the
 * mistake was caught while writing this. The runtime check stays as the backstop for the same value
 * arriving from anywhere the compiler is not looking, because the cost of being wrong is a `.catch`
 * on a number: a throw inside an unload listener, with no caller to catch it, on the one path where
 * the user's unsaved work is at stake.
 */
function isThenable(value: Promise<void> | void): value is Promise<void> {
  return typeof (value as Promise<void> | undefined)?.then === 'function';
}

function reportFailure(name: string): (error: unknown) => void {
  return error => diagnostics.error(`failed to flush pending writes for ${name}`, error);
}

/**
 * Installs the unload listeners and returns the teardown that removes them.
 *
 * Both events, because they are not redundant: `beforeunload` is the one a reload and a window
 * close fire, and `pagehide` is the one Chromium fires unconditionally on the way out — including
 * for a page it discards without asking. `flushPendingWritesOnExit` is idempotent (each writer
 * no-ops with nothing pending), so a page that fires both flushes once and writes once.
 */
export function installExitFlush(): () => void {
  // `void`, not awaited: an unload listener runs to completion or not at all, and the writes are
  // already on their way over IPC by the time it returns.
  const onExit = (): void => {
    void flushPendingWritesOnExit();
  };

  window.addEventListener('beforeunload', onExit);
  window.addEventListener('pagehide', onExit);

  const teardowns: (() => void)[] = [
    () => {
      window.removeEventListener('beforeunload', onExit);
      window.removeEventListener('pagehide', onExit);
    },
  ];

  // The quit path. Subscribing needs the bridge; in browser mode there is no main process to
  // answer and nothing to persist, so there is nothing to install.
  if (isIpcAvailable()) {
    teardowns.push(ipc().app.onFlushBeforeQuit(() => void flushAndReport()));
  }

  return () => {
    for (const teardown of teardowns) teardown();
  };
}

/**
 * The answer to main's flush request: empty every writer, wait for the writes to land, then say so.
 *
 * The order is the whole point. Main does not write `AppState` to disk until this reply arrives, so
 * replying early would persist the state main held a moment ago — the very bug, with an extra round
 * trip. The bridge is re-checked before replying, because a window torn down between the request
 * and the reply leaves `ipc()` throwing, and this runs with no caller to catch it.
 */
async function flushAndReport(): Promise<void> {
  try {
    await flushPendingWritesOnExit();
  } catch (error) {
    // `flushPendingWritesOnExit` reports per-writer failures and does not reject; this is the
    // belt-and-braces path, and main must still be answered so its bounded wait ends early.
    diagnostics.error('the flush-before-quit sweep failed', error);
  }

  if (!isIpcAvailable()) return;
  try {
    ipc().app.reportFlushed();
  } catch (error) {
    diagnostics.error('failed to answer the flush-before-quit request', error);
  }
}
