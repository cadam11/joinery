/**
 * J-150 — how many server round trips one FK preview costs, per engine.
 *
 * ── Why this file exists next to `fk-record.spec.ts` ─────────────────────────────────────────
 *
 * `fk-record.spec.ts` replaces `./metadata` with a double, which is right for the questions it asks
 * (is the value bound? which pool? what SQL?) and makes this question unaskable: a doubled
 * `MetadataService` issues no queries, so nothing it records can say what the catalogue read costs.
 *
 * So this file doubles **only** `./connection-pool` — the one seam where a statement leaves the
 * process — and runs the REAL `MetadataService` and the REAL dialects above it. Every driver call
 * the preview makes lands in one ordered list, which makes the round-trip count a plain assertion
 * rather than an estimate. Both mocks name the same module id (`./connection-pool` resolves
 * identically from this spec and from `metadata.ts`, same directory), so the recorder sees the
 * metadata service's calls too.
 *
 * ── The measurement this locks in (J-150) ────────────────────────────────────────────────────
 *
 * Before: the preview called `getEnrichedColumnMetadata`, which fans out to `listColumns` +
 * `listForeignKeys` + a per-engine identity read (`metadata.ts:1061-1111`) — 3 round trips on
 * PostgreSQL and 4 on MySQL and SQL Server, for a decoration that consumes three fields.
 * After: `listColumns` alone, so **2 on every engine** — the row, then its columns.
 *
 * On the doubles. The recorder's surface is copied from `connection-pool.ts`, same as
 * `fk-record.spec.ts` and `metadata-binding.spec.ts`:
 *   - `getDialectForProfile(profileId): SQLDialect`                    (`:258`)
 *   - `getEngineForProfile(profileId): DatabaseEngine`                 (`:267`)
 *   - `getPgPool(profileId, database?): Promise<PgPool>`               (`:598`) → `.query(sql, values?)`
 *   - `getMySQLPool(profileId, database?, trust?): Promise<MySQLPool>` (`:733`) → `.query` / `.execute`
 *   - `query<T>(profileId, sql, database?)`                            (`:865`) → `{ recordset }`
 *   - `queryWithParams<T>(profileId, sql, params, database?)`          (`:900`) → `{ recordset }`
 * The dialects are NOT faked, so the SQL counted below is production's SQL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseEngine } from '@joinery/shared';

const recorder = vi.hoisted(() => ({
  engine: 'postgresql' as DatabaseEngine,
  /** What the preview's own SELECT returns — empty for a reference that matches no row. */
  rows: [] as Record<string, unknown>[],
  /** What any catalogue read returns — one column row, enough to decorate `id`. */
  catalogue: [] as Record<string, unknown>[],
  /** Every driver call, in order. `sql` is normalised to one line so a fingerprint is greppable. */
  sent: [] as { via: string; sql: string }[],
}));

vi.mock('./connection-pool', async () => {
  const { getDialect } = await import('./dialect');

  /**
   * The recorder answers the preview's SELECT with the row and every other statement with the
   * catalogue rows. Discriminating on the SQL is deliberate: it is the only thing that tells the
   * two apart here, and getting it wrong would show up as an empty preview, not as a wrong count.
   */
  const rowsFor = (sql: string) =>
    /^\s*SELECT (TOP 1 )?\*/i.test(sql) ? recorder.rows : recorder.catalogue;

  const record = (via: string, sql: string) => {
    recorder.sent.push({ via, sql: sql.replace(/\s+/g, ' ').trim() });
    return rowsFor(sql);
  };

  return {
    ConnectionPoolManager: {
      getInstance: () => ({
        getDialectForProfile: () => getDialect(recorder.engine),
        getEngineForProfile: () => recorder.engine,
        getPgPool: async () => ({
          query: async (sql: string, values?: readonly unknown[]) => ({
            rows: record(values ? 'pg.query(bound)' : 'pg.query(unbound)', sql),
          }),
        }),
        getMySQLPool: async () => ({
          query: async (sql: string) => [record('mysql.query(unbound)', sql)],
          execute: async (sql: string) => [record('mysql.execute(bound)', sql)],
        }),
        query: async (_id: string, sql: string) => ({
          recordset: record('mssql.query(unbound)', sql),
        }),
        queryWithParams: async (_id: string, sql: string) => ({
          recordset: record('mssql.queryWithParams(bound)', sql),
        }),
      }),
    },
  };
});

import { getDialect } from './dialect';
import { fetchFkRecord } from './fk-record';
import { MetadataService } from './metadata';

const REQUEST = {
  connectionId: 'conn-j150',
  database: 'appdb',
  schema: 'public',
  table: 'customers',
  column: 'id',
  value: 3,
};

/** `MetadataService.listColumns` returns `ColumnInfo[]` (`metadata.ts:277-295`). */
const COLUMN_ROW = {
  name: 'id',
  dataType: 'integer',
  isNullable: false,
  isPrimaryKey: true,
  isForeignKey: false,
  ordinalPosition: 1,
};

beforeEach(() => {
  // The real service is under test, and it caches; a leftover instance would carry a previous
  // test's pools and caches into this one.
  MetadataService.resetInstance();
  recorder.engine = 'postgresql';
  recorder.rows = [{ id: 3 }];
  recorder.catalogue = [COLUMN_ROW];
  recorder.sent = [];
});

describe.each(['postgresql' as const, 'mysql' as const, 'mssql' as const])(
  'one FK preview on %s',
  engine => {
    beforeEach(() => {
      recorder.engine = engine;
    });

    it('costs exactly two round trips: the row, then its columns', async () => {
      await fetchFkRecord(REQUEST);

      // The count is the point of this file. It is listed rather than summed so a regression names
      // the query it added.
      expect(recorder.sent.map(call => call.sql)).toHaveLength(2);
    });

    it('spends the first round trip on the row itself', async () => {
      await fetchFkRecord(REQUEST);

      expect(recorder.sent[0].sql).toMatch(/^SELECT (TOP 1 )?\*/);
      expect(recorder.sent[0].via).toContain('bound');
    });

    it('spends the second on the column catalogue, and it is exactly the dialect’s own query', async () => {
      await fetchFkRecord(REQUEST);

      // Compared against the dialect rather than pattern-matched: `listColumnsQuery` already
      // derives `isForeignKey` from the catalogue, so every engine's COLUMNS query mentions foreign
      // keys and a "no FK query was sent" regex would pass vacuously. The identity of the statement
      // is the honest assertion, and with the length above it says the preview sent no
      // `listForeignKeys` and no identity/auto-increment read.
      const expected = getDialect(engine)
        .listColumnsQuery(REQUEST.database, REQUEST.schema, REQUEST.table)
        .sql.replace(/\s+/g, ' ')
        .trim();

      expect(recorder.sent[1].sql).toBe(expected);
    });

    it('still decorates the row from the catalogue it did read', async () => {
      const result = await fetchFkRecord(REQUEST);

      expect(result.success).toBe(true);
      expect(result.columns).toEqual([
        { name: 'id', type: 'integer', dataType: 'integer', nullable: false, isPrimaryKey: true },
      ]);
    });

    it('costs exactly one round trip when no row matches — no catalogue read at all', async () => {
      // `fetchFkRecord` returns before `describeRow` when the reference matches nothing, so the
      // decoration is never paid for. Asserted so the early return is not refactored away.
      recorder.rows = [];

      const result = await fetchFkRecord(REQUEST);

      expect(result).toEqual({ success: true });
      expect(recorder.sent).toHaveLength(1);
    });
  }
);
