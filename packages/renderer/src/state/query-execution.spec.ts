/**
 * The execution store: the running registry the status bar reads, and the stale-result rule that stops a
 * slow query overwriting a fast one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryRequest, QueryResult } from '@joinery/shared';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { setDiagnosticsSink, setNotifier } from './diagnostics';
import {
  createQueryExecutionStore,
  selectAnyExecuting,
  selectIsExecuting,
  selectResultFor,
  selectRunningCount,
  selectSqlFor,
} from './query-execution';

const REQUEST = {
  tabId: 'tab-1',
  tabTitle: 'Query 1',
  connectionId: 'conn-1',
  database: 'shop',
  sql: 'select 1',
  maxRows: 10_000,
  timeout: 30_000,
};

const okResult = (queryId = 'query-1'): QueryResult => ({
  queryId,
  success: true,
  resultSets: [{ columns: [], rows: [] }],
  executionTime: 3,
});

const teardowns: (() => void)[] = [];
const notifications: string[] = [];
const errors: string[] = [];

function quiet(): void {
  notifications.length = 0;
  errors.length = 0;
  teardowns.push(
    setDiagnosticsSink({ error: context => errors.push(context), warn: () => undefined }),
    setNotifier({
      success: message => notifications.push(`success:${message}`),
      error: message => notifications.push(`error:${message}`),
      info: message => notifications.push(`info:${message}`),
      warning: message => notifications.push(`warning:${message}`),
    })
  );
}

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  vi.useRealTimers();
});

describe('execute', () => {
  it('records the tab as running, then stores the result and stops running', async () => {
    quiet();
    let resolveExecute: ((result: QueryResult) => void) | undefined;
    teardowns.push(
      installJoineryMock({
        query: { execute: () => new Promise<QueryResult>(resolve => (resolveExecute = resolve)) },
      })
    );
    const store = createQueryExecutionStore();

    const pending = store.getState().execute(REQUEST);
    expect(selectIsExecuting('tab-1')(store.getState())).toBe(true);
    expect(selectAnyExecuting(store.getState())).toBe(true);
    expect(selectRunningCount(store.getState())).toBe(1);

    resolveExecute?.(okResult());
    await pending;

    expect(selectIsExecuting('tab-1')(store.getState())).toBe(false);
    expect(selectResultFor('tab-1')(store.getState())?.success).toBe(true);
  });

  it('passes the tab id and the row cap through to the bridge', async () => {
    quiet();
    // The parameter is declared so the recorded call is typed; the bridge's own signature is
    // `(request: QueryRequest) => Promise<QueryResult>`.
    const execute = vi.fn(async (_request: QueryRequest) => okResult());
    teardowns.push(installJoineryMock({ query: { execute } }));

    await createQueryExecutionStore().getState().execute(REQUEST);

    // `tabId` is what makes the main process persist the snapshot itself instead of the renderer
    // shipping the whole result set back over IPC; `maxRows` is what truncates before it crosses;
    // `timeout` is the deadline the executor enforces per engine (J-54).
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        maxRows: 10_000,
        timeout: 30_000,
        sql: 'select 1',
        database: 'shop',
      })
    );
    // `query-<millis>-<n>`: the Angular prefix and timestamp, so main-process logs stay greppable,
    // plus the monotonic suffix that makes two runs in one millisecond distinguishable.
    expect(execute.mock.calls[0]?.[0].queryId).toMatch(/^query-\d+-\d+$/);
  });

  /**
   * The collision window, opened deliberately.
   *
   * With `query-${Date.now()}` alone, two executes inside one millisecond mint the SAME id — and the
   * supersede rule is an id comparison (`running.get(tabId)?.queryId !== queryId`). Equal ids make that
   * comparison answer "still ours" for a request that has been replaced, so the superseded first run
   * writes its result over the second's and the `finally` clears the second's running record. Fake
   * timers freeze the clock so the window is the whole test rather than a race that reproduces once in
   * a thousand runs.
   */
  it('keeps the supersede rule working for two executes in the SAME millisecond', async () => {
    quiet();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'));

    const ids: string[] = [];
    let resolveFirst: ((result: QueryResult) => void) | undefined;
    let call = 0;
    teardowns.push(
      installJoineryMock({
        query: {
          cancel: async () => undefined,
          execute: (request: QueryRequest) => {
            ids.push(request.queryId ?? '');
            call += 1;
            if (call === 1) return new Promise<QueryResult>(resolve => (resolveFirst = resolve));
            return Promise.resolve({ ...okResult('second'), queryId: request.queryId });
          },
        },
      })
    );
    const store = createQueryExecutionStore();

    const first = store.getState().execute(REQUEST);
    const second = store.getState().execute(REQUEST);
    const secondResult = await second;

    // Same clock, different ids — which is the fix, stated as the precondition of everything below.
    expect(new Date().getMilliseconds()).toBe(0);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    // And the rule holds: the first run's late result is dropped, the second's is what the tab shows,
    // and the tab is not left marked as running by the loser's `finally`.
    resolveFirst?.(okResult(ids[0]));
    expect(await first).toBeNull();
    expect(selectResultFor('tab-1')(store.getState())?.queryId).toBe(ids[1]);
    expect(secondResult?.queryId).toBe(ids[1]);
    expect(selectIsExecuting('tab-1')(store.getState())).toBe(false);
  });

  it('clears the previous result the moment a new run starts', async () => {
    quiet();
    let resolveSecond: ((result: QueryResult) => void) | undefined;
    let call = 0;
    teardowns.push(
      installJoineryMock({
        query: {
          execute: () => {
            call += 1;
            if (call === 1) return Promise.resolve(okResult());
            return new Promise<QueryResult>(resolve => (resolveSecond = resolve));
          },
        },
      })
    );
    const store = createQueryExecutionStore();

    await store.getState().execute(REQUEST);
    expect(selectResultFor('tab-1')(store.getState())).not.toBeNull();

    const second = store.getState().execute(REQUEST);
    // A grid still showing the last query's rows under a spinner is worse than an empty pane.
    expect(selectResultFor('tab-1')(store.getState())).toBeNull();
    resolveSecond?.(okResult('query-2'));
    await second;
  });

  it('turns a rejected execute into a failed result rather than throwing', async () => {
    quiet();
    teardowns.push(
      installJoineryMock({ query: { execute: () => Promise.reject(new Error('connection lost')) } })
    );
    const store = createQueryExecutionStore();

    const result = await store.getState().execute(REQUEST);

    expect(result?.success).toBe(false);
    expect(result?.error).toBe('connection lost');
    expect(selectResultFor('tab-1')(store.getState())?.error).toBe('connection lost');
    expect(errors).toEqual(['query execution failed']);
    expect(selectIsExecuting('tab-1')(store.getState())).toBe(false);
  });

  it('cancels a query already in flight for the same tab before starting the next', async () => {
    quiet();
    const cancel = vi.fn(async () => undefined);
    let resolveFirst: ((result: QueryResult) => void) | undefined;
    let call = 0;
    teardowns.push(
      installJoineryMock({
        query: {
          cancel,
          execute: () => {
            call += 1;
            if (call === 1) return new Promise<QueryResult>(resolve => (resolveFirst = resolve));
            return Promise.resolve(okResult('query-2'));
          },
        },
      })
    );
    const store = createQueryExecutionStore();

    const first = store.getState().execute(REQUEST);
    const second = store.getState().execute(REQUEST);
    await second;

    expect(cancel).toHaveBeenCalledTimes(1);
    // The first execute's own promise still settles, and its result must NOT land: the store's record
    // belongs to the second run by then. This is the stale-result rule.
    resolveFirst?.(okResult('query-1'));
    expect(await first).toBeNull();
    expect(selectResultFor('tab-1')(store.getState())?.queryId).toBe('query-2');
  });

  it('leaves a second tab’s run alone', async () => {
    quiet();
    teardowns.push(installJoineryMock({ query: { execute: () => Promise.resolve(okResult()) } }));
    const store = createQueryExecutionStore();

    await Promise.all([
      store.getState().execute(REQUEST),
      store.getState().execute({ ...REQUEST, tabId: 'tab-2' }),
    ]);

    expect(selectResultFor('tab-1')(store.getState())).not.toBeNull();
    expect(selectResultFor('tab-2')(store.getState())).not.toBeNull();
    expect(selectRunningCount(store.getState())).toBe(0);
  });

  it('does nothing at all without a bridge', async () => {
    quiet();
    const store = createQueryExecutionStore();
    expect(await store.getState().execute(REQUEST)).toBeNull();
    expect(selectAnyExecuting(store.getState())).toBe(false);
  });
});

