/**
 * The grid's own decisions, with AG Grid itself replaced by a double.
 *
 * The double is not a shortcut. jsdom has no layout engine, so a real AG Grid reports a 0px viewport
 * and renders no rows at all — asserting on cells there would be asserting on a grid that a user never
 * sees. What CAN be tested without a browser is everything this component decides: which props reach
 * the grid (and whether the row array is the one that arrived over IPC, R2's rule 2), what the toolbar
 * says, and what the copy/export/claim handlers do with the grid's API. The rendered result is covered
 * by the e2e tier and the both-theme browser gate, against a real Chromium and real PostgreSQL rows.
 *
 * The double also hands the component a `GridApi` stub, which is what makes the copy paths testable at
 * all: `getSelectedRows` / `getAllDisplayedColumns` / `getDisplayedRowAtIndex` are the three calls the
 * clipboard logic is built on, and a real grid in jsdom would answer all three with nothing.
 */

import { useEffect, useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@joinery/shared';
import { MAX_ROWS_SETTING_LABEL } from '../settings/settings-labels';
import type { AppSettings, ExportOptions, ExportResult, ResultSet } from '@joinery/shared';

import { dispatchCommand } from '../../commands';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { settingsStore } from '../../state/settings';
import { tabStore } from '../../state/tab';
import { TooltipProvider } from '../../ui';
import { ROW_NUMBER_COL_ID, SELECTION_COL_ID } from './grid-columns';

// ── The AG Grid double ─────────────────────────────────────────────────────────────────────

interface GridDoubleProps {
  readonly rowData?: readonly Record<string, unknown>[];
  readonly columnDefs?: readonly { readonly field?: string; readonly colId?: string }[];
  readonly quickFilterText?: string;
  readonly rowHeight?: number;
  readonly animateRows?: boolean;
  readonly theme?: string;
  readonly onGridReady?: (event: { api: unknown }) => void;
  readonly onSelectionChanged?: () => void;
  readonly onRowDataUpdated?: () => void;
  readonly onSortChanged?: () => void;
  readonly onFilterChanged?: () => void;
}

/** What the component last handed the grid, and how many times it rendered it. */
const grid = {
  props: null as GridDoubleProps | null,
  renders: 0,
  /** Rows the api pretends are selected. */
  selected: [] as Record<string, unknown>[],
  /** Rows the api pretends are displayed, in displayed order. */
  displayed: [] as Record<string, unknown>[],
  /** Displayed columns, as `getAllDisplayedColumns` reports them. */
  columns: [] as { id: string; header?: string; width: number }[],
  autoSized: 0,
  widthsSet: [] as { key: unknown; newWidth: number }[][],
  refreshed: [] as { columns?: unknown[]; force?: boolean }[],
  /** The handlers the component installed, so a test can fire a grid event. */
  events: null as Pick<
    GridDoubleProps,
    'onSelectionChanged' | 'onRowDataUpdated' | 'onSortChanged' | 'onFilterChanged'
  > | null,
};

const gridApi = {
  getSelectedRows: () => grid.selected,
  getDisplayedRowCount: () => grid.displayed.length,
  getDisplayedRowAtIndex: (index: number) =>
    grid.displayed[index] === undefined ? undefined : { data: grid.displayed[index] },
  getAllDisplayedColumns: () =>
    grid.columns.map(column => ({
      getColId: () => column.id,
      getColDef: () => ({ headerName: column.header }),
      getActualWidth: () => column.width,
    })),
  getColumns: () =>
    grid.columns.map(column => ({
      getColId: () => column.id,
      getActualWidth: () => column.width,
    })),
  autoSizeAllColumns: () => {
    grid.autoSized += 1;
  },
  setColumnWidths: (widths: { key: unknown; newWidth: number }[]) => {
    grid.widthsSet.push(widths);
  },
  refreshCells: (params: { columns?: unknown[]; force?: boolean }) => {
    grid.refreshed.push(params);
  },
};

vi.mock('ag-grid-react', () => ({
  AgGridReact: (props: GridDoubleProps) => {
    const ready = useRef(false);
    grid.renders += 1;
    grid.props = props;
    grid.events = {
      onSelectionChanged: props.onSelectionChanged,
      onRowDataUpdated: props.onRowDataUpdated,
      onSortChanged: props.onSortChanged,
      onFilterChanged: props.onFilterChanged,
    };
    // `onGridReady` fires ONCE per mount, after the DOM exists — the same contract the real grid has,
    // and the component's auto-size runs from it. The ref is what keeps it to once even though the
    // effect declares its dependency honestly.
    const { onGridReady } = props;
    useEffect(() => {
      if (ready.current) return;
      ready.current = true;
      onGridReady?.({ api: gridApi });
    }, [onGridReady]);
    return <div data-testid="ag-grid-double" />;
  },
}));

const { ResultsGrid } = await import('./results-grid');

// ── The harness ────────────────────────────────────────────────────────────────────────────

const TAB_ID = 'tab-1';

const resultSet = (overrides: Partial<ResultSet> = {}): ResultSet => ({
  columns: [
    { name: 'id', type: 'int' },
    { name: 'email', type: 'text' },
  ],
  rows: [
    { id: 1, email: 'a@example.com' },
    { id: 2, email: null },
  ],
  ...overrides,
});

const teardowns: (() => void)[] = [];
const notifications: string[] = [];
const clipboard = { text: '', fail: false };

function setGridSettings(grid: Partial<AppSettings['grid']>): void {
  settingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, ...grid } },
  });
}

