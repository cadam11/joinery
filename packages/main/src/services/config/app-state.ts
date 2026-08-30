/**
 * App State Persistence Service
 * Saves and restores application state across sessions
 */

import Store from 'electron-store';
import { BaseSingleton } from '../../utils/singleton';
import type { AppState, TabState, LayoutConfig } from '@joinery/shared';
import { createTrailingDebounce, type TrailingDebounce } from '../../utils/trailing-debounce';

const DEFAULT_APP_STATE: AppState = {
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

const PERSIST_DEBOUNCE_MS = 500;

export class AppStateStore extends BaseSingleton {
  private store: Store<{ appState: AppState }>;
  /**
   * Runtime source of truth. Writes are debounced because electron-store
   * persists synchronously (tab saves used to trigger two full
   * read-modify-write disk cycles each); index.ts flushes on before-quit.
   */
  private cached: AppState;
  private persist: TrailingDebounce;

  constructor() {
    super();
    this.store = new Store<{ appState: AppState }>({
      name: 'app-state',
      defaults: {
        appState: DEFAULT_APP_STATE,
      },
    });
    this.cached = this.store.get('appState');
    this.persist = createTrailingDebounce(
      () => this.store.set('appState', this.cached),
      PERSIST_DEBOUNCE_MS
    );
  }

  /** Write any pending mutations to disk now. Called on app quit. */
  flush(): void {
    this.persist.flush();
  }

  /**
   * Get the full app state
   */
  getState(): AppState {
    return structuredClone(this.cached);
  }

  /**
   * Update app state (partial update)
   */
  setState(partial: Partial<AppState>): void {
    this.cached = { ...this.cached, ...partial };
    this.persist.call();
  }

  /**
   * Returns the legacy single-connection key from disk if present. Used only
   * for forward-migration during the first launch after the multi-connection
   * upgrade — `getLastConnectedProfileIds()` is the supported accessor now.
   */
  getLastConnectionId(): string | null {
    return this.getState().lastConnectionId ?? null;
  }

  /**
   * Get the list of profile ids that were connected when the app was last
   * closed. Empty array if never set.
   */
  getLastConnectedProfileIds(): string[] {
    return this.getState().lastConnectedProfileIds;
  }

  /**
   * Set the list of profile ids that are currently connected.
   */
  setLastConnectedProfileIds(connectionIds: string[]): void {
    this.setState({ lastConnectedProfileIds: connectionIds });
  }

  /**
   * Get last database
   */
  getLastDatabase(): string | null {
    return this.getState().lastDatabase;
  }

  /**
   * Set last database
   */
  setLastDatabase(database: string | null): void {
    this.setState({ lastDatabase: database });
  }

  /**
   * Get editor height percent
   */
  getEditorHeightPercent(): number {
    return this.getState().editorHeightPercent;
  }

  /**
   * Set editor height percent
   */
  setEditorHeightPercent(percent: number): void {
    this.setState({ editorHeightPercent: percent });
  }

  /**
   * Get sidebar width
   */
  getSidebarWidth(): number {
    return this.getState().sidebarWidth;
  }

  /**
   * Set sidebar width
   */
  setSidebarWidth(width: number): void {
    this.setState({ sidebarWidth: width });
  }

  /**
   * Get sidebar collapsed state
   */
  getSidebarCollapsed(): boolean {
    return this.getState().sidebarCollapsed;
  }

  /**
   * Set sidebar collapsed state
   */
  setSidebarCollapsed(collapsed: boolean): void {
    this.setState({ sidebarCollapsed: collapsed });
  }

  /**
   * Get open tabs
   */
  getOpenTabs(): TabState[] {
    return this.getState().openTabs;
  }

  /**
   * Set open tabs
   */
  setOpenTabs(tabs: TabState[]): void {
    this.setState({ openTabs: tabs });
  }

  /**
   * Get active tab ID
   */
  getActiveTabId(): string | null {
    return this.getState().activeTabId;
  }

  /**
   * Set active tab ID
   */
  setActiveTabId(tabId: string | null): void {
    this.setState({ activeTabId: tabId });
  }

  /**
   * Add recent workspace
   */
  addRecentWorkspace(workspacePath: string): void {
    const current = this.getState().recentWorkspaces;
    const filtered = current.filter(p => p !== workspacePath);
    const updated = [workspacePath, ...filtered].slice(0, 10); // Keep last 10
    this.setState({ recentWorkspaces: updated });
  }

  /**
   * Get recent workspaces
   */
  getRecentWorkspaces(): string[] {
    return this.getState().recentWorkspaces;
  }

  /**
   * Get current workspace path
   */
  getCurrentWorkspacePath(): string | null {
    return this.getState().currentWorkspacePath;
  }

  /**
   * Set current workspace path
   */
  setCurrentWorkspacePath(path: string | null): void {
    this.setState({ currentWorkspacePath: path });
    if (path) {
      this.addRecentWorkspace(path);
    }
  }

  /**
   * Get the persisted workspace layout
   */
  getWorkspaceLayout(): LayoutConfig | undefined {
    return this.getState().workspaceLayout;
  }

  /**
   * Set the persisted workspace layout
   */
  setWorkspaceLayout(config: LayoutConfig | undefined): void {
    this.setState({ workspaceLayout: config });
  }

  /**
   * Clear all state (for testing or reset)
   */
  clearState(): void {
    this.cached = structuredClone(DEFAULT_APP_STATE);
    this.persist.call();
  }
}
