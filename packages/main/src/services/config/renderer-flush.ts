/**
 * Asking the renderer to empty its debounced `AppState` writes before main writes anything to disk
 * (J-74), and — the part a quit path lives and dies by — never waiting for the answer forever.
 *
 * ── Why main has to ask at all ────────────────────────────────────────────────────────────────
 *
 * The renderer debounces three writes, because each is driven by an event that fires per frame or
 * per keystroke: shell geometry (250ms), the open tabs and their SQL (500ms), and the Dockview
 * arrangement (500ms). It empties them on `beforeunload` / `pagehide`, which covers a window close
 * and a reload — but NOT a macOS ⌘Q, the ordinary quit gesture. `index.ts`'s `before-quit` handler
 * calls `event.preventDefault()` so it can run its own cleanup and ends at `app.exit(0)`, and
 * `app.exit` closes windows *immediately without emitting `close`*, so no unload event ever reaches
 * the page. The pending timer died with it, and main never had the value in memory for its own
 * `AppStateStore.flush()` to write.
 *
 * ── The contract ─────────────────────────────────────────────────────────────────────────────
 *
 * Main sends `APP.FLUSH_BEFORE_QUIT` to every live window. Each renderer empties its writers,
 * **awaits** the resulting `app:set-state` calls — so by the time it answers, main's in-memory
 * cache already holds the values — and replies on `APP.FLUSH_BEFORE_QUIT_DONE`. Main waits for one
 * reply per window it asked, bounded by `RENDERER_FLUSH_TIMEOUT_MS`, and quits either way.
 *
 * The bound is not decoration: a renderer wedged in a synchronous loop, or one whose page crashed
 * between the send and the reply, would otherwise hold the quit open until the force-exit net
 * fired — which is the one path that exits with writes still in memory.
 */

import { IPC_CHANNELS } from '@joinery/shared';

/**
 * How long main will wait for the renderer's answer. Sized against the longest renderer debounce
 * (500ms) plus one IPC round trip, and it sits inside `index.ts`'s force-exit budget.
 */
export const RENDERER_FLUSH_TIMEOUT_MS = 1_000;

export type RendererFlushOutcome =
  /** Every window asked has answered; its values are in main's cache. */
  | 'flushed'
  /** The bound elapsed first. Quit anyway; whatever landed in time is kept. */
  | 'timed-out'
  /** Nothing to ask — the window already closed (and flushed on its own unload). */
  | 'no-window';

/** The `BrowserWindow` slice this needs. Narrow on purpose: it makes the module testable. */
export interface FlushTarget {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string): void;
  };
}

/** The `ipcMain` slice this needs. */
export interface FlushIpc {
  on(channel: string, listener: () => void): void;
  removeListener(channel: string, listener: () => void): void;
}

/**
 * Asks every live window to flush and resolves when they all have, or when `timeoutMs` elapses.
 * Never rejects and never waits longer than the bound.
 */
export function requestRendererFlush(
  windows: readonly FlushTarget[],
  ipc: FlushIpc,
  timeoutMs: number = RENDERER_FLUSH_TIMEOUT_MS
): Promise<RendererFlushOutcome> {
  if (timeoutMs <= 0) {
    throw new Error(`requestRendererFlush: timeoutMs must be > 0, got ${timeoutMs}`);
  }

  const live = windows.filter(window => !window.isDestroyed() && !window.webContents.isDestroyed());
  if (live.length === 0) return Promise.resolve('no-window');

  return new Promise<RendererFlushOutcome>(resolve => {
    let acknowledged = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** The single exit. Both resources are released here, on every path. */
    const settle = (outcome: RendererFlushOutcome): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      ipc.removeListener(IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT_DONE, onAcknowledged);
      resolve(outcome);
    };

    const onAcknowledged = (): void => {
      acknowledged += 1;
      if (acknowledged >= live.length) settle('flushed');
    };

    // Listener before send: a renderer that answers synchronously must not answer into nothing.
    ipc.on(IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT_DONE, onAcknowledged);
    timer = setTimeout(() => settle('timed-out'), timeoutMs);
    for (const window of live) window.webContents.send(IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT);
  });
}
