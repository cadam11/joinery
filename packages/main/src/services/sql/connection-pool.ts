/**
 * Connection Pool Manager
 * Manages database connection pools for multiple connections.
 * Supports SQL Server (mssql), PostgreSQL (pg), and MySQL (mysql2) engines.
 */

import type { EventEmitter } from 'node:events';
import mssql from 'mssql';
import pg from 'pg';
import type { ConnectionPool, config as SqlConfig, IResult } from 'mssql';
import type { Pool as PgPool } from 'pg';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import mysql from 'mysql2/promise';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { acquireTokenInteractive } from '../azure/entra-auth';
import type { ConnectionProfile, TestConnectionResult, DatabaseEngine } from '@joinery/shared';
import { describePasswordHygiene } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { ConnectionProfilesStore } from '../config/connection-profiles';
import { SshTunnelManager, type SshCredentials } from '../ssh/ssh-tunnel-manager';
import { splitTopLevelStatements } from './sql-statement-splitter';
import { getDialect, type SQLDialect } from './dialect';
import { auroraDsqlPoolOptions } from './aurora-dsql-pool-options';
import {
  mysqlPoolKey,
  mysqlPoolKeysForDatabase,
  mysqlPoolOptions,
  mysqlTestPoolOptions,
  type MySQLPoolTrust,
} from './mysql-pool-options';

const log = createLogger('PoolManager');

/**
 * Build the mssql config for a given profile and password.
 * Entra ID runs MSAL via loopback + system browser, pinned to the profile's
 * bound account (profile.azureHomeAccountId) so multi-account users don't
 * cross-contaminate profiles. onAccountBound is invoked with the resolved
 * homeAccountId whenever it changes from what the profile already had, so
 * the caller can persist it.
 */
async function buildMssqlConfig(
  profile: ConnectionProfile,
  password: string,
  database: string,
  timeouts: { connectionMs: number; requestMs: number },
  onAccountBound?: (homeAccountId: string) => Promise<void>
): Promise<SqlConfig> {
  const base: SqlConfig = {
    server: profile.server,
    port: profile.port,
    database,
    options: {
      encrypt: profile.encrypt,
      trustServerCertificate: profile.trustServerCertificate,
    },
    connectionTimeout: timeouts.connectionMs,
    requestTimeout: timeouts.requestMs,
  };

  if (profile.authenticationType === 'entra-id') {
    // Known v1 limitation: the access token is embedded statically into
    // the mssql config below. Azure AD tokens expire after 60–90 minutes,
    // and node-mssql/tedious has no callback for token refresh on
    // 'azure-active-directory-access-token'. Active connections keep
    // working past expiry, but new connections spawned by pool growth
    // (or after the 30s idle timeout) will fail auth. Workaround for
    // users: disconnect and reconnect; silent refresh from Keychain
    // makes that one click. Future fix: track expiry per pool and
    // recycle proactively, or invalidate on auth error and reconnect.
    log.info(
      `Acquiring Entra ID token (tenant=${profile.azureTenantId || 'organizations'}, boundAccount=${profile.azureHomeAccountId ?? '<none>'})...`
    );
    const { accessToken, homeAccountId } = await acquireTokenInteractive({
      tenantId: profile.azureTenantId,
      clientId: profile.azureClientId,
      homeAccountId: profile.azureHomeAccountId,
    });
    log.info(`Entra ID token acquired (length: ${accessToken.length})`);
    if (onAccountBound && homeAccountId !== profile.azureHomeAccountId) {
      await onAccountBound(homeAccountId);
    }
    return {
      ...base,
      authentication: {
        type: 'azure-active-directory-access-token' as const,
        options: { token: accessToken },
      },
    } as SqlConfig;
  }

  return {
    ...base,
    user: profile.username,
    password,
  };
}

function isEntraIdAuth(profile: ConnectionProfile): boolean {
  return profile.authenticationType === 'entra-id';
}

interface PoolEntry {
  pool: ConnectionPool;
  profileId: string;
  lastUsed: Date;
  activeQueries: number;
}

interface PgPoolEntry {
  pool: PgPool;
  profileId: string;
  lastUsed: Date;
  activeQueries: number;
}

interface MySQLPoolEntry {
  pool: MySQLPool;
  profileId: string;
  lastUsed: Date;
  activeQueries: number;
}

export class ConnectionPoolManager extends BaseSingleton {
  private pools: Map<string, PoolEntry> = new Map();
  private pgPools: Map<string, PgPoolEntry> = new Map();
  private mysqlPools: Map<string, MySQLPoolEntry> = new Map();
  // Cache: profileId → isAzureSQL. Cleared on disconnect.
  private azureCache: Map<string, boolean> = new Map();
  // Cache: profileId → is Aurora DSQL (postgresql variant). Cleared on disconnect.
  private dsqlCache: Map<string, boolean> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private profileStore: ConnectionProfilesStore;
  private sshTunnelManager: SshTunnelManager;

  constructor() {
    super();
    this.profileStore = ConnectionProfilesStore.getInstance();
    this.sshTunnelManager = SshTunnelManager.getInstance();
    this.startCleanupTimer();
  }

  /**
   * If the profile has SSH tunneling enabled, open a tunnel and return
   * a modified profile pointing at the local tunnel endpoint.
   * Otherwise, return the profile unchanged.
   */
  private async withTunnel(
    profile: ConnectionProfile,
    password?: string
  ): Promise<{ effectiveProfile: ConnectionProfile; tunnelOpened: boolean }> {
    if (!profile.sshTunnel?.enabled) {
      return { effectiveProfile: profile, tunnelOpened: false };
    }

    // For test connections (no real profile ID), use a temp key
    const tunnelKey = profile.id || `test-${Date.now()}`;

    // Store SSH credentials temporarily for test connections so tunnel manager can read them
    if (password !== undefined && profile.id === 'test-connection') {
      // For test connections, the SSH creds are passed through the profile store flow.
      // The tunnel manager reads from credential store, so we need them cached.
    }

    const endpoint = await this.sshTunnelManager.openTunnel(
      tunnelKey,
      profile.sshTunnel,
      profile.server,
      profile.port
    );

    return {
      effectiveProfile: { ...profile, server: endpoint.localHost, port: endpoint.localPort },
      tunnelOpened: true,
    };
  }

