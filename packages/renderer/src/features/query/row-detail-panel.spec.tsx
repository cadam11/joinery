/**
 * The row inspector, mounted for real.
 *
 * What is worth asserting here rather than in `row-detail.spec.ts` / `fk-lookup.spec.ts`:
 *
 *  - **the PostgreSQL FK path end to end in the renderer.** A PG result set carries no `foreignKey`
 *    on its columns (only the MSSQL executor enriches — `query-executor.ts:94-125`), so the rail has
 *    to fetch the catalogue itself and merge. That the badge and the link appear at all on PG is the
 *    single most valuable thing this file pins;
 *  - **what goes out for a preview** — since J-145 a `query.fetchFkRecord` call naming the
 *    reference, never a statement — and **the SQL that goes out for an open-in-tab**, per engine,
 *    from a click;
 *  - **navigation walks the GRID's displayed order**, which is the regression
 *    `tests/e2e/row-detail.spec.ts` exists for, expressed here as a source whose order differs from
 *    the result's;
 *  - **Escape closes the rail and nothing else.**
 */

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ColumnMetadata,
  ConnectionProfile,
  FkRecordResult,
  QueryResult,
} from '@joinery/shared';

import { IpcQueryProvider } from '../../ipc';
import { connectionStore } from '../../state/connection';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { queryExecutionStore } from '../../state/query-execution';
import { tabStore } from '../../state/tab';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { TooltipProvider } from '../../ui';
import { RowDetailPanel, type DisplayedRows, type RowDetailTarget } from './row-detail-panel';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

/** What a PostgreSQL result set actually carries: names and driver types, no keys, no references. */
const PG_COLUMNS: ColumnMetadata[] = [
  { name: 'id', type: 'int4' },
  { name: 'customer_id', type: 'int4' },
  { name: 'note', type: 'text' },
];

