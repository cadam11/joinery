/**
 * The tab store's debounced save, and the flush that empties it on the way out (J-74).
 *
 * The rest of this store is covered where its collaborators are — `persistence/hydrate.spec.ts` for
 * the restore-before-save gate and `shell/boot.spec.ts` for the boot ordering. What is asserted here
 * is the one property those two cannot see: a keystroke schedules a 500ms write of the tab's SQL
 * (`setTabContent` → `scheduleSave`), so the window going away inside that window used to lose the
 * last thing the user typed. Same shape as the geometry bug J-74 was filed for, with the user's SQL
 * at stake instead of a sidebar width.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createAppStateDouble, type AppStateDouble } from '../test/app-state-double';
import { setDiagnosticsSink } from './diagnostics';
import { createTabStore } from './tab';

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

/** A query tab with the persistence gate already open, and the save it fired on open settled. */
function openQueryTab(): { store: ReturnType<typeof createTabStore>; tabId: string } {
  const store = createTabStore();
  store.getState().unlockPersistence();
  const tabId = store.getState().openTab({ type: 'query', title: 'Query 1', icon: 'code' });
  return { store, tabId };
}

describe('the tab store’s debounced save', () => {
  it('collapses a burst of keystrokes into one write', () => {
    const { store, tabId } = openQueryTab();
    const opened = bridge.calls.saveTabs;

    for (const sql of ['S', 'SE', 'SEL', 'SELECT 1']) store.getState().setTabContent(tabId, sql);
    expect(bridge.calls.saveTabs).toBe(opened);

    vi.advanceTimersByTime(500);
    expect(bridge.calls.saveTabs).toBe(opened + 1);
  });

  it('persists a keystroke that happened inside the debounce window', () => {
    const { store, tabId } = openQueryTab();
    const opened = bridge.calls.saveTabs;

    store.getState().setTabContent(tabId, 'SELECT 1');
    vi.advanceTimersByTime(100);
    expect(bridge.calls.saveTabs).toBe(opened);

    store.getState().flushPendingSave();

    expect(bridge.calls.saveTabs).toBe(opened + 1);
    expect(bridge.snapshot().openTabs?.[0]?.content).toBe('SELECT 1');
  });

  it('does not write a second time when the debounce would have fired', () => {
    const { store, tabId } = openQueryTab();
    const opened = bridge.calls.saveTabs;

    store.getState().setTabContent(tabId, 'SELECT 1');
    store.getState().flushPendingSave();
    vi.advanceTimersByTime(500);

    expect(bridge.calls.saveTabs).toBe(opened + 1);
  });

  it('writes nothing when no save is pending', () => {
    const { store } = openQueryTab();
    const opened = bridge.calls.saveTabs;

    store.getState().flushPendingSave();

    expect(bridge.calls.saveTabs).toBe(opened);
  });

  it('does not fire an IPC call after the bridge has gone', () => {
    const { store, tabId } = openQueryTab();
    store.getState().setTabContent(tabId, 'SELECT 1');
    const opened = bridge.calls.saveTabs;
    removeJoineryMock();

    expect(() => store.getState().flushPendingSave()).not.toThrow();
    expect(bridge.calls.saveTabs).toBe(opened);
  });
});
