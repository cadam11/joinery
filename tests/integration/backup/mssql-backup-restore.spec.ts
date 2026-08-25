/**
 * MSSQL backup/restore round-trip — integration test.
 *
 * Unlike the PG/MySQL paths (which shell out to pg_dump/mysqldump on the
 * Joinery host machine), MSSQL backup runs as T-SQL via BACKUP DATABASE on
 * the *server*. The .bak file lands on the SQL Server container's local
 * disk. We pick a path under /var/opt/mssql/data which is the data dir
 * SQL Server's process user can read/write.
 *
 * This means we never see the .bak on the host filesystem — but we don't
 * need to. The same SQL Server reads it back during RESTORE, and we
 * verify by querying the restored data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sqlserver from 'mssql';
import { randomUUID } from 'node:crypto';

import { ipcCapture, waitForOperation } from '../../helpers/backup-ipc-capture';
import { TEST_CONNECTIONS } from '../../helpers/db-fixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeProfiles: Map<string, any> = new Map();
const fakePasswords: Map<string, string> = new Map();

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
      getById: (id: string) => fakeProfiles.get(id),
      getPassword: async (id: string) => fakePasswords.get(id) ?? null,
    }),
  },
}));

import { BackupRestoreService } from '@joinery/main/services/sql/backup-restore';
import { ConnectionPoolManager } from '@joinery/main/services/sql/connection-pool';
import { OperationClaims } from '@joinery/main/services/sql/operation-claims';

const SQLSERVER_DATA_DIR = '/var/opt/mssql/data';

function freshDbName(): string {
  return `joinery_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function withMssqlAdminPool<T>(
  fn: (pool: sqlserver.ConnectionPool) => Promise<T>
): Promise<T> {
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
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

async function dropDbIfExists(name: string): Promise<void> {
  await withMssqlAdminPool(pool =>
    pool
      .request()
      .batch(
        `IF DB_ID('${name}') IS NOT NULL ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ` +
          `IF DB_ID('${name}') IS NOT NULL DROP DATABASE [${name}];`
      )
  );
}

async function dbExists(name: string): Promise<boolean> {
  return withMssqlAdminPool(async pool => {
    const r = await pool
      .request()
      .input('name', sqlserver.NVarChar, name)
      .query<{ hit: number }>('SELECT 1 AS hit FROM sys.databases WHERE name = @name');
    return r.recordset.length === 1;
  });
}

async function rowsInBar(name: string): Promise<{ id: number; label: string }[]> {
  const c = TEST_CONNECTIONS.mssql;
  const pool = new sqlserver.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: name,
    options: { trustServerCertificate: true, encrypt: false },
  });
  await pool.connect();
  try {
    const r = await pool
      .request()
      .query<{ id: number; label: string }>('SELECT id, label FROM dbo.bar ORDER BY id');
    return r.recordset;
  } finally {
    await pool.close();
  }
}

describe('mssql backup/restore round-trip', () => {
  let sourceDb: string;
  let connectionId: string;
  let backupPath: string;

  beforeEach(async () => {
    ipcCapture.reset();
    fakeProfiles.clear();
    fakePasswords.clear();
    BackupRestoreService.resetInstance();
    OperationClaims.resetInstance();
    ConnectionPoolManager.resetInstance();

    sourceDb = freshDbName();

    // Create the source database + a tiny seeded table.
    await withMssqlAdminPool(pool => pool.request().batch(`CREATE DATABASE [${sourceDb}];`));
    const c = TEST_CONNECTIONS.mssql;
    const seedPool = new sqlserver.ConnectionPool({
      server: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: sourceDb,
      options: { trustServerCertificate: true, encrypt: false },
    });
    await seedPool.connect();
    try {
      await seedPool
        .request()
        .batch(
          `CREATE TABLE dbo.bar (id INT PRIMARY KEY, label NVARCHAR(32) NOT NULL); ` +
            `INSERT INTO dbo.bar (id, label) VALUES (1, N'one'), (2, N'two'), (3, N'three');`
        );
    } finally {
      await seedPool.close();
    }

    connectionId = randomUUID();
    fakeProfiles.set(connectionId, {
      id: connectionId,
      name: 'mssql-test',
      engine: 'mssql',
      server: c.host,
      port: c.port,
      username: c.user,
      encrypt: false,
      trustServerCertificate: true,
      connectionTimeout: 30,
    });
    fakePasswords.set(connectionId, c.password);

    backupPath = `${SQLSERVER_DATA_DIR}/${sourceDb}.bak`;
  });

  afterEach(async () => {
    await dropDbIfExists(sourceDb);
    ConnectionPoolManager.resetInstance();
  });

  it('backs up a database, drops it, and restores from the .bak', async () => {
    const service = BackupRestoreService.getInstance();

    const backupOpId = await service.startBackup({
      connectionId,
      database: sourceDb,
      backupPath,
      backupType: 'full',
    });
    const backupResult = await waitForOperation(ipcCapture, backupOpId);
    expect(backupResult.success, `backup failed: ${backupResult.error}`).toBe(true);

    await dropDbIfExists(sourceDb);
    expect(await dbExists(sourceDb)).toBe(false);

    const restoreOpId = await service.startRestore({
      connectionId,
      backupPath,
      targetDatabase: sourceDb,
    });
    const restoreResult = await waitForOperation(ipcCapture, restoreOpId);
    expect(restoreResult.success, `restore failed: ${restoreResult.error}`).toBe(true);

    expect(await dbExists(sourceDb)).toBe(true);
    expect(await rowsInBar(sourceDb)).toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
      { id: 3, label: 'three' },
    ]);
  }, 60_000);

  // ── J-48f ──────────────────────────────────────────────────────────────────────────────────
  //
  // Two starts against one destination used to spawn two runs writing the same file: the archive
  // is corrupt and BOTH report success. The renderer grew an in-flight record as a mitigation, but
  // it is per window — it does not survive a reload and does not cover any other caller of
  // `backup.start`. This asserts the refusal happens in main, and — just as important — that the
  // destination is free again afterwards, because a leaked claim would lock it for the session.
  it('refuses a second backup to a destination one is already writing, then frees it', async () => {
    const service = BackupRestoreService.getInstance();

    const firstOpId = await service.startBackup({
      connectionId,
      database: sourceDb,
      backupPath,
      backupType: 'full',
    });

    await expect(
      service.startBackup({ connectionId, database: sourceDb, backupPath, backupType: 'full' })
    ).rejects.toThrow(/already running/);

    const firstResult = await waitForOperation(ipcCapture, firstOpId);
    expect(firstResult.success, `first backup failed: ${firstResult.error}`).toBe(true);

    // Released on completion, so the same path is usable again.
    const secondOpId = await service.startBackup({
      connectionId,
      database: sourceDb,
      backupPath,
      backupType: 'full',
    });
    const secondResult = await waitForOperation(ipcCapture, secondOpId);
    expect(secondResult.success, `second backup failed: ${secondResult.error}`).toBe(true);
  }, 60_000);

  // ── J-48a ──────────────────────────────────────────────────────────────────────────────────
  //
  // The bug this replaces: `backupType: 'log'` fell through both arms of the builder's type
  // branch and picked up `INIT` with everything else, so it ran `BACKUP DATABASE … WITH INIT` —
  // a FULL backup that OVERWROTE the destination — and reported success. A user taking a log
  // backup onto the file holding their full backup destroyed it and was told it worked.
  //
  // Asserting on the emitted SQL would only restate the builder. This asks SQL Server what is
  // actually in the file afterwards.
  it('takes a real log backup that appends to the file instead of destroying what is in it', async () => {
    const service = BackupRestoreService.getInstance();

    const fullOpId = await service.startBackup({
      connectionId,
      database: sourceDb,
      backupPath,
      backupType: 'full',
    });
    const fullResult = await waitForOperation(ipcCapture, fullOpId);
    expect(fullResult.success, `full backup failed: ${fullResult.error}`).toBe(true);

    // A log backup needs something to have happened since the full one.
    await withMssqlAdminPool(pool =>
      pool.request().batch(`INSERT INTO [${sourceDb}].dbo.bar (id, label) VALUES (4, N'four');`)
    );

    const logOpId = await service.startBackup({
      connectionId,
      database: sourceDb,
      backupPath, // deliberately the SAME file the full backup went to
      backupType: 'log',
    });
    const logResult = await waitForOperation(ipcCapture, logOpId);
    expect(logResult.success, `log backup failed: ${logResult.error}`).toBe(true);

    // BackupType 1 = database, 2 = transaction log. Two sets, in order, is the whole claim:
    // the full backup survived (it would be gone under INIT), and the second set is really a
    // log backup rather than another full one wearing the label.
    const header = await withMssqlAdminPool(pool =>
      pool
        .request()
        .query<{ BackupType: number }>(`RESTORE HEADERONLY FROM DISK = N'${backupPath}'`)
    );

    expect(header.recordset.map(row => Number(row.BackupType))).toEqual([1, 2]);
  }, 60_000);

  it('restores into a brand-new target database name', async () => {
    const service = BackupRestoreService.getInstance();

    const backupOpId = await service.startBackup({
      connectionId,
      database: sourceDb,
      backupPath,
      backupType: 'full',
    });
    const backupResult = await waitForOperation(ipcCapture, backupOpId);
    expect(backupResult.success, `backup failed: ${backupResult.error}`).toBe(true);

    const newDb = freshDbName();
    try {
      // Restoring to a different database name on MSSQL needs WITH MOVE
      // clauses so SQL Server doesn't try to overwrite the source's
      // existing .mdf/.ldf files. Mirror what the renderer's restore
      // dialog does: read the backup header to discover the logical file
      // names, then point them at fresh paths under the data dir.
      const fileList = await withMssqlAdminPool(pool =>
        pool.request().query<{
          LogicalName: string;
          Type: 'D' | 'L';
        }>(`RESTORE FILELISTONLY FROM DISK = N'${backupPath}'`)
      );
      const fileRelocations = fileList.recordset.map(row => {
        const ext = row.Type === 'L' ? '_log.ldf' : '.mdf';
        const path = `${SQLSERVER_DATA_DIR}/${newDb}${ext}`;
        // FileRelocation requires `physicalName`; `newPath` is documented as
        // an alias the renderer fills in. Set both so we satisfy the type
        // and exercise the same shape the renderer sends.
        return {
          logicalName: row.LogicalName,
          physicalName: path,
          newPath: path,
        };
      });

      const restoreOpId = await service.startRestore({
        connectionId,
        backupPath,
        targetDatabase: newDb,
        fileRelocations,
      });
      const restoreResult = await waitForOperation(ipcCapture, restoreOpId);
      expect(restoreResult.success, `restore failed: ${restoreResult.error}`).toBe(true);

      expect(await dbExists(newDb)).toBe(true);
      expect(await rowsInBar(newDb)).toEqual([
        { id: 1, label: 'one' },
        { id: 2, label: 'two' },
        { id: 3, label: 'three' },
      ]);
    } finally {
      await dropDbIfExists(newDb);
    }
  }, 60_000);
});
