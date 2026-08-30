/**
 * "What you are looking at", read off the grid — the one definition Copy and Export both use (J-47).
 *
 * ── Why the double here is trustworthy ───────────────────────────────────────────────────────────
 *
 * The stub below stands in for `GridApi`, and every method it implements was checked against
 * `ag-grid-community@36.1.0/dist/types/src/api/gridApi.d.ts` before it was written:
 *
 *   - `getDisplayedRowCount(): number` (:233) — "the total number of displayed rows", i.e. post-filter,
 *     post-sort, NOT the rendered viewport.
 *   - `getDisplayedRowAtIndex(index): IRowNode | undefined` (:228) — the node at a DISPLAYED index;
 *     `IRowNode.data: TData | undefined` (`interfaces/iRowNode.d.ts:121`), hence the `undefined` branch.
 *   - `getAllDisplayedColumns(): Column[]` (:664) — "all columns currently displayed … for the pinned
 *     left, centre and pinned right portions", so hidden columns are absent and the order is the
 *     displayed order. `Column.getColId(): string` and `Column.getColDef(): ColDef`
 *     (`interfaces/iColumn.d.ts:160,165`); `ColDef.headerName?: string` and `ColDef.field?` are
 *     `entities/colDef.d.ts:22,250`.
 *
 * Two neighbours were read and deliberately NOT used, because each would encode a different bug:
 *
 *   - `getRenderedNodes()` (:204) — "Due to virtualisation this will contain only the current visible
 *     rows and those in the buffer." Reading it would copy a screenful and call it the result.
 *   - `getAllDisplayedVirtualColumns()` (:668) — the viewport's columns, not the grid's.
 *
 * `forEachNodeAfterFilterAndSort` (:406) would also be correct, but it lives in
 * `ClientSideRowModelApiModule` rather than `RowApiModule` and gives no cheap way to stop at a bound,
 * which is what `MAX_VIEW_ROWS` needs. The indexed pair is used instead.
 *
 * The compile-time half of the verification is at the call site: `results-grid.tsx` passes a real
 * `GridApi` to `readGridView`, so `GridViewSource` drifting from AG Grid's signatures is a typecheck
 * failure, not a green test.
 */

import { describe, expect, it } from 'vitest';
import type { ColumnMetadata } from '@joinery/shared';

import { ROW_NUMBER_COL_ID, SELECTION_COL_ID } from './grid-columns';
import { MAX_VIEW_ROWS, readGridView, viewResultSet, type GridViewSource } from './grid-view';

interface DoubleColumn {
  readonly colId: string;
  readonly field?: string;
  readonly headerName?: string;
}

/**
 * A `GridApi` stand-in over an explicit displayed model.
 *
 * A `rows` entry of `undefined` stands for a displayed index the grid counts but cannot produce a
 * node's data for, which is what `IRowNode.data`'s `| undefined` makes possible.
 */
function gridDouble(model: {
  readonly columns: readonly DoubleColumn[];
  readonly rows: readonly (Record<string, unknown> | undefined)[];
}): GridViewSource {
  return {
    getAllDisplayedColumns: () =>
      model.columns.map(column => ({
        getColId: () => column.colId,
        getColDef: () => ({ field: column.field, headerName: column.headerName }),
      })),
    getDisplayedRowCount: () => model.rows.length,
    getDisplayedRowAtIndex: (index: number) =>
      index < 0 || index >= model.rows.length ? undefined : { data: model.rows[index] },
  };
}

const CUSTOMERS: ColumnMetadata[] = [
  { name: 'id', type: 'int' },
  { name: 'email', type: 'text' },
  { name: 'secret', type: 'text' },
];

