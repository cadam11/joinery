/**
 * J-135 — the metadata surface's schema/table names, proved bound against real servers.
 *
 * Two layers, answering different questions.
 *
 * 1. **Query layer, MySQL under `NO_BACKSLASH_ESCAPES`.** This is the one arm that can tell the
 *    fix apart from the escape it replaces. J-134's MySQL escape doubles backslashes as well as
 *    quotes, which is safe in *both* `sql_mode`s but LOSSY in this one: `\\` is two literal
 *    backslashes when `NO_BACKSLASH_ESCAPES` is set, so a table whose name contains a backslash
 *    stops being findable. J-134's own report named that as the open question only binding could
 *    close. The session sets `sql_mode` on its own connection, so nothing else on the shared
 *    harness sees it.
 *
 * 2. **Service layer, all three engines.** The real `MetadataService` over the real
 *    `ConnectionPoolManager` (only the profile store is faked, so no Keychain is touched). This is
 *    the only thing that exercises the routing added by this ticket — node-pg's extended protocol,
 *    mysql2's `execute`, and the SQL Server arm staying on `query`/`batch` — and the only thing
 *    that would catch mysql2's binary protocol handing back a different row shape than the text
 *    protocol did.
 *
 * Honest about what goes red: reverting the dialects to interpolation turns the MySQL arm of
 * layer 1 red. It does NOT turn PostgreSQL or SQL Server red, and it is worth saying why rather
 * than shipping a decorative arm (the J-134 review's finding): T-SQL has no backslash escape in
 * any configuration, and PostgreSQL's `E'…'` is invariant under `standard_conforming_strings`, so
 * on those two engines J-134 had already made the escaping sound. Their arms here are regression
 * guards for the new routing, and the security delta on them is structural — asserted in
 * `packages/main/src/services/sql/metadata-binding.spec.ts` and `dialect/dialect.spec.ts`, where
 * the name's absence from the SQL text is the property.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';

import { getDialect } from '@joinery/main/services/sql/dialect';
import type { DatabaseEngine } from '@joinery/shared';

import {
  applyFixture,
  TEST_CONNECTIONS,
  withFreshDatabase,
  type Engine,
} from '../../helpers/db-fixtures.js';

/**
 * The pool manager reads connection details from the profile store, which is backed by the macOS
 * Keychain in production. Same fake as `tests/integration/ai/row-count-injection.spec.ts`.
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
const FIXTURE_TABLES = ['customers', 'order_items', 'orders', 'products'];

/** No injection here — `\t` reads as a TAB to an escape-honouring lexer, so the lookup misses. */
const BACKSLASH_TABLE = String.raw`probe\table`;

/**
 * The cycle-4 audit's payload, trimmed so it is a legal identifier on every engine: MySQL forbids
 * a trailing space in an identifier, hence `-- x`.
 */
const INJECTION_TABLE = String.raw`probe\'; DROP TABLE probe_victim; -- x`;

// ---- layer 1: MySQL with NO_BACKSLASH_ESCAPES, the mode only binding survives ----

