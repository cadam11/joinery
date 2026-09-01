/**
 * J-137 — the MySQL pools are split by trust level.
 *
 * Joinery opens MySQL pools for two kinds of caller and they need different
 * connection capabilities:
 *
 *  - **script** — the query editor. `QueryExecutor.executeMySQL` sends the
 *    user's whole script in one `conn.query()` and reads the multi-result
 *    array back, so `CLIENT_MULTI_STATEMENTS` is load-bearing there. The SQL
 *    is authored by the person sitting at the keyboard.
 *  - **restricted** — metadata, the AI tool surface, the FETCH_FK_RECORD handler.
 *    None of them ever sends more than one statement, and some of them build
 *    SQL out of strings an LLM or a result-set cell supplied. Handing those a
 *    connection that *cannot* carry a second statement turns the cycle-4
 *    audit's S1 (stacked-statement injection) from "escaped correctly, we
 *    hope" into "not expressible on this connection".
 *
 * `multipleStatements` is a handshake capability flag, not a per-query option:
 * `mysql2/lib/connection_config.js:247-249` pushes `MULTI_STATEMENTS` onto the
 * client flags only when the option is set, and `constants/client.js:26` is
 * `CLIENT_MULTI_STATEMENTS = 0x00010000`. Without it the server's parser
 * rejects the `;` — so the property is enforced by MySQL, not by Joinery.
 *
 * These are pure functions, kept out of `connection-pool.ts` for the same
 * reason `aurora-dsql-pool-options.ts` is: the security-critical invariant is
 * then pinned without mocking the pool-manager singleton or the driver.
 */
import { describe, expect, it } from 'vitest';
import { createPool, type PoolOptions } from 'mysql2/promise';
import type { ConnectionProfile } from '@joinery/shared';
import {
  MYSQL_POOL_TRUSTS,
  mysqlPoolKey,
  mysqlPoolOptions,
  mysqlTestPoolOptions,
} from './mysql-pool-options';

const baseProfile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'profile-1',
  name: 'MySQL Profile',
  engine: 'mysql',
  server: 'db.example.com',
  port: 3306,
  username: 'app',
  authenticationType: 'sql',
  encrypt: false,
  trustServerCertificate: false,
  connectionTimeout: 15,
  ...over,
});

describe('mysqlPoolOptions', () => {
  it('refuses multi-statement on a restricted pool', () => {
    const opts = mysqlPoolOptions(baseProfile(), 'app', 'restricted', 'secret');
    // Explicitly false, not merely absent: this is the whole point of the
    // trust split and it must survive someone rewriting the object literal.
    expect(opts.multipleStatements).toBe(false);
  });

  it('allows multi-statement on a script pool, which the editor depends on', () => {
    const opts = mysqlPoolOptions(baseProfile(), 'app', 'script', 'secret');
    expect(opts.multipleStatements).toBe(true);
  });

  it('differs between the two trust levels ONLY in multipleStatements', () => {
    const restricted = mysqlPoolOptions(baseProfile(), 'app', 'restricted', 'secret');
    const script = mysqlPoolOptions(baseProfile(), 'app', 'script', 'secret');

    const { multipleStatements: _r, ...restRestricted } = restricted;
    const { multipleStatements: _s, ...restScript } = script;
    expect(restRestricted).toEqual(restScript);
  });

  it('carries the profile through unchanged', () => {
    const opts = mysqlPoolOptions(
      baseProfile({ server: '127.0.0.1', port: 13306, mysqlCollation: 'utf8mb4_bin' }),
      'app',
      'restricted',
      'secret'
    );
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(13306);
    expect(opts.user).toBe('app');
    expect(opts.password).toBe('secret');
    expect(opts.database).toBe('app');
    expect(opts.charset).toBe('utf8mb4_bin');
    expect(opts.connectTimeout).toBe(15000);
    expect(opts.connectionLimit).toBe(10);
    expect(opts.waitForConnections).toBe(true);
    expect(opts.idleTimeout).toBe(30000);
  });

  it('validates the server certificate unless the profile opts out', () => {
    const on = mysqlPoolOptions(baseProfile({ encrypt: true }), 'app', 'restricted', 'secret');
    expect(on.ssl).toEqual({ rejectUnauthorized: true });

    const trusting = mysqlPoolOptions(
      baseProfile({ encrypt: true, trustServerCertificate: true }),
      'app',
      'restricted',
      'secret'
    );
    expect(trusting.ssl).toEqual({ rejectUnauthorized: false });

    const off = mysqlPoolOptions(baseProfile({ encrypt: false }), 'app', 'restricted', 'secret');
    expect(off.ssl).toBeUndefined();
  });

  it('leaves database undefined when the profile has no default database', () => {
    const opts = mysqlPoolOptions(baseProfile(), undefined, 'restricted', 'secret');
    expect(opts.database).toBeUndefined();
  });
});

