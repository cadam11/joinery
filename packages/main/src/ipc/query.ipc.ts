/**
 * Query IPC Handlers
 */

import { dialog } from 'electron';
import * as fs from 'fs';
import { IPC_CHANNELS } from '@joinery/shared';
import { SQLConverterService, type ConversionResult } from '../services/sql/sql-converter';
import { PythonDepsService } from '../services/sql/python-deps';
import { fetchFkRecord } from '../services/sql/fk-record';
import type {
  PythonDepsResult,
  QueryRequest,
  QueryResult,
  QueryHistoryFilter,
  QueryHistoryEntry,
  ExportOptions,
  ExportResult,
  ResultSet,
  FkRecordRequest,
  FkRecordResult,
} from '@joinery/shared';
import { QueryExecutor } from '../services/sql/query-executor';
import { QueryHistoryStore } from '../services/config/query-history';
import { ConnectionProfilesStore } from '../services/config/connection-profiles';
import { QueryResultsStore } from '../services/config/query-results-store';
import { createLogger } from '../utils/logger';
import { safeHandle } from './safe-handle';

const log = createLogger('QueryIPC');

export function registerQueryHandlers(): void {
  const queryExecutor = QueryExecutor.getInstance();
  const historyStore = QueryHistoryStore.getInstance();
  const connectionStore = ConnectionProfilesStore.getInstance();

  // Execute query
  safeHandle(
    IPC_CHANNELS.QUERY.EXECUTE,
    async (_event, request: QueryRequest): Promise<QueryResult> => {
      const startTime = Date.now();
      // The editor channel: `request.sql` is whatever the user typed (or a
      // script Joinery generated for them to review), and MySQL users expect a
      // multi-statement script to run in one go. This is the ONE call site that
      // asks for the MySQL script pool (J-137) — every other main-process
      // caller leaves the trust level at its restricted default.
      const result = await queryExecutor.execute(request, { mysqlTrust: 'script' });

      // Record to history
      const connection = connectionStore.getById(request.connectionId);
      if (connection) {
        historyStore.add({
          connectionId: request.connectionId,
          connectionName: connection.name,
          database: request.database || 'master',
          sql: request.sql.substring(0, 10000), // Limit SQL size in history
          executedAt: new Date().toISOString(),
          executionTimeMs: Date.now() - startTime,
          rowCount: result.resultSets?.reduce((sum, rs) => sum + (rs.rowCount || 0), 0),
          success: result.success,
          error: result.error,
        });
      }

      // Snapshot main-side, off the reply's critical path. The result used
      // to be structured-cloned to the renderer and then cloned back whole
      // for SAVE_SNAPSHOT; setImmediate lets the reply reach the renderer
      // before the (synchronous) store write runs.
      const snapshotTabId = request.tabId;
      const snapshotDb = request.database;
      if (snapshotTabId && snapshotDb) {
        setImmediate(() => {
          try {
            // getInstance() here (not at registration) so the store's
            // synchronous full-file load never runs during startup.
            QueryResultsStore.getInstance().saveSnapshot(
              snapshotTabId,
              request.sql,
              request.connectionId,
              snapshotDb,
              result
            );
          } catch (error) {
            log.error('Failed to persist result snapshot:', error);
          }
        });
      }

      return result;
    }
  );

  // Cancel query
  safeHandle(IPC_CHANNELS.QUERY.CANCEL, async (_event, queryId: string): Promise<void> => {
    await queryExecutor.cancel(queryId);
  });

  // Get query history
  safeHandle(
    IPC_CHANNELS.QUERY.GET_HISTORY,
    async (_event, filter?: QueryHistoryFilter): Promise<QueryHistoryEntry[]> => {
      return historyStore.getHistory(filter);
    }
  );

  // Clear all history
  safeHandle(IPC_CHANNELS.QUERY.CLEAR_HISTORY, async (): Promise<void> => {
    historyStore.clearAll();
  });

  // Delete single history entry
  safeHandle(
    IPC_CHANNELS.QUERY.DELETE_HISTORY_ENTRY,
    async (_event, id: string): Promise<boolean> => {
      return historyStore.deleteEntry(id);
    }
  );

  // Export results
  safeHandle(
    IPC_CHANNELS.QUERY.EXPORT_RESULTS,
    async (_event, resultSet: ResultSet, options: ExportOptions): Promise<ExportResult> => {
      try {
        // Show save dialog
        const defaultExt =
          options.format === 'json' ? 'json' : options.format === 'sql' ? 'sql' : 'csv';
        const filters = [
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'SQL Files', extensions: ['sql'] },
          { name: 'All Files', extensions: ['*'] },
        ];

        const result = await dialog.showSaveDialog({
          title: 'Export Results',
          defaultPath: `query-results.${defaultExt}`,
          filters,
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' };
        }

        const filePath = result.filePath;
        let content: string;

        switch (options.format) {
          case 'csv':
            content = exportToCsv(resultSet, options);
            break;
          case 'json':
            content = exportToJson(resultSet, options);
            break;
          case 'sql':
            content = exportToSql(resultSet, options);
            break;
          default:
            return { success: false, error: `Unknown format: ${options.format}` };
        }

        fs.writeFileSync(filePath, content, 'utf-8');

        return {
          success: true,
          filePath,
          rowsExported: resultSet.rows.length,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Export failed',
        };
      }
    }
  );

  // Fetch foreign key referenced record.
  //
  // The row inspector's FK preview (J-145). Everything this used to do inline — dialect selection,
  // the single-row lookup with its value BOUND rather than escaped into the predicate, MySQL's
  // restricted pool, and the catalogue decoration that marks the referenced row's primary key —
  // is in `services/sql/fk-record.ts`, where it is testable without Electron. It deliberately does
  // NOT go through `QueryExecutor`: that seam takes a SQL string and has nothing to bind values to,
  // which is exactly why this path used to interpolate a result-set cell.
  //
  // Nor does it write to query history, and that is the one behaviour the move gives up: while the
  // preview ran on QUERY.EXECUTE, every disclosure a user expanded filed an entry. A bound
  // statement's history row would read `… WHERE "id" = $1` with the value absent, which is a worse
  // record than none.
  safeHandle(
    IPC_CHANNELS.QUERY.FETCH_FK_RECORD,
    async (_event, request: FkRecordRequest): Promise<FkRecordResult> => fetchFkRecord(request)
  );

  // Convert SQL between dialects
  safeHandle(
    IPC_CHANNELS.QUERY.CONVERT_SQL,
    async (
      _event,
      sql: string,
      fromEngine: string,
      toEngine: string
    ): Promise<ConversionResult> => {
      const converter = SQLConverterService.getInstance();
      return converter.convert(sql, fromEngine, toEngine);
    }
  );

  // The SQL-conversion Python probe (J-29). Two channels for the same reason the backup CLI probe
  // has two: the result is cached for the process lifetime, so a user who installs the packages
  // while Joinery is running needs a way to say so without restarting.
  safeHandle(IPC_CHANNELS.PYTHON.CHECK, async (): Promise<PythonDepsResult> => {
    return PythonDepsService.getInstance().check();
  });

  safeHandle(IPC_CHANNELS.PYTHON.RECHECK, async (): Promise<PythonDepsResult> => {
    return PythonDepsService.getInstance().recheck();
  });
}

