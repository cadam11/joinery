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
 *     → `.query(sql)` / `.execute(sql, values)` — since J-135 the metadata path takes the
 *       second, a server-side prepared statement, so the stub answers both the same way
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
    execute: async () => [recorder.rows, []],
    getConnection: async () => ({
      query: async () => [recorder.rows, []],
      execute: async () => [recorder.rows, []],
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
    // Any main-process caller that hands the executor SQL it built itself, rather than SQL a
    // user typed, must not inherit the editor's multi-statement connection. (The FK lookup used
    // to be the example here; since J-145 it binds its value and goes to the pool directly —
    // see `fk-record.ts` — so what this guards is the executor's DEFAULT, for every other caller.)
    await QueryExecutor.getInstance().execute({
      connectionId: CONNECTION_ID,
      database: DATABASE,
      sql: "SELECT * FROM `t` WHERE `c` = 'x' LIMIT 1",
    });

    expect(recorder.asked).toEqual([{ database: DATABASE, trust: 'restricted' }]);
  });
});
