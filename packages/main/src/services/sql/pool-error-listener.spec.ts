/**
 * J-175 — every driver pool `ConnectionPoolManager` builds carries an `'error'` listener.
 *
 * A driver pool is a Node `EventEmitter`, and an `EventEmitter` with no `'error'` listener
 * *rethrows* the error from inside `emit()`. Pool errors arrive on socket callbacks rather than on
 * an awaited promise, so that throw lands in the event loop as an uncaught exception — a crash of
 * the Electron main process. The live proof that this happens with no bug and no unusual setup is
 * `tests/integration/sql/pg-pool-error.spec.ts`; this file is the structural half, and it covers
 * the construction sites that tier cannot reach (the two throwaway "Test Connection" probes, and
 * SQL Server, whose emit path needs a server-side non-ESOCKET failure to provoke).
 *
 * On the doubles — the point of this spec is that they CANNOT encode the bug under test. The
 * failure mode is Node's own `EventEmitter.emit('error')`, so each double *is* a real
 * `EventEmitter`; an unguarded double throws for exactly the same reason the real pool does, and
 * the assertion is the real behaviour (`emit` does not throw, and the error reaches the log), not
 * "a listener was registered".
 *
 * Each double's surface was read off the real classes, not guessed:
 *  - pg 8.23.0 / pg-pool 3.14.0 — `pg-pool/index.js:65` `class Pool extends EventEmitter`;
 *    `connect()` resolves a pg `Client` — so it answers `query()` — with a `release()` attached
 *    (`index.js:200-243, 369-398`); `query()` on either resolves `{ rows }`; `end()` returns a
 *    promise. `@types/pg/index.d.ts:181` agrees.
 *  - mssql 11.0.1 — `@types/mssql/index.d.ts:248`
 *    `class ConnectionPool extends events.EventEmitter`; the probe path uses `connect()`,
 *    `request().query()` → `{ recordset }` and `close()`; `getPool` additionally reads
 *    `.connected`.
 *
 * mysql2 pools are deliberately absent. `PromisePool` inherits only
 * `acquire | connection | enqueue | release` from the core pool
 * (mysql2 3.23.3 `lib/promise/pool.js:18`) and neither pool class ever emits `'error'`, so a
 * listener on a mysql2 pool would be unreachable code. Its `PoolConnection` registers its own
 * (`lib/pool_connection.js:14-16`, `once('error', … _removeFromPool())`).
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import mssql from 'mssql';
import type { ConnectionProfile } from '@joinery/shared';
import { ConnectionPoolManager } from './connection-pool';
import { ConnectionProfilesStore } from '../config/connection-profiles';
import { onLogEntry } from '../../utils/logger';

// --- doubles ---------------------------------------------------------------

/** A pg `Pool`, in the shape `connection-pool.ts` uses it. A real EventEmitter, deliberately. */
class FakePgPool extends EventEmitter {
  connect(): Promise<{ query: FakePgPool['query']; release: () => void }> {
    return Promise.resolve({ query: () => this.query(), release: () => undefined });
  }
  query(): Promise<{ rows: Record<string, string>[] }> {
    return Promise.resolve({ rows: [{ version: 'PostgreSQL 16.2, x86_64', name: 'appdb' }] });
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
}

/** An mssql `ConnectionPool`, in the shape `connection-pool.ts` uses it. */
class FakeMssqlPool extends EventEmitter {
  readonly connected = true;
  connect(): Promise<this> {
    return Promise.resolve(this);
  }
  request(): { query: () => Promise<{ recordset: Record<string, string>[] }> } {
    return {
      query: () =>
        Promise.resolve({ recordset: [{ version: 'Microsoft SQL Server 2022', name: 'srv' }] }),
    };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// --- fixtures --------------------------------------------------------------

const PG_PROFILE: ConnectionProfile = {
  id: 'pg-profile',
  name: 'PG Profile',
  engine: 'postgresql',
  server: 'db.example.com',
  port: 5432,
  username: 'app',
  database: 'appdb',
  authenticationType: 'sql',
  encrypt: false,
  trustServerCertificate: true,
  connectionTimeout: 15,
  requestTimeout: 30,
};

const MSSQL_PROFILE: ConnectionProfile = {
  ...PG_PROFILE,
  id: 'mssql-profile',
  name: 'MSSQL Profile',
  engine: 'mssql',
  port: 1433,
  database: 'master',
};

/** A FATAL of the shape pg-pool re-emits on the pool for a terminated idle backend. */
function fatal(): Error & { code: string } {
  const err = new Error('terminating connection due to administrator command') as Error & {
    code: string;
  };
  err.code = '57P01';
  return err;
}

let pgPools: FakePgPool[] = [];
let mssqlPools: FakeMssqlPool[] = [];
let errorLog: string[] = [];
let stopLogging: () => void;

beforeEach(() => {
  pgPools = [];
  mssqlPools = [];
  errorLog = [];
  stopLogging = onLogEntry(entry => {
    if (entry.level === 'error') errorLog.push(entry.message);
  });

  // The drivers are reached through a property read on their module object at call time
  // (`pg.Pool`, `mssql.ConnectionPool`), which is what makes a spy land — a `vi.mock` of either
  // module would not, because the node project's setup file has already imported
  // `connection-pool.ts` and bound the real driver. See packages/main/src/__tests__/setup.ts.
  // `function`, not an arrow: these stand in for a constructor, and an object returned from a
  // constructor call is what `new` yields.
  vi.spyOn(pg, 'Pool').mockImplementation(function (): FakePgPool {
    const pool = new FakePgPool();
    pgPools.push(pool);
    return pool;
  } as unknown as typeof pg.Pool);

  vi.spyOn(mssql, 'ConnectionPool').mockImplementation(function (): FakeMssqlPool {
    const pool = new FakeMssqlPool();
    mssqlPools.push(pool);
    return pool;
  } as unknown as typeof mssql.ConnectionPool);

  const store = ConnectionProfilesStore.getInstance();
  vi.spyOn(store, 'getById').mockImplementation(id =>
    id === PG_PROFILE.id ? PG_PROFILE : id === MSSQL_PROFILE.id ? MSSQL_PROFILE : undefined
  );
  vi.spyOn(store, 'getPassword').mockResolvedValue('secret');
});

afterEach(async () => {
  stopLogging();
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.getInstance().stopCleanupTimer();
  ConnectionPoolManager.resetInstance();
  vi.restoreAllMocks();
});

// --- tests -----------------------------------------------------------------

describe('pool error listeners (J-175)', () => {
  it('guards the persistent PostgreSQL pool', async () => {
    await ConnectionPoolManager.getInstance().getPgPool(PG_PROFILE.id, 'appdb');

    expect(pgPools).toHaveLength(1);
    expect(() => pgPools[0].emit('error', fatal())).not.toThrow();
    expect(errorLog.some(m => /Pool error/.test(m) && /57P01/.test(m))).toBe(true);
  });

  it('guards the throwaway PostgreSQL probe pool', async () => {
    const result = await ConnectionPoolManager.getInstance().testConnection(PG_PROFILE, 'secret');
    expect(result.success).toBe(true);

    expect(pgPools).toHaveLength(1);
    expect(() => pgPools[0].emit('error', fatal())).not.toThrow();
    expect(errorLog.some(m => /Pool error/.test(m) && /57P01/.test(m))).toBe(true);
  });

  it('guards the persistent SQL Server pool', async () => {
    await ConnectionPoolManager.getInstance().getPool(MSSQL_PROFILE.id);

    expect(mssqlPools).toHaveLength(1);
    expect(() => mssqlPools[0].emit('error', fatal())).not.toThrow();
    expect(errorLog.some(m => /Pool error/.test(m) && /57P01/.test(m))).toBe(true);
  });

  it('guards the throwaway SQL Server probe pool', async () => {
    const result = await ConnectionPoolManager.getInstance().testConnection(
      MSSQL_PROFILE,
      'secret'
    );
    expect(result.success).toBe(true);

    expect(mssqlPools).toHaveLength(1);
    expect(() => mssqlPools[0].emit('error', fatal())).not.toThrow();
    expect(errorLog.some(m => /Pool error/.test(m) && /57P01/.test(m))).toBe(true);
  });

  it('names the pool in the log without leaking the password', async () => {
    await ConnectionPoolManager.getInstance().getPgPool(PG_PROFILE.id, 'appdb');
    pgPools[0].emit('error', fatal());

    const line = errorLog.find(m => /Pool error/.test(m));
    expect(line).toBeDefined();
    expect(line).toContain('PG Profile');
    expect(line).not.toContain('secret');
  });
});