describe('MySQL metadata queries under NO_BACKSLASH_ESCAPES (J-135)', () => {
  it('finds a table whose name contains a backslash', async () => {
    const dialect = getDialect('mysql');

    await withFreshDatabase('mysql', async db => {
      const c = TEST_CONNECTIONS.mysql;
      const conn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: db.databaseName,
        // Exactly how Joinery's editor pool is opened, so a stacked statement really would run.
        multipleStatements: true,
      });
      try {
        // Session-scoped, so the shared harness is untouched for everyone else.
        await conn.query("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'");
        const [modeRows] = await conn.query('SELECT @@SESSION.sql_mode AS mode');
        expect((modeRows as { mode: string }[])[0].mode).toContain('NO_BACKSLASH_ESCAPES');

        await conn.query(
          `CREATE TABLE ${dialect.quoteIdentifier(BACKSLASH_TABLE)} (${dialect.quoteIdentifier('id')} INT)`
        );

        const query = dialect.listColumnsQuery(db.databaseName, db.databaseName, BACKSLASH_TABLE);
        const [rows] = await conn.execute(query.sql, [...query.params]);

        // With the name escaped into the SQL instead, `\\` is two literal backslashes in this
        // mode, the predicate matches nothing, and this is zero.
        expect(rows as unknown[]).toHaveLength(1);
        expect((rows as { name: string }[])[0].name).toBe('id');
      } finally {
        await conn.end();
      }
    });
  });

  it('keeps a stacked-statement payload in a table name as data', async () => {
    const dialect = getDialect('mysql');

    await withFreshDatabase('mysql', async db => {
      const c = TEST_CONNECTIONS.mysql;
      const conn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: db.databaseName,
        multipleStatements: true,
      });
      try {
        await conn.query("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'");
        await conn.query('CREATE TABLE probe_victim (label INT)');
        await conn.query(
          `CREATE TABLE ${dialect.quoteIdentifier(INJECTION_TABLE)} (${dialect.quoteIdentifier('id')} INT)`
        );

        const query = dialect.listColumnsQuery(db.databaseName, db.databaseName, INJECTION_TABLE);
        const [rows] = await conn.execute(query.sql, [...query.params]);

        // Asserted first, because it is the security claim.
        const [victims] = await conn.query('SELECT COUNT(*) AS n FROM probe_victim');
        expect(
          Number((victims as { n: number }[])[0].n),
          'probe_victim was dropped — the payload executed'
        ).toBe(0);
        expect(rows as unknown[]).toHaveLength(1);
      } finally {
        await conn.end();
      }
    });
  });
});

// ---- layer 2: the whole metadata service, over the real ConnectionPoolManager ----

const { ConnectionPoolManager } = await import('@joinery/main/services/sql/connection-pool');
const { MetadataService } = await import('@joinery/main/services/sql/metadata');

describe.each(ENGINES)('MetadataService on %s (J-135)', engine => {
  afterEach(() => {
    MetadataService.resetInstance();
    fakeProfiles.clear();
    fakePasswords.clear();
  });

  it('reads the fixture schema back through the bound queries', async () => {
    await withFreshDatabase(engine, async db => {
      await applyFixture(engine, db.databaseName, 'seed');
      if (engine === 'postgres') await disableStandardConformingStrings(db.databaseName);

      const { database, schema } = metadataArgs(engine, db.databaseName);
      const connectionId = registerProfile(engine, db.databaseName);
      const metadata = MetadataService.getInstance();

      try {
        const tables = await metadata.listTables(connectionId, database, true);
        expect(tables.map(t => t.name.toLowerCase()).sort()).toEqual(FIXTURE_TABLES);

        // mysql2's `execute` reads rows back over the BINARY protocol, where `query` used the
        // text one. If that changed a column's JavaScript type, it shows up here first.
        const columns = await metadata.listColumns(connectionId, database, schema, 'products');
        const id = columns.find(col => col.name.toLowerCase() === 'id');
        expect(id, 'expected an id column').toBeDefined();
        expect(id!.isPrimaryKey).toBe(true);
        expect(typeof id!.dataType).toBe('string');

        const indexes = await metadata.listIndexes(connectionId, database, schema, 'products');
        expect(indexes.map(i => i.name.toLowerCase())).toContain('ix_products_category');

        const foreignKeys = await metadata.listForeignKeys(
          connectionId,
          database,
          schema,
          'orders'
        );
        expect(foreignKeys.map(fk => fk.referencedTable.toLowerCase())).toContain('customers');

        const properties = await metadata.getTableProperties(
          connectionId,
          database,
          schema,
          'products'
        );
        expect(properties.name.toLowerCase()).toBe('products');
        expect(properties.columns.length).toBeGreaterThan(0);
      } finally {
        await closeJoineryPools();
      }
    });
  });

  it('finds a table whose name carries a quote, a semicolon and a backslash', async () => {
    await withFreshDatabase(engine, async db => {
      await createProbeTables(engine, db.databaseName);
      if (engine === 'postgres') await disableStandardConformingStrings(db.databaseName);

      const { database, schema } = metadataArgs(engine, db.databaseName);
      const connectionId = registerProfile(engine, db.databaseName);
      const metadata = MetadataService.getInstance();

      try {
        const columns = await metadata.listColumns(connectionId, database, schema, INJECTION_TABLE);
        expect(columns.map(col => col.name.toLowerCase())).toEqual(['id']);
      } finally {
        await closeJoineryPools();
      }

      // Throws if the payload ran as a second statement.
      const survivors = await countProbeVictims(engine, db.databaseName);
      expect(survivors, 'probe_victim was dropped — the payload executed').toBe(0);
    });
  });
});

