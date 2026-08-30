/**
 * The tab workspace: what is open, what is focused, what is dirty, and the persistence of all
 * three. Tabs are the navigation model — PLAN.md 0.1 established that the Angular router never
 * had an outlet, so this store is the whole of "where am I" in the app.
 *
 * Ported from `packages/renderer/src/app/core/state/tab.state.ts`. Conventions: `capabilities.ts`.
 *
 * Two pieces of state are deliberately NOT in the store, carried over from the Angular original
 * (`tab.state.ts:60-73`), and they are the reason this file has closure variables at all:
 *
 * - **`contentMap`** — live editor text per tab. Monaco fires per keystroke, and putting the text
 *   in the store would rebuild the tabs array per character and re-render every `tabs` subscriber
 *   with it. The store's `content` field holds the initial/persisted value only; live text goes
 *   through `getTabContent` / `setTabContent`, which no component subscribes to.
 * - **`cleanContentMap`** — the per-tab baseline that `isDirty` is measured against. Only the
 *   resulting boolean reaches the store, so a keystroke that does not flip dirtiness costs zero
 *   re-renders.
 *
 * `saveTimeout` is the third: a debounce handle is a resource, not state, and nothing renders it.
 */

import { create } from 'zustand';
import type { TabState as PersistedTab } from '@joinery/shared';
import { ipc, isIpcAvailable } from '../ipc';
// The leaf persistence module, never the `persistence/` barrel — see the note in that barrel.
import {
  rendererStatePersistence,
  type RendererStatePersistence,
} from '../persistence/renderer-state';
import { diagnostics } from './diagnostics';

export type TabType = 'query' | 'results' | 'object' | 'welcome' | 'erd' | 'chat';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  icon: string;
  connectionId?: string;
  databaseName?: string;
  content?: string; // For query tabs, the SQL content
  isDirty?: boolean;
  isPinned?: boolean;
  autoExecute?: boolean; // For query tabs, execute immediately when opened
  metadata?: Record<string, unknown>;
}

const MAX_QUERY_TABS = 20;
const SAVE_DEBOUNCE_MS = 500;

const WELCOME_TAB: Tab = { id: 'welcome', type: 'welcome', title: 'Welcome', icon: 'home' };

/** Tab types that hold a database "in use" and therefore block drop/restore until closed. */
const DATABASE_BOUND_TYPES: readonly TabType[] = ['query', 'object', 'erd'];

const OBJECT_TYPE_ICONS: Record<string, string> = {
  table: 'table_chart',
  view: 'view_list',
  procedure: 'functions',
  function: 'calculate',
  index: 'format_list_numbered',
  trigger: 'bolt',
  constraint: 'link',
};

function iconForObjectType(objectType: string): string {
  return OBJECT_TYPE_ICONS[objectType.toLowerCase()] ?? 'description';
}

/**
 * Generate a smart tab title from SQL content: a preview of the statement (e.g. the table a
 * SELECT reads) or "Query N". Pure; lifted out of the store because it needs no state.
 */
export function generateQueryTitle(sql: string | undefined, index: number): string {
  if (!sql || !sql.trim()) {
    return `Query ${index}`;
  }

  const cleaned = sql.replace(/\s+/g, ' ').trim();

  const selectMatch = cleaned.match(/^SELECT\b.*?\bFROM\s+(?:\[?(\w+)\]?\.)?\[?(\w+)\]?/i);
  const selectTable = selectMatch?.[2];
  if (selectTable) {
    return selectTable.length > 20 ? `${selectTable.substring(0, 18)}…` : selectTable;
  }

  const execMatch = cleaned.match(/^EXEC(?:UTE)?\s+(?:\[?(\w+)\]?\.)?\[?(\w+)\]?/i);
  const execProc = execMatch?.[2];
  if (execProc) {
    return `Exec ${execProc.length > 16 ? `${execProc.substring(0, 14)}…` : execProc}`;
  }

  const preview = cleaned.substring(0, 22);
  return preview.length < cleaned.length ? `${preview}…` : preview;
}

