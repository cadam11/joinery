/**
 * The one namespaced sub-object the React renderer owns inside main-process `AppState`, and the
 * only writer of it.
 *
 * ── Why a sub-object, and why one writer ─────────────────────────────────────────────────────
 *
 * PLAN.md §7.5 records that `app.setState(partial)` is an unvalidated merge: whatever the renderer
 * sends is spread over the persisted state (`packages/main/src/services/config/app-state.ts:66-69`).
 * That is a shallow spread, which has two consequences this module exists to contain:
 *
 * 1. Anything the React renderer adds lands at the top level of a file the Angular renderer and
 *    the whole main process also read. So everything goes under ONE key, `reactRendererState`,
 *    typed here and never mentioned in `packages/shared` (which this task may not touch).
 * 2. The spread replaces that key WHOLESALE. A caller that wrote `{ reactRendererState: { settings } }`
 *    would silently delete the migrated snippets sitting next to it. So there is exactly one write
 *    path — `update()` — it is a read-modify-write, and it is serialized against itself.
 *
 * `update()` takes a function rather than a patch object on purpose: the read happens *inside* the
 * critical section, so a mutator sees every earlier write and can decide "nothing to do" from the
 * current value. That is what makes the localStorage migration idempotent without a lock of its own
 * (`migration.ts`).
 *
 * ── What is NOT here ─────────────────────────────────────────────────────────────────────────
 *
 * No localStorage. This module never reads or writes browser storage; `legacy-local-storage.ts`
 * reads the Angular keys (read-only, forever) and `theme-mirror.ts` owns the one small key the
 * pre-mount FOUC script needs. Keeping those apart is what makes "no code path can overwrite the
 * user's Angular localStorage" checkable by reading three short files instead of the whole app.
 */

import type {
  AppState,
  EditorSettings,
  GridSettings,
  QuerySettings,
  ThemePreference,
} from '@joinery/shared';
import { ipc, isIpcAvailable } from '../ipc';
import { diagnostics } from '../state/diagnostics';

/** Schema version of the sub-object. Bump when a field's meaning changes, not when one is added. */
export const REACT_RENDERER_STATE_VERSION = 1;

/** The single `AppState` key this renderer owns. */
export const REACT_RENDERER_STATE_KEY = 'reactRendererState';

/**
 * One saved SQL snippet, in the shape `snippet-library.component.ts:19-25` persisted. The whole
 * snippet library lived in localStorage and nowhere else (PLAN.md 0.5), so this is a data contract
 * with existing user data, not a design choice — do not "improve" it.
 *
 * Three fields are optional here although the Angular type declares all five as required, and that
 * is deliberate: the source is a JSON blob in a user's browser profile, so the type says what
 * `isSqlSnippet` can actually guarantee rather than what the writer intended. `id` and `sql` are
 * the two a snippet is meaningless without.
 */
export interface SqlSnippet {
  id: string;
  sql: string;
  name?: string;
  tags?: string[];
  createdAt?: string;
}

/**
 * The single snippet predicate. Shared by the localStorage reader and the persisted-state validator
 * on purpose: two different thresholds would mean a snippet that migrates in and then vanishes on
 * the next read, which is the precise failure this task exists to avoid.
 */
export function isSqlSnippet(value: unknown): value is SqlSnippet {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['sql'] === 'string';
}

/**
 * A persisted settings object, as `joinery-settings` actually holds one.
 *
 * Not `Partial<AppSettings>`: that makes each group optional but still demands every field inside a
 * group that is present, and the real thing routinely has a group with one field in it (the Angular
 * service spread partial groups over its defaults too, `settings.service.ts:127-145`). This type is
 * what `mergePersistedSettings` can actually be handed.
 */
export interface PersistedSettings {
  theme?: ThemePreference;
  editor?: Partial<EditorSettings>;
  query?: Partial<QuerySettings>;
  grid?: Partial<GridSettings>;
}

/**
 * Everything the React renderer persists in main-process `AppState`.
 *
 * Every field is optional and absence is always meaningful ("never migrated", "no snippets yet"),
 * because this object is assembled from a user's disk file that may predate any given field.
 */
