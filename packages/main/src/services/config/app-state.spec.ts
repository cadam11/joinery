import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, LayoutConfig } from '@joinery/shared';
import { AppStateStore } from './app-state';

/** Fresh instance simulating a new process: sees only persisted data. */
function freshInstance(): AppStateStore {
  AppStateStore.resetInstance();
  return AppStateStore.getInstance();
}

describe('AppStateStore (debounced persistence)', () => {
  let store: AppStateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = freshInstance();
    store.clearState();
    store.flush();
  });

  afterEach(() => {
    AppStateStore.getInstance().flush();
    vi.useRealTimers();
  });

  it('setState is visible immediately through getState()', () => {
    store.setState({ lastDatabase: 'db-x', sidebarWidth: 300 });
    expect(store.getState().lastDatabase).toBe('db-x');
    expect(store.getState().sidebarWidth).toBe(300);
  });

  it('consecutive setState calls collapse into one deferred persist', () => {
    store.setOpenTabs([]);
    store.setActiveTabId('tab-9');

    // Nothing persisted yet…
    expect(freshInstance().getState().activeTabId).toBeNull();

    // …but the debounced write carries both mutations. Re-apply on the live
    // instance (freshInstance above replaced the singleton, discarding the
    // unpersisted cache — exactly what a crash would do).
    const live = freshInstance();
    live.setOpenTabs([]);
    live.setActiveTabId('tab-9');
    vi.advanceTimersByTime(1000);

    const fresh = freshInstance();
    expect(fresh.getState().activeTabId).toBe('tab-9');
    expect(fresh.getState().openTabs).toEqual([]);
  });

  it('flush() persists immediately (quit path)', () => {
    store.setLastDatabase('quit-db');
    store.flush();

    expect(freshInstance().getState().lastDatabase).toBe('quit-db');
  });

  it('getState returns a copy — callers cannot mutate the cache', () => {
    const a = store.getState();
    a.lastDatabase = 'mutated';
    expect(store.getState().lastDatabase).not.toBe('mutated');
  });
});

/**
 * J-89 renamed the persisted key `goldenLayoutConfig` → `workspaceLayout` with no migration. Every
 * other test of that rename runs against the renderer's in-memory stand-in for this class, so
 * nothing proved the real store — the one that actually reaches disk — round-trips the new key or
 * leaves the old one alone. These two do, across a simulated restart.
 */
describe('AppStateStore workspace layout', () => {
  /** The envelope shape `renderer/src/persistence/layout.ts` writes: one childless component node. */
  const LAYOUT: LayoutConfig = {
    root: {
      type: 'component',
      componentType: 'joinery:react-workspace',
      componentState: { version: 1, dockview: { grid: 'opaque' } },
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    const store = freshInstance();
    store.clearState();
    store.flush();
  });

  afterEach(() => {
    const store = AppStateStore.getInstance();
    store.clearState();
    store.flush();
    vi.useRealTimers();
  });

  it('persists and restores the layout under workspaceLayout across a restart', () => {
    const store = freshInstance();
    expect(store.getWorkspaceLayout()).toBeUndefined();

    store.setWorkspaceLayout(LAYOUT);
    store.flush();

    const restarted = freshInstance();
    expect(restarted.getWorkspaceLayout()).toEqual(LAYOUT);
    expect(restarted.getState().workspaceLayout).toEqual(LAYOUT);
  });

  it('ignores a layout left on disk under the retired goldenLayoutConfig key', () => {
    // A pre-J-89 install. Craig's ruling (n-04b9b625): no migration, pre-v1 — so the old bytes are
    // neither honoured nor deleted, and the workspace rebuilds from the intact saveTabs/getTabs list.
    const store = freshInstance();
    store.setState({ goldenLayoutConfig: LAYOUT } as unknown as Partial<AppState>);
    store.flush();

    const restarted = freshInstance();
    expect(restarted.getWorkspaceLayout()).toBeUndefined();

    const onDisk = restarted.getState() as AppState & { goldenLayoutConfig?: LayoutConfig };
    expect(onDisk.goldenLayoutConfig).toEqual(LAYOUT);
  });
});
