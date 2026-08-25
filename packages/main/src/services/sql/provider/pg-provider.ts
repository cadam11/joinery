/**
 * PostgreSQL Database Provider
 *
 * Uses the 'pg' (node-postgres) driver for connection pooling and query execution.
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import type { ConnectionProfile, TestConnectionResult } from '@joinery/shared';
import { createLogger } from '../../../utils/logger';
import { DatabaseProvider, type ProviderQueryResult } from './database-provider';
import { PgDialect } from '../dialect/pg-dialect';

const log = createLogger('PgProvider');

export class PgProvider extends DatabaseProvider {
  readonly engine = 'postgresql' as const;
  readonly dialect = new PgDialect();

  private pool: Pool | null = null;

  get connected(): boolean {
    return this.pool !== null;
  }

  async connect(profile: ConnectionProfile, password: string): Promise<void> {
    const config: PoolConfig = {
      host: profile.server,
      port: profile.port,
      user: profile.username,
      password,
      database: profile.database || 'postgres',
      ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : false,
      connectionTimeoutMillis: profile.connectionTimeout * 1000,
      query_timeout: (profile.requestTimeout || 30) * 1000,
      max: 10,
      idleTimeoutMillis: 30000,
    };

    this.pool = new Pool(config);
    // Verify the connection works
    const client = await this.pool.connect();
    client.release();
    log.info(`Connected to PostgreSQL at ${profile.server}:${profile.port}`);
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      log.info('Disconnected from PostgreSQL');
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    password: string
  ): Promise<TestConnectionResult> {
    let testPool: Pool | null = null;
    try {
      testPool = new Pool({
        host: profile.server,
        port: profile.port,
        user: profile.username,
        password,
        database: profile.database || 'postgres',
        ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : false,
        connectionTimeoutMillis: profile.connectionTimeout * 1000,
        max: 1,
      });

      const client = await testPool.connect();
      const result = await client.query('SELECT version() AS version, current_database() AS name');
      client.release();

      const row = result.rows[0];
      return {
        success: true,
        serverVersion: row?.version?.split(',')[0] || 'Unknown',
        serverName: row?.name || 'Unknown',
      };
    } catch (error) {
      const err = error as Error & { code?: string };
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
          log.debug(`Closing the PostgreSQL test pool failed: ${message}`);
        });
      }
    }
  }

  async execute(sql: string, database?: string): Promise<ProviderQueryResult> {
    if (!this.pool) throw new Error('Not connected');

    // PostgreSQL doesn't support USE — database is set at connection level.
    // If a different database is requested, we'd need a separate pool.
    // For now, ignore the database parameter (it's set at connect time).
    if (database) {
      log.debug(`PG ignores USE ${database} — database is set at connection time`);
    }

    const client: PoolClient = await this.pool.connect();
    try {
      const result = await client.query(sql);

      // pg returns a single result or an array for multi-statement queries
      const results = Array.isArray(result) ? result : [result];

      const recordsets: Record<string, unknown>[][] = [];
      const columns: Record<string, unknown>[] = [];
      const rowsAffected: number[] = [];

      for (const r of results) {
        if (r.rows && r.rows.length > 0) {
          recordsets.push(r.rows as Record<string, unknown>[]);
          // Build column metadata from fields
          const colMeta: Record<string, unknown> = {};
          if (r.fields) {
            for (const f of r.fields) {
              colMeta[f.name] = {
                type: { declaration: f.dataTypeID?.toString() || 'unknown' },
                nullable: true,
                length: f.dataTypeSize || undefined,
              };
            }
          }
          columns.push(colMeta);
        }
        rowsAffected.push(r.rowCount ?? 0);
      }

      return { recordsets, columns, rowsAffected };
    } finally {
      client.release();
    }
  }

  cancelRequest(_requestRef: unknown): boolean {
    // pg doesn't support per-request cancellation via the pool API
    // The caller would need to cancel via pg_cancel_backend
    return false;
  }

  getPool(): Pool | null {
    return this.pool;
  }

  private getErrorGuidance(error: Error & { code?: string }): string[] {
    switch (error.code) {
      case 'ECONNREFUSED':
        return [
          'Check that PostgreSQL is running',
          'Verify the hostname and port are correct',
          'Check if a firewall is blocking the connection',
        ];
      case '28P01': // invalid_password
      case '28000': // invalid_authorization_specification
        return [
          'Check that the username is correct',
          'Check that the password is correct',
          'Ensure the user has CONNECT privilege',
        ];
      case '3D000': // invalid_catalog_name (database doesn't exist)
        return ['The specified database does not exist', 'Check the database name'];
      default:
        return ['Check the error details and try again'];
    }
  }
}
