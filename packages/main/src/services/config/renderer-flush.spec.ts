/**
 * The flush-before-quit request (J-74): main asking the renderer to empty its debounced `AppState`
 * writes, and — the part that actually matters — never waiting for the answer indefinitely.
 *
 * Why this exists at all: a macOS ⌘Q never reaches the renderer's `beforeunload` / `pagehide`.
 * `index.ts`'s `before-quit` handler preventDefaults so it can run its own cleanup and ends at
 * `app.exit(0)`, which closes windows WITHOUT emitting `close`. So the renderer's three debounced
 * writes (shell geometry 250ms, the open tabs and their SQL 500ms, the Dockview arrangement 500ms)
 * used to die with the page on the ordinary quit gesture, and main never had the values in memory
 * for its own flush to write to disk.
 *
 * The properties asserted here are the ones a quit path lives and dies by: the wait is BOUNDED, the
 * listener is removed on every exit path, and a renderer that never answers cannot hold the quit.
 */

import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@joinery/shared';
import {
  RENDERER_FLUSH_TIMEOUT_MS,
  requestRendererFlush,
  type FlushIpc,
  type FlushTarget,
} from './renderer-flush';

/**
 * A stand-in for `ipcMain`'s two-method slice, recording its own listener traffic so a leaked
 * listener is a failing assertion rather than a slow leak in a shutdown path.
 */
function createIpcDouble(): FlushIpc & {
  emitAck: () => void;
  liveListeners: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    on: (channel, listener) => {
      expect(channel).toBe(IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT_DONE);
      listeners.add(listener);
    },
    removeListener: (channel, listener) => {
      expect(channel).toBe(IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT_DONE);
      listeners.delete(listener);
    },
    emitAck: () => {
      for (const listener of [...listeners]) listener();
    },
    liveListeners: () => listeners.size,
  };
}

/** A stand-in for the `BrowserWindow` slice the request touches, recording what it was sent. */
function createWindowDouble(
  state: { destroyed?: boolean; contentsDestroyed?: boolean } = {}
): FlushTarget & { sent: string[] } {
  const sent: string[] = [];
  return {
    isDestroyed: () => state.destroyed === true,
    webContents: {
      isDestroyed: () => state.contentsDestroyed === true,
      send: (channel: string) => sent.push(channel),
    },
    sent,
  };
}

describe('requestRendererFlush', () => {
  it('asks every live window and resolves once they have all answered', async () => {
    const ipc = createIpcDouble();
    const first = createWindowDouble();
    const second = createWindowDouble();

    const pending = requestRendererFlush([first, second], ipc);
    expect(first.sent).toEqual([IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT]);
    expect(second.sent).toEqual([IPC_CHANNELS.APP.FLUSH_BEFORE_QUIT]);

    ipc.emitAck();
    ipc.emitAck();

    expect(await pending).toBe('flushed');
    expect(ipc.liveListeners()).toBe(0);
  });

  it('gives up after the bound rather than holding the quit open', async () => {
    vi.useFakeTimers();
    try {
      const ipc = createIpcDouble();
      const window = createWindowDouble();

      const pending = requestRendererFlush([window], ipc, 1_000);
      // A renderer wedged in a synchronous loop never answers. The quit must not care.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toBe('timed-out');
      expect(ipc.liveListeners()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait at all when there is no window to ask', async () => {
    const ipc = createIpcDouble();
    const destroyed = createWindowDouble({ destroyed: true });
    const contentsGone = createWindowDouble({ contentsDestroyed: true });

    // The Windows/Linux path: the window closed (and flushed on `beforeunload`) before the quit
    // reached main, so there is nobody left to ask and nothing to wait for.
    expect(await requestRendererFlush([destroyed, contentsGone], ipc)).toBe('no-window');
    expect(destroyed.sent).toEqual([]);
    expect(contentsGone.sent).toEqual([]);
    expect(ipc.liveListeners()).toBe(0);
  });

  it('refuses an unbounded wait', () => {
    // "Bound every wait" as a runtime assertion: a zero or negative bound is a wait that never ends.
    expect(() => requestRendererFlush([createWindowDouble()], createIpcDouble(), 0)).toThrow(
      /must be > 0/
    );
  });

  it('names its own bound, so the shutdown budget can be reasoned about', () => {
    expect(RENDERER_FLUSH_TIMEOUT_MS).toBe(1_000);
  });
});
