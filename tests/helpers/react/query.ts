/**
 * The query tab: Monaco, the toolbar's Execute, the completion widget, and the execution plan.
 *
 * Monaco is a vendor surface, so it is located structurally — `.view-lines`,
 * `.suggest-widget`, `.mtk*` — which is the one exemption PLAN.md's test-hook
 * rule grants ("Vendor internals (`.monaco-editor`, `.ag-*`, Dockview's classes)
 * may be located structurally"). Everything Joinery owns around it has a
 * `query-*` testid.
 *
 * **No `:visible` filter anywhere in this module, and that is an assertion rather than an
 * omission.** PLAN.md Task 20 trap (b) expected the Angular suite's `.monaco-editor:visible` /
 * `.query-toolbar:visible` filters to be inherited, because Golden Layout kept every inactive tab's
 * Monaco mounted. Dockview does not: §6 "R5 RESOLVED" finding 4 measured exactly one
 * `.monaco-editor` in the document per visible group, and `query-editor.spec.ts` › `mounts one
 * Monaco per visible group` asserts that count directly. If Dockview ever starts keeping detached
 * panels mounted, that spec fails — which is the right place for the news to arrive, rather than a
 * filter here quietly making it invisible.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { CONNECT_TIMEOUT_MS, UI_TIMEOUT_MS } from './app';

/** The editor's host element. Monaco's own DOM hangs off it. */
export function queryEditor(window: Page): Locator {
  return window.getByTestId('query-editor');
}

/**
 * Opens a query tab and waits for Monaco to have painted a line.
 *
 * Tolerant of a tab already being open, because connecting can open one itself
 * (`sidebar.tsx`'s `openQueryForConnection`) — and the sidebar's New Query button
 * deliberately refuses to open a SECOND tab for a connection that already has one.
 *
 * The wait is on `.view-lines`, not on the panel: the panel is behind a lazy
 * boundary (`shell/workspace/query-panel-host.tsx`), so `query-panel` appearing
 * means the chunk loaded and Monaco is still mounting.
 */
export async function openQueryTab(window: Page): Promise<Locator> {
  if ((await window.getByTestId('query-panel').count()) === 0) {
    await window.getByTestId('sidebar-new-query').click();
  }
  await expect(window.getByTestId('query-panel')).toBeVisible({ timeout: UI_TIMEOUT_MS });
  const editor = queryEditor(window);
  await expect(editor.locator('.view-lines')).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return editor;
}

/**
 * Puts the caret in the visible editor and waits until Monaco actually holds DOM focus.
 *
 * Needed before any keystroke the EDITOR owns. `execute-query`'s ⌃E is declared
 * `accelerator: { source: 'editor' }` (`packages/renderer/src/commands/catalogue.ts`) and bound by
 * Monaco with `registerAccelerator: false`, so it only fires while Monaco's input sink has focus —
 * a press that lands on `document.body` is silently dropped. Anything that took focus away first
 * (a Radix dialog restores it asynchronously after its close animation, and under a full-tier load
 * that restore loses the race) leaves the next press on the floor.
 *
 * The wait is on `.monaco-editor.focused` rather than `toBeFocused()` on an input element, because
 * WHICH element Monaco focuses is a vendor detail that has already moved: this build focuses
 * `<div class="native-edit-context">`, not the historical `<textarea class="inputarea">`
 * (`helpers/react/a11y.ts`'s `MONACO_EXEMPTION` documents the same discovery). The `.focused` class
 * on the editor root is the marker Monaco maintains across both input paths.
 */
export async function focusEditor(window: Page): Promise<void> {
  const editor = queryEditor(window);
  await editor.locator('.view-lines').click();
  await expect(editor.locator('.monaco-editor.focused')).toHaveCount(1, { timeout: UI_TIMEOUT_MS });
}

/**
 * Types SQL into the editor, replacing whatever was there.
 *
 * `insertText` rather than `type`: Monaco's auto-indent and bracket completion
 * rewrite typed input, so a multi-line `type()` produces SQL that is not the SQL
 * the test asked for. `insertText` arrives as one input event, which Monaco
 * inserts verbatim.
 */
export async function typeSql(window: Page, sql: string): Promise<void> {
  const editor = await openQueryTab(window);
  await editor.locator('.view-lines').click();
  await window.keyboard.press('ControlOrMeta+a');
  await window.keyboard.insertText(sql);
  await expect(editor.locator('.view-lines')).toContainText(sql.split('\n')[0]?.trim() ?? '', {
    timeout: UI_TIMEOUT_MS,
  });
}