/** Rows the row-detail rail was opened on, in order. Task 14's seam through this component. */
const opened: { rowIndex: number; row: Record<string, unknown>; totalRows: number }[] = [];

function mount(set: ResultSet = resultSet()): { unmount: () => void } {
  return render(
    <TooltipProvider>
      <ResultsGrid
        resultSet={set}
        tabId={TAB_ID}
        resultIndex={0}
        onRowOpen={target =>
          opened.push({ rowIndex: target.rowIndex, row: target.row, totalRows: target.totalRows })
        }
      />
    </TooltipProvider>
  );
}

beforeEach(() => {
  opened.length = 0;
  grid.props = null;
  grid.renders = 0;
  grid.selected = [];
  grid.displayed = [];
  grid.columns = [
    { id: ROW_NUMBER_COL_ID, header: '#', width: 60 },
    { id: SELECTION_COL_ID, width: 40 },
    { id: 'id', header: 'id', width: 120 },
    { id: 'email', header: 'email', width: 200 },
  ];
  grid.autoSized = 0;
  grid.widthsSet = [];
  grid.refreshed = [];
  notifications.length = 0;
  clipboard.text = '';
  clipboard.fail = false;

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (clipboard.fail) return Promise.reject(new Error('not focused'));
        clipboard.text = text;
        return Promise.resolve();
      },
    },
  });

  setGridSettings({});
  tabStore.setState({ tabs: [], activeTabId: TAB_ID });
  teardowns.push(
    setDiagnosticsSink({ error: () => undefined, warn: () => undefined }),
    setNotifier({
      success: message => notifications.push(`success:${message}`),
      error: message => notifications.push(`error:${message}`),
      info: message => notifications.push(`info:${message}`),
      warning: message => notifications.push(`warning:${message}`),
    })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  settingsStore.setState({ settings: DEFAULT_SETTINGS });
  tabStore.setState({ tabs: [], activeTabId: '' });
});

