/**
 * The execute sequence, end to end but without a UI: refusals, the placeholder prompt's suspension, the
 * substitution, and the tab rename.
 *
 * Driven through a probe component rather than by calling the hook directly, because the prompt is React
 * state and the suspension is a promise resolved by a later render's callback — the interesting part IS the
 * interleaving.
 *
 * The real stores are used, with the bridge mocked: the hook's whole job is to sequence them, so doubling
 * them would leave nothing under test.
 */

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryRequest, QueryResult } from '@joinery/shared';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { aiStore } from '../../state/ai';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { editorPrefsStore } from '../../state/editor-prefs';
import { queryExecutionStore } from '../../state/query-execution';
import { tabStore } from '../../state/tab';
import { useRunQuery, type RunContext, type RunQuery } from './use-run-query';

const okResult: QueryResult = {
  queryId: 'query-1',
  success: true,
  resultSets: [],
  executionTime: 1,
};

const teardowns: (() => void)[] = [];
const notifications: string[] = [];

/** Mounts the hook and hands its API back through a ref. */
function mountHook(): { api: () => RunQuery; unmount: () => void } {
  const box: { current: RunQuery | null } = { current: null };
  function Probe() {
    box.current = useRunQuery();
    return null;
  }
  const { unmount } = render(<Probe />);
  return { api: () => box.current as RunQuery, unmount };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    tabId: 'tab-1',
    tabTitle: 'Query 1',
    connectionId: 'conn-1',
    database: 'shop',
    querySettings: {
      maxRowsToDisplay: 500,
      defaultTimeout: 45_000,
    } as RunContext['querySettings'],
    sql: 'select 1',
    ...overrides,
  };
}

beforeEach(() => {
  notifications.length = 0;
  teardowns.push(
    setDiagnosticsSink({ error: () => undefined, warn: () => undefined }),
    setNotifier({
      success: message => notifications.push(`success:${message}`),
      error: message => notifications.push(`error:${message}`),
      info: message => notifications.push(`info:${message}`),
      warning: message => notifications.push(`warning:${message}`),
    })
  );
  editorPrefsStore
    .getState()
    .hydrate({ confirmedCtrlEExecute: false, flywayPlaceholderValues: {} });
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  tabStore.setState({ tabs: [], activeTabId: '' });
  queryExecutionStore.getState().forgetTab('tab-1');
  aiStore.setState(aiStore.getInitialState());
});

describe('refusals', () => {
  it('refuses an empty run with the original’s wording, and calls nothing', async () => {
    const execute = vi.fn();
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context({ sql: '   \n  ' })));

    expect(notifications).toEqual(['warning:No query to execute']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a run with no connection', async () => {
    const execute = vi.fn();
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context({ connectionId: undefined })));

    expect(notifications).toEqual(['error:No active connection']);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('the happy path', () => {
  it('executes with the tab’s connection, database, row cap and query timeout', async () => {
    const execute = vi.fn(async () => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context()));

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        database: 'shop',
        sql: 'select 1',
        tabId: 'tab-1',
        maxRows: 500,
        // J-54: `QuerySettings.defaultTimeout` reaching `QueryRequest.timeout` is the whole
        // consumer chain for that setting on this side of IPC.
        timeout: 45_000,
      })
    );
  });

  it('renames the tab from the SQL after a successful run', async () => {
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult } }));
    const tabId = tabStore
      .getState()
      .openQueryTab('conn-1', 'shop', 'select * from customers', false);
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context({ tabId, sql: 'select * from customers' })));

    expect(tabStore.getState().tabs.find(tab => tab.id === tabId)?.title).toBe('customers');
  });

  it('asks the AI for a name when auto-rename is on', async () => {
    const generateTabName = vi.fn(async () => ({ suggestedName: 'Recent customers' }));
    teardowns.push(
      installJoineryMock({ query: { execute: async () => okResult }, ai: { generateTabName } })
    );
    // `generateTabName` also requires a CONFIGURED vendor (`selectHasConfiguredVendors`), which is a
    // separate switch from the feature flag — both have to be on, and that is the store's rule, not
    // this hook's.
    aiStore.setState({
      settings: {
        ...aiStore.getState().settings,
        enabled: true,
        features: { ...aiStore.getState().settings.features, autoRenameEnabled: true },
        vendorSettings: [
          { vendorId: 'anthropic', enabled: true, apiKeyConfigured: true, priority: 1 } as never,
        ],
      },
    });
    const tabId = tabStore.getState().openQueryTab('conn-1', 'shop', 'select 1', false);
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context({ tabId })));
    await vi.waitFor(() =>
      expect(tabStore.getState().tabs.find(tab => tab.id === tabId)?.title).toBe('Recent customers')
    );
    expect(generateTabName).toHaveBeenCalledWith({ sql: 'select 1', database: 'shop' });
  });

  it('does not rename after a failed run', async () => {
    teardowns.push(
      installJoineryMock({
        query: { execute: async () => ({ queryId: 'q', success: false, error: 'boom' }) },
      })
    );
    const tabId = tabStore
      .getState()
      .openQueryTab('conn-1', 'shop', 'select * from customers', false);
    const before = tabStore.getState().tabs.find(tab => tab.id === tabId)?.title;
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context({ tabId, sql: 'select * from customers' })));

    expect(tabStore.getState().tabs.find(tab => tab.id === tabId)?.title).toBe(before);
  });
});

