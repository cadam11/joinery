/**
 * J-136 — the AI `get_table_row_count` tool, proved against real servers.
 *
 * Two layers, because they answer different questions.
 *
 * 1. **Query layer.** `buildRowCountQuery` is the exact SQL the tool sends; it
 *    is executed here through each engine's real driver, bound the way
 *    `ToolRegistry` binds it:
 *      - PostgreSQL: `client.query(sql, values)` — extended query protocol
 *      - MySQL:      `conn.execute(sql, values)` — server-side prepared statement
 *      - SQL Server: `request.input('p0', …).query(sql)` — sp_executesql
 *    This layer can assert the lookup found *exactly one* metadata row, which
 *    is the correctness half of the fix.
 *
 * 2. **Tool layer.** The real `ToolRegistry.executeTool` over the real
 *    `ConnectionPoolManager` (only the profile store is faked, so no Keychain
 *    is touched). This is the only thing that exercises
 *    `ConnectionPoolManager.queryWithParams` — including whether the
 *    `USE [db];` prefix survives being run inside `sp_executesql`.
 *
 * The MySQL connections are opened `multipleStatements: true`, matching
 * Joinery's own pools (`connection-pool.ts`, `provider/mysql-provider.ts`), so
 * a stacked statement that reaches the server really would run. The PostgreSQL
 * arms run with `standard_conforming_strings` off, the per-database setting
 * that makes quote-doubling alone an injection there.
 *
 * Mutation-checked: reverting `buildRowCountQuery` to the pre-J-136
 * interpolated form turns the MySQL and PostgreSQL arms red (MySQL fails with
 * `Table '…probe_victim' doesn't exist` — the DROP really executes). The SQL
 * Server arms cannot go red: T-SQL has no backslash escape, so the old
 * quote-doubling was already sound there. They stand as regression guards.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import sqlserver from 'mssql';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';

import { buildRowCountQuery } from '@joinery/main/services/ai/row-count-query';
import type { DatabaseEngine } from '@joinery/shared';

import { TEST_CONNECTIONS, withFreshDatabase, type Engine } from '../../helpers/db-fixtures.js';

/**
 * The pool manager reads connection details from the profile store, which is
 * backed by the macOS Keychain in production. Same fake as
 * `tests/integration/database-lifecycle/create-drop-database.spec.ts`.
 */
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

const FIXTURE_TO_DIALECT: Record<Engine, DatabaseEngine> = {
  mssql: 'mssql',
  postgres: 'postgresql',
  mysql: 'mysql',
};

const ENGINES: Engine[] = ['mssql', 'postgres', 'mysql'];

/**
 * The cycle-4 audit's payload, trimmed so it is a legal identifier everywhere:
 * MySQL forbids a trailing space in an identifier, so the comment is `-- x`.
 * Read as SQL by an engine that honours `\` as an escape, `\'` is an escaped
 * quote, the next `'` closes the literal, and `DROP TABLE` is a new statement.
 */
const INJECTION_NAME = String.raw`probe\'; DROP TABLE probe_victim; -- x`;

/** No injection here — `\t` is read as a TAB by an escape-honouring engine, so the lookup misses. */
const BACKSLASH_NAME = String.raw`probe\table`;

describe.each(ENGINES)('get_table_row_count against %s', engine => {
  const dialectEngine = FIXTURE_TO_DIALECT[engine];

  it('finds a table whose name contains a backslash', async () => {
    await withFreshDatabase(engine, async db => {
      const { schema } = queryArgs(engine, db.databaseName);
      await withConnection(engine, db.databaseName, async conn => {
        await conn.exec(`CREATE TABLE ${quoteIdent(engine, BACKSLASH_NAME)} (id INT)`);

        const query = buildRowCountQuery(dialectEngine, schema, BACKSLASH_NAME);
        const rows = await conn.run(query.sql, query.params);

        // Exactly one metadata row: the predicate matched this table and no other.
        expect(rows).toHaveLength(1);
      });
    });
  });

  it('treats a stacked-statement payload as data, leaving the victim table intact', async () => {
    await withFreshDatabase(engine, async db => {
      const { schema } = queryArgs(engine, db.databaseName);
      await withConnection(engine, db.databaseName, async conn => {
        await conn.exec('CREATE TABLE probe_victim (label INT)');
        await conn.exec(`CREATE TABLE ${quoteIdent(engine, INJECTION_NAME)} (id INT)`);

        const query = buildRowCountQuery(dialectEngine, schema, INJECTION_NAME);
        const rows = await conn.run(query.sql, query.params);

        // Asserted first, because it is the security claim: if the payload was
        // spliced into the SQL, the DROP ran as a second statement.
        const victims = await conn.run(
          `SELECT COUNT(*) AS n FROM ${quoteIdent(engine, 'probe_victim')}`,
          []
        );
        expect(Number(victims[0].n), 'probe_victim was dropped — the payload executed').toBe(0);

        // And the lookup still found the one table it was asked about.
        expect(rows).toHaveLength(1);
      });
    });
  });
});

