/**
 * PostgreSQL Backup/Restore Service
 *
 * Uses pg_dump and pg_restore CLI tools (not SQL commands).
 * Requires pg_dump/pg_restore to be installed on the machine running Joinery.
 */

import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { Client as PgClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { BackupRequest, RestoreRequest } from '@joinery/shared';
import { IPC_CHANNELS } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { killProcess } from './kill-process';
import { backupDestinationKey, OperationClaims, restoreTargetKey } from './operation-claims';
import { MetadataService } from './metadata';
import { operationProgressEvent } from './operation-progress';
import { createLogger } from '../../utils/logger';
import { ConnectionProfilesStore } from '../config/connection-profiles';
import { buildPgRestoreArgs } from './backup-args';

const log = createLogger('PgBackup');

interface PgBackupOperation {
  id: string;
  type: 'backup' | 'restore';
  cancelled: boolean;
  pid?: number;
  /** Needed to invalidate this connection's database cache once a restore lands (J-51d). */
  connectionId: string;
}

export class PgBackupService extends BaseSingleton {
  private activeOperations: Map<string, PgBackupOperation> = new Map();
  private profileStore: ConnectionProfilesStore;

  constructor() {
    super();
    this.profileStore = ConnectionProfilesStore.getInstance();
  }

  /**
   * Start a PostgreSQL backup using pg_dump.
   * Returns the operationId immediately — the dump runs in the background.
   */
  async startBackup(request: BackupRequest): Promise<string> {
    const operationId = uuidv4();
    const profile = this.profileStore.getById(request.connectionId);
    if (!profile) throw new Error('Connection profile not found');

    const password = await this.profileStore.getPassword(request.connectionId);

    // Before anything is spawned: two dumps to one path corrupt the archive and both report
    // success (J-48f). Throws, which `safeHandle` serialises back to the renderer.
    OperationClaims.getInstance().claim(
      backupDestinationKey(request.backupPath),
      operationId,
      `a backup of ${request.database}`
    );

    const operation: PgBackupOperation = {
      id: operationId,
      type: 'backup',
      cancelled: false,
      connectionId: request.connectionId,
    };
    this.activeOperations.set(operationId, operation);

    const args = [
      '-h',
      profile.server,
      '-p',
      String(profile.port),
      '-U',
      profile.username || 'postgres',
      '-d',
      request.database,
      '-F',
      'c', // custom format (compressed, supports pg_restore)
      '-v', // verbose for progress
      '-f',
      request.backupPath || `/tmp/${request.database}_${Date.now()}.dump`,
    ];

    log.info(`Starting pg_dump for ${request.database} → ${request.backupPath}`);

    const env = { ...process.env };
    if (password) env.PGPASSWORD = password;

    // Fire and forget — run in background, report via IPC events
    this.runProcess(operationId, 'pg_dump', args, env, operation, 'backup');

    return operationId;
  }

  /**
   * Start a PostgreSQL restore using pg_restore.
   * Returns the operationId immediately — the restore runs in the background.
   */
  async startRestore(request: RestoreRequest): Promise<string> {
    const operationId = uuidv4();
    const profile = this.profileStore.getById(request.connectionId);
    if (!profile) throw new Error('Connection profile not found');

    const password = await this.profileStore.getPassword(request.connectionId);

    const targetDb = request.targetDatabase || 'restored_db';

    // Claimed BEFORE the operation is registered: a refused claim throws out of this method, and
    // an entry added first would sit in `activeOperations` forever with nothing to remove it.
    // Two `pg_restore --clean` runs into one database drop objects the other is still writing.
    OperationClaims.getInstance().claim(
      restoreTargetKey(request.connectionId, targetDb),
      operationId,
      `a restore into ${targetDb}`
    );

    const operation: PgBackupOperation = {
      id: operationId,
      type: 'restore',
      cancelled: false,
      connectionId: request.connectionId,
    };
    this.activeOperations.set(operationId, operation);

    const args = buildPgRestoreArgs(
      { server: profile.server, port: profile.port, username: profile.username },
      request,
      targetDb
    );

    log.info(`Starting pg_restore for ${request.backupPath} → ${targetDb}`);

    const env = { ...process.env };
    if (password) env.PGPASSWORD = password;

    // Connection config for the post-restore verify step.
    const verifyConfig = {
      host: profile.server,
      port: profile.port,
      user: profile.username || 'postgres',
      password: password ?? undefined,
    };

    // Fire and forget — run in background, report via IPC events
    this.runProcess(operationId, 'pg_restore', args, env, operation, 'restore', {
      targetDb,
      verifyConfig,
    });

    return operationId;
  }

  /**
   * Spawn a CLI tool in the background and report progress/completion via IPC.
   */
  private runProcess(
    operationId: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    operation: PgBackupOperation,
    type: 'backup' | 'restore',
    verify?: {
      targetDb: string;
      verifyConfig: { host: string; port: number; user: string; password?: string };
    }
  ): void {
    const proc = spawn(command, args, { env });
    operation.pid = proc.pid;

    let stderr = '';

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString();
      stderr += msg;
      this.sendProgress(operationId, type, msg.trim());
    });

    const finishWithVerify = async (claimedSuccess: boolean): Promise<void> => {
      if (!claimedSuccess || !verify) {
        if (claimedSuccess) {
          log.info(`${command} completed (${operationId})`);
          this.onRestored(operation, type);
          this.sendComplete(operationId, type, true);
        }
        return;
      }
      // pg_restore is generous about exit codes (warnings vs errors blur)
      // and we never pass --create — so a missing target db, a wrong
      // host, or a permission gap can all leave the dump's statements
      // un-applied while the CLI still reports a "successful with
      // warnings" path. Pin success to "the target database is actually
      // visible in pg_database after the dust settles."
      try {
        const exists = await this.verifyDatabaseExists(verify.targetDb, verify.verifyConfig);
        if (exists) {
          log.info(`${command} completed successfully → ${verify.targetDb} (${operationId})`);
          this.onRestored(operation, type);
          this.sendComplete(operationId, type, true);
        } else {
          const errMsg =
            `pg_restore exited cleanly but target database "${verify.targetDb}" was not found. ` +
            `Likely causes: target db doesn't exist on the server (pg_restore won't create one without --create), ` +
            `connecting user lacks privilege, or the dump is empty/corrupt. pg_restore stderr: ${stderr.slice(-500) || '(none)'}`;
          log.error(errMsg);
          this.sendComplete(operationId, type, false, errMsg);
        }
      } catch (err) {
        const errMsg = `pg_restore exited cleanly but post-restore verification failed: ${(err as Error).message}`;
        log.error(errMsg);
        this.sendComplete(operationId, type, false, errMsg);
      }
    };

    proc.on('close', code => {
      this.activeOperations.delete(operationId);
      if (operation.cancelled) {
        this.sendComplete(operationId, type, false, `${command} cancelled`);
        return;
      }
      if (code === 0) {
        // Even on a clean exit pg_restore can have done nothing useful
        // (empty dump, --create missing, warnings-only path). Verify if
        // we have a target.
        void finishWithVerify(true);
        return;
      }
      // Non-zero exit. pg_restore returns non-zero for warnings too —
      // historically we treated stderr-without-"ERROR:" as warnings.
      // That regex misses FATAL: messages (e.g. "FATAL: database X does
      // not exist" from a missing target), so widen the failure check.
      const looksLikeRealFailure =
        command !== 'pg_restore' ||
        /\b(ERROR|FATAL|fatal):/i.test(stderr) ||
        /pg_restore:\s*error:/i.test(stderr);
      if (!looksLikeRealFailure) {
        log.info(`${command} completed with warnings (${operationId})`);
        void finishWithVerify(true);
        return;
      }
      const errMsg = `${command} failed with exit code ${code}: ${stderr.slice(-500)}`;
      log.error(errMsg);
      this.sendComplete(operationId, type, false, errMsg);
    });

    proc.on('error', err => {
      this.activeOperations.delete(operationId);
      const errMsg = err.message.includes('ENOENT')
        ? `${command} not found. Please install PostgreSQL client tools.`
        : err.message;
      log.error(`${command} error: ${errMsg}`);
      this.sendComplete(operationId, type, false, errMsg);
    });
  }

  /**
   * Cancel a running backup/restore operation.
   *
   * Returns whether this service owned `operationId`. The cancel channels carry an id and nothing
   * else, so the IPC layer asks each engine in turn — and a cancel that matched nobody has to be
   * distinguishable from one that worked (J-48e / J-51g). Before that, every cancel was routed to
   * the MSSQL service, which does not hold these ids: a Cancel button stopped the readout and left
   * `pg_dump` running.
   */
  cancel(operationId: string): boolean {
    const op = this.activeOperations.get(operationId);
    if (!op) return false;

    op.cancelled = true;
    if (op.pid !== undefined) killProcess(op.pid, operationId);
    return true;
  }

  /**
   * Stop all operations (for app shutdown)
   */
  stopAllOperations(): void {
    // The processes holding these claims are being stopped, so the claims go with them —
    // otherwise a restart-free shutdown path would leave a destination locked (J-48f).
    OperationClaims.getInstance().releaseAll();

    for (const [id, op] of this.activeOperations) {
      op.cancelled = true;
      if (op.pid !== undefined) killProcess(op.pid, id);
      log.info(`Shutdown: stopped PG ${op.type} operation ${id}`);
    }
    this.activeOperations.clear();
  }

  /**
   * Verify a database exists by querying pg_database on a fresh connection.
   * Used by the restore flow to catch the false-positive case where
   * pg_restore exits cleanly but the target database wasn't actually
   * present (empty dump, missing target, no --create flag, etc.).
   */
  private async verifyDatabaseExists(
    name: string,
    config: { host: string; port: number; user: string; password?: string }
  ): Promise<boolean> {
    const client = new PgClient({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: 'postgres', // verify connects to the management db
    });
    await client.connect();
    try {
      const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      return r.rowCount === 1;
    } finally {
      await client.end();
    }
  }

  /**
   * Drop this connection's cached database list after a restore lands (J-51d).
   *
   * `MetadataService.listDatabases` caches for 60s, and only the MSSQL path invalidated it — so a
   * database a restore had just created could stay invisible to `database.list` for a minute.
   * A cache drop, not a query: the side effect is one map deletion.
   */
  private onRestored(operation: PgBackupOperation, type: 'backup' | 'restore'): void {
    if (type !== 'restore') return;
    MetadataService.getInstance().invalidateDatabases(operation.connectionId);
  }

  private sendProgress(operationId: string, type: 'backup' | 'restore', message: string): void {
    const channel =
      type === 'backup' ? IPC_CHANNELS.BACKUP.PROGRESS : IPC_CHANNELS.RESTORE.PROGRESS;
    // Keyed per channel: a restore event carries `restoreId`, which this path never sent (J-51a).
    const progress = operationProgressEvent(type, operationId, {
      status: 'running',
      percentComplete: -1, // indeterminate — CLI tools don't report %
      currentPhase: message,
    });
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send(channel, progress);
    }
  }

  private sendComplete(
    operationId: string,
    type: 'backup' | 'restore',
    success: boolean,
    error?: string
  ): void {
    // Every terminal path in this service comes through here, which is why the claim is released
    // here rather than at each of them: a leaked claim locks the destination for the session.
    OperationClaims.getInstance().release(operationId);

    const channel =
      type === 'backup' ? IPC_CHANNELS.BACKUP.PROGRESS : IPC_CHANNELS.RESTORE.PROGRESS;
    const progress = operationProgressEvent(type, operationId, {
      status: success ? 'completed' : 'failed',
      percentComplete: success ? 100 : 0,
      currentPhase: success ? 'Completed' : 'Failed',
      error,
    });
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send(channel, progress);
    }
  }
}
