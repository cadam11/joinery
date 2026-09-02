/**
 * IPC Channel definitions for communication between main and renderer processes
 */
export const IPC_CHANNELS = {
  // Connection Management
  CONNECTION: {
    TEST: 'connection:test',
    SAVE: 'connection:save',
    DELETE: 'connection:delete',
    LIST: 'connection:list',
    CONNECT: 'connection:connect',
    DISCONNECT: 'connection:disconnect',
    PING: 'connection:ping',
    LIST_AWS_PROFILES: 'connection:list-aws-profiles',
  },

  // Docker Detection
  DOCKER: {
    DETECT: 'docker:detect',
    GET_CONTAINERS: 'docker:get-containers',
    GET_VOLUMES: 'docker:get-volumes',
    START_CONTAINER: 'docker:start-container',
    STOP_CONTAINER: 'docker:stop-container',
    CREATE_CONTAINER: 'docker:create-container',
  },

  // Database Operations
  DATABASE: {
    LIST: 'database:list',
    CREATE: 'database:create',
    RENAME: 'database:rename',
    DELETE: 'database:delete',
    GET_INFO: 'database:get-info',
  },

  // Object Explorer
  EXPLORER: {
    GET_CHILDREN: 'explorer:get-children',
    GET_OBJECT_DETAILS: 'explorer:get-object-details',
    REFRESH_NODE: 'explorer:refresh-node',
    LIST_SCHEMAS: 'explorer:list-schemas',
    // Table metadata
    GET_TABLE_COLUMNS: 'explorer:get-table-columns',
    GET_TABLE_INDEXES: 'explorer:get-table-indexes',
    GET_TABLE_KEYS: 'explorer:get-table-keys',
    GET_TABLE_CONSTRAINTS: 'explorer:get-table-constraints',
    GET_TABLE_TRIGGERS: 'explorer:get-table-triggers',
    GET_TABLE_METADATA: 'explorer:get-table-metadata',
    GET_TABLE_PROPERTIES: 'explorer:get-table-properties',
    GET_EXTENDED_PROPERTIES: 'explorer:get-extended-properties',
    GET_ENRICHED_COLUMNS: 'explorer:get-enriched-columns',
    // Scripting
    SCRIPT_TABLE_CREATE: 'explorer:script-table-create',
    SCRIPT_TABLE_INSERT: 'explorer:script-table-insert',
    // Legacy
    GET_TABLES: 'explorer:get-tables',
    GET_VIEWS: 'explorer:get-views',
    GET_PROCEDURES: 'explorer:get-procedures',
    GET_DEFINITION: 'explorer:get-definition',
    REFRESH: 'explorer:refresh',
  },

  // Query Execution
  QUERY: {
    EXECUTE: 'query:execute',
    CANCEL: 'query:cancel',
    // History
    GET_HISTORY: 'query:get-history',
    CLEAR_HISTORY: 'query:clear-history',
    DELETE_HISTORY_ENTRY: 'query:delete-history-entry',
    // Export
    EXPORT_RESULTS: 'query:export-results',
    // Foreign Key Navigation
    FETCH_FK_RECORD: 'query:fetch-fk-record',
    // SQL Dialect Conversion
    CONVERT_SQL: 'query:convert-sql',
  },

  // Query Results Persistence
  QUERY_RESULTS: {
    SAVE_SNAPSHOT: 'query-results:save-snapshot',
    GET_SNAPSHOTS: 'query-results:get-snapshots',
    GET_SNAPSHOT: 'query-results:get-snapshot',
    DELETE_SNAPSHOT: 'query-results:delete-snapshot',
    DELETE_SNAPSHOTS: 'query-results:delete-snapshots',
    PIN_SNAPSHOT: 'query-results:pin-snapshot',
    UNPIN_SNAPSHOT: 'query-results:unpin-snapshot',
    LABEL_SNAPSHOT: 'query-results:label-snapshot',
    GET_STORAGE_STATS: 'query-results:get-storage-stats',
    PURGE: 'query-results:purge',
    COMPARE_SNAPSHOTS: 'query-results:compare-snapshots',
  },

  // AI Integration
  AI: {
    GET_VENDORS: 'ai:get-vendors',
    GET_SETTINGS: 'ai:get-settings',
    SET_SETTINGS: 'ai:set-settings',
    SET_API_KEY: 'ai:set-api-key',
    REMOVE_API_KEY: 'ai:remove-api-key',
    VALIDATE_API_KEY: 'ai:validate-api-key',
    GENERATE_TAB_NAME: 'ai:generate-tab-name',
    ANALYZE_RESULTS: 'ai:analyze-results',
    GENERATE_SQL: 'ai:generate-sql',
    CANCEL_REQUEST: 'ai:cancel-request',
  },

  // Server File System (browsing SQL Server's file system)
  SERVER_FS: {
    GET_DRIVES: 'server-fs:get-drives',
    LIST_DIRECTORY: 'server-fs:list-directory',
    GET_DEFAULT_PATHS: 'server-fs:get-default-paths',
  },

  // Backup Operations
  /** SQL-conversion Python probe (J-29). Mirrors the backup CLI-tools probe. */
  PYTHON: {
    CHECK: 'python:check',
    RECHECK: 'python:recheck',
  },

  BACKUP: {
    START: 'backup:start',
    CANCEL: 'backup:cancel',
    PROGRESS: 'backup:progress',
    COMPLETE: 'backup:complete',
    ERROR: 'backup:error',
    GET_HISTORY: 'backup:get-history',
    // Probe whether the host has the engine-specific CLIs (pg_dump,
    // mysqldump, etc.) Joinery needs for backup/restore on PG/MySQL.
    CHECK_TOOLS: 'backup:check-tools',
    // Same probe but bypasses the cache — wired to the "Re-check"
    // button in the missing-tools dialog after the user installs.
    RECHECK_TOOLS: 'backup:recheck-tools',
  },

  // Restore Operations
  RESTORE: {
    START: 'restore:start',
    CANCEL: 'restore:cancel',
    GET_FILE_LIST: 'restore:get-file-list',
    GET_BACKUP_INFO: 'restore:get-backup-info',
    PROGRESS: 'restore:progress',
    COMPLETE: 'restore:complete',
    ERROR: 'restore:error',
    // Legacy
    READ_INFO: 'restore:read-info',
  },

  // Diagnostics / logging
  LOG: {
    // Renderer pulls the recent in-memory log buffer (e.g. on panel open).
    GET_RECENT: 'log:get-recent',
    // Renderer pushes a renderer-side log entry into the shared buffer.
    APPEND: 'log:append',
    // Main broadcasts each new log entry to renderer windows (stream).
    ENTRY: 'log:entry',
    // Reveal the on-disk log file in the OS file manager.
    REVEAL_FILE: 'log:reveal-file',
  },

  // Settings
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
  },

  // Theme (native OS theme detection)
  THEME: {
    GET_NATIVE: 'theme:get-native',
    CHANGED: 'theme:changed',
  },

  // Credential store availability. Availability only — no credential, and no part of one,
  // is ever carried on these channels (J-118).
  CREDENTIALS: {
    GET_KEYCHAIN_STATUS: 'credentials:get-keychain-status',
    KEYCHAIN_STATUS_CHANGED: 'credentials:keychain-status-changed',
  },

  // App
  APP: {
    GET_VERSION: 'app:get-version',
    OPEN_EXTERNAL: 'app:open-external',
    SHOW_IN_FOLDER: 'app:show-in-folder',
    SHOW_OPEN_DIALOG: 'app:show-open-dialog',
    SHOW_SAVE_DIALOG: 'app:show-save-dialog',
    // State persistence
    GET_STATE: 'app:get-state',
    SET_STATE: 'app:set-state',
    SAVE_TABS: 'app:save-tabs',
    GET_TABS: 'app:get-tabs',
    // Workspace layout persistence
    SAVE_LAYOUT: 'app:save-layout',
    GET_LAYOUT: 'app:get-layout',
    // General-purpose file write (for exports — no workspace required)
    SAVE_TO_FILE: 'app:save-to-file',
    /**
     * The flush-before-quit handshake (J-74). One exchange, two directions: main asks the renderer
     * to empty its debounced `AppState` writes, the renderer answers once they have actually landed.
     *
     * It exists because a macOS ⌘Q never reaches the renderer's unload events at all — `before-quit`
     * preventDefaults and ends at `app.exit(0)`, which closes windows without emitting `close` — so
     * a sidebar drag or a keystroke inside a 250-500ms debounce window died with the page. Main
     * waits for the answer with an explicit bound and quits either way; see
     * `main/src/services/config/renderer-flush.ts`.
     */
    FLUSH_BEFORE_QUIT: 'app:flush-before-quit',
    FLUSH_BEFORE_QUIT_DONE: 'app:flush-before-quit-done',
  },

  // Workspace (for file/folder support)
  WORKSPACE: {
    OPEN_FOLDER: 'workspace:open-folder',
    GET_FILES: 'workspace:get-files',
    READ_FILE: 'workspace:read-file',
    WRITE_FILE: 'workspace:write-file',
    CREATE_FILE: 'workspace:create-file',
    DELETE_FILE: 'workspace:delete-file',
    RENAME_FILE: 'workspace:rename-file',
    WATCH: 'workspace:watch',
    UNWATCH: 'workspace:unwatch',
    FILE_CHANGED: 'workspace:file-changed',
  },
} as const;

export type IpcChannels = typeof IPC_CHANNELS;
