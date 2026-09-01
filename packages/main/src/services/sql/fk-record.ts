/**
 * The row a foreign key points at (J-145).
 *
 * Backs `QUERY.FETCH_FK_RECORD`, which the row inspector's preview calls when the user expands a
 * disclosure on an FK cell. Two things make this the path worth being careful about:
 *
 *  - the predicate's value is a **result-set cell** — data out of whatever table the user opened,
 *    which is the most attacker-influenceable input Joinery has;
 *  - it **auto-executes**. Nobody types it and nobody reviews it first.
 *
 * So the value is bound, never written into the SQL (`SQLDialect.selectOneByColumnQuery`), and on
 * MySQL the statement goes out on the restricted pool, which cannot carry a second statement at all
 * (J-137). The escaping question this used to turn on does not arise.
 *
 * ── Why this is not `QueryExecutor.execute` ──────────────────────────────────────────────────
 *
 * It was, until this ticket, and that is what put the lookup on a SQL-string seam: `QueryRequest`
 * carries `sql` and nothing to bind to it. Going straight to the driver's binding call is the whole
 * point. What is given up is the executor's own column enrichment, which it derives by parsing the
 * table back OUT of the SQL (`query-executor.ts:104-125`) and which only ever ran on SQL Server —
 * and this module does not need to parse anything, because the request names the schema and table
 * outright. The catalogue lookup below is that enrichment, working on all three engines.
 *
 * ── Why the catalogue read is `listColumns`, not `getEnrichedColumnMetadata` (J-150) ─────────
 *
 * It was `getEnrichedColumnMetadata` for one release, and that made a preview cost FOUR server
 * round trips where the SELECT is one: the enrichment fans out to `listColumns` +
 * `listForeignKeys` + a per-engine identity read (`metadata.ts:1061-1111`) — three statements on
 * MySQL and SQL Server, two on PostgreSQL, on top of the row itself.
 *
 * None of that fan-out reached the screen. `describeRow` below reads three fields off each column,
 * and the preview's own markup reads two of them (`renderer/features/query/row-detail-panel.tsx`:
 * `column.name`, `column.isPrimaryKey`). All three are already on `ColumnInfo`, which
 * `listColumns` returns from ONE statement on every engine — so the foreign-key and identity reads
 * were paying for `foreignKey`, `isIdentity`, `defaultValue`, `maxLength`, `precision` and `scale`,
 * none of which this module returns.
 *
 * So: one statement. A preview is 2 round trips on all three engines, and 1 when the reference
 * matches no row (the early return below never reaches the catalogue).
 * `fk-record-round-trips.spec.ts` asserts the count. `getEnrichedColumnMetadata` is unchanged and
 * still serves the callers that genuinely want FK and identity data —
 * `EXPLORER.GET_ENRICHED_COLUMNS` and `query-executor.ts:119`.
 *
 * Caching `listColumns` was the ticket's other option and is deliberately NOT taken: nothing in the
 * app invalidates metadata caches when a DDL statement runs in the editor, so a column cache would
 * trade fresh columns for a saving this narrowing already made unnecessary.
 */

import type { ColumnInfo, ColumnMetadata, FkRecordRequest, FkRecordResult } from '@joinery/shared';
import { ConnectionPoolManager } from './connection-pool';
import { MetadataService } from './metadata';
import { runBoundQuery } from './bound-query';
import { createLogger } from '../../utils/logger';

const log = createLogger('FkRecord');

/**
 * Fetch the single row `request.column = request.value` selects from `request.schema.request.table`.
 *
 * A reference that matches no row is a **success with no record**, not an error: the rail draws a
 * plain "no row in customers has id = 3" line for it and reserves its error card for an engine
 * that actually refused the statement.
 */
export async function fetchFkRecord(request: FkRecordRequest): Promise<FkRecordResult> {
  const pools = ConnectionPoolManager.getInstance();

  try {
    const query = pools.getDialectForProfile(request.connectionId).selectOneByColumnQuery({
      schema: request.schema,
      table: request.table,
      column: request.column,
      value: request.value,
    });

    const rows = await runBoundQuery<Record<string, unknown>>(
      pools,
      request.connectionId,
      query,
      request.database
    );

    const record = rows[0];
    if (record === undefined) return { success: true };

    return { success: true, record, columns: await describeRow(request, record) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch FK record';
    log.error(`FK lookup on ${request.schema}.${request.table} failed:`, error);
    return { success: false, error: message };
  }
}

/**
 * The returned row's columns, in the order the row carries them, decorated with what the catalogue
 * knows.
 *
 * The row's own keys decide which columns exist and in what order — they are what the server
 * actually sent back. The catalogue only adds what a driver field list cannot say: the declared
 * type, nullability, and which column is the primary key, which is what the preview marks with a
 * key glyph.
 */
async function describeRow(
  request: FkRecordRequest,
  record: Record<string, unknown>
): Promise<ColumnMetadata[]> {
  const catalogue = await catalogueColumns(request);
  const byName = new Map(catalogue.map(column => [column.name.toLowerCase(), column]));

  return Object.keys(record).map(name => {
    const match = byName.get(name.toLowerCase());
    if (match === undefined) return { name, type: 'unknown', dataType: 'unknown', nullable: true };
    return {
      name,
      type: match.dataType,
      dataType: match.dataType,
      nullable: match.isNullable,
      // Optional on `ColumnInfo` (`shared/types/database.types.ts:91-102`), so defaulted here
      // rather than passed through as `undefined` — the preview tests `isPrimaryKey === true`.
      // These three lines produce exactly the values `getEnrichedColumnMetadata` produced from the
      // same `ColumnInfo` (`metadata.ts:1137-1148`), so the shape on the wire did not change.
      isPrimaryKey: match.isPrimaryKey ?? false,
    };
  });
}

/**
 * The referenced table's catalogue columns in ONE statement, or none if the catalogue cannot be read.
 *
 * A preview that shows the row without its key markers is worth far more than one that shows an
 * error because a second, decorative query failed — so this failure is logged and swallowed
 * deliberately, and it is the only place in this module that swallows anything.
 */
async function catalogueColumns(request: FkRecordRequest): Promise<ColumnInfo[]> {
  try {
    return await MetadataService.getInstance().listColumns(
      request.connectionId,
      request.database,
      request.schema,
      request.table
    );
  } catch (error) {
    log.warn(`No catalogue metadata for ${request.schema}.${request.table}:`, error);
    return [];
  }
}
