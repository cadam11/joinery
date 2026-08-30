/**
 * J-137 — which MySQL trust level each query channel asks for.
 *
 * The trust split only holds if the *call sites* keep asking for the right
 * pool, and there is exactly one call site in the whole main process that is
 * entitled to the multi-statement one: `QUERY.EXECUTE`, the editor channel.
 * Everything else — here, `QUERY.FETCH_FK_RECORD`, whose predicate carries a
 * result-set cell value — must leave the option off and get the restricted
 * pool. Without this spec, deleting `{ mysqlTrust: 'script' }` from the editor
 * handler, or adding it to another one, is an invisible change.
 *
 * Read `QUERY.EXECUTE` as "the channel the renderer runs SQL on", not "the
 * editor": `row-detail-panel.tsx`'s foreign-key preview also uses it, with a
 * predicate built from a result-set cell, because the FETCH_FK_RECORD handler
 * below emits T-SQL and is unusable on PostgreSQL and MySQL. So the value this
 * spec's second case guards is not on the path the app actually takes — the
 * renderer preview is still on the script pool. Recorded here so the next
 * person does not read a green suite as coverage it does not have.
 *
 * Harness copied from `credentials.ipc.spec.ts`: `electron` is replaced with
 * the members this file touches and the registered handlers are captured so
 * they can be invoked directly. `QueryExecutor` is a **recorder** — it runs no
 * SQL and makes no routing decision of its own, it only records the
 * `(request, options)` pair it was handed, so it cannot make a wrong call site
 * look right. Its surface matches the real class's `execute` /`cancel`.
 * The behaviour of the pools themselves is proved against the live MySQL
 * server in `tests/integration/sql/mysql-pool-trust.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@joinery/shared';
import type { QueryRequest, QueryResult } from '@joinery/shared';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** Every QueryExecutor.execute call, in order. */
  executed: [] as { sql: string; options: unknown }[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
}));

vi.mock('../services/sql/query-executor', () => ({
  QueryExecutor: {
    getInstance: () => ({
      execute: async (request: QueryRequest, options?: unknown): Promise<QueryResult> => {
        harness.executed.push({ sql: request.sql, options });
        return {
          queryId: 'q1',
          success: true,
          resultSets: [{ columns: [], rows: [{ id: 1 }], rowCount: 1 }],
          messages: [],
          rowsAffected: 0,
          executionTime: 1,
        };
      },
      cancel: async () => undefined,
    }),
  },
}));

vi.mock('../services/config/query-history', () => ({
  QueryHistoryStore: { getInstance: () => ({ add: () => undefined }) },
}));

vi.mock('../services/config/connection-profiles', () => ({
  ConnectionProfilesStore: { getInstance: () => ({ getById: () => undefined }) },
}));

vi.mock('../services/sql/connection-pool', () => ({
  ConnectionPoolManager: { getInstance: () => ({ getEngineForProfile: () => 'mysql' }) },
}));

// Static, not dynamic: vitest hoists the mocks above every import, and this
// package emits CommonJS, which has no top-level await.
import { registerQueryHandlers } from './query.ipc';

/** Invoke a captured handler the way `ipcRenderer.invoke` would. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, ...args);
}

describe('MySQL pool trust per query channel (J-137)', () => {
  beforeEach(() => {
    harness.handlers.clear();
    harness.executed = [];
    registerQueryHandlers();
  });

  it('runs the editor channel on the script pool', async () => {
    await invoke(IPC_CHANNELS.QUERY.EXECUTE, {
      connectionId: 'c1',
      database: 'appdb',
      sql: 'SELECT 1; SELECT 2',
    } satisfies QueryRequest);

    expect(harness.executed).toHaveLength(1);
    expect(harness.executed[0].options).toEqual({ mysqlTrust: 'script' });
  });

  it('runs the FETCH_FK_RECORD handler on the restricted pool', async () => {
    await invoke(IPC_CHANNELS.QUERY.FETCH_FK_RECORD, {
      connectionId: 'c1',
      database: 'appdb',
      schema: 'appdb',
      table: 'orders',
      column: 'customer_id',
      value: String.raw`x\'; DROP TABLE t; -- `,
    });

    expect(harness.executed).toHaveLength(1);
    // Undefined, not `{ mysqlTrust: 'restricted' }`: the executor's default is
    // restricted, and this handler must not be able to opt out of it.
    expect(harness.executed[0].options).toBeUndefined();
  });

  it('asks for the script pool on exactly one channel', async () => {
    await invoke(IPC_CHANNELS.QUERY.EXECUTE, {
      connectionId: 'c1',
      database: 'appdb',
      sql: 'SELECT 1',
    } satisfies QueryRequest);
    await invoke(IPC_CHANNELS.QUERY.FETCH_FK_RECORD, {
      connectionId: 'c1',
      database: 'appdb',
      schema: 'appdb',
      table: 'orders',
      column: 'customer_id',
      value: 'x',
    });

    const scripted = harness.executed.filter(
      call => (call.options as { mysqlTrust?: string } | undefined)?.mysqlTrust === 'script'
    );
    expect(scripted).toHaveLength(1);
    expect(scripted[0].sql).toBe('SELECT 1');
  });
});