  private errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Attach the `'error'` listener every driver pool needs (J-175).
   *
   * A pool is a Node `EventEmitter`, and an `EventEmitter` with no `'error'` listener *rethrows*
   * the error from inside `emit()`. Pool errors arrive on a socket callback rather than on an
   * awaited promise, so that throw lands in the event loop as an uncaught exception — in the
   * main process, a crash of the whole app. This needs no bug to provoke:
   *
   * - pg-pool 3.14.0 `makeIdleListener` (`pg-pool/index.js:51-63`) removes the client from the
   *   pool and *then* calls `pool.emit('error', err, client)`. That is the path a server-side
   *   FATAL on an idle pooled connection takes — a Postgres restart, an admin
   *   `pg_terminate_backend`, or `DROP DATABASE … WITH (FORCE)`, including Joinery's own
   *   drop-database flow (all `57P01`).
   * - mssql 11.0.1 emits on the pool from its tedious connection's own `'error'` handler for
   *   anything that is not `ESOCKET` (`mssql/lib/tedious/connection-pool.js:101-107`), and from a
   *   failed `acquire()` (`mssql/lib/base/connection-pool.js:365-368`).
   *
   * Logging is the whole job: both drivers have already given up on the connection by the time
   * they emit, so the pool stays usable and opens a fresh connection on the next call.
   *
   * mysql2 pools are deliberately NOT guarded. `PromisePool` inherits only
   * `acquire | connection | enqueue | release` from the core pool
   * (`mysql2/lib/promise/pool.js:18`) and neither pool class ever emits `'error'`, so a listener
   * there would be unreachable code; its `PoolConnection` registers its own
   * (`mysql2/lib/pool_connection.js:14-16`).
   */
  private guardPoolErrors(pool: EventEmitter, label: string): void {
    pool.on('error', (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      log.error(`Pool error on ${label}${code ? ` [${code}]` : ''}: ${this.errMessage(err)}`);
    });
  }

  /**
   * Construct an AuroraDSQLPool for an aws-iam profile. Shared by getPgPool
   * (persistent pool) and testPgConnection (throwaway pool) so the two
   * paths can't drift on option names. The connector mints a fresh IAM
   * token per physical connection from the user's ~/.aws credentials —
   * nothing here reads from or writes to the Keychain.
   *
   * Option construction itself lives in the pure auroraDsqlPoolOptions
   * helper (aurora-dsql-pool-options.ts) so its security-critical
   * invariants — TLS validation always on, never built from a
   * tunnel-rewritten profile — are unit-testable without driver mocking.
   */
  private buildAuroraDsqlPool(
    profile: ConnectionProfile,
    dbName: string,
    poolOptions: { max: number; idleTimeoutMillis?: number; query_timeout?: number }
  ): AuroraDSQLPool {
    const pool = new AuroraDSQLPool(auroraDsqlPoolOptions(profile, dbName, poolOptions));
    this.guardPoolErrors(pool, `Aurora DSQL ${profile.name} (${dbName})`);
    return pool;
  }

  /**
   * If the SSH tunnel for a profile has been evicted (e.g. ssh2 keepalive
   * detected a dead bastion connection and fired 'close'), all DB pools that
   * were tunneling through it are stale — even if their `.connected` flag
   * still reports true, since the OS hasn't yet noticed the local socket is
   * dead. Tear them down so the next get*Pool call rebuilds them on a fresh
   * tunnel.
   */
  private async invalidateStalePoolsIfTunnelGone(profile: ConnectionProfile): Promise<void> {
    if (!profile.sshTunnel?.enabled) return;
    if (this.sshTunnelManager.hasTunnel(profile.id)) return;

    // The "no tunnel for this profile" condition is also true on the very
    // first connection — we don't want to log "tunnel is gone" then. Collect
    // affected pools first; only proceed (and log) if there's something to
    // actually invalidate.
    const mssqlEntry = this.pools.get(profile.id);
    const pgEntries = [...this.pgPools.entries()].filter(
      ([key]) => key === profile.id || key.startsWith(`${profile.id}:`)
    );
    const mysqlEntries = [...this.mysqlPools.entries()].filter(
      ([key]) => key === profile.id || key.startsWith(`${profile.id}:`)
    );

    if (!mssqlEntry && pgEntries.length === 0 && mysqlEntries.length === 0) return;

    log.info(`SSH tunnel for ${profile.id} is gone — discarding stale pools`);

    if (mssqlEntry) {
      try {
        await mssqlEntry.pool.close();
      } catch (err) {
        log.warn(`Failed to close stale mssql pool: ${this.errMessage(err)}`);
      }
      this.pools.delete(profile.id);
    }

    for (const [key, entry] of pgEntries) {
      try {
        await entry.pool.end();
      } catch (err) {
        log.warn(`Failed to close stale pg pool ${key}: ${this.errMessage(err)}`);
      }
      this.pgPools.delete(key);
    }

    for (const [key, entry] of mysqlEntries) {
      try {
        await entry.pool.end();
      } catch (err) {
        log.warn(`Failed to close stale mysql pool ${key}: ${this.errMessage(err)}`);
      }
      this.mysqlPools.delete(key);
    }
  }

  /**
   * Get the SQL dialect for a connection profile
   */
  getDialectForProfile(profileId: string): SQLDialect {
    const profile = this.profileStore.getById(profileId);
    const engine = profile?.engine || 'mssql';
    return getDialect(engine, this.isDsqlCached(profileId) ? 'dsql' : undefined);
  }

  /**
   * Get the database engine for a connection profile
   */
  getEngineForProfile(profileId: string): DatabaseEngine {
    const profile = this.profileStore.getById(profileId);
    return profile?.engine || 'mssql';
  }

  getProfileForId(profileId: string): ConnectionProfile | undefined {
    return this.profileStore.getById(profileId);
  }

  /**
   * Returns true when the connection is to Azure SQL Database (or Synapse).
   * Probes SERVERPROPERTY('EngineEdition') once per profile and caches the
   * result. Edition 5 = Azure SQL Database; 6 = Azure SQL Data Warehouse;
   * 8 = Azure SQL Managed Instance — we treat 5/6 as "Azure" since they
   * lack msdb. Managed Instance (8) HAS msdb, so it's treated as on-prem.
   * Non-mssql engines always return false.
   */
  async isAzureSQL(profileId: string): Promise<boolean> {
    const cached = this.azureCache.get(profileId);
    if (cached !== undefined) return cached;

    if (this.getEngineForProfile(profileId) !== 'mssql') {
      this.azureCache.set(profileId, false);
      return false;
    }

    // Use the base pool to probe (getPool without a database arg returns
    // the profileId-keyed pool, and resolveMssqlPoolKey shortcuts on
    // no-database so this doesn't recurse back into isAzureSQL).
    const pool = await this.getPool(profileId);
    const result = (await pool
      .request()
      .batch(`SELECT CAST(SERVERPROPERTY('EngineEdition') AS INT) AS edition`)) as IResult<{
      edition: number;
    }>;
    const edition = result.recordset[0]?.edition ?? 0;
    const isAzure = edition === 5 || edition === 6;
    this.azureCache.set(profileId, isAzure);
    log.info(`Engine edition for ${profileId}: ${edition} (isAzure=${isAzure})`);
    return isAzure;
  }

