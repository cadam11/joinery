/**
 * J-54 — the per-query timeout, proved against all three live engines.
 *
 * `QuerySettings.defaultTimeout` was written by the settings panel and read by nobody:
 * `QueryRequest.timeout` existed on the IPC contract and `QueryExecutor` never looked at it, so
 * the only deadline a query had was the pool's, derived from the connection profile. That made it
 * the same defect as J-44 — a control that persisted and changed nothing.
 *
 * The property under test is enforced by a real clock against a real server, which is why it lives
 * here rather than in the unit tier: `query-timeout.spec.ts` owns the timer's mechanics, and this
 * file asks whether an actual sleeping query on an actual connection stops.
 *
 * Everything is the real thing — the pool manager, the query executor, the drivers — except the
 * profile store, which is faked so no Keychain is touched (same fake as
 * `tests/integration/sql/mysql-pool-trust.spec.ts` and `tests/integration/ai/row-count-injection.spec.ts`).
 *
 * Mutation check, run: dropping the `withQueryTimeout` wrapper from the PostgreSQL branch of
 * `query-executor.ts` turns the first two PostgreSQL tests red after 30s each (the SLEEP runs to
 * completion and the query succeeds), while the third stays green — which is the point of the
 * third being there.
 *
 * The second test per engine is the one the abort strategy is for. A timed-out connection is
 * disowned rather than pooled — an mssql attention packet, `client.release(error)` on pg,
 * `conn.destroy()` on mysql2 — and the proof that this was necessary is that the NEXT query on the
 * same pool still answers correctly. Return the connection clean instead and pg hands out a client
 * with a response still inbound.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { TEST_CONNECTIONS, withFreshDatabase, type Engine } from '../../helpers/db-fixtures.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeProfiles: Map<string, any> = new Map();
const fakePasswords: Map<string, string> = new Map();

vi.mock('@joinery/main/services/config/connection-profiles', () => ({
  ConnectionProfilesStore: {
    getInstance: () => ({
      getById: (id: string) => fakeProfiles.get(id),
      getPassword: async (id: string) => fakePasswords.get(id) ?? null,
    }),
  },
}));

const { ConnectionPoolManager } = await import('@joinery/main/services/sql/connection-pool');
const { MetadataService } = await import('@joinery/main/services/sql/metadata');
const { QueryExecutor } = await import('@joinery/main/services/sql/query-executor');

/** Well past the 1s deadline below, so the deadline is the only reason the query can end. */
const SLEEP_SQL: Record<Engine, string> = {
  mssql: "WAITFOR DELAY '00:00:30'",
  postgres: 'SELECT pg_sleep(30)',
  mysql: 'SELECT SLEEP(30)',
};

const DEADLINE_MS = 1_000;

afterEach(async () => {
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.getInstance().stopCleanupTimer();
  ConnectionPoolManager.resetInstance();
  MetadataService.resetInstance();
  QueryExecutor.resetInstance();
  fakeProfiles.clear();
  fakePasswords.clear();
});

describe.each<Engine>(['postgres', 'mysql', 'mssql'])('the per-query timeout on %s', engine => {
  it('stops a query that outlives QueryRequest.timeout', async () => {
    await withConnection(engine, async (connectionId, databaseName) => {
      const started = Date.now();
      const result = await QueryExecutor.getInstance().execute({
        connectionId,
        database: databaseName,
        sql: SLEEP_SQL[engine],
        timeout: DEADLINE_MS,
      });
      const elapsed = Date.now() - started;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/i);
      // The deadline, not the sleep: a generous ceiling, because what would fail this is the
      // 30s sleep having run to completion.
      expect(elapsed).toBeLessThan(15_000);
    });
  });

  it('leaves the pool usable after a timeout, rather than pooling the abandoned connection', async () => {
    await withConnection(engine, async (connectionId, databaseName) => {
      const executor = QueryExecutor.getInstance();

      const timedOut = await executor.execute({
        connectionId,
        database: databaseName,
        sql: SLEEP_SQL[engine],
        timeout: DEADLINE_MS,
      });
      expect(timedOut.success).toBe(false);

      const after = await executor.execute({
        connectionId,
        database: databaseName,
        sql: 'SELECT 1 AS one',
      });

      expect(after.error).toBeUndefined();
      expect(after.success).toBe(true);
      expect(after.resultSets?.[0].rows[0]).toEqual({ one: 1 });
    });
  });

  it('runs a fast query untouched under the same deadline', async () => {
    await withConnection(engine, async (connectionId, databaseName) => {
      const result = await QueryExecutor.getInstance().execute({
        connectionId,
        database: databaseName,
        sql: 'SELECT 1 AS one',
        timeout: DEADLINE_MS,
      });

      expect(result.success).toBe(true);
      expect(result.resultSets?.[0].rows[0]).toEqual({ one: 1 });
    });
  });
});

// ---- helpers ----

/**
 * A fresh database, a profile pointing at it, and — the part that has to be here rather than in
 * `afterEach` — Joinery's pools released BEFORE the fixture drops that database.
 *
 * `withFreshDatabase` drops PostgreSQL databases `WITH (FORCE)`, which FATALs any connection still
 * open on them (`57P01`). pg-pool re-emits that on the Pool, so the pool would log an eviction in
 * the middle of an unrelated test's teardown. An `afterEach` cannot help: `withFreshDatabase`'s own
 * `finally` has already dropped the database by then. (Before J-175 this was worse than noise —
 * Joinery's pg pools carried no `'error'` listener, so the re-emit threw as an uncaught exception.
 * `tests/integration/sql/pg-pool-error.spec.ts` now owns that property.)
 */
async function withConnection(
  engine: Engine,
  fn: (connectionId: string, databaseName: string) => Promise<void>
): Promise<void> {
  await withFreshDatabase(engine, async db => {
    const connectionId = registerProfile(engine, db.databaseName);
    try {
      await fn(connectionId, db.databaseName);
    } finally {
      await ConnectionPoolManager.getInstance().closeAll();
    }
  });
}

/** The engine names the pool manager uses, which are not the fixture helper's. */
const PROFILE_ENGINE: Record<Engine, string> = {
  mssql: 'mssql',
  postgres: 'postgresql',
  mysql: 'mysql',
};

function registerProfile(engine: Engine, dbName: string): string {
  const connectionId = randomUUID();
  const c = TEST_CONNECTIONS[engine];
  fakeProfiles.set(connectionId, {
    id: connectionId,
    name: `${engine}-j54`,
    engine: PROFILE_ENGINE[engine],
    server: c.host,
    port: c.port,
    username: c.user,
    database: dbName,
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 30,
    // Deliberately long: the per-query deadline has to be what stops the query, not this.
    requestTimeout: 120,
  });
  fakePasswords.set(connectionId, c.password);
  return connectionId;
}