// ---- helpers ----

/**
 * `get_table_row_count` resolves the schema the same way per engine:
 * `dbo` on SQL Server, `public` on PostgreSQL, the active database on MySQL.
 */
function queryArgs(engine: Engine, dbName: string): { schema: string } {
  switch (engine) {
    case 'mssql':
      return { schema: 'dbo' };
    case 'postgres':
      return { schema: 'public' };
    case 'mysql':
      return { schema: dbName };
  }
}

function quoteIdent(engine: Engine, name: string): string {
  switch (engine) {
    case 'mssql':
      return `[${name.replace(/]/g, ']]')}]`;
    case 'postgres':
      return `"${name.replace(/"/g, '""')}"`;
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``;
  }
}

/** One connection, two operations: `exec` for setup DDL, `run` for the bound query under test. */
interface EngineConnection {
  exec(sql: string): Promise<void>;
  run(sql: string, params: readonly string[]): Promise<Record<string, unknown>[]>;
}

async function withConnection(
  engine: Engine,
  dbName: string,
  fn: (conn: EngineConnection) => Promise<void>
): Promise<void> {
  switch (engine) {
    case 'mssql':
      return withMssql(dbName, fn);
    case 'postgres':
      return withPostgres(dbName, fn);
    case 'mysql':
      return withMysql(dbName, fn);
  }
}

async function withMssql(
  dbName: string,
  fn: (conn: EngineConnection) => Promise<void>
): Promise<void> {
  const c = TEST_CONNECTIONS.mssql;
  const pool = new sqlserver.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dbName,
    options: { trustServerCertificate: true, encrypt: false },
  });
  await pool.connect();
  try {
    await fn({
      exec: async sql => {
        await pool.request().batch(sql);
      },
      run: async (sql, params) => {
        // Mirrors ConnectionPoolManager.queryWithParams: inputs named p0, p1, …
        const request = pool.request();
        params.forEach((value, i) => request.input(`p${i}`, sqlserver.NVarChar, value));
        const result = await request.query(sql);
        return result.recordset as unknown as Record<string, unknown>[];
      },
    });
  } finally {
    await pool.close();
  }
}

async function withPostgres(
  dbName: string,
  fn: (conn: EngineConnection) => Promise<void>
): Promise<void> {
  const c = TEST_CONNECTIONS.postgres;
  const client = new PgClient({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dbName,
  });
  await client.connect();
  try {
    // The setting the pre-J-136 escape depended on. It is per-database and
    // per-role settable, so a Joinery user can meet a server where it is off —
    // and with it off, quote-doubling alone is an injection. Bound parameters
    // are never lexed as SQL, so the fix is invariant to it.
    await client.query('SET standard_conforming_strings = off');
    const check = await client.query('SHOW standard_conforming_strings');
    expect(check.rows[0].standard_conforming_strings).toBe('off');

    await fn({
      exec: async sql => {
        await client.query(sql);
      },
      run: async (sql, params) => {
        // With values, node-pg uses the extended query protocol, which cannot
        // carry a second statement. Without them it uses the simple protocol,
        // which can — which is the path the pre-J-136 code took, and the
        // branch a mutation check exercises.
        const result = params.length
          ? await client.query(sql, params as string[])
          : await client.query(sql);
        // A simple-protocol call that ran more than one statement answers with
        // an array of results. Take the first so the assertions below report
        // the domain failure rather than a TypeError.
        const first = Array.isArray(result) ? result[0] : result;
        return (first.rows ?? []) as Record<string, unknown>[];
      },
    });
  } finally {
    await client.end();
  }
}

