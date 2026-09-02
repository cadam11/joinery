/**
 * J-66 — one spelling of a referential action crosses the IPC bridge, whatever engine produced it.
 *
 * `ForeignKeyInfo.onDelete`/`onUpdate` are declared as an underscore-cased union, but only SQL
 * Server produces it: `TsqlBuilder.listForeignKeys` maps `sys.foreign_keys.delete_referential_action`
 * onto `'no_action' | 'cascade' | 'set_null' | 'set_default'` directly. PostgreSQL and MySQL both
 * read `information_schema.referential_constraints`, whose `DELETE_RULE`/`UPDATE_RULE` are
 * `NO ACTION`, `SET NULL`, `SET DEFAULT`, `RESTRICT` and `CASCADE` — space-separated, and lower-cased
 * by the dialect (`pg-dialect.ts` / `mysql-dialect.ts`). `RESTRICT` is not in the union at all.
 *
 * `MetadataService.listForeignKeys` used to blind-cast the row through, so the renderer had to
 * normalise before it could compare (`features/object-detail/object-rows.ts`). These tests pin the
 * normalisation at the single producer instead.
 *
 * On the double: `ConnectionPoolManager` is replaced with a **row source**. It builds no SQL and
 * makes no routing decision — it returns whatever rows the test stages, so it cannot pass by
 * agreeing with a broken normaliser. Its surface is copied from the real class
 * (`connection-pool.ts`), the same subset `metadata-binding.spec.ts` verified for J-135:
 * `getDialectForProfile`, `getEngineForProfile`, `getPgPool` → `.query(sql, values)`,
 * `getMySQLPool` → `.query`/`.execute`, `query`/`queryWithParams` → `{ recordset }`,
 * `isAzureSQL`, `isDsqlCached`. The dialect is the REAL one, so the SQL under test is production's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseEngine } from '@joinery/shared';

interface FkRow {
  name: string;
  columns: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string;
  onDelete: string | null;
  onUpdate: string | null;
}

/** `vi.hoisted` because the `vi.mock` factory below runs before this module body. */
const staged = vi.hoisted(() => ({
  engine: 'postgresql' as DatabaseEngine,
  rows: [] as unknown[],
}));

vi.mock('./connection-pool', async () => {
  const { getDialect } = await import('./dialect');
  return {
    ConnectionPoolManager: {
      getInstance: () => ({
        getDialectForProfile: () => getDialect(staged.engine),
        getEngineForProfile: () => staged.engine,
        isAzureSQL: async () => false,
        isDsqlCached: () => false,
        getPgPool: async () => ({ query: async () => ({ rows: staged.rows }) }),
        getMySQLPool: async () => ({
          query: async () => [staged.rows],
          execute: async () => [staged.rows],
        }),
        query: async () => ({ recordset: staged.rows }),
        queryWithParams: async () => ({ recordset: staged.rows }),
      }),
    },
  };
});

import { MetadataService } from './metadata';

const CONNECTION = 'conn-j66';
const DATABASE = 'appdb';

function row(onDelete: string | null, onUpdate: string | null): FkRow {
  return {
    name: 'fk_order_items_order',
    columns: 'order_id',
    referencedSchema: 'public',
    referencedTable: 'orders',
    referencedColumns: 'id',
    onDelete,
    onUpdate,
  };
}

async function firstKey(engine: DatabaseEngine, staging: FkRow) {
  staged.engine = engine;
  staged.rows = [staging];
  MetadataService.resetInstance();
  const keys = await MetadataService.getInstance().listForeignKeys(
    CONNECTION,
    DATABASE,
    'public',
    'order_items'
  );
  return keys[0];
}

beforeEach(() => {
  staged.rows = [];
});

describe('MetadataService.listForeignKeys — referential actions (J-66)', () => {
  it.each([
    ['no action', 'no_action'],
    ['set null', 'set_null'],
    ['set default', 'set_default'],
    ['cascade', 'cascade'],
    ['restrict', 'restrict'],
  ])('normalises PostgreSQL’s %s to %s', async (raw, expected) => {
    const key = await firstKey('postgresql', row(raw, raw));
    expect(key?.onDelete).toBe(expected);
    expect(key?.onUpdate).toBe(expected);
  });

  it('normalises MySQL’s spellings the same way', async () => {
    const key = await firstKey('mysql', row('no action', 'restrict'));
    expect(key?.onDelete).toBe('no_action');
    expect(key?.onUpdate).toBe('restrict');
  });

  it('leaves SQL Server’s already-underscored spelling alone', async () => {
    const key = await firstKey('mssql', row('set_null', 'no_action'));
    expect(key?.onDelete).toBe('set_null');
    expect(key?.onUpdate).toBe('no_action');
  });

  it('tolerates upper case and surrounding whitespace', async () => {
    const key = await firstKey('postgresql', row('  SET NULL ', 'NO ACTION'));
    expect(key?.onDelete).toBe('set_null');
    expect(key?.onUpdate).toBe('no_action');
  });

  it('reports an absent or unrecognised action as undefined rather than casting it through', async () => {
    const key = await firstKey('postgresql', row(null, 'made up'));
    expect(key?.onDelete).toBeUndefined();
    expect(key?.onUpdate).toBeUndefined();
  });

  it('carries the rest of the row through untouched', async () => {
    const key = await firstKey('postgresql', row('cascade', 'cascade'));
    expect(key).toMatchObject({
      name: 'fk_order_items_order',
      columns: ['order_id'],
      referencedSchema: 'public',
      referencedTable: 'orders',
      referencedColumns: ['id'],
    });
  });
});
