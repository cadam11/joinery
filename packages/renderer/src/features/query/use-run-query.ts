/**
 * The execute sequence: what happens between the user asking for a run and a result being in the store.
 *
 * Ported from `query.component.ts:1779-1873`, minus the two halves that moved elsewhere — the IPC call
 * and the running/result bookkeeping are `state/query-execution.ts`, and the placeholder prompt is a
 * dialog. What is left here is the ORDER, which is the part worth having in one readable function:
 *
 *   1. read the SQL the caret and the setting select (`editor.textToExecute`);
 *   2. refuse an empty run, and refuse one with no connection — both with the original's wording;
 *   3. if the SQL carries `${placeholders}`, prompt, then substitute — and abandon the run if the
 *      prompt is cancelled;
 *   4. execute, which is where the store takes over;
 *   5. on success, rename the tab — through the AI namer when it is enabled, otherwise from the SQL,
 *      and only when the caller has not opted out (`RunContext.autoRename`).
 *
 * ── The prompt is a promise, and why ───────────────────────────────────────────────────────
 *
 * Step 3 has to suspend the sequence until a dialog resolves, which in the Angular version was a
 * `new Promise` around a hand-built modal (`:1663`). A React dialog is declarative, so the promise is
 * kept but its resolver is parked in a ref and called by the dialog's own callbacks. That is the one
 * place in this task where a ref holds control flow, and the alternative — splitting the sequence into
 * "before the prompt" and "after the prompt" state machines — was tried and is worse: the SQL, the
 * connection, the database and the tab title all have to survive the gap, and a machine that carries
 * them is the same promise with more parts.
 */

import { useCallback, useRef, useState } from 'react';
import type { AppSettings, QueryResult } from '@joinery/shared';

import { aiStore, selectAutoRenameEnabled } from '../../state/ai';
import { diagnostics, notify } from '../../state/diagnostics';
import { queryExecutionStore } from '../../state/query-execution';
import { queryHistoryStore } from '../../state/query-history';
import { generateQueryTitle, tabStore } from '../../state/tab';
import { detectPlaceholders, substitutePlaceholders } from './placeholders';
import { editorPrefsStore } from '../../state/editor-prefs';

/** What the panel knows and the sequence needs. Resolved fresh per run by the caller. */
export interface RunContext {
  readonly tabId: string;
  readonly tabTitle: string;
  readonly connectionId: string | undefined;
  readonly database: string | undefined;
  readonly querySettings: AppSettings['query'];
  /** The SQL to run, already resolved from the selection / caret / setting. */
  readonly sql: string;
  /**
   * Whether a successful run may rename the tab. Defaults to true, which is every ordinary Execute.
   *
   * `false` for Task 19b's plan request, and the reason is what the SQL is: the statement sent is
   * `EXPLAIN (FORMAT JSON) …` or `SET STATISTICS PROFILE ON; …`, so both namers would read the WRAPPER —
   * `generateQueryTitle` would title the tab from the word EXPLAIN, and the AI namer would spend a model
   * call summarising a diagnostic directive. Asking for a plan is not a statement about what the tab is.
   */
  readonly autoRename?: boolean;
}

export interface RunQuery {
  /**
   * Runs the sequence. Resolves with the result that landed, or `null` when there is none — an empty or
   * connectionless refusal, a cancelled placeholder prompt, or a superseded execute.
   *
   * The result is returned rather than only stored because Task 19b's plan request has to PARSE it, and
   * reading it back out of the store afterwards would be a second chance to pick up somebody else's:
   * `execute`'s own supersede rule means the store's current entry may already belong to a newer run.
   */
  readonly run: (context: RunContext) => Promise<QueryResult | null>;
  /** The placeholders currently being prompted for, or an empty array. Drives the dialog. */
  readonly prompting: readonly string[];
  /**
   * Bumped every time an execute is abandoned because this prompt was already open.
   *
   * The dialog re-focuses its first field when it changes, which is what makes the refusal
   * self-explaining: the user asked to run something, the answer is "answer this first", and the way to
   * say that in a UI is to put the caret in the thing that needs answering. Zero means "never
   * happened", so a dialog that has just opened does not steal focus from Radix's own initial focus.
   */
  readonly promptAttention: number;
  /** The dialog's submit. */
  readonly submitPlaceholders: (values: Readonly<Record<string, string>>) => void;
  /** The dialog's cancel — and the backdrop, and Escape. */
  readonly cancelPlaceholders: () => void;
}