/** Lets a handler's promise chain (clipboard, IPC) settle inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── What reaches the grid ──────────────────────────────────────────────────────────────────

describe('the grid options', () => {
  it('passes the row array BY REFERENCE — R2 rule 2', () => {
    const set = resultSet();
    const { unmount } = mount(set);
    teardowns.push(unmount);
    // Not `toEqual`: a mapped copy would pass that and re-create every row object per render.
    expect(grid.props?.rowData).toBe(set.rows);
  });

  it('opts into the legacy CSS themes, which is what the token map styles', () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    expect(grid.props?.theme).toBe('legacy');
  });

  it('takes row height and row animation from the persisted grid settings', () => {
    setGridSettings({ rowHeight: 32, animateRows: true });
    const { unmount } = mount();
    teardowns.push(unmount);
    expect(grid.props?.rowHeight).toBe(32);
    expect(grid.props?.animateRows).toBe(true);
  });

  it('builds one column per result column, plus the ordinal gutter', () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    expect(grid.props?.columnDefs?.map(definition => definition.colId ?? definition.field)).toEqual(
      [ROW_NUMBER_COL_ID, 'id', 'email']
    );
  });

  it('renumbers the ordinal gutter after a sort and after a filter', () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.refreshed = [];

    // `node.rowIndex` is the displayed index, but AG Grid does not re-run a value getter for a row it
    // merely re-positions — so without this the gutter reads `5 4 3 2 1` after a descending sort, which
    // is what the Angular grid did.
    act(() => grid.events?.onSortChanged?.());
    act(() => grid.events?.onFilterChanged?.());

    expect(grid.refreshed).toEqual([
      { columns: [ROW_NUMBER_COL_ID], force: true },
      { columns: [ROW_NUMBER_COL_ID], force: true },
    ]);
  });

  it('does not ask to renumber a gutter that is turned off', () => {
    setGridSettings({ showRowNumbers: false });
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.refreshed = [];

    // The column does not exist, so naming it would be asking the grid to refresh nothing.
    act(() => grid.events?.onSortChanged?.());
    expect(grid.refreshed).toEqual([]);
  });

  it('auto-sizes on grid ready and on every new result, capping runaway columns', () => {
    grid.columns = [{ id: 'blob', header: 'blob', width: 4000 }];
    const { unmount } = mount();
    teardowns.push(unmount);

    expect(grid.autoSized).toBe(1);
    expect(grid.widthsSet[0]).toEqual([{ key: expect.anything(), newWidth: 1100 }]);

    // A second query lands in the same grid: AG Grid reports `rowDataUpdated`, and the columns are
    // re-fitted to the new content rather than keeping the previous result's widths.
    act(() => grid.events?.onRowDataUpdated?.());
    expect(grid.autoSized).toBe(2);
  });
});

// ── The theme class, which Angular hardcoded to dark ───────────────────────────────────────

describe('the theme class', () => {
  it('binds the vendor class to the effective theme', () => {
    settingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } });
    const dark = mount();
    expect(screen.getByTestId('results-grid').className).toContain('ag-theme-quartz-dark');
    expect(screen.getByTestId('results-grid').className).toContain('ag-theme-joinery');
    dark.unmount();

    settingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } });
    const light = mount();
    teardowns.push(light.unmount);
    const className = screen.getByTestId('results-grid').className;
    // The bug this replaces: `ag-theme-quartz-dark` was hardcoded, so an ivory user got a dark grid.
    expect(className).toContain('ag-theme-quartz');
    expect(className).not.toContain('ag-theme-quartz-dark');
  });

  it('adds the striping class only when the setting asks for it', () => {
    setGridSettings({ alternatingRowColors: false });
    const plain = mount();
    expect(screen.getByTestId('results-grid').className).not.toContain('ag-theme-joinery-striped');
    plain.unmount();

    setGridSettings({ alternatingRowColors: true });
    const striped = mount();
    teardowns.push(striped.unmount);
    expect(screen.getByTestId('results-grid').className).toContain('ag-theme-joinery-striped');
  });
});

// ── The counts, and the row cap ────────────────────────────────────────────────────────────

describe('the counts', () => {
  it('reports rows and columns', () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    expect(screen.getByTestId('results-row-count').textContent).toBe('2');
    expect(screen.getByTestId('results-column-count').textContent).toBe('2 cols');
    expect(screen.queryByTestId('results-truncated')).toBeNull();
  });

  it('says "showing first N of M" when the executor capped the set', () => {
    // `main/src/services/sql/row-cap.ts` slices `rows` and records the true count in `rowCount`, so
    // this is the ONLY place a user learns their maxRowsToDisplay setting bit.
    const { unmount } = mount(
      resultSet({
        rows: Array.from({ length: 10 }, (_, index) => ({ id: index, email: null })),
        rowCount: 40_000,
        truncated: true,
      })
    );
    teardowns.push(unmount);

    const banner = screen.getByTestId('results-truncated');
    expect(banner.textContent).toContain('showing first');
    expect(screen.getByTestId('results-displayed-count').textContent).toBe('10');
    expect(screen.getByTestId('results-row-count').textContent).toBe('40,000');
  });

  it('names the cap by the label the settings control actually shows (J-107)', async () => {
    // The tooltip used to say "maximum rows to display" — the field name — while the control read
    // "Maximum rows to fetch", so it named a setting the user could not find. Both now read the
    // same constant, and this asserts the rendered text against that constant rather than against
    // a transcription of it, which is the failure mode being guarded.
    const { unmount } = mount(
      resultSet({
        rows: Array.from({ length: 10 }, (_, index) => ({ id: index, email: null })),
        rowCount: 40_000,
        truncated: true,
      })
    );
    teardowns.push(unmount);

    // Hovering is how the tooltip renders at all — its content is a prop until then.
    await userEvent.hover(screen.getByTestId('results-truncated'));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain(MAX_ROWS_SETTING_LABEL);
    expect(tip.textContent).not.toContain('maximum rows to display');
  });

  it('reports a selection when the grid has one', async () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    expect(screen.queryByTestId('results-selected-count')).toBeNull();

    grid.selected = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await act(async () => grid.events?.onSelectionChanged?.());

    expect(screen.getByTestId('results-selected-count').textContent).toContain('3');
  });

  it('says a query that matched nothing succeeded, rather than showing an empty grid', () => {
    const { unmount } = mount(resultSet({ rows: [] }));
    teardowns.push(unmount);
    expect(screen.getByTestId('results-empty').textContent).toContain('0 rows returned');
  });
});

// ── The quick filter ───────────────────────────────────────────────────────────────────────

describe('the quick filter', () => {
  it('reaches the grid, announces itself, and clears', async () => {
    const { unmount } = mount();
    teardowns.push(unmount);

    await userEvent.type(screen.getByTestId('results-filter'), 'example');
    expect(grid.props?.quickFilterText).toBe('example');
    expect(screen.getByTestId('results-filtered')).toBeTruthy();

    await userEvent.click(screen.getByTestId('results-filter-clear'));
    expect(grid.props?.quickFilterText).toBe('');
    expect(screen.queryByTestId('results-filtered')).toBeNull();
  });
});

// ── Copy ───────────────────────────────────────────────────────────────────────────────────

describe('copy', () => {
  it('copies the selection in the user’s format, excluding the two structural columns', async () => {
    setGridSettings({ copyFormat: 'csv', copyIncludeHeaders: true });
    const { unmount } = mount();
    teardowns.push(unmount);

    grid.selected = [{ id: 1, email: 'a@example.com' }];
    await userEvent.click(screen.getByTestId('results-copy'));
    await settle();

    // No `#` and no checkbox column: the ordinal is generated and the checkbox is not data.
    expect(clipboard.text).toBe('id,email\n1,a@example.com');
    expect(notifications).toContain('info:Copied 1 row to clipboard (CSV)');
  });

  it('copies ALL displayed rows when nothing is selected — never silently nothing', async () => {
    setGridSettings({ copyFormat: 'tsv', copyIncludeHeaders: false });
    const { unmount } = mount();
    teardowns.push(unmount);

    // Displayed, i.e. post-sort and post-filter: the order here is the order copied.
    grid.displayed = [
      { id: 2, email: null },
      { id: 1, email: 'a@example.com' },
    ];
    await userEvent.click(screen.getByTestId('results-copy'));
    await settle();

    expect(clipboard.text).toBe('2\tNULL\n1\ta@example.com');
    expect(notifications).toContain('info:Copied all 2 rows to clipboard (TSV)');
  });

  it('says so instead of copying an empty string when there is nothing at all', async () => {
    const { unmount } = mount(resultSet({ rows: [] }));
    teardowns.push(unmount);

    await userEvent.click(screen.getByTestId('results-copy'));
    await settle();

    expect(clipboard.text).toBe('');
    expect(notifications).toContain('info:No rows to copy');
  });

  it('lets the menu items override the setting for one call', async () => {
    setGridSettings({ copyFormat: 'tsv', copyIncludeHeaders: false });
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'a@example.com' }];

    await userEvent.click(screen.getByTestId('results-export'));
    await userEvent.click(screen.getByTestId('results-copy-json'));
    await settle();

    expect(JSON.parse(clipboard.text)).toEqual([{ id: 1, email: 'a@example.com' }]);
  });

  it('reports a refused clipboard write instead of claiming success', async () => {
    clipboard.fail = true;
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'x' }];

    await userEvent.click(screen.getByTestId('results-copy'));
    await settle();

    expect(notifications).toContain('error:Could not copy to the clipboard');
  });
});

// ── Edit ▸ Copy, the claimable command ─────────────────────────────────────────────────────

describe('the menu-copy claim', () => {
  /** `dispatchCommand` returns whether a handler claimed it — the menu bridge's fallback reads it. */
  const menuCopy = (): boolean => dispatchCommand('menu-copy');

  it('is declined when focus is outside the grid, so the platform default still runs', () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'x' }];

    // Nothing in the grid is focused: `document.body` is the active element.
    expect(menuCopy()).toBe(false);
    expect(clipboard.text).toBe('');
  });

  it('is claimed when focus is inside the grid', async () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'x' }];

    // A cell is not focusable in the double, so the grid host itself takes focus — which is what the
    // real grid's focused cell is a descendant of, and the containment test is the same either way.
    const host = screen.getByTestId('results-grid');
    host.tabIndex = -1;
    host.focus();

    expect(menuCopy()).toBe(true);
    await settle();
    expect(clipboard.text).toContain('x');
  });

  it('is declined from an editable field inside the grid — the quick filter is a text box', async () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'x' }];

    // The filter input lives inside the results pane; ⌘C in it must copy the text the user typed.
    screen.getByTestId('results-filter').focus();
    expect(menuCopy()).toBe(false);
    await settle();
    expect(clipboard.text).toBe('');
  });

  it('is declined from a floating-filter input, which lives inside the grid host', async () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'x' }];

    // The quick filter sits in the toolbar, ABOVE the host div — so it is only the containment test
    // that declines it there. A floating filter is AG Grid's own input and it is genuinely inside the
    // host, which makes `focusIsEditable()` the only thing standing between ⌘C-in-a-filter-box and a
    // clipboard full of rows. The double renders no filter row, so one is planted where the real one
    // lives.
    const planted = document.createElement('input');
    planted.className = 'ag-floating-filter-input';
    screen.getByTestId('results-grid').appendChild(planted);
    planted.focus();

    expect(document.activeElement).toBe(planted);
    expect(menuCopy()).toBe(false);
    await settle();
    expect(clipboard.text).toBe('');
    planted.remove();
  });

  it('is declined when the user has a real text selection', async () => {
    const { unmount } = mount();
    teardowns.push(unmount);
    grid.displayed = [{ id: 1, email: 'x' }];

    const host = screen.getByTestId('results-grid');
    host.tabIndex = -1;
    host.focus();

    // A drag across cell text: they asked for that string, not for the row. The selection is stubbed
    // rather than made with a real Range because jsdom's `Selection.toString()` returns '' for one —
    // it has no layout and no text-serialisation, so a real range cannot express this case at all.
    const realGetSelection = document.getSelection.bind(document);
    Object.defineProperty(document, 'getSelection', {
      configurable: true,
      value: () => ({ toString: () => 'a@example.com' }),
    });

    expect(menuCopy()).toBe(false);
    await settle();
    expect(clipboard.text).toBe('');

    Object.defineProperty(document, 'getSelection', {
      configurable: true,
      value: realGetSelection,
    });
  });
});

