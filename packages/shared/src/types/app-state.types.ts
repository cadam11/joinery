/**
 * App State Types for persistence across sessions
 */

import type { AISettings } from './ai.types';

export interface TabState {
  id: string;
  type: 'query' | 'results' | 'object' | 'welcome' | 'erd' | 'chat';
  title: string;
  content?: string;
  connectionId?: string;
  databaseName?: string;
  isDirty?: boolean;
  isPinned?: boolean;
  filePath?: string; // For workspace files
}

export interface AppState {
  /**
   * Legacy single-connection persistence key. Replaced by
   * `lastConnectedProfileIds` in the multi-connection-first-class change.
   * Read only on first launch after the upgrade, for forward-migration:
   * if `lastConnectedProfileIds` is absent and this is set, the renderer
   * treats it as a one-element array and writes the new key on the way
   * through. No new code writes to this field.
   */
  lastConnectionId?: string | null;
  /**
   * Profile ids that were connected when the app was last closed. Restored
   * independently on launch; failures for one profile do not block others.
   */
  lastConnectedProfileIds: string[];
  lastDatabase: string | null;
  editorHeightPercent: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  showQueryHistory: boolean;
  openTabs: TabState[];
  activeTabId: string | null;
  recentWorkspaces: string[];
  currentWorkspacePath: string | null;
  /** Serialized workspace arrangement. See `renderer/src/persistence/layout.ts` for the envelope. */
  workspaceLayout?: LayoutConfig;
  /** AI settings */
  aiSettings?: AISettings;
  /** Chat panel width in pixels */
  chatPanelWidth?: number;
}

export interface WorkspaceSettings {
  defaultConnection?: string;
  defaultDatabase?: string;
  executeOnOpen?: boolean;
  formatting?: {
    keywordCase?: 'upper' | 'lower' | 'preserve';
    indentSize?: number;
  };
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  children?: FileTreeNode[];
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  files: FileTreeNode[];
  settings?: WorkspaceSettings;
}

/**
 * GoldenLayout-based workspace configuration for flexible tab layouts
 */
export interface WorkspaceLayoutConfig {
  /** Schema version for future migrations */
  version: number;

  /** Golden Layout state (may be undefined if cleared due to corruption) */
  layout?: LayoutConfig;

  /** ID of currently active tab */
  activeTabId: string | null;

  /** All tabs metadata */
  tabs: WorkspaceTab[];
}

/**
 * Layout configuration: the serialized workspace tree, as written by the renderer.
 */
export interface LayoutConfig {
  root: LayoutNode;
  dimensions?: {
    headerHeight: number;
    borderWidth: number;
  };
}

/**
 * Node in the layout tree
 */
export interface LayoutNode {
  type: 'row' | 'column' | 'stack' | 'component';
  content?: LayoutNode[];
  componentType?: string;
  componentState?: Record<string, unknown>;
  width?: number;
  height?: number;
  isClosable?: boolean;
  title?: string;
}

/**
 * Individual tab definition for GoldenLayout
 */
export interface WorkspaceTab {
  /** Unique ID for this tab */
  id: string;

  /** Tab type */
  type: 'query' | 'results' | 'object' | 'welcome' | 'erd' | 'chat';

  /** Display title */
  title: string;

  /** Icon name (Material Icons) */
  icon: string;

  /** Connection ID for this tab */
  connectionId?: string;

  /** Database name for this tab */
  databaseName?: string;

  /** Whether tab has unsaved changes */
  isDirty?: boolean;

  /** Whether tab is pinned (permanent) */
  isPinned?: boolean;

  /** Display order */
  sequence: number;

  /** Tab-specific configuration */
  configuration: TabConfiguration;
}

/**
 * Tab-specific configuration (extensible)
 */
export interface TabConfiguration {
  /** SQL content for query tabs */
  content?: string;

  /** Auto-execute query when tab opens */
  autoExecute?: boolean;

  /** Object name for object tabs */
  objectName?: string;

  /** Object type for object tabs */
  objectType?: string;

  /** Table name for ERD tabs */
  tableName?: string;

  /** Schema name for ERD tabs */
  schema?: string;

  /** Focus depth for ERD tabs */
  focusDepth?: number;

  /** Allow additional properties */
  [key: string]: unknown;
}

/**
 * Create default workspace layout configuration
 */
export function createDefaultLayoutConfig(): WorkspaceLayoutConfig {
  return {
    version: 1,
    layout: {
      root: {
        type: 'row',
        content: [],
      },
    },
    activeTabId: null,
    tabs: [],
  };
}
