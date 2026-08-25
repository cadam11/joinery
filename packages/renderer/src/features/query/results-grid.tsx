/**
 * The results grid: AG Grid 36 over one result set, and the strip of controls above it.
 *
 * Replaces the 2,055-line `results-grid.component.ts` — or the half of it that is this task's. The
 * grid's own API surface is shallow (PLAN.md §4 Decision B: `ColDef`, `GridApi`, `defaultColDef`,
 * `ModuleRegistry`, `onGridReady`, cell classes), so this is a port, not a rewrite. What did NOT come
 * across, and where it went:
 *
 *  - the **FK preview popover** and the **cell-value preview panel** → Task 14's row-detail rail,
 *    which this file now OPENS and does not otherwise know about: `onRowOpen` hands over the clicked
 *    row, the columns, and a `DisplayedRows` accessor over the grid's own displayed order. The data
 *    it needs was already here — `cell-fk` is applied to the right cells and `headerTooltipFor`
 *    records the reference.
 *  - the **column statistics panel** → nothing in PLAN.md or this brief claims it. It is a parity gap
 *    on purpose rather than by accident, recorded in the task report for a ticket of its own.
 *  - the **cell context menu** (copy cell / copy row as JSON / copy as INSERT / filter by value) →
 *    the same: its FK half is Task 14's, and splitting one menu across two tasks would ship it twice.
 *
 * ── R2, which is the whole reason this file is shaped the way it is ────────────────────────────
 *
 * PLAN.md's risk register: "A React port can accidentally re-render 10k rows per keystroke through a
 * badly-scoped store selector." Three rules, all of them load-bearing and all of them measured (the
 * unit proof is `render-isolation.spec.tsx`, the browser proof is task-11-perf.mjs):
 *
 *  1. **`memo`, with props that keep their identity.** `resultSet` comes from the execution store's
 *     `results` Map, so its identity only changes when a query lands; `tabId` is a string. A keystroke
 *     in the editor re-renders `QueryPanel` (the first one does — it flips `isDirty`), and the memo
 *     boundary stops there.
 *  2. **Row data by reference.** `rowData={resultSet.rows}` — the array the IPC reply arrived in, never
 *     a mapped copy. A `.map()` in the render body would hand AG Grid a new array of new objects on
 *     every render, which is a full grid refresh per keystroke.
 *  3. **Narrow selectors.** Two subscriptions, `settings.grid` and the effective theme, both of which
 *     change when a user changes a setting and never otherwise. Nothing here subscribes to a whole
 *     store, and nothing subscribes to the execution store at all — the result arrives as a prop.
 *
 * ── Two commands are claimed here, and only one grid may answer ───────────────────────────────
 *
 * Dockview keeps inactive panels mounted, so every open query tab has a live grid. Both handlers
 * therefore need a "is this me?" test, and they use different ones because the questions differ:
 * Edit ▸ Copy belongs to the grid the user is *in* (focus containment, exactly as
 * `results-grid.component.ts:1207-1220` decided it), while File ▸ Export Results belongs to the
 * *active tab's* grid, which is the same guard `query-commands.tsx` uses for its twelve.
 */

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type Column,
  type GridApi,
  type GridReadyEvent,
  type RowSelectionOptions,
} from 'ag-grid-community';
import {
  AlertTriangle,
  Columns3,
  Copy,
  Download,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  Rows3,
  X,
} from 'lucide-react';
import type { CopyFormat, ExportFormat, ResultSet } from '@joinery/shared';

