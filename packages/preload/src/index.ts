import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, CHAT_IPC_CHANNELS } from '@joinery/shared';
import type {
  ConnectionProfile,
  TestConnectionResult,
  DatabaseInfo,
  SchemaInfo,
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
  DatabaseOperationResult,
  ObjectMetadata,
  ObjectType,
  QueryRequest,
  QueryResult,
  QueryHistoryEntry,
  QueryHistoryFilter,
  ExportOptions,
  ExportResult,
  ResultSet,
  FkRecordRequest,
  FkRecordResult,
  BackupRequest,
  BackupProgress,
  BackupFileInfo,
  BackupHistoryEntry,
  CliDepsResult,
  CliEngine,
  RestoreRequest,
  RestoreProgress,
  DockerStatus,
  DockerContainer,
  DockerVolume,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  ConstraintInfo,
  TriggerInfo,
  ExtendedProperty,
  TableProperties,
  ObjectDefinition,
  AppState,
  TabState,
  FileTreeNode,
  WorkspaceInfo,
  LayoutConfig,
  // Query Results types
  QueryResultSnapshot,
  QueryResultHistoryFilter,
  ResultHistorySortOptions,
  PurgeOptions,
  PurgeResult,
  ResultStorageStats,
  ResultDiff,
  DiffOptions,
  // AI types
  AIVendor,
  AISettings,
  TabRenameRequest,
  TabRenameResponse,
  AnalysisRequest,
  AnalysisResponse,
  SQLGenerationRequest,
  SQLGenerationResponse,
  // Chat types
  ChatRequest,
  ChatStreamChunk,
  ConfirmToolCallOutcome,
  Conversation,
  ToolDefinition,
  // Server file system types
  ServerDrive,
  ServerFileEntry,
  ServerDefaultPaths,
  LogEntry,
  ActiveConnection,
  // Keychain availability (never a credential — see the `credentials` namespace below)
  KeychainStatus,
} from '@joinery/shared';

/**
 * The API exposed to the renderer process via contextBridge
 */
export interface JoineryAPI {
  connection: {
    test: (
      profile: ConnectionProfile,
      password?: string,
      sshPassword?: string,
      sshPassphrase?: string
    ) => Promise<TestConnectionResult>;
    save: (
      profile: ConnectionProfile,
      password?: string,
      sshPassword?: string,
      sshPassphrase?: string
    ) => Promise<ConnectionProfile>;
    delete: (profileId: string) => Promise<void>;
    list: () => Promise<ConnectionProfile[]>;
    connect: (profileId: string) => Promise<ActiveConnection>;
    disconnect: (profileId: string) => Promise<void>;
    ping: (profileId: string) => Promise<boolean>;
    listAwsProfiles: () => Promise<string[]>;
  };

  docker: {
    detect: () => Promise<DockerStatus>;
    getContainers: () => Promise<DockerContainer[]>;
    getVolumes: () => Promise<DockerVolume[]>;
    startContainer: (containerId: string) => Promise<void>;
    stopContainer: (containerId: string) => Promise<void>;
    createContainer: (options: {
      name: string;
      password: string;
      port: number;
      image?: string;
      acceptEula?: boolean;
    }) => Promise<{ success: boolean; containerId?: string; error?: string }>;
  };

  database: {
    list: (connectionId: string) => Promise<DatabaseInfo[]>;
    create: (
      connectionId: string,
      options: CreateDatabaseOptions
    ) => Promise<DatabaseOperationResult>;
    rename: (
      connectionId: string,
      options: RenameDatabaseOptions
    ) => Promise<DatabaseOperationResult>;
    delete: (
      connectionId: string,
      options: DeleteDatabaseOptions
    ) => Promise<DatabaseOperationResult>;
    getInfo: (connectionId: string, databaseName: string) => Promise<DatabaseInfo>;
  };

