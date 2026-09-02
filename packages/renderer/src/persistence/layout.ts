/**
 * The workspace-layout persistence contract for the React renderer. Decision C, in code.
 *
 * ── The decision ─────────────────────────────────────────────────────────────────────────────
 *
 * Craig's binding answer to Decision C (PLAN.md §5): *migrate by reset*. The renderer rebuilds the
 * workspace from the still-valid `saveTabs`/`getTabs` list and writes its own shape from then on.
 * J-89 finished the job by renaming the persisted key from `goldenLayoutConfig` to
 * `AppState.workspaceLayout` with no migration: anything left under the old key is dead bytes that
 * nothing in this app reads.
 *
 * ── The shape, and why it is this shape ──────────────────────────────────────────────────────
 *
 * `LayoutConfig` is `{ root: LayoutNode; dimensions? }`, and `LayoutNode` has an optional
 * `componentType: string` and `componentState: Record<string, unknown>`. So a React layout is a
 * single component node — no `content` array — carrying the opaque Dockview blob in its
 * `componentState`. That satisfies the existing type with no change to `packages/shared`, and it
 * makes the stored value **self-identifying**: `decodeReactLayout` returns `undefined` for anything
 * that is not a current-version React envelope, so a corrupted, foreign or future-version blob
 * degrades to "rebuild from the tab list" instead of to a crash.
 *
 * `workspace.tsx` owns the Dockview wiring and decides what goes in `dockview`; this module owns the
 * envelope and refuses to look inside it.
 */

import type { LayoutConfig } from '@joinery/shared';
import { ipc, isIpcAvailable } from '../ipc';
import { diagnostics } from '../state/diagnostics';

/** The marker that makes a stored `LayoutConfig` recognisably ours. Never change it in place. */
export const REACT_LAYOUT_COMPONENT_TYPE = 'joinery:react-workspace';

/** Bump when `ReactLayoutPayload`'s meaning changes; an older version decodes to `undefined`. */
export const REACT_LAYOUT_VERSION = 1;

export interface ReactLayoutPayload {
  readonly version: number;
  /** Dockview's serialized state, opaque here. JSON-serializable — it crosses the IPC boundary. */
  readonly dockview: Record<string, unknown>;
  /** The focused panel, kept beside the blob so a reader need not parse Dockview's tree to find it. */
  readonly activeTabId: string | null;
}

/** Wraps a payload in the one `LayoutConfig` shape the React renderer writes. */
export function encodeReactLayout(payload: ReactLayoutPayload): LayoutConfig {
  return {
    root: {
      type: 'component',
      componentType: REACT_LAYOUT_COMPONENT_TYPE,
      // `title` so a human reading app-state.json can tell what wrote this.
      title: 'Joinery React workspace',
      componentState: {
        version: payload.version,
        activeTabId: payload.activeTabId,
        dockview: payload.dockview,
      },
    },
  };
}

/**
 * The payload if this config is a React one of a version we understand, `undefined` otherwise —
 * which covers a foreign tree, a future version, and a corrupted blob alike. Never throws.
 */
export function decodeReactLayout(
  config: LayoutConfig | undefined
): ReactLayoutPayload | undefined {
  const root = config?.root;
  if (!root || root.type !== 'component' || root.componentType !== REACT_LAYOUT_COMPONENT_TYPE) {
    return undefined;
  }

  const state = root.componentState;
  if (!state || state['version'] !== REACT_LAYOUT_VERSION) return undefined;

  const dockview = state['dockview'];
  if (typeof dockview !== 'object' || dockview === null || Array.isArray(dockview)) {
    diagnostics.warn('stored React layout has no usable Dockview state; rebuilding from tabs', {
      dockview,
    });
    return undefined;
  }

  const activeTabId = state['activeTabId'];
  return {
    version: REACT_LAYOUT_VERSION,
    dockview: dockview as Record<string, unknown>,
    activeTabId: typeof activeTabId === 'string' ? activeTabId : null,
  };
}

/** `locked` is the restore-before-save gate refusing the write — see `LayoutPersistence.unlock`. */
export type LayoutWriteResult = 'saved' | 'locked' | 'unavailable' | 'failed';

/**
 * The debounce window on `scheduleSave`. Matches the Angular layout save debounce
 * (`golden-layout-container.component.ts:645`), which is where the figure comes from.
 */
export const LAYOUT_SAVE_DEBOUNCE_MS = 500;

/**
 * Reads the current arrangement out of the dock. A closure rather than a value, because it runs
 * once — when the debounced write actually goes out — and `DockviewApi.toJSON()` is not free:
 * `onDidLayoutChange` fires per change, including per frame of a sash drag, so serializing at
 * schedule time would put back the cost the debounce exists to avoid.
 */
export type ReadLayoutPayload = () => ReactLayoutPayload;

