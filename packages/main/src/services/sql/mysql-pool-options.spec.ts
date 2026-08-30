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
import type { ConnectionProfile } from '@joinery/shared';
import { mysqlPoolKey, mysqlPoolOptions } from './mysql-pool-options';

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
