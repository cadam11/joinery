/**
 * The query panel's own decisions, with the editor seam replaced by a double.
 *
 * The panel is a Monaco host, and Monaco cannot run in jsdom — which is why `QueryCommands` was split
 * out in the first place, so `query-commands.spec.tsx` could mount the command table without it. That
 * split covers "the id reaches the handler". What it cannot cover is what the handlers DO with the
 * editor, and one of them was wrong in a way no existing test could see: Execute Selection inferred
 * "nothing is selected" from the selected text being equal to the whole buffer, so a deliberate ⌘A was
 * refused.
 *
 * So `../../editor` is mocked here — the whole seam, which is a single module boundary precisely
 * because ESLint bans importing Monaco anywhere else — and the panel is driven through the real command
 * bus, the real tab store and the real execution store. What is under test is the wiring between them.
 */

import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ExecuteScope,
  type QueryRequest,
  type QueryResult,
} from '@joinery/shared';

import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { dispatchCommand } from '../../commands';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { connectionStore } from '../../state/connection';
import { editorPrefsStore } from '../../state/editor-prefs';
import { queryExecutionStore } from '../../state/query-execution';
import { queryPlanStore } from '../../state/query-plan';
import { settingsStore } from '../../state/settings';
import { tabStore } from '../../state/tab';
import { TooltipProvider } from '../../ui';

// ── The editor double ──────────────────────────────────────────────────────────────────────

/**
 * The editor's state, as the panel can observe it through the handle.
 *
 * `selection` and `value` are separate on purpose: the bug this file exists for was a comparison
 * between them, so a double that derived one from the other could not express the failing case.
 */
const editorState = {
  value: '',
  selection: '',
  hasSelection: false,
  setValues: [] as string[],
  /**
   * The last `editorSettings` the panel handed the editor, and how many times the editor MOUNTED.
   *
   * Task 15's half of the settings chain is asserted through these two: a settings change must reach an
   * editor that is already open (a new prop) rather than a new one (a remount, which would discard the
   * document and the undo stack). `sql-editor.spec.tsx` owns the other half — the prop reaching Monaco's
   * `updateOptions`.
   */
  settings: undefined as AppSettings['editor'] | undefined,
  mounts: 0,
};

/** The panel's ⌃E handler, which in the real editor is a Monaco keybinding rather than a DOM event. */
const editorShortcut: { current: (() => void) | null } = { current: null };

const handle = {
  getValue: () => editorState.value,
  setValue: (next: string) => {
    editorState.setValues.push(next);
    editorState.value = next;
  },
  focus: () => undefined,
  layout: () => undefined,
  textToExecute: (scope: ExecuteScope) =>
    // Mirrors `statements.ts`: a non-empty selection always wins, whatever the scope says.
    editorState.selection !== '' ? editorState.selection : scope === 'all' ? editorState.value : '',
  hasSelection: () => editorState.hasSelection,
  insertSnippet: () => undefined,
  runAction: () => undefined,
};

vi.mock('../../editor', () => ({
  // The host div carries the testid the real one does, so a locator in this file reads like the e2e one.
  SqlEditor: ({
    handleRef,
    editorSettings,
    onExecuteShortcut,
    'data-testid': testId,
  }: {
    handleRef: { current: unknown };
    editorSettings: AppSettings['editor'];
    onExecuteShortcut: () => void;
    'data-testid'?: string;
  }) => {
    handleRef.current = handle;
    editorState.settings = editorSettings;
    editorShortcut.current = onExecuteShortcut;
    // A mount counter has to be an effect, not a render-body increment: React may render twice for one
    // mount, and what is being asserted is that the editor was not REBUILT.
    useEffect(() => {
      editorState.mounts += 1;
    }, []);
    return <div data-testid={testId} />;
  },
  formatSql: (sql: string) => sql.toUpperCase(),
  monacoLanguageFor: () => 'pgsql',
  sqlIntellisense: { loadMetadata: async () => undefined },
}));

const { QueryPanel } = await import('./query-panel');

// ── The harness ────────────────────────────────────────────────────────────────────────────

const okResult: QueryResult = {
  queryId: 'query-1',
  success: true,
  resultSets: [{ columns: [{ name: 'id', type: 'int' }], rows: [{ id: 1 }] }],
  executionTime: 2,
};

const teardowns: (() => void)[] = [];
const notifications: string[] = [];