/** The subset of a saved Dockview component state a tab can be rebuilt from. */
export interface LayoutTabState {
  tabId: string;
  tabType: string;
  title: string;
  icon: string;
  isPinned: boolean;
  connectionId?: string;
  databaseName?: string;
  /**
   * Optional, because this arrives from rehydrated layout JSON. The Angular source guarded it with
   * `state.configuration?.['content']` even though its own type said otherwise
   * (`tab.state.ts:686-688`); the type now says what the guard already knew, so a panel persisted
   * without a configuration block yields `undefined` rather than throwing.
   */
  configuration?: Record<string, unknown>;
}

export interface TabStoreState {
  readonly tabs: readonly Tab[];
  readonly activeTabId: string;

  readonly openTab: (tab: Omit<Tab, 'id'>) => string;
  readonly closeTab: (tabId: string) => void;
  readonly activateTab: (tabId: string) => void;
  readonly updateTab: (tabId: string, updates: Partial<Tab>) => void;

  readonly markDirty: (tabId: string) => void;
  readonly markClean: (tabId: string) => void;
  readonly setTabDirty: (tabId: string, isDirty: boolean) => void;
  readonly setCleanBaseline: (tabId: string, content: string) => void;
  readonly getCleanBaseline: (tabId: string) => string;

  /** Records live editor text. Returns true only when the dirty flag actually flipped. */
  readonly setTabContent: (tabId: string, content: string) => boolean;
  readonly getTabContent: (tabId: string) => string;

  readonly togglePin: (tabId: string) => void;
  readonly pinTab: (tabId: string) => void;
  readonly unpinTab: (tabId: string) => void;
  readonly renameTab: (tabId: string, newTitle: string) => void;

  readonly openQueryTab: (
    connectionId: string,
    databaseName: string,
    initialSql?: string,
    autoExecute?: boolean,
    reuseEmpty?: boolean
  ) => string;
  readonly clearAutoExecute: (tabId: string) => void;
  readonly openObjectTab: (
    connectionId: string,
    databaseName: string,
    objectName: string,
    objectType: string,
    schema?: string
  ) => string;
  readonly openErdTab: (
    connectionId: string,
    databaseName: string,
    tableName?: string,
    schema?: string
  ) => string;
  /**
   * Opens a chat tab, optionally carrying the connection it was opened from (J-59) so the model
   * gets database context on the surface built for a long conversation.
   */
  readonly openChatTab: (
    conversationId?: string,
    target?: { readonly connectionId?: string; readonly databaseName?: string }
  ) => string;
  readonly showWelcome: () => void;

  readonly closeTabsForDatabase: (connectionId: string, databaseName: string) => void;
  readonly closeAllTabs: () => void;
  readonly closeOtherTabs: (tabId: string) => void;
  readonly closeTabsToRight: (tabId: string) => void;
  readonly duplicateTab: (tabId: string) => string | null;
  readonly nextTab: () => void;
  readonly previousTab: () => void;

  /**
   * Persists the query tabs. **Does nothing until `unlockPersistence` has been called** — see
   * that action, and the `writesUnlocked` closure in `createTabStore`.
   */
  readonly saveTabs: () => Promise<void>;
  readonly restoreTabs: (connectionId: string) => Promise<void>;

  /**
   * Opens the `saveTabs` write path. Called exactly once, by `persistence/hydrate.ts`'s
   * `hydrateWorkspace`, as its last statement — after the restore has finished.
   *
   * This is the restore-before-save contract, and it is a gate rather than a convention because
   * the failure it prevents is silent and total. `saveTabs` serializes the SQL of every query
   * tab; if anything writes before the restore has put the saved tabs back, it writes the tabs
   * it can see — usually none — over the user's saved work, and there is no second copy. The
   * Angular renderer had exactly this shape and only avoided the bug by ordering
   * (`app.component.ts:116-124`), which is to say by nobody having written a store action that
   * saves during startup yet.
   *
   * Idempotent, and there is deliberately no `lockPersistence`: a gate that can be closed again
   * is a gate someone can close at the wrong moment.
   */
  readonly unlockPersistence: () => void;
  /** Whether the write path is open. For tests and for the boot-sequence assertion. */
  readonly isPersistenceUnlocked: () => boolean;
  readonly syncTabsFromLayout: (layoutTabStates: readonly LayoutTabState[]) => void;

