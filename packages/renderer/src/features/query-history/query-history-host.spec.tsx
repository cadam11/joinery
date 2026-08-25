/**
 * The history surface, from the command to the tab it opens.
 *
 * The two paths the brief names — **load** and **execute** — differ by exactly one flag on the new tab,
 * so they are asserted as a pair through both of their affordances (the row's own button / the run
 * button, and Enter / ⇧Enter): a shared handler that lost its flag would still pass a single-path test.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ConnectionProfile,
  DatabaseInfo,
  QueryHistoryEntry,
  QueryHistoryFilter,
} from '@joinery/shared';

import { dispatchCommand } from '../../commands';
import { IpcQueryProvider } from '../../ipc';
import { TooltipProvider } from '../../ui';
import { connectionStore } from '../../state/connection';
import { SEARCH_DEBOUNCE_MS } from './query-history-dialog';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { queryHistoryStore } from '../../state/query-history';
import { tabStore } from '../../state/tab';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { QueryHistoryHost } from './query-history-host';

const SERVER_A = 'conn-a';
const SERVER_B = 'conn-b';

function profile(id: string, name: string): ConnectionProfile {
  return {
    id,
    name,
    engine: 'postgresql',
    server: '127.0.0.1',
    port: 15432,
    authenticationType: 'sql',
    username: 'joinery',
    database: 'joinery_test',
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15,
  } as ConnectionProfile;
}

function entry(overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
  return {
    id: 'h1',
    connectionId: SERVER_A,
    connectionName: 'Server A',
    database: 'sales',
    sql: 'select * from orders',
    executedAt: new Date().toISOString(),
    executionTimeMs: 12,
    rowCount: 3,
    success: true,
    ...overrides,
  };
}

const ENTRIES: QueryHistoryEntry[] = [
  entry(),
  entry({ id: 'h2', sql: 'select count(*) from customers', database: 'sales', executionTimeMs: 4 }),
  entry({
    id: 'h3',
    sql: 'select * from nope',
    success: false,
    error: 'relation "nope" does not exist',
    rowCount: undefined,
  }),
];

const teardowns: (() => void)[] = [];
let toasts: string[] = [];
/** Every filter the main process was asked for, in order. */
let filters: (QueryHistoryFilter | undefined)[] = [];

function installBridge(entries: QueryHistoryEntry[] = ENTRIES): void {
  filters = [];
  teardowns.push(
    installJoineryMock({
      query: {
        getHistory: (filter?: QueryHistoryFilter) => {
          filters.push(filter);
          const search = filter?.searchText?.toLowerCase();
          // The same three-field match the main process performs
          // (`services/config/query-history.ts:87-95`), so the spec is not a kinder oracle than the app.
          const matching =
            search === undefined
              ? entries
              : entries.filter(
                  candidate =>
                    candidate.sql.toLowerCase().includes(search) ||
                    candidate.database.toLowerCase().includes(search) ||
                    candidate.connectionName.toLowerCase().includes(search)
                );
          return Promise.resolve(matching);
        },
        clearHistory: () => Promise.resolve(),
        deleteHistoryEntry: (_id: string) => Promise.resolve(true),
      },
    })
  );
}

/** Server A connected, with `sales` in its database list. */
function seedConnections(connected: readonly string[] = [SERVER_A]): void {
  connectionStore.setState({
    profiles: [profile(SERVER_A, 'Server A'), profile(SERVER_B, 'Server B')],
    connectedProfileIds: new Set(connected),
    databasesByConnection: new Map(
      connected.map(id => [id, [{ name: 'sales', state: 'online' }] as unknown as DatabaseInfo[]])
    ),
  });
}

/** Mounts the host once. Everything below reaches the dialog through the command, the only way in. */
function mountHost(): void {
  render(
    <IpcQueryProvider>
      <TooltipProvider>
        <QueryHistoryHost />
      </TooltipProvider>
    </IpcQueryProvider>
  );
}

/** Dispatches the command and waits for the seeded rows. Mounts the host on first use. */
async function openHistory(rows = 3): Promise<void> {
  if (screen.queryAllByTestId('query-history-dialog').length === 0 && !hostMounted) {
    mountHost();
    hostMounted = true;
  }
  dispatchCommand('open-query-history');
  await screen.findByTestId('query-history-dialog');
  await waitFor(() => expect(screen.getAllByTestId('query-history-row')).toHaveLength(rows));
}

let hostMounted = false;

