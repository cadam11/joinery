/**
 * Persistence: main-process `AppState` on one side, the six Angular localStorage keys on the other,
 * and a one-shot migration between them.
 *
 * Read in this order:
 *
 *   renderer-state.ts       the one `AppState` key this renderer owns, and its only writer
 *   legacy-local-storage.ts the six Angular keys: read them, and remove the ones that were lifted
 *   migration.ts            the one-shot lift-then-remove, idempotent via a marker in AppState
 *   theme-mirror.ts         the one localStorage key React writes, for the pre-mount FOUC script
 *   layout.ts               the `LayoutConfig` shape the React app writes to `workspaceLayout`
 *   hydrate.ts              the startup path that ties the above to the Task 4 stores
 *
 * `state/settings.ts` and `state/tab.ts` import the leaf modules DIRECTLY, never this barrel:
 * `hydrate.ts` imports those two stores, so a barrel import from inside them would close a cycle.
 */

export {
  hydrateRendererState,
  hydrateWorkspace,
  type HydratedRendererState,
  type HydrationDeps,
  type WorkspaceHydrationDeps,
} from './hydrate';

// `clearLegacyLocalStorage` is deliberately NOT re-exported: it is the package's only destructive
// call, its safety is a property of having exactly one caller (`migration.ts`), and a barrel export
// would offer it to every future feature with none of the preconditions attached.
export {
  LEGACY_KEYS,
  readLegacyLocalStorage,
  type LegacyLocalStorageReading,
} from './legacy-local-storage';

export {
  createLayoutPersistence,
  decodeReactLayout,
  encodeReactLayout,
  layoutPersistence,
  REACT_LAYOUT_COMPONENT_TYPE,
  REACT_LAYOUT_VERSION,
  type LayoutPersistence,
  type LayoutWriteResult,
  type ReactLayoutPayload,
} from './layout';

export {
  migrateLegacyLocalStorage,
  type MigrationOutcome,
  type MigrationResult,
} from './migration';

export {
  createRendererStatePersistence,
  isSqlSnippet,
  REACT_RENDERER_STATE_KEY,
  REACT_RENDERER_STATE_VERSION,
  rendererStatePersistence,
  validateReactRendererState,
  type AppStateWithReactRenderer,
  type PersistedSettings,
  type ReactRendererState,
  type ReactRendererStateMutator,
  type RendererStatePersistence,
  type RendererStateWriteResult,
  type SqlSnippet,
} from './renderer-state';

export {
  readMirroredThemePreference,
  THEME_MIRROR_KEY,
  writeMirroredThemePreference,
} from './theme-mirror';