  explorer: {
    listSchemas: (connectionId: string, databaseName: string) => Promise<SchemaInfo[]>;
    getChildren: (
      connectionId: string,
      databaseName: string,
      parentPath: string
    ) => Promise<ObjectMetadata[]>;
    getObjectDetails: (
      connectionId: string,
      databaseName: string,
      objectType: ObjectType,
      objectName: string,
      schema?: string
    ) => Promise<ObjectMetadata>;
    refreshNode: (
      connectionId: string,
      databaseName: string,
      path: string
    ) => Promise<ObjectMetadata[]>;
    getDefinition: (
      connectionId: string,
      databaseName: string,
      schema: string,
      name: string,
      objectType: string
    ) => Promise<ObjectDefinition>;
    getTableColumns: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<ColumnInfo[]>;
    getTableIndexes: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<IndexInfo[]>;
    getTableKeys: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<ForeignKeyInfo[]>;
    getTableConstraints: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<ConstraintInfo[]>;
    getTableTriggers: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<TriggerInfo[]>;
    getTableProperties: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<TableProperties>;
    getExtendedProperties: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<ExtendedProperty[]>;
    scriptTableAsCreate: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<string>;
    scriptTableAsInsert: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<string>;
    getEnrichedColumns: (
      connectionId: string,
      databaseName: string,
      schema: string,
      tableName: string
    ) => Promise<
      Array<{
        name: string;
        type: string;
        nullable: boolean;
        maxLength: number | null;
        precision: number | null;
        scale: number | null;
        isPrimaryKey: boolean;
        isIdentity: boolean;
        defaultValue: string | null;
        foreignKey: {
          referencedSchema: string;
          referencedTable: string;
          referencedColumn: string;
          constraintName: string;
        } | null;
      }>
    >;
  };

  query: {
    execute: (request: QueryRequest) => Promise<QueryResult>;
    cancel: (queryId: string) => Promise<void>;
    getHistory: (filter?: QueryHistoryFilter) => Promise<QueryHistoryEntry[]>;
    clearHistory: () => Promise<void>;
    deleteHistoryEntry: (id: string) => Promise<boolean>;
    exportResults: (resultSet: ResultSet, options: ExportOptions) => Promise<ExportResult>;
    fetchFkRecord: (request: FkRecordRequest) => Promise<FkRecordResult>;
    convertSql: (
      sql: string,
      fromEngine: string,
      toEngine: string
    ) => Promise<{ success: boolean; sql: string; error?: string }>;
  };

  queryResults: {
    saveSnapshot: (
      tabId: string,
      sql: string,
      connectionId: string,
      database: string,
      result: QueryResult
    ) => Promise<QueryResultSnapshot>;
    getSnapshots: (
      filter?: QueryResultHistoryFilter,
      sort?: ResultHistorySortOptions
    ) => Promise<QueryResultSnapshot[]>;
    getSnapshot: (id: string) => Promise<QueryResultSnapshot | null>;
    deleteSnapshot: (id: string) => Promise<boolean>;
    deleteSnapshots: (ids: string[]) => Promise<number>;
    pinSnapshot: (id: string) => Promise<boolean>;
    unpinSnapshot: (id: string) => Promise<boolean>;
    labelSnapshot: (id: string, label: string) => Promise<boolean>;
    getStorageStats: () => Promise<ResultStorageStats>;
    purge: (options: PurgeOptions) => Promise<PurgeResult>;
    compareSnapshots: (
      baseId: string,
      compareId: string,
      options?: DiffOptions
    ) => Promise<ResultDiff | null>;
  };

  ai: {
    getVendors: () => Promise<AIVendor[]>;
    getSettings: () => Promise<AISettings>;
    setSettings: (settings: Partial<AISettings>) => Promise<AISettings>;
    setApiKey: (vendorId: string, apiKey: string) => Promise<boolean>;
    removeApiKey: (vendorId: string) => Promise<boolean>;
    validateApiKey: (vendorId: string, apiKey: string) => Promise<boolean>;
    generateTabName: (request: TabRenameRequest) => Promise<TabRenameResponse>;
    analyzeResults: (request: AnalysisRequest) => Promise<AnalysisResponse>;
    generateSQL: (request: SQLGenerationRequest) => Promise<SQLGenerationResponse>;
    cancelRequest: (requestId: string) => Promise<boolean>;
  };

