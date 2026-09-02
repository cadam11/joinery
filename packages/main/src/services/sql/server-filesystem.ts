/**
 * Server Filesystem Service
 * Provides methods to browse the SQL Server's file system
 */

import type {
  ServerDrive,
  ServerFileEntry,
  ServerDefaultPaths,
  BackupHistoryEntry,
} from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { ConnectionPoolManager } from './connection-pool';

const log = createLogger('ServerFS');

/** Which filesystem a server path belongs to. SQL Server runs on both (J-50). */
export type ServerPathStyle = 'windows' | 'posix';

/**
 * The style of an ABSOLUTE server path, or `null` when it is not one.
 *
 * Anchoring is the first half of the injection guard, not a formatting nicety: a value that is not
 * rooted is not a path this app produced, and the browser only ever walks down from a drive or from
 * `/`. Windows means a drive letter or a UNC prefix; POSIX means a leading slash.
 */
export function serverPathStyle(inputPath: string): ServerPathStyle | null {
  if (/^[A-Za-z]:\\/.test(inputPath) || inputPath.startsWith('\\\\')) return 'windows';
  if (inputPath.startsWith('/')) return 'posix';
  return null;
}

/** The separator to build paths with, for a path of this style. */
export function serverPathSeparator(style: ServerPathStyle): string {
  return style === 'windows' ? '\\' : '/';
}

/**
 * Validate and escape a server filesystem path (J-50).
 *
 * This is an injection guard: the value is interpolated into an `xp_dirtree` call, so what it
 * REFUSES matters more than what it accepts. It used to accept Windows paths only, which meant
 * SQL Server on Linux — `/var/opt/mssql/data`, the container this repo's own harness runs — could
 * not be browsed at all, while the renderer's path helpers already handled POSIX correctly.
 *
 * Widening it kept every existing refusal and added two:
 *
 * - **A POSIX path may not contain a backslash.** Legal in a Linux filename, never produced by
 *   this app, and a mixed-separator path is the shape a caller confusing the two styles would
 *   send. Refusing is cheap; guessing is not.
 * - **No `..` segment, in either style.** The renderer computes a parent by slicing, so nothing
 *   legitimate emits one — which makes a `..` arriving here a sign the caller is not the app.
 */
