/**
 * MySQL Backup/Restore Service
 *
 * Uses mysqldump and mysql CLI tools (not SQL commands).
 * Requires mysqldump/mysql to be installed on the machine running Joinery.
 */

import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import { Transform } from 'stream';
import { BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import mysql from 'mysql2/promise';
import type { BackupRequest, RestoreRequest } from '@joinery/shared';
import { IPC_CHANNELS } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { killProcess } from './kill-process';
import { MetadataService } from './metadata';
import { operationProgressEvent } from './operation-progress';
import { createLogger } from '../../utils/logger';
import { ConnectionProfilesStore } from '../config/connection-profiles';
import { buildMysqlRestorePrelude, resolveReplaceExisting } from './backup-args';

const log = createLogger('MySQLBackup');

interface MySQLBackupOperation {
  id: string;
  type: 'backup' | 'restore';
  cancelled: boolean;
  pid?: number;
  /** Needed to invalidate this connection's database cache once a restore lands (J-51d). */
  connectionId: string;
}

export class MySQLBackupService extends BaseSingleton {
  private activeOperations: Map<string, MySQLBackupOperation> = new Map();
  private profileStore: ConnectionProfilesStore;

  constructor() {
    super();
    this.profileStore = ConnectionProfilesStore.getInstance();
  }

  /**
   * Start a MySQL backup using mysqldump.
   * Returns the operationId immediately — the dump runs in the background
   * and reports progress/completion via IPC events.
   */
  async startBackup(request: BackupRequest): Promise<string> {
    const operationId = uuidv4();
    const profile = this.profileStore.getById(request.connectionId);
    if (!profile) throw new Error('Connection profile not found');

    const password = await this.profileStore.getPassword(request.connectionId);

    const operation: MySQLBackupOperation = {
      id: operationId,
      type: 'backup',
      cancelled: false,
      connectionId: request.connectionId,
    };
    this.activeOperations.set(operationId, operation);

    const backupPath = request.backupPath || `/tmp/${request.database}_${Date.now()}.sql`;

    // Build args with minimal privilege requirements. The key challenge is that
    // --single-transaction does a FLUSH TABLES WITH READ LOCK on some versions,
    // which requires RELOAD privilege that many managed DB users don't have.
    // Instead we use --skip-lock-tables + --skip-opt + --create-options to get
    // a clean dump without requiring RELOAD, PROCESS, or SUPER privileges.
    const args = [
      '-h',
      profile.server,
      '-P',
      String(profile.port),
      '-u',
      profile.username || 'root',
      '--skip-opt',
      '--create-options',
      '--add-drop-table',
      '--set-charset',
      '--extended-insert',
      '--quick',
      '--triggers',
      '--no-tablespaces',
      '--set-gtid-purged=OFF',
      '--column-statistics=0',
      '--result-file',
      backupPath,
      request.database,
    ];

    log.info(`Starting mysqldump for ${request.database} → ${backupPath}`);

    const env = { ...process.env };
    if (password) env.MYSQL_PWD = password;

    // Fire and forget — run in background, report via IPC events
    this.runBackupProcess(operationId, request.database, args, env, operation);

    return operationId;
  }

  private runBackupProcess(
    operationId: string,
    database: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    operation: MySQLBackupOperation
  ): void {
    const proc = spawn('mysqldump', args, { env });
    operation.pid = proc.pid;

    let stderr = '';

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString();
      stderr += msg;
      this.sendProgress(operationId, 'backup', msg.trim());
    });

    proc.on('close', code => {
      this.activeOperations.delete(operationId);
      if (operation.cancelled) {
        this.sendComplete(operationId, 'backup', false, 'Backup cancelled');
      } else if (code === 0) {
        log.info(`mysqldump completed successfully for ${database}`);
        this.sendComplete(operationId, 'backup', true);
      } else {
        const errMsg = `mysqldump failed with exit code ${code}: ${stderr.slice(-500)}`;
        log.error(errMsg);
        this.sendComplete(operationId, 'backup', false, errMsg);
      }
    });

    proc.on('error', err => {
      this.activeOperations.delete(operationId);
      const errMsg = err.message.includes('ENOENT')
        ? 'mysqldump not found. Please install MySQL client tools.'
        : err.message;
      log.error(`mysqldump error: ${errMsg}`);
      this.sendComplete(operationId, 'backup', false, errMsg);
    });
  }

  /**
   * Start a MySQL restore by piping a SQL file to the mysql CLI.
   * Returns the operationId immediately — the restore runs in the background.
   */
  async startRestore(request: RestoreRequest): Promise<string> {
    const operationId = uuidv4();
    const profile = this.profileStore.getById(request.connectionId);
    if (!profile) throw new Error('Connection profile not found');

    const password = await this.profileStore.getPassword(request.connectionId);

    const operation: MySQLBackupOperation = {
      id: operationId,
      type: 'restore',
      cancelled: false,
      connectionId: request.connectionId,
    };
    this.activeOperations.set(operationId, operation);

    const targetDb = request.targetDatabase || 'restored_db';

    // Validate the target db name: backtick-quoting alone isn't enough
    // because the value reaches the CLI both as a SQL identifier (in the
    // CREATE DATABASE we prepend) and a positional arg path. Only allow
    // names that are safe in both contexts; anything else suggests a typo
    // or an attempt to inject. MySQL identifiers permit much more, but
    // this is a Joinery-managed flow with a freshly-typed value — we can
    // afford to be conservative.
    if (!/^[A-Za-z0-9_]+$/.test(targetDb)) {
      throw new Error(
        `Invalid target database name "${targetDb}". Use letters, digits, and underscores only.`
      );
    }

    // Don't pass targetDb as a positional arg — the mysql CLI verifies it
    // exists at connect time and errors out (ERROR 1049 (42000): Unknown
    // database 'X') when the user is restoring into a *new* database. We
    // connect without a default database and prepend CREATE DATABASE IF
    // NOT EXISTS + USE statements to the dump stream so the target is
    // created (or reused) on the fly.
    const args = [
      '-h',
      profile.server,
      '-P',
      String(profile.port),
      '-u',
      profile.username || 'root',
    ];

    log.info(`Starting mysql restore for ${request.backupPath} → ${targetDb}`);

    const env = { ...process.env };
    if (password) env.MYSQL_PWD = password;

    // Connection config we'll re-use for the post-restore verify step.
    const verifyConfig = {
      host: profile.server,
      port: profile.port,
      user: profile.username || 'root',
      password: password ?? undefined,
    };

    // Fire and forget — run in background, report via IPC events
    this.runRestoreProcess(
      operationId,
      targetDb,
      request.backupPath,
      args,
      env,
      operation,
      verifyConfig,
      resolveReplaceExisting(request)
    );

    return operationId;
  }

  /**
   * Create a transform stream that strips SQL statements requiring SUPER privilege.
   * Dump files from managed MySQL instances (RDS, Cloud SQL, etc.) often contain
   * SET @@SESSION.SQL_LOG_BIN, SET @@GLOBAL.GTID_PURGED, and similar statements
   * that fail without SUPER or SYSTEM_VARIABLES_ADMIN privileges.
   */
  private createPrivilegeFilter(): Transform {
    let buffer = '';
    return new Transform({
      transform(chunk, _encoding, callback) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        // Keep the last partial line in the buffer
        buffer = lines.pop() || '';
        const filtered =
          lines
            .filter(line => {
              const trimmed = line.trimStart();
              return (
                !trimmed.startsWith('SET @@SESSION.SQL_LOG_BIN') &&
                !trimmed.startsWith('SET @@GLOBAL.GTID_PURGED') &&
                !trimmed.startsWith('SET @@GLOBAL.gtid_purged')
              );
            })
            .join('\n') + '\n';
        callback(null, filtered);
      },
      flush(callback) {
        if (buffer) callback(null, buffer);
        else callback();
      },
    });
  }

  private runRestoreProcess(
    operationId: string,
    targetDb: string,
    backupPath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    operation: MySQLBackupOperation,
    verifyConfig: {
      host: string;
      port: number;
      user: string;
      password?: string;
    },
    replace: boolean
  ): void {
    const proc = spawn('mysql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    operation.pid = proc.pid;

    let stderr = '';

    // Prepend a prelude so the dump runs against a guaranteed-to-exist target.
    // When replacing, the existing database is dropped first so the dump lands
    // in a clean schema. targetDb has been validated by startRestore to match
    // /^[A-Za-z0-9_]+$/, so backtick-quoting alone is safe here. Writing this
    // synchronously to stdin before piping the dump ensures the prelude
    // reaches mysql first.
    proc.stdin.write(buildMysqlRestorePrelude(targetDb, replace));

    // Pipe the SQL file through a filter that strips SUPER-privilege statements
    const fileStream = createReadStream(backupPath);
    const filter = this.createPrivilegeFilter();
    fileStream.pipe(filter).pipe(proc.stdin);

    fileStream.on('error', err => {
      this.activeOperations.delete(operationId);
      const errMsg = `Failed to read backup file: ${err.message}`;
      log.error(errMsg);
      this.sendComplete(operationId, 'restore', false, errMsg);
    });

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString();
      stderr += msg;
      this.sendProgress(operationId, 'restore', msg.trim());
    });

    proc.on('close', code => {
      this.activeOperations.delete(operationId);
      if (operation.cancelled) {
        this.sendComplete(operationId, 'restore', false, 'Restore cancelled');
        return;
      }
      if (code !== 0) {
        const errMsg = `mysql restore failed with exit code ${code}: ${stderr.slice(-500)}`;
        log.error(errMsg);
        this.sendComplete(operationId, 'restore', false, errMsg);
        return;
      }
      // mysql exited 0, but that's not enough to claim success on its own.
      // Failure modes that all yield exit 0:
      //   - Empty / trivial dump (mysql ran zero meaningful statements; the
      //     prepended CREATE DATABASE may have been silently rejected).
      //   - User lacks CREATE DATABASE privilege; mysql's batch mode may
      //     continue past errors depending on flags, leaving target absent.
      //   - mysql connected but the prelude write was lost in some pipe
      //     timing / version-specific quirk we don't control.
      // Verify the target database actually exists before reporting success.
      this.verifyDatabaseExists(targetDb, verifyConfig)
        .then(exists => {
          if (exists) {
            log.info(`mysql restore completed successfully → ${targetDb}`);
            // The piped prelude creates the target here, so unlike PostgreSQL nothing else
            // invalidates the cached list — a restored database stayed invisible for 60s (J-51d).
            MetadataService.getInstance().invalidateDatabases(operation.connectionId);
            this.sendComplete(operationId, 'restore', true);
          } else {
            const errMsg =
              `mysql exited 0 but target database "${targetDb}" was not created. ` +
              `Likely causes: empty/invalid dump file, or the connecting user lacks ` +
              `CREATE privilege. mysql stderr: ${stderr.slice(-500) || '(none)'}`;
            log.error(errMsg);
            this.sendComplete(operationId, 'restore', false, errMsg);
          }
        })
        .catch(err => {
          const errMsg = `mysql exited 0 but post-restore verification failed: ${(err as Error).message}`;
          log.error(errMsg);
          this.sendComplete(operationId, 'restore', false, errMsg);
        });
    });

    proc.on('error', err => {
      this.activeOperations.delete(operationId);
      const errMsg = err.message.includes('ENOENT')
        ? 'mysql client not found. Please install MySQL client tools.'
        : err.message;
      log.error(`mysql restore error: ${errMsg}`);
      this.sendComplete(operationId, 'restore', false, errMsg);
    });
  }

  /**
   * Verify a database exists by querying information_schema.SCHEMATA on a
   * fresh connection. Used by the restore flow to catch the false-positive
   * case where mysql CLI exits 0 but the target database wasn't actually
   * created (empty dump, privilege error, prelude write lost, etc.).
   */
  private async verifyDatabaseExists(
    name: string,
    config: { host: string; port: number; user: string; password?: string }
  ): Promise<boolean> {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
    });
    try {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [name]
      );
      return rows.length === 1;
    } finally {
      await conn.end();
    }
  }

  /**
   * Cancel a running backup/restore operation.
   *
   * Returns whether this service owned `operationId` — the cancel channels carry an id and nothing
   * else, so the IPC layer asks each engine in turn (J-48e / J-51g).
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
    for (const [id, op] of this.activeOperations) {
      op.cancelled = true;
      if (op.pid !== undefined) killProcess(op.pid, id);
      log.info(`Shutdown: stopped MySQL ${op.type} operation ${id}`);
    }
    this.activeOperations.clear();
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
