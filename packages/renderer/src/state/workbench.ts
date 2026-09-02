/**
 * The shell's own geometry: how wide the sidebar is, whether it is collapsed, how wide the chat side
 * panel is, and (since Task 10) how the query tab splits between its editor and its results.
 * Conventions: `capabilities.ts`.
 *
 * The first three are the ones the Angular shell kept in component signals and wrote to
 * `AppState` by hand (`shell.component.ts:425-448`), which is why they were the only shell
 * state that survived a restart. They live in a store here for two reasons: the native-menu
 * bridge toggles the sidebar without owning the component that renders it, and the boot
 * sequence has to hydrate them before the shell paints or the sidebar visibly jumps from 280px
 * to its saved width on first frame.
 *
 * ── Which `AppState` fields, and why not the React sub-object ─────────────────────────────
 *
 * `sidebarWidth`, `sidebarCollapsed` and `chatPanelWidth` are TOP-LEVEL `AppState` fields that
 * already exist and that the Angular renderer reads and writes today (PLAN.md §1.7). So this
 * store writes them where they already live rather than shadowing them under
 * `reactRendererState` — during coexistence a user who resizes the sidebar in one renderer
 * should find it resized in the other. `app.setState` is a shallow top-level merge, so writing
 * these three cannot disturb the React sub-object sitting beside them.
 *
 * ── The write path ────────────────────────────────────────────────────────────────────────
 *
 * Writes are debounced, because the drag handler runs per pointer-move frame and every write is
 * an IPC call ending in a synchronous `electron-store` write on the main thread. The Angular
 * original avoided that by writing only on mouse-up, which is the same idea implemented at the
 * call site — and therefore forgettable at the next call site. Here it is the store's property.
 *
 * Nothing gates these writes on hydration, unlike tabs and layout (see `state/tab.ts`), and the
 * asymmetry is deliberate: the worst case here is a saved sidebar width being overwritten with
 * the default, whereas an early tab write destroys the user's unsaved SQL. Hydration still
 * happens before the shell paints, and every write path is a user gesture that cannot fire
 * before then.
 */

import { create } from 'zustand';
import { ipc, isIpcAvailable } from '../ipc';
import { diagnostics } from './diagnostics';

/** PROPOSAL §2.4 has no opinion on these; they are the Angular values (`shell.component.ts:23-25`). */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 280;

export const CHAT_PANEL_MIN_WIDTH = 280;
export const CHAT_PANEL_MAX_WIDTH = 640;
export const CHAT_PANEL_DEFAULT_WIDTH = 360;

/**
 * The query tab's editor/results split, as a percentage of the pane. The bounds are the Angular
 * ones (`query.component.ts:2094`: `Math.max(10, Math.min(90, …))`), and 50 is `AppState`'s own
 * default (`main/src/services/config/app-state.ts:14`).
 *
 * Task 10 added this to the store, and it is the one field here that was persisted but DEAD: main has
 * had `editorHeightPercent` with a getter and a setter since before the rewrite, while the Angular
 * query component kept the value in a component signal and never read or wrote `AppState` at all —
 * so the split reset to 50% on every launch. PLAN.md §1.7 lists the field as state that must
 * round-trip, so it is hydrated and persisted here with the other three.
 */
export const EDITOR_HEIGHT_MIN_PERCENT = 10;
export const EDITOR_HEIGHT_MAX_PERCENT = 90;
export const EDITOR_HEIGHT_DEFAULT_PERCENT = 50;

/** One frame is 16ms; 250 collapses a whole drag into one write without feeling lossy. */
const SAVE_DEBOUNCE_MS = 250;

