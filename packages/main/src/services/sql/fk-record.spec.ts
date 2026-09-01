/**
 * J-145 — the foreign-key lookup, per engine, with its value bound.
 *
 * What this file is for. The FK preview is the most data-driven path in the app: it runs by itself
 * when the user expands a disclosure in the row inspector, and the value in its predicate is a cell
 * out of whatever result set is on screen. Until J-145 the React renderer built that SQL itself and
 * sent it down `QUERY.EXECUTE` — the one channel entitled to MySQL's multi-statement pool — because
 * this handler emitted T-SQL and was a syntax error on two of three engines. So the escaping in
 * `renderer/features/query/fk-lookup.ts` was the only thing between a cell and a second statement.
 *
 * Three properties are asserted here, on all three engines:
 *   1. the SQL is dialect-correct (the row cap and the delimiters each engine spells its own way);
 *   2. the value is never in the SQL — it goes as a bound parameter, to the driver call that binds;
 *   3. MySQL gets the RESTRICTED pool (J-137), so a stacked statement is not expressible even if
 *      the binding were somehow bypassed.
 *
 * On the doubles. `ConnectionPoolManager` is replaced with a **recorder**, exactly as
 * `metadata-binding.spec.ts` does it and for the same reason: it builds no SQL, escapes nothing and
 * routes nothing, so it cannot make a broken escaper look correct. The dialect is NOT faked —
 * `getDialectForProfile` returns the real one — so the SQL asserted below is production's SQL. The
 * recorder's surface is copied from `connection-pool.ts`:
 *   - `getDialectForProfile(profileId): SQLDialect`                    (`:258`)
 *   - `getEngineForProfile(profileId): DatabaseEngine`                 (`:267`)
 *   - `getPgPool(profileId, database?): Promise<PgPool>`               (`:598`) → `.query(sql, values?)`
 *   - `getMySQLPool(profileId, database?, trust?): Promise<MySQLPool>` (`:733`) → `.query` / `.execute`
 *   - `queryWithParams<T>(profileId, sql, params, database?)`          (`:900`) → `{ recordset }`
 *
 * Behaviour against live servers is the integration tier's job
 * (`tests/integration/sql/mysql-pool-trust.spec.ts`) and the e2e tier's
 * (`tests/e2e-react/row-detail.spec.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseEngine } from '@joinery/shared';

const recorder = vi.hoisted(() => ({
  engine: 'postgresql' as DatabaseEngine,
  rows: [] as Record<string, unknown>[],
  /** Every driver call the lookup made, in order. */
  sent: [] as { via: string; sql: string; params: readonly unknown[] }[],
  /** Which MySQL pool was asked for, and for which database. */
  mysqlPools: [] as { database: string | undefined; trust: string | undefined }[],
  /** Every `getEnrichedColumnMetadata` call. */
  enrichedFor: [] as string[],
  enriched: [] as unknown[],
  enrichmentFails: false,
  /** When set, every driver call rejects with this message — the engine refusing the statement. */
  queryFails: null as string | null,
}));

vi.mock('./connection-pool', async () => {
  const { getDialect } = await import('./dialect');
  const record = (via: string, sql: string, params: readonly unknown[]) => {
    recorder.sent.push({ via, sql, params });
    if (recorder.queryFails !== null) throw new Error(recorder.queryFails);
  };
  return {
    ConnectionPoolManager: {
      getInstance: () => ({
        getDialectForProfile: () => getDialect(recorder.engine),
        getEngineForProfile: () => recorder.engine,
        getPgPool: async () => ({
          query: async (sql: string, values?: readonly unknown[]) => {
            record(values ? 'pg.query(bound)' : 'pg.query(unbound)', sql, values ?? []);
            return { rows: recorder.rows };
          },
        }),
        getMySQLPool: async (_id: string, database?: string, trust?: string) => {
          recorder.mysqlPools.push({ database, trust });
          return {
            query: async (sql: string) => {
              record('mysql.query(unbound)', sql, []);
              return [recorder.rows];
            },
            execute: async (sql: string, values?: readonly unknown[]) => {
              record('mysql.execute(bound)', sql, values ?? []);
              return [recorder.rows];
            },
          };
        },
        query: async (_id: string, sql: string) => {
          record('mssql.query(unbound)', sql, []);
          return { recordset: recorder.rows };
        },
        queryWithParams: async (_id: string, sql: string, params: readonly unknown[]) => {
          record('mssql.queryWithParams(bound)', sql, params);
          return { recordset: recorder.rows };
        },
      }),
    },
  };
});

vi.mock('./metadata', () => ({
  MetadataService: {
    getInstance: () => ({
      getEnrichedColumnMetadata: async (
        _connectionId: string,
        _database: string,
        schema: string,
        table: string
      ) => {
        recorder.enrichedFor.push(`${schema}.${table}`);
        if (recorder.enrichmentFails) throw new Error('catalogue unavailable');
        return recorder.enriched;
      },
    }),
  },
}));

import { fetchFkRecord } from './fk-record';

/** The characters that have broken this surface before, in the position a cell value occupies. */
const HOSTILE = String.raw`\'; DROP TABLE users; --`;

const REQUEST = {
  connectionId: 'conn-j145',
  database: 'appdb',
  schema: 'public',
  table: 'customers',
  column: 'id',
  value: 3,
};

