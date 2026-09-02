/**
 * Shell geometry: the three `AppState` fields that made the Angular sidebar the only piece of shell
 * state that survived a restart, plus the fourth that Task 10 brought back to life.
 *
 * Two things are worth asserting. The **clamp**, because the values come off disk and a hand-edited
 * or stale width must not produce a sidebar wider than the window or narrower than its own content.
 * And the **debounce**, because the drag handler runs per pointer-move frame and each write is an IPC
 * call ending in a synchronous `electron-store` write on the main thread — the Angular version
 * avoided that by writing only on mouse-up, i.e. at the call site, which is the kind of discipline
 * that survives exactly as long as the next call site.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createAppStateDouble, type AppStateDouble } from '../test/app-state-double';
import { setDiagnosticsSink } from './diagnostics';
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  EDITOR_HEIGHT_DEFAULT_PERCENT,
  EDITOR_HEIGHT_MAX_PERCENT,
  EDITOR_HEIGHT_MIN_PERCENT,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampWidth,
  createWorkbenchStore,
} from './workbench';

let bridge: AppStateDouble;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  bridge = createAppStateDouble();
  teardowns.push(installJoineryMock({ app: bridge.app }));
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
});

afterEach(() => {
  vi.useRealTimers();
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
});

describe('clampWidth', () => {
  it('keeps a value inside its bounds and rounds it', () => {
    expect(clampWidth(300.4, 180, 500, 280)).toBe(300);
    expect(clampWidth(80, 180, 500, 280)).toBe(180);
    expect(clampWidth(9_000, 180, 500, 280)).toBe(500);
  });

  it('falls back for a value that is not a number at all', () => {
    // `AppState` comes off disk through an unvalidated merge; `NaN` is reachable.
    expect(clampWidth(Number.NaN, 180, 500, 280)).toBe(280);
    expect(clampWidth(Number.POSITIVE_INFINITY, 180, 500, 280)).toBe(280);
  });
});

describe('the workbench store', () => {
  it('starts at the defaults', () => {
    const workbench = createWorkbenchStore();

    expect(workbench.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(workbench.getState().sidebarCollapsed).toBe(false);
    expect(workbench.getState().chatPanelWidth).toBe(CHAT_PANEL_DEFAULT_WIDTH);
    expect(workbench.getState().editorHeightPercent).toBe(EDITOR_HEIGHT_DEFAULT_PERCENT);
  });

  it('hydrates from AppState, clamping what it finds', async () => {
    const seeded = createAppStateDouble({
      lastConnectedProfileIds: [],
      lastDatabase: null,
      editorHeightPercent: 50,
      sidebarWidth: 9_000,
      sidebarCollapsed: true,
      showQueryHistory: false,
      openTabs: [],
      activeTabId: null,
      recentWorkspaces: [],
      currentWorkspacePath: null,
      chatPanelWidth: 10,
    });
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: seeded.app }));
    const workbench = createWorkbenchStore();

    await workbench.getState().hydrate();

    expect(workbench.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    expect(workbench.getState().sidebarCollapsed).toBe(true);
    expect(workbench.getState().chatPanelWidth).toBe(280);
  });

  it('hydration is a read — it writes nothing back', async () => {
    const workbench = createWorkbenchStore();
    await workbench.getState().hydrate();

    expect(bridge.calls.setState).toBe(0);
  });

  it('collapses one drag into a single write', () => {
    const workbench = createWorkbenchStore();

    // 40 frames of a drag.
    for (let width = 280; width < 320; width += 1) workbench.getState().setSidebarWidth(width);

    expect(workbench.getState().sidebarWidth).toBe(319);
    expect(bridge.calls.setState).toBe(0);

    vi.advanceTimersByTime(250);
    expect(bridge.calls.setState).toBe(1);
  });

  it('persists all three fields together, and nothing else', () => {
    const workbench = createWorkbenchStore();
    workbench.getState().toggleSidebar();
    vi.advanceTimersByTime(250);

    // A shallow top-level merge (main's `setState`), so writing these three must not disturb the
    // React sub-object sitting beside them.
    expect(bridge.snapshot().sidebarCollapsed).toBe(true);
    expect(bridge.snapshot().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(bridge.snapshot().chatPanelWidth).toBe(CHAT_PANEL_DEFAULT_WIDTH);
    expect(bridge.snapshot().reactRendererState).toBeUndefined();
  });

  it('writes nothing when a setter changes nothing', () => {
    const workbench = createWorkbenchStore();

    workbench.getState().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    workbench.getState().setSidebarCollapsed(false);
    // Below the floor, and already clamped to it.
    workbench.getState().setSidebarWidth(SIDEBAR_MIN_WIDTH);
    workbench.getState().setSidebarWidth(1);
    vi.advanceTimersByTime(250);

    expect(bridge.calls.setState).toBe(1);
  });

  it('resets to the default width', () => {
    const workbench = createWorkbenchStore();
    workbench.getState().setSidebarWidth(420);
    workbench.getState().resetSidebarWidth();

    expect(workbench.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('is inert without a bridge rather than throwing', async () => {
    removeJoineryMock();
    const workbench = createWorkbenchStore();

    await workbench.getState().hydrate();
    workbench.getState().toggleSidebar();
    vi.advanceTimersByTime(250);

    expect(workbench.getState().sidebarCollapsed).toBe(true);
  });

  describe('flushing the pending write on the way out (J-74)', () => {
    it('persists a resize that happened inside the debounce window', () => {
      const workbench = createWorkbenchStore();

      // The bug: the user drags the sidebar and quits before the 250ms window closes.
      workbench.getState().setSidebarWidth(420);
      vi.advanceTimersByTime(100);
      expect(bridge.calls.setState).toBe(0);

      workbench.getState().flushPendingWrites();

      expect(bridge.calls.setState).toBe(1);
      expect(bridge.snapshot().sidebarWidth).toBe(420);
    });

    it('does not write a second time when the debounce would have fired', () => {
      const workbench = createWorkbenchStore();
      workbench.getState().setSidebarWidth(420);

      workbench.getState().flushPendingWrites();
      vi.advanceTimersByTime(250);

      expect(bridge.calls.setState).toBe(1);
    });

    it('writes nothing when no write is pending', () => {
      const workbench = createWorkbenchStore();

      workbench.getState().flushPendingWrites();

      expect(bridge.calls.setState).toBe(0);
    });

    it('does not fire an IPC call after the bridge has gone', () => {
      // The teardown race: the geometry was scheduled while the bridge was live and the flush runs
      // after it went away. `ipc()` throws synchronously there, and a throw inside an unload
      // listener has no caller to catch it.
      const workbench = createWorkbenchStore();
      workbench.getState().setSidebarWidth(420);
      removeJoineryMock();

      expect(() => workbench.getState().flushPendingWrites()).not.toThrow();
      expect(bridge.calls.setState).toBe(0);
    });
  });

  describe('the query tab’s editor/results split (Task 10)', () => {
    // This field has existed in `AppState` — with a getter and a setter in main — since before the
    // rewrite, while the Angular query component kept the split in a component signal and never read or
    // wrote it. So the split reset to 50% on every launch. PLAN.md §1.7 lists it as state that must
    // round-trip, and these are the assertions that make that true.
    it('hydrates the persisted percentage', async () => {
      const seeded = createAppStateDouble({ editorHeightPercent: 72 } as never);
      removeJoineryMock();
      teardowns.push(installJoineryMock({ app: seeded.app }));
      const workbench = createWorkbenchStore();

      await workbench.getState().hydrate();

      expect(workbench.getState().editorHeightPercent).toBe(72);
    });

    it('clamps a percentage that would leave one pane unusable', async () => {
      const seeded = createAppStateDouble({ editorHeightPercent: 99 } as never);
      removeJoineryMock();
      teardowns.push(installJoineryMock({ app: seeded.app }));
      const workbench = createWorkbenchStore();

      await workbench.getState().hydrate();

      expect(workbench.getState().editorHeightPercent).toBe(EDITOR_HEIGHT_MAX_PERCENT);
    });

    it('clamps and persists a set, debounced with the other three fields', () => {
      const workbench = createWorkbenchStore();

      workbench.getState().setEditorHeightPercent(1);
      expect(workbench.getState().editorHeightPercent).toBe(EDITOR_HEIGHT_MIN_PERCENT);

      workbench.getState().setEditorHeightPercent(65);
      vi.advanceTimersByTime(250);

      // One write for the pair, and it carries all four fields — `app.setState` is a shallow top-level
      // merge, so sending them together cannot disturb the React sub-object beside them.
      expect(bridge.calls.setState).toBe(1);
      expect(bridge.snapshot().editorHeightPercent).toBe(65);
    });

    it('resets to the middle', () => {
      const workbench = createWorkbenchStore();
      workbench.getState().setEditorHeightPercent(80);
      workbench.getState().resetEditorHeightPercent();
      expect(workbench.getState().editorHeightPercent).toBe(EDITOR_HEIGHT_DEFAULT_PERCENT);
    });
  });
});