/**
 * Export result set to CSV format
 */
function exportToCsv(resultSet: ResultSet, options: ExportOptions): string {
  const delimiter = options.delimiter || ',';
  const lines: string[] = [];

  // Header row
  if (options.includeHeaders !== false) {
    const headers = resultSet.columns.map(col => escapeCsvField(col.name, delimiter));
    lines.push(headers.join(delimiter));
  }

  // Data rows
  for (const row of resultSet.rows) {
    const values = resultSet.columns.map(col => {
      const value = row[col.name];
      return escapeCsvField(formatValue(value), delimiter);
    });
    lines.push(values.join(delimiter));
  }

  return lines.join('\n');
}

/**
 * Export result set to JSON format
 */
function exportToJson(resultSet: ResultSet, options: ExportOptions): string {
  const data = resultSet.rows.map(row => {
    const obj: Record<string, unknown> = {};
    for (const col of resultSet.columns) {
      obj[col.name] = row[col.name];
    }
    return obj;
  });

  return options.prettyPrint ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/**
 * Export result set to SQL INSERT statements
 */
function exportToSql(resultSet: ResultSet, options: ExportOptions): string {
  const tableName = options.tableName || 'TableName';
  const lines: string[] = [];

  for (const row of resultSet.rows) {
    const columns = resultSet.columns.map(col => `[${col.name}]`).join(', ');
    const values = resultSet.columns
      .map(col => {
        const value = row[col.name];
        return formatSqlValue(value, col.type);
      })
      .join(', ');

    lines.push(`INSERT INTO [${tableName}] (${columns}) VALUES (${values});`);
  }

  return lines.join('\n');
}

/**
 * Escape a field for CSV output
 */
function escapeCsvField(value: string, delimiter: string): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');

  if (needsQuoting) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Format a value for SQL INSERT statement
 */
function formatSqlValue(value: unknown, dataType: string): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  const lowerType = dataType.toLowerCase();

  // Numeric types
  if (
    lowerType.includes('int') ||
    lowerType.includes('decimal') ||
    lowerType.includes('numeric') ||
    lowerType.includes('float') ||
    lowerType.includes('real') ||
    lowerType.includes('money') ||
    lowerType.includes('bit')
  ) {
    return String(value);
  }

  // Date types
  if (lowerType.includes('date') || lowerType.includes('time')) {
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  // Binary types
  if (lowerType.includes('binary') || lowerType.includes('varbinary')) {
    // Assume hex string or Buffer
    if (Buffer.isBuffer(value)) {
      return `0x${value.toString('hex').toUpperCase()}`;
    }
    return `0x${String(value)}`;
  }

  // String types (default)
  return `N'${String(value).replace(/'/g, "''")}'`;
}