// ---- helpers ----

/**
 * The `(database, schema)` pair `MetadataService` is called with per engine: `dbo` on SQL Server,
 * `public` on PostgreSQL, and the database itself on MySQL, which conflates the two.
 */
function metadataArgs(engine: Engine, dbName: string): { database: string; schema: string } {
  switch (engine) {
    case 'mssql':
      return { database: dbName, schema: 'dbo' };
    case 'postgres':
      return { database: dbName, schema: 'public' };
    case 'mysql':
      return { database: dbName, schema: dbName };
  }
}

/**
 * Release Joinery's own pools before the fixture drops the database out from under them —
 * PostgreSQL's `DROP DATABASE … (FORCE)` otherwise kills a live backend and node-pg raises an
 * unhandled 57P01.
 */
async function closeJoineryPools(): Promise<void> {
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.resetInstance();
}

function quoteIdent(engine: Engine, name: string): string {
  return getDialect(FIXTURE_TO_DIALECT[engine]).quoteIdentifier(name);
}

/** The victim table the payload names, plus a table actually called the payload. */
async function createProbeTables(engine: Engine, dbName: string): Promise<void> {
  const statements = [
    'CREATE TABLE probe_victim (label INT)',
    `CREATE TABLE ${quoteIdent(engine, INJECTION_TABLE)} (${quoteIdent(engine, 'id')} INT)`,
  ];
  for (const sql of statements) await runDirect(engine, dbName, sql);
}

async function countProbeVictims(engine: Engine, dbName: string): Promise<number> {
  const rows = await runDirect(engine, dbName, 'SELECT COUNT(*) AS n FROM probe_victim');
  return Number((rows[0] as { n: number }).n);
}

/** A connection of the test's own, so the assertions do not depend on the code under test. */
async function runDirect(
  engine: Engine,
  dbName: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  const c = TEST_CONNECTIONS[engine];

  if (engine === 'postgres') {
    const client = new PgClient({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: dbName,
    });
    await client.connect();
    try {
      const result = await client.query(sql);
      return (result.rows ?? []) as Record<string, unknown>[];
    } finally {
      await client.end();
    }
  }

  if (engine === 'mysql') {
    const conn = await mysql.createConnection({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: dbName,
    });
    try {
      const [rows] = await conn.query(sql);
      return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
    } finally {
      await conn.end();
    }
  }

  const sqlserver = (await import('mssql')).default;
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
    const result = await pool.request().batch(sql);
    return (result.recordset ?? []) as unknown as Record<string, unknown>[];
  } finally {
    await pool.close();
  }
}

/** Register a connection profile pointing at `dbName`, and return its id. */
function registerProfile(engine: Engine, dbName: string): string {
  const connectionId = randomUUID();
  const c = TEST_CONNECTIONS[engine];
  const base = {
    id: connectionId,
    name: `${engine}-j135`,
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
 * Turn `standard_conforming_strings` off for the whole database, which is how a Joinery user
 * would actually meet it — it is settable per database and per role.
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