export function useRunQuery(): RunQuery {
  const [prompting, setPrompting] = useState<readonly string[]>([]);
  const [promptAttention, setPromptAttention] = useState(0);
  /** The parked resolver for the placeholder prompt. `null` when no prompt is open. */
  const pending = useRef<((values: Record<string, string> | null) => void) | null>(null);

  const promptForPlaceholders = useCallback(
    (placeholders: readonly string[]): Promise<Record<string, string> | null> => {
      // A second prompt while one is open abandons the SECOND run rather than replacing the first
      // resolver — which would strand it and hang the first run forever with no visible cause.
      //
      // Reachable: the dialog traps focus, so the editor's ⌃E cannot fire behind it, but Query ▸ Execute
      // from the native menu is not a keystroke and arrives regardless. Reported rather than thrown,
      // because the caller is a `void run(…)` and a throw there is an unhandled rejection.
      //
      // And re-focused, not only logged. A refusal whose only trace is a line in the Output panel looks
      // to the user like the menu item did nothing; pulling the caret back to the field that is blocking
      // the run says why, in the place they are already looking. The `diagnostics.warn` stays, because
      // the abandoned run is still a thing a developer wants in the log.
      if (pending.current !== null) {
        diagnostics.warn('ignored an execute while a placeholder prompt was open', {
          placeholders,
        });
        setPromptAttention(count => count + 1);
        return Promise.resolve(null);
      }
      setPrompting(placeholders);
      return new Promise(resolve => {
        pending.current = resolve;
      });
    },
    []
  );

  const settlePrompt = useCallback((values: Record<string, string> | null): void => {
    const resolve = pending.current;
    pending.current = null;
    setPrompting([]);
    // Reset with the prompt, so the next one starts at "never happened" and does not fight Radix's own
    // initial focus with a stale count.
    setPromptAttention(0);
    resolve?.(values);
  }, []);

  const run = useCallback(
    async (context: RunContext): Promise<QueryResult | null> => {
      if (context.sql.trim() === '') {
        notify.warning('No query to execute');
        return null;
      }
      if (context.connectionId === undefined) {
        notify.error('No active connection');
        return null;
      }

      let sql = context.sql;
      const placeholders = detectPlaceholders(sql);
      if (placeholders.length > 0) {
        const values = await promptForPlaceholders(placeholders);
        if (values === null) return null; // Cancelled.
        editorPrefsStore.getState().rememberPlaceholderValues(values);
        sql = substitutePlaceholders(sql, values);
      }

      const result = await queryExecutionStore.getState().execute({
        tabId: context.tabId,
        tabTitle: context.tabTitle,
        connectionId: context.connectionId,
        database: context.database,
        sql,
        maxRows: context.querySettings.maxRowsToDisplay,
        timeout: context.querySettings.defaultTimeout,
      });

      // `null` means superseded or no bridge; a failed query is a result with `success: false`.
      if (result === null) return null;

      // The history list is main-process state that the execute has just appended to. Refreshed only
      // when something is showing it, exactly as `:1841-1843` did — the dialog is Task 19's, so today
      // this is a no-op unless that store has been loaded.
      if (queryHistoryStore.getState().entries.length > 0) {
        void queryHistoryStore.getState().loadHistory();
      }

      if (result.success && context.autoRename !== false) {
        renameTabFromResult(context.tabId, sql, context.database);
      }
      return result;
    },
    [promptForPlaceholders]
  );

  return {
    run,
    prompting,
    promptAttention,
    submitPlaceholders: useCallback(
      (values: Readonly<Record<string, string>>) => settlePrompt({ ...values }),
      [settlePrompt]
    ),
    cancelPlaceholders: useCallback(() => settlePrompt(null), [settlePrompt]),
  };
}

/**
 * Auto-rename after a successful run. Ported from `:1852-1860` and `:2652-2666`.
 *
 * The AI path is fire-and-forget and silent on failure, which is the original's behaviour and the right
 * one: a tab title is not worth a toast. The fallback is `generateQueryTitle`, which Task 4 already
 * ported out of `tab.state.ts` — the Angular query component carried its own near-duplicate
 * (`updateTabTitleFromSql`, `:2621-2649`) with the same three regexes and slightly different
 * truncation, and that duplicate dies here rather than being ported a second time.
 */
function renameTabFromResult(tabId: string, sql: string, database: string | undefined): void {
  const tabs = tabStore.getState();
  if (selectAutoRenameEnabled(aiStore.getState())) {
    void aiStore
      .getState()
      .generateTabName({ sql, database })
      .then(response => {
        if (response?.suggestedName) tabs.renameTab(tabId, response.suggestedName);
      });
    return;
  }
  // The index argument only matters when the SQL yields no name at all, in which case the original
  // produced a preview of the statement rather than "Query N" — so any index is unreachable here.
  tabs.renameTab(tabId, generateQueryTitle(sql, 1));
}
