/**
 * Pure options and cache-key builders for Joinery's MySQL pools — kept
 * separate from connection-pool.ts so the trust split below is pinned by unit
 * tests without standing up the driver or the pool-manager singleton (same
 * reasoning as aurora-dsql-pool-options.ts).
 *
 * ## Why there are two pools per (profile, database)
 *
 * `multipleStatements` is not a per-query option. It is the
 * `CLIENT_MULTI_STATEMENTS` capability flag, negotiated once during the
 * connection handshake: mysql2 pushes it onto the client flags only when the
 * option is set (`lib/connection_config.js:247-249`, `lib/constants/client.js:26`).
 * A connection either can carry a second statement for its whole life, or it
 * cannot — so "allow it here, refuse it there" has to be two connections.
 *
 * - `'script'` — the query editor. `QueryExecutor.executeMySQL` sends the
 *   user's entire script in one `conn.query()` and reads the multi-result
 *   array back, so the flag is load-bearing there and cannot simply be turned
 *   off. The SQL on this path is authored by the person at the keyboard.
 *
 * - `'restricted'` — everything else: metadata, the AI tool surface, the
 *   FETCH_FK_RECORD handler. None of them ever sends more than one statement, and
 *   some of them build SQL from strings supplied by an LLM or read out of a
 *   result-set cell. Denying the capability makes a stacked statement
 *   unparseable by the server rather than merely un-writable by a correct
 *   escaper (the cycle-4 audit's S1).
 *
 * `'restricted'` is the default everywhere so a new caller is safe unless it
 * says otherwise.
 */
import type { PoolOptions } from 'mysql2/promise';
import type { ConnectionProfile } from '@joinery/shared';

export type MySQLPoolTrust = 'restricted' | 'script';

/** Every trust level, so callers that must cover all of them cannot miss one. */
export const MYSQL_POOL_TRUSTS: readonly MySQLPoolTrust[] = ['restricted', 'script'];

/**
 * Build the mysql2 pool options for one (profile, database, trust) triple.
 *
 * `profile` must already be tunnel-resolved (see ConnectionPoolManager.withTunnel):
 * host and port are taken from it verbatim.
 */
export function mysqlPoolOptions(
  profile: ConnectionProfile,
  dbName: string | undefined,
  trust: MySQLPoolTrust,
  password: string
): PoolOptions {
  return {
    host: profile.server,
    port: profile.port,
    user: profile.username,
    password,
    database: dbName,
    charset: profile.mysqlCollation || undefined,
    ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : undefined,
    connectTimeout: profile.connectionTimeout * 1000,
    connectionLimit: 10,
    waitForConnections: true,
    idleTimeout: 30000,
    // J-146: `idleTimeout` is inert on its own. mysql2 arms its idle reaper in
    // the pool constructor only when `maxIdle < connectionLimit`
    // (`lib/base/pool.js:50-52`), and `maxIdle` defaults to `connectionLimit`
    // (`lib/pool_config.js:18-20`) — so without this line the 30s timeout above
    // never starts, and every connection a burst opens is held until the pool
    // closes. Burst capacity is unchanged at connectionLimit: 10; the pool just
    // gives the connections back once they go idle.
    maxIdle: 2,
    // Written explicitly on both branches: `false` is also mysql2's default,
    // but the security property here is the point of the module and should not
    // depend on a driver default staying put.
    multipleStatements: trust === 'script',
  };
}

/**
 * Options for the throwaway pool behind "Test Connection" (J-149).
 *
 * Both probe paths — `ConnectionPoolManager.testMySQLConnection` and
 * `MySQLProvider.testConnection` — used to hand-roll their own copy of the
 * option literal, and both had already drifted from the builder above (neither
 * ever received J-146's `maxIdle`). Deriving them here means a future change to
 * the shared options reaches the probe by construction.
 *
 * `restricted` trust: the probe sends one statement, `SELECT VERSION() AS
 * version, DATABASE() AS name`, and has no business holding a connection that
 * could carry a second.
 *
 * Only the pool-size pair is overridden, and both values reproduce what the
 * hand-rolled copies effectively had: `connectionLimit: 1` was explicit there,
 * and `maxIdle` defaulted to `connectionLimit` when omitted
 * (`mysql2/lib/pool_config.js:18-20`). Inheriting `maxIdle: 2` over a
 * one-connection pool would leave `maxIdle > connectionLimit` — harmless to
 * mysql2, but it reads as a mistake. The reaper stays disarmed either way
 * (`lib/base/pool.js:50-52` arms it only when `maxIdle < connectionLimit`),
 * which is right for a pool that answers one query and is closed in a `finally`.
 *
 * The one inherited value the copies did not have is `idleTimeout: 30000` in
 * place of mysql2's 60s default. It is inert here: nothing reaps a pool whose
 * reaper never arms, and the pool does not outlive the probe.
 */
export function mysqlTestPoolOptions(profile: ConnectionProfile, password: string): PoolOptions {
  return {
    ...mysqlPoolOptions(profile, profile.database || undefined, 'restricted', password),
    connectionLimit: 1,
    maxIdle: 1,
  };
}

/**
 * Cache key for a MySQL pool entry.
 *
 * Shape: `profileId:trust:database`. Two constraints fix it:
 *
 *  - Every key must start with `${profileId}:`, because closePool,
 *    invalidateStalePoolsIfTunnelGone and isConnected sweep a profile's pools
 *    with `key === profileId || key.startsWith(profileId + ':')`.
 *  - No database name may be able to forge another triple's key. MySQL permits
 *    `:` in a database name, so the trust marker sits in its own segment
 *    *before* the name: segment 2 is always the literal trust level, never
 *    user data.
 */
export function mysqlPoolKey(
  profileId: string,
  database: string | undefined,
  trust: MySQLPoolTrust
): string {
  return `${profileId}:${trust}:${database ?? '__default__'}`;
}

/** Both keys for a (profile, database) pair — the pools that must be released together. */
export function mysqlPoolKeysForDatabase(profileId: string, database: string): string[] {
  return MYSQL_POOL_TRUSTS.map(trust => mysqlPoolKey(profileId, database, trust));
}