/**
 * J-146 — `idleTimeout` is inert unless `maxIdle < connectionLimit`.
 *
 * mysql2 starts the idle reaper in the pool constructor, behind exactly that
 * comparison (`mysql2/lib/base/pool.js:50-52`, v3.23.3):
 *
 *     if (this.config.maxIdle < this.config.connectionLimit) {
 *       // create idle connection timeout automatically release job
 *       this._removeIdleTimeoutConnections();
 *     }
 *
 * and `maxIdle` defaults to `connectionLimit` (`mysql2/lib/pool_config.js:18-20`):
 *
 *     this.maxIdle = isNaN(options.maxIdle)
 *       ? this.connectionLimit
 *       : Number(options.maxIdle);
 *
 * So a pool that sets `connectionLimit` and `idleTimeout` but no `maxIdle`
 * never arms the reaper at all — verified empirically in cycle 5, where six
 * connections opened by six parallel queries were all still open long after
 * the 30s timeout elapsed. The reaper, once armed, polls every second and
 * destroys free connections above `maxIdle` or past `idleTimeout`
 * (`lib/base/pool.js:321-344`).
 *
 * These tests drive the REAL mysql2 pool constructor rather than a double, so
 * they pin the driver's actual arming rule, not our reading of it. Creating a
 * pool does not connect — mysql2 opens a socket lazily on `getConnection` —
 * so no server is needed. The pool is always ended: its reaper timer would
 * otherwise hold the event loop open.
 */
/** mysql2 keeps the reaper handle on the core pool; it is not in the public types. */
type ReaperProbe = { pool: { _removeIdleTimeoutConnectionsTimer?: NodeJS.Timeout } };

const reaperArmed = async (options: PoolOptions): Promise<boolean> => {
  const pool = createPool(options);
  try {
    return Boolean((pool as unknown as ReaperProbe).pool._removeIdleTimeoutConnectionsTimer);
  } finally {
    await pool.end();
  }
};

describe('mysqlPoolOptions idle reaper (J-146)', () => {
  it.each(MYSQL_POOL_TRUSTS)('arms mysql2’s idle reaper on the %s pool', async trust => {
    const opts = mysqlPoolOptions(baseProfile(), 'app', trust, 'secret');
    await expect(reaperArmed(opts)).resolves.toBe(true);
  });

  it.each(MYSQL_POOL_TRUSTS)('keeps maxIdle below connectionLimit on the %s pool', trust => {
    const opts = mysqlPoolOptions(baseProfile(), 'app', trust, 'secret');
    expect(opts.maxIdle).toBe(2);
    expect(opts.connectionLimit).toBe(10);
    expect(opts.maxIdle).toBeLessThan(opts.connectionLimit as number);
  });

  it('leaves the reaper disarmed when maxIdle is dropped — the defect this pins', async () => {
    // The control case: the exact options we ship, minus maxIdle. If this ever
    // starts passing, mysql2 changed its default and the guard above is moot.
    const { maxIdle: _dropped, ...withoutMaxIdle } = mysqlPoolOptions(
      baseProfile(),
      'app',
      'restricted',
      'secret'
    );
    await expect(reaperArmed(withoutMaxIdle)).resolves.toBe(false);
  });
});

/**
 * J-149 — the "Test Connection" probe pool is derived, not hand-rolled.
 *
 * Two copies of the pool options used to live in the test-connection paths
 * (`connection-pool.ts` testMySQLConnection, `provider/mysql-provider.ts`
 * testConnection). They drifted from `mysqlPoolOptions` — J-146's `maxIdle`
 * never reached them, and neither would the next fix. These tests pin the
 * derivation itself: anything added to the shared builder must show up in the
 * probe options too, or the first assertion fails.
 */
