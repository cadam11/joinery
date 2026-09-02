/**
 * Database fixture helpers for the regression harness.
 *
 * Provides `withFreshDatabase` — creates a uniquely-named database on a target
 * engine, applies the synthetic schema, hands the connection config to a test
 * callback, and tears the database down on exit (happy path or error).
 *
 * Connection config points at the docker-compose.test.yml services on
 * non-standard host ports. Bring the network up first via:
 *   pnpm run test:harness:up
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sqlserver from 'mssql';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';

export type Engine = 'mssql' | 'postgres' | 'mysql';

export interface TestConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Connection config for the test compose network. Uses the privileged user
 * for each engine — sa on MSSQL, the superuser POSTGRES_USER on Postgres,
 * root on MySQL — because `withFreshDatabase` needs to CREATE/DROP arbitrary
 * databases. The unprivileged MySQL `joinery` user only has rights on
 * `joinery_test`, which is why we use root here.
 *
 * The `database` field on MSSQL/Postgres points at the management DB used
 * to issue CREATE/DROP; MySQL has no separate management DB.
 */
export const TEST_CONNECTIONS: Record<Engine, TestConnection> = {
  mssql: {
    host: '127.0.0.1',
    port: 11433,
    user: 'sa',
    password: 'JoineryTest!Pa55',
    database: 'master',
  },
  postgres: {
    host: '127.0.0.1',
    port: 15432,
    user: 'joinery',
    password: 'joinery',
    database: 'postgres',
  },
  mysql: {
    host: '127.0.0.1',
    port: 13306,
    user: 'root',
    password: 'joinery',
    database: 'joinery_test',
  },
};

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, '..', 'fixtures');

const VALID_DB_NAME = /^[a-z][a-z0-9_]{1,62}$/;

function assertValidDbName(name: string): void {
  if (!VALID_DB_NAME.test(name)) {
    throw new Error(`[db-fixtures] invalid database name: ${name}`);
  }
}

function makeFreshDbName(): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  return `joinery_t_${id}`;
}

export async function loadFixtureSql(engine: Engine, kind: 'schema' | 'seed'): Promise<string> {
  const path = join(FIXTURES_ROOT, engine, `${kind}.sql`);
  return readFile(path, 'utf8');
}

// --- per-engine admin exec (connects to management DB, runs a statement) ---

async function execMssqlAdmin(statement: string): Promise<void> {
  const c = TEST_CONNECTIONS.mssql;
  const pool = new sqlserver.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: 'master',
    options: { trustServerCertificate: true, encrypt: false },
  });
  await pool.connect();
  try {
    await pool.request().batch(statement);
  } finally {
    await pool.close();
  }
}

async function execPostgresAdmin(statement: string): Promise<void> {
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
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function execMysqlAdmin(statement: string): Promise<void> {
  const c = TEST_CONNECTIONS.mysql;
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    multipleStatements: true,
  });
  try {
    await conn.query(statement);
  } finally {
    await conn.end();
  }
}

// --- per-engine in-db exec (connects to a specific DB, runs SQL) ---

async function execMssqlInDb(dbName: string, sql: string): Promise<void> {
  assertValidDbName(dbName);
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
    await pool.request().batch(sql);
  } finally {
    await pool.close();
  }
}

