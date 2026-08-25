/**
 * Backup and Restore Service
 * Handles database backup and restore operations with progress tracking
 */

import { v4 as uuidv4 } from 'uuid';
import { BrowserWindow } from 'electron';
import type {
  BackupRequest,
  BackupProgress,
  BackupResult,
  BackupFileInfo,
  BackupLogicalFile,
  RestoreRequest,
  RestoreProgress,
  RestoreResult,
} from '@joinery/shared';
import { IPC_CHANNELS } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { TsqlBuilder } from '../../utils/tsql-builder';
import { createLogger } from '../../utils/logger';
import { ConnectionPoolManager } from './connection-pool';
import { MetadataService } from './metadata';
import { resolveReplaceExisting } from './backup-args';

const log = createLogger('BackupRestore');

interface ActiveOperation {
  operationId: string;
  type: 'backup' | 'restore';
  connectionId: string;
  startTime: number;
  cancelled: boolean;
  progressInterval?: NodeJS.Timeout;
}

export class BackupRestoreService extends BaseSingleton {
  private poolManager: ConnectionPoolManager;
  private metadataService: MetadataService;
  private activeOperations: Map<string, ActiveOperation> = new Map();

  constructor() {
    super();
    this.poolManager = ConnectionPoolManager.getInstance();
    this.metadataService = MetadataService.getInstance();
  }

  /**
   * Start a backup operation
   */
  async startBackup(request: BackupRequest): Promise<string> {
    const operationId = request.backupId || uuidv4();
    const startTime = Date.now();

    // Track operation
    const operation: ActiveOperation = {
      operationId,
      type: 'backup',
      connectionId: request.connectionId,
      startTime,
      cancelled: false,
    };
    this.activeOperations.set(operationId, operation);

    // Generate T-SQL
    const tsql = TsqlBuilder.backup({
      databaseName: request.database,
      destinationPath: request.backupPath,
      backupType: request.backupType,
      compression: request.compression ?? false,
      // Both of these reached the builder and were dropped on the floor before J-48: `checksum`
      // arrived as a `verify` the builder never read, and `copyOnly` was read by nothing anywhere.
      checksum: request.checksum ?? false,
      copyOnly: request.copyOnly ?? false,
      description: request.description,
    });

    // Start progress monitoring
    this.startProgressMonitoring(operation, 'backup');

    // Execute backup in background
    this.executeBackup(operationId, request, tsql);

    return operationId;
  }

