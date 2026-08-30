/**
 * Dialect roundtrip tests.
 *
 * Exercises the SQL strings produced by `getDialect(engine)` against real
 * databases. Catches regressions in identifier quoting, metadata-query
 * shape, and engine-specific syntax differences.
 *
 * Each test creates a fresh database (via `withFreshDatabase`), optionally
 * applies the seed fixture, runs dialect-generated SQL through the engine
 * driver, and asserts on the rows that come back.
 */

import { describe, expect, it } from 'vitest';
import sqlserver from 'mssql';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';

import { getDialect } from '@joinery/main/services/sql/dialect';
import type { ParameterisedQuery } from '@joinery/main/services/sql/dialect';
import type { DatabaseEngine } from '@joinery/shared';

import {
  applyFixture,
  TEST_CONNECTIONS,
  withFreshDatabase,
  type Engine,
} from '../../helpers/db-fixtures.js';

const FIXTURE_TO_DIALECT: Record<Engine, DatabaseEngine> = {
  mssql: 'mssql',
  postgres: 'postgresql',
  mysql: 'mysql',
};

const ENGINES: Engine[] = ['mssql', 'postgres', 'mysql'];
const FIXTURE_TABLES = ['customers', 'order_items', 'orders', 'products'];
const PRODUCT_COLUMNS = ['id', 'sku', 'name', 'price_cents', 'category', 'active', 'created_at'];

describe.each(ENGINES)('dialect roundtrip — %s', engine => {
  const dialect = getDialect(FIXTURE_TO_DIALECT[engine]);

  it('listTablesSQL returns the four fixture tables', async () => {
    await withFreshDatabase(engine, async db => {
      await applyFixture(engine, db.databaseName, 'seed');
      const { database, schema } = dialectArgs(engine, db.databaseName);
      const rows = await runQuery(
        engine,
        db.databaseName,
        dialect.listTablesQuery(database, schema)
      );
      const names = rows.map(r => String(r.name).toLowerCase()).sort();
      expect(names).toEqual(FIXTURE_TABLES);
    });
  });

  it('listColumnsSQL on products returns the expected columns and flags id as PK', async () => {
    await withFreshDatabase(engine, async db => {
      const { database, schema } = dialectArgs(engine, db.databaseName);
      const rows = await runQuery(
        engine,
        db.databaseName,
        dialect.listColumnsQuery(database, schema, 'products')
      );
      const names = rows.map(r => String(r.name).toLowerCase());
      expect(names).toEqual(expect.arrayContaining(PRODUCT_COLUMNS));

      const id = rows.find(r => String(r.name).toLowerCase() === 'id');
      expect(id, 'expected an id column row').toBeDefined();
      expect(asBool(id!.isPrimaryKey)).toBe(true);
    });
  });

  it('listIndexesSQL on products surfaces ix_products_category', async () => {
    await withFreshDatabase(engine, async db => {
      const { database, schema } = dialectArgs(engine, db.databaseName);
      const rows = await runQuery(
        engine,
        db.databaseName,
        dialect.listIndexesQuery(database, schema, 'products')
      );
      const names = rows.map(r => String(r.name).toLowerCase());
      expect(names).toContain('ix_products_category');
    });
  });

  it('listForeignKeysSQL on orders points to customers', async () => {
    await withFreshDatabase(engine, async db => {
      const { database, schema } = dialectArgs(engine, db.databaseName);
      const rows = await runQuery(
        engine,
        db.databaseName,
        dialect.listForeignKeysQuery(database, schema, 'orders')
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const referenced = rows.map(r => String(r.referencedTable ?? '').toLowerCase());
      expect(referenced).toContain('customers');
    });
  });

  it('quoteLiteral keeps a backslash-led injection payload as data (J-134)', async () => {
    // The payload the cycle-4 audit demonstrated: the leading backslash escapes the quote the
    // escaper doubles, so on an engine that reads `\` as an escape the NEXT quote closes the
    // literal and `DROP TABLE` runs as a second statement. `runMysql` opens its connection with
    // `multipleStatements: true`, exactly as Joinery's own MySQL pools do, so this test can fail
    // the way production would.
    const payload = String.raw`\'; DROP TABLE probe_victim; -- `;

    await withFreshDatabase(engine, async db => {
      await createProbeVictim(engine, db.databaseName);
      await insertProbeLabel(engine, db.databaseName, payload);

      const predicate = `${dialect.quoteIdentifier('label')} = ${dialect.quoteLiteral(payload)}`;
      const matched = await runQuery(
        engine,
        db.databaseName,
        `SELECT COUNT(*) AS n FROM ${dialect.quoteIdentifier('probe_victim')} WHERE ${predicate}`
      );
      // 1 means the literal reached the server as the exact bytes the driver bound on insert.
      expect(Number(matched[0].n)).toBe(1);

      // And the table is still there: nothing after the payload's `;` was executed. This query
      // throws if it was dropped.
      const survived = await runQuery(
        engine,
        db.databaseName,
        `SELECT COUNT(*) AS n FROM ${dialect.quoteIdentifier('probe_victim')}`
      );
      expect(Number(survived[0].n)).toBe(1);
    });
  });

  it('listColumnsSQL finds a table whose name contains a backslash (J-134)', async () => {
    // Not a security case — a correctness one. With quote-doubling alone, MySQL read the `\t` in
    // this name as a TAB and the metadata query silently returned no columns.
    const table = String.raw`probe\table`;

    await withFreshDatabase(engine, async db => {
      const { database, schema } = dialectArgs(engine, db.databaseName);
      await runQuery(
        engine,
        db.databaseName,
        `CREATE TABLE ${dialect.quoteIdentifier(table)} (${dialect.quoteIdentifier('id')} INT)`
      );

      const rows = await runQuery(
        engine,
        db.databaseName,
        dialect.listColumnsQuery(database, schema, table)
      );
      expect(rows.map(r => String(r.name).toLowerCase())).toEqual(['id']);
    });
  });

  it('quoteIdentifier roundtrips through a SELECT', async () => {
    await withFreshDatabase(engine, async db => {
      await applyFixture(engine, db.databaseName, 'seed');
      const quoted = dialect.quoteIdentifier('products');
      const rows = await runQuery(engine, db.databaseName, `SELECT COUNT(*) AS n FROM ${quoted}`);
      expect(Number(rows[0].n)).toBe(10);
    });
  });
});

// ---- helpers ----

function dialectArgs(engine: Engine, dbName: string): { database: string; schema: string } {
  switch (engine) {
    case 'mssql':
      return { database: dbName, schema: 'dbo' };
    case 'postgres':
      return { database: '', schema: 'public' };
    // MySQL conflates schema and database: pass dbName as both.
    case 'mysql':
      return { database: dbName, schema: dbName };
  }
}

function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't';
}

