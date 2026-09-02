/**
 * Query Executor Service
 * Executes SQL queries and returns structured results.
 * Supports SQL Server (mssql) and PostgreSQL (pg) engines.
 */

import { v4 as uuidv4 } from 'uuid';
import type * as mssql from 'mssql';
import type { QueryRequest, QueryResult, ResultSet, ColumnMetadata } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { ConnectionPoolManager } from './connection-pool';
import type { MySQLPoolTrust } from './mysql-pool-options';
import { MetadataService } from './metadata';
import { applyRowCap } from './row-cap';
import { resolveQueryTimeoutMs, withQueryTimeout } from './query-timeout';

const log = createLogger('QueryExecutor');

interface ParsedTableRef {
  schema: string;
  table: string;
}

/**
 * Caller-supplied execution context. Not part of `QueryRequest`, which is a
 * shared type the renderer fills in: the renderer must not be able to pick its
 * own MySQL trust level.
 */
export interface ExecuteOptions {
  /**
   * MySQL only. `'script'` runs on the multi-statement pool and is for
   * user-authored editor scripts; anything Joinery built itself leaves this
   * unset and gets the restricted pool. See mysql-pool-options.ts.
   */
  mysqlTrust?: MySQLPoolTrust;
}

interface ActiveQuery {
  queryId: string;
  connectionId: string;
  startTime: number;
  cancelled: boolean;
  request?: mssql.Request; // Track the actual request for cancellation
}

export class QueryExecutor extends BaseSingleton {
  private poolManager: ConnectionPoolManager;
  private metadataService: MetadataService;
  private activeQueries: Map<string, ActiveQuery> = new Map();

  constructor() {
    super();
    this.poolManager = ConnectionPoolManager.getInstance();
    this.metadataService = MetadataService.getInstance();
  }