describe('mysqlTestPoolOptions (J-149)', () => {
  const probeProfile = baseProfile({ database: 'appdb' });

  it('differs from the shared restricted options ONLY in the pool-size pair', () => {
    const shared = mysqlPoolOptions(probeProfile, 'appdb', 'restricted', 'secret');
    const probe = mysqlTestPoolOptions(probeProfile, 'secret');

    const { connectionLimit: _sl, maxIdle: _sm, ...sharedRest } = shared;
    const { connectionLimit: _pl, maxIdle: _pm, ...probeRest } = probe;
    expect(probeRest).toEqual(sharedRest);
  });

  it('opens a single connection, the effective size the hand-rolled copies had', () => {
    const probe = mysqlTestPoolOptions(probeProfile, 'secret');
    expect(probe.connectionLimit).toBe(1);
    // maxIdle tracked connectionLimit by default in the hand-rolled copies
    // (mysql2/lib/pool_config.js:18-20). Inheriting the shared builder's
    // maxIdle: 2 would leave maxIdle > connectionLimit, which reads as a
    // mistake even though mysql2 ignores it. Pin the coherent pair instead.
    expect(probe.maxIdle).toBe(1);
    expect(probe.maxIdle).toBe(probe.connectionLimit);
  });

  it('leaves mysql2’s idle reaper disarmed — the probe pool is ended, not reaped', async () => {
    // Driven through the real mysql2 constructor: the reaper arms only when
    // maxIdle < connectionLimit (lib/base/pool.js:50-52). A one-connection pool
    // that the caller ends in a `finally` has nothing for a 1s poller to do.
    await expect(reaperArmed(mysqlTestPoolOptions(probeProfile, 'secret'))).resolves.toBe(false);
  });

  it('probes on a restricted connection: the probe sends one statement', () => {
    const probe = mysqlTestPoolOptions(probeProfile, 'secret');
    expect(probe.multipleStatements).toBe(false);
  });

  it('carries the profile through, including a tunnel-resolved host and TLS', () => {
    const probe = mysqlTestPoolOptions(
      baseProfile({
        server: '127.0.0.1',
        port: 13306,
        database: 'appdb',
        mysqlCollation: 'utf8mb4_bin',
        encrypt: true,
      }),
      'secret'
    );
    expect(probe.host).toBe('127.0.0.1');
    expect(probe.port).toBe(13306);
    expect(probe.user).toBe('app');
    expect(probe.password).toBe('secret');
    expect(probe.database).toBe('appdb');
    expect(probe.charset).toBe('utf8mb4_bin');
    expect(probe.connectTimeout).toBe(15000);
    expect(probe.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('leaves database undefined when the profile names none', () => {
    // The hand-rolled copies read `profile.database || undefined`: an empty
    // string must not be handed to mysql2 as a database name.
    expect(mysqlTestPoolOptions(baseProfile({ database: '' }), 'secret').database).toBeUndefined();
    expect(mysqlTestPoolOptions(baseProfile(), 'secret').database).toBeUndefined();
  });
});

describe('mysqlPoolKey', () => {
  it('gives the two trust levels separate cache entries', () => {
    expect(mysqlPoolKey('p1', 'app', 'restricted')).not.toBe(mysqlPoolKey('p1', 'app', 'script'));
  });

  it('keeps every key under the `profileId:` prefix the pool sweeps rely on', () => {
    // closePool / invalidateStalePoolsIfTunnelGone / isConnected all match
    // pools for a profile with `key === profileId || key.startsWith(profileId + ':')`.
    for (const trust of ['restricted', 'script'] as const) {
      for (const db of ['app', undefined]) {
        expect(mysqlPoolKey('p1', db, trust).startsWith('p1:')).toBe(true);
      }
    }
  });

  it('never lets a database name forge another pool key', () => {
    // A MySQL database may be named `script:app` or `restricted:app`. The trust
    // marker sits in its own segment before the name, so no database name can
    // produce the key of a different (profile, database, trust) triple.
    const forged = mysqlPoolKey('p1', 'script:app', 'restricted');
    const real = mysqlPoolKey('p1', 'app', 'script');
    expect(forged).not.toBe(real);

    const forgedOther = mysqlPoolKey('p1', 'restricted:app', 'script');
    const realOther = mysqlPoolKey('p1', 'app', 'restricted');
    expect(forgedOther).not.toBe(realOther);
  });

  it('distinguishes databases and profiles', () => {
    expect(mysqlPoolKey('p1', 'a', 'restricted')).not.toBe(mysqlPoolKey('p1', 'b', 'restricted'));
    expect(mysqlPoolKey('p1', 'a', 'restricted')).not.toBe(mysqlPoolKey('p2', 'a', 'restricted'));
    expect(mysqlPoolKey('p1', undefined, 'restricted')).not.toBe(
      mysqlPoolKey('p1', 'a', 'restricted')
    );
  });

  it('is stable for the same triple', () => {
    expect(mysqlPoolKey('p1', 'app', 'restricted')).toBe(mysqlPoolKey('p1', 'app', 'restricted'));
  });
});
