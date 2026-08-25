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

export type BackupType = 'full' | 'differential' | 'log';

export interface BackupRequest {
  connectionId: string;
  database: string;
  backupPath: string;
  backupType: BackupType;
  compression?: boolean;
  copyOnly?: boolean;
  checksum?: boolean;
  description?: string;
  backupId?: string;
}

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