/** Keeps a hand-edited or stale persisted value from producing an unusable shell. */
export function clampWidth(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface WorkbenchState {
  readonly sidebarWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly chatPanelWidth: number;
  /** The query tab's editor/results split. See the constants above for why it is here. */
  readonly editorHeightPercent: number;

  /** Reads the four fields out of `AppState`. Called once, from the boot sequence. */
  readonly hydrate: () => Promise<void>;

  /**
   * Sends the pending debounced write now and resolves once it has landed; a no-op when nothing is
   * pending. Registered with `persistence/flush-on-exit.ts` by the shell, which is its only caller
   * — J-74 was a drag inside the 250ms window followed by the window going away, which dropped the
   * value entirely because the timer died with the page before the IPC call was ever made.
   *
   * The promise matters on the quit path: main does not write `AppState` to disk until the renderer
   * says it is done, so "done" has to mean the `setState` call has been processed, not merely sent.
   */
  readonly flushPendingWrites: () => Promise<void>;

  readonly setSidebarWidth: (width: number) => void;
  readonly resetSidebarWidth: () => void;
  readonly toggleSidebar: () => void;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly setChatPanelWidth: (width: number) => void;
  readonly setEditorHeightPercent: (percent: number) => void;
  readonly resetEditorHeightPercent: () => void;
}

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;

export function createWorkbenchStore() {
  // A debounce handle is a resource, not state — the same call the tab store makes.
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  return create<WorkbenchState>()((set, get) => {
    /**
     * The write itself. Re-checks the bridge, because every caller reaches it later than its own
     * availability check: the debounce is 250ms late and the flush runs while the window is being
     * torn down. `ipc()` throws when the bridge has gone — which a partial bridge does
     * synchronously rather than as a rejection — and a throw from a timer or an unload listener has
     * no caller to catch it, so it surfaces as an uncaught error rather than a log line. Found by
     * Task 16's object-search suite, which toggles the sidebar and then unmounts inside the
     * debounce window.
     */
    const writeNow = (): Promise<void> => {
      if (!isIpcAvailable()) return Promise.resolve();
      try {
        return ipc()
          .app.setState({
            sidebarWidth: get().sidebarWidth,
            sidebarCollapsed: get().sidebarCollapsed,
            chatPanelWidth: get().chatPanelWidth,
            editorHeightPercent: get().editorHeightPercent,
          })
          .catch((error: unknown) => diagnostics.error('failed to persist shell geometry', error));
      } catch (error) {
        diagnostics.error('failed to persist shell geometry', error);
        return Promise.resolve();
      }
    };

    const persist = (): void => {
      if (!isIpcAvailable()) return;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        saveTimeout = null;
        // Nothing to await on the timer path: `writeNow` reports its own failures.
        void writeNow();
      }, SAVE_DEBOUNCE_MS);
    };

    return {
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      chatPanelWidth: CHAT_PANEL_DEFAULT_WIDTH,
      editorHeightPercent: EDITOR_HEIGHT_DEFAULT_PERCENT,

      hydrate: async () => {
        if (!isIpcAvailable()) return;
        try {
          const state = await ipc().app.getState();
          set({
            sidebarWidth: clampWidth(
              state.sidebarWidth,
              SIDEBAR_MIN_WIDTH,
              SIDEBAR_MAX_WIDTH,
              SIDEBAR_DEFAULT_WIDTH
            ),
            sidebarCollapsed: state.sidebarCollapsed === true,
            chatPanelWidth: clampWidth(
              state.chatPanelWidth ?? CHAT_PANEL_DEFAULT_WIDTH,
              CHAT_PANEL_MIN_WIDTH,
              CHAT_PANEL_MAX_WIDTH,
              CHAT_PANEL_DEFAULT_WIDTH
            ),
            editorHeightPercent: clampWidth(
              state.editorHeightPercent ?? EDITOR_HEIGHT_DEFAULT_PERCENT,
              EDITOR_HEIGHT_MIN_PERCENT,
              EDITOR_HEIGHT_MAX_PERCENT,
              EDITOR_HEIGHT_DEFAULT_PERCENT
            ),
          });
        } catch (error) {
          diagnostics.error('failed to read shell geometry; using defaults', error);
        }
      },

      flushPendingWrites: () => {
        // The pending-timer check is what makes this safe to call on every exit: with nothing
        // pending there is nothing to write, so an exit cannot turn into a write of its own.
        if (!saveTimeout) return Promise.resolve();
        clearTimeout(saveTimeout);
        saveTimeout = null;
        return writeNow();
      },

      setSidebarWidth: width => {
        const next = clampWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH);
        if (next === get().sidebarWidth) return;
        set({ sidebarWidth: next });
        persist();
      },

      resetSidebarWidth: () => get().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH),

      toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),

      setSidebarCollapsed: collapsed => {
        if (collapsed === get().sidebarCollapsed) return;
        set({ sidebarCollapsed: collapsed });
        persist();
      },

      setChatPanelWidth: width => {
        const next = clampWidth(
          width,
          CHAT_PANEL_MIN_WIDTH,
          CHAT_PANEL_MAX_WIDTH,
          CHAT_PANEL_DEFAULT_WIDTH
        );
        if (next === get().chatPanelWidth) return;
        set({ chatPanelWidth: next });
        persist();
      },

      setEditorHeightPercent: percent => {
        const next = clampWidth(
          percent,
          EDITOR_HEIGHT_MIN_PERCENT,
          EDITOR_HEIGHT_MAX_PERCENT,
          EDITOR_HEIGHT_DEFAULT_PERCENT
        );
        if (next === get().editorHeightPercent) return;
        set({ editorHeightPercent: next });
        persist();
      },

      resetEditorHeightPercent: () => get().setEditorHeightPercent(EDITOR_HEIGHT_DEFAULT_PERCENT),
    };
  });
}

export const workbenchStore = createWorkbenchStore();
export const useWorkbenchStore = workbenchStore;
