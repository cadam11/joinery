/**
 * J-137 — the MySQL trust split, proved against the live MySQL container.
 *
 * The cycle-4 escapeString audit's S1 was a stacked-statement injection, and
 * every part of it except one has now been fixed by escaping (J-134) or by
 * binding (J-136). The part left over is the *capability*: Joinery opened
 * every MySQL connection with `multipleStatements: true`, so a second
 * statement that reached the server ran. This ticket takes that capability
 * away from every caller that never needed it.
 *
 * `multipleStatements` is a handshake flag, so the property under test is
 * enforced by the MySQL server, not by Joinery — `mysql2` pushes
 * `CLIENT_MULTI_STATEMENTS` onto the client flags only when the option is set
 * (`lib/connection_config.js:247-249`, `lib/constants/client.js:26`). Nothing
 * here is simulated: the pools, the pool manager, the tool registry, the
 * metadata service and the query executor are all the real ones, and only the
 * profile store is faked so no Keychain is touched.
 *
 * Mutation check: put `multipleStatements: true` back on the restricted pool
 * and the three "refuses a second statement" tests go red — `probe_victim` is
 * genuinely dropped. Flip the editor to the restricted pool and the
 * "editor still runs a multi-statement script" test goes red instead, which is
 * the other half of the ticket: `multipleStatements` is load-bearing there.
 *
 * J-145 added the FK-preview case at the end. Until that ticket the row inspector's preview was
 * NOT on this handler at all — the renderer built its own SQL and sent it down the editor channel,
 * i.e. onto the script pool — so the app's most data-driven lookup was the one exception to
 * everything above. It now binds its value and runs here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

import { TEST_CONNECTIONS, withFreshDatabase } from '../../helpers/db-fixtures.js';

/** Same fake as tests/integration/ai/row-count-injection.spec.ts — no Keychain. */
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
const { ToolRegistry } = await import('@joinery/main/services/ai/tool-registry');
const { fetchFkRecord } = await import('@joinery/main/services/sql/fk-record');

/** Two statements, the second destructive. Runs in full iff the connection carries the flag. */
const STACKED = 'SELECT 1 AS one; DROP TABLE probe_victim';

/**
 * The same shape as a cell value: a leading backslash to escape the quote an escaper doubles, then
 * a `;` and a destructive statement. Short enough to be a `VARCHAR(64)` primary key.
 */
const FK_CELL_PAYLOAD = String.raw`\'; DROP TABLE probe_victim; --`;

afterEach(async () => {
  // Release Joinery's own pools before the fixture drops the database.
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.getInstance().stopCleanupTimer();
  ConnectionPoolManager.resetInstance();
  MetadataService.resetInstance();
  QueryExecutor.resetInstance();
  ToolRegistry.resetInstance();
  fakeProfiles.clear();
  fakePasswords.clear();
});

describe('MySQL pool trust levels', () => {
  it('refuses a second statement on the restricted pool', async () => {
    await withFreshDatabase('mysql', async db => {
      await createVictim(db.databaseName);
      const connectionId = registerProfile(db.databaseName);

      const pool = await ConnectionPoolManager.getInstance().getMySQLPool(
        connectionId,
        db.databaseName
      );

      const outcome = await pool.query(STACKED).then(
        () => 'ran',
        (err: Error) => `refused: ${err.message}`
      );

      // Asserted first, because it is the security claim: if the connection
      // carried the second statement, the DROP has already happened.
      expect(await victimExists(db.databaseName), 'probe_victim was dropped').toBe(true);
      expect(outcome).toMatch(/^refused: .*syntax/i);
    });
  });

  it('still carries a second statement on the script pool, which the editor needs', async () => {
    await withFreshDatabase('mysql', async db => {
      await createVictim(db.databaseName);
      const connectionId = registerProfile(db.databaseName);

      const pool = await ConnectionPoolManager.getInstance().getMySQLPool(
        connectionId,
        db.databaseName,
        'script'
      );

      await pool.query(STACKED);
      // The counterpart assertion: this pool really does multiplex, which is
      // why the restricted one had to be a separate pool rather than a flag flip.
      expect(await victimExists(db.databaseName)).toBe(false);
    });
  });

  it('hands out a different, separately-cached pool per trust level', async () => {
    await withFreshDatabase('mysql', async db => {
      const connectionId = registerProfile(db.databaseName);
      const manager = ConnectionPoolManager.getInstance();

      const restricted = await manager.getMySQLPool(connectionId, db.databaseName);
      const script = await manager.getMySQLPool(connectionId, db.databaseName, 'script');

      expect(restricted).not.toBe(script);
      expect(await manager.getMySQLPool(connectionId, db.databaseName)).toBe(restricted);
      expect(await manager.getMySQLPool(connectionId, db.databaseName, 'script')).toBe(script);
    });
  });

  it('releases both trust levels when a database is released for DDL', async () => {
    await withFreshDatabase('mysql', async db => {
      const connectionId = registerProfile(db.databaseName);
      const manager = ConnectionPoolManager.getInstance();

      const restricted = await manager.getMySQLPool(connectionId, db.databaseName);
      const script = await manager.getMySQLPool(connectionId, db.databaseName, 'script');

      // DROP DATABASE needs Joinery to let go of every connection to it, not
      // just the ones on the default trust level.
      await manager.closePoolForDatabase(connectionId, db.databaseName);

      expect(await manager.getMySQLPool(connectionId, db.databaseName)).not.toBe(restricted);
      expect(await manager.getMySQLPool(connectionId, db.databaseName, 'script')).not.toBe(script);
    });
  });
});