import { dispatchCommand, useCommand } from '../../commands';
import { MAX_ROWS_SETTING_LABEL } from '../settings/settings-labels';
import { ipc, isIpcAvailable } from '../../ipc';
import { diagnostics, notify } from '../../state/diagnostics';
import { selectEffectiveTheme, selectGridSettings, useSettingsStore } from '../../state/settings';
import { tabStore } from '../../state/tab';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
  ToolbarSpacer,
  Tooltip,
} from '../../ui';
import { keyHint } from '../../utils/platform';
import {
  DEFAULT_COL_DEF,
  ROW_NUMBER_COL_ID,
  buildColumnDefs,
  isDataColumnId,
} from './grid-columns';
import type { DisplayedRows, RowDetailTarget } from './row-detail-panel';
import {
  buildClipboardText,
  copyScopeLabel,
  type ClipboardColumn,
  type ClipboardRow,
} from './results-clipboard';

/**
 * Every community feature, registered once on import. AG Grid 36 requires an explicit registration —
 * an unregistered module is a silently missing feature (no sorting, no filtering) rather than an
 * error. Module scope, like `results-grid.component.ts:53`: this file is inside the lazily-loaded
 * query-panel chunk, so it costs nothing until a query tab opens.
 */
ModuleRegistry.registerModules([AllCommunityModule]);

/** What SQL INSERT export names the table. The Angular query tab passed the same literal. */
const EXPORT_TABLE_NAME = 'QueryResults';

/**
 * Multi-row selection with checkboxes, and AG Grid's own ⌘C handler left off — copying is this
 * component's job, because the user's `CopyFormat` setting decides the bytes. Ported from `:1253-1256`;
 * module-scoped so the object identity is stable across renders (a fresh one is a grid option change).
 */
const ROW_SELECTION: RowSelectionOptions = {
  mode: 'multiRow',
  copySelectedRows: false,
};

/**
 * The ceiling auto-size may give a column, in px. A single 4KB JSON cell would otherwise produce a
 * column wider than the window; the user can still drag past this.
 */
const MAX_AUTO_WIDTH = 1100;

/**
 * Every open query tab has a grid, so a copy has to belong to the one the user is looking at.
 *
 * **The host is the grid div, not the whole pane** — narrower than Angular's, whose `ElementRef` was the
 * component and therefore included the toolbar (`results-grid.component.ts:1210`). So ⌘C with the quick
 * filter focused is declined here by containment, where Angular declined it by its editable-element
 * test. Both refuse, for different reasons, and the narrower host is the one that generalises: a future
 * control in this toolbar that is not an `<input>` would have inherited Angular's claim.
 *
 * `focusIsEditable` still matters and is not redundant: AG Grid's floating-filter inputs are genuinely
 * inside this host, and that is the path it stands in front of.
 */
function hostContainsFocus(host: HTMLElement | null): boolean {
  const active = document.activeElement;
  return host !== null && active !== null && host.contains(active);
}

/**
 * True when the user has a real text selection — a drag across cell text. They asked for that string,
 * so Edit ▸ Copy must not replace it with the whole row (`:1215-1216`).
 */
function hasTextSelection(): boolean {
  const selection = document.getSelection();
  return selection !== null && selection.toString().length > 0;
}

/** An editable element inside the grid — the quick filter, a floating filter, a future cell editor. */
function focusIsEditable(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active === null) return false;
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
}

export interface ResultsGridProps {
  /** The result set to show. Passed by reference; its `rows` array reaches AG Grid untouched. */
  readonly resultSet: ResultSet;
  /** Which tab this grid belongs to, so File ▸ Export Results can ask whether that tab is active. */
  readonly tabId: string;
  /**
   * Which result set of the batch this is. Travels with an opened row so the rail can tell whether
   * the grid it belongs to is still the one on screen — see `query-results.tsx`.
   */
  readonly resultIndex: number;
  /**
   * Opens the row-detail rail on one row. The payload is assembled here because the grid is the only
   * thing that knows the DISPLAYED order; everything else about the rail is `query-results.tsx`'s.
   */
  readonly onRowOpen: (target: RowDetailTarget) => void;
}