async function execPostgresInDb(dbName: string, sql: string): Promise<void> {
  assertValidDbName(dbName);
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
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function execMysqlInDb(dbName: string, sql: string): Promise<void> {
  assertValidDbName(dbName);
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
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

// --- create / drop / apply ---

async function createDatabase(engine: Engine, dbName: string): Promise<void> {
  assertValidDbName(dbName);
  switch (engine) {
    case 'mssql':
      return execMssqlAdmin(`CREATE DATABASE [${dbName}];`);
    case 'postgres':
      return execPostgresAdmin(`CREATE DATABASE "${dbName}"`);
    case 'mysql':
      return execMysqlAdmin(`CREATE DATABASE \`${dbName}\``);
  }
}

async function dropDatabase(engine: Engine, dbName: string): Promise<void> {
  assertValidDbName(dbName);
  switch (engine) {
    case 'mssql':
      // Kick connections, then drop. SINGLE_USER + ROLLBACK IMMEDIATE is the
      // canonical "evict everyone now" pattern for MSSQL.
      return execMssqlAdmin(
        `ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;` +
          `DROP DATABASE [${dbName}];`
      );
    case 'postgres':
      // FORCE evicts active sessions atomically as part of the drop.
      // Avoids the race where pg_terminate_backend returns before the
      // backend has fully released its lock on the database.
      // Requires Postgres 13+ — our compose pins postgres:16.
      return execPostgresAdmin(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    case 'mysql':
      return execMysqlAdmin(`DROP DATABASE \`${dbName}\``);
  }
}

export async function applyFixture(
  engine: Engine,
  dbName: string,
  kind: 'schema' | 'seed'
): Promise<void> {
  const sql = await loadFixtureSql(engine, kind);
  switch (engine) {
    case 'mssql':
      return execMssqlInDb(dbName, sql);
    case 'postgres':
      return execPostgresInDb(dbName, sql);
    case 'mysql':
      return execMysqlInDb(dbName, sql);
  }
}

/**
 * Run arbitrary SQL inside an existing test database, on a connection of the caller's own.
 *
 * `applyFixture` only knows the two canned fixture files; a test that needs to stand up extra
 * objects (a view, a routine, a trigger) needs this. Statements are separated by `;` on MySQL —
 * the connection is opened with `multipleStatements`, so keep routine bodies single-statement.
 */
export async function execInDatabase(engine: Engine, dbName: string, sql: string): Promise<void> {
  switch (engine) {
    case 'mssql':
      return execMssqlInDb(dbName, sql);
    case 'postgres':
      return execPostgresInDb(dbName, sql);
    case 'mysql':
      return execMysqlInDb(dbName, sql);
  }
}

// --- public API ---

export interface FreshDatabase {
  engine: Engine;
  databaseName: string;
  /** Connection config bound to the freshly-created database. */
  config: TestConnection;
}

/**
 * Create a fresh, schema-loaded database on the target engine, run `fn`,
 * and drop the database when `fn` resolves or rejects.
 *
 * The callback's database is empty of seed data. Call `applyFixture(engine,
 * db.databaseName, 'seed')` from inside the callback if you want the
 * synthetic 10-product / 5-customer / 8-order dataset.
 */
export async function withFreshDatabase<T>(
  engine: Engine,
  fn: (db: FreshDatabase) => Promise<T>
): Promise<T> {
  const databaseName = makeFreshDbName();
  await createDatabase(engine, databaseName);
  try {
    await applyFixture(engine, databaseName, 'schema');
    const config: TestConnection = { ...TEST_CONNECTIONS[engine], database: databaseName };
    return await fn({ engine, databaseName, config });
  } finally {
    try {
      await dropDatabase(engine, databaseName);
    } catch (err) {
      // Cleanup failure shouldn't mask the real test result. Log loudly so
      // orphaned databases get noticed in CI logs / local dev.
      console.error(`[db-fixtures] failed to drop ${engine} database ${databaseName}:`, err);
    }
  }
}

/**
 * Open a connection to the engine's management DB, run `SELECT 1`, close.
 * Useful as a smoke test that the compose network is reachable.
 */
export async function pingEngine(engine: Engine): Promise<void> {
  switch (engine) {
    case 'mssql':
      return execMssqlAdmin('SELECT 1');
    case 'postgres':
      return execPostgresAdmin('SELECT 1');
    case 'mysql':
      return execMysqlAdmin('SELECT 1');
  }
}

/** Returns true if a database with the given name exists on the engine. */
export async function databaseExists(engine: Engine, dbName: string): Promise<boolean> {
  assertValidDbName(dbName);
  switch (engine) {
    case 'mssql':
      return databaseExistsMssql(dbName);
    case 'postgres':
      return databaseExistsPostgres(dbName);
    case 'mysql':
      return databaseExistsMysql(dbName);
  }
}

async function databaseExistsMssql(dbName: string): Promise<boolean> {
  const c = TEST_CONNECTIONS.mssql;
  const pool = new sqlserver.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: 'master',
    options: { trustServerCertificate: true, encrypt: false },
  });
  await pool.connect();
  try {
    const r = await pool
      .request()
      .input('name', sqlserver.NVarChar, dbName)
      .query('SELECT 1 AS hit FROM sys.databases WHERE name = @name');
    return r.recordset.length > 0;
  } finally {
    await pool.close();
  }
}

async function databaseExistsPostgres(dbName: string): Promise<boolean> {
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
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    return r.rowCount === 1;
  } finally {
    await client.end();
  }
}

async function databaseExistsMysql(dbName: string): Promise<boolean> {
  const c = TEST_CONNECTIONS.mysql;
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
  });
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [dbName]
    );
    return rows.length === 1;
  } finally {
    await conn.end();
  }
}