  /**
   * Execute a SQL query.
   *
   * `options` is main-process-only and never crosses IPC — the renderer must
   * not be able to ask for a more capable connection than its call site is
   * entitled to. See ExecuteOptions.
   */
  async execute(request: QueryRequest, options: ExecuteOptions = {}): Promise<QueryResult> {
    const queryId = request.queryId || uuidv4();
    const startTime = Date.now();
    // Resolved once, here, so all three engines get the same validated value — and so a bogus
    // timeout off the IPC boundary cannot reach a driver or a timer. See query-timeout.ts for
    // why the deadline is Joinery's to enforce and how it stacks with the profile's own.
    const timeoutMs = resolveQueryTimeoutMs(request.timeout);

    // Track active query
    const activeQuery: ActiveQuery = {
      queryId,
      connectionId: request.connectionId,
      startTime,
      cancelled: false,
    };
    this.activeQueries.set(queryId, activeQuery);

    try {
      // Route to engine-specific executor
      const engine = this.poolManager.getEngineForProfile(request.connectionId);
      if (engine === 'postgresql') {
        return await this.executePg(request, activeQuery, queryId, startTime, timeoutMs);
      }
      if (engine === 'mysql') {
        return await this.executeMySQL(
          request,
          activeQuery,
          queryId,
          startTime,
          options,
          timeoutMs
        );
      }

      const pool = await this.poolManager.getPool(request.connectionId, request.database);

      // Check if cancelled before executing
      if (activeQuery.cancelled) {
        return this.createCancelledResult(queryId, startTime);
      }

      // Split SQL on GO batch separators (GO is a client-side command, not T-SQL).
      // Each batch between GO statements must be sent as a separate batch() call.
      const batches = this.splitBatches(request.sql);

      // Build USE prefix for database context.
      // Azure SQL Database doesn't support USE — getPool already targets
      // the right database. Key off the actual server edition rather than
      // auth type so SQL-auth-on-Azure also skips the USE.
      let usePrefix = '';
      const skipUse = await this.poolManager.isAzureSQL(request.connectionId);
      if (request.database && !skipUse) {
        const safeDb = request.database.replace(/\]/g, ']]');
        usePrefix = `USE [${safeDb}];\n`;
      }

      const allResultSets: ResultSet[] = [];
      const allMessages: string[] = [];
      let totalRowsAffected = 0;

      // Try to parse the SQL to detect a single-table SELECT for FK enrichment
      const parsedTable = this.parseSimpleSelect(request.sql);
      let enrichedColumns: Map<string, ColumnMetadata> | null = null;

      if (parsedTable && request.database) {
        try {
          const metadata = await this.metadataService.getEnrichedColumnMetadata(
            request.connectionId,
            request.database,
            parsedTable.schema,
            parsedTable.table
          );
          enrichedColumns = new Map(
            metadata.map(col => [
              col.name.toLowerCase(),
              {
                name: col.name,
                type: col.type,
                dataType: col.type,
                nullable: col.nullable,
                maxLength: col.maxLength ?? undefined,
                precision: col.precision ?? undefined,
                scale: col.scale ?? undefined,
                isPrimaryKey: col.isPrimaryKey,
                foreignKey: col.foreignKey ?? undefined,
              },
            ])
          );
        } catch {
          // Ignore metadata errors - just proceed without FK info
        }
      }

      // If we need USE and there's only one batch, check if it requires being
      // the first statement (CREATE VIEW/TRIGGER/PROC/FUNCTION/SCHEMA).
      // If so, run USE as a separate batch first.
      const needsSeparateUse =
        usePrefix && batches.length === 1 && this.requiresFirstInBatch(batches[0]);

      if (needsSeparateUse) {
        // Set database context in its own batch
        const setupReq = pool.request();
        activeQuery.request = setupReq;
        await this.runBatch(setupReq, usePrefix.trimEnd(), timeoutMs);
      }

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        if (activeQuery.cancelled) {
          return this.createCancelledResult(queryId, startTime);
        }

        const batchSql = batches[batchIdx];

        // Build the final SQL for this batch
        let sql: string;
        if (needsSeparateUse) {
          // USE already executed separately
          sql = batchSql;
        } else if (usePrefix && batchIdx === 0) {
          // For multi-batch scripts, prepend USE to first batch if it's safe,
          // otherwise run USE separately then the batch
          if (this.requiresFirstInBatch(batchSql)) {
            const setupReq = pool.request();
            activeQuery.request = setupReq;
            await this.runBatch(setupReq, usePrefix.trimEnd(), timeoutMs);
            sql = batchSql;
          } else {
            sql = usePrefix + batchSql;
          }
        } else {
          sql = batchSql;
        }

        const sqlRequest = pool.request();
        activeQuery.request = sqlRequest;

        const result = await this.runBatch(sqlRequest, sql, timeoutMs);

        // Process result sets from this batch
        if (Array.isArray(result.recordsets)) {
          for (let i = 0; i < result.recordsets.length; i++) {
            const recordset = result.recordsets[i];
            let columns = this.extractColumns(recordset.columns);

            if (enrichedColumns) {
              columns = columns.map(col => {
                const enriched = enrichedColumns!.get(col.name.toLowerCase());
                if (enriched) {
                  return {
                    ...col,
                    isPrimaryKey: enriched.isPrimaryKey,
                    foreignKey: enriched.foreignKey,
                  };
                }
                return col;
              });
            }

            allResultSets.push({
              columns,
              rows: recordset as unknown as Record<string, unknown>[],
              rowCount: recordset.length,
            });
          }
        }

        const batchRows = result.rowsAffected?.reduce((a, b) => a + b, 0) || 0;
        totalRowsAffected += batchRows;

        if (batches.length > 1) {
          allMessages.push(`Batch ${batchIdx + 1}: (${batchRows} row(s) affected)`);
        }
      }

      if (activeQuery.cancelled) {
        return this.createCancelledResult(queryId, startTime);
      }

      // Summary messages
      if (allResultSets.length > 1) {
        for (let i = 0; i < allResultSets.length; i++) {
          allMessages.push(`Result ${i + 1}: (${allResultSets[i].rowCount || 0} row(s) returned)`);
        }
      }
      allMessages.push(`(${totalRowsAffected} row(s) affected)`);

