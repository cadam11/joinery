/**
 * MySQL backup/restore round-trip — integration test.
 *
 * Same shape as the PG round-trip: spawn `mysqldump` to capture the
 * database, drop the verification table, pipe the dump file into the
 * `mysql` CLI to restore, and re-query to confirm the rows came back.
 * Exercises the real client tools against the test MySQL container, so
 * this fails fast if mysqldump/mysql aren't on PATH or the service
 * regresses on argument handling, env vars, or progress reporting.
 *
 * The same electron + connection-profiles mocking pattern as the PG
 * spec — see backup-ipc-capture.ts for how completion events are
 * captured and awaited.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { ipcCapture, waitForOperation } from '../../helpers/backup-ipc-capture';
import { withFreshDatabase, TEST_CONNECTIONS } from '../../helpers/db-fixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeProfiles: Map<string, any> = new Map();
const fakePasswords: Map<string, string> = new Map();

/**
 * Connection-shaped fields every real `ConnectionProfile` carries, merged under
 * whatever a test sets. The restore path reads them — since J-151 the
 * post-restore existence check builds its connection from the profile, TLS and
 * connect timeout included — so a double that omits them is not the object the
 * service is handed in production. A test that cares overrides them.
 */
const PROFILE_DEFAULTS = {
  authenticationType: 'sql',
  encrypt: false,
  trustServerCertificate: false,
  connectionTimeout: 15,
};

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: { send: ipcCapture.send },
      },
    ],
  },
}));

vi.mock('@joinery/main/services/config/connection-profiles', () => ({
  ConnectionProfilesStore: {
    getInstance: () => ({
      getById: (id: string) => {
        const profile = fakeProfiles.get(id);
        return profile ? { ...PROFILE_DEFAULTS, ...profile } : undefined;
      },
      getPassword: async (id: string) => fakePasswords.get(id) ?? null,
    }),
  },
}));

import { MySQLBackupService } from '@joinery/main/services/sql/mysql-backup';

