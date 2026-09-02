/**
 * The three row builders, including the two things the Angular tab could not show at all (identity and
 * references) and the one it would have rendered wrong (an empty MySQL referenced schema).
 */

import { describe, expect, it } from 'vitest';
import type { ForeignKeyInfo, IndexInfo } from '@joinery/shared';

import type { EnrichedColumn } from '../query/fk-lookup';
import { columnRows, indexRows, keyRows } from './object-rows';

function column(overrides: Partial<EnrichedColumn> = {}): EnrichedColumn {
  return {
    name: 'id',
    type: 'int',
    nullable: false,
    maxLength: null,
    precision: null,
    scale: null,
    isPrimaryKey: true,
    isIdentity: true,
    defaultValue: null,
    foreignKey: null,
    ...overrides,
  };
}

describe('columnRows', () => {
  it('carries the identity flag and the reference, which ColumnInfo could not', () => {
    const [row] = columnRows([
      column({
        name: 'customer_id',
        type: 'int',
        isPrimaryKey: false,
        isIdentity: false,
        foreignKey: {
          referencedSchema: 'public',
          referencedTable: 'customers',
          referencedColumn: 'id',
          constraintName: 'fk_orders_customer',
        },
      }),
    ]);

    expect(row?.isIdentity).toBe(false);
    expect(row?.references).toBe('public.customers.id');
  });

  it('formats the declared type through the row-detail formatter', () => {
    // The nulls have to become `undefined` on the way in, or every guard in the formatter sees a value
    // and prints `nvarchar(null)`.
    expect(columnRows([column({ type: 'nvarchar', maxLength: 64 })])[0]?.type).toBe('nvarchar(64)');
    expect(columnRows([column({ type: 'nvarchar', maxLength: null })])[0]?.type).toBe('nvarchar');
    expect(columnRows([column({ type: 'decimal', precision: 10, scale: 2 })])[0]?.type).toBe(
      'decimal(10,2)'
    );
  });

  it('drops the leading dot when MySQL reports no referenced schema', () => {
    const [row] = columnRows([
      column({
        foreignKey: {
          referencedSchema: '',
          referencedTable: 'customers',
          referencedColumn: 'id',
          constraintName: 'fk',
        },
      }),
    ]);
    expect(row?.references).toBe('customers.id');
  });

  it('answers null for a column that references nothing', () => {
    expect(columnRows([column()])[0]?.references).toBeNull();
  });
});

describe('indexRows', () => {
  const index = (overrides: Partial<IndexInfo> = {}): IndexInfo => ({
    name: 'pk_orders',
    type: 'clustered',
    columns: ['id'],
    isUnique: true,
    isPrimaryKey: true,
    ...overrides,
  });

  it('joins the key columns in order and hyphenates the catalogue spelling', () => {
    const [row] = indexRows([
      index({
        name: 'ix_orders_customer',
        type: 'nonclustered',
        columns: ['customer_id', 'placed_at'],
        isUnique: false,
        isPrimaryKey: false,
      }),
    ]);
    expect(row?.columns).toBe('customer_id, placed_at');
    expect(row?.type).toBe('non-clustered');
    expect(row?.isUnique).toBe(false);
  });

  it('defaults a missing primary-key flag to false rather than undefined', () => {
    expect(indexRows([index({ isPrimaryKey: undefined })])[0]?.isPrimaryKey).toBe(false);
  });
});

describe('keyRows', () => {
  const key = (overrides: Partial<ForeignKeyInfo> = {}): ForeignKeyInfo => ({
    name: 'fk_order_items_order',
    columns: ['order_id'],
    referencedSchema: 'public',
    referencedTable: 'orders',
    referencedColumns: ['id'],
    ...overrides,
  });

  it('renders a composite key as one row with both column lists', () => {
    const [row] = keyRows([
      key({ columns: ['tenant_id', 'order_id'], referencedColumns: ['tenant_id', 'id'] }),
    ]);
    expect(row?.columns).toBe('tenant_id, order_id');
    expect(row?.references).toBe('public.orders (tenant_id, id)');
  });

  it('shows referential actions as SQL, and says nothing for the defaults', () => {
    expect(keyRows([key({ onDelete: 'cascade', onUpdate: 'set_null' })])[0]?.rules).toBe(
      'ON DELETE CASCADE · ON UPDATE SET NULL'
    );
    // `no_action` IS the default; rendering it would fill the column with noise.
    expect(keyRows([key({ onDelete: 'no_action', onUpdate: 'no_action' })])[0]?.rules).toBeNull();
    expect(keyRows([key()])[0]?.rules).toBeNull();
  });

  it('renders the two actions the first case does not cover', () => {
    // `MetadataService.listForeignKeys` normalises each engine's spelling onto `ForeignKeyAction`
    // before the row crosses the bridge (J-66), so the five members of that union are the whole
    // input domain — this renderer used to receive PostgreSQL's `'no action'`, with a space, and
    // had to suppress it here. `restrict` is the member the declared type omitted altogether.
    expect(keyRows([key({ onDelete: 'restrict' })])[0]?.rules).toBe('ON DELETE RESTRICT');
    expect(keyRows([key({ onUpdate: 'set_default' })])[0]?.rules).toBe('ON UPDATE SET DEFAULT');
  });
});
