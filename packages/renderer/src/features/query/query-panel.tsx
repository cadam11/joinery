/**
 * The query tab. Replaces the 2,689-line `query.component.ts` — or rather, replaces the ~250 lines of it
 * that are this surface's own job, the rest having gone to `src/editor/`, `state/query-execution.ts`,
 * two dialogs, a toolbar, a results pane and a command table.
 *
 * What this file owns and nothing else does:
 *
 *  - the **geometry**: toolbar / editor / divider / results, and the persisted split between the last two;
 *  - the **bindings** between the tab and the editor: initial content, content → `setTabContent`, caret →
 *    the status bar, engine → the tokenizer;
 *  - the **two execute gates**: ⌃E's one-time confirmation, which is a keystroke's and not the menu
 *    item's, and `QuerySettings.confirmBeforeExecute`, which is every entry point's (Task 15);
 *  - **auto-execute**, for a tab opened from the explorer or an FK link with SQL already in it;
 *  - the **`layout()` on re-activation** that PLAN.md R5 finding 4 requires.
 *
 * ── Reading the tab, and why nothing is prop-drilled ───────────────────────────────────────
 *
 * Dockview mounts this with `params.tabId` and that is the only input (`shell/workspace/tab-panels.tsx`).
 * Every other value — the tab, its connection, its database, the engine, the settings — is read from a
 * store through a selector, so an inactive panel whose DOM is detached still re-renders correctly when
 * its tab's connection changes, and no ancestor has to know a query tab exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { DatabaseEngine, PythonDepsResult } from '@joinery/shared';

import { dispatchCommand } from '../../commands';
import { ipc } from '../../ipc';
import {
  SqlEditor,
  formatSql,
  monacoLanguageFor,
  sqlIntellisense,
  type SqlEditorHandle,
} from '../../editor';
import { ResizeHandle } from '../../shell/resize-handle';
import { diagnostics, notify } from '../../state/diagnostics';
import { selectProfileFor, useConnectionStore } from '../../state/connection';
import {
  queryExecutionStore,
  selectIsExecuting,
  selectResultFor,
  useQueryExecutionStore,
} from '../../state/query-execution';
import { queryPlanStore } from '../../state/query-plan';
import { selectEditorSettings, selectEffectiveTheme, useSettingsStore } from '../../state/settings';
import { tabStore, useTabStore } from '../../state/tab';
import {
  EDITOR_HEIGHT_MAX_PERCENT,
  EDITOR_HEIGHT_MIN_PERCENT,
  useWorkbenchStore,
  workbenchStore,
} from '../../state/workbench';
import { cn } from '../../ui';
import { ConfirmExecuteDialog, type ExecuteGate } from './confirm-execute-dialog';
import { PlaceholderDialog } from './placeholder-dialog';
import { QueryCommands } from './query-commands';
import { QueryResults } from './query-results';
import { QueryToolbar } from './query-toolbar';
import { editorPrefsStore, useEditorPrefsStore } from '../../state/editor-prefs';
import { adoptOpenedFile, openQueryFile, rememberedFilePath, saveQueryToFile } from './query-files';
import { PLAN_KIND, planFromResult, planRequestFor } from './execution-plan';
import { ENGINE_LABELS, convertSql } from './sql-convert';
import { PythonSetupDialog } from './python-setup-dialog';
import { useRunQuery } from './use-run-query';

/** Arrow-key step for the split divider, in percent. 2% is ~12px in a 600px pane. */
const SPLIT_STEP_PERCENT = 2;