/**
 * What the editor is showing, with Monaco's rendering artefacts normalised.
 *
 * Monaco renders leading whitespace as `&nbsp;` and only renders the lines in
 * view, so this is "what the user can see", not "the document".
 */
export async function visibleSql(window: Page): Promise<string> {
  const lines = await queryEditor(window).locator('.view-line').allTextContents();
  return lines.map(line => line.replace(/\u00a0/g, ' ')).join('\n');
}

/**
 * Opens the suggest widget and returns its rows.
 *
 * `Control+Space` on every platform, because that is what Monaco binds
 * `editor.action.triggerSuggest` to on macOS as well. Triggering it explicitly
 * rather than relying on the provider's `' '` trigger character is deliberate:
 * `typeSql` uses `insertText`, which arrives as one input event and does not
 * necessarily run Monaco's per-character trigger logic.
 */
export async function suggestions(window: Page): Promise<Locator> {
  await window.keyboard.press('Control+Space');
  const widget = queryEditor(window).locator('.suggest-widget.visible');
  await expect(widget).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return widget.locator('.monaco-list-row');
}

/**
 * The suggest widget, **re-triggered until one of its rows matches `text`**.
 *
 * Monaco computes a completion list once per trigger and does not recompute it when a provider's
 * metadata arrives afterwards, so a widget opened before `sqlIntellisense.loadMetadata` has answered
 * shows keywords and snippets and stays that way. `suggestions()` alone therefore races the prefetch —
 * it passed reliably in isolation and failed roughly one run in three inside the full tier, where the
 * container is under load from the specs before it.
 *
 * Bounded on purpose (`ATTEMPTS`): the widget is closed and re-opened up to that many times, and the
 * final `expect` is what reports the failure if the metadata never arrives, rather than the loop
 * exhausting silently.
 */
export async function suggestionsContaining(window: Page, text: string): Promise<Locator> {
  const ATTEMPTS = 5;
  let rows = await suggestions(window);

  for (let attempt = 1; attempt < ATTEMPTS; attempt += 1) {
    if ((await rows.filter({ hasText: text }).count()) > 0) return rows;
    await window.keyboard.press('Escape');
    await expect(queryEditor(window).locator('.suggest-widget.visible')).toBeHidden({
      timeout: UI_TIMEOUT_MS,
    });
    rows = await suggestions(window);
  }

  await expect(rows.filter({ hasText: text })).not.toHaveCount(0, { timeout: UI_TIMEOUT_MS });
  return rows;
}

/**
 * Runs the query from the toolbar and waits for the run to finish.
 *
 * "Finished" is the executing indicator being gone from the status bar, which is
 * the store's `running` map emptying — the same source of truth the toolbar's
 * disabled state reads.
 */
export async function executeQuery(window: Page): Promise<void> {
  await window.getByTestId('query-execute').click();
  await expect(window.getByTestId('status-executing')).toBeHidden({ timeout: CONNECT_TIMEOUT_MS });
}

/** The plan tab in the results pane. Only present once a plan has been asked for. */
export function planTab(window: Page): Locator {
  return window.getByTestId('query-results-tab-plan');
}

/** The plan tree. */
export function executionPlan(window: Page): Locator {
  return window.getByTestId('execution-plan');
}

/** One row per operator, root first. */
export function planNodes(window: Page): Locator {
  return window.getByTestId('plan-node');
}

/**
 * Press the toolbar's plan button and wait for the tree.
 *
 * PostgreSQL and MySQL answer with an EXPLAIN and never run the statement, so there is no gate to
 * clear here. SQL Server does run it and raises the `actual-plan` confirmation — a spec that wants
 * that path presses the button itself and confirms.
 */
export async function showExecutionPlan(window: Page): Promise<Locator> {
  await window.getByTestId('query-execution-plan').click();
  await expect(planTab(window)).toBeVisible({ timeout: CONNECT_TIMEOUT_MS });
  await expect(executionPlan(window)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return executionPlan(window);
}

/** The operator names in the plan, in the order they are drawn. */
export async function planNodeTypes(window: Page): Promise<string[]> {
  return planNodes(window).locator('[data-testid="plan-node-type"]').allTextContents();
}

/**
 * Select the Analysis tab and return the results pane.
 *
 * The PANE rather than `ai-analysis`, because that testid belongs to the asking surface and the three
 * degrades (no provider, AI switched off, nothing run) replace it entirely — a helper that waited for it
 * would only work on a machine with an API key.
 */
export async function openAnalysisTab(window: Page): Promise<Locator> {
  await window.getByTestId('query-results-tab-analysis').click();
  const pane = window.getByTestId('query-results');
  await expect(pane).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return pane;
}