// ── Export ─────────────────────────────────────────────────────────────────────────────────

describe('export', () => {
  const exported: { options: ExportOptions; rows: number }[] = [];

  function installExport(result: ExportResult): void {
    exported.length = 0;
    teardowns.push(
      installJoineryMock({
        query: {
          exportResults: async (set: ResultSet, options: ExportOptions) => {
            exported.push({ options, rows: set.rows.length });
            return result;
          },
        },
      })
    );
  }

  it('sends the result set to the main process, which owns the dialog and the encoder', async () => {
    installExport({ success: true, rowsExported: 2, filePath: '/tmp/out.csv' });
    const { unmount } = mount();
    teardowns.push(unmount);

    await userEvent.click(screen.getByTestId('results-export'));
    await userEvent.click(screen.getByTestId('results-export-csv'));
    await settle();

    expect(exported).toEqual([
      {
        options: {
          format: 'csv',
          includeHeaders: true,
          prettyPrint: true,
          tableName: 'QueryResults',
        },
        rows: 2,
      },
    ]);
    expect(notifications).toContain('success:Exported 2 rows to /tmp/out.csv');
  });

  it('offers all three formats', async () => {
    installExport({ success: true, rowsExported: 2 });
    const { unmount } = mount();
    teardowns.push(unmount);

    for (const [testId, format] of [
      ['results-export-json', 'json'],
      ['results-export-sql', 'sql'],
    ] as const) {
      await userEvent.click(screen.getByTestId('results-export'));
      await userEvent.click(screen.getByTestId(testId));
      await settle();
      expect(exported.at(-1)?.options.format).toBe(format);
    }
  });

  it('is silent when the save dialog was dismissed, and loud when it failed', async () => {
    installExport({ success: false, error: 'Export cancelled' });
    const cancelled = mount();
    await userEvent.click(screen.getByTestId('results-export'));
    await userEvent.click(screen.getByTestId('results-export-csv'));
    await settle();
    expect(notifications).toEqual([]);
    cancelled.unmount();

    removeJoineryMock();
    installExport({ success: false, error: 'EACCES' });
    const failed = mount();
    teardowns.push(failed.unmount);
    await userEvent.click(screen.getByTestId('results-export'));
    await userEvent.click(screen.getByTestId('results-export-csv'));
    await settle();
    expect(notifications).toContain('error:Export failed: EACCES');
  });

  it('refuses to export nothing', async () => {
    installExport({ success: true, rowsExported: 0 });
    const { unmount } = mount(resultSet({ rows: [] }));
    teardowns.push(unmount);

    await userEvent.click(screen.getByTestId('results-export'));
    await userEvent.click(screen.getByTestId('results-export-csv'));
    await settle();

    expect(exported).toEqual([]);
    expect(notifications).toContain('warning:No results to export');
  });

  it('answers File ▸ Export Results, but only for the ACTIVE tab’s grid', async () => {
    installExport({ success: true, rowsExported: 2, filePath: '/tmp/out.csv' });
    const { unmount } = mount();
    teardowns.push(unmount);

    // Dockview keeps inactive panels mounted, so an unguarded handler would fire once per open tab.
    tabStore.setState({ activeTabId: 'some-other-tab' });
    await act(async () => void dispatchCommand('export-results'));
    await settle();
    expect(exported).toEqual([]);

    tabStore.setState({ activeTabId: TAB_ID });
    await act(async () => void dispatchCommand('export-results'));
    await settle();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.options.format).toBe('csv');
  });
});
