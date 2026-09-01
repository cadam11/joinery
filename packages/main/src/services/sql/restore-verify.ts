/**
 * Post-restore existence checks for the CLI-driven restore paths (J-151).
 *
 * Both `mysql` and `pg_restore` can finish with a success-looking exit code
 * having applied nothing — an empty or invalid dump, a missing CREATE
 * privilege, a target database that `pg_restore` was never told to create. So
 * both restore services end by asking the server whether the target database
 * is actually there before reporting success.
 *
 * These live here, out of the two services, for the reason `backup-args.ts`
 * does: the services import `electron`, and the connection *options* these
 * checks use are the security-relevant part. Here they are unit-testable
 * against the real driver factories without booting Electron
 * (`restore-verify.spec.ts`).
 *
 * Each function owns exactly one connection and closes it on every exit path.
 * They are the only side effect in this module.
 */

import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import pg from 'pg';
import type { ConnectionProfile } from '@joinery/shared';
import { mysqlVerifyConnectionOptions } from './mysql-pool-options';

/**
 * Does `name` exist as a schema on the profile's MySQL server?
 *
 * Connects with {@link mysqlVerifyConnectionOptions} — the profile's own
 * settings, TLS included. It used to be a hand-rolled
 * `{ host, port, user, password }` literal, which meant a TLS-required server
 * failed the check on a restore that had in fact succeeded.
 *
 * `password` is passed through as the empty string when the profile has none
 * stored: mysql2 folds any falsy password to `undefined`
 * (`lib/connection_config.js:110`, v3.23.3), so this is the same wire
 * behaviour as omitting the key.
 */
export async function mysqlDatabaseExists(
  name: string,
  profile: ConnectionProfile,
  password: string | undefined
): Promise<boolean> {
  const conn = await mysql.createConnection(mysqlVerifyConnectionOptions(profile, password ?? ''));
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [name]
    );
    return rows.length === 1;
  } finally {
    await conn.end();
  }
}

/**
 * Does `name` exist as a database on the profile's PostgreSQL server?
 *
 * Connects to `postgres`, never to the restore target: on the run this check
 * exists for, the target does not exist and connecting to it would throw
 * instead of answering. `user` falls back to `postgres` to match the `-U` the
 * restore CLI is given (`PgBackupService.startRestore`).
 *
 * The `ssl` / `connectionTimeoutMillis` pair is written out here rather than
 * taken from a shared builder because PostgreSQL has no equivalent of
 * `mysql-pool-options.ts` yet — `connection-pool.ts` and
 * `provider/pg-provider.ts` still hold their own copies of the pool config.
 * When that builder lands, this literal should be derived from it the way the
 * MySQL side now is. The `ssl` shape reproduces what those copies pass, so this
 * check trusts (or refuses) the same certificates as every other PG connection
 * in the app.
 */
export async function pgDatabaseExists(
  name: string,
  profile: ConnectionProfile,
  password: string | undefined
): Promise<boolean> {
  const client = new pg.Client({
    host: profile.server,
    port: profile.port,
    user: profile.username || 'postgres',
    password,
    database: 'postgres',
    ssl: profile.encrypt ? { rejectUnauthorized: !profile.trustServerCertificate } : false,
    connectionTimeoutMillis: profile.connectionTimeout * 1000,
  });
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}