/** Dockview hands the panel a `params.tabId` and an `api`; these two members are all it touches. */
function panelProps(tabId: string): IDockviewPanelProps {
  return {
    params: { tabId },
    api: {
      id: tabId,
      onDidActiveChange: () => ({ dispose: () => undefined }),
    },
  } as unknown as IDockviewPanelProps;
}

/**
 * A connected profile, a query tab on it, and the panel mounted for that tab.
 *
 * The engine is a parameter because one of the panel's decisions turns on it: only SQL Server's execution
 * plan runs the statement, so only SQL Server raises the `actual-plan` confirmation.
 */
function mountPanel(
  sql: string,
  engine: 'postgresql' | 'mssql' | 'mysql' = 'postgresql'
): { tabId: string; unmount: () => void } {
  connectionStore.setState({
    profiles: [{ id: 'conn-1', name: 'Test server', engine }],
  } as never);
  const tabId = tabStore.getState().openQueryTab('conn-1', 'shop', sql, false);
  editorState.value = sql;
  // The toolbar's buttons are tooltipped, and Radix requires the provider the shell mounts once.
  const { unmount } = render(
    <TooltipProvider>
      <QueryPanel {...panelProps(tabId)} />
    </TooltipProvider>
  );
  return { tabId, unmount };
}

beforeEach(() => {
  editorState.value = '';
  editorState.selection = '';
  editorState.hasSelection = false;
  editorState.setValues = [];
  editorState.settings = undefined;
  editorShortcut.current = null;
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
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  for (const tab of tabStore.getState().tabs) queryExecutionStore.getState().forgetTab(tab.id);
  tabStore.setState({ tabs: [], activeTabId: '' });
  connectionStore.setState({ profiles: [] } as never);
});

/** Runs a command through the real bus and lets the resulting promises settle. */
async function invoke(
  id: 'execute-query' | 'execute-selection' | 'open-query-file' | 'show-execution-plan'
): Promise<void> {
  await act(async () => {
    dispatchCommand(id);
    await Promise.resolve();
  });
}

// ── Execute Selection ──────────────────────────────────────────────────────────────────────

describe('execute-selection', () => {
  it('runs a ⌘A select-all, because selecting everything IS a selection', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT 1;\nSELECT 2;');
    teardowns.push(unmount);

    // ⌘A: Monaco reports a selection, and its text is the whole document.
    editorState.hasSelection = true;
    editorState.selection = 'SELECT 1;\nSELECT 2;';

    await invoke('execute-selection');

    // The bug: `selection === whole` read this as "nothing selected" and answered "Select some SQL to
    // execute" — refusing the most obvious way to use the command.
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].sql).toBe('SELECT 1;\nSELECT 2;');
    expect(notifications).not.toContain('warning:Select some SQL to execute');
  });

  it('runs a partial selection, not the buffer around it', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT 1;\nSELECT 2;');
    teardowns.push(unmount);

    editorState.hasSelection = true;
    editorState.selection = 'SELECT 2;';

    await invoke('execute-selection');

    expect(execute.mock.calls[0]?.[0].sql).toBe('SELECT 2;');
  });

  it('refuses when the caret is collapsed, rather than running the whole buffer', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);

    // The Angular menu item ran the whole buffer here (`query.component.ts:1095` bound Execute
    // Selection to `executeQuery()`), which made it a duplicate of Execute.
    await invoke('execute-selection');

    expect(execute).not.toHaveBeenCalled();
    expect(notifications).toContain('warning:Select some SQL to execute');
  });

  it('refuses a selection of nothing but whitespace', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT 1;\n   \n');
    teardowns.push(unmount);

    // Monaco's `isEmpty()` is a zero-WIDTH check, so a blank line IS a selection — and there is still
    // nothing to run in it.
    editorState.hasSelection = true;
    editorState.selection = '   \n';

    await invoke('execute-selection');

    expect(execute).not.toHaveBeenCalled();
    expect(notifications).toContain('warning:Select some SQL to execute');
  });

  it('still sends the whole buffer for plain Execute', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);

    await invoke('execute-query');

    // The two commands are different, which is the whole point of the deviation from Angular.
    expect(execute.mock.calls[0]?.[0].sql).toBe('SELECT 1;');
  });
});

// ── Opening a file ─────────────────────────────────────────────────────────────────────────

