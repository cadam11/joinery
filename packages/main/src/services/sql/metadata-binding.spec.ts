/**
 * J-135 — the first spec `metadata.ts` has ever had.
 *
 * `MetadataService` is where the explorer's schema, table and object names meet a live pool. The
 * cycle-4 audit's coverage table has no row for it at all, which is how two engines' worth of
 * inlined literals went unnoticed. These tests assert the *wiring*: for PostgreSQL and MySQL every
 * name the caller supplies leaves the process as a **bound parameter**, never inside the SQL text,
 * and reaches the driver call that actually binds — node-pg's `query(sql, values)` and mysql2's
 * `execute` (a server-side prepared statement), not `query(sql)`.
 *
 * On the double: `ConnectionPoolManager` is replaced with a **recorder**. It builds no SQL, does
 * no escaping and makes no routing decision — it captures the `(sql, params)` pair and which call
 * received it, and hands back empty result sets. So it cannot pass by agreeing with a broken
 * escaper, which is the failure mode `test-double-fiction-pattern` warns about. The one
 * collaborator that is NOT faked is the dialect: `getDialectForProfile` returns the real one, so
 * the SQL under assertion is the SQL production sends. Its surface is copied from the real class
 * (`connection-pool.ts`):
 *   - `getDialectForProfile(profileId): SQLDialect`
 *   - `getEngineForProfile(profileId): DatabaseEngine`
 *   - `getPgPool(profileId, database?): Promise<PgPool>`               → `.query(sql, values?)`
 *   - `getMySQLPool(profileId, database?, trust?): Promise<MySQLPool>` → `.query(sql)` / `.execute(sql, values)`
 *   - `query<T>(profileId, sql, database?): Promise<IResult<T>>`
 *   - `queryWithParams<T>(profileId, sql, params, database?): Promise<IResult<T>>`
 *   - `isAzureSQL(profileId): Promise<boolean>` / `isDsqlCached(profileId): boolean`
 *
 * The behaviour against real servers is proved in
 * `tests/integration/metadata/metadata-bound-parameters.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseEngine } from '@joinery/shared';

/** `vi.hoisted` because the `vi.mock` factory below runs before this module body. */
const recorder = vi.hoisted(() => ({
  engine: 'mysql' as DatabaseEngine,
  sent: [] as { via: string; sql: string; params: readonly unknown[] }[],
}));

vi.mock('./connection-pool', async () => {
  const { getDialect } = await import('./dialect');
  const record = (via: string, sql: string, params: readonly unknown[]) => {
    recorder.sent.push({ via, sql, params });
  };
  return {
    ConnectionPoolManager: {
      getInstance: () => ({
        getDialectForProfile: () => getDialect(recorder.engine),
        getEngineForProfile: () => recorder.engine,
        isAzureSQL: async () => false,
        isDsqlCached: () => false,
        getPgPool: async () => ({
          query: async (sql: string, values?: readonly unknown[]) => {
            record(values ? 'pg.query(bound)' : 'pg.query(unbound)', sql, values ?? []);
            return { rows: [] };
          },
        }),
        getMySQLPool: async () => ({
          query: async (sql: string) => {
            record('mysql.query(unbound)', sql, []);
            return [[]];
          },
          execute: async (sql: string, values?: readonly unknown[]) => {
            record('mysql.execute(bound)', sql, values ?? []);
            return [[]];
          },
        }),
        query: async (_profileId: string, sql: string) => {
          record('mssql.query(unbound)', sql, []);
          return { recordset: [] };
        },
        queryWithParams: async (_profileId: string, sql: string, params: readonly unknown[]) => {
          record('mssql.queryWithParams(bound)', sql, params);
          return { recordset: [] };
        },
      }),
    },
  };
});

import { MetadataService } from './metadata';

/**
 * A schema/table name carrying the characters that have broken this surface before: a quote to
 * close a literal, a statement separator, a comment to swallow the rest, and a trailing backslash.
 */
const HOSTILE = "p'; DROP TABLE victim; -- \\";

const CONNECTION = 'conn-j135';
const DATABASE = 'appdb';

