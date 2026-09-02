/**
 * J-151 — the post-restore existence checks connect the way the profile says.
 *
 * Both CLI restore services finish by asking the server whether the target
 * database is actually there (the CLI can exit 0 / "succeeded with warnings"
 * having applied nothing). Both opened that one-off connection from a
 * hand-rolled literal — `{ host, port, user, password }` — so every other
 * connection setting on the profile was dropped, TLS included:
 *
 *   - `mysql-backup.ts:373` (`mysql.createConnection`, no `ssl`)
 *   - `pg-backup.ts:296` (`new PgClient`, no `ssl`)
 *
 * Against a TLS profile the check ran in plaintext; against a server with
 * `require_secure_transport = ON` (MySQL) or `hostssl`-only `pg_hba` (Postgres)
 * it could not connect at all, and a restore that had in fact succeeded was
 * reported to the user as a failure.
 *
 * ## On the doubles
 *
 * The drivers are not replaced, only their factories are, and only the surface
 * the code under test touches — read off the real call sites and pinned against
 * the real modules:
 *
 *   - mysql2 v3.23.3: `mysql.createConnection(options)` resolves a connection
 *     whose `query<T>(sql, values)` resolves `[rows, fields]` and whose `end()`
 *     resolves (`mysql2/promise.d.ts`).
 *   - pg v8: `new pg.Client(config)`, `connect()`, `query(sql, values)`
 *     resolving `{ rows, rowCount }`, `end()` (`@types/pg`).
 *
 * `vi.mock` cannot be used for either: the node project's setup file imports
 * `connection-pool.ts`, which binds the real `mysql2` and `pg` before any spec
 * runs, so a module mock never reaches the code under test (J-149's worked
 * example, and the warning at the top of `__tests__/setup.ts`). Both factories
 * are property reads at call time, so a `vi.spyOn` of the one property does
 * reach them.
 *
 * The recorders decide nothing: they store the config they were handed and
 * answer with a fixed row, so wrong options cannot look right. Behaviour
 * against a live server is the integration tier's job.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import type { Connection, ConnectionOptions } from 'mysql2/promise';
import pg from 'pg';
import type { ConnectionProfile } from '@joinery/shared';
import { onLogEntry } from '../../utils/logger';
import { mysqlVerifyConnectionOptions } from './mysql-pool-options';
import { mysqlDatabaseExists, pgDatabaseExists } from './restore-verify';

const profile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'profile-1',
  name: 'Profile',
  engine: 'mysql',
  server: 'db.example.com',
  port: 3306,
  username: 'app',
  database: 'appdb',
  authenticationType: 'sql',
  encrypt: true,
  trustServerCertificate: false,
  connectionTimeout: 15,
  ...over,
});

/**
 * A pg `Client`, in the shape `restore-verify.ts` uses it — and a real
 * `EventEmitter`, deliberately (J-183). The failure mode under test is Node's
 * own `emit('error')` rethrow on an emitter with no `'error'` listener, so the
 * double cannot encode it: an unguarded instance throws for exactly the same
 * reason the real client does (`pg/lib/client.js:416-423`, `_handleErrorEvent`
 * → `this.emit('error', err)` once connected).
 */
class FakePgClient extends EventEmitter {
  /** `'error'` listeners present at the moment `connect()` was called. */
  errorListenersAtConnect = -1;

  constructor(private readonly calls: Recorded) {
    super();
  }

  async connect(): Promise<void> {
    this.errorListenersAtConnect = this.listenerCount('error');
  }

  async query(sql: string, values: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.queries.push({ sql, values });
    if (pgRows instanceof Error) throw pgRows;
    return { rows: pgRows, rowCount: pgRows.length };
  }

  async end(): Promise<void> {
    this.calls.ended += 1;
  }
}

/** What a driver was asked for, and what it was asked. */
interface Recorded {
  readonly configs: unknown[];
  readonly queries: { sql: string; values: unknown[] }[];
  ended: number;
}

