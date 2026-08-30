/**
 * J-137 — which MySQL pool each caller asks for.
 *
 * `mysql-pool-options.spec.ts` pins what the two pools *are*. This pins the
 * routing: every caller that only ever sends one statement must ask for the
 * `restricted` pool, and the query editor — the one path that genuinely needs
 * `CLIENT_MULTI_STATEMENTS` — must ask for `script` and keep working.
 *
 * On the doubles: `ConnectionPoolManager` is replaced by a **recorder**. It
 * builds no SQL, escapes nothing and decides nothing; it records the trust
 * level it was asked for and hands back a connection stub. So it cannot make a
 * broken routing decision look right. Its surface is copied from the real
 * class (`connection-pool.ts`):
 *   - `getEngineForProfile(profileId): DatabaseEngine`
 *   - `getDialectForProfile(profileId): SQLDialect`
 *   - `getMySQLPool(profileId, database?, trust?): Promise<MySQLPool>`
 *   - `isAzureSQL(profileId): Promise<boolean>`
 * The behaviour against a live MySQL server is proved in
 * `tests/integration/sql/mysql-pool-trust.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseEngine } from '@joinery/shared';

const recorder = vi.hoisted(() => ({
  /** Every getMySQLPool call, in order. */
  asked: [] as { database?: string; trust?: string }[],
  /** Rows the stub connection answers with. */
  rows: [] as Record<string, unknown>[],
}));

vi.mock('./connection-pool', async () => {
  const { MySQLDialect } = await import('./dialect/mysql-dialect');
  const dialect = new MySQLDialect();
  const pool = {
    query: async () => [recorder.rows, []],
    getConnection: async () => ({
      query: async () => [recorder.rows, []],
      release: () => undefined,
    }),
  };
  return {
    ConnectionPoolManager: {
      getInstance: () => ({
        getEngineForProfile: (): DatabaseEngine => 'mysql',
        getDialectForProfile: () => dialect,
        isAzureSQL: async () => false,
        getMySQLPool: async (_profileId: string, database?: string, trust?: string) => {
          recorder.asked.push({ database, trust });
          return pool;
        },
      }),
    },
  };
});

// Static, not dynamic: `vi.mock` above is hoisted over these, and packages/main
// forbids top-level await.
import { MetadataService } from './metadata';
import { QueryExecutor } from './query-executor';

const CONNECTION_ID = 'profile-1';
const DATABASE = 'appdb';

describe('MySQL pool trust routing', () => {
  beforeEach(() => {
    recorder.asked = [];
    recorder.rows = [];
    MetadataService.resetInstance();
    QueryExecutor.resetInstance();
  });

  it('serves metadata from the restricted pool', async () => {
    recorder.rows = [];
    await MetadataService.getInstance().listTables(CONNECTION_ID, DATABASE, true);

    expect(recorder.asked).toEqual([{ database: DATABASE, trust: 'restricted' }]);
  });

  it('runs the query editor on the script pool, which multi-statement scripts need', async () => {
    await QueryExecutor.getInstance().execute(
      { connectionId: CONNECTION_ID, database: DATABASE, sql: 'SELECT 1; SELECT 2' },
      { mysqlTrust: 'script' }
    );

    expect(recorder.asked).toEqual([{ database: DATABASE, trust: 'script' }]);
  });

  it('defaults an internally-built query to the restricted pool', async () => {
    // The FK-record lookup (query.ipc.ts FETCH_FK_RECORD) reaches the executor
    // with dialect-built, single-statement SQL carrying a result-set cell value.
    // It must not inherit the editor's multi-statement connection.
    await QueryExecutor.getInstance().execute({
      connectionId: CONNECTION_ID,
      database: DATABASE,
      sql: "SELECT * FROM `t` WHERE `c` = 'x' LIMIT 1",
    });

    expect(recorder.asked).toEqual([{ database: DATABASE, trust: 'restricted' }]);
  });
});
