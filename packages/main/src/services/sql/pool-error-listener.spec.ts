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
 * mysql2 *pools* are still absent, and deliberately so. `PromisePool` inherits only
 * `acquire | connection | enqueue | release` from the core pool
 * (mysql2 3.23.3 `lib/promise/pool.js:18`) and neither pool class ever emits `'error'`, so a
 * listener on a mysql2 pool would be unreachable code. What J-184 adds is one level down: its
 * `PoolConnection` registers `once('error', () => this._removeFromPool())`
 * (`lib/pool_connection.js:14-16`), so a FATAL on a pooled MySQL connection evicts it *silently* —
 * no crash, but nothing in the output panel either, unlike pg and mssql after J-175. The gap is
 * observability, not safety: `_notifyError` early-returns on `_fatalError`
 * (`lib/base/connection.js:264`) and `protocolError` on `_closing` (`:452`), so a second error on
 * the same dead connection does not reach an unlistened `emit` either.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import mssql from 'mssql';
import mysql from 'mysql2/promise';
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

/**
 * A mysql2 `PoolConnection`, in the shape the pool hands one out (J-184).
 *
 * The `once('error')` eviction listener is the real one, copied from
 * `mysql2/lib/pool_connection.js:14-16` — it is what makes the gap under test a *silent* eviction
 * rather than a throw, so the double must have it or the test would be proving a different bug
 * from the one the ticket describes.
 */
class FakeMySQLPoolConnection extends EventEmitter {
  evicted = 0;

  constructor() {
    super();
    this.once('error', () => {
      this.evicted += 1;
    });
  }

  released = 0;

  release(): void {
    this.released += 1;
  }
}

/**
 * A mysql2 promise `Pool`, in the shape `connection-pool.ts` uses it. A real EventEmitter,
 * deliberately, and it emits `'connection'` where the real pool does: after a *new* physical
 * connection finishes connecting (`mysql2/lib/base/pool.js:92-104`), including the implicit
 * acquire inside `pool.query()` (`:240-250`). `PromisePool` forwards that event through
 * `inheritEvents` (`lib/promise/pool.js:18`, `lib/promise/inherit_events.js`), which re-emits the
 * original arguments — so a listener on the promise pool receives the *core* `PoolConnection`, and
 * `pool.getConnection()` resolving a `PromisePoolConnection` wrapper instead is beside the point
 * here: `connection-pool.ts` only calls `release()` on what it gets back.
 */
class FakeMySQLPool extends EventEmitter {
  readonly connections: FakeMySQLPoolConnection[] = [];

  getConnection(): Promise<FakeMySQLPoolConnection> {
    const conn = new FakeMySQLPoolConnection();
    this.connections.push(conn);
    this.emit('connection', conn);
    return Promise.resolve(conn);
  }

  async query(): Promise<[Record<string, string>[], []]> {
    await this.getConnection();
    return [[{ version: '8.4.0', name: 'appdb' }], []];
  }

  end(): Promise<void> {
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

const MYSQL_PROFILE: ConnectionProfile = {
  ...PG_PROFILE,
  id: 'mysql-profile',
  name: 'MySQL Profile',
  engine: 'mysql',
  port: 3306,
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
let mysqlPools: FakeMySQLPool[] = [];
let errorLog: string[] = [];
let stopLogging: () => void;

beforeEach(() => {
  pgPools = [];
  mssqlPools = [];
  mysqlPools = [];
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

  vi.spyOn(mysql, 'createPool').mockImplementation(function (): FakeMySQLPool {
    const pool = new FakeMySQLPool();
    mysqlPools.push(pool);
    return pool;
  } as unknown as typeof mysql.createPool);

  const store = ConnectionProfilesStore.getInstance();
  const profiles = [PG_PROFILE, MSSQL_PROFILE, MYSQL_PROFILE];
  vi.spyOn(store, 'getById').mockImplementation(id => profiles.find(p => p.id === id));
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

  // J-184. mysql2's own `once('error', … _removeFromPool())` means the pool survives a FATAL on a
  // pooled connection and quietly drops it — so nothing crashes, and nothing is said. These pin the
  // missing line, not a crash: see the note at the top of this file on why the residual risk here
  // is observability only.
  it('logs a pooled MySQL connection dying under the pool (J-184)', async () => {
    await ConnectionPoolManager.getInstance().getMySQLPool(MYSQL_PROFILE.id, 'appdb');

    expect(mysqlPools).toHaveLength(1);
    const [conn] = mysqlPools[0].connections;
    expect(() => conn.emit('error', fatal())).not.toThrow();

    // mysql2's own eviction listener still ran — this adds a log line, it does not replace it.
    expect(conn.evicted).toBe(1);
    const line = errorLog.find(m => /MySQL connection error/.test(m));
    expect(line).toBeDefined();
    expect(line).toContain('57P01');
    expect(line).toContain('MySQL Profile');
    expect(line).not.toContain('secret');
  });

  it('guards connections handed out by the throwaway MySQL probe pool', async () => {
    const result = await ConnectionPoolManager.getInstance().testConnection(
      MYSQL_PROFILE,
      'secret'
    );
    expect(result.success).toBe(true);

    expect(mysqlPools).toHaveLength(1);
    const [conn] = mysqlPools[0].connections;
    expect(() => conn.emit('error', fatal())).not.toThrow();
    expect(errorLog.some(m => /MySQL connection error/.test(m) && /57P01/.test(m))).toBe(true);
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