  /**
   * Probe whether a postgresql profile is an Aurora DSQL cluster.
   * sys.dsql_major_version() exists only on DSQL; on vanilla PostgreSQL the
   * call errors, which we interpret as "not DSQL". Result is cached per
   * profile and cleared on disconnect. Mirrors the isAzureSQL pattern.
   * aws-iam profiles skip the probe entirely — that auth type only exists
   * for DSQL, so the answer is always true.
   */
  async detectDsql(profileId: string): Promise<boolean> {
    const cached = this.dsqlCache.get(profileId);
    if (cached !== undefined) return cached;

    const profile = this.profileStore.getById(profileId);
    if (profile?.authenticationType === 'aws-iam') {
      // IAM auth is DSQL-only — no need to probe.
      this.dsqlCache.set(profileId, true);
      return true;
    }

    if (this.getEngineForProfile(profileId) !== 'postgresql') {
      this.dsqlCache.set(profileId, false);
      return false;
    }

    const pool = await this.getPgPool(profileId);
    let isDsql = false;
    try {
      await pool.query('SELECT * FROM sys.dsql_major_version()');
      isDsql = true;
    } catch (err) {
      // Expected on standard PostgreSQL — the probe function doesn't exist.
      log.debug(`DSQL probe negative for ${profileId}: ${this.errMessage(err)}`);
    }
    this.dsqlCache.set(profileId, isDsql);
    log.info(`DSQL detection for ${profileId}: ${isDsql}`);
    return isDsql;
  }

  /** Synchronous read of the cached DSQL detection (false until detectDsql ran). */
  isDsqlCached(profileId: string): boolean {
    return this.dsqlCache.get(profileId) === true;
  }

  /**
   * Cheap liveness check: SELECT 1 on the profile's pool. Used by the
   * renderer heartbeat via CONNECTION.PING. Throws on failure — the IPC
   * layer surfaces the rejection and the renderer treats it as "unhealthy".
   */
  async pingConnection(profileId: string): Promise<boolean> {
    const engine = this.getEngineForProfile(profileId);
    if (engine === 'postgresql') {
      const pool = await this.getPgPool(profileId);
      await pool.query('SELECT 1');
      return true;
    }
    if (engine === 'mysql') {
      const pool = await this.getMySQLPool(profileId);
      await pool.query('SELECT 1');
      return true;
    }
    await this.query(profileId, 'SELECT 1');
    return true;
  }

  /**
   * Compute the mssql pool key for (profileId, database). Used by getPool,
   * query, and batch so they all agree on which pool entry to look up
   * (preventing activeQueries-tracking drift). Per-DB keying is used only
   * for Azure SQL (where USE [db] is unsupported); on-prem SQL Server uses
   * a single base pool keyed at `profileId` with USE-switching at query time.
   */
  private async resolveMssqlPoolKey(profileId: string, database?: string): Promise<string> {
    if (!database) return profileId;
    const azure = await this.isAzureSQL(profileId);
    return azure ? `${profileId}:${database}` : profileId;
  }