  chat: {
    getTools: () => Promise<ToolDefinition[]>;
    listConversations: () => Promise<Conversation[]>;
    getConversation: (id: string) => Promise<Conversation | null>;
    createConversation: (title?: string) => Promise<Conversation>;
    deleteConversation: (id: string) => Promise<boolean>;
    renameConversation: (id: string, title: string) => Promise<Conversation | null>;
    sendMessage: (request: ChatRequest) => Promise<{ started: boolean }>;
    confirmTool: (
      conversationId: string,
      toolCallId: string,
      confirmed: boolean
    ) => Promise<{ confirmed: boolean; outcome: ConfirmToolCallOutcome }>;
    cancelStream: (conversationId: string) => Promise<{ cancelled: boolean }>;
    onStreamChunk: (callback: (chunk: ChatStreamChunk) => void) => () => void;
  };

  serverFs: {
    getDrives: (connectionId: string) => Promise<ServerDrive[]>;
    listDirectory: (
      connectionId: string,
      path: string,
      includeFiles?: boolean
    ) => Promise<ServerFileEntry[]>;
    getDefaultPaths: (connectionId: string) => Promise<ServerDefaultPaths>;
  };

  backup: {
    start: (request: BackupRequest) => Promise<void>;
    cancel: (backupId: string) => Promise<void>;
    getHistory: (connectionId: string, databaseName?: string) => Promise<BackupHistoryEntry[]>;
    onProgress: (callback: (progress: BackupProgress) => void) => () => void;
    checkTools: (engine: CliEngine) => Promise<CliDepsResult>;
    recheckTools: (engine: CliEngine) => Promise<CliDepsResult>;
  };

  restore: {
    start: (request: RestoreRequest) => Promise<void>;
    cancel: (restoreId: string) => Promise<void>;
    getFileList: (
      connectionId: string,
      backupPath: string
    ) => Promise<{ logicalName: string; physicalName: string; type: string }[]>;
    /**
     * Resolves `null` for PostgreSQL and MySQL: only MSSQL keeps a readable backup header, and
     * the object those two returned was a cast over undefined fields (J-51e).
     */
    getBackupInfo: (connectionId: string, backupPath: string) => Promise<BackupFileInfo | null>;
    onProgress: (callback: (progress: RestoreProgress) => void) => () => void;
  };

  logs: {
    getRecent: (limit?: number) => Promise<LogEntry[]>;
    append: (entry: LogEntry) => Promise<void>;
    onEntry: (callback: (entry: LogEntry) => void) => () => void;
    revealFile: () => Promise<string>;
  };

  app: {
    getVersion: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    showOpenDialog: (
      options: Electron.OpenDialogOptions
    ) => Promise<Electron.OpenDialogReturnValue>;
    showSaveDialog: (
      options: Electron.SaveDialogOptions
    ) => Promise<Electron.SaveDialogReturnValue>;
    // State persistence
    getState: () => Promise<AppState>;
    setState: (partial: Partial<AppState>) => Promise<void>;
    saveTabs: (tabs: TabState[], activeTabId: string | null) => Promise<void>;
    getTabs: () => Promise<{ tabs: TabState[]; activeTabId: string | null }>;
    // GoldenLayout persistence
    saveLayout: (config: LayoutConfig | undefined) => Promise<void>;
    getLayout: () => Promise<LayoutConfig | undefined>;
    // Atomic save-dialog + file write (main process shows dialog and writes)
    saveToFile: (
      options: {
        title?: string;
        defaultPath?: string;
        filters?: { name: string; extensions: string[] }[];
      },
      content: string
    ) => Promise<{ canceled: boolean; filePath?: string }>;
  };

  workspace: {
    openFolder: (path: string) => Promise<WorkspaceInfo>;
    getFiles: (path: string) => Promise<FileTreeNode[]>;
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<void>;
    createFile: (filePath: string, content?: string) => Promise<void>;
    deleteFile: (filePath: string) => Promise<void>;
    renameFile: (oldPath: string, newPath: string) => Promise<void>;
    onFileChanged: (callback: (event: { filePath: string; type: string }) => void) => () => void;
  };