describe('open-query-file', () => {
  it('leaves the freshly opened tab CLEAN', async () => {
    teardowns.push(
      installJoineryMock({
        app: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/a.sql'] }) },
        workspace: { readFile: async () => 'SELECT 42;' },
      })
    );
    const { tabId, unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);
    // An edited tab, which is the state the bug was visible from: the clean baseline is `SELECT 1;`.
    tabStore.getState().setTabContent(tabId, 'SELECT 1; -- edited');
    expect(tabStore.getState().tabs.find(tab => tab.id === tabId)?.isDirty).toBe(true);

    await invoke('open-query-file');
    // `openQueryFile` awaits two bridge calls before `adoptOpenedFile` runs.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const tab = tabStore.getState().tabs.find(candidate => candidate.id === tabId);
    expect(editorState.setValues).toEqual(['SELECT 42;']);
    // Without the baseline move, reading a file made the tab dirty the instant it opened — unsaved dot,
    // and Task 7's close guard warning about work the user had never touched.
    expect(tab?.isDirty).toBe(false);
    expect(tab?.metadata?.['filePath']).toBe('/tmp/a.sql');
    expect(tabStore.getState().getTabContent(tabId)).toBe('SELECT 42;');
  });
});

// ── The two execute gates (Task 15) ────────────────────────────────────────────────────────
//
// `QuerySettings.confirmBeforeExecute` was the third of the three query settings the Angular panel
// wrote while nothing read them — J-44's class of defect. Task 15 wired it HERE, at the panel, because
// this is the one place every user-initiated run passes through; that is also what makes it assertable
// without Monaco, since `../../editor` is already a double in this file.

describe('confirmBeforeExecute', () => {
  const setConfirmBeforeExecute = (value: boolean): void => {
    settingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        query: { ...DEFAULT_SETTINGS.query, confirmBeforeExecute: value },
      },
    });
  };

  afterEach(() => {
    settingsStore.setState({ settings: DEFAULT_SETTINGS });
    editorPrefsStore.setState({ confirmedCtrlEExecute: false });
  });

  it('gates plain Execute, and runs the SQL that was on screen when it was confirmed', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    setConfirmBeforeExecute(true);
    const { unmount } = mountPanel('DELETE FROM orders;');
    teardowns.push(unmount);

    await invoke('execute-query');

    // Nothing ran, and the dialog says which gate stopped it.
    expect(execute).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('query-confirm-execute');
    expect(dialog.getAttribute('data-gate')).toBe('always');
    // The permanent gate offers no "don't ask me again" — that would be a second, hidden way to turn
    // the setting off, leaving the switch in Settings showing "on".
    expect(screen.queryByTestId('query-confirm-execute-remember')).toBeNull();

    await userEvent.click(screen.getByTestId('query-confirm-execute-run'));

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].sql).toBe('DELETE FROM orders;');
  });

  it('runs nothing when the confirmation is cancelled', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    setConfirmBeforeExecute(true);
    const { unmount } = mountPanel('DELETE FROM orders;');
    teardowns.push(unmount);

    await invoke('execute-query');
    await userEvent.click(screen.getByTestId('query-confirm-execute-cancel'));

    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByTestId('query-confirm-execute')).toBeNull();
  });

  it('gates Execute Selection too — after the refusals, not before them', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    setConfirmBeforeExecute(true);
    const { unmount } = mountPanel('SELECT 1;\nSELECT 2;');
    teardowns.push(unmount);

    // No selection: the refusal comes first, and no confirmation is raised for a run that cannot happen.
    await invoke('execute-selection');
    expect(screen.queryByTestId('query-confirm-execute')).toBeNull();
    expect(notifications).toContain('warning:Select some SQL to execute');

    editorState.hasSelection = true;
    editorState.selection = 'SELECT 2;';
    await invoke('execute-selection');
    await userEvent.click(screen.getByTestId('query-confirm-execute-run'));

    // The SELECTION, not the buffer: the gate captures the SQL when it opens rather than re-deriving it.
    expect(execute.mock.calls[0]?.[0].sql).toBe('SELECT 2;');
  });

  it('takes precedence over the one-time ⌃E gate, which cannot dismiss it', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    setConfirmBeforeExecute(true);
    // Already ticked "don't ask me again" for ⌃E — which must not skip a confirmation the SETTING wants.
    editorPrefsStore.setState({ confirmedCtrlEExecute: true, hydrated: true });
    const { unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);

    // ⌃E is a Monaco keybinding, so the editor double's `onExecuteShortcut` is the entry point.
    await act(async () => {
      editorShortcut.current?.();
      await Promise.resolve();
    });

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByTestId('query-confirm-execute').getAttribute('data-gate')).toBe('always');
  });

  /*
   * The consequence of Task 15's "Ask me again" button, asserted where it is observable. The tick is
   * one-way from the ⌃E dialog itself, so before that button there was no way back at all — this is what
   * makes it a real control rather than a decorative one.
   */
  it('re-arms the ⌃E gate when the confirmation is reset', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);

    const pressCtrlE = async (): Promise<void> => {
      await act(async () => {
        editorShortcut.current?.();
        await Promise.resolve();
      });
    };

    // Never confirmed: the one-time gate appears.
    await pressCtrlE();
    expect(screen.getByTestId('query-confirm-execute').getAttribute('data-gate')).toBe('ctrl-e');
    await userEvent.click(screen.getByTestId('query-confirm-execute-remember'));
    await userEvent.click(screen.getByTestId('query-confirm-execute-run'));
    expect(editorPrefsStore.getState().confirmedCtrlEExecute).toBe(true);

    // Confirmed: straight through.
    await pressCtrlE();
    expect(screen.queryByTestId('query-confirm-execute')).toBeNull();

    // Reset from the settings panel: the gate is back.
    act(() => editorPrefsStore.getState().resetCtrlEExecuteConfirmation());
    await pressCtrlE();
    expect(screen.getByTestId('query-confirm-execute').getAttribute('data-gate')).toBe('ctrl-e');
  });

  it('leaves every entry point ungated when the setting is off', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    setConfirmBeforeExecute(false);
    const { unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);

    await invoke('execute-query');

    expect(screen.queryByTestId('query-confirm-execute')).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  });
});