  /**
   * Execute the backup operation
   */
  private async executeBackup(
    operationId: string,
    request: BackupRequest,
    tsql: string
  ): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    try {
      await this.poolManager.batch(request.connectionId, tsql);

      // Get file size (approximate from database size)
      const databases = await this.metadataService.listDatabases(request.connectionId);
      const db = databases.find(d => d.name === request.database);
      const sizeBytes = db?.sizeBytes || 0;

      // Send completed progress first so dialog knows we're done
      this.sendToRenderer(IPC_CHANNELS.BACKUP.PROGRESS, {
        backupId: operationId,
        status: 'completed',
        percentComplete: 100,
        currentPhase: 'Completed',
        elapsedMs: Date.now() - operation.startTime,
      } as BackupProgress);

      const result: BackupResult = {
        operationId,
        success: true,
        filePath: request.backupPath,
        sizeBytes,
        durationMs: Date.now() - operation.startTime,
        tsql,
      };

      this.sendToRenderer(IPC_CHANNELS.BACKUP.COMPLETE, result);
    } catch (error) {
      const err = error as Error;
      // Send failed progress first
      this.sendToRenderer(IPC_CHANNELS.BACKUP.PROGRESS, {
        backupId: operationId,
        status: 'failed',
        percentComplete: 0,
        error: err.message,
        currentPhase: 'Failed',
      } as BackupProgress);

      this.sendToRenderer(IPC_CHANNELS.BACKUP.ERROR, {
        operationId,
        error: err.message,
      });
    } finally {
      this.stopOperation(operationId);
    }
  }

  /**
   * Read backup file information
   */
  async readBackupInfo(connectionId: string, path: string): Promise<BackupFileInfo> {
    try {
      // Get file list
      const fileListSql = TsqlBuilder.getBackupFileInfo(path);
      const fileListResult = await this.poolManager.query<BackupLogicalFile>(
        connectionId,
        fileListSql
      );

      // Get header info
      const headerSql = TsqlBuilder.getBackupHeaderInfo(path);
      const headerResult = await this.poolManager.query<{
        DatabaseName: string;
        BackupType: number;
        BackupFinishDate: Date;
        BackupSize: number;
        CompressedBackupSize: number;
        ServerName: string;
        CompatibilityLevel: number;
        Collation: string;
        RecoveryModel: string;
        BackupDescription: string | null;
      }>(connectionId, headerSql);

      const header = headerResult.recordset?.[0];
      if (!header) {
        throw new Error('Could not read backup header — the file may be corrupt or inaccessible.');
      }

      const files = fileListResult.recordset.map(f => ({
        logicalName: f.logicalName,
        physicalName: f.physicalName,
        type: f.type as 'D' | 'L',
        fileType: f.type as 'D' | 'L',
        fileGroupName: f.fileGroupName,
        sizeBytes: Number(f.sizeBytes) || 0,
      }));

      // Get backup type string
      const backupTypeMap: Record<number, string> = {
        1: 'Full',
        2: 'Transaction Log',
        5: 'Differential',
      };

      const backupDateStr = header.BackupFinishDate?.toISOString() || new Date().toISOString();
      return {
        databaseName: header.DatabaseName || 'Unknown',
        backupType: backupTypeMap[header.BackupType || 1] || 'Unknown',
        backupDate: backupDateStr,
        backupFinishDate: backupDateStr,
        backupSizeBytes: Number(header.BackupSize) || 0,
        compressedSizeBytes: Number(header.CompressedBackupSize) || 0,
        serverVersion: '',
        serverName: header.ServerName || 'Unknown',
        recoveryModel: header.RecoveryModel || 'FULL',
        compatibilityLevel: header.CompatibilityLevel || 150,
        collation: header.Collation || '',
        files,
        description: header.BackupDescription || undefined,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to read backup file info';
      throw new Error(`Error reading backup info: ${message}`);
    }
  }

  /**
   * Get file list from backup
   */
  async getFileList(
    connectionId: string,
    backupPath: string
  ): Promise<{ logicalName: string; physicalName: string; type: string }[]> {
    try {
      const fileListSql = TsqlBuilder.getBackupFileInfo(backupPath);
      const result = await this.poolManager.query<{
        LogicalName: string;
        PhysicalName: string;
        Type: string;
      }>(connectionId, fileListSql);

      return result.recordset.map(f => ({
        logicalName: f.LogicalName,
        physicalName: f.PhysicalName,
        type: f.Type,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to read backup file list';
      throw new Error(`Error reading file list: ${message}`);
    }
  }

  /**
   * Start a restore operation
   */
  async startRestore(request: RestoreRequest): Promise<string> {
    const operationId = request.restoreId || uuidv4();
    const startTime = Date.now();

    // Track operation
    const operation: ActiveOperation = {
      operationId,
      type: 'restore',
      connectionId: request.connectionId,
      startTime,
      cancelled: false,
    };
    this.activeOperations.set(operationId, operation);

    // Convert file relocations to file moves
    const fileMoves = (request.fileRelocations || [])
      .filter(r => r.physicalName || r.newPath)
      .map(r => ({
        logicalName: r.logicalName,
        destinationPath: r.physicalName || r.newPath || '',
      }));

    // Determine target database name - use provided name or fall back to reading from backup
    const targetDbName = request.targetDatabase || 'RestoredDatabase';

    // Generate T-SQL
    const tsql = TsqlBuilder.restore({
      sourcePath: request.backupPath,
      targetDatabaseName: targetDbName,
      overwriteExisting: resolveReplaceExisting(request),
      fileMoves,
      recoveryState: (request.recoveryState?.toLowerCase() ||
        (request.withNoRecovery ? 'norecovery' : 'recovery')) as
        'recovery' | 'norecovery' | 'standby',
    });

    // Start progress monitoring
    this.startProgressMonitoring(operation, 'restore');

    // Execute restore in background
    this.executeRestore(operationId, request, tsql);

    return operationId;
  }

  /**
   * Execute the restore operation
   */
  private async executeRestore(
    operationId: string,
    request: RestoreRequest,
    tsql: string
  ): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    try {
      // RESTORE … WITH REPLACE needs exclusive access to the target database.
      // If Joinery has it open (explorer node expanded or a query window on it),
      // our own pool holds connections that make SQL Server refuse with
      // "Exclusive access could not be obtained because the database is in
      // use." Release our grip first; the pool reconnects lazily afterward.
      if (resolveReplaceExisting(request) && request.targetDatabase) {
        await this.poolManager.closePoolForDatabase(request.connectionId, request.targetDatabase);
      }

      await this.poolManager.batch(request.connectionId, tsql);

      // Invalidate database cache
      this.metadataService.invalidateDatabases(request.connectionId);

      // Send completed progress first so dialog knows we're done
      this.sendToRenderer(IPC_CHANNELS.RESTORE.PROGRESS, {
        restoreId: operationId,
        status: 'completed',
        percentComplete: 100,
        currentPhase: 'Completed',
        elapsedMs: Date.now() - operation.startTime,
      } as RestoreProgress);

      const result: RestoreResult = {
        operationId,
        success: true,
        databaseName: request.targetDatabase || 'RestoredDatabase',
        durationMs: Date.now() - operation.startTime,
        tsql,
      };

      this.sendToRenderer(IPC_CHANNELS.RESTORE.COMPLETE, result);
    } catch (error) {
      const err = error as Error;
      // Send failed progress first
      this.sendToRenderer(IPC_CHANNELS.RESTORE.PROGRESS, {
        restoreId: operationId,
        status: 'failed',
        percentComplete: 0,
        error: err.message,
        currentPhase: 'Failed',
      } as RestoreProgress);

      this.sendToRenderer(IPC_CHANNELS.RESTORE.ERROR, {
        operationId,
        error: err.message,
      });
    } finally {
      this.stopOperation(operationId);
    }
  }

  /**
   * Cancel an operation
   */
  async cancel(operationId: string): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (operation) {
      operation.cancelled = true;
      // Note: Actual cancellation of backup/restore is complex
      // For now, we just mark it cancelled
    }
  }

  /**
   * Start progress monitoring for an operation
   */
  private startProgressMonitoring(operation: ActiveOperation, type: 'backup' | 'restore'): void {
    // Poll for progress every 2 seconds
    operation.progressInterval = setInterval(async () => {
      if (operation.cancelled) {
        this.stopOperation(operation.operationId);
        return;
      }

      try {
        const progress = await this.getOperationProgress(operation, type);
        const channel =
          type === 'backup' ? IPC_CHANNELS.BACKUP.PROGRESS : IPC_CHANNELS.RESTORE.PROGRESS;
        this.sendToRenderer(channel, progress);
      } catch (err) {
        log.warn(`Progress poll error for ${operation.operationId}:`, err);
      }
    }, 2000);
  }

  /**
   * Get progress of an operation from SQL Server
   */
  private async getOperationProgress(
    operation: ActiveOperation,
    type: 'backup' | 'restore'
  ): Promise<BackupProgress | RestoreProgress> {
    const sql = `
      SELECT
        percent_complete,
        estimated_completion_time
      FROM sys.dm_exec_requests
      WHERE command LIKE '%BACKUP%' OR command LIKE '%RESTORE%'
      ORDER BY start_time DESC;
    `;

    try {
      const result = await this.poolManager.query<{
        percent_complete: number;
        estimated_completion_time: number;
      }>(operation.connectionId, sql);

      const row = result.recordset[0];
      const percentComplete = row?.percent_complete || 0;
      const estimatedMs = row?.estimated_completion_time || 0;
      const elapsedMs = Date.now() - operation.startTime;
      const status = percentComplete >= 100 ? 'completed' : 'running';

      if (type === 'backup') {
        return {
          backupId: operation.operationId,
          status,
          percentComplete,
          processedBytes: 0,
          totalBytes: 0,
          elapsedMs,
          estimatedRemainingMs: estimatedMs,
          currentPhase: percentComplete < 100 ? 'Processing' : 'Completing',
        } as BackupProgress;
      } else {
        return {
          restoreId: operation.operationId,
          status,
          percentComplete,
          processedBytes: 0,
          totalBytes: 0,
          elapsedMs,
          estimatedRemainingMs: estimatedMs,
          currentPhase: percentComplete < 100 ? 'Processing' : 'Completing',
        } as RestoreProgress;
      }
    } catch {
      // Return default progress if query fails
      if (type === 'backup') {
        return {
          backupId: operation.operationId,
          status: 'running',
          percentComplete: 0,
          processedBytes: 0,
          totalBytes: 0,
          elapsedMs: Date.now() - operation.startTime,
          currentPhase: 'Processing',
        } as BackupProgress;
      } else {
        return {
          restoreId: operation.operationId,
          status: 'running',
          percentComplete: 0,
          processedBytes: 0,
          totalBytes: 0,
          elapsedMs: Date.now() - operation.startTime,
          currentPhase: 'Processing',
        } as RestoreProgress;
      }
    }
  }

  /**
   * Stop an operation and cleanup
   */
  private stopOperation(operationId: string): void {
    const operation = this.activeOperations.get(operationId);
    if (operation) {
      if (operation.progressInterval) {
        clearInterval(operation.progressInterval);
      }
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Stop all active operations and clear their progress intervals (used during app shutdown)
   */
  stopAllOperations(): void {
    for (const [id, operation] of this.activeOperations) {
      if (operation.progressInterval) {
        clearInterval(operation.progressInterval);
      }
      log.info(`Shutdown: stopped ${operation.type} operation ${id}`);
    }
    this.activeOperations.clear();
  }

  /**
   * Send a message to the renderer process
   */
  private sendToRenderer(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      window.webContents.send(channel, data);
    }
  }
}