  theme: {
    getNative: () => Promise<'dark' | 'light'>;
    onChanged: (callback: (theme: 'dark' | 'light') => void) => () => void;
  };

  /**
   * Keychain availability, and nothing else. There is deliberately no read, write or list
   * of credentials on the bridge: secrets stay in the main process (J-118).
   */
  credentials: {
    getKeychainStatus: () => Promise<KeychainStatus>;
    onKeychainStatusChanged: (callback: (status: KeychainStatus) => void) => () => void;
  };

  menu: {
    // File menu
    onNewConnection: (callback: () => void) => () => void;
    onNewQuery: (callback: () => void) => () => void;
    onOpenQuery: (callback: () => void) => () => void;
    onCloseTab: (callback: () => void) => () => void;
    onSaveQuery: (callback: () => void) => () => void;
    onSaveQueryAs: (callback: () => void) => () => void;
    onExportResults: (callback: () => void) => () => void;

    // Edit menu
    onCopy: (callback: () => void) => () => void;
    onFind: (callback: () => void) => () => void;
    onReplace: (callback: () => void) => () => void;
    onFormatSql: (callback: () => void) => () => void;
    onToggleComment: (callback: () => void) => () => void;

    // Query menu
    onExecuteQuery: (callback: () => void) => () => void;
    onExecuteSelection: (callback: () => void) => () => void;
    onCancelQuery: (callback: () => void) => () => void;
    onQueryHistory: (callback: () => void) => () => void;

    // Server menu
    onDisconnect: (callback: () => void) => () => void;
    onRefresh: (callback: () => void) => () => void;

    // Database menu
    onNewDatabase: (callback: () => void) => () => void;
    onBackup: (callback: () => void) => () => void;
    onRestore: (callback: () => void) => () => void;

    // View menu
    onShowWelcome: (callback: () => void) => () => void;
    onToggleSidebar: (callback: () => void) => () => void;
    onToggleChat: (callback: () => void) => () => void;
    onToggleResults: (callback: () => void) => () => void;

    // Window menu
    onNextTab: (callback: () => void) => () => void;
    onPreviousTab: (callback: () => void) => () => void;

    // Settings/Help
    onOpenSettings: (callback: () => void) => () => void;
    onOpenAiSetup: (callback: () => void) => () => void;
    onShowShortcuts: (callback: () => void) => () => void;
  };
}