function sanitizeServerPath(inputPath: string): string {
  const style = serverPathStyle(inputPath);
  if (style === null) {
    throw new Error(`Invalid server path: ${inputPath}`);
  }
  if (style === 'posix' && inputPath.includes('\\')) {
    throw new Error(`Invalid server path: ${inputPath}`);
  }
  if (inputPath.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid server path: ${inputPath}`);
  }
  // Reject semicolons, SQL comments, and other injection patterns
  if (/[;]|--|\bEXEC\b|\bDROP\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bSELECT\b/i.test(inputPath)) {
    throw new Error('Path contains invalid characters');
  }
  // Escape single quotes for N-string literals
  return inputPath.replace(/'/g, "''");
}

/** Exposed for the spec: the guard is the interesting part of this module. */
export const sanitizeServerPathForTest = sanitizeServerPath;

/**
 * Validates a SQL Server identifier (database name, etc.)
 * Only allows alphanumeric, underscore, space, hyphen, and dot.
 */
function sanitizeIdentifier(name: string): string {
  if (!/^[\w\s.-]+$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name.replace(/'/g, "''");
}

/**
 * A raw `xp_dirtree` row as the driver hands it back.
 *
 * `isfile` is declared BIT in the temp table, and node-mssql/tedious maps BIT
 * to a JavaScript **boolean** — not 0/1. The numeric arm of the union is kept
 * so the mapper stays correct if a row ever arrives from a driver (or a mock)
 * that yields the numeric form instead.
 */
export interface DirTreeRow {
  name: string;
  depth: number;
  isfile: boolean | number;
}

/**
 * Maps one `xp_dirtree` row to a ServerFileEntry.
 *
 * Exported so the BIT handling is unit-testable without a live server: this is
 * exactly where the "every entry looks like a file" bug lived (`isfile === 0`
 * is always false when `isfile` is a boolean).
 */
export function mapDirTreeRow(row: DirTreeRow, parentPath: string): ServerFileEntry {
  return {
    name: row.name,
    path: `${parentPath}${row.name}`,
    isDirectory: !row.isfile,
    depth: row.depth,
  };
}

export class ServerFilesystemService extends BaseSingleton {
  private poolManager: ConnectionPoolManager;

  constructor() {
    super();
    this.poolManager = ConnectionPoolManager.getInstance();
  }

  /**
   * Get available drives on the SQL Server
   */
  async getDrives(connectionId: string): Promise<ServerDrive[]> {
    const sql = `EXEC xp_fixeddrives;`;

    const result = await this.poolManager.query<{
      drive: string;
      'MB free': number;
    }>(connectionId, sql);

    return result.recordset.map(row => ({
      drive: `${row.drive}:`,
      freeSpaceMB: row['MB free'],
    }));
  }

  /**
   * List directory contents on the SQL Server
   * Uses xp_dirtree which returns subdirectories and files
   */
  async listDirectory(
    connectionId: string,
    path: string,
    includeFiles = true
  ): Promise<ServerFileEntry[]> {
    // Normalise with the separator the path itself is written in — hardcoding a backslash here was
    // the other half of "SQL Server on Linux cannot be browsed" (J-50). An unrooted path has no
    // style; let the sanitizer be the one that refuses it, so there is one place that does.
    const style = serverPathStyle(path);
    const separator = style === null ? '\\' : serverPathSeparator(style);
    const normalizedPath = path.endsWith(separator) ? path : `${path}${separator}`;
    const safePath = sanitizeServerPath(normalizedPath);

    // xp_dirtree parameters: path, depth (0=recursive), include_files (1=yes)
    const sql = `
      CREATE TABLE #DirectoryTree (
        subdirectory NVARCHAR(512),
        depth INT,
        isfile BIT
      );

      INSERT INTO #DirectoryTree
      EXEC xp_dirtree @path = N'${safePath}', @depth = 1, @file = ${includeFiles ? 1 : 0};

      SELECT subdirectory as name, depth, isfile
      FROM #DirectoryTree
      ORDER BY isfile, subdirectory;

      DROP TABLE #DirectoryTree;
    `;

    try {
      const result = await this.poolManager.query<DirTreeRow>(connectionId, sql);

      return result.recordset.map(row => mapDirTreeRow(row, normalizedPath));
    } catch (error) {
      // If the directory doesn't exist or access denied, return empty
      log.error('Error listing directory:', error);
      return [];
    }
  }

  /**
   * Get SQL Server's default paths for data, log, and backup files
   */
  async getDefaultPaths(connectionId: string): Promise<ServerDefaultPaths> {
    const sql = `
      SELECT
        SERVERPROPERTY('InstanceDefaultDataPath') as DataPath,
        SERVERPROPERTY('InstanceDefaultLogPath') as LogPath,
        SERVERPROPERTY('InstanceDefaultBackupPath') as BackupPath;
    `;

    const result = await this.poolManager.query<{
      DataPath: string | null;
      LogPath: string | null;
      BackupPath: string | null;
    }>(connectionId, sql);

    const row = result.recordset[0];

    // Fallback to querying registry if server properties return null
    const dataPath = row?.DataPath || '';
    const logPath = row?.LogPath || '';
    let backupPath = row?.BackupPath || '';

    // If backup path is empty, try to get it from master database location
    if (!backupPath) {
      try {
        const backupSql = `
          SELECT TOP 1 physical_name
          FROM master.sys.database_files
          WHERE type = 0;
        `;
        const backupResult = await this.poolManager.query<{ physical_name: string }>(
          connectionId,
          backupSql
        );
        if (backupResult.recordset[0]) {
          // Extract directory from file path
          const filePath = backupResult.recordset[0].physical_name;
          backupPath = filePath.substring(0, filePath.lastIndexOf('\\') + 1);
        }
      } catch {
        // Ignore errors
      }
    }

    return {
      dataPath: dataPath || 'C:\\',
      logPath: logPath || dataPath || 'C:\\',
      backupPath: backupPath || dataPath || 'C:\\',
    };
  }

  /**
   * Get backup history for a database
   */
  async getBackupHistory(
    connectionId: string,
    databaseName?: string,
    limit = 50
  ): Promise<BackupHistoryEntry[]> {
    const whereClause = databaseName
      ? `WHERE bs.database_name = N'${sanitizeIdentifier(databaseName)}'`
      : '';

    const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 50)));

    const sql = `
      SELECT TOP ${safeLimit}
        bs.database_name as databaseName,
        CASE bs.type
          WHEN 'D' THEN 'Full'
          WHEN 'I' THEN 'Differential'
          WHEN 'L' THEN 'Log'
          WHEN 'F' THEN 'File or Filegroup'
          WHEN 'G' THEN 'Differential File'
          WHEN 'P' THEN 'Partial'
          WHEN 'Q' THEN 'Differential Partial'
          ELSE 'Unknown'
        END as backupType,
        bs.backup_start_date as backupStartDate,
        bs.backup_finish_date as backupFinishDate,
        bs.backup_size as backupSizeBytes,
        bs.compressed_backup_size as compressedSizeBytes,
        bmf.physical_device_name as physicalDeviceName,
        bs.server_name as serverName,
        bs.recovery_model as recoveryModel,
        bs.user_name as userName,
        bs.first_lsn as firstLsn,
        bs.last_lsn as lastLsn,
        bs.description as description
      FROM msdb.dbo.backupset bs
      INNER JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
      ${whereClause}
      ORDER BY bs.backup_finish_date DESC;
    `;

    const result = await this.poolManager.query<{
      databaseName: string;
      backupType: string;
      backupStartDate: Date;
      backupFinishDate: Date;
      backupSizeBytes: number;
      compressedSizeBytes: number | null;
      physicalDeviceName: string;
      serverName: string;
      recoveryModel: string;
      userName: string;
      firstLsn: string | null;
      lastLsn: string | null;
      description: string | null;
    }>(connectionId, sql);

    return result.recordset.map(row => ({
      databaseName: row.databaseName,
      backupType: row.backupType,
      backupStartDate: row.backupStartDate?.toISOString() || '',
      backupFinishDate: row.backupFinishDate?.toISOString() || '',
      backupSizeBytes: Number(row.backupSizeBytes) || 0,
      compressedSizeBytes: row.compressedSizeBytes ? Number(row.compressedSizeBytes) : undefined,
      physicalDeviceName: row.physicalDeviceName,
      serverName: row.serverName,
      recoveryModel: row.recoveryModel,
      userName: row.userName,
      firstLsn: row.firstLsn || undefined,
      lastLsn: row.lastLsn || undefined,
      description: row.description || undefined,
    }));
  }

  /**
   * Get the parent directory of a path
   */
  getParentPath(path: string): string {
    // Remove trailing backslash if present
    const normalizedPath = path.endsWith('\\') ? path.slice(0, -1) : path;
    const lastSlash = normalizedPath.lastIndexOf('\\');

    if (lastSlash <= 2) {
      // We're at root (e.g., "C:")
      return normalizedPath.substring(0, 2) + '\\';
    }

    return normalizedPath.substring(0, lastSlash);
  }
}