/** Every `MetadataService` entry point that takes a caller-supplied schema, table or object name. */
const NAME_TAKING_CALLS: ReadonlyArray<[string, (svc: MetadataService) => Promise<unknown>]> = [
  ['listSchemas', s => s.listSchemas(CONNECTION, HOSTILE, true)],
  ['listTables', s => s.listTables(CONNECTION, HOSTILE, true)],
  ['listViews', s => s.listViews(CONNECTION, HOSTILE, true)],
  ['listProcedures', s => s.listProcedures(CONNECTION, HOSTILE, true)],
  ['listFunctions', s => s.listFunctions(CONNECTION, HOSTILE, true)],
  ['listColumns', s => s.listColumns(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['listIndexes', s => s.listIndexes(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['listForeignKeys', s => s.listForeignKeys(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['listConstraints', s => s.listConstraints(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['listTriggers', s => s.listTriggers(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['listExtendedProperties', s => s.listExtendedProperties(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  [
    'getObjectDefinition',
    s => s.getObjectDefinition(CONNECTION, DATABASE, HOSTILE, HOSTILE, 'view'),
  ],
  ['getTableProperties', s => s.getTableProperties(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['scriptTableAsCreate', s => s.scriptTableAsCreate(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  ['scriptTableAsInsert', s => s.scriptTableAsInsert(CONNECTION, DATABASE, HOSTILE, HOSTILE)],
  [
    'getEnrichedColumnMetadata',
    s => s.getEnrichedColumnMetadata(CONNECTION, DATABASE, HOSTILE, HOSTILE),
  ],
];

/** The subset that names a table, and so binds on PostgreSQL as well as MySQL. */
const TABLE_LEVEL_CALLS = NAME_TAKING_CALLS.filter(
  ([name]) =>
    !['listSchemas', 'listTables', 'listViews', 'listProcedures', 'listFunctions'].includes(name)
);

describe.each(['postgresql', 'mysql'] as const)('MetadataService on %s (J-135)', engine => {
  beforeEach(() => {
    recorder.engine = engine;
    recorder.sent = [];
    // The service caches per connection id; a fresh instance keeps each case independent.
    MetadataService.resetInstance();
  });

  it.each(NAME_TAKING_CALLS)('%s never writes the caller’s name into the SQL', async (_n, call) => {
    await call(MetadataService.getInstance());

    expect(recorder.sent.length).toBeGreaterThan(0);
    for (const statement of recorder.sent) {
      expect(statement.sql).not.toContain(HOSTILE);
      expect(statement.sql).not.toContain('DROP TABLE victim');
    }
  });

  it.each(NAME_TAKING_CALLS)('%s binds through the driver’s binding call', async (_n, call) => {
    await call(MetadataService.getInstance());

    for (const statement of recorder.sent) {
      if (statement.params.length === 0) continue;
      // node-pg only takes the extended query protocol when values are present; mysql2 only
      // prepares server-side on `execute`. A value handed to any other call is not bound at all.
      expect(statement.via).toBe(
        engine === 'postgresql' ? 'pg.query(bound)' : 'mysql.execute(bound)'
      );
    }
  });

  it.each(TABLE_LEVEL_CALLS)('%s actually binds the name it was given', async (_n, call) => {
    await call(MetadataService.getInstance());

    // Only the table-level calls are asserted here. The database-level ones (`listSchemas`,
    // `listTables`, `listViews`, `listProcedures`, `listFunctions`) bind nothing on PostgreSQL,
    // because PostgreSQL reaches a database by connecting to it — the name is the pool key, not
    // a predicate — and `MetadataService` passes no schema filter. There is nothing to bind.
    const carryingTheName = recorder.sent.filter(s => s.params.includes(HOSTILE));
    expect(carryingTheName.length).toBeGreaterThan(0);
  });
});

describe('MetadataService on mssql (J-135)', () => {
  beforeEach(() => {
    recorder.engine = 'mssql';
    recorder.sent = [];
    MetadataService.resetInstance();
  });

  it('is unchanged — TsqlBuilder writes its own literals and nothing binds', async () => {
    // Deliberate: T-SQL has no backslash escape in any configuration, so `TsqlBuilder`'s
    // quote-doubling is correct, and every statement stays on `ConnectionPoolManager.query`
    // (`request.batch`) exactly as before J-135.
    await MetadataService.getInstance().listColumns(CONNECTION, DATABASE, HOSTILE, HOSTILE);

    expect(recorder.sent.length).toBeGreaterThan(0);
    for (const statement of recorder.sent) {
      expect(statement.via).toBe('mssql.query(unbound)');
      expect(statement.params).toEqual([]);
    }
  });
});