  /**
   * Adopts the persisted welcome-dismissed flag. Called once from `persistence/hydrate.ts`, which
   * is where that flag now comes from — Task 4 read `joinery:welcomeDismissed` at construction, and
   * Task 5 moved it into main-process `AppState` with the other five keys.
   *
   * Adds the Welcome tab when the flag is false, rather than removing it when true, because a store
   * cannot be constructed from async state: the workspace starts empty and gains Welcome a tick
   * later. The other order would show a returning user the Welcome tab and then snatch it away.
   * Idempotent — it never adds a second Welcome tab.
   */
  readonly hydrateWelcome: (dismissed: boolean) => void;
}

export type TabStore = ReturnType<typeof createTabStore>;

export function createTabStore(persistence: RendererStatePersistence = rendererStatePersistence) {
  // See the module comment: these three are per-store resources, not rendered state.
  const contentMap = new Map<string, string>();
  const cleanContentMap = new Map<string, string>();
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * The restore-before-save gate. See `TabStoreState.unlockPersistence` for the data loss it
   * exists to close. A closure variable rather than store state, for the same reason the
   * settings store's `writesUnlocked` is one: nothing renders it, and no component may flip it.
   */
  let writesUnlocked = false;

  /**
   * Fire-and-forget: closing the Welcome tab must not wait on IPC, and `update()` serializes and
   * reports its own failures. `void` so the floating promise is visible rather than accidental.
   */
  const persistWelcomeDismissed = (dismissed: boolean): void => {
    void persistence.update(current =>
      current.welcomeDismissed === dismissed
        ? undefined
        : { ...current, welcomeDismissed: dismissed }
    );
  };

  return create<TabStoreState>()((set, get) => {
    const scheduleSave = (): void => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        saveTimeout = null;
        void get().saveTabs();
      }, SAVE_DEBOUNCE_MS);
    };

    const findTab = (tabId: string): Tab | undefined => get().tabs.find(t => t.id === tabId);

    const forgetTabContent = (tabId: string): void => {
      cleanContentMap.delete(tabId);
      contentMap.delete(tabId);
    };

    return {
      // Empty, not `[WELCOME_TAB]`: whether Welcome belongs here is persisted state, and persisted
      // state arrives over IPC. `hydrateWelcome` settles it. See its doc comment.
      tabs: [],
      activeTabId: '',

      openTab: tab => {
        const id = `tab-${crypto.randomUUID()}`;
        const newTab: Tab = { ...tab, id };
        if (typeof tab.content === 'string') {
          contentMap.set(id, tab.content);
        }
        set(state => ({ tabs: [...state.tabs, newTab], activeTabId: id }));
        void get().saveTabs();
        return id;
      },

      closeTab: tabId => {
        const tabs = get().tabs;
        const index = tabs.findIndex(t => t.id === tabId);
        if (index === -1) return;

        if (tabs[index]?.type === 'welcome') {
          persistWelcomeDismissed(true);
        }
        forgetTabContent(tabId);

        const remaining = tabs.filter(t => t.id !== tabId);
        // Prefer the tab that slid into the closed tab's slot, else the last one.
        const nextActiveId =
          get().activeTabId === tabId
            ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? '')
            : get().activeTabId;

        set({ tabs: remaining, activeTabId: nextActiveId });
        void get().saveTabs();
      },

      activateTab: tabId => {
        if (findTab(tabId)) set({ activeTabId: tabId });
      },

      updateTab: (tabId, updates) => {
        set(state => ({
          tabs: state.tabs.map(t => (t.id === tabId ? { ...t, ...updates } : t)),
        }));
        if (updates.content !== undefined) scheduleSave();
      },

      markDirty: tabId => get().updateTab(tabId, { isDirty: true }),

      markClean: tabId => {
        if (findTab(tabId)) {
          cleanContentMap.set(tabId, get().getTabContent(tabId));
        }
        get().updateTab(tabId, { isDirty: false });
      },

      setTabDirty: (tabId, isDirty) => get().updateTab(tabId, { isDirty }),

      setCleanBaseline: (tabId, content) => {
        cleanContentMap.set(tabId, content);
      },

      getCleanBaseline: tabId => cleanContentMap.get(tabId) ?? '',

      setTabContent: (tabId, content) => {
        contentMap.set(tabId, content);
        scheduleSave();

        const isDirty = content !== (cleanContentMap.get(tabId) ?? '');
        const tab = findTab(tabId);
        if (!tab || tab.isDirty === isDirty) return false;
        get().updateTab(tabId, { isDirty });
        return true;
      },

      getTabContent: tabId => {
        const live = contentMap.get(tabId);
        if (live !== undefined) return live;
        return findTab(tabId)?.content ?? '';
      },

      togglePin: tabId => {
        const tab = findTab(tabId);
        if (!tab) return;
        get().updateTab(tabId, { isPinned: !tab.isPinned });
        void get().saveTabs();
      },

      pinTab: tabId => {
        get().updateTab(tabId, { isPinned: true });
        void get().saveTabs();
      },

      unpinTab: tabId => {
        get().updateTab(tabId, { isPinned: false });
        void get().saveTabs();
      },

      renameTab: (tabId, newTitle) => {
        if (!findTab(tabId) || !newTitle.trim()) return;
        get().updateTab(tabId, { title: newTitle.trim() });
        void get().saveTabs();
      },

      openQueryTab: (
        connectionId,
        databaseName,
        initialSql,
        autoExecute = false,
        reuseEmpty = true
      ) => {
        const queryTabs = get().tabs.filter(t => t.type === 'query');

        // Reuse the active tab when it is an empty, clean query tab — the explorer
        // double-click flow wants to "land in" the active tab. ⌘N opts out with
        // reuseEmpty=false so the user always gets a fresh one.
        if (!initialSql && reuseEmpty) {
          const activeTab = selectActiveTab(get());
          if (
            activeTab &&
            activeTab.type === 'query' &&
            !activeTab.isDirty &&
            get().getTabContent(activeTab.id).trim() === ''
          ) {
            get().updateTab(activeTab.id, { connectionId, databaseName });
            return activeTab.id;
          }
        }

        // Enforce the cap by closing the oldest closeable query tab.
        if (queryTabs.length >= MAX_QUERY_TABS) {
          const closeable = queryTabs.find(t => !t.isDirty && !t.isPinned);
          if (closeable) get().closeTab(closeable.id);
        }

        const content = initialSql ?? '';
        const tabId = get().openTab({
          type: 'query',
          title: generateQueryTitle(initialSql, queryTabs.length + 1),
          icon: 'code',
          connectionId,
          databaseName,
          content,
          isDirty: false,
          autoExecute,
        });

        // Baseline so dirty state is measured against the initial content.
        cleanContentMap.set(tabId, content);
        return tabId;
      },

      clearAutoExecute: tabId => get().updateTab(tabId, { autoExecute: false }),

      openObjectTab: (connectionId, databaseName, objectName, objectType, schema = 'dbo') => {
        const existing = get().tabs.find(
          t =>
            t.type === 'object' &&
            t.connectionId === connectionId &&
            t.databaseName === databaseName &&
            t.metadata?.['objectName'] === objectName
        );
        if (existing) {
          set({ activeTabId: existing.id });
          return existing.id;
        }

        return get().openTab({
          type: 'object',
          title: objectName,
          icon: iconForObjectType(objectType),
          connectionId,
          databaseName,
          metadata: { objectName, objectType, schema },
        });
      },

      openErdTab: (connectionId, databaseName, tableName, schema) => {
        const existing = get().tabs.find(
          t =>
            t.type === 'erd' &&
            t.connectionId === connectionId &&
            t.databaseName === databaseName &&
            t.metadata?.['tableName'] === tableName
        );
        if (existing) {
          set({ activeTabId: existing.id });
          return existing.id;
        }

        return get().openTab({
          type: 'erd',
          title: tableName ? `ERD: ${tableName}` : `ERD: ${databaseName}`,
          icon: 'account_tree',
          connectionId,
          databaseName,
          metadata: {
            tableName,
            schema: schema ?? 'dbo',
            // Two levels of relationships when focused on one table.
            focusDepth: tableName ? 2 : undefined,
          },
        });
      },

      // Each chat tab is an independent instance, so this never focuses an existing one.
      //
      // `target` is the connection the tab was opened FROM, stored the way every other tab type
      // stores it (J-59). Without it a chat tab had no database context at all: focus derived from
      // the active query tab, and with a chat tab in front there is none — so the surface meant for
      // the longer conversation was the one that could not see the database.
      openChatTab: (conversationId, target) =>
        get().openTab({
          type: 'chat',
          title: 'AI Chat',
          icon: 'smart_toy',
          ...(target?.connectionId === undefined ? {} : { connectionId: target.connectionId }),
          ...(target?.databaseName === undefined ? {} : { databaseName: target.databaseName }),
          metadata: conversationId ? { conversationId } : undefined,
        }),

      showWelcome: () => {
        const existing = get().tabs.find(t => t.type === 'welcome');
        if (existing) {
          set({ activeTabId: existing.id });
          return;
        }
        persistWelcomeDismissed(false);
        set(state => ({ tabs: [WELCOME_TAB, ...state.tabs], activeTabId: WELCOME_TAB.id }));
      },

      hydrateWelcome: dismissed => {
        if (dismissed || get().tabs.some(t => t.type === 'welcome')) return;
        set(state => ({
          tabs: [WELCOME_TAB, ...state.tabs],
          // Only take focus if nothing has it. Hydration races nothing today, but a tab opened by
          // a deep link or a restored session must not lose focus to the Welcome tab.
          activeTabId: state.activeTabId === '' ? WELCOME_TAB.id : state.activeTabId,
        }));
      },

      closeTabsForDatabase: (connectionId, databaseName) => {
        for (const tab of selectTabsUsingDatabase(connectionId, databaseName)(get())) {
          get().closeTab(tab.id);
        }
      },

      closeAllTabs: () => {
        for (const tab of get().tabs) forgetTabContent(tab.id);
        set({ tabs: [], activeTabId: '' });
        void get().saveTabs();
      },

      closeOtherTabs: tabId => {
        const tab = findTab(tabId);
        if (!tab) return;
        for (const other of get().tabs) {
          if (other.id !== tabId) forgetTabContent(other.id);
        }
        set({ tabs: [tab], activeTabId: tabId });
        void get().saveTabs();
      },

      closeTabsToRight: tabId => {
        const tabs = get().tabs;
        const index = tabs.findIndex(t => t.id === tabId);
        if (index === -1) return;
        for (const removed of tabs.slice(index + 1)) forgetTabContent(removed.id);

        const kept = tabs.slice(0, index + 1);
        const activeSurvived = kept.some(t => t.id === get().activeTabId);
        set({ tabs: kept, activeTabId: activeSurvived ? get().activeTabId : tabId });
        void get().saveTabs();
      },

      duplicateTab: tabId => {
        const tab = findTab(tabId);
        if (!tab || tab.type !== 'query') return null;
        return get().openTab({
          type: tab.type,
          title: `${tab.title} (copy)`,
          icon: tab.icon,
          connectionId: tab.connectionId,
          databaseName: tab.databaseName,
          content: get().getTabContent(tabId),
          isDirty: tab.isDirty,
          metadata: tab.metadata ? { ...tab.metadata } : undefined,
        });
      },

      nextTab: () => {
        const tabs = get().tabs;
        if (tabs.length <= 1) return;
        const current = tabs.findIndex(t => t.id === get().activeTabId);
        const next = tabs[(current + 1) % tabs.length];
        if (next) set({ activeTabId: next.id });
      },

      previousTab: () => {
        const tabs = get().tabs;
        if (tabs.length <= 1) return;
        const current = tabs.findIndex(t => t.id === get().activeTabId);
        const previous = tabs[(current - 1 + tabs.length) % tabs.length];
        if (previous) set({ activeTabId: previous.id });
      },

      unlockPersistence: () => {
        writesUnlocked = true;
      },

      isPersistenceUnlocked: () => writesUnlocked,

      saveTabs: async () => {
        // The gate. Silent on purpose: every startup action that opens the Welcome tab or
        // activates a restored one calls through here, so warning would fire several times on
        // every launch and say nothing a reader could act on. The one thing worth knowing —
        // whether the gate is still shut — is `isPersistenceUnlocked()`.
        if (!writesUnlocked) return;
        if (!isIpcAvailable()) return;
        try {
          // Query tabs only — results / object / welcome tabs are not worth restoring.
          const persistable: PersistedTab[] = get()
            .tabs.filter(t => t.type === 'query')
            .map(t => ({
              id: t.id,
              type: t.type,
              title: t.title,
              content: get().getTabContent(t.id),
              connectionId: t.connectionId,
              databaseName: t.databaseName,
              isDirty: t.isDirty,
              isPinned: t.isPinned,
            }));
          await ipc().app.saveTabs(persistable, get().activeTabId);
        } catch (error) {
          diagnostics.error('failed to save tabs', error);
        }
      },

      /**
       * Puts the saved tabs back. **Merges — it does not replace.**
       *
       * The window is interactive before this runs (`shell/boot.ts` step 4: the session reconnect is
       * awaited first and a dead saved server holds it for a whole connect timeout), so by the time
       * the saved tabs arrive the user may already have opened a tab and typed a query into it.
       * Replacing the list — which is what this did, keeping only the Welcome tab — vaporized that
       * work, and it vaporized it silently: `contentMap` still held the text, but with no tab
       * referencing it nothing could ever show or save it again.
       *
       * So a live tab wins over a restored one with the same id, live tabs keep their positions, and
       * the restored ones are appended. The saved `activeTabId` is honoured only while the user has
       * opened nothing of their own — otherwise the restore would yank focus out of the editor they
       * are typing in, which is the same loss in a milder form.
       */
      restoreTabs: async connectionId => {
        if (!isIpcAvailable()) return;
        try {
          const { tabs: savedTabs, activeTabId } = await ipc().app.getTabs();
          if (savedTabs.length === 0) return;

          const live = get().tabs;
          const liveIds = new Set(live.map(t => t.id));

          const restored: Tab[] = [];
          for (const t of savedTabs) {
            const id = t.id || `tab-${crypto.randomUUID()}`;
            // The live tab is the one the user can see and has touched; the saved copy is by
            // definition older. Skipped before the content maps are written, so the restore cannot
            // overwrite live editor text either.
            if (liveIds.has(id)) continue;

            if (t.type === 'query') {
              // Baseline AND live content, so a restored tab starts clean.
              cleanContentMap.set(id, t.content ?? '');
              contentMap.set(id, t.content ?? '');
            }
            restored.push({
              id,
              type: t.type as TabType,
              title: t.title,
              icon: t.type === 'query' ? 'code' : 'description',
              connectionId: t.connectionId ?? connectionId,
              databaseName: t.databaseName,
              content: t.content,
              isDirty: false,
              isPinned: t.isPinned,
            });
          }

          const tabs = [...live, ...restored];
          // "The user has done nothing yet" is: every live tab is the Welcome tab this store adds
          // itself. Anything else means they opened it during the restore window.
          const userOpenedSomething = live.some(t => t.type !== 'welcome');
          const nextActive =
            !userOpenedSomething && activeTabId && tabs.some(t => t.id === activeTabId)
              ? activeTabId
              : get().activeTabId;
          set({ tabs, activeTabId: nextActive });
        } catch (error) {
          diagnostics.error('failed to restore tabs', error);
        }
      },

      /**
       * Reconcile the store with the tabs a persisted layout references, so the workspace never
       * mounts a panel this store has never heard of. Task 7 owns the `LayoutConfig` round-trip
       * (PLAN.md Decision C) and is this function's only consumer.
       */
      syncTabsFromLayout: layoutTabStates => {
        const current = get().tabs;
        const toAdd: Tab[] = [];

        for (const state of layoutTabStates) {
          if (current.some(t => t.id === state.tabId)) {
            // Take isPinned and title from the layout; it owns tab-header state.
            get().updateTab(state.tabId, { isPinned: state.isPinned, title: state.title });
            continue;
          }
          const content = state.configuration?.['content'];
          const autoExecute = state.configuration?.['autoExecute'];
          const newTab: Tab = {
            id: state.tabId,
            type: state.tabType as TabType,
            title: state.title,
            icon: state.icon,
            connectionId: state.connectionId,
            databaseName: state.databaseName,
            isPinned: state.isPinned,
            content: typeof content === 'string' ? content : undefined,
            autoExecute: typeof autoExecute === 'boolean' ? autoExecute : undefined,
            metadata: { ...state.configuration },
          };
          if (typeof newTab.content === 'string') {
            contentMap.set(newTab.id, newTab.content);
          }
          toAdd.push(newTab);
        }

        if (toAdd.length > 0) {
          set(prev => ({ tabs: [...prev.tabs, ...toAdd] }));
        }
      },
    };
  });
}

