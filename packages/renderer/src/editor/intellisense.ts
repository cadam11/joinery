/**
 * The app's single `SqlIntellisense` instance, and the wiring from its dependency seams to the real
 * stores and the real bridge.
 *
 * `sql-intellisense.ts` is a pure port with an explicit `IntellisenseDeps` — this file is the only
 * place that knows those deps come from Zustand and `window.joinery`, which is what keeps the 700-line
 * port unit-testable against three-line fakes.
 *
 * ── Why ONE instance, when the Angular version had one per query tab ────────────────────────
 *
 * Monaco completion providers are registered against a LANGUAGE, not against an editor: every editor
 * showing `sql` consults every provider registered for `sql`. The Angular renderer registered its
 * provider inside `createEditor` (`query.component.ts:1390`, `:1490`), so the fourth query tab meant
 * four providers and four copies of every suggestion in the widget. One module-level instance,
 * registered once by `<SqlEditor>`'s `installMonacoGlobals`, is the fix.
 *
 * That makes "which connection do I complete against?" a question with one answer instead of one per
 * editor, and the answer is **the active tab's** connection and database. That is correct rather than
 * merely convenient: a completion request can only come from the focused editor, and focusing a
 * Dockview panel activates its tab in `tabStore` (`workspace.tsx`'s `onDidActivePanelChange`), so the
 * active tab IS the editor being typed into. It is also strictly better than the Angular original,
 * which read `connectionState.focusedConnectionId()` — a value the sidebar could move without
 * touching the editor, so completions could quietly describe a different server than the tab.
 */

import { selectQueryAssistEnabled, selectHasConfiguredVendors, aiStore } from '../state/ai';
import { capabilitiesStore, selectCapabilitiesFor } from '../state/capabilities';
import { connectionStore, selectProfileFor } from '../state/connection';
import { selectActiveTab, tabStore } from '../state/tab';
import { ipc, isIpcAvailable } from '../ipc';
import { createSqlIntellisense, type IntellisenseTarget } from './sql-intellisense';

/**
 * The active tab's connection, database and engine, or nulls when there is no query tab focused.
 *
 * The engine comes from the connection PROFILE rather than the tab, which is where `query-panel.tsx`
 * already reads it from for the tokenizer and the formatter (`query-panel.tsx:75-76`). Reading it
 * the same way is the point: the completion provider, Monaco's tokenizer and `sql-formatter` now
 * cannot disagree about which dialect a tab is.
 */
export function activeTabTarget(): IntellisenseTarget {
  const tab = selectActiveTab(tabStore.getState());
  if (tab === null || tab.type !== 'query') {
    return { connectionId: null, database: null, engine: null };
  }
  const connectionId = tab.connectionId ?? null;
  return {
    connectionId,
    database: tab.databaseName ?? null,
    engine: selectProfileFor(connectionId)(connectionStore.getState())?.engine ?? null,
  };
}

export const sqlIntellisense = createSqlIntellisense({
  target: activeTabTarget,

  // The bridge, directly: these are one-shot reads whose results this module caches itself, so
  // TanStack Query would be a second cache with a different lifetime for the same data.
  getExplorerChildren: async (connectionId, database, parentPath) => {
    if (!isIpcAvailable()) return [];
    return ipc().explorer.getChildren(connectionId, database, parentPath);
  },
  getTableColumns: async (connectionId, database, schema, table) => {
    if (!isIpcAvailable()) return [];
    return ipc().explorer.getTableColumns(connectionId, database, schema, table);
  },

  supportsStoredProcedures: () => {
    const { connectionId } = activeTabTarget();
    return selectCapabilitiesFor(connectionId ?? undefined)(capabilitiesStore.getState())
      .supportsStoredProcedures;
  },

  // Both flags, as the original did (`sql-intellisense.service.ts:656`): a configured vendor AND the
  // query-assist feature switch. Neither alone is enough — a vendor with the feature off must not
  // spend tokens on every keystroke.
  ghostTextEnabled: () => {
    const state = aiStore.getState();
    return selectHasConfiguredVendors(state) && selectQueryAssistEnabled(state);
  },
  generateSql: request => aiStore.getState().generateSQL(request),
});