export interface ReactRendererState {
  /** `REACT_RENDERER_STATE_VERSION` at the time of the last write. */
  version?: number;
  /**
   * ISO timestamp of the one-shot localStorage migration. Its presence is the ONLY thing that
   * stops the migration re-running, and it is written in the same object as the data it describes
   * — see `migration.ts` for why that matters after a crash.
   */
  migratedFromLocalStorageAt?: string;
  /** The settings object as `joinery-settings` held it. Partial: merged over the defaults on read. */
  settings?: PersistedSettings;
  /**
   * ISO timestamp of the last time the **React renderer itself** authored `settings`, stamped by the
   * settings store's write path — which only runs once hydration has confirmed the migration
   * settled. So its presence answers a question no amount of looking at `settings` can: *who wrote
   * this, and did they know what they were overwriting?*
   *
   * `migration.ts` needs that answer and cannot infer it. The marker being absent does not mean
   * nothing considered lives here: a `no-data` boot (fresh install, React first) deliberately writes
   * no marker so a later Angular session can still be lifted, and in that window the user may make a
   * perfectly deliberate settings choice in React. Shape cannot distinguish the two either — a user
   * is allowed to choose exactly the defaults. Only provenance can, so provenance is recorded.
   */
  settingsAuthoredByReactAt?: string;
  /** Tour ids from `joinery:completed-tours`. */
  completedTours?: string[];
  /** From `joinery:welcomeDismissed`. */
  welcomeDismissed?: boolean;
  /** The snippet library from `joinery-snippets`. */
  snippets?: SqlSnippet[];
  /** From `joinery-ctrl-e-execute-confirmed`: the user has ticked "don't ask again" for ⌃E. */
  confirmedCtrlEExecute?: boolean;
  /** From `joinery-flyway-placeholder-values`: remembered placeholder substitutions. */
  flywayPlaceholderValues?: Record<string, string>;
}

/**
 * `Partial<AppState>` plus the key this renderer adds.
 *
 * This is the whole trick that keeps `packages/shared` untouched. An interface that *extends*
 * `Partial<AppState>` is structurally assignable to it (excess-property checking applies to fresh
 * object literals, not to a typed variable), so `setState` accepts it with no cast anywhere. The
 * reverse direction — treating the `AppState` that comes back from `getState()` as this type — is
 * also plain assignment, and it is honest: the extra key really is in the persisted JSON, because
 * main's shallow merge kept it and `getState` structured-clones the lot.
 */
export interface AppStateWithReactRenderer extends Partial<AppState> {
  reactRendererState?: ReactRendererState;
}

/** What `update()` did. Returned rather than thrown so callers can assert on the no-op cases. */
export type RendererStateWriteResult =
  /** The mutator produced a new value and main acknowledged the write. */
  | 'written'
  /** The mutator returned `undefined`: nothing to do, nothing sent. */
  | 'unchanged'
  /** No preload bridge (a plain browser tab, or a unit test without the mock). Nothing sent. */
  | 'unavailable'
  /** The bridge rejected. Logged with the cause; the caller decides whether that is fatal. */
  | 'failed';

/**
 * A mutator. Receives the current sub-object (never a shared reference — mutate it if you like)
 * and returns the value to persist, or `undefined` for "no write needed".
 */
export type ReactRendererStateMutator = (
  current: ReactRendererState
) => ReactRendererState | undefined;