describe('the placeholder prompt', () => {
  it('suspends the run, then substitutes what the prompt returned', async () => {
    // Declared parameter, so the recorded call's `sql` is typed rather than `never`.
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    // The run is STARTED inside an async act, which flushes far enough for the prompt's state update to
    // commit — and no further, because the sequence is now parked on the prompt's promise.
    let run: Promise<unknown> | undefined;
    let settled = false;
    await act(async () => {
      run = api()
        .run(context({ sql: 'SELECT * FROM ${schema}.${table}' }))
        .then(() => {
          settled = true;
        });
    });

    // Suspended: the prompt is up and nothing has been sent.
    expect(api().prompting).toEqual(['schema', 'table']);
    expect(execute).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await act(async () => {
      api().submitPlaceholders({ schema: 'public', table: 'customers' });
      await run;
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].sql).toBe('SELECT * FROM public.customers');
    expect(api().prompting).toEqual([]);
  });

  it('remembers the values for the next prompt', async () => {
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    let run: ReturnType<RunQuery['run']> | undefined;
    await act(async () => {
      run = api().run(context({ sql: 'SELECT ${schema}' }));
    });
    expect(api().prompting).toEqual(['schema']);

    await act(async () => {
      api().submitPlaceholders({ schema: 'reporting' });
      await run;
    });

    expect(editorPrefsStore.getState().flywayPlaceholderValues).toEqual({ schema: 'reporting' });
  });

  it('abandons the run when the prompt is cancelled', async () => {
    const execute = vi.fn(async () => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    let run: ReturnType<RunQuery['run']> | undefined;
    await act(async () => {
      run = api().run(context({ sql: 'SELECT ${schema}' }));
    });
    expect(api().prompting).toEqual(['schema']);

    await act(async () => {
      api().cancelPlaceholders();
      await run;
    });

    expect(execute).not.toHaveBeenCalled();
    expect(api().prompting).toEqual([]);
    // Nothing remembered either — a cancelled prompt taught the app nothing.
    expect(editorPrefsStore.getState().flywayPlaceholderValues).toEqual({});
  });

  it('abandons a SECOND run that arrives while the prompt is open, and reports it', async () => {
    // Reachable through Query ▸ Execute from the native menu, which is not a keystroke and so is not
    // stopped by the dialog's focus trap. Throwing here would be an unhandled rejection: the caller is a
    // `void run(…)`.
    const warnings: string[] = [];
    teardowns.push(
      setDiagnosticsSink({ error: () => undefined, warn: context => warnings.push(context) })
    );
    const execute = vi.fn(async () => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    let first: ReturnType<RunQuery['run']> | undefined;
    await act(async () => {
      first = api().run(context({ sql: 'SELECT ${schema}' }));
    });
    expect(api().prompting).toEqual(['schema']);

    // The second one settles immediately, having done nothing.
    await act(async () => {
      await api().run(context({ sql: 'SELECT ${other}' }));
    });
    expect(warnings).toEqual(['ignored an execute while a placeholder prompt was open']);
    expect(execute).not.toHaveBeenCalled();
    // And the first is still live: its prompt is untouched and answering it still runs it.
    expect(api().prompting).toEqual(['schema']);
    // The refusal is also SAID, not only logged: the counter is what re-focuses the dialog's first
    // field, so the user learns the prompt is what is blocking the run. A log entry alone reads as a
    // menu item that did nothing.
    expect(api().promptAttention).toBe(1);

    // A third arrival bumps it again — the dialog's effect keys on the change, so a boolean would make
    // every refusal after the first silent.
    await act(async () => {
      await api().run(context({ sql: 'SELECT ${third}' }));
    });
    expect(api().promptAttention).toBe(2);

    await act(async () => {
      api().submitPlaceholders({ schema: 'public' });
      await first;
    });
    expect(execute).toHaveBeenCalledOnce();
    // Reset with the prompt, so the next one does not open mid-count and steal Radix's initial focus.
    expect(api().promptAttention).toBe(0);
  });

  it('never raises the attention counter for a prompt that opens cleanly', async () => {
    const execute = vi.fn(async () => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    let run: ReturnType<RunQuery['run']> | undefined;
    await act(async () => {
      run = api().run(context({ sql: 'SELECT ${schema}' }));
    });

    expect(api().prompting).toEqual(['schema']);
    expect(api().promptAttention).toBe(0);

    await act(async () => {
      api().cancelPlaceholders();
      await run;
    });
  });

  it('does not prompt for SQL with no placeholders', async () => {
    const execute = vi.fn(async () => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { api, unmount } = mountHook();
    teardowns.push(unmount);

    await act(() => api().run(context()));

    expect(api().prompting).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });
});