async function runQuery(
  engine: Engine,
  dbName: string,
  query: string | ParameterisedQuery
): Promise<Record<string, unknown>[]> {
  // Since J-135 the metadata builders return `{ sql, params }`; the ad-hoc probe SQL in this file
  // is still a bare string, so both are accepted and the values (if any) are bound by the driver.
  const { sql, params } = typeof query === 'string' ? { sql: query, params: [] } : query;

  switch (engine) {
    case 'mssql':
      return runMssql(dbName, sql, params);
    case 'postgres':
      return runPostgres(dbName, sql, params);
    case 'mysql':
      return runMysql(dbName, sql, params);
  }
}

async function runMssql(
  dbName: string,
  sql: string,
  params: readonly string[]
): Promise<Record<string, unknown>[]> {
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
    // batch() handles `USE [db];` prefixes that the MSSQL dialect emits. The MSSQL builders bind
    // nothing (TsqlBuilder writes its own literals), so this branch never has params.
    if (params.length > 0) throw new Error('runMssql: the MSSQL dialect should bind no values');
    const result = await pool.request().batch(sql);
    const recordsets = (result.recordsets ?? []) as unknown as Record<string, unknown>[][];
    return recordsets[recordsets.length - 1] ?? [];
  } finally {
    await pool.close();
  }
}