export interface RendererStatePersistence {
  /**
   * The current sub-object, validated field by field. `{}` when there is no bridge.
   *
   * Queued behind any in-flight write, so a read issued after a fire-and-forget `update()` observes
   * it. Several store actions persist without awaiting (a settings change must land in the UI on the
   * same tick), and a reader that could overtake them would be a genuinely confusing bug.
   */
  read(): Promise<ReactRendererState>;
  /** Serialized read-modify-write. See the module comment for why it takes a function. */
  update(mutate: ReactRendererStateMutator): Promise<RendererStateWriteResult>;
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────
//
// The input is a JSON file on the user's disk that main merges without validating (§7.5), so every
// field is treated as untrusted. A field that fails its check is dropped and reported; it never
// takes a sibling with it, and it never throws into a startup path.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

/** Keeps the snippets that parse and reports the ones that do not, rather than dropping all. */
function validateSnippets(value: unknown): SqlSnippet[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter(isSqlSnippet);
  if (kept.length !== value.length) {
    diagnostics.warn('ignored malformed snippet(s) in persisted state', {
      dropped: value.length - kept.length,
      kept: kept.length,
    });
  }
  return kept;
}

const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/**
 * Settings get merged over `DEFAULT_SETTINGS` group by group on the way into the store, which is
 * where a bad *scalar* field ends up replaced by a default — with one exception that has to be
 * caught here instead.
 *
 * `theme` is not just data: `applyThemeAttribute` writes it straight onto `<html>` as `data-theme`,
 * and the merge would happily carry a hand-edited `"neon"` through to it, where it matches no
 * selector in `theme.css` and paints an unstyled canvas. So an illegal preference is dropped at the
 * boundary and the default takes over. Everything else in the object is left alone deliberately —
 * dropping a stray field would discard data the merge is capable of ignoring.
 */
function validateSettings(settings: Record<string, unknown>): PersistedSettings {
  const theme = settings['theme'];
  if (theme === undefined || THEME_PREFERENCES.includes(theme as ThemePreference)) {
    return settings as PersistedSettings;
  }
  diagnostics.warn('ignored an unrecognised persisted theme preference', { theme });
  const { theme: _dropped, ...rest } = settings;
  return rest as PersistedSettings;
}

/**
 * Narrows an unknown blob to the sub-object. Exported because both the reader and the specs need
 * the same answer, and because a caller holding a raw `AppState` (Task 7's startup path) should
 * not re-implement it.
 */
export function validateReactRendererState(value: unknown): ReactRendererState {
  if (!isRecord(value)) return {};

  const validated: ReactRendererState = {};
  if (typeof value['version'] === 'number') validated.version = value['version'];
  if (typeof value['migratedFromLocalStorageAt'] === 'string') {
    validated.migratedFromLocalStorageAt = value['migratedFromLocalStorageAt'];
  }
  if (isRecord(value['settings'])) validated.settings = validateSettings(value['settings']);
  if (typeof value['settingsAuthoredByReactAt'] === 'string') {
    validated.settingsAuthoredByReactAt = value['settingsAuthoredByReactAt'];
  }
  if (isStringArray(value['completedTours'])) validated.completedTours = value['completedTours'];
  if (typeof value['welcomeDismissed'] === 'boolean') {
    validated.welcomeDismissed = value['welcomeDismissed'];
  }
  const snippets = validateSnippets(value['snippets']);
  if (snippets) validated.snippets = snippets;
  if (typeof value['confirmedCtrlEExecute'] === 'boolean') {
    validated.confirmedCtrlEExecute = value['confirmedCtrlEExecute'];
  }
  if (isStringRecord(value['flywayPlaceholderValues'])) {
    validated.flywayPlaceholderValues = value['flywayPlaceholderValues'];
  }
  return validated;
}

// ── The writer ───────────────────────────────────────────────────────────────────────────────

export function createRendererStatePersistence(): RendererStatePersistence {
  /**
   * The serialization point, and the only mutable state in this module. A promise chain rather
   * than a queue: each operation awaits the previous one's settlement before reading, so two
   * concurrent callers cannot both read a pre-write value and clobber each other.
   */
  let tail: Promise<unknown> = Promise.resolve();

  /** Appends to the chain. The only way in, so nothing can jump the queue by accident. */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    // The chain must never carry a rejection forward, or one failure wedges every later write. Both
    // `readState` and `runUpdate` already resolve rather than throw, so this is belt-and-braces —
    // but it makes "the chain cannot wedge" a property of THIS function rather than a convention two
    // other functions have to keep. The caller still gets the un-neutered promise.
    tail = result.catch(() => undefined);
    return result;
  };

  /** The unqueued read. Private, because `runUpdate` runs INSIDE the queue and would deadlock. */
  const readState = async (): Promise<ReactRendererState> => {
    if (!isIpcAvailable()) return {};
    try {
      // Plain assignment, no cast: see AppStateWithReactRenderer's doc comment.
      const appState: AppStateWithReactRenderer = await ipc().app.getState();
      return validateReactRendererState(appState.reactRendererState);
    } catch (error) {
      diagnostics.error('failed to read persisted renderer state', error);
      return {};
    }
  };

  const runUpdate = async (
    mutate: ReactRendererStateMutator
  ): Promise<RendererStateWriteResult> => {
    if (!isIpcAvailable()) return 'unavailable';
    try {
      const next = mutate(await readState());
      if (next === undefined) return 'unchanged';
      const patch: AppStateWithReactRenderer = {
        reactRendererState: { ...next, version: REACT_RENDERER_STATE_VERSION },
      };
      await ipc().app.setState(patch);
      return 'written';
    } catch (error) {
      diagnostics.error('failed to persist renderer state', error);
      return 'failed';
    }
  };

  return {
    read: () => enqueue(readState),

    update: mutate => enqueue(() => runUpdate(mutate)),
  };
}

/** The app-wide instance. Tests build their own with `createRendererStatePersistence()`. */
export const rendererStatePersistence = createRendererStatePersistence();
