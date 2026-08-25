/**
 * Backup IPC Handlers
 *
 * SQL Server: uses BACKUP/RESTORE DATABASE T-SQL commands
 * PostgreSQL: uses pg_dump/pg_restore CLI tools
 * MySQL: uses mysqldump/mysql CLI tools
 */

import { IPC_CHANNELS } from '@joinery/shared';
import type {
  BackupRequest,
  BackupFileInfo,
  CliDepsResult,
  CliEngine,
  RestoreRequest,
} from '@joinery/shared';
import { BackupRestoreService } from '../services/sql/backup-restore';
import { PgBackupService } from '../services/sql/pg-backup';
import { MySQLBackupService } from '../services/sql/mysql-backup';
import { CliDepsService } from '../services/sql/cli-deps';
import { ServerFilesystemService } from '../services/sql/server-filesystem';
import { ConnectionPoolManager } from '../services/sql/connection-pool';
import { safeHandle } from './safe-handle';
import { createLogger } from '../utils/logger';

const log = createLogger('BackupIPC');

function getEngine(connectionId: string): string {
  return ConnectionPoolManager.getInstance().getEngineForProfile(connectionId);
}

/**
 * Route a cancel to whichever engine owns the operation (J-48e / J-51g).
 *
 * The cancel channels carry an operation id and nothing else — no connection, so no engine — and
 * both used to call the MSSQL service unconditionally. It does not hold the PostgreSQL or MySQL
 * ids, so a cancel there stopped the progress readout and left `pg_dump` or `mysqldump` running to
 * completion. Each service now reports whether the id was its own, so asking all three is exact
 * rather than a guess, and a cancel that matched nobody is logged instead of reported as success.
 */
export async function cancelOperation(
  services: {
    readonly mssql: BackupRestoreService;
    readonly pg: PgBackupService;
    readonly mysql: MySQLBackupService;
  },
  operationId: string
): Promise<void> {
  if (services.pg.cancel(operationId)) return;
  if (services.mysql.cancel(operationId)) return;
  if (await services.mssql.cancel(operationId)) return;

  log.warn(`Cancel requested for unknown operation ${operationId}: nothing was running under it.`);
}

export function registerBackupHandlers(): void {
  const backupService = BackupRestoreService.getInstance();
  const pgBackupService = PgBackupService.getInstance();
  const mysqlBackupService = MySQLBackupService.getInstance();
  const cliDeps = CliDepsService.getInstance();
  const serverFs = new ServerFilesystemService();

  // CLI tool probe — renderer queries this before opening the
  // backup/restore form on PG/MySQL. CHECK_TOOLS is cached;
  // RECHECK_TOOLS forces a fresh probe (after the user installs).
  safeHandle(
    IPC_CHANNELS.BACKUP.CHECK_TOOLS,
    async (_event, engine: CliEngine): Promise<CliDepsResult> => cliDeps.checkDeps(engine)
  );
  safeHandle(
    IPC_CHANNELS.BACKUP.RECHECK_TOOLS,
    async (_event, engine: CliEngine): Promise<CliDepsResult> => cliDeps.recheck(engine)
  );

  // Start backup — routes to correct provider
  safeHandle(IPC_CHANNELS.BACKUP.START, async (_event, request: BackupRequest): Promise<string> => {
    const engine = getEngine(request.connectionId);
    if (engine === 'postgresql') return pgBackupService.startBackup(request);
    if (engine === 'mysql') return mysqlBackupService.startBackup(request);
    return backupService.startBackup(request);
  });

  // Cancel backup
  const cancelServices = {
    mssql: backupService,
    pg: pgBackupService,
    mysql: mysqlBackupService,
  };

  safeHandle(IPC_CHANNELS.BACKUP.CANCEL, async (_event, operationId: string): Promise<void> => {
    await cancelOperation(cancelServices, operationId);
  });

  // Read backup info (MSSQL only — PG uses file headers)
  safeHandle(
    IPC_CHANNELS.RESTORE.READ_INFO,
    async (_event, connectionId: string, path: string): Promise<BackupFileInfo> => {
      const engine = getEngine(connectionId);
      if (engine === 'postgresql') {
        return {
          databaseName:
            path
              .split('/')
              .pop()
              ?.replace(/\.dump$/, '') || 'unknown',
        } as BackupFileInfo;
      }
      if (engine === 'mysql') {
        return {
          databaseName:
            path
              .split('/')
              .pop()
              ?.replace(/\.sql$/, '') || 'unknown',
        } as BackupFileInfo;
      }
      return backupService.readBackupInfo(connectionId, path);
    }
  );

  // Get file list from backup (MSSQL only)
  safeHandle(
    IPC_CHANNELS.RESTORE.GET_FILE_LIST,
    async (
      _event,
      connectionId: string,
      backupPath: string
    ): Promise<{ logicalName: string; physicalName: string; type: string }[]> => {
      const engine = getEngine(connectionId);
      if (engine === 'postgresql' || engine === 'mysql') {
        return []; // PG/MySQL dump formats don't have logical file mapping
      }
      return backupService.getFileList(connectionId, backupPath);
    }
  );

  // Start restore — routes to correct provider
  safeHandle(
    IPC_CHANNELS.RESTORE.START,
    async (_event, request: RestoreRequest): Promise<string> => {
      const engine = getEngine(request.connectionId);
      if (engine === 'postgresql') return pgBackupService.startRestore(request);
      if (engine === 'mysql') return mysqlBackupService.startRestore(request);
      return backupService.startRestore(request);
    }
  );

  // Cancel restore
  safeHandle(IPC_CHANNELS.RESTORE.CANCEL, async (_event, operationId: string): Promise<void> => {
    await cancelOperation(cancelServices, operationId);
  });

  // Get backup history (MSSQL only — PG has no backup metadata tables)
  safeHandle(
    IPC_CHANNELS.BACKUP.GET_HISTORY,
    async (_event, connectionId: string, databaseName?: string) => {
      const engine = getEngine(connectionId);
      if (engine === 'postgresql' || engine === 'mysql') {
        return []; // PG/MySQL don't store backup history in system tables
      }
      return serverFs.getBackupHistory(connectionId, databaseName);
    }
  );

  // Get backup info (header info from backup file)
  safeHandle(
    IPC_CHANNELS.RESTORE.GET_BACKUP_INFO,
    async (_event, connectionId: string, backupPath: string): Promise<BackupFileInfo | null> => {
      const engine = getEngine(connectionId);

      // Only MSSQL has a backup header to read. PostgreSQL and MySQL used to get
      // `{ databaseName } as BackupFileInfo` — a cast over an object whose every other field was
      // `undefined` at runtime while the type promised otherwise, so any UI rendering
      // `backupType` or `backupSizeBytes` printed "undefined". `null` says the same thing without
      // lying about it (J-51e); the filename guess it carried was never the file's own metadata.
      if (engine === 'postgresql' || engine === 'mysql') return null;

      return backupService.readBackupInfo(connectionId, backupPath);
    }
  );
}