  /**
   * Test a connection without creating a persistent pool.
   * Routes to the correct engine-specific test method.
   * Opens a temporary SSH tunnel if configured, and tears it down afterward.
   */
  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    sshCredentials?: SshCredentials
  ): Promise<TestConnectionResult> {
    log.info(`Testing ${profile.engine || 'mssql'} connection for profile: ${profile.name}`);
    log.debug(`Server: ${profile.server}:${profile.port}, User: ${profile.username}`);

    // Open SSH tunnel if configured (temporary, closed in finally)
    let tunnelKey: string | null = null;
    let effectiveProfile = profile;
    try {
      // aws-iam (Aurora DSQL) never tunnels: the connector needs the real
      // DSQL hostname both to parse the AWS region and to sign a SigV4
      // token for the actual endpoint. Guard here, before any tunnel is
      // opened, so a saved profile that already carries an enabled tunnel
      // fails with a clear message instead of wastefully opening a tunnel
      // and then failing deep inside the connector with a cryptic "can't
      // parse region from '127.0.0.1'" error.
      if (profile.authenticationType === 'aws-iam' && profile.sshTunnel?.enabled) {
        return {
          success: false,
          error:
            'SSH tunneling is not supported with AWS IAM authentication (Aurora DSQL uses a public TLS endpoint). Disable the SSH tunnel on this profile.',
          errorCode: 'SSH_TUNNEL_UNSUPPORTED',
          guidance: [
            'Disable the SSH tunnel on this profile',
            'Aurora DSQL uses a public, publicly-trusted TLS endpoint and does not need one',
          ],
        };
      }

      if (profile.sshTunnel?.enabled) {
        tunnelKey = `test-${Date.now()}`;
        const endpoint = await this.sshTunnelManager.openTunnel(
          tunnelKey,
          profile.sshTunnel,
          profile.server,
          profile.port,
          sshCredentials
        );
        effectiveProfile = { ...profile, server: endpoint.localHost, port: endpoint.localPort };
        log.info(`Test tunnel open on port ${endpoint.localPort}`);
      }

      if ((effectiveProfile.engine || 'mssql') === 'postgresql') {
        return await this.testPgConnection(effectiveProfile, password || '');
      }

      if ((effectiveProfile.engine || 'mssql') === 'mysql') {
        return await this.testMySQLConnection(effectiveProfile, password || '');
      }

      // Default: SQL Server
      return await this.testMssqlConnection(effectiveProfile, password || '');
    } catch (error) {
      const err = error as Error;
      // Only label SSH_TUNNEL_ERROR when a tunnel is actually configured —
      // this catch also sees pre-connect throws from the engine test methods,
      // and SSH guidance for a profile with no tunnel misdirects the user.
      if (profile.sshTunnel?.enabled) {
        return {
          success: false,
          error: err.message,
          errorCode: 'SSH_TUNNEL_ERROR',
          guidance: ['Check your SSH tunnel settings', 'Verify the SSH host is reachable'],
        };
      }
      return {
        success: false,
        error: err.message,
        errorCode: 'TEST_FAILED',
        guidance: ['Check the error details and try again'],
      };
    } finally {
      if (tunnelKey) {
        try {
          await this.sshTunnelManager.closeTunnel(tunnelKey);
        } catch (err) {
          log.warn(`Failed to close test tunnel ${tunnelKey}: ${this.errMessage(err)}`);
        }
      }
    }
  }

  /**
   * Test a SQL Server connection
   */
  private async testMssqlConnection(
    profile: ConnectionProfile,
    password: string
  ): Promise<TestConnectionResult> {
    const testDb = profile.database || 'master';
    let pool: ConnectionPool | null = null;

    try {
      // Inside the try so config-stage failures (e.g. a cancelled Entra ID
      // browser login) are categorized here instead of escaping to the outer
      // testConnection catch and being mislabeled as tunnel/test errors.
      const config = await buildMssqlConfig(profile, password, testDb, {
        connectionMs: profile.connectionTimeout * 1000,
        requestMs: 10000,
      });

      log.debug(
        `Config: encrypt=${config.options?.encrypt}, trustCert=${config.options?.trustServerCertificate}, auth=${profile.authenticationType}`
      );

      pool = new mssql.ConnectionPool(config);
      this.guardPoolErrors(pool, `SQL Server probe ${profile.name}`);
      log.debug('Attempting test connection...');
      await pool.connect();
      log.info('Test connection successful');

      const result = await pool.request().query<{
        version: string;
        name: string;
      }>('SELECT @@VERSION as version, @@SERVERNAME as name');

      const row = result.recordset[0];

      return {
        success: true,
        serverVersion: row?.version?.split('\n')[0] || 'Unknown',
        serverName: row?.name || 'Unknown',
      };
    } catch (error) {
      const err = error as Error & { code?: string; number?: number };
      const categorized = this.categorizeError(err, password);
      return {
        success: false,
        error: categorized.message,
        errorCode: categorized.code,
        guidance: categorized.guidance,
      };
    } finally {
      if (pool) {
        try {
          await pool.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Test a PostgreSQL connection
   */
  private async testPgConnection(
    profile: ConnectionProfile,
    password: string
  ): Promise<TestConnectionResult> {
    let testPool: PgPool | null = null;
    try {
      // aws-iam (Aurora DSQL): the `password` param (always '' for these
      // profiles, since testConnection's callers never touch the Keychain
      // for aws-iam) is ignored on this branch.
      if (profile.authenticationType === 'aws-iam') {
        testPool = this.buildAuroraDsqlPool(profile, profile.database || 'postgres', { max: 1 });
      } else {
        testPool = new pg.Pool({
          host: profile.server,
          port: profile.port,
          user: profile.username,
          password,
          database: profile.database || 'postgres',
          ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : false,
          connectionTimeoutMillis: profile.connectionTimeout * 1000,
          max: 1,
        });
        this.guardPoolErrors(testPool, `PostgreSQL probe ${profile.name}`);
      }

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
      const err = error as Error & { code?: string; name?: string };
      return {
        success: false,
        error: err.message,
        errorCode: err.code || 'UNKNOWN',
        guidance: this.categorizePgError(err, profile, password),
      };
    } finally {
      if (testPool) {
        try {
          await testPool.end();
        } catch (err) {
          log.warn(`Failed to close test pg pool: ${this.errMessage(err)}`);
        }
      }
    }
  }

  /**
   * Get a PostgreSQL pool for a profile.
   * PG sets database at the connection level, so a separate pool is created
   * per database. The pool key includes the database name.
   * All PG pools for a profile share the same SSH tunnel.
   */
  async getPgPool(profileId: string, database?: string): Promise<PgPool> {
    const profile = this.profileStore.getById(profileId);
    if (!profile) throw new Error('Connection profile not found');

    await this.invalidateStalePoolsIfTunnelGone(profile);

    const dbName = database || profile.database || 'postgres';
    const poolKey = `${profileId}:${dbName}`;

    const existing = this.pgPools.get(poolKey);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.pool;
    }

    // aws-iam (Aurora DSQL): nothing is read from or written to the
    // Keychain for these profiles. This branch MUST stay ahead of the
    // getPassword() call below, which throws when no Keychain password
    // exists (never the case for aws-iam). It also never tunnels — SSH
    // tunneling rewrites server/port to a local loopback address, which
    // breaks both the connector's region-from-hostname parsing and the
    // SigV4 signature (signed for the wrong host). Guard here, before any
    // tunnel is opened and before the pool is built, so a saved profile
    // that already carries an enabled tunnel fails loudly instead of
    // reaching the connector with a tunneled host.
    let pool: PgPool;
    if (profile.authenticationType === 'aws-iam') {
      if (profile.sshTunnel?.enabled) {
        throw new Error(
          'SSH tunneling is not supported with AWS IAM authentication (Aurora DSQL uses a public TLS endpoint). Disable the SSH tunnel on this profile.'
        );
      }
      pool = this.buildAuroraDsqlPool(profile, dbName, {
        max: 10,
        idleTimeoutMillis: 30000,
        query_timeout: (profile.requestTimeout || 30) * 1000,
      });
    } else {
      // Open SSH tunnel if configured (reuses existing tunnel for this profileId)
      const { effectiveProfile } = await this.withTunnel(profile);
      const password = await this.profileStore.getPassword(profileId);
      if (!password) throw new Error('Connection password not found in Keychain');
      pool = new pg.Pool({
        host: effectiveProfile.server,
        port: effectiveProfile.port,
        user: effectiveProfile.username,
        password,
        database: dbName,
        ssl: effectiveProfile.encrypt
          ? { rejectUnauthorized: !effectiveProfile.trustServerCertificate }
          : false,
        connectionTimeoutMillis: effectiveProfile.connectionTimeout * 1000,
        query_timeout: (effectiveProfile.requestTimeout || 30) * 1000,
        max: 10,
        idleTimeoutMillis: 30000,
      });
      this.guardPoolErrors(pool, `PostgreSQL ${profile.name} (${dbName})`);
    }

    // Verify connection
    const client = await pool.connect();
    client.release();

    this.pgPools.set(poolKey, {
      pool,
      profileId,
      lastUsed: new Date(),
      activeQueries: 0,
    });

    log.info(`Connected to PostgreSQL: ${profile.name}`);
    return pool;
  }

  /**
   * Test a MySQL connection
   */
  private async testMySQLConnection(
    profile: ConnectionProfile,
    password: string
  ): Promise<TestConnectionResult> {
    let testPool: MySQLPool | null = null;
    try {
      // Options from the shared builder (J-149), not a local literal: the copy
      // that used to live here had already drifted from mysqlPoolOptions.
      testPool = mysql.createPool(mysqlTestPoolOptions(profile, password));

      const [rows] = await testPool.query('SELECT VERSION() AS version, DATABASE() AS name');
      const row = (rows as Record<string, unknown>[])[0];

      return {
        success: true,
        serverVersion: String(row?.version || 'Unknown'),
        serverName: String(row?.name || 'Unknown'),
      };
    } catch (error) {
      const err = error as Error & { code?: string };
      return {
        success: false,
        error: err.message,
        errorCode: err.code || 'UNKNOWN',
        guidance: this.categorizeMySQLError(err, password),
      };
    } finally {
      if (testPool) {
        try {
          await testPool.end();
        } catch (err) {
          log.warn(`Failed to close test mysql pool: ${this.errMessage(err)}`);
        }
      }
    }
  }

  /**
   * Get a MySQL pool for a profile, at a given trust level (J-137).
   *
   * MySQL supports USE for database switching, but we still create pools per
   * database for consistency with the PG pattern and connection isolation.
   * All MySQL pools for a profile share the same SSH tunnel.
   *
   * There are two pools per (profile, database) because `multipleStatements`
   * is a handshake capability, not a per-query option — see
   * mysql-pool-options.ts for the full reasoning. `'restricted'` is the
   * default: only the query editor, which sends a whole user-authored script
   * in one call, asks for `'script'`. Both pools are opened lazily, so a
   * profile only ever pays for the trust levels it actually uses.
   */
  async getMySQLPool(
    profileId: string,
    database?: string,
    trust: MySQLPoolTrust = 'restricted'
  ): Promise<MySQLPool> {
    const profile = this.profileStore.getById(profileId);
    if (!profile) throw new Error('Connection profile not found');

    await this.invalidateStalePoolsIfTunnelGone(profile);

    const dbName = database || profile.database || undefined;
    const poolKey = mysqlPoolKey(profileId, dbName, trust);

    const existing = this.mysqlPools.get(poolKey);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.pool;
    }

    const password = await this.profileStore.getPassword(profileId);
    if (!password) throw new Error('Connection password not found in Keychain');

    // Open SSH tunnel if configured (reuses existing tunnel for this profileId)
    const { effectiveProfile } = await this.withTunnel(profile);

    const pool = mysql.createPool(mysqlPoolOptions(effectiveProfile, dbName, trust, password));

    // Verify connection
    const conn = await pool.getConnection();
    conn.release();

    this.mysqlPools.set(poolKey, {
      pool,
      profileId,
      lastUsed: new Date(),
      activeQueries: 0,
    });

    log.info(`Connected to MySQL: ${profile.name} (${dbName}, ${trust})`);
    return pool;
  }

  /**
   * Get or create a SQL Server connection pool for a profile.
   * Opens an SSH tunnel first if the profile has one configured.
   */
  async getPool(profileId: string, database?: string): Promise<ConnectionPool> {
    const profile = this.profileStore.getById(profileId);
    if (!profile) {
      log.error(`Profile not found: ${profileId}`);
      throw new Error('Connection profile not found');
    }

    // If the SSH tunnel died and got evicted, the cached pool is stale even if
    // it still reports connected. Drop it before checking for reuse.
    await this.invalidateStalePoolsIfTunnelGone(profile);

    // Azure SQL Database requires per-database pools (USE [db] is not supported).
    // On-prem SQL Server uses a single base pool keyed at profileId with
    // USE-switching at query time. resolveMssqlPoolKey is the single source
    // of truth — query()/batch() use it too, so activeQueries tracking
    // always points at the right entry.
    const poolKey = await this.resolveMssqlPoolKey(profileId, database);

    log.debug(`Getting pool: key=${poolKey}`);

    const existing = this.pools.get(poolKey);
    if (existing?.pool.connected) {
      log.debug(`Reusing existing pool: ${poolKey}`);
      existing.lastUsed = new Date();
      return existing.pool;
    }

    log.debug(`Creating new pool: ${poolKey}`);

    const needsPassword = !isEntraIdAuth(profile);
    const password = needsPassword ? await this.profileStore.getPassword(profileId) : '';
    if (needsPassword && !password) {
      log.error(`Password not found in keychain for: ${profileId}`);
      throw new Error('Connection password not found in Keychain');
    }

    const { effectiveProfile } = await this.withTunnel(profile);

    // Per-DB pool key has the form 'profileId:database'; base pool key is
    // just profileId and connects to the profile's default database.
    const targetDb =
      poolKey === profileId ? effectiveProfile.database || 'master' : (database as string);
    const config: SqlConfig = {
      ...(await buildMssqlConfig(
        effectiveProfile,
        password || '',
        targetDb,
        {
          connectionMs: effectiveProfile.connectionTimeout * 1000,
          requestMs: (effectiveProfile.requestTimeout || 30) * 1000,
        },
        async homeAccountId => {
          const ok = await this.profileStore.setAzureHomeAccountId(profileId, homeAccountId);
          if (!ok)
            log.warn(`Failed to persist Entra account binding: profile ${profileId} not found`);
        }
      )),
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    log.debug(
      `Pool config: server=${config.server}:${config.port}, db=${targetDb}, auth=${effectiveProfile.authenticationType}`
    );

    const pool = new mssql.ConnectionPool(config);
    this.guardPoolErrors(pool, `SQL Server ${profile.name} (${targetDb})`);
    await pool.connect();
    log.info(`Connected to ${profile.name} (db: ${targetDb})`);

    this.pools.set(poolKey, {
      pool,
      profileId,
      lastUsed: new Date(),
      activeQueries: 0,
    });

    return pool;
  }

  /**
   * Execute a query on a connection
   */
  async query<T>(profileId: string, sql: string, database?: string): Promise<IResult<T>> {
    const poolKey = await this.resolveMssqlPoolKey(profileId, database);
    const pool = await this.getPool(profileId, database);
    const finalSql = this.adaptSqlForPool(sql, poolKey, profileId, database);

    const entry = this.pools.get(poolKey);
    if (entry) entry.activeQueries++;

    try {
      return (await pool.request().batch(finalSql)) as IResult<T>;
    } finally {
      if (entry) {
        entry.activeQueries--;
        entry.lastUsed = new Date();
      }
    }
  }

  /**
   * Execute a query on a SQL Server connection with bound parameters.
   *
   * `params[0]` binds to `@p0`, `params[1]` to `@p1`, and so on — the caller
   * writes those names into the SQL.
   *
   * Uses `request.query()` rather than the `request.batch()` that `query`
   * above uses, because node-mssql implements the two differently: `batch()`
   * with parameters *inlines* them, prepending a
   * `declare @p0 …;select @p0 = N'…';` prologue built by `cast()` (see
   * `node_modules/mssql/lib/tedious/request.js`, the `_isBatch` branch, and
   * `lib/datatypes.js`), whereas `query()` hands them to tedious as real
   * `sp_executesql` bind values. Only the latter is parameterisation.
   *
   * The `USE [db];` prefix `adaptSqlForPool` adds still applies: it runs
   * inside the `sp_executesql` batch, ahead of the statement, and was
   * verified against the harness SQL Server.
   */
  async queryWithParams<T>(
    profileId: string,
    sql: string,
    params: readonly unknown[],
    database?: string
  ): Promise<IResult<T>> {
    const poolKey = await this.resolveMssqlPoolKey(profileId, database);
    const pool = await this.getPool(profileId, database);
    const finalSql = this.adaptSqlForPool(sql, poolKey, profileId, database);

    const entry = this.pools.get(poolKey);
    if (entry) entry.activeQueries++;

    try {
      const request = pool.request();
      params.forEach((value, i) => request.input(`p${i}`, value));
      return (await request.query(finalSql)) as IResult<T>;
    } finally {
      if (entry) {
        entry.activeQueries--;
        entry.lastUsed = new Date();
      }
    }
  }

  /**
   * Execute a batch of statements (for DDL operations).
   * If `database` is provided, routes via the same per-DB pool path the
   * `query` method uses, so DDL on Azure SQL targets the right database
   * (Azure has no USE support to fall back on).
   */
  async batch(profileId: string, sql: string, database?: string): Promise<void> {
    const poolKey = await this.resolveMssqlPoolKey(profileId, database);
    const pool = await this.getPool(profileId, database);
    const finalSql = this.adaptSqlForPool(sql, poolKey, profileId, database);

    const entry = this.pools.get(poolKey);
    if (entry) entry.activeQueries++;

    try {
      await pool.request().batch(finalSql);
    } finally {
      if (entry) {
        entry.activeQueries--;
        entry.lastUsed = new Date();
      }
    }
  }

  /**
   * Adjust the outgoing SQL to match the pool we're routing it to.
   *
   *  - On the on-prem path (poolKey === profileId), prepend `USE [db]` so
   *    a shared pool can switch database context per-query.
   *  - On the Azure path (poolKey === `${profileId}:${database}`), the pool
   *    is already connected to the right DB AND Azure SQL rejects USE
   *    outright. Strip any leading `USE [..];` the SQL generator embedded
   *    (TsqlBuilder.listSchemas/listTables/etc. all do) so those metadata
   *    queries actually run on Azure. The strip only touches a single
   *    leading USE statement; mid-query USEs (uncommon) are left alone.
   */
  private adaptSqlForPool(
    sql: string,
    poolKey: string,
    profileId: string,
    database?: string
  ): string {
    if (!database) return sql;

    if (poolKey === profileId) {
      const safeDb = database.replace(/\]/g, ']]');
      return `USE [${safeDb}];\n${sql}`;
    }

    // Azure per-DB pool: drop a single leading USE [..]; if present.
    // Bracket content allows escaped `]]` so DB names with `]` survive.
    return sql.replace(/^\s*USE\s+\[(?:[^\]]|\]\])*\]\s*;?\s*/i, '');
  }

  /**
   * Execute DDL statements on any engine (MSSQL or PostgreSQL).
   * Routes to the correct pool based on the connection's engine.
   */
  async executeDDL(profileId: string, sql: string, database?: string): Promise<void> {
    const engine = this.getEngineForProfile(profileId);

    if (engine === 'postgresql') {
      const pool = await this.getPgPool(profileId, database);
      const client = await pool.connect();
      try {
        // Postgres' simple query protocol wraps a multi-statement string
        // in a single implicit transaction, but DROP DATABASE / CREATE
        // DATABASE / a few other commands cannot run inside a transaction
        // block. The dialect emits multi-statement DDL for "kick connections
        // then DROP DATABASE" and "kick connections then ALTER DATABASE
        // RENAME", so we split on top-level ; and run each statement as its
        // own client.query() call — every individual statement is then its
        // own auto-commit transaction.
        for (const statement of splitTopLevelStatements(sql)) {
          await client.query(statement);
        }
      } finally {
        client.release();
      }
      return;
    }

    if (engine === 'mysql') {
      // Script trust (J-137), deliberately. DDL arrives here either dialect-built
      // from database.ipc.ts or as raw SQL through the AI `execute_ddl` tool,
      // which is confirmation-gated — the user has seen and approved the exact
      // text. Multi-statement DDL scripts are a legitimate thing to approve, and
      // the PostgreSQL arm above already runs them (it splits and loops). The
      // unconfirmed AI path, `execute_query`, goes through ToolRegistry.queryAny
      // and gets the restricted pool.
      const pool = await this.getMySQLPool(profileId, database, 'script');
      const conn = await pool.getConnection();
      try {
        await conn.query(sql);
      } finally {
        conn.release();
      }
      return;
    }

    // Default: SQL Server
    await this.batch(profileId, sql, database);
  }

  /**
   * Close a specific connection pool (SQL Server, PostgreSQL, or MySQL)
   * and its associated SSH tunnel if any.
   */
  async closePool(profileId: string): Promise<void> {
    // Each step is wrapped in try/catch so closePool never rejects, regardless
    // of what individual pool/tunnel close calls do. Callers (cleanup timer,
    // closeAll, IPC disconnect) rely on this — fire-and-forget at the cleanup
    // timer would crash the Electron main process under Node 20's
    // unhandled-rejection default if any step here propagated a rejection.
    this.azureCache.delete(profileId);
    this.dsqlCache.delete(profileId);

    // MSSQL pools may be keyed as "profileId" (on-prem, single pool) or
    // "profileId:dbName" (Entra/Azure SQL per-database pools). Iterate so
    // both shapes are cleaned up — matches the PG/MySQL handling below.
    for (const [key, entry] of this.pools) {
      if (key === profileId || key.startsWith(`${profileId}:`)) {
        try {
          await entry.pool.close();
        } catch (err) {
          log.warn(`Failed to close mssql pool ${key}: ${this.errMessage(err)}`);
        }
        this.pools.delete(key);
      }
    }

    for (const [key, pgEntry] of this.pgPools) {
      if (key === profileId || key.startsWith(`${profileId}:`)) {
        try {
          await pgEntry.pool.end();
        } catch (err) {
          log.warn(`Failed to close pg pool ${key}: ${this.errMessage(err)}`);
        }
        this.pgPools.delete(key);
      }
    }

    for (const [key, mysqlEntry] of this.mysqlPools) {
      if (key === profileId || key.startsWith(`${profileId}:`)) {
        try {
          await mysqlEntry.pool.end();
        } catch (err) {
          log.warn(`Failed to close mysql pool ${key}: ${this.errMessage(err)}`);
        }
        this.mysqlPools.delete(key);
      }
    }

    // Close SSH tunnel for this profile
    try {
      await this.sshTunnelManager.closeTunnel(profileId);
    } catch (err) {
      log.warn(`Failed to close SSH tunnel for ${profileId}: ${this.errMessage(err)}`);
    }

    // Azure credential cache is keyed by server config, not profileId.
    // We keep it so reconnecting reuses the cached token without a browser popup.
  }

  /**
   * Release Joinery's own pooled connections to a single database on a profile,
   * without tearing down the rest of the profile's pools or its SSH tunnel.
   *
   * This is the missing piece behind "can't delete/restore a database that's
   * expanded in the explorer or has query windows open": those affordances
   * keep a live pool to the target database, and DROP DATABASE / RESTORE WITH
   * REPLACE both require exclusive access. The drop/restore SQL kicks
   * *external* sessions, but not Joinery's own pool — so we must let go here
   * first. Every pool reconnects lazily on next use, so this is non-destructive
   * from the user's perspective (no app restart needed).
   *
   * Never rejects — each close is wrapped so callers can fire it inline before
   * the DDL without risking an unhandled rejection.
   */
  async closePoolForDatabase(profileId: string, database: string): Promise<void> {
    if (database === '__base__' || !database) return;

    const engine = this.getEngineForProfile(profileId);

    if (engine === 'postgresql') {
      const key = `${profileId}:${database}`;
      const entry = this.pgPools.get(key);
      if (entry) {
        try {
          await entry.pool.end();
        } catch (err) {
          log.warn(`Failed to close pg pool ${key} for database release: ${this.errMessage(err)}`);
        }
        this.pgPools.delete(key);
      }
      return;
    }

    if (engine === 'mysql') {
      // Both trust levels, or DROP DATABASE still fails: the editor's script
      // pool holds connections to the same database as the restricted one.
      for (const key of mysqlPoolKeysForDatabase(profileId, database)) {
        const entry = this.mysqlPools.get(key);
        if (!entry) continue;
        try {
          await entry.pool.end();
        } catch (err) {
          log.warn(
            `Failed to close mysql pool ${key} for database release: ${this.errMessage(err)}`
          );
        }
        this.mysqlPools.delete(key);
      }
      return;
    }

    // MSSQL. Azure uses a per-database pool (profileId:db); on-prem shares a
    // single pool (profileId) across databases with USE-switching, so there's
    // no way to release one database's connections selectively — close the
    // shared pool, which reconnects lazily on the next query. Close whichever
    // key shape is present.
    for (const key of [`${profileId}:${database}`, profileId]) {
      const entry = this.pools.get(key);
      if (entry) {
        try {
          await entry.pool.close();
        } catch (err) {
          log.warn(
            `Failed to close mssql pool ${key} for database release: ${this.errMessage(err)}`
          );
        }
        this.pools.delete(key);
      }
    }
  }

  /**
   * Close all connection pools (SQL Server + PostgreSQL)
   */
  async closeAll(): Promise<void> {
    const mssqlCloses = Array.from(this.pools.keys()).map(id => this.closePool(id));
    const pgCloses = Array.from(this.pgPools.keys()).map(async id => {
      const entry = this.pgPools.get(id);
      if (entry) {
        try {
          await entry.pool.end();
        } catch (err) {
          log.warn(`Failed to close pg pool ${id} during shutdown: ${this.errMessage(err)}`);
        }
        this.pgPools.delete(id);
      }
    });
    const mysqlCloses = Array.from(this.mysqlPools.keys()).map(async id => {
      const entry = this.mysqlPools.get(id);
      if (entry) {
        try {
          await entry.pool.end();
        } catch (err) {
          log.warn(`Failed to close mysql pool ${id} during shutdown: ${this.errMessage(err)}`);
        }
        this.mysqlPools.delete(id);
      }
    });
    await Promise.all([...mssqlCloses, ...pgCloses, ...mysqlCloses]);
    try {
      await this.sshTunnelManager.closeAll();
    } catch (err) {
      log.warn(`Failed to close all SSH tunnels during shutdown: ${this.errMessage(err)}`);
    }
  }

  /**
   * Check if a connection is active
   */
  isConnected(profileId: string): boolean {
    // MSSQL pools may be keyed as profileId (on-prem base) or
    // 'profileId:dbName' (Azure per-DB). Either counts as connected.
    for (const [key, entry] of this.pools) {
      if ((key === profileId || key.startsWith(`${profileId}:`)) && entry.pool.connected) {
        return true;
      }
    }
    // PG pools are keyed as 'profileId:dbName' too — match the same pattern.
    for (const [key, entry] of this.pgPools) {
      if (key === profileId || key.startsWith(`${profileId}:`)) {
        if (entry != null) return true;
      }
    }
    // MySQL pools: any pool for this profile counts.
    for (const key of this.mysqlPools.keys()) {
      if (key === profileId || key.startsWith(`${profileId}:`)) return true;
    }
    return false;
  }

  /**
   * Guidance for a failed username/password login, shared by all three engines.
   * Appends paste-artifact findings for the password that was actually sent to
   * the server — the form-entered value, or the keychain-stored one when a
   * saved profile was tested with a blank password field — plus its character
   * count. Advisory only; never echoes the value.
   */
  private authFailedGuidance(password: string | undefined, engineHint: string): string[] {
    const guidance = [
      'Check that the username is correct',
      'Check that the password is correct',
      engineHint,
    ];
    if (password !== undefined) {
      guidance.push(...describePasswordHygiene(password, { includeLength: true }));
    }
    return guidance;
  }

  /**
   * Categorize connection errors for user-friendly messages
   */
  private categorizeError(
    error: Error & { code?: string; number?: number },
    password?: string
  ): {
    code: string;
    message: string;
    guidance: string[];
  } {
    // SQL Server login failure. Server error 18456 reaches us in two shapes:
    // a query-time RequestError carrying `number`, or — the test-connection
    // case — a tedious ConnectionError from pool.connect() carrying only
    // code 'ELOGIN' (tedious never copies the server error number onto it).
    if (error.number === 18456 || error.code === 'ELOGIN') {
      return {
        code: 'AUTH_FAILED',
        message: 'Login failed',
        guidance: this.authFailedGuidance(password, 'Ensure the login has permission to connect'),
      };
    }
    return this.categorizeMssqlInfraError(error);
  }

  /**
   * Non-auth MSSQL failures: network, timeout, certificate, and the fallback.
   */
  private categorizeMssqlInfraError(error: Error & { code?: string; number?: number }): {
    code: string;
    message: string;
    guidance: string[];
  } {
    const code = error.code || error.number?.toString() || 'UNKNOWN';
    const message = error.message;

    if (error.code === 'ESOCKET' || error.code === 'ECONNREFUSED') {
      return {
        code: 'CONNECTION_REFUSED',
        message: 'Cannot connect to server',
        guidance: [
          'Check that SQL Server is running',
          'Verify the hostname and port are correct',
          'Check if a firewall is blocking the connection',
          'For Docker: ensure the container is running and port is exposed',
        ],
      };
    }

    if (error.code === 'ETIMEOUT') {
      return {
        code: 'TIMEOUT',
        message: 'Connection timed out',
        guidance: [
          'The server took too long to respond',
          'Check network connectivity',
          'Try increasing the connection timeout',
        ],
      };
    }

    if (message.includes('certificate')) {
      return {
        code: 'CERTIFICATE_ERROR',
        message: 'Certificate validation failed',
        guidance: [
          'Enable "Trust server certificate" for development servers',
          'For production, ensure the server has a valid certificate',
        ],
      };
    }

    return {
      code,
      message,
      guidance: ['Check the error details and try again'],
    };
  }

  /**
   * True when an error looks like a failure to mint AWS credentials rather
   * than a database-level rejection — the AWS SDK's CredentialsProviderError
   * name, or wording it (and expired-SSO-session errors) surface in message
   * text. Only meaningful for aws-iam profiles; callers gate on that first.
   */
  private isAwsCredentialError(error: Error & { name?: string }): boolean {
    if (error.name === 'CredentialsProviderError') return true;
    const message = error.message.toLowerCase();
    return (
      message.includes('could not load credentials') ||
      message.includes('expired') ||
      message.includes('sso')
    );
  }

  /**
   * Categorize PostgreSQL connection errors for user-friendly messages.
   * `profile` routes aws-iam credential failures to aws-sso-login guidance;
   * `password` feeds paste-artifact hygiene hints on auth failures. Both are
   * optional so existing callers compile; pass whatever is available.
   */
  private categorizePgError(
    error: Error & { code?: string; name?: string },
    profile?: ConnectionProfile,
    password?: string
  ): string[] {
    if (profile?.authenticationType === 'aws-iam' && this.isAwsCredentialError(error)) {
      const awsProfile = profile.awsProfile || 'default';
      return [
        `AWS credentials for profile '${awsProfile}' are missing or expired`,
        `If you use SSO, run: aws sso login --profile ${awsProfile}`,
        'Then retry the connection',
      ];
    }

    switch (error.code) {
      case 'ECONNREFUSED':
        return [
          'Check that PostgreSQL is running',
          'Verify the hostname and port are correct',
          'Check if a firewall is blocking the connection',
          'For Docker: ensure the container is running and port is exposed',
        ];
      case '28P01': // invalid_password
      case '28000': // invalid_authorization_specification
        return this.authFailedGuidance(
          password,
          'Ensure the user has CONNECT privilege on the database'
        );
      case '3D000': // invalid_catalog_name
        return ['The specified database does not exist', 'Check the database name'];
      case 'ETIMEOUT':
        return [
          'The server took too long to respond',
          'Check network connectivity',
          'Try increasing the connection timeout',
        ];
      default:
        return ['Check the error details and try again'];
    }
  }

  /**
   * Categorize MySQL connection errors for user-friendly messages
   */
  private categorizeMySQLError(error: Error & { code?: string }, password?: string): string[] {
    switch (error.code) {
      case 'ECONNREFUSED':
        return [
          'Check that MySQL is running',
          'Verify the hostname and port are correct',
          'Check if a firewall is blocking the connection',
          'For Docker: ensure the container is running and port is exposed',
        ];
      case 'ER_ACCESS_DENIED_ERROR':
        return this.authFailedGuidance(password, 'Ensure the user has access from this host');
      case 'ER_BAD_DB_ERROR':
        return ['The specified database does not exist', 'Check the database name'];
      case 'ETIMEDOUT':
      case 'ECONNRESET':
        return [
          'The server took too long to respond',
          'Check network connectivity',
          'Try increasing the connection timeout',
        ];
      default:
        return ['Check the error details and try again'];
    }
  }

  /**
   * Start cleanup timer for idle connections
   */
  private startCleanupTimer(): void {
    // Clean up idle connections every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        const now = new Date();
        for (const [id, entry] of this.pools) {
          const idleMs = now.getTime() - entry.lastUsed.getTime();
          if (idleMs > 600000 && entry.activeQueries === 0) {
            // closePool wraps every step in try/catch internally — it cannot
            // reject — so `void` is safe here. For the direct pg/mysql end()
            // calls below, we attach a .catch handler because those CAN reject
            // (e.g. on a stale pool) and an unhandled rejection in this
            // setInterval callback would crash the Electron main process.
            void this.closePool(id);
          }
        }
        for (const [id, entry] of this.pgPools) {
          const idleMs = now.getTime() - entry.lastUsed.getTime();
          if (idleMs > 600000 && entry.activeQueries === 0) {
            entry.pool
              .end()
              .catch(err =>
                log.warn(`Failed to close idle pg pool ${id}: ${this.errMessage(err)}`)
              );
            this.pgPools.delete(id);
          }
        }
        for (const [id, entry] of this.mysqlPools) {
          const idleMs = now.getTime() - entry.lastUsed.getTime();
          if (idleMs > 600000 && entry.activeQueries === 0) {
            entry.pool
              .end()
              .catch(err =>
                log.warn(`Failed to close idle mysql pool ${id}: ${this.errMessage(err)}`)
              );
            this.mysqlPools.delete(id);
          }
        }
      },
      5 * 60 * 1000
    );
  }

  /**
   * Stop cleanup timer
   */
  stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
