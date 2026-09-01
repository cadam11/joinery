/**
 * J-149 — the "Test Connection" path builds its pool from the shared builder.
 *
 * `mysql-pool-options.spec.ts` pins what `mysqlTestPoolOptions` *is*. This pins
 * who uses it: `ConnectionPoolManager.testConnection` → `testMySQLConnection`,
 * the one probe path in the app, must pass exactly what the builder returns.
 * It used to hand-roll its own copy of the mysql2 options and that copy was
 * already drifting (J-146's `maxIdle` never reached it); a deep-equal against
 * the builder makes the next drift a test failure instead of a silent
 * divergence.
 *
 * J-149 pinned a second caller here too, `MySQLProvider.testConnection`. J-148
 * deleted `sql/provider/` — nothing ever constructed those classes — so the
 * pool manager is the whole surface again.
 *
 * On the double: the driver is not replaced, only its factory is. The call site
 * reaches the pool through `mysql.createPool(...)` — a property read on the
 * real `mysql2/promise` default export at call time — so a `vi.spyOn` of that
 * one property records the options the path builds. (`vi.mock('mysql2/promise')`
 * cannot be used here: the node project's setup file imports
 * `connection-pool.ts` before any spec runs, so that module has already bound
 * the real driver by the time a spec-level module mock is registered.) The
 * recorder decides nothing and builds no options — it stores what it was handed
 * and answers the probe's single `SELECT VERSION() AS version, DATABASE() AS name`
 * with a fixed row, so it cannot make wrong options look right. Its surface is
 * only what the path touches, read off the real call site: `.query(sql)` and
 * `.end()`. Behaviour against a live MySQL server is the integration tier's job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import type { Pool, PoolOptions } from 'mysql2/promise';
import type { ConnectionProfile } from '@joinery/shared';
import { ConnectionPoolManager } from './connection-pool';
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

  it('opens exactly one probe pool and closes it', async () => {
    await ConnectionPoolManager.getInstance().testConnection(profile, 'secret');

    expect(created).toHaveLength(1);
    expect(ended).toBe(1);
  });
});