export function QueryPanel(props: IDockviewPanelProps) {
  const tabId = typeof props.params['tabId'] === 'string' ? props.params['tabId'] : props.api.id;
  const tab = useTabStore(state => state.tabs.find(candidate => candidate.id === tabId));

  const profile = useConnectionStore(selectProfileFor(tab?.connectionId ?? null));
  const engine: DatabaseEngine | undefined = profile?.engine;

  const editorSettings = useSettingsStore(selectEditorSettings);
  const theme = useSettingsStore(selectEffectiveTheme);

  const executing = useQueryExecutionStore(selectIsExecuting(tabId));
  const result = useQueryExecutionStore(selectResultFor(tabId));

  const editorHeightPercent = useWorkbenchStore(state => state.editorHeightPercent);
  // Only the placeholder values are SUBSCRIBED to: they are rendered (as the prompt's pre-filled
  // fields), whereas the ⌃E flag is read at the moment the keystroke arrives (`executeWithGate`) and a
  // subscription to it would re-render every open query tab when one of them ticks the box.
  const rememberedPlaceholders = useEditorPrefsStore(state => state.flywayPlaceholderValues);

  const editor = useRef<SqlEditorHandle | null>(null);
  /** The split container, measured at drag start so a percentage divider knows what 1px is worth. */
  const splitPane = useRef<HTMLDivElement | null>(null);
  const [resultsHidden, setResultsHidden] = useState(false);
  /** The Python probe behind a refused conversion, or null when the dialog is closed (J-29). */
  const [pythonSetup, setPythonSetup] = useState<PythonDepsResult | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | undefined>(undefined);
  /**
   * The run waiting on a confirmation: the SQL it would send, and which gate stopped it. `null` when
   * nothing is waiting, which is also what closes the dialog.
   *
   * The SQL is captured when the gate opens rather than re-read when it closes. Both are correct — the
   * dialog is modal, so the document cannot change underneath — but capturing makes ONE code path serve
   * a whole-editor run and a selection run, and it is the selection that needs it: `executeSelection`
   * has already validated a selection by the time the gate opens, and re-deriving it afterwards would
   * be a second chance to disagree with the check that let it through.
   */
  const [pendingRun, setPendingRun] = useState<{
    readonly sql: string;
    readonly gate: ExecuteGate;
    /**
     * Set when the confirmation is for a PLAN request rather than for an ordinary run: `sql` is then the
     * `SET STATISTICS PROFILE …` wrapper that will be sent, and this is the statement the resulting plan
     * is for. Both are needed — one is what goes over IPC, the other is what the plan is labelled with.
     */
    readonly planFor?: string;
  } | null>(null);

  const runQuery = useRunQuery();

  /**
   * The context every run needs, read fresh from the stores.
   *
   * A function rather than a memo: it is called from Monaco keybindings and command handlers that were
   * installed once, and a memo captured in one of those closures would hand them the tab's connection as
   * it was when the editor mounted. This is the same reason `isActive` is a function.
   */
  const runContext = useCallback(
    (sql: string) => {
      const current = tabStore.getState().tabs.find(candidate => candidate.id === tabId);
      return {
        tabId,
        tabTitle: current?.title ?? 'Query',
        connectionId: current?.connectionId,
        database: current?.databaseName,
        querySettings: useSettingsStore.getState().settings.query,
        sql,
      };
    },
    [tabId]
  );

  /** Send SQL to the executor, with no gate. Everything below funnels here, and so does the dialog. */
  const runNow = useCallback(
    (sql: string): void => {
      void runQuery.run(runContext(sql));
    },
    [runContext, runQuery]
  );

  /** What the caret, the selection and the `executeScope` setting select. */
  const statementSql = useCallback(
    (): string =>
      editor.current?.textToExecute(useSettingsStore.getState().settings.query.executeScope) ?? '',
    []
  );

  /**
   * Execute. Consumed by the toolbar button, Query ▸ Execute, ⌘↩ and F5 — every ungated entry point,
   * which is what makes `QuerySettings.confirmBeforeExecute` a real setting rather than a keystroke's
   * private business: switching it on means *every* one of those asks first.
   *
   * Read from the store at press time, not through a subscription, for the same reason `runContext` is
   * a function: this callback is installed once into Monaco keybindings and a captured value would be
   * whatever the setting was when the editor mounted.
   */
  const execute = useCallback((): void => {
    const sql = statementSql();
    if (useSettingsStore.getState().settings.query.confirmBeforeExecute) {
      setPendingRun({ sql, gate: 'always' });
      return;
    }
    runNow(sql);
  }, [runNow, statementSql]);

  /**
   * Query ▸ Execute Selection (⇧⌘↩).
   *
   * The Angular menu bound this to the SAME method as Execute (`query.component.ts:1095` subscribes
   * `executeSelection$` to `this.executeQuery()`), so "Execute Selection" with nothing selected ran the
   * whole buffer and the menu item was a duplicate. Here it means what it says: the selection, and a
   * refusal when there is none. `'all'` is passed as the scope so a selection-less invocation cannot fall
   * through to the current statement either — `hasSelection()` is the only thing that decides.
   *
   * **`hasSelection()`, not "the selected text differs from the buffer".** That was the first version of
   * this function and it refused the most obvious way to use the command: ⌘A, then Execute Selection.
   * Selecting everything IS a selection, the user said so, and the answer "select some SQL to execute"
   * is nonsense. It was also wrong for a one-line document, where selecting the line equals the buffer.
   * Monaco already knows — `getSelection().isEmpty()` is a zero-width check — so the question is asked
   * of the editor instead of inferred from a string comparison.
   */
  const executeSelection = useCallback((): void => {
    const instance = editor.current;
    if (instance === null || !instance.hasSelection()) {
      notify.warning('Select some SQL to execute');
      return;
    }
    const selection = instance.textToExecute('all');
    // A selection of nothing but whitespace is a real selection to Monaco (see `statements.ts`), and
    // there is nothing to run in it. Same wording, because it is the same instruction to the user.
    if (selection.trim() === '') {
      notify.warning('Select some SQL to execute');
      return;
    }
    // The refusals come FIRST and the confirmation second: being asked "execute this?" and then told
    // there was nothing to execute would be the wrong order to learn that in.
    if (useSettingsStore.getState().settings.query.confirmBeforeExecute) {
      setPendingRun({ sql: selection, gate: 'always' });
      return;
    }
    runNow(selection);
  }, [runNow]);

  /**
   * ⌃E / ⌘E: the gate, then execute. Ported from `handleCtrlEExecute` (`:1545-1553`).
   *
   * Two gates can apply and the ORDER matters. `confirmBeforeExecute` is checked first, because it is
   * the stronger statement — a user who asked to confirm every execute has asked to confirm this one,
   * and the ⌃E gate's "Don't ask me again" must not appear on a confirmation that the setting will raise
   * again next time regardless. Only when the setting is off does the one-time shortcut gate apply.
   */
  const executeWithGate = useCallback((): void => {
    const sql = statementSql();
    if (useSettingsStore.getState().settings.query.confirmBeforeExecute) {
      setPendingRun({ sql, gate: 'always' });
      return;
    }
    if (editorPrefsStore.getState().confirmedCtrlEExecute) {
      runNow(sql);
      return;
    }
    setPendingRun({ sql, gate: 'ctrl-e' });
  }, [runNow, statementSql]);

  const format = useCallback((): void => {
    const sql = editor.current?.getValue() ?? '';
    if (sql.trim() === '') {
      notify.warning('No SQL to format');
      return;
    }
    try {
      editor.current?.setValue(formatSql(sql, engine));
      notify.success('SQL formatted');
    } catch (error) {
      // The parse error is the useful part — `sql-formatter` says which token it choked on — so it goes
      // in the toast rather than into a console the user does not have open.
      notify.error(
        `Could not format this SQL: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [engine]);

  /**
   * Rewrite the editor in another dialect (Task 19a).
   *
   * The **selection or the whole buffer**, which is `getSelectedOrAllText` in the Angular original
   * (`query.component.ts:2393-2417`) — converting a highlighted statement inside a long script is the
   * common case, and converting the whole file when nothing is selected is the other one.
   *
   * How that is expressed: `hasSelection()` picks the branch, and the selected text comes back from
   * `textToExecute('all')` because a non-empty selection wins inside `textToExecute` whatever the scope
   * says (`editor/statements.ts:91-96`). `ExecuteScope` has two members, `'all'` and
   * `'currentStatement'` — there is no `'selection'` — and `'all'` is passed as a CONSTANT rather than
   * reading `editorPrefs.executeScope`: that setting is about what EXECUTES, and a user who set it to
   * "current statement" has not asked for a partial conversion.
   *
   * The write goes through `setValue`, which replaces the whole document — the same thing Format does —
   * so a conversion is one undo away. Replacing only the selection was considered and rejected: the
   * converter answers a whole statement, and splicing it back at the selection's offsets would produce a
   * document in two dialects with no way to tell which lines are which.
   */
  const convert = useCallback(
    (toEngine: DatabaseEngine): void => {
      const instance = editor.current;
      if (instance === null || engine === undefined) return;
      const sql = instance.hasSelection() ? instance.textToExecute('all') : instance.getValue();

      void convertSql({ sql, from: engine, to: toEngine }).then(outcome => {
        if (!outcome.ok) {
          // "This host cannot run the converter" is a setup problem with a guided fix, not a
          // failed conversion — a toast saying so would be the sentence J-29 exists to replace.
          if (outcome.pythonSetup !== undefined) {
            setPythonSetup(outcome.pythonSetup);
            return;
          }
          notify.warning(outcome.reason);
          return;
        }
        editor.current?.setValue(outcome.sql);
        notify.success(`Converted to ${ENGINE_LABELS[toEngine]}`);
      });
    },
    [engine]
  );

  /**
   * Probe again after the user says they have installed the packages (J-29).
   *
   * The probe is cached for the process lifetime, so this is the only way back without a restart.
   * On success the dialog closes and says so rather than converting on the user's behalf: they
   * asked for a conversion some minutes and one install ago, and re-running it silently would be
   * acting on a stale intent.
   */
  const recheckPython = useCallback((): void => {
    setRechecking(true);
    void ipc()
      .python.recheck()
      .then(next => {
        if (next.ready) {
          setPythonSetup(null);
          notify.success('Python is ready — convert again.');
          return;
        }
        setPythonSetup(next);
      })
      .catch(cause => {
        diagnostics.error('the Python re-check failed', cause);
        notify.warning('Could not check for Python again.');
      })
      .finally(() => setRechecking(false));
  }, []);

  const copySetupCommand = useCallback((command: string): void => {
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopiedCommand(command))
      .catch(cause => diagnostics.error('the setup command could not be copied', cause));
  }, []);

  const openSetupLink = useCallback((url: string): void => {
    void ipc()
      .app.openExternal(url)
      .catch(cause => diagnostics.error('the setup link could not be opened', cause));
  }, []);

  /**
   * Send the plan request and store what came back (Task 19b).
   *
   * It goes through `queryExecutionStore.execute`, not around it, and that is the whole design: the tab
   * gets its Executing indicator, its Cancel button, its Messages pane and its stale-result rule for
   * free, and there is still exactly one place in the app that runs SQL. The Angular version called
   * `ipc.executeQuery` directly from the component and had to set `executing` by hand
   * (`query.component.ts:2436`), which is why its Cancel button did nothing during a plan request.
   *
   * A failure leaves NO plan: `forgetTab` first, so a refusal cannot leave the previous statement's Plan
   * tab on screen looking like an answer to this one.
   *
   * **A plan request therefore appears in the query history like any other run, and that is accepted.**
   * The alternative is a run the execution store does not know about, which is the Angular arrangement and
   * is precisely why its Cancel button did nothing during a plan request. History is the visible cost of
   * an in-flight run being cancellable; a `SET STATISTICS PROFILE` row in the history is also a true record
   * of something that really did execute against the database, so hiding it would be the less honest half
   * of the trade.
   */
  const runPlan = useCallback(
    (planSql: string, statement: string): void => {
      if (engine === undefined) return;
      queryPlanStore.getState().forgetTab(tabId);
      void runQuery.run({ ...runContext(planSql), autoRename: false }).then(result => {
        // `null` means the run was superseded, refused or prompted for placeholders — each of which has
        // already reported itself. There is nothing to add and nothing to store.
        if (result === null) return;
        const parsed = planFromResult(result, engine);
        if (!parsed.ok) {
          notify.warning(parsed.reason);
          return;
        }
        queryPlanStore.getState().setPlan(tabId, {
          forResult: result,
          engine,
          kind: PLAN_KIND[engine],
          root: parsed.root,
          summary: parsed.summary,
          sql: statement,
        });
      });
    },
    [engine, runContext, runQuery, tabId]
  );

  /**
   * Query ▸ Show execution plan, from the toolbar button and from the palette.
   *
   * The selection wins over the whole buffer, as it does for Execute — a plan for a highlighted statement
   * inside a script is the common case. `planRequestFor` decides both the wrapper and whether sending it
   * has consequences; when it does (MSSQL only), the confirmation comes first.
   *
   * **`confirmBeforeExecute` is NOT consulted here, and that is deliberate.** On PostgreSQL and MySQL an
   * `EXPLAIN` mutates nothing and returns no rows of the user's own, so the setting's question — "you are
   * about to change data on a live database, are you sure?" — has no subject. On MSSQL the statement DOES
   * run, and that path is gated regardless of the setting by `actual-plan`, which is the stronger
   * confirmation of the two (it cannot be switched off). So there is no engine on which asking here would
   * add a decision the user is not already being given.
   */
  const showExecutionPlan = useCallback((): void => {
    if (engine === undefined) {
      notify.warning('Connect this tab to a server before asking for a plan');
      return;
    }
    const statement = statementSql();
    if (statement.trim() === '') {
      notify.warning('No SQL to explain');
      return;
    }
    const request = planRequestFor(engine, statement);
    if (request.executes) {
      setPendingRun({ sql: request.sql, gate: 'actual-plan', planFor: statement });
      return;
    }
    runPlan(request.sql, statement);
  }, [engine, runPlan, statementSql]);

  const save = useCallback(
    (promptForPath: boolean): void => {
      void saveQueryToFile({
        tabId,
        sql: editor.current?.getValue() ?? '',
        promptForPath,
        rememberedPath: rememberedFilePath(
          tabStore.getState().tabs.find(candidate => candidate.id === tabId)?.metadata
        ),
      });
    },
    [tabId]
  );

  const openFile = useCallback((): void => {
    void openQueryFile().then(opened => {
      if (opened === null) return;
      editor.current?.setValue(opened.content);
      // The path, the store's copy of the text, and the clean baseline — see `adoptOpenedFile`. It runs
      // after the editor write because `markClean` reads the tab's content back.
      adoptOpenedFile({ tabId, path: opened.path, content: opened.content });
    });
  }, [tabId]);

  /**
   * Auto-execute, for a tab opened with SQL already in it (the explorer's "select top 1000", an FK link).
   *
   * The Angular version polled for the editor to be ready — `executeWhenEditorReady`, twenty attempts at
   * 50ms (`:2195-2218`) — because the effect that noticed the flag could fire before Monaco had loaded.
   * Here the effect runs after the editor's own mount effect has installed the handle, so there is nothing
   * to wait for: the flag is cleared and the run starts on the same commit. The clear happens FIRST, which
   * is what stops a re-render from running it twice.
   *
   * **Not gated by `confirmBeforeExecute`, deliberately.** The flag is only ever set by an explicit
   * action that already named the query — the explorer's "select top 1000", an FK link — so the tab
   * arriving with a result is what the user asked for. A confirmation here would ask "execute this?"
   * about SQL the user has not seen yet, in a tab that opened because they clicked something else.
   */
  useEffect(() => {
    if (tab?.autoExecute !== true || tab.type !== 'query') return;
    tabStore.getState().clearAutoExecute(tabId);
    const sql = tabStore.getState().getTabContent(tabId);
    if (sql.trim() === '') return;
    runNow(sql);
    // `runQuery` and `runContext` are stable for the tab's lifetime; the trigger is the flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.autoExecute, tabId]);

  /**
   * Prefetch the completions' metadata for THIS tab's target.
   *
   * Without this the provider is registered and answers with keywords and snippets only — which is what
   * the first e2e run showed, and it is the same call the Angular component made from `createEditor`
   * (`loadAutoCompleteObjects`, `:1493`). The target is passed explicitly rather than left to the
   * provider's active-tab default: this effect belongs to a tab that may not be the active one.
   *
   * Fire-and-forget: completions are optional, the service reports its own failures, and nothing here
   * should wait on up to 51 IPC round trips.
   */
  useEffect(() => {
    if (tab?.connectionId === undefined || tab.databaseName === undefined) return;
    void sqlIntellisense.loadMetadata({
      connectionId: tab.connectionId,
      database: tab.databaseName,
      // J-138: the same `engine` the tokenizer and the formatter are given above, so this tab's
      // prefetch caches under the engine the tab is actually connected to.
      engine: engine ?? null,
    });
  }, [tab?.connectionId, tab?.databaseName, engine]);

  /**
   * PLAN.md R5 finding 4: an inactive Dockview panel's DOM subtree is detached from the document, and the
   * Task 10 spike measured what that does to Monaco — an editor whose host was detached when it was
   * created comes up at Monaco's 5×5 minimum. `automaticLayout`'s ResizeObserver repairs it on re-attach,
   * but only on its own schedule, so the first frame after a tab switch can be a collapsed editor. This
   * makes the re-measure synchronous with the activation, and takes focus with it so the caret is where a
   * user who just clicked a tab expects to type.
   */
  useEffect(() => {
    const subscription = props.api.onDidActiveChange(({ isActive }) => {
      if (!isActive) return;
      editor.current?.layout();
      editor.current?.focus();
    });
    return () => subscription.dispose();
  }, [props.api]);

  /** Forget the tab's result when the panel goes away for good, so the store does not grow forever. */
  useEffect(
    () => () => {
      if (tabStore.getState().tabs.some(candidate => candidate.id === tabId)) return;
      queryExecutionStore.getState().forgetTab(tabId);
      // The plan is per-tab state in a second store, so it needs the same teardown or a closed tab's
      // plan tree stays in memory for the session.
      queryPlanStore.getState().forgetTab(tabId);
    },
    [tabId]
  );

  // Read once, for the editor's uncontrolled initial value. The tab store is the source of truth for the
  // text from then on; see `<SqlEditor>`'s header for why the editor is not a controlled component.
  const initialValue = useMemo(() => tabStore.getState().getTabContent(tabId), [tabId]);

  /**
   * The handlers the toolbar and the command table SHARE, named once.
   *
   * Both surfaces drive the same five actions, and writing the arrow twice would let them drift — a
   * toolbar Find that focused the editor and a ⌘F that did not is exactly the kind of difference nobody
   * notices until a user reports it. The toolbar additionally owns Go to Line (no menu item has it) and
   * the command table additionally owns save/open/comment/snippet.
   */
  const runEditorAction = useCallback(
    (actionId: Parameters<SqlEditorHandle['runAction']>[0]) => () =>
      editor.current?.runAction(actionId),
    []
  );
  const cancel = useCallback(() => void queryExecutionStore.getState().cancel(tabId), [tabId]);
  const toggleResults = useCallback(() => setResultsHidden(hidden => !hidden), []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" data-testid="query-panel">
      <QueryCommands
        isActive={() => tabStore.getState().activeTabId === tabId}
        onExecute={execute}
        onExecuteSelection={executeSelection}
        onCancel={cancel}
        onFormat={format}
        onFind={runEditorAction('actions.find')}
        onReplace={runEditorAction('editor.action.startFindReplaceAction')}
        onToggleComment={runEditorAction('editor.action.commentLine')}
        onSave={() => save(false)}
        onSaveAs={() => save(true)}
        onOpenFile={openFile}
        onToggleResults={toggleResults}
        onInsertSnippet={sql => editor.current?.insertSnippet(sql)}
        onConvertSql={convert}
        onShowExecutionPlan={showExecutionPlan}
      />

      <QueryToolbar
        tabId={tabId}
        executing={executing}
        resultsHidden={resultsHidden}
        connectionName={profile?.name ?? null}
        onExecute={execute}
        onCancel={cancel}
        onFormat={format}
        onFind={runEditorAction('actions.find')}
        onReplace={runEditorAction('editor.action.startFindReplaceAction')}
        onGoToLine={runEditorAction('editor.action.gotoLine')}
        onToggleResults={toggleResults}
        engine={engine}
        onConvertSql={convert}
        onShowExecutionPlan={showExecutionPlan}
      />

      <div ref={splitPane} className="flex min-h-0 grow flex-col">
        <div
          // The editor takes the whole pane when the results are hidden, which is the Angular
          // behaviour (`:378`). A custom property rather than an inline height, per `general.md`.
          style={
            {
              '--editor-height': `${resultsHidden ? 100 : editorHeightPercent}%`,
            } as CSSProperties
          }
          className="h-(--editor-height) min-h-0 shrink-0"
        >
          <SqlEditor
            handleRef={editor}
            data-testid="query-editor"
            defaultValue={initialValue}
            language={monacoLanguageFor(engine)}
            editorSettings={editorSettings}
            theme={theme}
            onChange={value => tabStore.getState().setTabContent(tabId, value)}
            onCursorPositionChange={position => {
              // Only the focused tab may move the status bar's readout. Two visible panels in a split
              // group would otherwise fight over it on every keystroke.
              if (tabStore.getState().activeTabId === tabId) {
                dispatchCommand('cursor-position', position);
              }
            }}
            onExecuteShortcut={executeWithGate}
            onExecute={execute}
          />
        </div>

        {resultsHidden ? null : (
          <>
            <ResizeHandle
              label="Editor height"
              testId="query-split-handle"
              orientation="horizontal"
              edge="leading"
              value={editorHeightPercent}
              min={EDITOR_HEIGHT_MIN_PERCENT}
              max={EDITOR_HEIGHT_MAX_PERCENT}
              step={SPLIT_STEP_PERCENT}
              // The value is a percentage of this pane, so a pixel of drag is worth `100 / height` of
              // it. Measured at drag start — see `unitsPerPixel`.
              unitsPerPixel={() => 100 / (splitPane.current?.clientHeight ?? 600)}
              onChange={percent => workbenchStore.getState().setEditorHeightPercent(percent)}
              onReset={() => workbenchStore.getState().resetEditorHeightPercent()}
            />
            <div className={cn('flex min-h-0 grow flex-col')}>
              {/* Three props, all of them stable across a panel re-render: `<QueryResults>` is
                  memoised and that is the R2 boundary — see its header. Nothing built in this render
                  body may be passed here. */}
              <QueryResults result={result} executing={executing} tabId={tabId} />
            </div>
          </>
        )}
      </div>

      <ConfirmExecuteDialog
        open={pendingRun !== null}
        // `?? 'ctrl-e'` is unreachable while the dialog is open — the prop above is exactly
        // `pendingRun !== null` — and it is a default rather than a non-null assertion so that a closed
        // dialog still type-checks without one.
        gate={pendingRun?.gate ?? 'ctrl-e'}
        // The plan gate shows what it is about to run, and what it shows is the user's STATEMENT rather
        // than the `SET STATISTICS PROFILE` wrapper around it: the wrapper is this app's diagnostic
        // scaffolding, and the thing being consented to is the statement inside it. The other two gates
        // do not render this at all (see `ConfirmExecuteDialog`'s header), so `sql` is what they would
        // have sent.
        sql={pendingRun?.planFor ?? pendingRun?.sql ?? ''}
        // Focus goes back to the editor either way — see `onReturnFocus`. It has to be Radix's
        // close-autofocus hook rather than a `focus()` inside these handlers: Radix moves focus AFTER
        // they run, so an earlier call is simply overridden.
        onReturnFocus={() => editor.current?.focus()}
        onCancel={() => setPendingRun(null)}
        onConfirm={remember => {
          const confirmed = pendingRun;
          setPendingRun(null);
          if (confirmed === null) return;
          if (remember) editorPrefsStore.getState().confirmCtrlEExecute();
          // A plan request carries the statement it is FOR, which is how one dialog serves both without
          // the plan path losing the label its Plan tab needs.
          if (confirmed.planFor !== undefined) {
            runPlan(confirmed.sql, confirmed.planFor);
            return;
          }
          runNow(confirmed.sql);
        }}
      />

      {runQuery.prompting.length === 0 ? null : (
        <PlaceholderDialog
          // Remounts per prompt, which is what resets the form to the remembered values rather than the
          // previous prompt's answers. See `PlaceholderDialog`'s state comment.
          key={runQuery.prompting.join('|')}
          placeholders={runQuery.prompting}
          // A second Execute while this is open is refused; the counter is what makes the refusal
          // visible instead of silent. See `useRunQuery`'s `promptAttention`.
          attention={runQuery.promptAttention}
          remembered={rememberedPlaceholders}
          onCancel={runQuery.cancelPlaceholders}
          onSubmit={runQuery.submitPlaceholders}
          onReturnFocus={() => editor.current?.focus()}
        />
      )}

      {/* Opens only when a conversion was refused because this host cannot run the converter — a
          setup problem with a guided fix, which used to be a toast saying "Python 3 is required"
          on machines that had Python 3 (J-29). */}
      <PythonSetupDialog
        deps={pythonSetup}
        rechecking={rechecking}
        onRecheck={recheckPython}
        onCopyCommand={copySetupCommand}
        onOpenLink={openSetupLink}
        onClose={() => setPythonSetup(null)}
        copiedCommand={copiedCommand}
      />
    </div>
  );
}
