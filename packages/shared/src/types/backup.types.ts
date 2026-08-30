/**
 * Backup and Restore type definitions
 */

/**
 * Server file system types for browsing SQL Server's file system
 */
export interface ServerDrive {
  drive: string; // e.g., "C:", "D:"
  freeSpaceMB: number;
}

export interface ServerFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  depth: number;
}

export interface ServerDefaultPaths {
  dataPath: string; // Default data file location
  logPath: string; // Default log file location
  backupPath: string; // Default backup location
}

export interface BackupHistoryEntry {
  databaseName: string;
  backupType: string;
  backupStartDate: string;
  backupFinishDate: string;
  backupSizeBytes: number;
  compressedSizeBytes?: number;
  physicalDeviceName: string;
  serverName: string;
  recoveryModel: string;
  userName: string;
  firstLsn?: string;
  lastLsn?: string;
  description?: string;
}

/**
 * The three things `BACKUP DATABASE` can be asked for. **SQL Server only** — see `BackupRequest`.
 */
export type BackupType = 'full' | 'differential' | 'log';

export interface BackupRequest {
  connectionId: string;
  database: string;
  backupPath: string;
  /**
   * SQL Server only, and absent on every other engine (J-48d).
   *
   * The Angular dialog bound a four-option "Dump Format" picker to this field on PostgreSQL and
   * MySQL, where all four options produced a byte-identical dump: `pg_dump` was always given
   * `-F c` and `mysqldump` was never given a format flag at all. Rather than implement four
   * formats nobody asked for, each of those engines has exactly one, stated as a fact in the
   * dialog and pinned in `backup-args.ts`. The field is optional so that a request for those
   * engines can leave it out rather than carry a placeholder the engine ignores; the two CLI
   * services take {@link CliBackupRequest}, which does not have it at all.
   */
  backupType?: BackupType;
  compression?: boolean;
  copyOnly?: boolean;
  checksum?: boolean;
  description?: string;
  backupId?: string;
}

/**
 * The request the `pg_dump` / `mysqldump` services receive.
 *
 * `backupType` is removed rather than ignored: those engines have one dump format each, so a
 * service that could read the field could grow a format branch again without anyone changing this
 * type first (J-48d).
 */
export type CliBackupRequest = Omit<BackupRequest, 'backupType'>;

// Legacy alias
export interface BackupOptions {
  connectionId: string;
  databaseName: string;
  destinationPath: string;
  backupType: BackupType | 'full_copy_only';
  compression: boolean;
  verify: boolean;
  description?: string;
}

export interface BackupProgress {
  backupId: string;
  operationId?: string; // alias
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  percentComplete: number;
  percent?: number; // alias
  processedBytes?: number;
  totalBytes?: number;
  elapsedMs?: number;
  estimatedRemainingMs?: number;
  currentPhase?: string;
  error?: string;
}

export interface BackupResult {
  operationId: string;
  success: boolean;
  filePath: string;
  sizeBytes: number;
  durationMs: number;
  tsql: string;
  error?: string;
}

export interface BackupLogicalFile {
  logicalName: string;
  physicalName: string;
  type: 'D' | 'L'; // Data or Log
  fileType: 'D' | 'L'; // Alias for type
  fileGroupName?: string;
  sizeBytes?: number;
}

export interface BackupFileInfo {
  databaseName: string;
  backupType: string;
  backupDate: string;
  backupFinishDate: string; // Alias for backupDate
  backupSizeBytes: number;
  compressedSizeBytes?: number;
  serverVersion?: string;
  serverName?: string;
  recoveryModel?: string;
  compatibilityLevel?: number;
  collation?: string;
  files?: BackupLogicalFile[];
  description?: string;
}

export interface FileRelocation {
  logicalName: string;
  physicalName: string;
  newPath?: string; // Alias for physicalName
}

export interface RestoreRequest {
  connectionId: string;
  backupPath: string;
  targetDatabase?: string;
  fileRelocations?: FileRelocation[];
  replaceExisting?: boolean;
  withReplace?: boolean; // Alias for replaceExisting
  withNoRecovery?: boolean;
  /**
   * `'STANDBY'` was removed in J-51c: the builder could only emit `STANDBY = N'standby.dat'`, a
   * relative path the server resolves against whatever its working directory happens to be, so a
   * standby restore put its undo file somewhere nobody could name. Re-adding it means taking the
   * path as a field first.
   */
  recoveryState?: 'RECOVERY' | 'NORECOVERY';
  restoreId?: string;
}

// Legacy alias
export interface RestoreOptions {
  connectionId: string;
  sourcePath: string;
  targetDatabaseName: string;
  overwriteExisting: boolean;
  fileMoves: FileMove[];
  recoveryState: 'recovery' | 'norecovery';
}

export interface FileMove {
  logicalName: string;
  destinationPath: string;
}

export interface RestoreProgress {
  restoreId: string;
  operationId?: string; // alias
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  percentComplete: number;
  percent?: number; // alias
  processedBytes?: number;
  totalBytes?: number;
  elapsedMs?: number;
  estimatedRemainingMs?: number;
  currentPhase?: string;
  error?: string;
}

export interface RestoreResult {
  operationId: string;
  success: boolean;
  databaseName: string;
  durationMs: number;
  tsql: string;
  error?: string;
}