describe('mysql backup/restore round-trip', () => {
  const tmpFiles: string[] = [];

  beforeEach(() => {
    ipcCapture.reset();
    fakeProfiles.clear();
    fakePasswords.clear();
    MySQLBackupService.resetInstance();
  });

  afterAll(async () => {
    for (const path of tmpFiles) {
      await rm(path, { force: true }).catch(() => {});
    }
  });

  it('backs up a seeded table, drops it, restores from the dump, and recovers all rows', async () => {
    await withFreshDatabase('mysql', async db => {
      const c = db.config;

      const seedConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
        multipleStatements: true,
      });
      try {
        await seedConn.query('CREATE TABLE foo (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)');
        await seedConn.query(
          "INSERT INTO foo (id, name) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')"
        );
      } finally {
        await seedConn.end();
      }

      const connectionId = randomUUID();
      fakeProfiles.set(connectionId, {
        id: connectionId,
        engine: 'mysql',
        server: c.host,
        port: c.port,
        username: c.user,
      });
      fakePasswords.set(connectionId, c.password);

      const backupPath = join(tmpdir(), `joinery-mysql-backup-${connectionId}.sql`);
      tmpFiles.push(backupPath);

      const service = MySQLBackupService.getInstance();

      const backupOpId = await service.startBackup({
        connectionId,
        database: c.database,
        backupPath,
      });
      expect(backupOpId).toMatch(/^[0-9a-f-]{36}$/i);

      const backupResult = await waitForOperation(ipcCapture, backupOpId);
      expect(backupResult.success, `backup failed: ${backupResult.error}`).toBe(true);

      // Drop foo so the restore has work to do — the mysqldump output
      // contains DROP TABLE / CREATE TABLE for `foo` (the service uses
      // `--add-drop-table`), so re-running it on an existing schema is
      // idempotent and doesn't need a `replaceExisting` flag.
      const dropConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      try {
        await dropConn.query('DROP TABLE foo');
      } finally {
        await dropConn.end();
      }

      const restoreOpId = await service.startRestore({
        connectionId,
        backupPath,
        targetDatabase: c.database,
      });
      expect(restoreOpId).toMatch(/^[0-9a-f-]{36}$/i);

      const restoreResult = await waitForOperation(ipcCapture, restoreOpId);
      expect(restoreResult.success, `restore failed: ${restoreResult.error}`).toBe(true);

      const verifyConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      try {
        const [rows] = await verifyConn.query<mysql.RowDataPacket[]>(
          'SELECT id, name FROM foo ORDER BY id'
        );
        expect(rows).toEqual([
          { id: 1, name: 'alpha' },
          { id: 2, name: 'beta' },
          { id: 3, name: 'gamma' },
        ]);
      } finally {
        await verifyConn.end();
      }
    });
  }, 60_000);

  // Regression: MySQL CLI rejects connecting with a non-existent default
  // database (ERROR 1049 (42000): Unknown database 'X'). startRestore used
  // to pass the target db as a positional arg, which made the CLI fail
  // before the dump could create the target. The fix prepends
  // CREATE DATABASE IF NOT EXISTS / USE to the dump stream so a new target
  // is created on the fly. This test fails without that fix.
  it('restores into a target database that does not yet exist', async () => {
    await withFreshDatabase('mysql', async db => {
      const c = db.config;

      const seedConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      try {
        await seedConn.query('CREATE TABLE bar (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)');
        await seedConn.query("INSERT INTO bar (id, label) VALUES (1, 'one'), (2, 'two')");
      } finally {
        await seedConn.end();
      }

      const connectionId = randomUUID();
      fakeProfiles.set(connectionId, {
        id: connectionId,
        engine: 'mysql',
        server: c.host,
        port: c.port,
        username: c.user,
      });
      fakePasswords.set(connectionId, c.password);

      const backupPath = join(tmpdir(), `joinery-mysql-newdb-${connectionId}.sql`);
      tmpFiles.push(backupPath);

      const service = MySQLBackupService.getInstance();

      const backupOpId = await service.startBackup({
        connectionId,
        database: c.database,
        backupPath,
      });
      const backupResult = await waitForOperation(ipcCapture, backupOpId);
      expect(backupResult.success, `backup failed: ${backupResult.error}`).toBe(true);

      // Restore into a database name that doesn't exist yet on the server.
      const newDb = `joinery_restore_${randomUUID().slice(0, 8).replace(/-/g, '')}`;

      const restoreOpId = await service.startRestore({
        connectionId,
        backupPath,
        targetDatabase: newDb,
      });
      const restoreResult = await waitForOperation(ipcCapture, restoreOpId);
      expect(restoreResult.success, `restore failed: ${restoreResult.error}`).toBe(true);

      const verifyConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: newDb,
      });
      try {
        const [rows] = await verifyConn.query<mysql.RowDataPacket[]>(
          'SELECT id, label FROM bar ORDER BY id'
        );
        expect(rows).toEqual([
          { id: 1, label: 'one' },
          { id: 2, label: 'two' },
        ]);
      } finally {
        await verifyConn.end();
        // Clean up the side-effect database the test created.
        const cleanupConn = await mysql.createConnection({
          host: c.host,
          port: c.port,
          user: c.user,
          password: c.password,
        });
        try {
          await cleanupConn.query(`DROP DATABASE IF EXISTS \`${newDb}\``);
        } finally {
          await cleanupConn.end();
        }
      }
    });
  }, 60_000);

  it('rejects target database names that contain unsafe characters', async () => {
    const connectionId = randomUUID();
    fakeProfiles.set(connectionId, {
      id: connectionId,
      engine: 'mysql',
      server: '127.0.0.1',
      port: 13306,
      username: 'joinery',
    });
    fakePasswords.set(connectionId, 'joinery');

    const service = MySQLBackupService.getInstance();

    await expect(
      service.startRestore({
        connectionId,
        backupPath: '/tmp/whatever.sql',
        targetDatabase: 'evil; DROP DATABASE prod; --',
      })
    ).rejects.toThrow(/Invalid target database name/);
  });

  // An empty .sql file is the simplest happy-path-ish shape that still
  // exercises the restore pipeline end-to-end. Joinery's prepended
  // CREATE DATABASE IF NOT EXISTS + USE makes the target exist regardless
  // of whether the dump has content; an empty file should restore to an
  // empty-but-present database. This pins the contract: empty dump =>
  // success, target exists, no spurious failure.
  it('handles an empty dump by creating an empty target database', async () => {
    const c = TEST_CONNECTIONS.mysql;
    const connectionId = randomUUID();
    fakeProfiles.set(connectionId, {
      id: connectionId,
      engine: 'mysql',
      server: c.host,
      port: c.port,
      username: c.user,
    });
    fakePasswords.set(connectionId, c.password);

    const dumpPath = join(tmpdir(), `joinery-mysql-empty-${connectionId}.sql`);
    tmpFiles.push(dumpPath);
    const fs = await import('node:fs/promises');
    await fs.writeFile(dumpPath, '', 'utf8');

    const newDb = `joinery_empty_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const service = MySQLBackupService.getInstance();

    try {
      const restoreOpId = await service.startRestore({
        connectionId,
        backupPath: dumpPath,
        targetDatabase: newDb,
      });
      const result = await waitForOperation(ipcCapture, restoreOpId);
      expect(result.success, `restore failed: ${result.error}`).toBe(true);

      // The verify step should have confirmed the target exists.
      const probeConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
      });
      try {
        const [rows] = await probeConn.query<mysql.RowDataPacket[]>(
          'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
          [newDb]
        );
        expect(rows.length).toBe(1);
      } finally {
        await probeConn.end();
      }
    } finally {
      const cleanupConn = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
      });
      try {
        await cleanupConn.query(`DROP DATABASE IF EXISTS \`${newDb}\``);
      } finally {
        await cleanupConn.end();
      }
    }
  }, 60_000);

  // Regression: when the connecting user lacks CREATE DATABASE privilege,
  // mysql CLI's behavior on the prepended CREATE failing varies — the
  // prior code reported success based purely on exit code 0. The new
  // verifyDatabaseExists step queries information_schema on a fresh
  // connection after mysql exits and turns "exit 0 but db missing" into
  // a clear failure pointing at the likely cause. The joinery test mysql
  // container ships with a `joinery`/`joinery` user that has rights only on
  // joinery_test; trying to CREATE a new database as that user should
  // fail at minimum at the verify step.
  it('reports failure when target db is missing after mysql exits (low-priv user)', async () => {
    const c = TEST_CONNECTIONS.mysql;
    const connectionId = randomUUID();
    fakeProfiles.set(connectionId, {
      id: connectionId,
      engine: 'mysql',
      server: c.host,
      port: c.port,
      username: 'joinery', // limited user; rights only on joinery_test
    });
    fakePasswords.set(connectionId, 'joinery');

    // Empty dump — the only statements mysql sees are our prepended
    // CREATE DATABASE / USE, both of which the limited user can't run
    // against a brand-new schema.
    const dumpPath = join(tmpdir(), `joinery-mysql-noperm-${connectionId}.sql`);
    tmpFiles.push(dumpPath);
    const fs = await import('node:fs/promises');
    await fs.writeFile(dumpPath, '', 'utf8');

    const newDb = `joinery_noperm_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const service = MySQLBackupService.getInstance();

    const restoreOpId = await service.startRestore({
      connectionId,
      backupPath: dumpPath,
      targetDatabase: newDb,
    });
    const result = await waitForOperation(ipcCapture, restoreOpId);
    expect(result.success).toBe(false);
    // Either mysql aborts with non-zero (clear failure) or exits 0 and
    // the verify step catches the missing target — both are acceptable.
    expect(result.error).toBeTruthy();
  }, 60_000);

  /**
   * J-151 — the post-restore existence check must connect the way the profile
   * says, TLS included.
   *
   * It used to build its own `createConnection` literal of
   * `{ host, port, user, password }`, so `profile.encrypt` never reached it. A
   * server that refuses plaintext therefore rejected the check, and a restore
   * that had *succeeded* was reported to the user as a failure.
   *
   * The refusal is expressed per-user (`CREATE USER ... REQUIRE SSL`) rather
   * than server-wide: `SET GLOBAL require_secure_transport = ON` would break
   * every other spec sharing this container if this test died before resetting
   * it. The user is dropped in a `finally`.
   *
   * The mysql CLI that performs the restore itself needs no help — MySQL 8's
   * client defaults to `--ssl-mode=PREFERRED` and negotiates TLS on its own.
   * `trustServerCertificate: true` is required on Joinery's side because the
   * mysql:8 image auto-generates a self-signed server certificate.
   *
   * Before the fix this fails with "post-restore verification failed: Access
   * denied for user" while the database it is asking about does exist.
   */
  it('verifies the restore over TLS when the profile requires it (J-151)', async () => {
    const c = TEST_CONNECTIONS.mysql;
    const suffix = randomUUID().slice(0, 8).replace(/-/g, '');
    const tlsUser = `joinery_tls_${suffix}`;
    const newDb = `joinery_tls_${suffix}`;

    const admin = await mysql.createConnection({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      multipleStatements: true,
    });
    try {
      // REQUIRE SSL: this user cannot authenticate over a plaintext socket.
      // Privileges on *.* because the restore prelude creates the target.
      await admin.query(
        `CREATE USER '${tlsUser}'@'%' IDENTIFIED BY 'joinery' REQUIRE SSL;` +
          `GRANT ALL PRIVILEGES ON *.* TO '${tlsUser}'@'%'`
      );

      const connectionId = randomUUID();
      fakeProfiles.set(connectionId, {
        id: connectionId,
        engine: 'mysql',
        server: c.host,
        port: c.port,
        username: tlsUser,
        encrypt: true,
        trustServerCertificate: true, // the container's cert is self-signed
      });
      fakePasswords.set(connectionId, 'joinery');

      const dumpPath = join(tmpdir(), `joinery-mysql-tls-${connectionId}.sql`);
      tmpFiles.push(dumpPath);
      const fs = await import('node:fs/promises');
      await fs.writeFile(dumpPath, '', 'utf8');

      const restoreOpId = await MySQLBackupService.getInstance().startRestore({
        connectionId,
        backupPath: dumpPath,
        targetDatabase: newDb,
      });
      const result = await waitForOperation(ipcCapture, restoreOpId);
      expect(result.success, `restore failed: ${result.error}`).toBe(true);

      const [rows] = await admin.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [newDb]
      );
      expect(rows.length).toBe(1);
    } finally {
      // Cleanup failure must not mask the real result, but it must be visible:
      // a leaked REQUIRE SSL user would confuse the next run of this tier.
      // eslint-disable-next-line no-console -- cleanup diagnostics, same as db-fixtures.ts:281
      const warn = (what: string, err: unknown) => console.error(`[j-151] ${what}:`, err);
      await admin
        .query(`DROP DATABASE IF EXISTS \`${newDb}\``)
        .catch(err => warn(`failed to drop database ${newDb}`, err));
      await admin
        .query(`DROP USER IF EXISTS '${tlsUser}'@'%'`)
        .catch(err => warn(`failed to drop user ${tlsUser}`, err));
      await admin.end();
    }
  }, 60_000);
});