/** What `getEnrichedColumnMetadata` returns, shaped as `metadata.ts:1063-1086` declares it. */
const ENRICHED = [
  {
    name: 'id',
    type: 'integer',
    nullable: false,
    maxLength: null,
    precision: 32,
    scale: 0,
    isPrimaryKey: true,
    isIdentity: true,
    defaultValue: null,
    foreignKey: null,
  },
  {
    name: 'email',
    type: 'text',
    nullable: true,
    maxLength: null,
    precision: null,
    scale: null,
    isPrimaryKey: false,
    isIdentity: false,
    defaultValue: null,
    foreignKey: null,
  },
];

beforeEach(() => {
  recorder.engine = 'postgresql';
  recorder.rows = [{ id: 3, email: 'c3@example.test' }];
  recorder.sent = [];
  recorder.mysqlPools = [];
  recorder.enrichedFor = [];
  recorder.enriched = ENRICHED;
  recorder.enrichmentFails = false;
  recorder.queryFails = null;
});

describe('the SQL, per engine', () => {
  it('uses PostgreSQL’s LIMIT form and binds the value', async () => {
    recorder.engine = 'postgresql';
    await fetchFkRecord(REQUEST);

    expect(recorder.sent).toEqual([
      {
        via: 'pg.query(bound)',
        sql: 'SELECT * FROM "public"."customers" WHERE "id" = $1 LIMIT 1',
        params: [3],
      },
    ]);
  });

  it('uses MySQL’s LIMIT form, binds through execute, and asks for the restricted pool', async () => {
    recorder.engine = 'mysql';
    await fetchFkRecord({ ...REQUEST, schema: 'shop' });

    expect(recorder.sent).toEqual([
      {
        via: 'mysql.execute(bound)',
        sql: 'SELECT * FROM `shop`.`customers` WHERE `id` = ? LIMIT 1',
        params: [3],
      },
    ]);
    // J-137: the editor's script pool is not available to this path, on this or any engine.
    expect(recorder.mysqlPools).toEqual([{ database: 'appdb', trust: 'restricted' }]);
  });

  it('uses T-SQL’s TOP form and binds through sp_executesql', async () => {
    recorder.engine = 'mssql';
    await fetchFkRecord({ ...REQUEST, schema: 'dbo', table: 'Customers' });

    expect(recorder.sent).toEqual([
      {
        via: 'mssql.queryWithParams(bound)',
        sql: 'SELECT TOP 1 * FROM [dbo].[Customers] WHERE [id] = @p0',
        params: [3],
      },
    ]);
  });
});

describe('the value never reaches the SQL', () => {
  it.each(['mssql' as const, 'postgresql' as const, 'mysql' as const])(
    'sends a hostile cell as a parameter on %s',
    async engine => {
      recorder.engine = engine;
      await fetchFkRecord({ ...REQUEST, value: HOSTILE });

      const call = recorder.sent[0];
      expect(call.via).toContain('bound');
      expect(call.sql).not.toContain('DROP');
      expect(call.sql.split(';')).toHaveLength(1);
      expect(call.params).toEqual([HOSTILE]);
    }
  );

  it('binds a Date rather than stringifying it into the predicate', async () => {
    const when = new Date('2026-08-25T00:00:00.000Z');
    await fetchFkRecord({ ...REQUEST, value: when });

    expect(recorder.sent[0].params).toEqual([when]);
  });
});

describe('the result', () => {
  it('returns the row and its columns, decorated from the catalogue', async () => {
    const result = await fetchFkRecord(REQUEST);

    expect(result.success).toBe(true);
    expect(result.record).toEqual({ id: 3, email: 'c3@example.test' });
    expect(result.columns).toEqual([
      { name: 'id', type: 'integer', dataType: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'email', type: 'text', dataType: 'text', nullable: true, isPrimaryKey: false },
    ]);
    expect(recorder.enrichedFor).toEqual(['public.customers']);
  });

  it('marks the primary key on PostgreSQL, which the driver’s own fields never carried', async () => {
    // The MSSQL executor enriched the FK preview's columns by parsing its SQL
    // (`query-executor.ts:104-125`); `executePg` and `executeMySQL` build columns from the driver
    // field list alone, so the pk marker was MSSQL-only. Naming the table outright rather than
    // parsing it back out of the SQL is what makes it work everywhere.
    recorder.engine = 'mysql';
    const result = await fetchFkRecord({ ...REQUEST, schema: 'shop' });

    expect(result.columns?.find(column => column.name === 'id')?.isPrimaryKey).toBe(true);
  });

  it('still returns the row when the catalogue cannot be read', async () => {
    recorder.enrichmentFails = true;
    const result = await fetchFkRecord(REQUEST);

    expect(result.success).toBe(true);
    expect(result.record).toEqual({ id: 3, email: 'c3@example.test' });
    expect(result.columns?.map(column => column.name)).toEqual(['id', 'email']);
  });

  it('reports "no such row" as a success with no record, not as an error', async () => {
    // The rail draws a "no row in customers has id = 3" line for this and an error card for a
    // failure. Collapsing them would put a red error where a plain fact belongs.
    recorder.rows = [];
    const result = await fetchFkRecord(REQUEST);

    expect(result).toEqual({ success: true });
  });

  it('returns the engine’s message when the query itself fails', async () => {
    recorder.queryFails = 'relation "public.customers" does not exist';
    const result = await fetchFkRecord(REQUEST);

    expect(result.success).toBe(false);
    expect(result.error).toBe('relation "public.customers" does not exist');
    expect(result.record).toBeUndefined();
  });
});