// ── The execution plan's MSSQL gate FIRES (Task 19b) ───────────────────────────────────────
//
// The safety property of the whole execution-plan feature rests on one branch: SQL Server cannot report a
// plan for a statement it has not run, so `show-execution-plan` on a `DELETE` deletes rows unless the
// confirmation stops it first. That branch is `if (request.executes)` in `showExecutionPlan`, and this
// block is what fails when it is inverted, removed, or made to fall through.

describe('show-execution-plan on SQL Server', () => {
  const PLAN_SQL = 'DELETE FROM orders WHERE id = 4;';

  it('asks BEFORE running anything, and names what it is about to do', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel(PLAN_SQL, 'mssql');
    teardowns.push(unmount);

    await invoke('show-execution-plan');

    // The whole point: nothing has reached the database yet.
    expect(execute).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('query-confirm-execute');
    expect(dialog.getAttribute('data-gate')).toBe('actual-plan');
    expect(dialog.textContent).toContain('SQL Server');
    // And the statement being consented to is on screen, not merely implied.
    expect(screen.getByTestId('query-confirm-execute-sql').textContent).toBe(PLAN_SQL);
  });

  it('runs the plan request only once the confirmation is accepted', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel(PLAN_SQL, 'mssql');
    teardowns.push(unmount);

    await invoke('show-execution-plan');
    expect(execute).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('query-confirm-execute-run'));

    expect(execute).toHaveBeenCalledOnce();
    // The wrapper, not the bare statement: `SET STATISTICS PROFILE` is the only plan MSSQL will give
    // through `query.execute` (`execution-plan.ts`).
    expect(execute.mock.calls[0]?.[0].sql).toContain('SET STATISTICS PROFILE ON');
    expect(execute.mock.calls[0]?.[0].sql).toContain('DELETE FROM orders WHERE id = 4');
  });

  it('runs nothing at all when the confirmation is declined', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel(PLAN_SQL, 'mssql');
    teardowns.push(unmount);

    await invoke('show-execution-plan');
    await userEvent.click(screen.getByTestId('query-confirm-execute-cancel'));

    expect(screen.queryByTestId('query-confirm-execute')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not gate PostgreSQL, whose EXPLAIN mutates nothing', async () => {
    const execute = vi.fn(async (_request: QueryRequest) => okResult);
    teardowns.push(installJoineryMock({ query: { execute } }));
    const { unmount } = mountPanel('SELECT * FROM orders;');
    teardowns.push(unmount);

    await invoke('show-execution-plan');

    // A confirmation on a free EXPLAIN would be a dialog with no consequence behind it — and it is the
    // contrast that makes the MSSQL gate readable as a statement about MSSQL rather than about plans.
    expect(screen.queryByTestId('query-confirm-execute')).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].sql).toBe('EXPLAIN (FORMAT JSON) SELECT * FROM orders');
  });
});

