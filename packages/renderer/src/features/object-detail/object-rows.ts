/**
 * What the object tab's three tables render, derived from what the bridge answers. No React, no IPC.
 *
 * ── Why the enriched reader and not `getTableColumns` ───────────────────────────────────────
 *
 * The Angular explorer tab read `explorer.getTableColumns`, whose `ColumnInfo` carries a name, a type,
 * nullability, a PK flag and a default — and **no identity flag and no foreign key**. Its Columns table
 * therefore showed five columns and could not answer the two questions a user actually opens an object
 * for: is this the identity, and where does it point?
 *
 * `explorer.getEnrichedColumns` answers both, on all three engines (`metadata.ts:1033-1149`), and Task
 * 14 already built a consumer for it (`features/query/fk-lookup.ts`, whose `EnrichedColumn` type is
 * derived from the preload declaration rather than re-typed — PLAN.md §7.2's anonymous 15-field return).
 * This module reuses that type rather than declaring a second view of the same shape.
 *
 * The type string goes through `features/query/row-detail.ts`'s `formatColumnType`, which is the one
 * that handles PostgreSQL's `character varying(2147483647)` and SQL Server's two spellings of
 * `varchar(max)`. There are two `formatColumnType`s in this renderer and picking the wrong one is easy:
 * the ERD's takes a `ColumnInfo` (`dataType`, undefined-able numbers) and this one takes a
 * `ColumnMetadata` (`type`, nullable numbers), which is the shape an enriched column converts to.
 */

import type { ColumnMetadata, ForeignKeyAction, ForeignKeyInfo, IndexInfo } from '@joinery/shared';

import type { EnrichedColumn } from '../query/fk-lookup';
import { formatColumnType } from '../query/row-detail';

/** One row of the Columns table. */
export interface ColumnRow {
  readonly name: string;
  /** The declared type with its length or precision, e.g. `nvarchar(64)`. */
  readonly type: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly isIdentity: boolean;
  /** The default expression, or `null` when the column has none. */
  readonly defaultValue: string | null;
  /** `schema.table.column`, or `null` when the column references nothing. */
  readonly references: string | null;
}

/**
 * An enriched column as a `ColumnMetadata`, which is what `formatColumnType` reads.
 *
 * The `null → undefined` mapping is the whole conversion: the bridge's enriched row uses `null` for
 * "the catalogue did not say", and `ColumnMetadata` uses `undefined` for the same thing. Passing the
 * nulls straight through would defeat every `!== undefined` guard in the formatter and print
 * `nvarchar(null)`.
 */
function asColumnMetadata(column: EnrichedColumn): ColumnMetadata {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    maxLength: column.maxLength ?? undefined,
    precision: column.precision ?? undefined,
    scale: column.scale ?? undefined,
    isPrimaryKey: column.isPrimaryKey,
    isIdentity: column.isIdentity,
    defaultValue: column.defaultValue ?? undefined,
    foreignKey: column.foreignKey ?? undefined,
  };
}

export function columnRows(columns: readonly EnrichedColumn[]): readonly ColumnRow[] {
  return columns.map(column => ({
    name: column.name,
    type: formatColumnType(asColumnMetadata(column)),
    nullable: column.nullable,
    isPrimaryKey: column.isPrimaryKey,
    isIdentity: column.isIdentity,
    defaultValue: column.defaultValue,
    references:
      column.foreignKey === null
        ? null
        : qualifiedReference(
            column.foreignKey.referencedSchema,
            column.foreignKey.referencedTable,
            column.foreignKey.referencedColumn
          ),
  }));
}

/** One row of the Indexes table. */
export interface IndexRow {
  readonly name: string;
  readonly type: string;
  /** The indexed columns in key order, comma-separated. */
  readonly columns: string;
  readonly isUnique: boolean;
  readonly isPrimaryKey: boolean;
}

export function indexRows(indexes: readonly IndexInfo[]): readonly IndexRow[] {
  return indexes.map(index => ({
    name: index.name,
    // `nonclustered` → `non-clustered`: the catalogue's spelling is a word this app does not use in
    // prose anywhere else, and the hyphen is what makes it read as English rather than as a column value.
    type: index.type === 'nonclustered' ? 'non-clustered' : index.type,
    columns: index.columns.join(', '),
    isUnique: index.isUnique,
    isPrimaryKey: index.isPrimaryKey ?? false,
  }));
}

/** One row of the Keys table: a whole foreign-key constraint, which may span several columns. */
export interface KeyRow {
  readonly name: string;
  /** The local columns, comma-separated. */
  readonly columns: string;
  /** `schema.table (col, col)` — the whole target, so a composite key reads correctly. */
  readonly references: string;
  /** `ON DELETE` / `ON UPDATE`, as SQL words, or `null` when the catalogue reported neither. */
  readonly rules: string | null;
}

export function keyRows(keys: readonly ForeignKeyInfo[]): readonly KeyRow[] {
  return keys.map(key => ({
    name: key.name,
    columns: key.columns.join(', '),
    references: `${qualifiedReference(key.referencedSchema, key.referencedTable)} (${key.referencedColumns.join(', ')})`,
    rules: referentialRules(key),
  }));
}

/**
 * The referential actions, as SQL words. `NO ACTION` is the default and says nothing, so it is dropped.
 *
 * Exactly one spelling arrives: `MetadataService.listForeignKeys` normalises every engine's catalogue
 * onto `ForeignKeyAction` before the row crosses the bridge (J-66). This renderer once had to normalise
 * for itself, because PostgreSQL reached it as `'no action'` — with a space — while the declared type
 * said `'no_action'`, and the comparison let the default straight through: every seeded key rendered
 * `ON UPDATE NO ACTION`. What is left here is display formatting, not defence.
 */
function referentialRules(key: ForeignKeyInfo): string | null {
  const parts: string[] = [];
  const deleteRule = sqlAction(key.onDelete);
  const updateRule = sqlAction(key.onUpdate);
  if (deleteRule !== null) parts.push(`ON DELETE ${deleteRule}`);
  if (updateRule !== null) parts.push(`ON UPDATE ${updateRule}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** One action as SQL words, or `null` when absent and for the default. */
function sqlAction(action: ForeignKeyAction | undefined): string | null {
  if (action === undefined) return null;
  const words = action.replace(/_/g, ' ').toUpperCase();
  return words === 'NO ACTION' ? null : words;
}

/**
 * `schema.table` or `schema.table.column`, with an empty schema dropped.
 *
 * MySQL's `referencedSchema` is a **database** name and is legitimately the connected one, in which
 * case the catalogue may report it empty — `features/query/fk-lookup.ts` has the whole story. Printing
 * a leading dot for that case is how a reference reads as broken when it is fine.
 */
function qualifiedReference(schema: string, table: string, column?: string): string {
  const base = schema === '' ? table : `${schema}.${table}`;
  return column === undefined ? base : `${base}.${column}`;
}
