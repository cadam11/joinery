/**
 * A post-restore metadata-cache refresh must never fail a restore that worked (J-195).
 *
 * Both CLI restore services end the same way: verify the target database is
 * really there, then drop this connection's cached database list so the newly
 * restored database shows up before the 60s TTL expires (J-51d). The cache drop
 * sat *inside* the same `try` / `.catch()` as the verification, so a throw from
 * `MetadataService.getInstance()` — which lazily constructs the pool manager,
 * the SSH tunnel manager and the credential store — was reported to the user as
 * `"pg_restore exited cleanly but post-restore verification failed: …"` and the
 * restore was marked failed, for a restore that had succeeded *and* verified.
 *
 * The double for that throw is the real failure mode, not an invented one:
 * `MetadataService.getInstance()` is `BaseSingleton.getInstance`, which
 * constructs on first call (`utils/singleton.ts:22-31`), and
 * `MetadataService`'s constructor calls `ConnectionPoolManager.getInstance()`
 * (`metadata.ts:109-111`) whose chain reads Electron's `app`. Spying the real
 * static reproduces exactly that, with the message the round-trip integration
 * tier prints today.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from '@joinery/shared';

/* eslint-disable @typescript-eslint/no-explicit-any -- the child-process and IPC doubles below
   stand in for shapes (`ChildProcess`, `webContents.send`) whose real types are far wider than the
   three members the services touch; typing them fully would be fiction, not safety. */

const spawnCalls = vi.hoisted(() => [] as Array<{ command: string; proc: any }>);
const ipcEvents = vi.hoisted(() => [] as Array<{ channel: string; payload: any }>);

// Only the members `runProcess` / `runRestoreProcess` actually touch: `pid`, a
// `stderr` that emits `'data'`, a `'close'` / `'error'` emitter, and (MySQL
// only) a writable `stdin` the dump is piped into. `stdin` is a real
// `PassThrough` in flowing mode so the pipe drains instead of stalling.
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    spawn: (command: string) => {
      const proc: any = new EventEmitter();
      proc.pid = 4242;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdin.resume();
      spawnCalls.push({ command, proc });
      return proc;
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: any) => {
            ipcEvents.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

vi.mock('../config/connection-profiles', () => ({
  ConnectionProfilesStore: {
    getInstance: () => ({
      getById: (id: string) => ({
        id,
        name: 'local',
        engine: 'postgresql',
        server: '127.0.0.1',
        port: 5432,
        username: 'joinery',
        authenticationType: 'sql',
        encrypt: false,
        trustServerCertificate: false,
        connectionTimeout: 15,
      }),
      getPassword: async () => 'hunter2',
    }),
  },
}));

// The point of these tests is what happens *after* verification passes, so both
// checks answer `true` — the same `Promise<boolean>` the real functions return.
vi.mock('./restore-verify', () => ({
  pgDatabaseExists: vi.fn(async () => true),
  mysqlDatabaseExists: vi.fn(async () => true),
}));

import { onLogEntry } from '../../utils/logger';
import { MetadataService } from './metadata';
import { pgDatabaseExists } from './restore-verify';
import { MySQLBackupService } from './mysql-backup';
import { PgBackupService } from './pg-backup';

const REFRESH_FAILURE = 'No "app" export is defined on the "electron" mock';

/** Resolve once the service reports the operation terminal. Bounded, like every poll here. */
async function waitForOperation(
  operationId: string
): Promise<{ success: boolean; error?: string }> {
  const POLL_MS = 10;
  const MAX_ITER = 200;
  for (let i = 0; i < MAX_ITER; i++) {
    const hit = ipcEvents.find(
      e =>
        e.payload?.operationId === operationId &&
        (e.payload?.status === 'completed' || e.payload?.status === 'failed')
    );
    if (hit) return { success: hit.payload.status === 'completed', error: hit.payload.error };
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for operation ${operationId}`);
}

/** Collect log entries for the duration of `run`, and always unsubscribe. */
async function withLogCapture<T>(run: () => Promise<T>): Promise<{ result: T; log: LogEntry[] }> {
  const log: LogEntry[] = [];
  const off = onLogEntry(entry => log.push(entry));
  try {
    return { result: await run(), log };
  } finally {
    off();
  }
}

describe('post-restore metadata refresh (J-195)', () => {
  let dumpDir: string;
  let dumpPath: string;

  beforeAll(async () => {
    dumpDir = await mkdtemp(join(tmpdir(), 'joinery-j195-'));
    dumpPath = join(dumpDir, 'dump.sql');
    await writeFile(dumpPath, 'SELECT 1;\n', 'utf8');
  });

  afterAll(async () => {
    await rm(dumpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    spawnCalls.length = 0;
    ipcEvents.length = 0;
    PgBackupService.resetInstance();
    MySQLBackupService.resetInstance();
    vi.spyOn(MetadataService, 'getInstance').mockImplementation(() => {
      throw new Error(REFRESH_FAILURE);
    });
  });

  it('reports a verified PostgreSQL restore as successful when the refresh throws', async () => {
    const { result, log } = await withLogCapture(async () => {
      const operationId = await PgBackupService.getInstance().startRestore({
        connectionId: 'conn-pg',
        backupPath: dumpPath,
        targetDatabase: 'pg_target',
      });
      spawnCalls.at(-1)?.proc.emit('close', 0);
      return waitForOperation(operationId);
    });

    expect(result).toEqual({ success: true, error: undefined });
    expect(log.some(e => e.level === 'error' && e.message.includes(REFRESH_FAILURE))).toBe(true);
  });

  it('reports a verified MySQL restore as successful when the refresh throws', async () => {
    const { result, log } = await withLogCapture(async () => {
      const operationId = await MySQLBackupService.getInstance().startRestore({
        connectionId: 'conn-mysql',
        backupPath: dumpPath,
        targetDatabase: 'mysql_target',
      });
      spawnCalls.at(-1)?.proc.emit('close', 0);
      return waitForOperation(operationId);
    });

    expect(result).toEqual({ success: true, error: undefined });
    expect(log.some(e => e.level === 'error' && e.message.includes(REFRESH_FAILURE))).toBe(true);
  });

  it('still fails a PostgreSQL restore when the verification itself throws', async () => {
    vi.mocked(pgDatabaseExists).mockRejectedValueOnce(new Error('connection refused'));

    const operationId = await PgBackupService.getInstance().startRestore({
      connectionId: 'conn-pg',
      backupPath: dumpPath,
      targetDatabase: 'pg_target_2',
    });
    spawnCalls.at(-1)?.proc.emit('close', 0);

    const result = await waitForOperation(operationId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('post-restore verification failed: connection refused');
  });
});