describe('readGridView — the columns', () => {
  it('takes the displayed data columns, in displayed order', () => {
    const view = readGridView(
      gridDouble({
        // Reordered by the user, and `secret` hidden — neither is in `getAllDisplayedColumns`'s output
        // in its original position, which is the whole point of asking the grid instead of the result.
        columns: [
          { colId: ROW_NUMBER_COL_ID, headerName: '#' },
          { colId: SELECTION_COL_ID },
          { colId: 'email', field: 'email', headerName: 'email' },
          { colId: 'id', field: 'id', headerName: 'id' },
        ],
        rows: [],
      })
    );

    expect(view.columns).toEqual([
      { id: 'email', header: 'email' },
      { id: 'id', header: 'id' },
    ]);
  });

  it('drops the ordinal gutter and the selection checkbox, which are chrome and not data', () => {
    const view = readGridView(
      gridDouble({
        columns: [{ colId: ROW_NUMBER_COL_ID, headerName: '#' }, { colId: SELECTION_COL_ID }],
        rows: [{ id: 1 }],
      })
    );

    expect(view.columns).toEqual([]);
  });

  it('reads the row key from `field`, so a de-duplicated colId still finds its values', () => {
    // AG Grid appends a suffix when two columns would share a colId; `field` keeps the real key.
    const view = readGridView(
      gridDouble({
        columns: [{ colId: 'id_1', field: 'id', headerName: 'id' }],
        rows: [],
      })
    );

    expect(view.columns).toEqual([{ id: 'id', header: 'id' }]);
  });
});

describe('readGridView — the rows', () => {
  it('takes every displayed row in displayed order, not the rendered viewport', () => {
    const rows = Array.from({ length: 500 }, (_unused, index) => ({ id: index }));
    const view = readGridView(gridDouble({ columns: [], rows }));

    // A viewport read (`getRenderedNodes`) would have stopped around the row buffer.
    expect(view.rows).toHaveLength(500);
    expect(view.rows[0]).toBe(rows[0]);
    expect(view.rows[499]).toBe(rows[499]);
    expect(view.displayedRowCount).toBe(500);
    expect(view.capped).toBe(false);
  });

  it('bounds the read with an explicit maximum and says when it hit it', () => {
    const rows = Array.from({ length: 10 }, (_unused, index) => ({ id: index }));
    const view = readGridView(gridDouble({ columns: [], rows }), 4);

    expect(view.rows).toHaveLength(4);
    expect(view.displayedRowCount).toBe(10);
    expect(view.capped).toBe(true);
  });

  it('defaults its bound to MAX_VIEW_ROWS', () => {
    expect(MAX_VIEW_ROWS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_VIEW_ROWS)).toBe(true);
  });

  it('refuses a bound that is not a positive integer rather than looping oddly', () => {
    const source = gridDouble({ columns: [], rows: [{ id: 1 }] });
    expect(() => readGridView(source, 0)).toThrow(/positive integer/);
    expect(() => readGridView(source, -1)).toThrow(/positive integer/);
    expect(() => readGridView(source, 1.5)).toThrow(/positive integer/);
  });

  it('skips a displayed index the grid cannot produce a node for', () => {
    const view = readGridView(gridDouble({ columns: [], rows: [{ id: 1 }, undefined, { id: 3 }] }));
    expect(view.rows).toEqual([{ id: 1 }, { id: 3 }]);
  });
});

describe('viewResultSet', () => {
  const view = readGridView(
    gridDouble({
      columns: [
        { colId: ROW_NUMBER_COL_ID, headerName: '#' },
        { colId: 'email', field: 'email', headerName: 'email' },
        { colId: 'id', field: 'id', headerName: 'id' },
      ],
      rows: [
        { id: 1, email: 'a@example.com', secret: 'hunter2' },
        { id: 2, email: null, secret: 'hunter3' },
      ],
    })
  );

  it('carries the result’s own column metadata, in the grid’s displayed order', () => {
    // Metadata, not a synthesised header: the SQL INSERT encoder branches on `type`.
    expect(viewResultSet(view, CUSTOMERS).columns).toEqual([
      { name: 'email', type: 'text' },
      { name: 'id', type: 'int' },
    ]);
  });

  it('projects the rows down to the displayed columns, so a hidden column is not exported', () => {
    expect(viewResultSet(view, CUSTOMERS).rows).toEqual([
      { email: 'a@example.com', id: 1 },
      { email: null, id: 2 },
    ]);
  });

  it('reports the projected row count, which is what the export toast counts', () => {
    expect(viewResultSet(view, CUSTOMERS).rowCount).toBe(2);
  });

  it('refuses to invent metadata for a displayed column the result never described', () => {
    expect(() => viewResultSet(view, [{ name: 'id', type: 'int' }])).toThrow(/email/);
  });
});