const recorded = (): Recorded => ({ configs: [], queries: [], ended: 0 });

let mysqlCalls: Recorded;
let pgCalls: Recorded;
/** Rows the next query resolves with; a rejection is expressed as an Error. */
let mysqlRows: unknown[] | Error;
let pgRows: unknown[] | Error;
/** Every client `pgDatabaseExists` built, newest last. */
let pgClients: FakePgClient[];

beforeEach(() => {
  mysqlCalls = recorded();
  pgCalls = recorded();
  mysqlRows = [];
  pgRows = [];
  pgClients = [];

  vi.spyOn(mysql, 'createConnection').mockImplementation(async (options): Promise<Connection> => {
    mysqlCalls.configs.push(options);
    return {
      query: async (sql: string, values: unknown[]) => {
        mysqlCalls.queries.push({ sql, values });
        if (mysqlRows instanceof Error) throw mysqlRows;
        return [mysqlRows, []];
      },
      end: async () => {
        mysqlCalls.ended += 1;
      },
    } as unknown as Connection;
  });

  vi.spyOn(pg, 'Client').mockImplementation(function (this: unknown, config: unknown) {
    pgCalls.configs.push(config);
    const client = new FakePgClient(pgCalls);
    pgClients.push(client);
    return client as unknown as pg.Client;
  } as unknown as typeof pg.Client);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mysqlDatabaseExists', () => {
  it('connects with exactly the shared builder’s options', async () => {
    await mysqlDatabaseExists('restored_db', profile(), 'secret');

    expect(mysqlCalls.configs).toEqual([mysqlVerifyConnectionOptions(profile(), 'secret')]);
  });

  it('connects over TLS when the profile asks for it — the defect this pins', async () => {
    await mysqlDatabaseExists('restored_db', profile({ encrypt: true }), 'secret');

    const [config] = mysqlCalls.configs as ConnectionOptions[];
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('asks information_schema for the target, bound not interpolated', async () => {
    await mysqlDatabaseExists('restored_db', profile(), 'secret');

    expect(mysqlCalls.queries).toEqual([
      {
        sql: 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        values: ['restored_db'],
      },
    ]);
  });

  it('answers true for one row and false for none', async () => {
    mysqlRows = [{ SCHEMA_NAME: 'restored_db' }];
    await expect(mysqlDatabaseExists('restored_db', profile(), 'secret')).resolves.toBe(true);

    mysqlRows = [];
    await expect(mysqlDatabaseExists('restored_db', profile(), 'secret')).resolves.toBe(false);
  });

  it('closes the connection on the happy path and on a failed query', async () => {
    await mysqlDatabaseExists('restored_db', profile(), 'secret');
    expect(mysqlCalls.ended).toBe(1);

    mysqlRows = new Error('server went away');
    await expect(mysqlDatabaseExists('restored_db', profile(), 'secret')).rejects.toThrow(
      'server went away'
    );
    expect(mysqlCalls.ended).toBe(2);
  });

  it('sends no password when the profile has none stored', async () => {
    await mysqlDatabaseExists('restored_db', profile(), undefined);

    const [config] = mysqlCalls.configs as ConnectionOptions[];
    // mysql2 normalises a falsy password to `undefined` anyway
    // (`lib/connection_config.js:110`), so '' and absent are the same wire
    // behaviour — but nothing here may invent a password.
    expect(config.password || undefined).toBeUndefined();
  });
});

describe('pgDatabaseExists', () => {
  it('connects over TLS when the profile asks for it — the defect this pins', async () => {
    await pgDatabaseExists('restored_db', profile({ engine: 'postgresql', encrypt: true }), 'pw');

    const [config] = pgCalls.configs as pg.ClientConfig[];
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('honours trustServerCertificate, and stays off when encrypt is off', async () => {
    await pgDatabaseExists(
      'restored_db',
      profile({ engine: 'postgresql', encrypt: true, trustServerCertificate: true }),
      'pw'
    );
    await pgDatabaseExists('restored_db', profile({ engine: 'postgresql', encrypt: false }), 'pw');

    const [trusting, plain] = pgCalls.configs as pg.ClientConfig[];
    expect(trusting.ssl).toEqual({ rejectUnauthorized: false });
    // `false`, not absent: this is what every other PG connection in the app
    // passes (`connection-pool.ts:558, 648`) and pg treats a missing `ssl` and
    // `ssl: false` identically.
    expect(plain.ssl).toBe(false);
  });

  it('carries the rest of the profile through, and checks from the management db', async () => {
    await pgDatabaseExists(
      'restored_db',
      profile({ engine: 'postgresql', server: '127.0.0.1', port: 15432, database: 'appdb' }),
      'pw'
    );

    const [config] = pgCalls.configs as pg.ClientConfig[];
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(15432);
    expect(config.user).toBe('app');
    expect(config.password).toBe('pw');
    // Never the restore target: on the run this check exists for, the target
    // does not exist and connecting to it would throw instead of answering.
    expect(config.database).toBe('postgres');
    expect(config.connectionTimeoutMillis).toBe(15000);
  });

  it('keeps the `postgres` user fallback the restore CLI already uses', async () => {
    await pgDatabaseExists(
      'restored_db',
      profile({ engine: 'postgresql', username: undefined }),
      'pw'
    );

    const [config] = pgCalls.configs as pg.ClientConfig[];
    expect(config.user).toBe('postgres');
  });

  it('asks pg_database for the target, bound not interpolated', async () => {
    await pgDatabaseExists('restored_db', profile({ engine: 'postgresql' }), 'pw');

    expect(pgCalls.queries).toEqual([
      { sql: 'SELECT 1 FROM pg_database WHERE datname = $1', values: ['restored_db'] },
    ]);
  });

  it('answers true for one row and false for none', async () => {
    pgRows = [{ '?column?': 1 }];
    await expect(pgDatabaseExists('restored_db', profile(), 'pw')).resolves.toBe(true);

    pgRows = [];
    await expect(pgDatabaseExists('restored_db', profile(), 'pw')).resolves.toBe(false);
  });

  it('closes the client on the happy path and on a failed query', async () => {
    await pgDatabaseExists('restored_db', profile(), 'pw');
    expect(pgCalls.ended).toBe(1);

    pgRows = new Error('terminating connection');
    await expect(pgDatabaseExists('restored_db', profile(), 'pw')).rejects.toThrow(
      'terminating connection'
    );
    expect(pgCalls.ended).toBe(2);
  });

  // J-183. A pg `Client` is an `EventEmitter`, and an `EventEmitter` with no
  // `'error'` listener *rethrows* from inside `emit()`. Once connected,
  // `_handleErrorEvent` emits unconditionally (`pg/lib/client.js:416-423`), and
  // a backend error arriving with no query in flight routes there too
  // (`_handleErrorMessage`, `:425-434`). That emit is on a socket callback, not
  // on the awaited promise, so with no listener it lands in the event loop as
  // an uncaught exception — in the main process, a crash of the whole app.
  it('carries a logging error listener from before it connects (J-183)', async () => {
    await pgDatabaseExists('restored_db', profile({ engine: 'postgresql' }), 'pw');

    const [client] = pgClients;
    expect(client.errorListenersAtConnect).toBe(1);

    const logged: string[] = [];
    const stopLogging = onLogEntry(entry => {
      if (entry.level === 'error') logged.push(entry.message);
    });
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    try {
      expect(() => client.emit('error', fatal)).not.toThrow();
    } finally {
      stopLogging();
    }

    expect(logged).toEqual([
      expect.stringContaining('terminating connection due to administrator command'),
    ]);
    expect(logged[0]).toContain('57P01');
  });
});