// ── Editor settings reach an ALREADY-MOUNTED editor (Task 15) ──────────────────────────────

describe('editor settings', () => {
  afterEach(() => settingsStore.setState({ settings: DEFAULT_SETTINGS }));

  it('re-renders the open editor with the new settings rather than remounting it', () => {
    const { unmount } = mountPanel('SELECT 1;');
    teardowns.push(unmount);

    const mountsBefore = editorState.mounts;
    expect(editorState.settings?.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);

    act(() => {
      settingsStore.getState().updateEditorSetting('fontSize', 18);
    });

    // The panel subscribes through `selectEditorSettings`, so the editor gets a new prop — and
    // `sql-editor.spec.tsx`'s "pushes changed settings through updateOptions instead of recreating"
    // owns the other half: the prop reaches Monaco without the instance being rebuilt. A remount here
    // would discard the document and the undo stack, which is what that half is protecting.
    expect(editorState.settings?.fontSize).toBe(18);
    expect(editorState.mounts).toBe(mountsBefore);
  });
});

// ── The SQL dialect converter (Task 19a) ───────────────────────────────────────────────────

describe('the SQL dialect converter', () => {
  /** Records what `sql-convert.ts` asked the bridge for, and answers with `converted`. */
  function installConverter(
    answer: { success: boolean; sql?: string; error?: string } = {
      success: true,
      sql: 'SELECT 1 LIMIT 1',
    }
  ): { calls: { sql: string; from: string; to: string }[] } {
    const calls: { sql: string; from: string; to: string }[] = [];
    teardowns.push(
      installJoineryMock({
        query: {
          convertSql: (sql: string, fromEngine: string, toEngine: string) => {
            calls.push({ sql, from: fromEngine, to: toEngine });
            return Promise.resolve({
              success: answer.success,
              sql: answer.sql ?? '',
              ...(answer.error === undefined ? {} : { error: answer.error }),
            });
          },
        },
      })
    );
    return { calls };
  }

  /**
   * Open the menu and pick a target. `userEvent` already wraps its own work in `act`, so nesting it
   * inside another `act` is what produces the "not configured to support act" warnings — the settle is a
   * `waitFor` on the observable effect instead, which is what the caller asserts on anyway.
   */
  async function chooseTarget(target: 'mssql' | 'mysql' | 'postgresql'): Promise<void> {
    await userEvent.click(screen.getByTestId('query-convert'));
    await userEvent.click(await screen.findByTestId(`query-convert-${target}`));
  }

  it('offers every engine except the tab’s own', async () => {
    installConverter();
    const { unmount } = mountPanel('SELECT 1');
    teardowns.push(unmount);

    await userEvent.click(screen.getByTestId('query-convert'));

    // The tab is PostgreSQL (`mountPanel`), so its own entry is absent — the Angular menu hid it too.
    expect(await screen.findByTestId('query-convert-mssql')).toBeTruthy();
    expect(screen.getByTestId('query-convert-mysql')).toBeTruthy();
    expect(screen.queryByTestId('query-convert-postgresql')).toBeNull();
  });

  it('converts the whole buffer and replaces the document', async () => {
    const { calls } = installConverter({ success: true, sql: 'SELECT TOP 1 * FROM t' });
    const { unmount } = mountPanel('SELECT * FROM t LIMIT 1');
    teardowns.push(unmount);

    await chooseTarget('mssql');
    await waitFor(() => expect(editorState.setValues.at(-1)).toBe('SELECT TOP 1 * FROM t'));

    expect(calls).toEqual([{ sql: 'SELECT * FROM t LIMIT 1', from: 'postgresql', to: 'mssql' }]);
    // `setValue`, the same write Format makes, so the conversion is one undo away.
    expect(notifications).toContain('success:Converted to SQL Server');
  });

  it('converts the selection when there is one', async () => {
    const { calls } = installConverter();
    const { unmount } = mountPanel('SELECT 1;\nSELECT * FROM t LIMIT 1;');
    teardowns.push(unmount);

    editorState.hasSelection = true;
    editorState.selection = 'SELECT * FROM t LIMIT 1;';

    await chooseTarget('mysql');
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]?.sql).toBe('SELECT * FROM t LIMIT 1;');
  });

  it('leaves the document alone and says why when the conversion fails', async () => {
    installConverter({ success: false, error: "ParseError: line 1, 'FROOM'" });
    const { unmount } = mountPanel('FROOM t');
    teardowns.push(unmount);

    await chooseTarget('mssql');
    await waitFor(() => expect(notifications).toContain("warning:ParseError: line 1, 'FROOM'"));

    expect(editorState.setValues).toEqual([]);
  });

  it('reaches the same handler from the palette’s command', async () => {
    // The toolbar menu and the three palette commands are two producers for one behaviour, which is why
    // the command exists at all rather than the menu calling the bridge itself.
    const { calls } = installConverter();
    const { unmount } = mountPanel('SELECT * FROM t LIMIT 1');
    teardowns.push(unmount);

    act(() => {
      dispatchCommand('convert-sql-to-mysql');
    });
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls).toEqual([{ sql: 'SELECT * FROM t LIMIT 1', from: 'postgresql', to: 'mysql' }]);
  });
});