describe('cancel', () => {
  it('sends the running query’s id and reports it', async () => {
    quiet();
    const cancel = vi.fn(async () => undefined);
    teardowns.push(
      installJoineryMock({
        query: { cancel, execute: () => new Promise<QueryResult>(() => undefined) },
      })
    );
    const store = createQueryExecutionStore();
    void store.getState().execute(REQUEST);
    const queryId = store.getState().running.get('tab-1')?.queryId;

    await store.getState().cancel('tab-1');

    expect(cancel).toHaveBeenCalledWith(queryId);
    expect(notifications).toContain('info:Query cancelled');
    expect(selectIsExecuting('tab-1')(store.getState())).toBe(false);
  });

  it('clears the running flag before awaiting, so Cancel cannot be offered twice', async () => {
    quiet();
    let resolveCancel: (() => void) | undefined;
    teardowns.push(
      installJoineryMock({
        query: {
          cancel: () => new Promise<void>(resolve => (resolveCancel = resolve)),
          execute: () => new Promise<QueryResult>(() => undefined),
        },
      })
    );
    const store = createQueryExecutionStore();
    void store.getState().execute(REQUEST);

    const pending = store.getState().cancel('tab-1');
    expect(selectIsExecuting('tab-1')(store.getState())).toBe(false);
    resolveCancel?.();
    await pending;
  });

  it('is a no-op for a tab with nothing running', async () => {
    quiet();
    const cancel = vi.fn(async () => undefined);
    teardowns.push(installJoineryMock({ query: { cancel } }));
    await createQueryExecutionStore().getState().cancel('tab-1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reports a failed cancel', async () => {
    quiet();
    teardowns.push(
      installJoineryMock({
        query: {
          cancel: () => Promise.reject(new Error('already finished')),
          execute: () => new Promise<QueryResult>(() => undefined),
        },
      })
    );
    const store = createQueryExecutionStore();
    void store.getState().execute(REQUEST);

    await store.getState().cancel('tab-1');

    expect(notifications).toContain('error:Could not cancel the query');
    expect(errors).toEqual(['failed to cancel query']);
  });
});

describe('setResult and forgetTab', () => {
  it('setResult replaces what a tab is showing — the historical-snapshot path', () => {
    const store = createQueryExecutionStore();
    store.getState().setResult('tab-1', okResult('snapshot-9'));
    expect(selectResultFor('tab-1')(store.getState())?.queryId).toBe('snapshot-9');
    store.getState().setResult('tab-1', null);
    expect(selectResultFor('tab-1')(store.getState())).toBeNull();
  });

  it('forgetTab drops both the result and any running record', async () => {
    quiet();
    teardowns.push(
      installJoineryMock({ query: { execute: () => new Promise<QueryResult>(() => undefined) } })
    );
    const store = createQueryExecutionStore();
    void store.getState().execute(REQUEST);
    store.getState().setResult('tab-2', okResult());

    store.getState().forgetTab('tab-1');

    expect(selectRunningCount(store.getState())).toBe(0);
    expect(selectResultFor('tab-1')(store.getState())).toBeNull();
    expect(selectResultFor('tab-2')(store.getState())).not.toBeNull();
  });
});

describe('the SQL that produced the result', () => {
  it('is recorded with the result, and is the EXECUTED text', async () => {
    quiet();
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult() } }));
    const store = createQueryExecutionStore();

    await store.getState().execute({ ...REQUEST, sql: 'SELECT id FROM customers' });

    expect(selectSqlFor('tab-1')(store.getState())).toBe('SELECT id FROM customers');
  });

  it('is cleared the moment a new run starts, so it can never describe the old result', async () => {
    quiet();
    let release: (() => void) | undefined;
    teardowns.push(
      installJoineryMock({
        query: {
          execute: () =>
            new Promise<QueryResult>(resolve => {
              release = () => resolve(okResult('query-2'));
            }),
        },
      })
    );
    const store = createQueryExecutionStore();
    store.setState({
      results: new Map([['tab-1', okResult('query-1')]]),
      sqlByTab: new Map([['tab-1', 'SELECT 1']]),
    });

    const running = store.getState().execute({ ...REQUEST, sql: 'SELECT 2' });
    expect(selectSqlFor('tab-1')(store.getState())).toBeNull();
    expect(selectResultFor('tab-1')(store.getState())).toBeNull();

    release?.();
    await running;
    expect(selectSqlFor('tab-1')(store.getState())).toBe('SELECT 2');
  });

  it('is recorded for a FAILED run too — the inspector still has a result to describe', async () => {
    quiet();
    teardowns.push(
      installJoineryMock({
        query: {
          execute: () => Promise.reject(new Error('syntax error')),
        },
      })
    );
    const store = createQueryExecutionStore();

    await store.getState().execute({ ...REQUEST, sql: 'SELEC 1' });

    expect(selectSqlFor('tab-1')(store.getState())).toBe('SELEC 1');
  });

  it('travels with setResult, and is FORGOTTEN when setResult omits it', () => {
    const store = createQueryExecutionStore();

    store.getState().setResult('tab-1', okResult('snap-1'), 'SELECT * FROM snapshot');
    expect(selectSqlFor('tab-1')(store.getState())).toBe('SELECT * FROM snapshot');

    // A caller with no SQL to offer must not leave the previous statement attached to a new result.
    store.getState().setResult('tab-1', okResult('snap-2'));
    expect(selectSqlFor('tab-1')(store.getState())).toBeNull();
  });

  it('is dropped by forgetTab', () => {
    const store = createQueryExecutionStore();
    store.getState().setResult('tab-1', okResult(), 'SELECT 1');

    store.getState().forgetTab('tab-1');

    expect(selectSqlFor('tab-1')(store.getState())).toBeNull();
  });
});

describe('the selectors', () => {
  it('answer for an undefined tab without throwing', () => {
    const store = createQueryExecutionStore();
    expect(selectIsExecuting(undefined)(store.getState())).toBe(false);
    expect(selectResultFor(undefined)(store.getState())).toBeNull();
    expect(selectSqlFor(undefined)(store.getState())).toBeNull();
  });
});
