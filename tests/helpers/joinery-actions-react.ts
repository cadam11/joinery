/**
 * E2E interaction helpers for the **React** renderer (`packages/renderer`) — the public
 * surface, re-exported from the eleven modules under `tests/helpers/react/`.
 *
 * ── Why this file is a barrel now (Task 20) ───────────────────────────────────
 *
 * It used to be the helpers themselves, and it reached **1,737 lines**: one section appended per
 * Phase B task, so "the connection editor" and "the ERD" and "the Docker panel" were neighbours in
 * one file and nothing but a comment banner separated them. Task 20 split it by surface family —
 * `react/app.ts`, `connections.ts`, `explorer.ts`, `query.ts`, `results.ts`, `backup-restore.ts`,
 * `dialogs.ts`, `overlays.ts`, `chat.ts`, `erd.ts`, `workbench.ts`, `db.ts` — each one under 250
 * lines with a single responsibility and its own rationale header.
 *
 * The barrel stays, and that is a decision rather than laziness: **no spec's import statement had to
 * change**, which is what makes the split provably behaviour-preserving. A suite that was green
 * before a pure re-export is green after it for the same reasons, and a reviewer reading the diff
 * sees moves rather than moves-plus-edits. It also keeps one import path per spec, which is the
 * right ergonomics for a file that pulls fifteen helpers.
 *
 * **Add nothing to this file but re-exports.** A helper belongs in the module that owns its surface.
 *
 * ── Why the name still says `-react` ──────────────────────────────────────────
 *
 * There were two helper trees while the two renderers coexisted, and this one was deliberately not
 * an abstraction over both: the Angular helper was Material-coupled end to end (`mat-form-field`
 * filtered by `mat-label:text-is(…)`, `mat-dialog-container`, `.mat-mdc-menu-panel
 * [role="menuitem"]`), and sharing would have dragged those locators forward. Task 24 deleted it
 * with the renderer it drove. The suffix stays because the tier directories it serves
 * (`tests/e2e-react/`, `-visual`, `-perf`) keep theirs — `tests/__snapshots__/visual-react/` is
 * keyed by them.
 */

export {
  CONNECT_TIMEOUT_MS,
  TEST_MYSQL,
  TEST_PG,
  UI_TIMEOUT_MS,
  applicationMenuPaths,
  clickMenuItem,
  dismissToasts,
  ensureJoineryTestSeeded,
  exactly,
  sendMenuCommand,
  waitForShell,
  withJoineryReact,
} from './react/app';

export {
  connectFromSidebar,
  connectionEditor,
  connectionManager,
  createAndConnectMysql,
  createAndConnectPostgres,
  createPostgresProfile,
  createPostgresProfiles,
  fillMysqlForm,
  fillPostgresForm,
  openConnectionEditor,
  openConnectionMenu,
  saveConnectionEditor,
  selectDatabase,
  selectEditorOption,
  testConnectionInEditor,
} from './react/connections';

export {
  createDatabaseFromSidebar,
  disconnectServer,
  expandTreeRow,
  objectDetailRows,
  objectPanel,
  objectRowCells,
  openNodeMenu,
  openObjectDetail,
  openObjectSection,
  refreshSidebar,
  renameDatabaseFromSidebar,
  serverRow,
  serverRows,
  submitDatabaseName,
  treeRow,
  treeRows,
} from './react/explorer';

export {
  executeQuery,
  executionPlan,
  focusEditor,
  openAnalysisTab,
  openQueryTab,
  planNodeTypes,
  planNodes,
  planTab,
  queryEditor,
  showExecutionPlan,
  suggestions,
  suggestionsContaining,
  typeSql,
  visibleSql,
} from './react/query';

export {
  captureResult,
  copyGridSelection,
  gridColumnHeaders,
  gridColumnValues,
  gridRows,
  gridSortState,
  historyRows,
  openExportMenu,
  openResultHistory,
  openRowDetail,
  pinnedHistoryRows,
  previewForeignKey,
  resultsGrid,
  rowDetailField,
  rowDetailFields,
  rowDetailPanel,
  selectGridRow,
  sortGridColumn,
} from './react/results';

export {
  backupDialog,
  fillRestoreForm,
  missingCliTools,
  openBackupDialog,
  openBackupDialogFromNode,
  openRestoreDialog,
  openRestoreDialogFromNode,
  restoreDialog,
  runBackupTo,
  runRestoreIntoNew,
  runRestoreOver,
  serverFileBrowser,
} from './react/backup-restore';

export {
  aiSetupDialog,
  closeSettings,
  historyEntryRow,
  historyEntryRows,
  openAiSetup,
  openQueryHistory,
  openSchemaDiff,
  openSchemaDiffFromNode,
  openSettings,
  openSettingsGroup,
  queryHistoryDialog,
  resolvedTheme,
  schemaDiffDialog,
  searchQueryHistory,
  selectDiffDatabase,
  setNumberSetting,
  setTheme,
  setToggleSetting,
  settingsDialog,
  type SettingsGroup,
} from './react/dialogs';

export {
  closeDockerPanel,
  closeOverlay,
  createSnippet,
  dockerContainerNames,
  dockerContainerRow,
  dockerPanel,
  dockerPip,
  filterOverlay,
  objectSearchRow,
  openDockerPanel,
  openObjectSearch,
  openPalette,
  openPaletteFromEditor,
  openShortcuts,
  openSnippets,
  overlay,
  overlayRows,
  paletteRow,
  paletteRowState,
  runPaletteCommand,
  snippetRow,
  startTour,
  tourOverlay,
  tourStep,
  type OverlayPrefix,
} from './react/overlays';

export {
  chatConversationRow,
  chatCostTier,
  chatPanel,
  chatTab,
  chatTitle,
  chooseChatCostTier,
  closeChatPanel,
  createChatConversation,
  deleteChatConversation,
  openChatConversations,
  openChatPanel,
  pinChatModel,
  renameChatConversation,
  seedAiProvider,
} from './react/chat';

export {
  erdCanvas,
  erdDetails,
  erdEdge,
  erdNode,
  erdNodes,
  erdPanel,
  erdTransform,
  erdZoomLevel,
  openRelationships,
} from './react/erd';

export {
  activeTabTitle,
  closeTabTitled,
  dragResizeHandle,
  newQueryTabFromMenu,
  openWelcome,
  resizeHandle,
  resizeHandleValue,
  welcomePanel,
  workspaceTab,
  workspaceTabTitles,
  workspaceTabs,
} from './react/workbench';

export {
  WIDE_SCHEMA_DATABASE,
  dropDatabasesMatching,
  dropWideSchema,
  ensureWideSchema,
  tableNameFor,
} from './react/db';

export {
  AG_GRID_EXEMPTION,
  COMMAND_OVERLAY_INPUT_EXEMPTION,
  MONACO_EXEMPTION,
  ROVING_TABLIST_EXEMPTION,
  attachFocusTable,
  unindicatedStops,
  walkTabOrder,
  type FocusExemption,
  type FocusStop,
  type FocusWalk,
  type WalkOutcome,
} from './react/a11y';
