/**
 * An in-memory stand-in for the main process's `AppStateStore`, for the persistence specs.
 *
 * It is deliberately a copy of main's semantics rather than a convenient fake, because the
 * properties Task 5 has to prove are properties of *those* semantics:
 *
 * - `setState` is a SHALLOW spread (`packages/main/src/services/config/app-state.ts:66-69`), so a
 *   nested write replaces its whole sub-object. That is the sibling-clobbering hazard the single
 *   read-modify-write writer exists to prevent, and a fake with a deep merge would hide it.
 * - `getState` returns a structured clone (`:59-61`), so a caller cannot mutate persisted state by
 *   holding onto what it read.
 * - `saveTabs` / `getTabs` / `saveLayout` / `getLayout` go through the same object, so a layout
 *   write and a settings write can be shown not to disturb each other.
 *
 * `calls` counts what crossed the boundary, which is how "the migration did not run twice" is
 * asserted without reaching into the module under test.
 */

import type { LayoutConfig, TabState } from '@joinery/shared';
import type { AppStateWithReactRenderer } from '../persistence/renderer-state';

export interface AppStateDouble {
  /** The `app` namespace to hand to `installJoineryMock`. */
  readonly app: {
    getState: () => Promise<AppStateWithReactRenderer>;
    setState: (partial: AppStateWithReactRenderer) => Promise<void>;
    saveTabs: (tabs: TabState[], activeTabId: string | null) => Promise<void>;
    getTabs: () => Promise<{ tabs: TabState[]; activeTabId: string | null }>;
    saveLayout: (config: LayoutConfig | undefined) => Promise<void>;
    getLayout: () => Promise<LayoutConfig | undefined>;
  };
  /** The persisted state as it stands, cloned. */
  snapshot(): AppStateWithReactRenderer;
  /** How many times each operation was invoked. */
  readonly calls: {
    getState: number;
    setState: number;
    saveTabs: number;
    getTabs: number;
    saveLayout: number;
    getLayout: number;
  };
  /** Simulates a quit: nothing but the persisted object survives into the next "boot". */
  reboot(): AppStateDouble;
}

const EMPTY_STATE: AppStateWithReactRenderer = {
  lastConnectedProfileIds: [],
  lastDatabase: null,
  editorHeightPercent: 50,
  sidebarWidth: 280,
  sidebarCollapsed: false,
  showQueryHistory: false,
  openTabs: [],
  activeTabId: null,
  recentWorkspaces: [],
  currentWorkspacePath: null,
};

export function createAppStateDouble(initial?: AppStateWithReactRenderer): AppStateDouble {
  let persisted: AppStateWithReactRenderer = structuredClone({ ...EMPTY_STATE, ...initial });
  const calls = {
    getState: 0,
    setState: 0,
    saveTabs: 0,
    getTabs: 0,
    saveLayout: 0,
    getLayout: 0,
  };

  const double: AppStateDouble = {
    app: {
      getState: () => {
        calls.getState += 1;
        return Promise.resolve(structuredClone(persisted));
      },
      setState: partial => {
        calls.setState += 1;
        // The shallow spread, exactly as main does it.
        persisted = { ...persisted, ...structuredClone(partial) };
        return Promise.resolve();
      },
      saveTabs: (tabs, activeTabId) => {
        calls.saveTabs += 1;
        persisted = { ...persisted, openTabs: structuredClone(tabs), activeTabId };
        return Promise.resolve();
      },
      getTabs: () => {
        calls.getTabs += 1;
        return Promise.resolve({
          tabs: structuredClone(persisted.openTabs ?? []),
          activeTabId: persisted.activeTabId ?? null,
        });
      },
      saveLayout: config => {
        calls.saveLayout += 1;
        persisted = { ...persisted, workspaceLayout: structuredClone(config) };
        return Promise.resolve();
      },
      getLayout: () => {
        calls.getLayout += 1;
        return Promise.resolve(structuredClone(persisted.workspaceLayout));
      },
    },
    snapshot: () => structuredClone(persisted),
    calls,
    reboot: () => createAppStateDouble(persisted),
  };

  return double;
}