export const ResultsGrid = memo(function ResultsGrid({
  resultSet,
  tabId,
  resultIndex,
  onRowOpen,
}: ResultsGridProps) {
  const gridSettings = useSettingsStore(selectGridSettings);
  const theme = useSettingsStore(selectEffectiveTheme);

  const api = useRef<GridApi | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [filterText, setFilterText] = useState('');
  const [selectedCount, setSelectedCount] = useState(0);

  const columnDefs: ColDef[] = useMemo(
    () => buildColumnDefs(resultSet.columns, { showRowNumbers: gridSettings.showRowNumbers }),
    [resultSet.columns, gridSettings.showRowNumbers]
  );

  /** The true received count, which exceeds `rows.length` when the executor capped the set. */
  const totalRows = resultSet.rowCount ?? resultSet.rows.length;
  const displayedRows = resultSet.rows.length;
  const truncated = resultSet.truncated === true;

  /**
   * Auto-size to content, then cap. AG Grid measures the RENDERED cells, so this is O(visible rows)
   * rather than O(100k) — which is why it is safe to run on every result.
   *
   * The cap loop is bounded by the column count and takes the grid's own list, so a column that
   * refuses to shrink cannot spin it.
   */
  const autoSizeColumns = useCallback((): void => {
    const grid = api.current;
    if (grid === null) return;
    grid.autoSizeAllColumns();

    const columns: Column[] = grid.getColumns() ?? [];
    const oversized = columns
      .filter(column => column.getActualWidth() > MAX_AUTO_WIDTH)
      .map(column => ({ key: column, newWidth: MAX_AUTO_WIDTH }));
    if (oversized.length > 0) grid.setColumnWidths(oversized);
  }, []);

  const onGridReady = useCallback(
    (event: GridReadyEvent): void => {
      api.current = event.api;
      autoSizeColumns();
    },
    [autoSizeColumns]
  );

  /**
   * Renumber the ordinal gutter after a sort or a filter.
   *
   * `rowNumberColumnDef`'s `valueGetter` reads `node.rowIndex`, which IS the displayed index — but AG
   * Grid does not re-run a value getter for a row that is merely re-positioned, so the Angular grid's
   * gutter kept its original numbers and a descending sort read `5 4 3 2 1` down the # column. That is
   * a faithful port of a bug: an ordinal that does not count the rows in front of it is not an ordinal.
   *
   * `refreshCells` on the one column, which re-runs only that getter for the rendered rows — O(visible),
   * not O(result). Skipped entirely when the gutter is off, so the call cannot name a column that does
   * not exist.
   */
  const refreshOrdinals = useCallback((): void => {
    if (!gridSettings.showRowNumbers) return;
    api.current?.refreshCells({ columns: [ROW_NUMBER_COL_ID], force: true });
  }, [gridSettings.showRowNumbers]);

  /**
   * The columns a copy or an export covers: what the grid is displaying, minus the ordinal gutter and
   * AG Grid's checkbox column. Read from the grid rather than from `resultSet.columns` so a hidden or
   * reordered column is honoured — the user copies what they can see.
   */
  const clipboardColumns = useCallback((grid: GridApi): ClipboardColumn[] => {
    return grid
      .getAllDisplayedColumns()
      .filter(column => isDataColumnId(column.getColId()))
      .map(column => ({
        id: column.getColId(),
        header: column.getColDef().headerName ?? column.getColId(),
      }));
  }, []);

  /**
   * Every row currently displayed, in displayed order. Bounded by the grid's own reported count, and
   * it is the post-sort, post-filter set — which is what "copy what I am looking at" means.
   */
  const displayedRowData = useCallback((grid: GridApi): ClipboardRow[] => {
    const rows: ClipboardRow[] = [];
    const total = grid.getDisplayedRowCount();
    for (let index = 0; index < total; index += 1) {
      const data = grid.getDisplayedRowAtIndex(index)?.data as ClipboardRow | undefined;
      if (data !== undefined) rows.push(data);
    }
    return rows;
  }, []);

  /**
   * Copy, in the user's format. Selection first; with nothing selected it copies ALL displayed rows,
   * which is Craig's rule from `:1506-1508` — pressing Copy with no selection must never silently
   * copy nothing.
   *
   * `formatOverride` is what the two menu items ("Copy as JSON", "Copy as TSV with Headers") pass; it
   * wins over the setting for that one call.
   */
  const copyRows = useCallback(
    (formatOverride?: {
      readonly format?: CopyFormat;
      readonly includeHeaders?: boolean;
    }): void => {
      const grid = api.current;
      if (grid === null) return;

      const format = formatOverride?.format ?? gridSettings.copyFormat;
      const includeHeaders = formatOverride?.includeHeaders ?? gridSettings.copyIncludeHeaders;

      const selected = grid.getSelectedRows() as ClipboardRow[];
      const fromSelection = selected.length > 0;
      const rows = fromSelection ? selected : displayedRowData(grid);
      if (rows.length === 0) {
        notify.info('No rows to copy');
        return;
      }

      const text = buildClipboardText({
        rows,
        columns: clipboardColumns(grid),
        format,
        includeHeaders,
      });

      // The write is async and can be refused (a document that is not focused), so the toast is not
      // fired until it resolved — the Angular version claimed success unconditionally.
      void navigator.clipboard
        .writeText(text)
        .then(() =>
          notify.info(
            `Copied ${copyScopeLabel(rows.length, fromSelection)} to clipboard (${format.toUpperCase()})`
          )
        )
        .catch(error => {
          notify.error('Could not copy to the clipboard');
          diagnostics.error('clipboard write failed', error);
        });
    },
    [clipboardColumns, displayedRowData, gridSettings.copyFormat, gridSettings.copyIncludeHeaders]
  );

  /**
   * Export through the main process: it shows the save dialog, formats, and writes the file
   * (`main/src/ipc/query.ipc.ts:111-166`). The renderer sends the result set and gets a verdict.
   *
   * **What gets exported, precisely: the WHOLE capped result set — every row the executor sent, in the
   * order it sent them, with every column it described.** Sorting, the quick filter, the column filters
   * and any hidden or reordered column are all ignored, because what crosses IPC is `resultSet`, not the
   * grid's view of it. That is deliberately NOT what Copy does (Copy is the selection, or every
   * *displayed* row in *displayed* order with only the *displayed* data columns), so the two now make
   * different promises about the word "results". **J-47 records that for Craig to rule on**, with the
   * shape of an "export what the grid shows" option if he wants one.
   *
   * This is the seam the Angular *menu* used (`query.component.ts:1963-1987`); the Angular grid's own
   * CSV button instead called `gridApi.exportDataAsCsv`, which exports the grid VIEW — but through the
   * `valueFormatter`, so its CSV carried locale-grouped numbers (`1,234.5`) and the display string
   * `NULL`. Rerouting fixes that defect and costs the view semantics; both halves of the trade are in
   * J-47. It also removes a Blob plus a synthetic `<a download>` click, which is at best untested under
   * `default-src 'none'` over `file://`, and it leaves one CSV encoder in the app instead of two.
   */
  const exportResults = useCallback(
    (format: ExportFormat): void => {
      if (!isIpcAvailable()) return;
      if (resultSet.rows.length === 0) {
        notify.warning('No results to export');
        return;
      }
      void ipc()
        .query.exportResults(resultSet, {
          format,
          includeHeaders: true,
          prettyPrint: true,
          tableName: EXPORT_TABLE_NAME,
        })
        .then(result => {
          if (result.success) {
            notify.success(`Exported ${result.rowsExported ?? 0} rows to ${result.filePath ?? ''}`);
            return;
          }
          // A dismissed dialog is not a failure. Main says so in this exact string.
          if (result.error === 'Export cancelled') return;
          notify.error(`Export failed: ${result.error ?? 'unknown error'}`);
        })
        .catch(error => {
          notify.error('Export failed');
          diagnostics.error('failed to export results', error);
        });
    },
    [resultSet]
  );

  /**
   * Edit ▸ Copy (⌘C). The claim protocol: return true and the menu bridge stops, return nothing and
   * it falls back to `document.execCommand('copy')` (`shell/menu-bridge.tsx:120`).
   *
   * The three refusals are Angular's, in Angular's order — not in this grid, in an editable field, or
   * there is a real text selection — and each one hands the keystroke back rather than eating it.
   */
  useCommand('menu-copy', () => {
    if (!hostContainsFocus(host.current)) return undefined;
    if (focusIsEditable()) return undefined;
    if (hasTextSelection()) return undefined;
    copyRows();
    return true;
  });

  /** File ▸ Export Results. CSV, as the Angular menu chose (`query.component.ts:1104`). */
  useCommand('export-results', () => {
    if (tabStore.getState().activeTabId !== tabId) return;
    exportResults('csv');
  });

  /**
   * The grid's displayed order, as two bounded reads.
   *
   * Built once per mount and closing over the api REF rather than the api, so it stays valid while
   * the grid lives and answers honestly once it does not: `isDestroyed()` is checked on every call,
   * because a rail can outlive its grid by a frame when a new result lands. `getDisplayedRowAtIndex`
   * is AG Grid's own post-sort, post-filter accessor — the same one `results-grid.component.ts` used
   * (`getDisplayedRowAt`), and the reason Next/Previous cannot fall back to `resultSet.rows[N]`.
   */
  const displayedOrder = useMemo<DisplayedRows>(
    () => ({
      count: () => {
        const grid = api.current;
        if (grid === null || grid.isDestroyed()) return 0;
        return grid.getDisplayedRowCount();
      },
      at: index => {
        const grid = api.current;
        if (grid === null || grid.isDestroyed() || index < 0) return null;
        const node = grid.getDisplayedRowAtIndex(index);
        return (node?.data as Record<string, unknown> | undefined) ?? null;
      },
    }),
    []
  );

  /**
   * Open the rail on a displayed row.
   *
   * **Double-click, not click.** Angular opened the drawer from `onCellSelected`
   * (`query.component.ts:2226`), i.e. from any single click on any cell — which fought with the two
   * other things a single click means in this grid: dragging out a text selection (`enableCellTextSelection`
   * is on, and Edit ▸ Copy honours a real selection) and ticking a row for a multi-row copy. A modal
   * drawer appearing when a user starts a drag is the kind of thing nobody reports and everybody
   * works around. Double-click is unclaimed here, and the command is the discoverable path.
   */
  const openRow = useCallback(
    (rowIndex: number | null | undefined, row: Record<string, unknown> | undefined): void => {
      if (rowIndex === null || rowIndex === undefined || row === undefined) return;
      onRowOpen({
        rowIndex,
        row,
        columns: resultSet.columns,
        totalRows: displayedOrder.count(),
        resultIndex,
        source: displayedOrder,
      });
    },
    [displayedOrder, onRowOpen, resultIndex, resultSet.columns]
  );

  /**
   * Results ▸ Inspect Row. Claimed by the ACTIVE tab's grid, the same guard File ▸ Export Results
   * uses — and it opens the focused row, or the first selected one, or the first displayed one, in
   * that order, so the command works with the keyboard alone.
   */
  useCommand('results-row-open', () => {
    if (tabStore.getState().activeTabId !== tabId) return;
    const grid = api.current;
    if (grid === null || grid.isDestroyed()) return;

    const focused = grid.getFocusedCell();
    if (focused !== null && focused !== undefined) {
      const node = grid.getDisplayedRowAtIndex(focused.rowIndex);
      openRow(focused.rowIndex, node?.data as Record<string, unknown> | undefined);
      return;
    }
    const [selected] = grid.getSelectedNodes();
    if (selected !== undefined) {
      openRow(selected.rowIndex, selected.data as Record<string, unknown> | undefined);
      return;
    }
    const first = grid.getDisplayedRowAtIndex(0);
    if (first === undefined) {
      notify.info('No rows to inspect');
      return;
    }
    openRow(0, first.data as Record<string, unknown> | undefined);
  });

  const clearFilter = useCallback(() => setFilterText(''), []);

  const copyHint = `Copy selected (${keyHint('C')})`;

  return (
    <div className="flex min-h-0 grow flex-col" data-testid="results-pane">
      <Toolbar aria-label="Results" data-testid="results-toolbar" className="gap-2">
        {/* Counts. Angular's wording, including the "showing first N of M" form when the executor
            capped the set — that is the only place a user learns their maxRowsToDisplay bit. */}
        <p className="flex shrink-0 items-baseline gap-3 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
          {truncated ? (
            <Tooltip
              // The setting's own label, imported rather than transcribed: this string used to say
              // "maximum rows to display" — the field name — while the control said "Maximum rows
              // to fetch", so the tooltip named a setting the user could not find (J-107).
              content={`Capped by your “${MAX_ROWS_SETTING_LABEL}” setting — the full result was ${totalRows.toLocaleString()} rows`}
            >
              {/* Amber marks the caution; the words stay `text-fg`. `--color-warning` measures 4.40:1
                  on `bg-chrome` under ivory — fine for a 14px icon (3:1 for non-text UI) and short of
                  AA body for a 10px label, which is what HOUSE-RULES §5 means by certifying a token
                  against its own canvas rather than against the one it was measured on. */}
              <span data-testid="results-truncated" className="flex items-center gap-1.5 text-fg">
                <AlertTriangle className="size-3.5 shrink-0 stroke-warning" aria-hidden />
                showing first{' '}
                <span className="tabular-nums" data-testid="results-displayed-count">
                  {displayedRows.toLocaleString()}
                </span>{' '}
                of{' '}
                <span className="tabular-nums" data-testid="results-row-count">
                  {totalRows.toLocaleString()}
                </span>{' '}
                rows
              </span>
            </Tooltip>
          ) : (
            <span className="text-fg">
              <span className="tabular-nums" data-testid="results-row-count">
                {totalRows.toLocaleString()}
              </span>{' '}
              {totalRows === 1 ? 'row' : 'rows'}
            </span>
          )}
          <span data-testid="results-column-count" className="tabular-nums">
            {resultSet.columns.length} {resultSet.columns.length === 1 ? 'col' : 'cols'}
          </span>
          {selectedCount > 0 ? (
            <span data-testid="results-selected-count" className="text-accent">
              <span className="tabular-nums">{selectedCount.toLocaleString()}</span> selected
            </span>
          ) : null}
          {filterText === '' ? null : (
            <span data-testid="results-filtered" className="text-warning">
              filtered
            </span>
          )}
        </p>

        <ToolbarSpacer />

        {/* The quick filter. `Input` renders the control plus a label wrapper; there is no room for a
            visible label in a 36px strip, so the name is an `aria-label` — the one case
            `form-controls.md` allows it. */}
        <div className="relative w-48 shrink-0">
          <Input
            name="results-filter"
            aria-label="Filter results"
            placeholder="Filter…"
            data-testid="results-filter"
            value={filterText}
            onChange={event => setFilterText(event.target.value)}
            className="pr-7 text-sm"
          />
          {filterText === '' ? null : (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              leadingIcon={X}
              aria-label="Clear the filter"
              data-testid="results-filter-clear"
              onClick={clearFilter}
              className="absolute top-1/2 right-0 -translate-y-1/2"
            />
          )}
        </div>

        <ToolbarSeparator />

        <Tooltip content="Fit columns to their contents">
          <ToolbarButton
            iconOnly
            leadingIcon={Columns3}
            aria-label="Fit columns to their contents"
            data-testid="results-autosize"
            onClick={autoSizeColumns}
          />
        </Tooltip>

        <Tooltip content="Inspect the focused row">
          <ToolbarButton
            iconOnly
            leadingIcon={Rows3}
            aria-label="Inspect the focused row"
            data-testid="results-inspect-row"
            onClick={() => dispatchCommand('results-row-open')}
          />
        </Tooltip>

        <Tooltip content={copyHint}>
          <ToolbarButton
            iconOnly
            leadingIcon={Copy}
            aria-label={copyHint}
            data-testid="results-copy"
            onClick={() => copyRows()}
          />
        </Tooltip>

        <DropdownMenu>
          <Tooltip content="Export">
            <DropdownMenuTrigger asChild>
              <ToolbarButton
                iconOnly
                leadingIcon={Download}
                aria-label="Export"
                data-testid="results-export"
              />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="results-export-csv"
              onSelect={() => exportResults('csv')}
            >
              <FileSpreadsheet className="size-4 shrink-0" aria-hidden />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="results-export-json"
              onSelect={() => exportResults('json')}
            >
              <FileJson className="size-4 shrink-0" aria-hidden />
              Export as JSON
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="results-export-sql"
              onSelect={() => exportResults('sql')}
            >
              <FileCode2 className="size-4 shrink-0" aria-hidden />
              Export as SQL INSERT
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="results-copy-json"
              onSelect={() => copyRows({ format: 'json' })}
            >
              <FileJson className="size-4 shrink-0" aria-hidden />
              Copy as JSON
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="results-copy-tsv"
              onSelect={() => copyRows({ format: 'tsv', includeHeaders: true })}
            >
              <Copy className="size-4 shrink-0" aria-hidden />
              Copy as TSV with headers
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Toolbar>

      <div
        ref={host}
        data-testid="results-grid"
        // The two vendor classes are bound to the effective theme; `ag-theme-joinery` is the token
        // map. `results-grid-theme.css` explains why the vendor class is bound rather than fixed.
        className={[
          'relative min-h-0 grow',
          theme === 'dark' ? 'ag-theme-quartz-dark' : 'ag-theme-quartz',
          'ag-theme-joinery',
          gridSettings.alternatingRowColors ? 'ag-theme-joinery-striped' : '',
        ]
          .filter(part => part !== '')
          .join(' ')}
      >
        <AgGridReact
          // `legacy` opts into the CSS themes imported by styles/theme.css. Without it AG Grid 36
          // applies its own Theming API quartz on top of them and warns about the collision.
          theme="legacy"
          // Rule 2 of the R2 discipline: the array from the IPC reply, by reference.
          rowData={resultSet.rows}
          columnDefs={columnDefs}
          defaultColDef={DEFAULT_COL_DEF}
          rowSelection={ROW_SELECTION}
          rowHeight={gridSettings.rowHeight}
          animateRows={gridSettings.animateRows}
          quickFilterText={filterText}
          suppressClipboardPaste
          enableCellTextSelection
          rowBuffer={20}
          onGridReady={onGridReady}
          onRowDataUpdated={autoSizeColumns}
          // Both, because both change which row is displayed where — and the gutter counts displayed
          // positions. See `refreshOrdinals`.
          onSortChanged={refreshOrdinals}
          onFilterChanged={refreshOrdinals}
          onSelectionChanged={() => setSelectedCount(api.current?.getSelectedRows().length ?? 0)}
          onRowDoubleClicked={event =>
            openRow(event.rowIndex, event.data as Record<string, unknown> | undefined)
          }
        />

        {/* A query that succeeded and matched nothing is not an error, and an empty grid with a header
            row is not a sentence. Ported from `:206-211`. */}
        {resultSet.rows.length === 0 ? (
          <div
            data-testid="results-empty"
            className="pointer-events-none absolute inset-0 top-(--panel-header-height) flex items-start justify-center pt-6"
          >
            <p className="text-md text-fg-muted">Query executed successfully — 0 rows returned</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});
