import { describe, expect, it, vi } from 'vitest';

import { QueryTimeoutError, resolveQueryTimeoutMs, withQueryTimeout } from './query-timeout';

describe('resolveQueryTimeoutMs', () => {
  it('passes a sane per-query timeout through', () => {
    expect(resolveQueryTimeoutMs(30_000)).toBe(30_000);
    expect(resolveQueryTimeoutMs(1)).toBe(1);
  });

  it('returns undefined when the request carries no timeout', () => {
    expect(resolveQueryTimeoutMs(undefined)).toBeUndefined();
  });

  /**
   * `QueryRequest` arrives over IPC, so these are inputs from outside the main process rather
   * than hypotheticals. Falling back to `undefined` means the pool's own timeout still applies.
   */
  it('refuses values that are not a positive duration', () => {
    expect(resolveQueryTimeoutMs(0)).toBeUndefined();
    expect(resolveQueryTimeoutMs(-1)).toBeUndefined();
    expect(resolveQueryTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveQueryTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('rounds to whole milliseconds', () => {
    expect(resolveQueryTimeoutMs(1500.6)).toBe(1501);
  });

  /**
   * The hazard that makes clamping load-bearing rather than tidy: Node coerces a delay above
   * 2^31-1 to 1ms, so an absurd timeout would time every query out instantly.
   */
  it('clamps to the largest delay setTimeout can hold', () => {
    expect(resolveQueryTimeoutMs(1e15)).toBe(2_147_483_647);
  });
});

describe('withQueryTimeout', () => {
  it('runs the work unguarded when there is no timeout', async () => {
    const abort = vi.fn();
    await expect(withQueryTimeout(undefined, abort, async () => 'done')).resolves.toBe('done');
    expect(abort).not.toHaveBeenCalled();
  });

  it('resolves with the work’s value and arms no lasting timer', async () => {
    const abort = vi.fn();
    await expect(withQueryTimeout(5_000, abort, async () => 'rows')).resolves.toBe('rows');
    expect(abort).not.toHaveBeenCalled();
  });

  it('propagates the work’s own failure untouched', async () => {
    const boom = new Error('syntax error at or near "SELCT"');
    await expect(withQueryTimeout(5_000, vi.fn(), () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('aborts and rejects with a QueryTimeoutError once the deadline passes', async () => {
    const abort = vi.fn();
    const outcome = await withQueryTimeout(
      10,
      abort,
      () => new Promise<never>(() => undefined)
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(QueryTimeoutError);
    expect((outcome as QueryTimeoutError).timeoutMs).toBe(10);
    expect((outcome as Error).message).toMatch(/timed out/i);
    expect(abort).toHaveBeenCalledTimes(1);
    // The caller needs the error to hand to `release()`, so it is passed in rather than rebuilt.
    expect(abort.mock.calls[0][0]).toBeInstanceOf(QueryTimeoutError);
  });

  /**
   * The ordering that would otherwise report a user cancellation for a timeout: mssql's
   * `Request.cancel()` calls the batch callback with `Canceled.`, and if that lands first the
   * race would settle on it.
   */
  it('still reports a timeout when the abort rejects the work first', async () => {
    const cancelled = new Error('Canceled.');
    let rejectWork: ((error: Error) => void) | undefined;
    const outcome = await withQueryTimeout(
      10,
      () => rejectWork?.(cancelled),
      () => new Promise<never>((_, reject) => (rejectWork = reject))
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(QueryTimeoutError);
  });

  /** A failed abort must not hide the deadline from the caller. */
  it('reports the timeout even when the abort itself throws', async () => {
    const outcome = await withQueryTimeout(
      10,
      () => {
        throw new Error('connection already gone');
      },
      () => new Promise<never>(() => undefined)
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(QueryTimeoutError);
  });

  it('rejects a timeout that is not a positive duration, rather than arming a bad timer', async () => {
    await expect(withQueryTimeout(0, vi.fn(), async () => 1)).rejects.toThrow(/positive/);
  });
});