      return applyRowCap(
        {
          queryId,
          success: true,
          resultSets: allResultSets,
          messages: allMessages,
          rowsAffected: totalRowsAffected,
          executionTime: Date.now() - startTime,
        },
        request.maxRows
      );
    } catch (error) {
      const err = error as Error & { lineNumber?: number; number?: number };

      return {
        queryId,
        success: false,
        resultSets: [],
        messages: [err.message],
        rowsAffected: 0,
        executionTime: Date.now() - startTime,
        error: err.message,
      };
    } finally {
      this.activeQueries.delete(queryId);
    }
  }

  /**
   * One MSSQL batch, under the per-query deadline.
   *
   * `Request.cancel()` sends an attention packet, so the server aborts the batch rather than
   * Joinery merely walking away from it — the same call `cancel()` below uses for a user
   * cancellation. It is per batch because tedious's own `requestTimeout` is per request too, so
   * a `GO`-separated script keeps the semantics it already had.
   */
  private runBatch(
    request: mssql.Request,
    sql: string,
    timeoutMs: number | undefined
  ): Promise<mssql.IResult<Record<string, unknown>>> {
    return withQueryTimeout(
      timeoutMs,
      () => request.cancel(),
      () => request.batch<Record<string, unknown>>(sql)
    );
  }

  /**
   * Cancel a running query
   */
  async cancel(queryId: string): Promise<boolean> {
    const activeQuery = this.activeQueries.get(queryId);
    if (activeQuery) {
      activeQuery.cancelled = true;

      // Actually cancel the mssql request if it exists
      if (activeQuery.request) {
        try {
          activeQuery.request.cancel();
          log.info(`Query ${queryId} cancelled`);
          return true;
        } catch (error) {
          log.error(`Error cancelling query ${queryId}:`, error);
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Cancel all running queries (used during app shutdown)
   */
  cancelAll(): void {
    for (const [queryId, activeQuery] of this.activeQueries) {
      activeQuery.cancelled = true;
      if (activeQuery.request) {
        try {
          activeQuery.request.cancel();
        } catch {
          // Ignore cancel errors during shutdown
        }
      }
      log.info(`Shutdown: cancelled query ${queryId}`);
    }
    this.activeQueries.clear();
  }

  /**
   * Extract column metadata from a recordset
   */
  /**
   * Execute a query against PostgreSQL
   */
  private async executePg(
    request: QueryRequest,
    activeQuery: ActiveQuery,
    queryId: string,
    startTime: number,
    timeoutMs: number | undefined
  ): Promise<QueryResult> {
    // PG sets database at the connection/pool level — pass database to get the right pool
    const pool = await this.poolManager.getPgPool(request.connectionId, request.database);

    if (activeQuery.cancelled) {
      return this.createCancelledResult(queryId, startTime);
    }
    const client = await pool.connect();
    /**
     * Set when the deadline fires, and passed to `release` so the client is DESTROYED rather
     * than pooled: pg leaves an already-sent query in flight when it gives up on it
     * (`pg/lib/client.js:719-727` destroys the stream only while pipelining), and the next
     * borrower would share a socket with a response it never asked for. `release(undefined)` is
     * the ordinary release, so there is still exactly one release on every path.
     */
    let abandoned: Error | undefined;
    try {
      const result = await withQueryTimeout(
        timeoutMs,
        error => {
          abandoned = error;
        },
        () => client.query(request.sql)
      );
      const results = Array.isArray(result) ? result : [result];

      const allResultSets: ResultSet[] = [];
      const allMessages: string[] = [];
      let totalRowsAffected = 0;

      for (const r of results) {
        if (r.fields && r.fields.length > 0) {
          const columns: ColumnMetadata[] = r.fields.map(
            (f: { name: string; dataTypeID: number; dataTypeSize: number }) => ({
              name: f.name,
              type: this.pgTypeIdToName(f.dataTypeID),
              dataType: this.pgTypeIdToName(f.dataTypeID),
              nullable: true,
            })
          );

          allResultSets.push({
            columns,
            rows: r.rows as Record<string, unknown>[],
            rowCount: r.rows.length,
          });
        }
        totalRowsAffected += r.rowCount ?? 0;
      }

      allMessages.push(`(${totalRowsAffected} row(s) affected)`);

      return applyRowCap(
        {
          queryId,
          success: true,
          resultSets: allResultSets,
          messages: allMessages,
          rowsAffected: totalRowsAffected,
          executionTime: Date.now() - startTime,
        },
        request.maxRows
      );
    } finally {
      client.release(abandoned);
    }
  }

  /**
   * Execute a query against MySQL
   */
  private async executeMySQL(
    request: QueryRequest,
    activeQuery: ActiveQuery,
    queryId: string,
    startTime: number,
    options: ExecuteOptions,
    timeoutMs: number | undefined
  ): Promise<QueryResult> {
    // MySQL supports USE for database context switching.
    // Trust level defaults to 'restricted' (J-137): only a caller that says it
    // is running a user-authored script gets a connection that can carry more
    // than one statement.
    const pool = await this.poolManager.getMySQLPool(
      request.connectionId,
      request.database,
      options.mysqlTrust ?? 'restricted'
    );

    if (activeQuery.cancelled) {
      return this.createCancelledResult(queryId, startTime);
    }

    const conn = await pool.getConnection();
    try {
      const [rawRows, rawFields] = await withQueryTimeout(
        timeoutMs,
        // mysql2 leaves a timed-out connection fatally errored with a result still pending, so
        // it must not go back to the pool. `destroy()` detaches it first
        // (`mysql2/lib/pool_connection.js:57-69` nulls `_pool`), which makes the `release()`
        // below a verified no-op (`release()` returns early when `_pool` is null) rather than a
        // double free.
        () => conn.destroy(),
        () => conn.query(request.sql)
      );

      const allResultSets: ResultSet[] = [];
      const allMessages: string[] = [];
      let totalRowsAffected = 0;

      // mysql2 with multipleStatements returns arrays of results
      const isMultiResult =
        Array.isArray(rawRows) && rawRows.length > 0 && Array.isArray(rawRows[0]);

      if (isMultiResult) {
        const multiRows = rawRows as unknown as unknown[][];
        const multiFields = (rawFields || []) as unknown as unknown[][];

        for (let i = 0; i < multiRows.length; i++) {
          const rows = multiRows[i];
          const fields = (multiFields[i] || []) as Array<{
            name: string;
            columnType?: number;
            columnLength?: number;
          }>;

          if (
            Array.isArray(rows) &&
            rows.length > 0 &&
            typeof rows[0] === 'object' &&
            !('affectedRows' in (rows[0] as object))
          ) {
            const columns: ColumnMetadata[] = fields.map(f => ({
              name: f.name,
              type: this.mysqlTypeIdToName(f.columnType),
              dataType: this.mysqlTypeIdToName(f.columnType),
              nullable: true,
            }));

            allResultSets.push({
              columns,
              rows: rows as Record<string, unknown>[],
              rowCount: rows.length,
            });
          }
          if (rows && typeof rows === 'object' && 'affectedRows' in (rows as object)) {
            totalRowsAffected += (rows as unknown as { affectedRows: number }).affectedRows;
          }
        }
      } else {
        // Single result
        const rows = rawRows;
        const fields = (rawFields || []) as unknown as Array<{
          name: string;
          columnType?: number;
          columnLength?: number;
        }>;

        if (Array.isArray(rows) && rows.length > 0) {
          const columns: ColumnMetadata[] = fields.map(f => ({
            name: f.name,
            type: this.mysqlTypeIdToName(f.columnType),
            dataType: this.mysqlTypeIdToName(f.columnType),
            nullable: true,
          }));

          allResultSets.push({
            columns,
            rows: rows as Record<string, unknown>[],
            rowCount: rows.length,
          });
        }
        if (rows && typeof rows === 'object' && 'affectedRows' in (rows as object)) {
          totalRowsAffected += (rows as { affectedRows: number }).affectedRows;
        }
      }

      allMessages.push(`(${totalRowsAffected} row(s) affected)`);

      return applyRowCap(
        {
          queryId,
          success: true,
          resultSets: allResultSets,
          messages: allMessages,
          rowsAffected: totalRowsAffected,
          executionTime: Date.now() - startTime,
        },
        request.maxRows
      );
    } finally {
      conn.release();
    }
  }

  /** Map common MySQL column type constants to human-readable names */
  private mysqlTypeIdToName(typeId?: number): string {
    if (typeId === undefined || typeId === null) return 'unknown';
    const typeMap: Record<number, string> = {
      0: 'decimal',
      1: 'tinyint',
      2: 'smallint',
      3: 'int',
      4: 'float',
      5: 'double',
      6: 'null',
      7: 'timestamp',
      8: 'bigint',
      9: 'mediumint',
      10: 'date',
      11: 'time',
      12: 'datetime',
      13: 'year',
      14: 'newdate',
      15: 'varchar',
      16: 'bit',
      245: 'json',
      246: 'newdecimal',
      247: 'enum',
      248: 'set',
      249: 'tiny_blob',
      250: 'medium_blob',
      251: 'long_blob',
      252: 'blob',
      253: 'var_string',
      254: 'string',
      255: 'geometry',
    };
    return typeMap[typeId] || `type:${typeId}`;
  }

  /** Map common PostgreSQL type OIDs to human-readable names */
  private pgTypeIdToName(oid: number): string {
    const typeMap: Record<number, string> = {
      16: 'boolean',
      17: 'bytea',
      18: 'char',
      19: 'name',
      20: 'int8',
      21: 'int2',
      23: 'int4',
      25: 'text',
      26: 'oid',
      114: 'json',
      142: 'xml',
      600: 'point',
      700: 'float4',
      701: 'float8',
      790: 'money',
      1042: 'bpchar',
      1043: 'varchar',
      1082: 'date',
      1083: 'time',
      1114: 'timestamp',
      1184: 'timestamptz',
      1186: 'interval',
      1266: 'timetz',
      1560: 'bit',
      1700: 'numeric',
      2950: 'uuid',
      3802: 'jsonb',
    };
    return typeMap[oid] || `oid:${oid}`;
  }

  private extractColumns(columns: Record<string, unknown>): ColumnMetadata[] {
    if (!columns) {
      return [];
    }

    return Object.entries(columns).map(([name, info]) => {
      const col = info as {
        type?: { declaration: string };
        nullable?: boolean;
        length?: number;
        precision?: number;
        scale?: number;
      };

      return {
        name,
        type: col.type?.declaration || 'unknown',
        dataType: col.type?.declaration || 'unknown',
        nullable: col.nullable ?? true,
        maxLength: col.length,
        precision: col.precision,
        scale: col.scale,
      };
    });
  }

  /**
   * Create a result for a cancelled query
   */
  private createCancelledResult(queryId: string, startTime: number): QueryResult {
    return {
      queryId,
      success: false,
      resultSets: [],
      messages: ['Query was cancelled'],
      rowsAffected: 0,
      executionTime: Date.now() - startTime,
      error: 'Query cancelled by user',
    };
  }

  /**
   * Split a SQL script on GO batch separators.
   * GO must appear on its own line (optionally with whitespace or a repeat count).
   * Respects strings and comments — GO inside a string or comment is ignored.
   */
  private splitBatches(sql: string): string[] {
    // Match GO on its own line: optional whitespace, GO, optional count, optional whitespace
    const goRegex = /^\s*GO\s*(\d*)\s*$/gim;
    const batches: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = goRegex.exec(sql)) !== null) {
      // Make sure this GO isn't inside a string or block comment
      const preceding = sql.substring(lastIndex, match.index);
      if (this.isInsideStringOrComment(preceding)) continue;

      const batch = sql.substring(lastIndex, match.index).trim();
      if (batch) {
        const count = match[1] ? parseInt(match[1], 10) : 1;
        for (let i = 0; i < count; i++) {
          batches.push(batch);
        }
      }
      lastIndex = match.index + match[0].length;
    }

    // Remaining SQL after last GO (or entire script if no GO found)
    const remaining = sql.substring(lastIndex).trim();
    if (remaining) {
      batches.push(remaining);
    }

    return batches.length > 0 ? batches : [''];
  }

  /**
   * Check if the end of a SQL fragment is inside an unclosed string or block comment.
   */
  private isInsideStringOrComment(sql: string): boolean {
    let inSingleQuote = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i++) {
      if (inBlockComment) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inSingleQuote) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i++; // escaped quote
        } else if (sql[i] === "'") {
          inSingleQuote = false;
        }
        continue;
      }
      if (sql[i] === '-' && sql[i + 1] === '-') {
        // Single-line comment — skip to end of line
        const eol = sql.indexOf('\n', i);
        if (eol === -1) return false; // comment extends to end, GO is after it
        i = eol;
        continue;
      }
      if (sql[i] === '/' && sql[i + 1] === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      if (sql[i] === "'") {
        inSingleQuote = true;
      }
    }

    return inSingleQuote || inBlockComment;
  }

  /**
   * Check if a SQL batch starts with a statement that must be the first
   * statement in a batch (CREATE/ALTER VIEW, TRIGGER, PROCEDURE, FUNCTION, SCHEMA).
   */
  private requiresFirstInBatch(sql: string): boolean {
    const normalized = sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trimStart();
    return /^(CREATE|ALTER)\s+(VIEW|TRIGGER|PROC(EDURE)?|FUNCTION|SCHEMA)\b/i.test(normalized);
  }

  /**
   * Returns schema and table name if it's a single-table SELECT, null otherwise
   *
   * Matches patterns like:
   * - SELECT * FROM [schema].[table]
   * - SELECT * FROM schema.table
   * - SELECT * FROM [table]
   * - SELECT TOP n * FROM ...
   */
  private parseSimpleSelect(sql: string): ParsedTableRef | null {
    // Normalize whitespace and remove comments
    const normalized = sql
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
      .replace(/\s+/g, ' ')
      .trim();

    // Match SELECT ... FROM [schema].[table] or SELECT ... FROM schema.table
    // The regex captures the table reference after FROM
    // Support: [schema].[table], schema.table, [table], table
    const fromMatch = normalized.match(
      /^\s*SELECT\s+(?:TOP\s+\d+\s+)?(?:DISTINCT\s+)?(?:\*|[\w\s,[\].*]+)\s+FROM\s+(\[?[\w]+\]?(?:\.\[?[\w]+\]?)?)/i
    );

    if (!fromMatch) {
      return null;
    }

    // Check for JOINs or multiple tables - if found, we can't reliably determine the source
    if (
      /\bJOIN\b/i.test(normalized) ||
      /,\s*\[?[\w]+\]?(?:\.\[?[\w]+\]?)?\s+(?:AS\s+)?[\w]/i.test(
        normalized.substring(normalized.indexOf('FROM'))
      )
    ) {
      return null;
    }

    const tableRef = fromMatch[1];

    // Parse the table reference
    // Patterns: [schema].[table], schema.table, [schema].table, schema.[table], [table], table
    const parts = tableRef.split('.');

    if (parts.length === 1) {
      // Just table name, assume dbo schema (MSSQL default; PG/MySQL FK enrichment
      // uses the database name as schema, which is handled by the caller)
      const table = parts[0].replace(/^\[|\]$/g, '').replace(/^`|`$/g, '');
      return { schema: 'dbo', table };
    } else if (parts.length === 2) {
      // schema.table
      const schema = parts[0].replace(/^\[|\]$/g, '');
      const table = parts[1].replace(/^\[|\]$/g, '');
      return { schema, table };
    }

    return null;
  }
}