// ── A closed tab's per-tab state is released, even when the panel was already unmounted (J-62) ──
//
// The panel's cleanup used to be an unmount effect guarded by "the tab is gone". That guard cannot see
// the case that matters: Dockview unmounts a panel when it is DEACTIVATED, so a tab closed while it is
// not in front never gets another unmount, and its result, its recorded SQL and its plan tree stay in
// the two stores for the rest of the session. This is the same lifecycle hole the chat stores closed
// with a `tabStore.tabs` watcher (`features/chat/chat-store-host.ts`), and it is closed the same way.

describe('a closed query tab', () => {
  afterEach(() => {
    for (const tabId of [...queryPlanStore.getState().plans.keys()]) {
      queryPlanStore.getState().forgetTab(tabId);
    }
  });

  /** A plan for a tab, written straight into the real store — the panel's own path needs MSSQL and a gate. */
  function givePlan(tabId: string, forResult: QueryResult): void {
    queryPlanStore.getState().setPlan(tabId, {
      forResult,
      engine: 'postgresql',
      kind: 'estimated',
      root: { type: 'Seq Scan', costPercent: 100, extra: [], children: [] },
      summary: { totalCost: 1, warnings: [] },
      sql: 'SELECT 1;',
    });
  }

  async function runOnce(): Promise<void> {
    await invoke('execute-query');
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('releases its result, its recorded SQL and its plan when it was DEACTIVATED at close time', async () => {
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult } }));
    const { tabId, unmount } = mountPanel('SELECT 1;');
    await runOnce();
    givePlan(tabId, queryExecutionStore.getState().results.get(tabId) as QueryResult);
    expect(queryExecutionStore.getState().results.has(tabId)).toBe(true);

    // Deactivation first, then the close: the order that produces no second unmount.
    unmount();
    tabStore.getState().closeTab(tabId);

    expect(queryExecutionStore.getState().results.has(tabId)).toBe(false);
    expect(queryExecutionStore.getState().sqlByTab.has(tabId)).toBe(false);
    expect(queryPlanStore.getState().plans.has(tabId)).toBe(false);
  });

  it('releases its result when it was the ACTIVE tab, which the old unmount cleanup already did', async () => {
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult } }));
    const { tabId, unmount } = mountPanel('SELECT 1;');
    await runOnce();
    givePlan(tabId, queryExecutionStore.getState().results.get(tabId) as QueryResult);

    tabStore.getState().closeTab(tabId);
    unmount();

    expect(queryExecutionStore.getState().results.has(tabId)).toBe(false);
    expect(queryPlanStore.getState().plans.has(tabId)).toBe(false);
  });

  it('leaves the results of the tabs that are still open alone', async () => {
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult } }));
    const first = mountPanel('SELECT 1;');
    await runOnce();
    const second = mountPanel('SELECT 2;');
    await runOnce();
    expect(queryExecutionStore.getState().results.has(first.tabId)).toBe(true);
    expect(queryExecutionStore.getState().results.has(second.tabId)).toBe(true);

    first.unmount();
    tabStore.getState().closeTab(first.tabId);

    expect(queryExecutionStore.getState().results.has(first.tabId)).toBe(false);
    expect(queryExecutionStore.getState().results.has(second.tabId)).toBe(true);
    second.unmount();
  });

  it('survives a panel that is unmounted without its tab being closed', async () => {
    teardowns.push(installJoineryMock({ query: { execute: async () => okResult } }));
    const { tabId, unmount } = mountPanel('SELECT 1;');
    await runOnce();

    // Plain deactivation: the tab is still open, so nothing may be forgotten.
    unmount();

    expect(queryExecutionStore.getState().results.has(tabId)).toBe(true);
  });
});