async function withMysql(
  dbName: string,
  fn: (conn: EngineConnection) => Promise<void>
): Promise<void> {
  const c = TEST_CONNECTIONS.mysql;
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dbName,
    // Exactly how Joinery opens its own MySQL pools: a stacked statement runs.
    multipleStatements: true,
  });
  try {
    await fn({
      exec: async sql => {
        await conn.query(sql);
      },
      run: async (sql, params) => {
        // `execute` = server-side prepared statement. Values are bound, never
        // spliced into the SQL text. When the values were spliced instead
        // (pre-J-136), `query` was the call and the DROP ran.
        const [rows] = params.length
          ? await conn.execute(sql, params as string[])
          : await conn.query(sql);
        return rows as Record<string, unknown>[];
      },
    });
  } finally {
    await conn.end();
  }
}

// ---- layer 2: the whole tool path, over the real ConnectionPoolManager ----

const { ConnectionPoolManager } = await import('@joinery/main/services/sql/connection-pool');
const { ToolRegistry } = await import('@joinery/main/services/ai/tool-registry');

interface RowCountResult {
  table: string;
  rowCount: number;
}

describe.each(ENGINES)('ToolRegistry.executeTool(get_table_row_count) on %s', engine => {
  afterEach(() => {
    ToolRegistry.resetInstance();
    fakeProfiles.clear();
    fakePasswords.clear();
  });

  it('runs the injection payload as a bound value and leaves the victim table intact', async () => {
    await withFreshDatabase(engine, async db => {
      const { schema } = queryArgs(engine, db.databaseName);

      await withConnection(engine, db.databaseName, async conn => {
        await conn.exec('CREATE TABLE probe_victim (label INT)');
        await conn.exec(`CREATE TABLE ${quoteIdent(engine, INJECTION_NAME)} (id INT)`);
      });
      if (engine === 'postgres') await disableStandardConformingStrings(db.databaseName);

      const connectionId = registerProfile(engine, db.databaseName);
      try {
        const result = (await ToolRegistry.getInstance().executeTool(
          'get_table_row_count',
          { table: INJECTION_NAME, schema },
          connectionId,
          db.databaseName
        )) as RowCountResult;

        expect(result.table).toBe(`${schema}.${INJECTION_NAME}`);
        // Not a value assertion: every engine's row count here is a statistics
        // estimate (PostgreSQL reports `reltuples = -1` until the table is
        // analysed). That the tool answered at all is the signal.
        expect(Number.isFinite(Number(result.rowCount))).toBe(true);
      } finally {
        // Release Joinery's own pools *inside* the fixture, before it drops the
        // database out from under them — PostgreSQL's `DROP DATABASE … (FORCE)`
        // otherwise kills a live backend and node-pg raises an unhandled 57P01.
        await ConnectionPoolManager.getInstance().closeAll();
        ConnectionPoolManager.resetInstance();
      }

      // Throws if the DROP ran as a second statement.
      await withConnection(engine, db.databaseName, async conn => {
        const victims = await conn.run(
          `SELECT COUNT(*) AS n FROM ${quoteIdent(engine, 'probe_victim')}`,
          []
        );
        expect(Number(victims[0].n), 'probe_victim was dropped — the payload executed').toBe(0);
      });
    });
  });
});

/**
 * Register a connection profile pointing at `dbName`, and return its id.
 * Field names copied from the real `ConnectionProfile` usage in
 * `create-drop-database.spec.ts`.
 */
function registerProfile(engine: Engine, dbName: string): string {
  const connectionId = randomUUID();
  const c = TEST_CONNECTIONS[engine];
  const base = {
    id: connectionId,
    name: `${engine}-j136`,
    server: c.host,
    port: c.port,
    username: c.user,
    database: dbName,
  };

  if (engine === 'mssql') {
    fakeProfiles.set(connectionId, {
      ...base,
      engine: 'mssql',
      encrypt: false,
      trustServerCertificate: true,
      connectionTimeout: 30,
    });
  } else {
    fakeProfiles.set(connectionId, {
      ...base,
      engine: engine === 'postgres' ? 'postgresql' : 'mysql',
    });
  }

  fakePasswords.set(connectionId, c.password);
  return connectionId;
}

/**
 * Turn `standard_conforming_strings` off for the whole database, which is how
 * a Joinery user would actually meet it — it is settable per database and per
 * role. With it off, doubling quotes alone stops being an escape.
 */
async function disableStandardConformingStrings(dbName: string): Promise<void> {
  const c = TEST_CONNECTIONS.postgres;
  const client = new PgClient({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    await client.query(`ALTER DATABASE "${dbName}" SET standard_conforming_strings = off`);
  } finally {
    await client.end();
  }
}
