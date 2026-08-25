/**
 * Query Results Persistence Types
 * Types for storing, managing, and comparing query result snapshots
 */

import type { ColumnMetadata } from './query.types';

/**
 * Persisted query result snapshot
 */
export interface QueryResultSnapshot {
  /** Unique identifier for this snapshot (UUID) */
  id: string;

  /** Reference to the tab that executed this query (UUID from tab.state) */
  tabId: string;

  /** The SQL that was executed */
  sql: string;

  /** Connection ID used for execution */
  connectionId: string;

  /** Database name */
  database: string;

  /** ISO timestamp when query was executed */
  executedAt: string;

  /** Execution duration in milliseconds */
  executionTimeMs: number;

  /** Whether query succeeded */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Total row count across all result sets */
  totalRowCount: number;

  /** Size of stored data in bytes (for management) */
  storageSizeBytes: number;

  /** Result sets (may be truncated for large results) */
  resultSets: StoredResultSet[];

  /** Optional user-provided label */
  label?: string;

  /** Whether this snapshot is pinned (excluded from auto-purge) */
  isPinned?: boolean;
}

/**
 * Stored result set (optimized for persistence)
 */
export interface StoredResultSet {
  /** Column metadata */
  columns: ColumnMetadata[];

  /** Row count */
  rowCount: number;

  /** Actual rows (JSON-serializable) */
  rows: Record<string, unknown>[];

  /** Checksum for integrity verification */
  checksum?: string;
}

/**
 * Query result history filter options
 */
export interface QueryResultHistoryFilter {
  tabId?: string;
  connectionId?: string;
  database?: string;
  startDate?: string;
  endDate?: string;
  successOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Sort options for result history
 */
export type ResultHistorySortField =
  'executedAt' | 'executionTimeMs' | 'totalRowCount' | 'storageSizeBytes';
export type ResultHistorySortOrder = 'asc' | 'desc';

export interface ResultHistorySortOptions {
  field: ResultHistorySortField;
  order: ResultHistorySortOrder;
}

/**
 * Diff comparison request
 */
export interface ResultDiffRequest {
  baseSnapshotId: string;
  compareSnapshotId: string;
  options?: DiffOptions;
}

/**
 * Diff calculation options
 */
export interface DiffOptions {
  /** Columns to use as primary key for row matching */
  keyColumns?: string[];
  /** Whether to ignore column order differences */
  ignoreColumnOrder?: boolean;
  /** Whether to show only changed rows */
  changesOnly?: boolean;
  /** Maximum rows to compare (for performance) */
  maxRows?: number;
}

/**
 * Complete result diff between two snapshots
 */
export interface ResultDiff {
  /** Summary statistics */
  summary: DiffSummary;
  /** Schema differences */
  schemaDiff: SchemaDiff;
  /** Row-level differences */
  rowDiffs: RowDiff[];
  /** Execution metadata */
  metadata: {
    baseSnapshot: { id: string; executedAt: string; rowCount: number };
    compareSnapshot: { id: string; executedAt: string; rowCount: number };
    comparisonTimeMs: number;
  };
}

/**
 * Summary of differences between two result sets
 */
export interface DiffSummary {
  totalBaseRows: number;
  totalCompareRows: number;
  addedRows: number;
  removedRows: number;
  modifiedRows: number;
  unchangedRows: number;
  columnsAdded: number;
  columnsRemoved: number;
  columnsModified: number;
}

/**
 * Schema differences between two result sets
 */
export interface SchemaDiff {
  addedColumns: string[];
  removedColumns: string[];
  modifiedColumns: ColumnDiff[];
  columnOrderChanged: boolean;
}

/**
 * Column type difference
 */
export interface ColumnDiff {
  name: string;
  baseType: string;
  compareType: string;
}

/**
 * Individual row difference
 */
export interface RowDiff {
  type: 'added' | 'removed' | 'modified' | 'unchanged';
  rowIndex: number;
  /** Key values for identifying the row */
  keyValues?: Record<string, unknown>;
  /** For modified rows, the specific cell changes */
  cellChanges?: CellChange[];
  /** Base row data (for removed/modified) */
  baseRow?: Record<string, unknown>;
  /** Compare row data (for added/modified) */
  compareRow?: Record<string, unknown>;
}

/**
 * Individual cell change within a row
 */
export interface CellChange {
  column: string;
  baseValue: unknown;
  compareValue: unknown;
}

/**
 * Storage statistics for query results
 */
export interface ResultStorageStats {
  totalSnapshots: number;
  totalSizeBytes: number;
  oldestSnapshot: string | null;
  newestSnapshot: string | null;
  snapshotsByTab: Record<string, number>;
}

/**
 * Purge options for cleaning up old snapshots
 */
export interface PurgeOptions {
  /** Delete snapshots older than this date */
  olderThan?: string;
  /** Delete snapshots for specific tab */
  tabId?: string;
  /** Delete snapshots exceeding size limit */
  maxTotalSizeBytes?: number;
  /** Keep at least N most recent snapshots per tab */
  keepMinPerTab?: number;
  /** Skip pinned snapshots */
  skipPinned?: boolean;
}

/**
 * Result of a purge operation
 */
export interface PurgeResult {
  deletedCount: number;
  freedBytes: number;
  remainingCount: number;
  remainingBytes: number;
}

/**
 * Storage configuration constants
 */
export const QUERY_RESULTS_CONFIG = {
  /** Maximum total storage size in bytes (500 MB) */
  MAX_STORAGE_SIZE_BYTES: 500 * 1024 * 1024,
  /** Maximum rows stored per result set */
  MAX_ROWS_PER_SNAPSHOT: 50000,
  /** Maximum snapshots to keep per tab */
  MAX_SNAPSHOTS_PER_TAB: 50,
  /** Default retention period in days */
  DEFAULT_RETENTION_DAYS: 30,
  /** Minimum snapshots to keep per tab during cleanup */
  MIN_SNAPSHOTS_PER_TAB: 5,
} as const;