/** What the catalogue knows, which is where the FK comes from on PG. */
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
    defaultValue: "nextval('orders_id_seq'::regclass)",
    foreignKey: null,
  },
  {
    name: 'customer_id',
    type: 'integer',
    nullable: false,
    maxLength: null,
    precision: 32,
    scale: 0,
    isPrimaryKey: false,
    isIdentity: false,
    defaultValue: null,
    foreignKey: {
      referencedSchema: 'public',
      referencedTable: 'customers',
      referencedColumn: 'id',
      constraintName: 'orders_customer_id_fkey',
    },
  },
  {
    name: 'note',
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

const ROWS: Record<string, unknown>[] = [
  { id: 10, customer_id: 3, note: 'first' },
  { id: 11, customer_id: null, note: null },
];

/**
 * A displayed order that is NOT the result's order: index 0 is the SECOND row. Navigating from it
 * must reach `ROWS[0]`, which is what proves the rail asks the source rather than indexing the rows.
 */
const DISPLAYED: Record<string, unknown>[] = [
  ROWS[1] as Record<string, unknown>,
  ROWS[0] as Record<string, unknown>,
];

const SOURCE: DisplayedRows = {
  count: () => DISPLAYED.length,
  at: index => DISPLAYED[index] ?? null,
};

/**
 * What `query.fetchFkRecord` resolves to (`shared/types/query.types.ts:157-165`). Since J-145 the
 * preview asks the main process for the referenced ROW rather than running a result set of its
 * own: the statement, its bound value and its columns are all built there.
 */
const FK_RESULT: FkRecordResult = {
  success: true,
  record: { id: 3, email: 'c3@example.test', deleted_at: null },
  columns: [
    { name: 'id', type: 'int4', isPrimaryKey: true },
    { name: 'email', type: 'text' },
    { name: 'deleted_at', type: 'timestamptz' },
  ],
};

const teardowns: (() => void)[] = [];
const notifications: string[] = [];
let getEnrichedColumns: ReturnType<typeof vi.fn>;
let fetchFkRecord: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;

function installBridge(): void {
  getEnrichedColumns = vi.fn(() => Promise.resolve(ENRICHED));
  fetchFkRecord = vi.fn(() => Promise.resolve(FK_RESULT));
  // Still declared, and deliberately: the assertion that the FK preview does NOT run SQL through
  // the editor channel is only worth anything if that channel is reachable from this mock.
  execute = vi.fn(() => Promise.resolve({ queryId: 'q', success: true } satisfies QueryResult));
  teardowns.push(
    installJoineryMock({
      explorer: { getEnrichedColumns },
      query: { execute, fetchFkRecord },
    })
  );
}

/** A query tab pointed at the seeded PG database, with a result whose SQL is recorded. */
function openTab(sql = 'SELECT id, customer_id, note FROM orders ORDER BY id'): string {
  connectionStore.setState({
    profiles: [
      { id: 'conn-1', name: 'Test PG', engine: 'postgresql' } as ConnectionProfile,
      { id: 'conn-2', name: 'Prod MSSQL', engine: 'mssql' } as ConnectionProfile,
    ],
  } as never);
  const tabId = tabStore.getState().openQueryTab('conn-1', 'joinery_test', sql, false);
  queryExecutionStore
    .getState()
    .setResult(tabId, { queryId: 'q1', success: true, resultSets: [] }, sql);
  return tabId;
}

function target(overrides: Partial<RowDetailTarget> = {}): RowDetailTarget {
  return {
    rowIndex: 1,
    row: ROWS[0] as Record<string, unknown>,
    columns: PG_COLUMNS,
    totalRows: DISPLAYED.length,
    resultIndex: 0,
    source: SOURCE,
    ...overrides,
  };
}

function mountRail(tabId: string, initial: RowDetailTarget = target()) {
  const onClose = vi.fn();
  const rendered = render(
    <IpcQueryProvider>
      <TooltipProvider>
        <RailHarness tabId={tabId} initial={initial} onClose={onClose} />
      </TooltipProvider>
    </IpcQueryProvider>
  );
  return { ...rendered, onClose };
}

/**
 * The rail plus the navigation `query-results.tsx` owns, so Next/Previous are exercised through the
 * same transition the app uses rather than through a spy that only records the direction.
 */
function RailHarness({
  tabId,
  initial,
  onClose,
}: {
  readonly tabId: string;
  readonly initial: RowDetailTarget;
  readonly onClose: () => void;
}) {
  const [current, setCurrent] = useState(initial);
  return (
    <RowDetailPanel
      tabId={tabId}
      target={current}
      onClose={onClose}
      onNavigate={direction =>
        setCurrent(previous => {
          const index = direction === 'next' ? previous.rowIndex + 1 : previous.rowIndex - 1;
          const row = previous.source.at(index);
          if (row === null) return previous;
          return { ...previous, rowIndex: index, row, totalRows: previous.source.count() };
        })
      }
    />
  );
}

/** A button's disabled state, read off the DOM — this project has no jest-dom matchers. */
function disabled(testId: string): boolean {
  return (screen.getByTestId(testId) as HTMLButtonElement).disabled;
}

function fieldRow(name: string): HTMLElement {
  const row = screen
    .getAllByTestId('rowdetail-field')
    .find(element => element.getAttribute('data-field') === name);
  if (row === undefined) throw new Error(`no field row for ${name}`);
  return row;
}

beforeEach(() => {
  installBridge();
  notifications.length = 0;
  teardowns.push(
    setDiagnosticsSink({ error: () => undefined, warn: () => undefined }),
    setNotifier({
      success: message => notifications.push(message),
      error: message => notifications.push(message),
      info: message => notifications.push(message),
      warning: message => notifications.push(message),
    })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  for (const tab of tabStore.getState().tabs) queryExecutionStore.getState().forgetTab(tab.id);
  tabStore.setState({ tabs: [], activeTabId: '' });
  connectionStore.setState({ profiles: [] } as never);
  vi.clearAllMocks();
});

describe('the fields', () => {
  it('reads the row vertically, in column order, with its position in the header', async () => {
    mountRail(openTab());

    expect(screen.getByTestId('rowdetail-title').textContent).toContain('Row 2 of 2');
    expect(
      screen.getAllByTestId('rowdetail-field').map(row => row.getAttribute('data-field'))
    ).toEqual(['id', 'customer_id', 'note']);
    expect(within(fieldRow('note')).getByTestId('rowdetail-value').textContent).toBe('first');
  });

  it('paints a NULL as NULL rather than as an empty line', async () => {
    mountRail(openTab(), target({ rowIndex: 0, row: ROWS[1] as Record<string, unknown> }));
    expect(within(fieldRow('note')).getByTestId('rowdetail-null').textContent).toBe('NULL');
  });

  it('copies one field, and the whole row, through the clipboard', async () => {
    const user = userEvent.setup();
    // AFTER `setup()`, which installs a clipboard stub of its own — defining it first means
    // asserting against user-event's copy of the API instead of the component's.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountRail(openTab());

    await user.click(within(fieldRow('note')).getByTestId('rowdetail-copy-value'));
    expect(writeText).toHaveBeenCalledWith('first');

    await user.click(screen.getByTestId('rowdetail-copy-all'));
    expect(writeText).toHaveBeenLastCalledWith('id: 10\ncustomer_id: 3\nnote: first');
  });
});

describe('catalogue enrichment — the PostgreSQL path', () => {
  it('asks for the queried table’s columns, resolved from the SQL that produced the result', async () => {
    mountRail(openTab());

    await waitFor(() =>
      expect(getEnrichedColumns).toHaveBeenCalledWith('conn-1', 'joinery_test', 'public', 'orders')
    );
  });

  it('shows the pk / fk / identity badges the driver’s columns did not carry', async () => {
    mountRail(openTab());

    await waitFor(() => expect(within(fieldRow('id')).getByTitle('Primary key')).toBeTruthy());
    expect(
      within(fieldRow('customer_id')).getByTitle('References public.customers.id')
    ).toBeTruthy();
    expect(within(fieldRow('id')).getByTitle('Identity / auto-increment')).toBeTruthy();
  });

  it('turns an FK cell with a value into a link', async () => {
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );
  });

  it('leaves the same column alone on the row where it is NULL — nothing to follow', async () => {
    mountRail(openTab(), target({ rowIndex: 0, row: ROWS[1] as Record<string, unknown> }));
    // The badge is the signal that the merge has landed — waiting on the mock call only proves the
    // request went out.
    await waitFor(() =>
      // The COLUMN still declares its reference even though this row cannot follow it.
      expect(
        within(fieldRow('customer_id')).getByTitle('References public.customers.id')
      ).toBeTruthy()
    );

    expect(within(fieldRow('customer_id')).queryByTestId('rowdetail-fk-link')).toBeNull();
    expect(within(fieldRow('customer_id')).getByTestId('rowdetail-null').textContent).toBe('NULL');
  });

  it('does not ask at all when the SQL names no single table', async () => {
    mountRail(openTab('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id'));

    await screen.findByTestId('rowdetail-fields');
    expect(getEnrichedColumns).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rowdetail-fk-link')).toBeNull();
  });
});

describe('the FK preview', () => {
  it('asks the main process for the referenced row, naming the reference rather than SQL', async () => {
    // J-145. What this pins is the SEAM, which is the security property: the renderer hands over
    // the schema, table, column and the raw cell value, and never a statement. The statement is
    // built by the dialect layer and its value is bound — pinned in
    // `main/services/sql/fk-record.spec.ts` and `main/services/sql/dialect/dialect.spec.ts`.
    const user = userEvent.setup();
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );

    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link'));

    const preview = await screen.findByTestId('rowdetail-fk-preview');
    expect(within(preview).getByTestId('rowdetail-fk-target').textContent).toBe('public.customers');
    await waitFor(() => expect(within(preview).getByText('c3@example.test')).toBeTruthy());

    expect(fetchFkRecord).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'conn-1',
      database: 'joinery_test',
      schema: 'public',
      table: 'customers',
      column: 'id',
      value: 3,
    });
  });

  it('never runs the preview through the editor channel, which is the one on MySQL’s script pool', async () => {
    // The regression J-145 exists for: the preview used to build its own SQL and send it down
    // `query.execute`, so the app's most data-driven lookup sat on the ONE channel entitled to
    // MySQL's multi-statement pool (J-137), with a result-set cell escaped into its predicate.
    const user = userEvent.setup();
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );
    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link'));

    await waitFor(() => expect(fetchFkRecord).toHaveBeenCalled());
    expect(execute).not.toHaveBeenCalled();
  });

  it('states the engine’s error rather than an empty card', async () => {
    fetchFkRecord.mockResolvedValueOnce({
      success: false,
      error: 'relation "public.customers" does not exist',
    } satisfies FkRecordResult);
    const user = userEvent.setup();
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );

    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link'));
    expect((await screen.findByTestId('rowdetail-fk-error')).textContent).toContain(
      'does not exist'
    );
  });

  it('says so when the reference points at a row that is not there', async () => {
    // A missing row is a SUCCESS with no record, not an error — see `fk-record.ts`. The rail draws
    // a plain line for it and keeps the red card for a statement the engine actually refused.
    fetchFkRecord.mockResolvedValueOnce({ success: true } satisfies FkRecordResult);
    const user = userEvent.setup();
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );

    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link'));
    expect((await screen.findByTestId('rowdetail-fk-empty')).textContent).toContain(
      'No row in customers has id = 3'
    );
  });

  it('closes on a second click of the same link', async () => {
    const user = userEvent.setup();
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );
    const link = within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link');

    await user.click(link);
    await screen.findByTestId('rowdetail-fk-preview');
    await user.click(link);
    expect(screen.queryByTestId('rowdetail-fk-preview')).toBeNull();
  });
});