describe('MySQL callers on the live server', () => {
  it('refuses raw model SQL that stacks a statement (ToolRegistry.execute_query)', async () => {
    await withFreshDatabase('mysql', async db => {
      await createVictim(db.databaseName);
      const connectionId = registerProfile(db.databaseName);

      // execute_query has no confirmation gate — it is the AI surface's widest
      // path, and the model's string is the whole statement. Single-statement
      // is now enforced by the connection rather than assumed.
      const outcome = await ToolRegistry.getInstance()
        .executeTool('execute_query', { sql: STACKED }, connectionId, db.databaseName)
        .then(
          () => 'ran',
          (err: Error) => `refused: ${err.message}`
        );

      expect(await victimExists(db.databaseName), 'probe_victim was dropped').toBe(true);
      expect(outcome).toMatch(/^refused: .*syntax/i);
    });
  });

  it('refuses a stacked statement on an internally-built query (QueryExecutor default)', async () => {
    await withFreshDatabase('mysql', async db => {
      await createVictim(db.databaseName);
      const connectionId = registerProfile(db.databaseName);

      const result = await QueryExecutor.getInstance().execute({
        connectionId,
        database: db.databaseName,
        sql: STACKED,
      });

      expect(await victimExists(db.databaseName), 'probe_victim was dropped').toBe(true);
      expect(result.success).toBe(false);
    });
  });

  it('binds the FK preview’s cell value rather than escaping it (J-145)', async () => {
    // The row inspector's foreign-key preview: the one auto-executing lookup whose predicate
    // carries a result-set cell. Two claims at once, and the second is the one escaping could not
    // make — the payload cannot start a statement (probe_victim survives) AND it round-trips
    // EXACTLY, where the doubled backslash J-134 had to write is lossy under
    // `NO_BACKSLASH_ESCAPES`. A bound value is neither escaped nor lexed.
    await withFreshDatabase('mysql', async db => {
      await createVictim(db.databaseName);
      const connectionId = registerProfile(db.databaseName);

      await withAdminConnection(db.databaseName, async conn => {
        await conn.query(
          'CREATE TABLE fk_target (code VARCHAR(64) PRIMARY KEY, label VARCHAR(64))'
        );
        await conn.query('INSERT INTO fk_target (code, label) VALUES (?, ?)', [
          FK_CELL_PAYLOAD,
          'found',
        ]);
      });

      const result = await fetchFkRecord({
        connectionId,
        database: db.databaseName,
        schema: db.databaseName,
        table: 'fk_target',
        column: 'code',
        value: FK_CELL_PAYLOAD,
      });

      expect(await victimExists(db.databaseName), 'probe_victim was dropped').toBe(true);
      expect(result.success).toBe(true);
      expect(result.record?.label).toBe('found');
      expect(result.record?.code).toBe(FK_CELL_PAYLOAD);
      // The primary-key marker the preview draws. Before J-145 it came from the executor's
      // SQL-parsing enrichment, which only ever ran on SQL Server; the handler is told the table
      // outright now, so MySQL gets it too.
      expect(result.columns?.find(column => column.name === 'code')?.isPrimaryKey).toBe(true);
    });
  });

  it('still runs a multi-statement script from the editor', async () => {
    await withFreshDatabase('mysql', async db => {
      const connectionId = registerProfile(db.databaseName);

      const result = await QueryExecutor.getInstance().execute(
        {
          connectionId,
          database: db.databaseName,
          sql: 'SELECT 1 AS a; SELECT 2 AS b',
        },
        { mysqlTrust: 'script' }
      );

      expect(result.success).toBe(true);
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets?.[0].rows[0]).toEqual({ a: 1 });
      expect(result.resultSets?.[1].rows[0]).toEqual({ b: 2 });
    });
  });

  it('still lists tables through the restricted pool', async () => {
    await withFreshDatabase('mysql', async db => {
      await createVictim(db.databaseName);
      const connectionId = registerProfile(db.databaseName);

      const tables = await MetadataService.getInstance().listTables(
        connectionId,
        db.databaseName,
        true
      );

      expect(tables.map(t => t.name)).toContain('probe_victim');
    });
  });
});

// ---- helpers ----

function registerProfile(dbName: string): string {
  const connectionId = randomUUID();
  const c = TEST_CONNECTIONS.mysql;
  fakeProfiles.set(connectionId, {
    id: connectionId,
    name: 'mysql-j137',
    engine: 'mysql',
    server: c.host,
    port: c.port,
    username: c.user,
    database: dbName,
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 30,
  });
  fakePasswords.set(connectionId, c.password);
  return connectionId;
}

/** Direct driver connection, deliberately outside Joinery's pools. */
async function withAdminConnection<T>(
  dbName: string,
  fn: (conn: mysql.Connection) => Promise<T>
): Promise<T> {
  const c = TEST_CONNECTIONS.mysql;
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dbName,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

async function createVictim(dbName: string): Promise<void> {
  await withAdminConnection(dbName, async conn => {
    await conn.query('CREATE TABLE probe_victim (label INT)');
  });
}

async function victimExists(dbName: string): Promise<boolean> {
  return withAdminConnection(dbName, async conn => {
    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, 'probe_victim']
    );
    return Number((rows as Record<string, unknown>[])[0].n) === 1;
  });
}
