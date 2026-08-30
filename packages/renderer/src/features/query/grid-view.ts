/**
 * One definition of "what you are looking at", read off the grid — used by BOTH Copy and Export (J-47).
 *
 * Before this module the two disagreed. Copy took the grid's displayed model (post-sort, post-filter,
 * displayed columns in displayed order); Export shipped the stored `ResultSet` whole, so a filtered,
 * re-ordered grid with a hidden column exported the untouched result set instead. Craig's ruling: both
 * mean what is on screen. That is only safe to promise once, in one place, which is this file.
 *
 * ── The grid calls this reads, and the two it deliberately does not ─────────────────────────────
 *
 * Verified against `ag-grid-community@36.1.0/dist/types/src/api/gridApi.d.ts`:
 *
 *   `getDisplayedRowCount()` (:233) and `getDisplayedRowAtIndex()` (:228) are the post-filter,
 *   post-sort accessors. `getRenderedNodes()` (:204) is NOT — its own doc says "due to virtualisation
 *   this will contain only the current visible rows and those in the buffer", so a copy built on it
 *   would be a screenful pretending to be a result.
 *
 *   `getAllDisplayedColumns()` (:664) is "all columns currently displayed … for the pinned left,
 *   centre and pinned right portions" — hidden columns absent, displayed order preserved.
 *   `getAllDisplayedVirtualColumns()` (:668) is the horizontal viewport's columns and would drop
 *   whatever the user has scrolled past.
 *
 * `forEachNodeAfterFilterAndSort()` (:406) would give the same rows, but it belongs to
 * `ClientSideRowModelApiModule` rather than `RowApiModule` and offers no way to stop early — and this
 * read has to stop at `MAX_VIEW_ROWS`. The indexed pair does both jobs.
 *
 * `GridViewSource` is a structural subset rather than `GridApi` itself so this module stays testable
 * without a browser. It is not an unchecked claim: `results-grid.tsx` hands `readGridView` a real
 * `GridApi`, so a signature drifting from AG Grid's is a typecheck failure at that call site.
 */

import type { ColumnMetadata, ResultSet } from '@joinery/shared';

import { isDataColumnId } from './grid-columns';
import type { ClipboardColumn, ClipboardRow } from './results-clipboard';

/**
 * The ceiling on how many displayed rows one copy or export may read.
 *
 * The executor already caps a result at the user's "Maximum rows to fetch" setting, so this is not the
 * user-facing limit — it is the explicit bound the loop below needs in order not to be "however many
 * the grid says". A million rows is far past any result the app fetches and far past what a clipboard
 * string can hold; hitting it is reported, never silent.
 */
export const MAX_VIEW_ROWS = 1_000_000;

/** The `Column` surface this module reads. Satisfied by AG Grid's `Column`. */
export interface GridViewColumnSource {
  getColId(): string;
  getColDef(): { readonly headerName?: string; readonly field?: string };
}

/** The `GridApi` surface this module reads. Satisfied by AG Grid's `GridApi`. */
export interface GridViewSource {
  getAllDisplayedColumns(): readonly GridViewColumnSource[];
  getDisplayedRowCount(): number;
  getDisplayedRowAtIndex(index: number): { readonly data?: unknown } | undefined;
}

export interface GridView {
  /** The displayed data columns, in displayed order. `id` is the row key; `header` is the label. */
  readonly columns: ClipboardColumn[];
  /** The displayed rows, in displayed order, by reference — at most `MAX_VIEW_ROWS` of them. */
  readonly rows: ClipboardRow[];
  /** What the grid says it is displaying, before the bound. */
  readonly displayedRowCount: number;
  /** True when `displayedRowCount` exceeded the bound and `rows` is therefore short. */
  readonly capped: boolean;
}

/** The displayed data columns, in displayed order, minus the ordinal gutter and the checkbox. */
function displayedColumns(source: GridViewSource): ClipboardColumn[] {
  const columns: ClipboardColumn[] = [];
  for (const column of source.getAllDisplayedColumns()) {
    const colId = column.getColId();
    if (!isDataColumnId(colId)) continue;
    const colDef = column.getColDef();
    // `field` is the row key the column was built from; `colId` is what AG Grid ended up calling it,
    // which differs when two result columns share a name and the grid de-duplicates the id.
    columns.push({ id: colDef.field ?? colId, header: colDef.headerName ?? colId });
  }
  return columns;
}

/**
 * Everything the grid is displaying: rows post-sort and post-filter in displayed order, and the
 * columns that are visible, in the order they are visible.
 *
 * Rows come back BY REFERENCE — the objects the IPC reply arrived in. Nothing here copies a row.
 */
export function readGridView(source: GridViewSource, maxRows: number = MAX_VIEW_ROWS): GridView {
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error(`readGridView: maxRows must be a positive integer, got ${String(maxRows)}`);
  }

  const displayedRowCount = source.getDisplayedRowCount();
  const limit = Math.min(displayedRowCount, maxRows);

  const rows: ClipboardRow[] = [];
  for (let index = 0; index < limit; index += 1) {
    const data = source.getDisplayedRowAtIndex(index)?.data as ClipboardRow | undefined;
    if (data !== undefined) rows.push(data);
  }

  return {
    columns: displayedColumns(source),
    rows,
    displayedRowCount,
    capped: displayedRowCount > limit,
  };
}

/** The view's columns, resolved back to the metadata the executor described them with. */
function projectColumns(view: GridView, columns: readonly ColumnMetadata[]): ColumnMetadata[] {
  const byName = new Map(columns.map(column => [column.name, column]));
  return view.columns.map(column => {
    const metadata = byName.get(column.id);
    if (metadata === undefined) {
      // Every data column is built from `resultSet.columns` (`grid-columns.ts:buildColumnDef` sets
      // `field: column.name`), so this cannot happen — and inventing a type would silently change
      // how the SQL INSERT encoder quotes the value.
      throw new Error(`viewResultSet: displayed column “${column.id}” is not in the result set`);
    }
    return metadata;
  });
}

/**
 * The view as a `ResultSet`, for the main process's export encoders.
 *
 * The rows ARE copied here, unlike everywhere else in this file: projecting them down to the displayed
 * columns is what keeps the promise literal (a hidden column's values never cross IPC) and it shrinks
 * the structured clone rather than growing it. Bounded by `view.rows`, which `readGridView` already
 * capped.
 */
export function viewResultSet(view: GridView, columns: readonly ColumnMetadata[]): ResultSet {
  const projected = projectColumns(view, columns);
  const rows = view.rows.map(row => {
    const projectedRow: Record<string, unknown> = {};
    for (const column of projected) projectedRow[column.name] = row[column.name];
    return projectedRow;
  });
  return { columns: projected, rows, rowCount: rows.length };
}

/** What the user is told when a copy or an export hit `MAX_VIEW_ROWS`. */
export function cappedMessage(view: GridView, verb: 'Copied' | 'Exported'): string {
  return `${verb} the first ${view.rows.length.toLocaleString()} of ${view.displayedRowCount.toLocaleString()} displayed rows — that is Joinery’s per-operation limit`;
}