/** The tab the last action created. */
function newestTab() {
  return tabStore.getState().tabs.at(-1);
}

beforeEach(() => {
  toasts = [];
  hostMounted = false;
  teardowns.push(
    setDiagnosticsSink({ error: () => undefined, warn: () => undefined }),
    setNotifier({
      success: text => toasts.push(text),
      error: text => toasts.push(text),
      info: text => toasts.push(text),
      warning: text => toasts.push(text),
    })
  );
  tabStore.setState({ tabs: [], activeTabId: '' });
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  queryHistoryStore.setState({ entries: [], loading: false, filter: { limit: 100 } });
  connectionStore.setState({ profiles: [], connectedProfileIds: new Set() });
  tabStore.setState({ tabs: [], activeTabId: '' });
});

describe('the query-history dialog', () => {
  it('loads the history when the command arrives, not when the dialog mounts', async () => {
    installBridge();
    seedConnections();
    await openHistory();

    // One fetch, from the command handler: the dialog opens with rows rather than with a spinner.
    expect(filters).toHaveLength(1);
    expect(screen.getByTestId('query-history-count').textContent).toBe('3 queries');
  });

  it('stays at one fetch after the search debounce window has passed (J-121)', async () => {
    // The flake this replaces: the dialog's debounced search effect ran on MOUNT with an empty
    // box and fetched the whole history again 200ms later — a second identical round trip on
    // every open. The assertion above counted 1 only because it usually finished first; under
    // full-suite load it did not, about one run in three.
    //
    // Waiting past the window is what makes this deterministic: before the fix it fails every
    // time rather than sometimes, and it is the SECOND fetch that is the product bug.
    installBridge();
    seedConnections();
    await openHistory();

    await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS * 3));

    expect(filters).toHaveLength(1);
  });

  it('still searches when the box is cleared back to empty', async () => {
    // The reason the guard is a ref and not `search === ''`: clearing the box is a real search,
    // and it must still reach the main process.
    const user = userEvent.setup();
    installBridge();
    seedConnections();
    await openHistory();

    const box = screen.getByTestId('query-history-search');
    await user.type(box, 'orders');
    await waitFor(() => expect(filters.length).toBeGreaterThan(1));

    const afterTyping = filters.length;
    await user.clear(box);

    await waitFor(() => expect(filters.length).toBeGreaterThan(afterTyping));
    expect(filters.at(-1)?.searchText ?? '').toBe('');
  });

  it('renders the failed entry as failed, with its error', async () => {
    installBridge();
    seedConnections();
    await openHistory();

    const rows = screen.getAllByTestId('query-history-row');
    expect(rows[0]?.getAttribute('data-failed')).toBeNull();
    expect(rows[2]?.getAttribute('data-failed')).toBe('true');
    expect(rows[2]?.textContent).toContain('relation "nope" does not exist');
  });

  it('searches through the main process rather than filtering the loaded page', async () => {
    // The Angular dialog did both, and the local half could only ever see the 100 entries the last
    // load returned while main searches the whole store.
    installBridge();
    seedConnections();
    await openHistory();

    await userEvent.type(screen.getByTestId('query-history-search'), 'customers');
    await waitFor(() => expect(screen.getAllByTestId('query-history-row')).toHaveLength(1));

    expect(filters.at(-1)?.searchText).toBe('customers');
    expect(screen.getByTestId('query-history-sql').textContent).toBe(
      'select count(*) from customers'
    );
  });

  it('says nothing matches, without claiming the history is empty', async () => {
    installBridge();
    seedConnections();
    await openHistory();

    await userEvent.type(screen.getByTestId('query-history-search'), 'zzzz');
    await waitFor(() => expect(screen.queryAllByTestId('query-history-row')).toHaveLength(0));
    expect(screen.getByText('Nothing matches that')).toBeTruthy();
  });

  describe('load vs execute', () => {
    it('load opens a tab with the SQL and does NOT run it', async () => {
      installBridge();
      seedConnections();
      await openHistory();

      await userEvent.click(screen.getAllByTestId('query-history-load')[0] as HTMLElement);

      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(1));
      const tab = newestTab();
      expect(tab?.type).toBe('query');
      expect(tab?.connectionId).toBe(SERVER_A);
      expect(tab?.databaseName).toBe('sales');
      expect(tabStore.getState().getTabContent(tab?.id ?? '')).toBe('select * from orders');
      expect(tab?.autoExecute).toBe(false);
      // And it closed itself: the dialog's job is done once the tab exists.
      expect(screen.queryByTestId('query-history-dialog')).toBeNull();
    });

    it('execute opens the same tab with the auto-execute flag set', async () => {
      installBridge();
      seedConnections();
      await openHistory();

      await userEvent.click(screen.getAllByTestId('query-history-execute')[0] as HTMLElement);

      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(1));
      expect(newestTab()?.autoExecute).toBe(true);
      expect(tabStore.getState().getTabContent(newestTab()?.id ?? '')).toBe('select * from orders');
    });

    it('Enter loads and ⇧Enter executes the selected row', async () => {
      installBridge();
      seedConnections();
      await openHistory();

      // ↓ moves off the first row, so this also proves the arrow keys move the selection.
      await userEvent.keyboard('{ArrowDown}{Enter}');
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(1));
      expect(tabStore.getState().getTabContent(newestTab()?.id ?? '')).toBe(
        'select count(*) from customers'
      );
      expect(newestTab()?.autoExecute).toBe(false);

      await openHistory();
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(2));
      expect(newestTab()?.autoExecute).toBe(true);
    });

    it('opens a fresh tab rather than re-pointing an empty one', async () => {
      // `reuseEmpty: false`: the user named a statement, so it gets a tab of its own.
      installBridge();
      seedConnections();
      const existing = tabStore.getState().openQueryTab(SERVER_A, 'sales');
      await openHistory();

      await userEvent.click(screen.getAllByTestId('query-history-load')[0] as HTMLElement);
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(2));
      expect(tabStore.getState().getTabContent(existing)).toBe('');
    });
  });

  describe('the target', () => {
    it('re-points to the live server and says so when the entry’s is gone', async () => {
      installBridge();
      seedConnections([SERVER_B]);
      await openHistory();

      await userEvent.click(screen.getAllByTestId('query-history-load')[0] as HTMLElement);
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(1));

      expect(newestTab()?.connectionId).toBe(SERVER_B);
      expect(toasts.join('\n')).toContain('Server A is not connected');
    });

    it('LOADS rather than runs on a re-pointed target, whichever affordance was used', async () => {
      // The defect this file's own header cites, one step further on: re-pointing the tab and then
      // honouring ⇧Enter runs `DELETE FROM orders WHERE id < 500` — recorded against a server that is
      // now disconnected — against whatever server happens to be open. Both execute affordances load.
      installBridge();
      seedConnections([SERVER_B]);

      await openHistory();
      await userEvent.click(screen.getAllByTestId('query-history-execute')[0] as HTMLElement);
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(1));

      expect(newestTab()?.connectionId).toBe(SERVER_B);
      expect(newestTab()?.autoExecute).toBe(false);
      // The SQL is there, on the right server, one keystroke from running — and the toast said so.
      expect(tabStore.getState().getTabContent(newestTab()?.id ?? '')).toBe('select * from orders');
      expect(toasts.join('\n')).toContain('Server A is not connected');

      await openHistory();
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(2));
      expect(newestTab()?.autoExecute).toBe(false);
    });

    it('still runs on the entry’s OWN server, so the refusal is about the redirect', async () => {
      // The control for the case above: same click, connected entry, and it executes. Without this a
      // blanket `autoExecute = false` would pass the test above and break the feature.
      installBridge();
      seedConnections([SERVER_A]);
      await openHistory();

      await userEvent.click(screen.getAllByTestId('query-history-execute')[0] as HTMLElement);
      await waitFor(() => expect(tabStore.getState().tabs).toHaveLength(1));
      expect(newestTab()?.connectionId).toBe(SERVER_A);
      expect(newestTab()?.autoExecute).toBe(true);
    });

    it('refuses, with a reason, when nothing is connected', async () => {
      installBridge();
      seedConnections([]);
      await openHistory();

      await userEvent.click(screen.getAllByTestId('query-history-load')[0] as HTMLElement);

      expect(tabStore.getState().tabs).toHaveLength(0);
      expect(toasts.join('\n')).toContain('Connect to a server');
    });
  });

  it('clears the whole history', async () => {
    installBridge();
    seedConnections();
    await openHistory();

    await userEvent.click(screen.getByTestId('query-history-clear'));
    await waitFor(() => expect(screen.queryAllByTestId('query-history-row')).toHaveLength(0));
    expect(screen.getByText('No queries yet')).toBeTruthy();
  });
});