async function runPostgres(
  dbName: string,
  sql: string,
  params: readonly string[]
): Promise<Record<string, unknown>[]> {
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
    // With values node-pg uses the extended query protocol, exactly as `MetadataService` does.
    const result = params.length ? await client.query(sql, [...params]) : await client.query(sql);
    const results = Array.isArray(result) ? result : [result];
    return results[results.length - 1].rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

async function runMysql(
  dbName: string,
  sql: string,
  params: readonly string[]
): Promise<Record<string, unknown>[]> {
  const c = TEST_CONNECTIONS.mysql;
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dbName,
    multipleStatements: true,
  });
  try {
    // `execute` = server-side prepared statement, exactly as `MetadataService` does.
    const [rows] = params.length ? await conn.execute(sql, [...params]) : await conn.query(sql);
    if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
      const arr = rows as unknown[][];
      return arr[arr.length - 1] as Record<string, unknown>[];
    }
    return rows as Record<string, unknown>[];
  } finally {
    await conn.end();
  }
}

/** A one-column table the injection payload names as its DROP target. */
async function createProbeVictim(engine: Engine, dbName: string): Promise<void> {
  await runQuery(engine, dbName, 'CREATE TABLE probe_victim (label VARCHAR(200) NULL)');
}

/**
 * Insert `value` through the driver's own parameter binding.
 *
 * Bound, not interpolated, on purpose: the row this test matches against must be written by
 * something other than the code under test, or the test would only prove the escaper agrees
 * with itself.
 */
async function insertProbeLabel(engine: Engine, dbName: string, value: string): Promise<void> {
  if (engine === 'mssql') {
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
      await pool
        .request()
        .input('label', sqlserver.NVarChar(200), value)
        .query('INSERT INTO probe_victim (label) VALUES (@label)');
    } finally {
      await pool.close();
    }
    return;
  }

  if (engine === 'postgres') {
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
      await client.query('INSERT INTO probe_victim (label) VALUES ($1)', [value]);
    } finally {
      await client.end();
    }
    return;
  }

  const c = TEST_CONNECTIONS.mysql;
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dbName,
  });
  try {
    await conn.execute('INSERT INTO probe_victim (label) VALUES (?)', [value]);
  } finally {
    await conn.end();
  }
}

/**
 * The `describe.each` injection test above cannot fail for PostgreSQL.
 *
 * Its payload is neutralised by quote-doubling alone whenever `standard_conforming_strings` is on,
 * and on is the default — so that arm stays green even with `PgDialect.quoteLiteral`'s `E'…'` and
 * backslash doubling reverted (verified by mutation during the J-134 review). The whole reason
 * J-52 chose `E'…'` is that the setting is not Joinery's to assume: it is settable per database and
 * per role, and `MetadataService.queryAny` sends PostgreSQL SQL through the simple query protocol,
 * which runs a second statement happily.
 *
 * So this block pins the case the default configuration hides.
 */
describe('dialect roundtrip — postgres with standard_conforming_strings off (J-134)', () => {
  const dialect = getDialect('postgresql');
  const payload = String.raw`\'; DROP TABLE probe_victim; -- `;

  it('quoteLiteral keeps the payload as data when the server reads backslashes as escapes', async () => {
    await withFreshDatabase('postgres', async db => {
      const c = TEST_CONNECTIONS.postgres;
      const client = new PgClient({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: db.databaseName,
      });
      await client.connect();
      try {
        await client.query('SET standard_conforming_strings = off');
        const scs = await client.query('SHOW standard_conforming_strings');
        expect(scs.rows[0].standard_conforming_strings).toBe('off');

        await client.query('CREATE TABLE probe_victim (label VARCHAR(200) NULL)');
        // Bound, not interpolated: the row must be written by something other than the code
        // under test, or the test would only prove the escaper agrees with itself.
        await client.query('INSERT INTO probe_victim (label) VALUES ($1)', [payload]);

        const predicate = `label = ${dialect.quoteLiteral(payload)}`;
        const matched = await client.query(
          `SELECT COUNT(*) AS n FROM probe_victim WHERE ${predicate}`
        );
        expect(Number(matched.rows[0].n)).toBe(1);

        // Throws if the payload's DROP ran as a second statement.
        const survived = await client.query('SELECT COUNT(*) AS n FROM probe_victim');
        expect(Number(survived.rows[0].n)).toBe(1);
      } finally {
        await client.end();
      }
    });
  });
});
