/**
 * MySQL Database Provider
 *
 * Uses the 'mysql2/promise' driver for connection pooling and query execution.
 */

import mysql from 'mysql2/promise';
import type { Pool, PoolOptions, FieldPacket, ResultSetHeader } from 'mysql2/promise';
import type { ConnectionProfile, TestConnectionResult } from '@joinery/shared';
import { createLogger } from '../../../utils/logger';
import { DatabaseProvider, type ProviderQueryResult } from './database-provider';
import { MySQLDialect } from '../dialect/mysql-dialect';

const log = createLogger('MySQLProvider');

export class MySQLProvider extends DatabaseProvider {
  readonly engine = 'mysql' as const;
  readonly dialect = new MySQLDialect();

  private pool: Pool | null = null;

  get connected(): boolean {
    return this.pool !== null;
  }

  async connect(profile: ConnectionProfile, password: string): Promise<void> {
    const config: PoolOptions = {
      host: profile.server,
      port: profile.port,
      user: profile.username,
      password,
      database: profile.database || undefined,
      charset: profile.mysqlCollation || undefined,
      ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : undefined,
      connectTimeout: profile.connectionTimeout * 1000,
      connectionLimit: 10,
      waitForConnections: true,
      idleTimeout: 30000,
      multipleStatements: true,
    };

    this.pool = mysql.createPool(config);
    // Verify the connection works
    const conn = await this.pool.getConnection();
    conn.release();
    log.info(`Connected to MySQL at ${profile.server}:${profile.port}`);
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      log.info('Disconnected from MySQL');
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    password: string
  ): Promise<TestConnectionResult> {
    let testPool: Pool | null = null;
    try {
      testPool = mysql.createPool({
        host: profile.server,
        port: profile.port,
        user: profile.username,
        password,
        database: profile.database || undefined,
        charset: profile.mysqlCollation || undefined,
        ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : undefined,
        connectTimeout: profile.connectionTimeout * 1000,
        connectionLimit: 1,
      });

      const [rows] = await testPool.query('SELECT VERSION() AS version, DATABASE() AS name');
      const row = (rows as Record<string, unknown>[])[0];

      return {
        success: true,
        serverVersion: String(row?.version || 'Unknown'),
        serverName: String(row?.name || 'Unknown'),
      };
    } catch (error) {
      const err = error as Error & { code?: string; errno?: number };
      return {
        success: false,
        error: err.message,
        errorCode: err.code || 'UNKNOWN',
        guidance: this.getErrorGuidance(err),
      };
    } finally {
      if (testPool) {
        // Not swallowed: a pool that will not close is worth a line, even on a path that has
        // already produced its answer. The empty catch here predates the lint gap (J-128).
        await testPool.end().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log.debug(`Closing the MySQL test pool failed: ${message}`);
        });
      }
    }
  }

  async execute(sql: string, database?: string): Promise<ProviderQueryResult> {
    if (!this.pool) throw new Error('Not connected');

    // MySQL supports USE for database context switching (session-level)
    let fullSql = sql;
    if (database) {
      const safeDb = database.replace(/`/g, '``');
      fullSql = `USE \`${safeDb}\`;\n${sql}`;
    }

    const conn = await this.pool.getConnection();
    try {
      const [rawRows, rawFields] = await conn.query(fullSql);

      // mysql2 with multipleStatements returns arrays of results
      // Normalize to always work with arrays
      const isMultiResult =
        Array.isArray(rawRows) && rawRows.length > 0 && Array.isArray(rawRows[0]);

      const resultSets: Record<string, unknown>[][] = [];
      const columns: Record<string, unknown>[] = [];
      const rowsAffected: number[] = [];

      if (isMultiResult) {
        const multiRows = rawRows as unknown as unknown[][];
        const multiFields = rawFields as unknown as FieldPacket[][];

        for (let i = 0; i < multiRows.length; i++) {
          const rows = multiRows[i];
          const fields = multiFields[i];

          if (
            Array.isArray(rows) &&
            rows.length > 0 &&
            typeof rows[0] === 'object' &&
            !('affectedRows' in (rows[0] as object))
          ) {
            resultSets.push(rows as Record<string, unknown>[]);
            const colMeta: Record<string, unknown> = {};
            if (fields) {
              for (const f of fields) {
                colMeta[f.name] = {
                  type: { declaration: mysqlTypeToName(f.columnType) },
                  nullable: true,
                  length: f.columnLength || undefined,
                };
              }
            }
            columns.push(colMeta);
          }
          // Track affected rows for DML statements
          if (rows && typeof rows === 'object' && 'affectedRows' in (rows as object)) {
            rowsAffected.push((rows as unknown as ResultSetHeader).affectedRows);
          }
        }
      } else {
        // Single result
        const rows = rawRows;
        const fields = rawFields as FieldPacket[];

        if (Array.isArray(rows) && rows.length > 0) {
          resultSets.push(rows as Record<string, unknown>[]);
          const colMeta: Record<string, unknown> = {};
          if (fields) {
            for (const f of fields) {
              colMeta[f.name] = {
                type: { declaration: mysqlTypeToName(f.columnType) },
                nullable: true,
                length: f.columnLength || undefined,
              };
            }
          }
          columns.push(colMeta);
        }
        if (rows && typeof rows === 'object' && 'affectedRows' in (rows as object)) {
          rowsAffected.push((rows as unknown as ResultSetHeader).affectedRows);
        }
      }

      return { recordsets: resultSets, columns, rowsAffected };
    } finally {
      conn.release();
    }
  }

  cancelRequest(_requestRef: unknown): boolean {
    // MySQL supports KILL QUERY <threadId> but requires the connection's threadId
    // which is tracked at the QueryExecutor level
    return false;
  }

  getPool(): Pool | null {
    return this.pool;
  }

  private getErrorGuidance(error: Error & { code?: string; errno?: number }): string[] {
    switch (error.code) {
      case 'ECONNREFUSED':
        return [
          'Check that MySQL is running',
          'Verify the hostname and port are correct',
          'Check if a firewall is blocking the connection',
        ];
      case 'ER_ACCESS_DENIED_ERROR':
        return [
          'Check that the username is correct',
          'Check that the password is correct',
          'Ensure the user has access from this host',
        ];
      case 'ER_BAD_DB_ERROR':
        return ['The specified database does not exist', 'Check the database name'];
      case 'ETIMEDOUT':
      case 'ECONNRESET':
        return [
          'Connection timed out',
          'Verify the server is reachable',
          'Check network connectivity',
        ];
      default:
        return ['Check the error details and try again'];
    }
  }
}

/** Map MySQL column type constants to human-readable type names */
function mysqlTypeToName(typeId?: number): string {
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
