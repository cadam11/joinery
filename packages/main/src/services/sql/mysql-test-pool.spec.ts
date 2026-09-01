/**
 * J-149 — both "Test Connection" paths build their pool from the shared builder.
 *
 * `mysql-pool-options.spec.ts` pins what `mysqlTestPoolOptions` *is*. This pins
 * who uses it: the two places that used to hand-roll their own copy of the
 * mysql2 options —
 *
 *   - `ConnectionPoolManager.testConnection` → `testMySQLConnection`
 *   - `MySQLProvider.testConnection`
 *
 * — must pass exactly what the builder returns. The copies were already drifting
 * (J-146's `maxIdle` never reached either of them); a deep-equal against the
 * builder makes the next drift a test failure instead of a silent divergence.
 *
 * On the double: the driver is not replaced, only its factory is. Both call
 * sites reach the pool through `mysql.createPool(...)` — a property read on the
 * real `mysql2/promise` default export at call time — so a `vi.spyOn` of that
 * one property records the options each path builds. (`vi.mock('mysql2/promise')`
 * cannot be used here: the node project's setup file imports
 * `connection-pool.ts` before any spec runs, so that module has already bound
 * the real driver by the time a spec-level module mock is registered.) The
 * recorder decides nothing and builds no options — it stores what it was handed
 * and answers the probe's single `SELECT VERSION() AS version, DATABASE() AS name`
 * with a fixed row, so it cannot make wrong options look right. Its surface is
 * only what the two paths touch, read off the real call sites: `.query(sql)` and
 * `.end()`. Behaviour against a live MySQL server is the integration tier's job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import type { Pool, PoolOptions } from 'mysql2/promise';
import type { ConnectionProfile } from '@joinery/shared';
import { ConnectionPoolManager } from './connection-pool';
import { MySQLProvider } from './provider/mysql-provider';
import { mysqlTestPoolOptions } from './mysql-pool-options';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'MySQL Profile',
  engine: 'mysql',
  server: 'db.example.com',
  port: 3306,
  username: 'app',
  database: 'appdb',
  mysqlCollation: 'utf8mb4_bin',
  authenticationType: 'sql',
  encrypt: true,
  trustServerCertificate: false,
  connectionTimeout: 15,
};

/** Options handed to createPool, in order, plus how many pools were closed. */
let created: PoolOptions[] = [];
let ended = 0;

beforeEach(() => {
  created = [];
  ended = 0;
  vi.spyOn(mysql, 'createPool').mockImplementation((options): Pool => {
    created.push(options as PoolOptions);
    return {
      query: async () => [[{ version: '8.0.36', name: 'appdb' }], []],
      end: async () => {
        ended += 1;
      },
    } as unknown as Pool;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MySQL test-connection pools (J-149)', () => {
  it('builds ConnectionPoolManager’s probe pool from the shared builder', async () => {
    const result = await ConnectionPoolManager.getInstance().testConnection(profile, 'secret');

    expect(result.success).toBe(true);
    expect(created).toEqual([mysqlTestPoolOptions(profile, 'secret')]);
    expect(ended).toBe(1);
  });

  it('builds MySQLProvider’s probe pool from the shared builder', async () => {
    const result = await new MySQLProvider().testConnection(profile, 'secret');

    expect(result.success).toBe(true);
    expect(created).toEqual([mysqlTestPoolOptions(profile, 'secret')]);
    expect(ended).toBe(1);
  });

  it('gives both paths the same options — neither may hold its own copy', async () => {
    await ConnectionPoolManager.getInstance().testConnection(profile, 'secret');
    await new MySQLProvider().testConnection(profile, 'secret');

    expect(created).toHaveLength(2);
    expect(created[0]).toEqual(created[1]);
  });
});