describe('opening the referenced row in a tab', () => {
  it('opens an auto-executing tab with the engine’s SQL, named after the reference', async () => {
    const user = userEvent.setup();
    const tabId = openTab();
    mountRail(tabId);
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-open')).toBeTruthy()
    );

    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-open'));

    const opened = tabStore.getState().tabs.find(tab => tab.id !== tabId && tab.type === 'query');
    expect(opened?.title).toBe('customers · 3');
    expect(opened?.autoExecute).toBe(true);
    expect(tabStore.getState().getTabContent(opened?.id ?? '')).toBe(
      'SELECT *\nFROM "public"."customers"\nWHERE "id" = 3'
    );
  });

  it('uses T-SQL for an MSSQL tab, from the same click', async () => {
    const user = userEvent.setup();
    connectionStore.setState({
      profiles: [{ id: 'conn-2', name: 'Prod MSSQL', engine: 'mssql' } as ConnectionProfile],
    } as never);
    const sql = 'SELECT id, customer_id, note FROM dbo.Orders';
    const tabId = tabStore.getState().openQueryTab('conn-2', 'shop', sql, false);
    queryExecutionStore
      .getState()
      .setResult(tabId, { queryId: 'q1', success: true, resultSets: [] }, sql);

    mountRail(tabId);
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-open')).toBeTruthy()
    );
    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-open'));

    const opened = tabStore.getState().tabs.find(tab => tab.id !== tabId && tab.type === 'query');
    expect(tabStore.getState().getTabContent(opened?.id ?? '')).toBe(
      'SELECT *\nFROM [public].[customers]\nWHERE [id] = 3'
    );
  });
});