export const tabStore = createTabStore();
export const useTabStore = tabStore;

/**
 * The two fields every tab selector actually reads. Narrower than `TabStoreState` on purpose:
 * the connection store derives focus from a projection of this store, and a selector that
 * demanded the full state (actions included) could not be handed one.
 */
export interface TabsSlice {
  readonly tabs: readonly Tab[];
  readonly activeTabId: string;
}

/**
 * The database the most recent query tab on `connectionId` was looking at, if any.
 *
 * For the chat tab the command palette opens (J-59): it has no surface to inherit context from, so
 * it takes the connection a user-driven action would target and the database that connection was
 * last used with. Tab order is creation order, so the last match is the most recent.
 */
export function selectLastDatabaseFor(state: TabsSlice, connectionId: string): string | undefined {
  for (let index = state.tabs.length - 1; index >= 0; index -= 1) {
    const tab = state.tabs[index];
    if (tab?.type === 'query' && tab.connectionId === connectionId && tab.databaseName) {
      return tab.databaseName;
    }
  }
  return undefined;
}

export function selectActiveTab(state: TabsSlice): Tab | null {
  return state.tabs.find(t => t.id === state.activeTabId) ?? null;
}

export function selectHasTabs(state: Pick<TabsSlice, 'tabs'>): boolean {
  return state.tabs.length > 0;
}

export function selectTabCount(state: Pick<TabsSlice, 'tabs'>): number {
  return state.tabs.length;
}

/** Fresh array — subscribe with `useShallow`. */
export function selectDirtyTabs(state: Pick<TabsSlice, 'tabs'>): readonly Tab[] {
  return state.tabs.filter(t => t.isDirty);
}

/** Fresh array — subscribe with `useShallow`. */
export function selectTabsUsingDatabase(connectionId: string, databaseName: string) {
  return (state: Pick<TabsSlice, 'tabs'>): readonly Tab[] =>
    state.tabs.filter(
      t =>
        DATABASE_BOUND_TYPES.includes(t.type) &&
        t.connectionId === connectionId &&
        t.databaseName === databaseName
    );
}
