/**
 * The shutdown sequence's ORDERING, which is the whole of J-74's quit half.
 *
 * `index.ts` used to hold this inline, and inline is why the ordering could not be asserted: the
 * before-quit handler is registered against the real `app` object inside `createWindow`'s module
 * body. The steps are injected here instead, so the two orderings that matter are provable:
 *
 * 1. The renderer is asked to flush BEFORE main writes its own debounced stores to disk. Backwards,
 *    and main persists the values it had a moment before the renderer sent the new ones — which is
 *    exactly the bug, with an extra IPC round trip for decoration.
 * 2. Nothing exits before the store write. Including the force-exit safety net, which used to call
 *    `app.exit(0)` with pending writes still in memory.
 */

import { describe, expect, it, vi } from 'vitest';
import { runShutdown, type ShutdownSteps } from './shutdown';

/** Records every step as it runs, so the assertions are about order rather than about mocks. */
function createSteps(overrides: Partial<ShutdownSteps> = {}): {
  steps: ShutdownSteps;
  order: string[];
} {
  const order: string[] = [];
  const steps: ShutdownSteps = {
    requestRendererFlush: async () => {
      order.push('request-renderer-flush');
      return 'flushed';
    },
    cancelInFlightWork: () => order.push('cancel-in-flight-work'),
    flushStoreWrites: () => order.push('flush-store-writes'),
    closeConnections: async () => {
      order.push('close-connections');
    },
    exit: () => order.push('exit'),
    forceExitTimeoutMs: 3_000,
    ...overrides,
  };
  return { steps, order };
}

describe('runShutdown', () => {
  it('asks the renderer to flush before it writes anything to disk, and exits last', async () => {
    const { steps, order } = createSteps();

    await runShutdown(steps);

    expect(order).toEqual([
      'request-renderer-flush',
      'cancel-in-flight-work',
      'flush-store-writes',
      'close-connections',
      'exit',
    ]);
  });

  it('waits for the renderer’s answer before writing, not merely for the request to be sent', async () => {
    // A no-op initial value rather than `null`: the executor below runs synchronously, so this is
    // always replaced before it is called, and TypeScript need not be argued with about it.
    let answer = (): void => undefined;
    const { steps, order } = createSteps({
      requestRendererFlush: () =>
        new Promise(resolve => {
          order.push('request-renderer-flush');
          answer = () => resolve('flushed');
        }),
    });

    const pending = runShutdown(steps);
    // Everything up to the `await` has run by now. The renderer has not answered, so nothing may
    // have been written — this is the assertion that "sent the request" is not good enough.
    expect(order).toEqual(['request-renderer-flush', 'cancel-in-flight-work']);

    answer();
    await pending;

    expect(order.indexOf('flush-store-writes')).toBeGreaterThan(
      order.indexOf('request-renderer-flush')
    );
  });

  it('still writes and still exits when the renderer never answers', async () => {
    const { steps, order } = createSteps();
    // Same recording, different answer: a wedged renderer must cost the quit its bound and nothing
    // else — not the store write, and not the exit.
    await runShutdown({
      ...steps,
      requestRendererFlush: async () => {
        order.push('request-renderer-flush');
        return 'timed-out';
      },
    });

    expect(order).toEqual([
      'request-renderer-flush',
      'cancel-in-flight-work',
      'flush-store-writes',
      'close-connections',
      'exit',
    ]);
  });

  it('still writes and still exits when the flush request rejects outright', async () => {
    // A rejected request must not become a lost write: an `await` that throws would skip the flush
    // and take the pending geometry with it.
    const { steps, order } = createSteps({
      requestRendererFlush: () => Promise.reject(new Error('the window went away mid-request')),
    });

    await runShutdown(steps);

    expect(order).toContain('flush-store-writes');
    expect(order.at(-1)).toBe('exit');
  });

  it('exits even when closing the connections fails', async () => {
    const { steps, order } = createSteps({
      closeConnections: () => Promise.reject(new Error('pool close hung')),
    });

    await runShutdown(steps);

    expect(order).toContain('flush-store-writes');
    expect(order.at(-1)).toBe('exit');
  });

  it('writes to disk from the force-exit net, which is the one path that used not to', async () => {
    vi.useFakeTimers();
    try {
      const { steps, order } = createSteps();

      const pending = runShutdown({
        ...steps,
        // A renderer that never answers, so the `await` below the request never resumes and the
        // NORMAL flush is unreachable. That is what makes this test bite: the net is now the only
        // path that can write, so deleting its flush leaves `['…', 'exit']` with nothing written.
        // Hanging `closeConnections` instead would not have caught it — the normal flush has
        // already run by then, and the assertion passed either way.
        requestRendererFlush: () =>
          new Promise(() => {
            order.push('request-renderer-flush');
          }),
        forceExitTimeoutMs: 3_000,
      });

      await vi.advanceTimersByTimeAsync(3_000);

      // Exactly this, in this order: the net flushes and then exits once. The flush is idempotent
      // (`TrailingDebounce.flush()` is a no-op with nothing pending), so arriving here after a
      // normal flush cannot double-write.
      expect(order).toEqual([
        'request-renderer-flush',
        'cancel-in-flight-work',
        'flush-store-writes',
        'exit',
      ]);
      void pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an unbounded force-exit net', () => {
    const { steps } = createSteps({ forceExitTimeoutMs: 0 });

    // Synchronously, not as a rejection: a shutdown that rejects is a shutdown that never exits.
    expect(() => runShutdown(steps)).toThrow(/must be > 0/);
  });
});