describe('navigation', () => {
  it('walks the grid’s DISPLAYED order, not the result’s row order', async () => {
    const user = userEvent.setup();
    // Opened on displayed index 1, which is `ROWS[0]` (id 10). Previous must reach displayed 0 —
    // `ROWS[1]`, id 11 — and NOT `ROWS[0 - 1]`, which does not exist.
    mountRail(openTab());
    expect(within(fieldRow('id')).getByTestId('rowdetail-value').textContent).toBe('10');

    await user.click(screen.getByTestId('rowdetail-previous'));

    expect(screen.getByTestId('rowdetail-title').textContent).toContain('Row 1 of 2');
    expect(within(fieldRow('id')).getByTestId('rowdetail-value').textContent).toBe('11');
  });

  it('disables Previous on the first displayed row and Next on the last', async () => {
    const user = userEvent.setup();
    mountRail(openTab());

    expect(disabled('rowdetail-next')).toBe(true);
    await user.click(screen.getByTestId('rowdetail-previous'));
    expect(disabled('rowdetail-previous')).toBe(true);
    expect(disabled('rowdetail-next')).toBe(false);
  });

  it('forgets the previous row’s open preview when it moves', async () => {
    const user = userEvent.setup();
    mountRail(openTab());
    await waitFor(() =>
      expect(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link')).toBeTruthy()
    );
    await user.click(within(fieldRow('customer_id')).getByTestId('rowdetail-fk-link'));
    await screen.findByTestId('rowdetail-fk-preview');

    await user.click(screen.getByTestId('rowdetail-previous'));

    expect(screen.queryByTestId('rowdetail-fk-preview')).toBeNull();
  });
});

describe('closing', () => {
  it('closes on the button', async () => {
    const user = userEvent.setup();
    const { onClose } = mountRail(openTab());
    await user.click(screen.getByTestId('rowdetail-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape inside the rail, and does not let it escape to the document', async () => {
    const user = userEvent.setup();
    const documentEscapes: string[] = [];
    const listener = (event: KeyboardEvent): void => {
      documentEscapes.push(event.key);
    };
    document.addEventListener('keydown', listener);
    teardowns.push(() => document.removeEventListener('keydown', listener));

    const { onClose } = mountRail(openTab());
    // The rail takes focus on mount — that is what makes Escape reach it without a click.
    expect(document.activeElement).toBe(screen.getByTestId('rowdetail-panel'));
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
    expect(documentEscapes).toEqual([]);
  });
});

describe('the expanded field', () => {
  it('shows the whole value and the column’s catalogue facts', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(200);
    mountRail(openTab(), target({ row: { id: 10, customer_id: 3, note: long } }));
    await waitFor(() => expect(getEnrichedColumns).toHaveBeenCalled());

    await user.click(within(fieldRow('note')).getByTestId('rowdetail-expand'));

    const expanded = within(fieldRow('note')).getByTestId('rowdetail-expanded');
    expect(expanded.textContent).toContain(long);
    expect(expanded.textContent).toContain('nullable');
  });
});