export interface LayoutPersistence {
  /**
   * The stored React layout, or `undefined` when there is none to honour. Read-only: a value it
   * does not recognise is left exactly where it is.
   */
  read(): Promise<ReactLayoutPayload | undefined>;
  /** Persists a React layout. */
  save(payload: ReactLayoutPayload): Promise<LayoutWriteResult>;
  /**
   * Debounces a save by `LAYOUT_SAVE_DEBOUNCE_MS`, replacing any pending one. `readPayload` runs
   * once, when the write goes out.
   */
  scheduleSave(readPayload: ReadLayoutPayload): void;
  /**
   * Sends a pending debounced save now and resolves once it has landed; a no-op when nothing is
   * pending. Registered with `flush-on-exit.ts` by the shell — J-74: the debounce used to be a
   * `useRef` timer in `shell/workspace/workspace.tsx` whose only cleanup DISCARDED the pending
   * arrangement, so a panel moved inside the window and followed by the window going away was
   * lost.
   */
  flushPendingSave(): Promise<void>;
  /**
   * Drops a pending save without sending it. For the workspace tearing down (a hot reload, a
   * remount): the dock handle its `readPayload` closed over is going away with it.
   */
  cancelPendingSave(): void;
  /**
   * Opens the write path. Called by `shell/boot.ts`'s `markRestoreApplied` — that is, by the
   * workspace, at the moment it has APPLIED the restored arrangement, not when `hydrateWorkspace`
   * read it. (It used to be the latter, which left the arrangement unapplied for an effect and a
   * debounce tick with the gate already open.) Same gate as `tabStore.unlockPersistence`, for the
   * same reason, at the other of the two write paths startup can race.
   *
   * The layout half is the cheaper loss of the two (a window arrangement, not the user's SQL)
   * but it is the likelier one: Dockview fires `onDidLayoutChange` while it builds its initial
   * empty state, so the workspace component has a live "save the layout" subscription before it
   * has any panels. Gating at the leaf means a mistake in that component's effect ordering
   * cannot overwrite the saved arrangement with the empty one.
   */
  unlock(): void;
  /** Whether the write path is open. For tests and for the boot-sequence assertion. */
  isUnlocked(): boolean;
}

export function createLayoutPersistence(): LayoutPersistence {
  /** The restore-before-save gate. See `LayoutPersistence.unlock`. */
  let writesUnlocked = false;

  // A debounce handle and the payload reader it will call are resources, not state. They are
  // cleared together, always: a live timer with no reader, or the reverse, is unreachable by
  // construction and every path below keeps it that way.
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingRead: ReadLayoutPayload | null = null;

  /**
   * Sends the pending write. The single exit from "pending" to "written", and the only place the
   * two resources above are cleared before the write rather than after it — so a `readPayload`
   * that throws cannot leave a pending save that no timer will ever fire.
   */
  const writePending = (): Promise<void> => {
    const readPayload = pendingRead;
    saveTimeout = null;
    pendingRead = null;
    if (!readPayload) return Promise.resolve();

    let payload: ReactLayoutPayload;
    try {
      payload = readPayload();
    } catch (error) {
      // Reading the dock is the caller's code, and this runs from a timer or an unload listener —
      // neither has a caller to catch a throw, so it would surface as an uncaught error.
      diagnostics.error('failed to read the workspace arrangement to persist it', error);
      return Promise.resolve();
    }

    // `locked` is the restore-before-save gate doing its job and `unavailable` is browser mode —
    // neither is a failure, and `failed` has already logged its own cause inside `save`.
    return persistence.save(payload).then(result => {
      if (result !== 'locked') return;
      diagnostics.warn('layout change discarded: the workspace has not finished restoring', {
        activeTabId: payload.activeTabId,
      });
    });
  };

  const persistence: LayoutPersistence = {
    unlock: () => {
      writesUnlocked = true;
    },

    isUnlocked: () => writesUnlocked,

    scheduleSave: readPayload => {
      if (saveTimeout) clearTimeout(saveTimeout);
      pendingRead = readPayload;
      // Nothing to await on the timer path: `writePending` reports its own failures.
      saveTimeout = setTimeout(() => void writePending(), LAYOUT_SAVE_DEBOUNCE_MS);
    },

    flushPendingSave: () => {
      // The pending-timer check is what makes this safe to call on every exit: with nothing
      // pending there is nothing to write, so an exit cannot turn into a write of its own.
      if (!saveTimeout) return Promise.resolve();
      clearTimeout(saveTimeout);
      return writePending();
    },

    cancelPendingSave: () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = null;
      pendingRead = null;
    },

    read: async () => {
      if (!isIpcAvailable()) return undefined;
      try {
        return decodeReactLayout(await ipc().app.getLayout());
      } catch (error) {
        diagnostics.error('failed to read the persisted layout', error);
        return undefined;
      }
    },

    save: async payload => {
      if (!writesUnlocked) return 'locked';
      if (!isIpcAvailable()) return 'unavailable';
      try {
        await ipc().app.saveLayout(encodeReactLayout(payload));
        return 'saved';
      } catch (error) {
        diagnostics.error('failed to persist the layout', error);
        return 'failed';
      }
    },
  };

  return persistence;
}

/** The app-wide instance. */
export const layoutPersistence = createLayoutPersistence();
