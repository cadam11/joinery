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
 * ── The one thing to know about the quit path ─────────────────────────────────────────────────
 *
 * `beforeunload` / `pagehide` cover a window close and a reload. They do NOT cover a macOS ⌘Q:
 * `main/src/index.ts`'s `before-quit` handler calls `event.preventDefault()` and then `app.exit(0)`
 * (`:153-156,255`), and `app.exit` closes windows without emitting a `close`, so no unload event
 * reaches this renderer. Closing that hole needs main to ask the renderer to flush and to wait for
 * the answer before it flushes `AppStateStore` — a new IPC channel and a reordered shutdown
 * sequence, both outside J-74's scope. It has its own follow-up ticket.
 */

import { isIpcAvailable } from '../ipc';
import { diagnostics } from '../state/diagnostics';

/**
 * Sends a writer's pending debounced write now. Must be a no-op when nothing is pending — this
 * runs on the way out, and a spurious write is a write racing a bridge that is being torn down.
 */
export type PendingWriteFlush = () => void;

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
 * Empties every registered writer once.
 *
 * The bridge check is the guard the ticket asks for: every flush ends in an IPC call, `ipc()`
 * throws synchronously when the preload bridge has gone, and a throw inside an unload listener has
 * no caller to catch it. Each writer re-checks for itself; this is the single place that says so.
 *
 * One writer's failure must not cost the others theirs, so each is called inside its own `try`
 * and the failure is reported rather than swallowed.
 */
export function flushPendingWritesOnExit(): void {
  if (!isIpcAvailable()) return;

  for (const [name, flush] of [...flushers]) {
    try {
      flush();
    } catch (error) {
      diagnostics.error(`failed to flush pending writes for ${name}`, error);
    }
  }
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
  const onExit = (): void => flushPendingWritesOnExit();

  window.addEventListener('beforeunload', onExit);
  window.addEventListener('pagehide', onExit);

  return () => {
    window.removeEventListener('beforeunload', onExit);
    window.removeEventListener('pagehide', onExit);
  };
}
