/**
 * PostgreSQL backup/restore round-trip — integration test.
 *
 * Pins the contract that PgBackupService.startBackup followed by
 * PgBackupService.startRestore returns the database to its pre-drop state.
 * Exercises the real `pg_dump` / `pg_restore` CLIs against the test PG
 * container, so this fails fast if the CLI tools aren't on PATH or the
 * service drops them on the floor.
 *
 * The service signals completion via BrowserWindow.getAllWindows() IPC,
 * which doesn't exist in a Node-only Vitest run. We mock `electron` with
 * a fake window that captures every send() into a buffer, then await the
 * completion event for a given operationId. The mock for
 * `connection-profiles` substitutes a controllable profile/password store
 * so the test owns those values without touching electron-store / keytar.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client as PgClient } from 'pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { ipcCapture, waitForOperation } from '../../helpers/backup-ipc-capture';
import { withFreshDatabase } from '../../helpers/db-fixtures';

// vi.mock calls are hoisted, so they take effect before the SUT import below.
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

// Import AFTER mocks so the service constructor sees the fake store.
import { PgBackupService } from '@joinery/main/services/sql/pg-backup';

describe('postgres backup/restore round-trip', () => {
  const tmpFiles: string[] = [];

  beforeEach(() => {
    ipcCapture.reset();
    fakeProfiles.clear();
    fakePasswords.clear();
    // Force a fresh service instance per test so the activeOperations Map
    // doesn't leak state between cases.
    PgBackupService.resetInstance();
  });

  afterAll(async () => {
    for (const path of tmpFiles) {
      await rm(path, { force: true }).catch(() => {});
    }
  });

  it('backs up a seeded table, drops it, restores from the dump, and recovers all rows', async () => {
    await withFreshDatabase('postgres', async db => {
      const c = db.config;

      const seedClient = new PgClient({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      await seedClient.connect();
      try {
        await seedClient.query('CREATE TABLE foo (id INT PRIMARY KEY, name TEXT NOT NULL)');
        await seedClient.query(
          "INSERT INTO foo (id, name) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')"
        );
      } finally {
        await seedClient.end();
      }

      const connectionId = randomUUID();
      fakeProfiles.set(connectionId, {
        id: connectionId,
        engine: 'postgresql',
        server: c.host,
        port: c.port,
        username: c.user,
      });
      fakePasswords.set(connectionId, c.password);

      const backupPath = join(tmpdir(), `joinery-pg-backup-${connectionId}.dump`);
      tmpFiles.push(backupPath);

      const service = PgBackupService.getInstance();

      const backupOpId = await service.startBackup({
        connectionId,
        database: c.database,
        backupPath,
      });
      expect(backupOpId).toMatch(/^[0-9a-f-]{36}$/i);

      const backupResult = await waitForOperation(ipcCapture, backupOpId);
      expect(backupResult).toEqual({ success: true, error: undefined });

      // Drop the table — the restore must put it back.
      const dropClient = new PgClient({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      await dropClient.connect();
      try {
        await dropClient.query('DROP TABLE foo');
      } finally {
        await dropClient.end();
      }

      // `withFreshDatabase` applies the synthetic e-commerce schema on
      // creation, so the dump contains both that schema AND our `foo`
      // table. Without `replaceExisting`, pg_restore hits "constraint
      // already exists" errors on the existing FKs. The flag wires up
      // `--clean --if-exists`, matching how a real user would restore
      // over an existing database.
      const restoreOpId = await service.startRestore({
        connectionId,
        backupPath,
        targetDatabase: c.database,
        replaceExisting: true,
      });
      expect(restoreOpId).toMatch(/^[0-9a-f-]{36}$/i);

      const restoreResult = await waitForOperation(ipcCapture, restoreOpId);
      expect(restoreResult.success, `restore failed: ${restoreResult.error}`).toBe(true);

      const verifyClient = new PgClient({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      await verifyClient.connect();
      try {
        const r = await verifyClient.query<{ id: number; name: string }>(
          'SELECT id, name FROM foo ORDER BY id'
        );
        expect(r.rows).toEqual([
          { id: 1, name: 'alpha' },
          { id: 2, name: 'beta' },
          { id: 3, name: 'gamma' },
        ]);
      } finally {
        await verifyClient.end();
      }
    });
  }, 60_000);

  // Pins the contract that pg_restore needs the target database to already
  // exist when we don't pass `-C` (we never do — Joinery generates plain
  // dumps without the CREATE DATABASE preamble). The MySQL flow surfaces
  // the same issue with a different error message; PG's pg_restore would
  // emit "could not connect to database X" against a non-existent target.
  // The user's flow goes through the renderer's restore dialog which
  // first creates the target db, so we mirror that here: CREATE the
  // target with the admin client, then run pg_restore against it.
  it('restores into a target database that does not yet exist', async () => {
    await withFreshDatabase('postgres', async db => {
      const c = db.config;

      // Seed source.
      const seedClient = new PgClient({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
      });
      await seedClient.connect();
      try {
        await seedClient.query('CREATE TABLE bar (id INT PRIMARY KEY, label TEXT NOT NULL)');
        await seedClient.query("INSERT INTO bar (id, label) VALUES (1, 'one'), (2, 'two')");
      } finally {
        await seedClient.end();
      }

      const connectionId = randomUUID();
      fakeProfiles.set(connectionId, {
        id: connectionId,
        engine: 'postgresql',
        server: c.host,
        port: c.port,
        username: c.user,
      });
      fakePasswords.set(connectionId, c.password);

      const backupPath = join(tmpdir(), `joinery-pg-newdb-${connectionId}.dump`);
      tmpFiles.push(backupPath);

      const service = PgBackupService.getInstance();

      const backupOpId = await service.startBackup({
        connectionId,
        database: c.database,
        backupPath,
      });
      const backupResult = await waitForOperation(ipcCapture, backupOpId);
      expect(backupResult.success, `backup failed: ${backupResult.error}`).toBe(true);

      // Create the target db. The renderer's restore dialog does this
      // up-front via the database CREATE IPC; the test mirrors that.
      const newDb = `joinery_restore_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
      const adminClient = new PgClient({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: 'postgres',
      });
      await adminClient.connect();
      try {
        await adminClient.query(`CREATE DATABASE "${newDb}"`);
      } finally {
        await adminClient.end();
      }

      try {
        const restoreOpId = await service.startRestore({
          connectionId,
          backupPath,
          targetDatabase: newDb,
        });
        const restoreResult = await waitForOperation(ipcCapture, restoreOpId);
        expect(restoreResult.success, `restore failed: ${restoreResult.error}`).toBe(true);

        const verifyClient = new PgClient({
          host: c.host,
          port: c.port,
          user: c.user,
          password: c.password,
          database: newDb,
        });
        await verifyClient.connect();
        try {
          const r = await verifyClient.query<{ id: number; label: string }>(
            'SELECT id, label FROM bar ORDER BY id'
          );
          expect(r.rows).toEqual([
            { id: 1, label: 'one' },
            { id: 2, label: 'two' },
          ]);
        } finally {
          await verifyClient.end();
        }
      } finally {
        // Clean up the side-effect database the test created.
        const cleanup = new PgClient({
          host: c.host,
          port: c.port,
          user: c.user,
          password: c.password,
          database: 'postgres',
        });
        await cleanup.connect();
        try {
          await cleanup.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [newDb]
          );
          await cleanup.query(`DROP DATABASE IF EXISTS "${newDb}"`);
        } finally {
          await cleanup.end();
        }
      }
    });
  }, 60_000);
});