// Helper to create event listener cleanup functions
function createEventListener<T>(channel: string, callback: (data: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Menu event channels
const MENU_CHANNELS = {
  // File menu
  NEW_CONNECTION: 'menu:new-connection',
  NEW_QUERY: 'menu:new-query',
  OPEN_QUERY: 'menu:open-query',
  CLOSE_TAB: 'menu:close-tab',
  SAVE_QUERY: 'menu:save-query',
  SAVE_QUERY_AS: 'menu:save-query-as',
  EXPORT_RESULTS: 'menu:export-results',

  // Edit menu
  COPY: 'menu:copy',
  FIND: 'menu:find',
  REPLACE: 'menu:replace',
  FORMAT_SQL: 'menu:format-sql',
  TOGGLE_COMMENT: 'menu:toggle-comment',

  // Query menu
  EXECUTE_QUERY: 'menu:execute-query',
  EXECUTE_SELECTION: 'menu:execute-selection',
  CANCEL_QUERY: 'menu:cancel-query',
  QUERY_HISTORY: 'menu:query-history',

  // Server menu
  DISCONNECT: 'menu:disconnect',
  REFRESH: 'menu:refresh',

  // Database menu
  NEW_DATABASE: 'menu:new-database',
  BACKUP: 'menu:backup',
  RESTORE: 'menu:restore',

  // View menu
  SHOW_WELCOME: 'menu:show-welcome',
  TOGGLE_SIDEBAR: 'menu:toggle-sidebar',
  TOGGLE_CHAT: 'menu:toggle-chat',
  TOGGLE_RESULTS: 'menu:toggle-results',

  // Window menu
  NEXT_TAB: 'menu:next-tab',
  PREVIOUS_TAB: 'menu:previous-tab',

  // Settings/Help
  OPEN_SETTINGS: 'menu:open-settings',
  OPEN_AI_SETUP: 'menu:open-ai-setup',
  SHOW_SHORTCUTS: 'menu:show-shortcuts',
} as const;

// Create the API implementation
const joineryAPI: JoineryAPI = {
  connection: {
    test: (profile, password, sshPassword, sshPassphrase) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.CONNECTION.TEST,
        profile,
        password,
        sshPassword,
        sshPassphrase
      ),
    save: (profile, password, sshPassword, sshPassphrase) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.CONNECTION.SAVE,
        profile,
        password,
        sshPassword,
        sshPassphrase
      ),
    delete: profileId => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION.DELETE, profileId),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION.LIST),
    connect: profileId => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION.CONNECT, profileId),
    disconnect: profileId => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION.DISCONNECT, profileId),
    ping: profileId => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION.PING, profileId),
    listAwsProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION.LIST_AWS_PROFILES),
  },

  docker: {
    detect: () => ipcRenderer.invoke(IPC_CHANNELS.DOCKER.DETECT),
    getContainers: () => ipcRenderer.invoke(IPC_CHANNELS.DOCKER.GET_CONTAINERS),
    getVolumes: () => ipcRenderer.invoke(IPC_CHANNELS.DOCKER.GET_VOLUMES),
    startContainer: containerId =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCKER.START_CONTAINER, containerId),
    stopContainer: containerId =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCKER.STOP_CONTAINER, containerId),
    createContainer: options => ipcRenderer.invoke(IPC_CHANNELS.DOCKER.CREATE_CONTAINER, options),
  },

  database: {
    list: connectionId => ipcRenderer.invoke(IPC_CHANNELS.DATABASE.LIST, connectionId),
    create: (connectionId, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.DATABASE.CREATE, connectionId, options),
    rename: (connectionId, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.DATABASE.RENAME, connectionId, options),
    delete: (connectionId, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.DATABASE.DELETE, connectionId, options),
    getInfo: (connectionId, databaseName) =>
      ipcRenderer.invoke(IPC_CHANNELS.DATABASE.GET_INFO, connectionId, databaseName),
  },

  explorer: {
    listSchemas: (connectionId, databaseName) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXPLORER.LIST_SCHEMAS, connectionId, databaseName),
    getChildren: (connectionId, databaseName, parentPath) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_CHILDREN,
        connectionId,
        databaseName,
        parentPath
      ),
    getObjectDetails: (connectionId, databaseName, objectType, objectName, schema) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_OBJECT_DETAILS,
        connectionId,
        databaseName,
        objectType,
        objectName,
        schema
      ),
    refreshNode: (connectionId, databaseName, path) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXPLORER.REFRESH_NODE, connectionId, databaseName, path),
    getDefinition: (connectionId, databaseName, schema, name, objectType) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_DEFINITION,
        connectionId,
        databaseName,
        schema,
        name,
        objectType
      ),
    getTableColumns: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_TABLE_COLUMNS,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getTableIndexes: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_TABLE_INDEXES,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getTableKeys: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_TABLE_KEYS,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getTableConstraints: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_TABLE_CONSTRAINTS,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getTableTriggers: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_TABLE_TRIGGERS,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getTableProperties: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_TABLE_PROPERTIES,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getExtendedProperties: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_EXTENDED_PROPERTIES,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    scriptTableAsCreate: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.SCRIPT_TABLE_CREATE,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    scriptTableAsInsert: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.SCRIPT_TABLE_INSERT,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
    getEnrichedColumns: (connectionId, databaseName, schema, tableName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.EXPLORER.GET_ENRICHED_COLUMNS,
        connectionId,
        databaseName,
        schema,
        tableName
      ),
  },

  query: {
    execute: request => ipcRenderer.invoke(IPC_CHANNELS.QUERY.EXECUTE, request),
    cancel: queryId => ipcRenderer.invoke(IPC_CHANNELS.QUERY.CANCEL, queryId),
    getHistory: filter => ipcRenderer.invoke(IPC_CHANNELS.QUERY.GET_HISTORY, filter),
    clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.QUERY.CLEAR_HISTORY),
    deleteHistoryEntry: id => ipcRenderer.invoke(IPC_CHANNELS.QUERY.DELETE_HISTORY_ENTRY, id),
    exportResults: (resultSet, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY.EXPORT_RESULTS, resultSet, options),
    fetchFkRecord: request => ipcRenderer.invoke(IPC_CHANNELS.QUERY.FETCH_FK_RECORD, request),
    convertSql: (sql: string, fromEngine: string, toEngine: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY.CONVERT_SQL, sql, fromEngine, toEngine),
  },

  queryResults: {
    saveSnapshot: (tabId, sql, connectionId, database, result) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.QUERY_RESULTS.SAVE_SNAPSHOT,
        tabId,
        sql,
        connectionId,
        database,
        result
      ),
    getSnapshots: (filter, sort) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.GET_SNAPSHOTS, filter, sort),
    getSnapshot: id => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.GET_SNAPSHOT, id),
    deleteSnapshot: id => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.DELETE_SNAPSHOT, id),
    deleteSnapshots: ids => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.DELETE_SNAPSHOTS, ids),
    pinSnapshot: id => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.PIN_SNAPSHOT, id),
    unpinSnapshot: id => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.UNPIN_SNAPSHOT, id),
    labelSnapshot: (id, label) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.LABEL_SNAPSHOT, id, label),
    getStorageStats: () => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.GET_STORAGE_STATS),
    purge: options => ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.PURGE, options),
    compareSnapshots: (baseId, compareId, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY_RESULTS.COMPARE_SNAPSHOTS, baseId, compareId, options),
  },

  ai: {
    getVendors: () => ipcRenderer.invoke(IPC_CHANNELS.AI.GET_VENDORS),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.AI.GET_SETTINGS),
    setSettings: settings => ipcRenderer.invoke(IPC_CHANNELS.AI.SET_SETTINGS, settings),
    setApiKey: (vendorId, apiKey) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI.SET_API_KEY, vendorId, apiKey),
    removeApiKey: vendorId => ipcRenderer.invoke(IPC_CHANNELS.AI.REMOVE_API_KEY, vendorId),
    validateApiKey: (vendorId, apiKey) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI.VALIDATE_API_KEY, vendorId, apiKey),
    generateTabName: request => ipcRenderer.invoke(IPC_CHANNELS.AI.GENERATE_TAB_NAME, request),
    analyzeResults: request => ipcRenderer.invoke(IPC_CHANNELS.AI.ANALYZE_RESULTS, request),
    generateSQL: request => ipcRenderer.invoke(IPC_CHANNELS.AI.GENERATE_SQL, request),
    cancelRequest: requestId => ipcRenderer.invoke(IPC_CHANNELS.AI.CANCEL_REQUEST, requestId),
  },

  chat: {
    getTools: () => ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_TOOLS),
    listConversations: () => ipcRenderer.invoke(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS),
    getConversation: id => ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_CONVERSATION, id),
    createConversation: title => ipcRenderer.invoke(CHAT_IPC_CHANNELS.CREATE_CONVERSATION, title),
    deleteConversation: id => ipcRenderer.invoke(CHAT_IPC_CHANNELS.DELETE_CONVERSATION, id),
    renameConversation: (id, title) =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.RENAME_CONVERSATION, id, title),
    sendMessage: request => ipcRenderer.invoke(CHAT_IPC_CHANNELS.SEND_MESSAGE, request),
    confirmTool: (conversationId, toolCallId, confirmed) =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.CONFIRM_TOOL, conversationId, toolCallId, confirmed),
    cancelStream: conversationId =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.CANCEL_STREAM, conversationId),
    onStreamChunk: callback => createEventListener(CHAT_IPC_CHANNELS.STREAM_CHUNK, callback),
  },

  serverFs: {
    getDrives: connectionId => ipcRenderer.invoke(IPC_CHANNELS.SERVER_FS.GET_DRIVES, connectionId),
    listDirectory: (connectionId, path, includeFiles) =>
      ipcRenderer.invoke(IPC_CHANNELS.SERVER_FS.LIST_DIRECTORY, connectionId, path, includeFiles),
    getDefaultPaths: connectionId =>
      ipcRenderer.invoke(IPC_CHANNELS.SERVER_FS.GET_DEFAULT_PATHS, connectionId),
  },

  backup: {
    start: request => ipcRenderer.invoke(IPC_CHANNELS.BACKUP.START, request),
    cancel: backupId => ipcRenderer.invoke(IPC_CHANNELS.BACKUP.CANCEL, backupId),
    getHistory: (connectionId, databaseName) =>
      ipcRenderer.invoke(IPC_CHANNELS.BACKUP.GET_HISTORY, connectionId, databaseName),
    onProgress: callback => createEventListener(IPC_CHANNELS.BACKUP.PROGRESS, callback),
    checkTools: engine => ipcRenderer.invoke(IPC_CHANNELS.BACKUP.CHECK_TOOLS, engine),
    recheckTools: engine => ipcRenderer.invoke(IPC_CHANNELS.BACKUP.RECHECK_TOOLS, engine),
  },

  restore: {
    start: request => ipcRenderer.invoke(IPC_CHANNELS.RESTORE.START, request),
    cancel: restoreId => ipcRenderer.invoke(IPC_CHANNELS.RESTORE.CANCEL, restoreId),
    getFileList: (connectionId, backupPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.RESTORE.GET_FILE_LIST, connectionId, backupPath),
    getBackupInfo: (connectionId, backupPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.RESTORE.GET_BACKUP_INFO, connectionId, backupPath),
    onProgress: callback => createEventListener(IPC_CHANNELS.RESTORE.PROGRESS, callback),
  },

  logs: {
    getRecent: limit => ipcRenderer.invoke(IPC_CHANNELS.LOG.GET_RECENT, limit),
    append: entry => ipcRenderer.invoke(IPC_CHANNELS.LOG.APPEND, entry),
    onEntry: callback => createEventListener(IPC_CHANNELS.LOG.ENTRY, callback),
    revealFile: () => ipcRenderer.invoke(IPC_CHANNELS.LOG.REVEAL_FILE),
  },

  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_VERSION),
    openExternal: url => ipcRenderer.invoke(IPC_CHANNELS.APP.OPEN_EXTERNAL, url),
    showOpenDialog: options => ipcRenderer.invoke(IPC_CHANNELS.APP.SHOW_OPEN_DIALOG, options),
    showSaveDialog: options => ipcRenderer.invoke(IPC_CHANNELS.APP.SHOW_SAVE_DIALOG, options),
    // State persistence
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_STATE),
    setState: partial => ipcRenderer.invoke(IPC_CHANNELS.APP.SET_STATE, partial),
    saveTabs: (tabs, activeTabId) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP.SAVE_TABS, tabs, activeTabId),
    getTabs: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_TABS),
    // GoldenLayout persistence
    saveLayout: config => ipcRenderer.invoke(IPC_CHANNELS.APP.SAVE_LAYOUT, config),
    getLayout: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_LAYOUT),
    saveToFile: (options, content) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP.SAVE_TO_FILE, options, content),
  },

  workspace: {
    openFolder: path => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.OPEN_FOLDER, path),
    getFiles: path => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.GET_FILES, path),
    readFile: filePath => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.READ_FILE, filePath),
    writeFile: (filePath, content) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.WRITE_FILE, filePath, content),
    createFile: (filePath, content) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.CREATE_FILE, filePath, content),
    deleteFile: filePath => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.DELETE_FILE, filePath),
    renameFile: (oldPath, newPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE.RENAME_FILE, oldPath, newPath),
    onFileChanged: callback => createEventListener(IPC_CHANNELS.WORKSPACE.FILE_CHANGED, callback),
  },

  theme: {
    getNative: () => ipcRenderer.invoke(IPC_CHANNELS.THEME.GET_NATIVE),
    onChanged: callback => createEventListener(IPC_CHANNELS.THEME.CHANGED, callback),
  },

  credentials: {
    getKeychainStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIALS.GET_KEYCHAIN_STATUS),
    onKeychainStatusChanged: callback =>
      createEventListener(IPC_CHANNELS.CREDENTIALS.KEYCHAIN_STATUS_CHANGED, callback),
  },

  menu: {
    // File menu
    onNewConnection: callback => createEventListener(MENU_CHANNELS.NEW_CONNECTION, callback),
    onNewQuery: callback => createEventListener(MENU_CHANNELS.NEW_QUERY, callback),
    onOpenQuery: callback => createEventListener(MENU_CHANNELS.OPEN_QUERY, callback),
    onCloseTab: callback => createEventListener(MENU_CHANNELS.CLOSE_TAB, callback),
    onSaveQuery: callback => createEventListener(MENU_CHANNELS.SAVE_QUERY, callback),
    onSaveQueryAs: callback => createEventListener(MENU_CHANNELS.SAVE_QUERY_AS, callback),
    onExportResults: callback => createEventListener(MENU_CHANNELS.EXPORT_RESULTS, callback),

    // Edit menu
    onCopy: callback => createEventListener(MENU_CHANNELS.COPY, callback),
    onFind: callback => createEventListener(MENU_CHANNELS.FIND, callback),
    onReplace: callback => createEventListener(MENU_CHANNELS.REPLACE, callback),
    onFormatSql: callback => createEventListener(MENU_CHANNELS.FORMAT_SQL, callback),
    onToggleComment: callback => createEventListener(MENU_CHANNELS.TOGGLE_COMMENT, callback),

    // Query menu
    onExecuteQuery: callback => createEventListener(MENU_CHANNELS.EXECUTE_QUERY, callback),
    onExecuteSelection: callback => createEventListener(MENU_CHANNELS.EXECUTE_SELECTION, callback),
    onCancelQuery: callback => createEventListener(MENU_CHANNELS.CANCEL_QUERY, callback),
    onQueryHistory: callback => createEventListener(MENU_CHANNELS.QUERY_HISTORY, callback),

    // Server menu
    onDisconnect: callback => createEventListener(MENU_CHANNELS.DISCONNECT, callback),
    onRefresh: callback => createEventListener(MENU_CHANNELS.REFRESH, callback),

    // Database menu
    onNewDatabase: callback => createEventListener(MENU_CHANNELS.NEW_DATABASE, callback),
    onBackup: callback => createEventListener(MENU_CHANNELS.BACKUP, callback),
    onRestore: callback => createEventListener(MENU_CHANNELS.RESTORE, callback),

    // View menu
    onShowWelcome: callback => createEventListener(MENU_CHANNELS.SHOW_WELCOME, callback),
    onToggleSidebar: callback => createEventListener(MENU_CHANNELS.TOGGLE_SIDEBAR, callback),
    onToggleChat: callback => createEventListener(MENU_CHANNELS.TOGGLE_CHAT, callback),
    onToggleResults: callback => createEventListener(MENU_CHANNELS.TOGGLE_RESULTS, callback),

    // Window menu
    onNextTab: callback => createEventListener(MENU_CHANNELS.NEXT_TAB, callback),
    onPreviousTab: callback => createEventListener(MENU_CHANNELS.PREVIOUS_TAB, callback),

    // Settings/Help
    onOpenSettings: callback => createEventListener(MENU_CHANNELS.OPEN_SETTINGS, callback),
    onOpenAiSetup: callback => createEventListener(MENU_CHANNELS.OPEN_AI_SETUP, callback),
    onShowShortcuts: callback => createEventListener(MENU_CHANNELS.SHOW_SHORTCUTS, callback),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('joinery', joineryAPI);

// Type declaration for renderer
declare global {
  interface Window {
    joinery: JoineryAPI;
  }
}
