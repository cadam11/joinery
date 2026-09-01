/**
 * J-137 — which MySQL pool each query channel ends up on.
 *
 * The trust split only holds if the *call sites* keep asking for the right pool, and there is
 * exactly one call site in the whole main process entitled to the multi-statement one:
 * `QUERY.EXECUTE`, the editor channel. Without this spec, deleting `{ mysqlTrust: 'script' }` from
 * that handler, or adding it to another one, is an invisible change.
 *
 * `QUERY.FETCH_FK_RECORD` is the other channel here, and J-145 changed what it proves. It used to
 * reach the pools through `QueryExecutor` with an escaped literal in its predicate, and — worse —
 * the React renderer did not call it at all: `row-detail-panel.tsx` built its own SQL and sent it
 * down `QUERY.EXECUTE`, so the FK preview really did run on the script pool and this spec's second
 * case guarded a value nothing produced. Now the handler binds its value and goes straight to the
 * restricted pool (`services/sql/fk-record.ts`), and the renderer is back on it, so what is
 * asserted below is: the FK lookup never touches `QueryExecutor`, and the pool it asks mysql2 for
 * is the restricted one.
 *
 * Harness copied from `credentials.ipc.spec.ts`: `electron` is replaced with the members this file
 * touches and the registered handlers are captured so they can be invoked directly. `QueryExecutor`
 * is a **recorder** — it runs no SQL and makes no routing decision of its own, it only records the
 * `(request, options)` pair it was handed, so it cannot make a wrong call site look right. Its
 * surface matches the real class's `execute` / `cancel`. The `ConnectionPoolManager` stand-in
 * likewise records which pool was asked for; its surface is copied from `connection-pool.ts`
 * (`getDialectForProfile:258`, `getEngineForProfile:267`, `getMySQLPool:733`), and the dialect it
 * returns is the REAL one, so the SQL below is production's SQL.
 *
 * The behaviour of the pools themselves is proved against the live MySQL server in
 * `tests/integration/sql/mysql-pool-trust.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@joinery/shared';
import type { QueryRequest, QueryResult } from '@joinery/shared';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** Every QueryExecutor.execute call, in order. */
  executed: [] as { sql: string; options: unknown }[],
  /** Every MySQL pool the FK path asked for. */
  mysqlPools: [] as { database: string | undefined; trust: string | undefined }[],
  /** Every statement the FK path sent, and how. */
  sent: [] as { via: string; sql: string; params: readonly unknown[] }[],
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

vi.mock('../services/sql/connection-pool', async () => {
  const { getDialect } = await import('../services/sql/dialect');
  return {
    ConnectionPoolManager: {
      getInstance: () => ({
        getEngineForProfile: () => 'mysql',
        getDialectForProfile: () => getDialect('mysql'),
        getMySQLPool: async (_id: string, database?: string, trust?: string) => {
          harness.mysqlPools.push({ database, trust });
          return {
            query: async (sql: string) => {
              harness.sent.push({ via: 'mysql.query(unbound)', sql, params: [] });
              return [[{ id: 1 }]];
            },
            execute: async (sql: string, values?: readonly unknown[]) => {
              harness.sent.push({ via: 'mysql.execute(bound)', sql, params: values ?? [] });
              return [[{ id: 1 }]];
            },
          };
        },
      }),
    },
  };
});

// Both methods are needed: `query-executor.ts:119` enriches MSSQL result columns with
// `getEnrichedColumnMetadata`, while since J-150 `fk-record.ts` reads `listColumns` alone. Neither
// is what this file measures — it counts POOLS — so both return nothing and issue no statement,
// which is also what keeps them out of `harness.sent`.
vi.mock('../services/sql/metadata', () => ({
  MetadataService: {
    getInstance: () => ({
      getEnrichedColumnMetadata: async () => [],
      listColumns: async () => [],
    }),
  },
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

const FK_REQUEST = {
  connectionId: 'c1',
  database: 'appdb',
  schema: 'appdb',
  table: 'orders',
  column: 'customer_id',
  value: String.raw`x\'; DROP TABLE t; -- `,
};

describe('MySQL pool trust per query channel (J-137)', () => {
  beforeEach(() => {
    harness.handlers.clear();
    harness.executed = [];
    harness.mysqlPools = [];
    harness.sent = [];
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

  it('runs the FK lookup on the restricted pool, bound, without the executor (J-145)', async () => {
    await invoke(IPC_CHANNELS.QUERY.FETCH_FK_RECORD, FK_REQUEST);

    expect(harness.executed).toHaveLength(0);
    expect(harness.mysqlPools).toEqual([{ database: 'appdb', trust: 'restricted' }]);
    expect(harness.sent).toEqual([
      {
        via: 'mysql.execute(bound)',
        sql: 'SELECT * FROM `appdb`.`orders` WHERE `customer_id` = ? LIMIT 1',
        params: [FK_REQUEST.value],
      },
    ]);
  });

  it('asks for the script pool on exactly one channel', async () => {
    await invoke(IPC_CHANNELS.QUERY.EXECUTE, {
      connectionId: 'c1',
      database: 'appdb',
      sql: 'SELECT 1',
    } satisfies QueryRequest);
    await invoke(IPC_CHANNELS.QUERY.FETCH_FK_RECORD, FK_REQUEST);

    const scripted = harness.executed.filter(
      call => (call.options as { mysqlTrust?: string } | undefined)?.mysqlTrust === 'script'
    );
    expect(scripted).toHaveLength(1);
    expect(scripted[0].sql).toBe('SELECT 1');
    expect(harness.mysqlPools.every(pool => pool.trust === 'restricted')).toBe(true);
  });
});
