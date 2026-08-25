import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrailingDebounce } from './trailing-debounce';

describe('createTrailingDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes the fn once after the wait elapses, not per call', () => {
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, 500);

    for (let i = 0; i < 50; i++) {
      d.call();
      vi.advanceTimersByTime(10);
    }
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires again for a new burst after a quiet period', () => {
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, 500);

    d.call();
    vi.advanceTimersByTime(500);
    d.call();
    vi.advanceTimersByTime(500);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('flush() runs a pending call immediately and cancels the timer', () => {
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, 500);

    d.call();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending is a no-op', () => {
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, 500);

    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending call without running it', () => {
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, 500);

    d.call();
    d.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a non-positive wait', () => {
    // The callback is never reached — the constructor throws on the wait — so it stays empty and
    // says so, rather than pretending to be a subject of these assertions.
    const unreached = (): void => {
      throw new Error('the debounced callback should never run when construction throws');
    };

    expect(() => createTrailingDebounce(unreached, 0)).toThrow();
    expect(() => createTrailingDebounce(unreached, -5)).toThrow();
  });
});
