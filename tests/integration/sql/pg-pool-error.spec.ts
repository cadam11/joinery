/**
 * J-175 — a server-side FATAL on an *idle* pooled PostgreSQL connection must be a logged,
 * recoverable eviction, not an uncaught exception in the Electron main process.
 *
 * `ConnectionPoolManager` built every `PgPool` without ever calling `pool.on('error', …)`.
 * pg-pool's idle listener (pg-pool 3.14.0, `index.js:51-63`) removes the client from the pool and
 * then calls `pool.emit('error', err, client)`; a Node `EventEmitter` with no `'error'` listener
 * rethrows from inside `emit`, and because that emit happens on a socket callback rather than on
 * an awaited promise, the throw surfaces as an uncaught exception. In the packaged app that is a
 * crash. The trigger needs no bug and no unusual setup: a Postgres restart, an admin
 * `pg_terminate_backend`, or `DROP DATABASE … WITH (FORCE)` — including Joinery's own
 * drop-database flow — all deliver `57P01` to whatever connection the pool is holding idle.
 *
 * This test is here rather than in the unit tier because the property under test is what the real
 * driver does with a real socket that a real server closed underneath it. The unit tier's
 * `pool-error-listener.spec.ts` owns the "every pool construction site is guarded" half.
 *
 * Nothing here is a double except the profile store, which is faked so no Keychain is touched —
 * the same two-method fake as `tests/integration/sql/query-timeout.spec.ts` and
 * `tests/integration/sql/mysql-pool-trust.spec.ts`, copied from the surface
 * `connection-pool.ts` actually calls (`getById`, `getPassword`).
 *
 * Red before the fix, on this exact file: the terminate produced
 *   `error: terminating connection due to administrator command` (code 57P01)
 * in `uncaught`, and vitest additionally reported it as an unhandled error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';

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

/** Bound on every wait in this file. Eviction is a socket round trip, not a timer. */
const EVICTION_TIMEOUT_MS = 10_000;

afterEach(async () => {
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.getInstance().stopCleanupTimer();
  ConnectionPoolManager.resetInstance();
  fakeProfiles.clear();
  fakePasswords.clear();
});

describe('a FATAL on an idle pooled PostgreSQL connection', () => {
  it('is logged and evicted rather than crashing the main process', async () => {
    await withFreshDatabase('postgres', async db => {
      const connectionId = registerProfile(db.databaseName);
      const manager = ConnectionPoolManager.getInstance();
      const errors: string[] = [];
      const stopLogging = onLogEntry(entry => {
        if (entry.level === 'error') errors.push(entry.message);
      });

      try {
        const pool = await manager.getPgPool(connectionId, db.databaseName);

        // One query, then the client goes back to the pool. `max` is 10 but only one
        // physical connection has ever been opened, so this pid is the idle client's.
        const { rows } = await pool.query<{ pid: string }>('SELECT pg_backend_pid() AS pid');
        const pid = Number(rows[0].pid);
        expect(Number.isInteger(pid)).toBe(true);
        expect(pool.totalCount).toBe(1);

        const uncaught = await captureUncaught(async () => {
          await terminateBackend(pid);
          // pg-pool's `_remove` runs before the emit, so totalCount reaching 0 means the
          // error has already travelled the whole path this test is about.
          await waitFor(() => pool.totalCount === 0);
        });

        expect(uncaught.map(err => `${err.message}`)).toEqual([]);
        expect(pool.totalCount).toBe(0);
        expect(errors.some(m => /Pool error/.test(m) && /57P01/.test(m))).toBe(true);

        // Recoverable: the pool opens a fresh connection on the next query.
        const after = await pool.query<{ one: number }>('SELECT 1 AS one');
        expect(after.rows[0]).toEqual({ one: 1 });
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
  const c = TEST_CONNECTIONS.postgres;
  fakeProfiles.set(connectionId, {
    id: connectionId,
    name: `postgres-j175`,
    engine: 'postgresql',
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

/** Kill one backend from a separate admin connection, the way a DBA or a restart would. */
async function terminateBackend(pid: number): Promise<void> {
  const c = TEST_CONNECTIONS.postgres;
  const admin = new PgClient({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  } finally {
    await admin.end();
  }
}

/**
 * Collect anything that reaches `process.on('uncaughtException')` while `fn` runs.
 *
 * Vitest installs its own handler, which would report the crash as an unhandled error against the
 * whole file instead of as this test's assertion; it is detached for the duration and restored in
 * `finally`. Safe here because the integration project runs with `fileParallelism: false` and the
 * tests in a file run in sequence.
 */
async function captureUncaught(fn: () => Promise<void>): Promise<Error[]> {
  const uncaught: Error[] = [];
  const existing = process.listeners('uncaughtException');
  existing.forEach(listener => process.removeListener('uncaughtException', listener));
  const collect = (err: Error): void => {
    uncaught.push(err);
  };
  process.on('uncaughtException', collect);
  try {
    await fn();
    return uncaught;
  } finally {
    process.removeListener('uncaughtException', collect);
    existing.forEach(listener => process.on('uncaughtException', listener));
  }
}

/** Poll `predicate` until true or the bound elapses. Never loops unbounded. */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + EVICTION_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
