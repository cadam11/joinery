/**
 * J-184 — a server-side kill of a pooled MySQL connection must reach the output panel.
 *
 * mysql2's `PoolConnection` constructor registers `once('error', () => this._removeFromPool())`
 * (`mysql2/lib/pool_connection.js:14-16`), so the eviction itself has always worked: the pool drops
 * the dead connection and the next query opens a fresh one. What it did *not* do was say so.
 * PostgreSQL and SQL Server both name the pool and the driver's code after J-175; MySQL said
 * nothing at all, which is the gap this closes. There is no crash to fix here — `_notifyError`
 * early-returns on `_fatalError` (`mysql2/lib/base/connection.js:264`) and `protocolError` on
 * `_closing` (`:452`), so a second error on the same dead connection reaches no unlistened `emit`.
 *
 * This test is here rather than in the unit tier because the property it proves is one no double
 * can: that the promise pool's `'connection'` event really does reach a listener with the live
 * core `PoolConnection` as its argument. `PromisePool` does not emit it itself — it re-emits from
 * the core pool through `inheritEvents` (`lib/promise/pool.js:18`), which subscribes lazily on
 * `newListener` and forwards the original arguments. The unit tier's `pool-error-listener.spec.ts`
 * owns the "every construction site is guarded" half.
 *
 * Red before the fix, on this exact file: the kill evicted the connection (`SHOW STATUS` back to a
 * single thread, next query fine) with no `MySQL connection error` line logged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

import { TEST_CONNECTIONS, withFreshDatabase } from '../../helpers/db-fixtures.js';

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
const { onLogEntry } = await import('@joinery/main/utils/logger');

/** Bound on every wait in this file. The eviction is a socket round trip, not a timer. */
const EVICTION_TIMEOUT_MS = 10_000;

afterEach(async () => {
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.getInstance().stopCleanupTimer();
  ConnectionPoolManager.resetInstance();
  fakeProfiles.clear();
  fakePasswords.clear();
});

describe('a killed pooled MySQL connection', () => {
  it('is named in the log, and the pool still recovers', async () => {
    await withFreshDatabase('mysql', async db => {
      const connectionId = registerProfile(db.databaseName);
      const manager = ConnectionPoolManager.getInstance();
      const errors: string[] = [];
      const stopLogging = onLogEntry(entry => {
        if (entry.level === 'error') errors.push(entry.message);
      });

      try {
        const pool = await manager.getMySQLPool(connectionId, db.databaseName);

        // One query, then the connection goes back to the pool. Only one physical connection has
        // ever been opened, so this thread id is the idle one's.
        const [rows] = await pool.query<mysql.RowDataPacket[]>(
          'SELECT CONNECTION_ID() AS id, DATABASE() AS db'
        );
        const threadId = Number(rows[0].id);
        expect(Number.isInteger(threadId)).toBe(true);
        expect(rows[0].db).toBe(db.databaseName);

        await killConnection(threadId);
        await waitFor(() => errors.some(m => /MySQL connection error/.test(m)));

        const line = errors.find(m => /MySQL connection error/.test(m));
        expect(line).toBeDefined();
        expect(line).toContain('mysql-j184');
        // The server closing the socket under an idle pooled connection.
        expect(line).toContain('PROTOCOL_CONNECTION_LOST');
        // No password assertion here: the harness password is literally `joinery`, which is also
        // the prefix of every fixture database name, so the check would pass or fail for the wrong
        // reason. `pool-error-listener.spec.ts` makes it against a password that appears nowhere
        // else.

        // Recoverable, exactly as before: the pool opens a fresh connection on the next query.
        const [after] = await pool.query<mysql.RowDataPacket[]>('SELECT 1 AS one');
        expect(after[0].one).toBe(1);
      } finally {
        stopLogging();
        await manager.closeAll();
      }
    });
  });
});

// ---- helpers ----

function registerProfile(dbName: string): string {
  const connectionId = randomUUID();
  const c = TEST_CONNECTIONS.mysql;
  fakeProfiles.set(connectionId, {
    id: connectionId,
    name: 'mysql-j184',
    engine: 'mysql',
    server: c.host,
    port: c.port,
    username: c.user,
    database: dbName,
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 30,
    requestTimeout: 120,
  });
  fakePasswords.set(connectionId, c.password);
  return connectionId;
}

/** Kill one connection from a separate admin session, the way a DBA or a restart would. */
async function killConnection(threadId: number): Promise<void> {
  const c = TEST_CONNECTIONS.mysql;
  const admin = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
  });
  try {
    // `threadId` came back from the server as an integer; `KILL` takes no placeholder.
    await admin.query(`KILL ${Number(threadId)}`);
  } finally {
    await admin.end();
  }
}

/** Poll `predicate` until true or the bound elapses. Never loops unbounded. */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + EVICTION_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
