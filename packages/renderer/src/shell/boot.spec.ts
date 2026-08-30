/**
 * The boot sequence, and the restore-before-save contract.
 *
 * Two claims are asserted here and both are load-bearing enough that a comment would not do:
 *
 * 1. **The ORDER.** Migration and settings first, geometry next, then interactive, then the session
 *    restore, then the workspace restore. Anything reordered is a real regression: a shell that
 *    paints before hydration shows default settings and re-themes; geometry after paint makes the
 *    sidebar jump.
 * 2. **Neither tab nor layout persistence may be writable before the workspace restore has
 *    finished.** This is the Angular-parity hazard the brief calls binding — `saveTabs` serializes
 *    every query tab's SQL, so one early write over an unrestored store destroys the user's work
 *    with no second copy. The test drives the real stores and the real persistence, and checks the
 *    gates at each step rather than trusting the sequence. The two gates open at different moments
 *    (tabs when `hydrateWorkspace` returns, layout when the workspace has APPLIED the arrangement)
 *    and both moments are asserted.
 * 3. **A tab the user opens while the reconnect is still running survives the restore.** The window
 *    is interactive before the workspace is restored, on purpose, so the restore merges rather than
 *    replaces. Third `describe` below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createAppStateDouble, type AppStateDouble } from '../test/app-state-double';
import { setDiagnosticsSink } from '../state/diagnostics';
import { createLayoutPersistence } from '../persistence/layout';
import { createRendererStatePersistence } from '../persistence/renderer-state';
import { hydrateWorkspace } from '../persistence/hydrate';
import { createTabStore } from '../state/tab';
import { createWorkbenchStore } from '../state/workbench';
import { BOOT_STEPS, createBootStore, resetBootLatch, runBoot, type BootStep } from './boot';

let bridge: AppStateDouble;
const teardowns: (() => void)[] = [];

/** A connection store stand-in: the boot sequence only ever calls these three members. */
function stubConnection(
  options: { connected?: string[]; failProfiles?: boolean; failRestore?: boolean } = {}
) {
  const calls: string[] = [];
  const state = {
    connectedProfileIds: new Set(options.connected ?? []),
    loadProfiles: async () => {
      calls.push('loadProfiles');
      if (options.failProfiles === true) throw new Error('profiles unreadable');
    },
    restoreState: async () => {
      calls.push('restoreState');
      if (options.failRestore === true) throw new Error('reconnect failed');
    },
  };
  return { calls, store: { getState: () => state } as never };
}

beforeEach(() => {
  bridge = createAppStateDouble();
  teardowns.push(installJoineryMock({ app: bridge.app }));
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
  resetBootLatch();
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  resetBootLatch();
});

describe('the boot sequence', () => {
  it('runs its steps in the declared order', async () => {
    const steps: BootStep[] = [];
    const connection = stubConnection({ connected: ['profile-a'] });

    await runBoot({
      boot: createBootStore(),
      connection: connection.store,
      workbench: createWorkbenchStore(),
      onStep: step => steps.push(step),
    });

    // Not a subset and not a set: the sequence itself is the contract.
    expect(steps).toEqual([...BOOT_STEPS]);
  });

  it('becomes interactive before the session restore, and ready only after the workspace restore', async () => {
    const boot = createBootStore();
    const connection = stubConnection({ connected: ['profile-a'] });
    const phaseAtStep = new Map<BootStep, string>();

    await runBoot({
      boot,
      connection: connection.store,
      workbench: createWorkbenchStore(),
      onStep: step => phaseAtStep.set(step, boot.getState().phase),
    });

    expect(phaseAtStep.get('hydrate-renderer-state')).toBe('starting');
    expect(phaseAtStep.get('hydrate-geometry')).toBe('starting');
    expect(phaseAtStep.get('interactive')).toBe('interactive');
    expect(phaseAtStep.get('restore-session')).toBe('interactive');
    expect(phaseAtStep.get('restore-workspace')).toBe('interactive');
    expect(phaseAtStep.get('ready')).toBe('ready');
  });

  it('restores the workspace even when loading profiles fails', async () => {
    const steps: BootStep[] = [];
    const connection = stubConnection({ failProfiles: true });

    await runBoot({
      boot: createBootStore(),
      connection: connection.store,
      workbench: createWorkbenchStore(),
      onStep: step => steps.push(step),
    });

    // `load-profiles` never fires — that step is inside the try — but everything after it does,
    // because the workspace restore is what opens the persistence gates and a failed startup must
    // not leave the app unable to save for the session.
    expect(steps).not.toContain('load-profiles');
    expect(steps).toContain('restore-workspace');
    expect(steps).toContain('ready');
  });

  it('restores the workspace even when the session reconnect throws', async () => {
    const steps: BootStep[] = [];
    const connection = stubConnection({ failRestore: true });

    await runBoot({
      boot: createBootStore(),
      connection: connection.store,
      workbench: createWorkbenchStore(),
      onStep: step => steps.push(step),
    });

    expect(steps).not.toContain('restore-session');
    expect(steps).toContain('restore-workspace');
  });

  it('runs once, however many times it is called', async () => {
    const connection = stubConnection();
    const deps = {
      boot: createBootStore(),
      connection: connection.store,
      workbench: createWorkbenchStore(),
    };

    // StrictMode mounts every effect twice; `loadProfiles` is a network-bound IPC call.
    await Promise.all([runBoot(deps), runBoot(deps)]);
    await runBoot(deps);

    expect(connection.calls.filter(call => call === 'loadProfiles')).toHaveLength(1);
  });
});

describe('the restore-before-save contract', () => {
  it('keeps both write paths shut until the workspace restore has run', async () => {
    const tabs = createTabStore(createRendererStatePersistence());
    const layout = createLayoutPersistence();

    expect(tabs.getState().isPersistenceUnlocked()).toBe(false);
    expect(layout.isUnlocked()).toBe(false);

    // Everything a startup path could plausibly do before the restore.
    tabs.getState().hydrateWelcome(false);
    const tabId = tabs.getState().openTab({ type: 'query', title: 'Query 1', icon: 'code' });
    tabs.getState().setTabContent(tabId, 'select 1');
    tabs.getState().closeTab(tabId);
    await tabs.getState().saveTabs();

    expect(bridge.calls.saveTabs).toBe(0);
    expect(bridge.calls.saveLayout).toBe(0);
  });

  it('does not clobber saved tabs when an early write races the restore', async () => {
    // The exact shape of the loss. A user quits with one query tab holding real SQL; on the next
    // boot something writes before the restore lands. Without the gate, `saveTabs` serializes the
    // tabs it can see — none — and the SQL is gone from the only place it lived.
    const seeded = createAppStateDouble();
    await seeded.app.saveTabs(
      [{ id: 'tab-1', type: 'query', title: 'Important', content: 'select * from payroll' }],
      'tab-1'
    );
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: seeded.app }));

    const tabs = createTabStore(createRendererStatePersistence());

    // The premature write.
    await tabs.getState().saveTabs();
    expect((await seeded.app.getTabs()).tabs).toHaveLength(1);

    // Now the real sequence, which restores and only then unlocks.
    const layout = createLayoutPersistence();
    await hydrateWorkspace('profile-a', { tabs, layout });

    expect(tabs.getState().tabs.map(tab => tab.title)).toEqual(['Important']);
    expect(tabs.getState().getTabContent(tabs.getState().tabs[0]?.id ?? '')).toBe(
      'select * from payroll'
    );
    expect(tabs.getState().isPersistenceUnlocked()).toBe(true);
    // The LAYOUT gate is still shut here: the arrangement has only been read, not applied. See the
    // layout-gate test below.
    expect(layout.isUnlocked()).toBe(false);

    // And a write after the restore keeps the content rather than dropping it.
    await tabs.getState().saveTabs();
    expect((await seeded.app.getTabs()).tabs[0]?.content).toBe('select * from payroll');
  });

  it('opens the tab gate even when there is no connection to restore tabs against', async () => {
    // The Angular renderer skipped the restore entirely in this case, which under a gate would mean
    // tabs silently stop persisting for the whole session.
    const tabs = createTabStore(createRendererStatePersistence());
    const layout = createLayoutPersistence();

    await hydrateWorkspace(null, { tabs, layout });

    expect(tabs.getState().isPersistenceUnlocked()).toBe(true);
  });

  it('opens the layout gate when the workspace applies the arrangement, not when it is read', async () => {
    // The two gates guard different moments. `hydrateWorkspace` only READS the arrangement;
    // `workspace.tsx` applies it an effect and a 500ms debounce later, and Dockview's
    // `onDidLayoutChange` is already subscribed to its own initial empty state by then. So the gate
    // is opened by the apply — `markRestoreApplied` — and nothing before it can write.
    const layout = createLayoutPersistence();
    const boot = createBootStore({ layout });

    await hydrateWorkspace(null, {
      tabs: createTabStore(createRendererStatePersistence()),
      layout,
    });
    expect(layout.isUnlocked()).toBe(false);

    // Still shut while there is nothing to apply: a caller that runs early cannot open it.
    boot.getState().markRestoreApplied();
    expect(layout.isUnlocked()).toBe(false);

    boot.getState().setWorkspaceRestore(undefined);
    boot.getState().markRestoreApplied();

    expect(boot.getState().workspaceRestore.applied).toBe(true);
    expect(layout.isUnlocked()).toBe(true);
  });

  it('leaves the gates open for the rest of the session', async () => {
    const tabs = createTabStore(createRendererStatePersistence());
    const layout = createLayoutPersistence();
    await hydrateWorkspace(null, { tabs, layout });

    tabs.getState().openTab({ type: 'query', title: 'Query 1', icon: 'code' });
    await tabs.getState().saveTabs();

    expect(bridge.calls.saveTabs).toBeGreaterThan(0);
  });
});

describe('the pre-restore interactive window', () => {
  /**
   * The sequence this reproduces, which is the one a user with a saved connection that has since gone
   * away actually gets:
   *
   *   interactive  →  restoreState() blocks on a dead server's connect timeout  →  the user, looking
   *   at a usable window, opens a query tab and types  →  the reconnect finally fails  →  the
   *   workspace restore runs.
   *
   * Before the merge, that last step REPLACED the tab list with the saved one and the user's tab and
   * everything they had typed into it were gone with no error, no toast and no recoverable copy.
   */
  async function bootWithSlowReconnect(tabs: ReturnType<typeof createTabStore>) {
    let releaseReconnect = (): void => undefined;
    const reconnectReached = new Promise<void>(resolve => {
      releaseReconnect = resolve;
    });

    const layout = createLayoutPersistence();
    const boot = createBootStore({ layout });
    const connection = {
      getState: () => ({
        connectedProfileIds: new Set<string>(),
        loadProfiles: async () => undefined,
        // A dead saved server: the reconnect hangs for its connect timeout and then fails.
        restoreState: async () => {
          await reconnectReached;
          throw new Error('connect ETIMEDOUT');
        },
      }),
    } as never;

    const booted = runBoot({
      boot,
      connection,
      workbench: createWorkbenchStore(),
      restoreWorkspace: connectionId => hydrateWorkspace(connectionId, { tabs, layout }),
    });

    // The window is interactive while the reconnect is still outstanding — that IS the window.
    await vi.waitFor(() => expect(boot.getState().phase).toBe('interactive'));
    expect(boot.getState().lastStep).toBe('interactive');

    return { boot, booted, releaseReconnect };
  }

  it('keeps the tab the user opened and typed into while the reconnect was still running', async () => {
    const seeded = createAppStateDouble();
    await seeded.app.saveTabs(
      [{ id: 'tab-saved', type: 'query', title: 'Saved', content: 'select * from payroll' }],
      'tab-saved'
    );
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: seeded.app }));

    const tabs = createTabStore(createRendererStatePersistence());
    tabs.getState().hydrateWelcome(false);
    const { boot, booted, releaseReconnect } = await bootWithSlowReconnect(tabs);

    // What an interactive window invites: a new tab, and typing in it.
    const userTabId = tabs.getState().openQueryTab('profile-a', 'analytics', '', false, false);
    tabs.getState().renameTab(userTabId, 'Scratch');
    tabs.getState().setTabContent(userTabId, 'select 1 -- typed during the restore window');

    releaseReconnect();
    await booted;

    expect(boot.getState().lastStep).toBe('ready');

    const titles = tabs.getState().tabs.map(tab => tab.title);
    // The user's tab, its content, and its focus.
    expect(titles).toContain('Scratch');
    expect(tabs.getState().getTabContent(userTabId)).toBe(
      'select 1 -- typed during the restore window'
    );
    expect(tabs.getState().activeTabId).toBe(userTabId);
    // And the restore still happened — a merge, not a skip.
    expect(titles).toContain('Saved');
    expect(tabs.getState().getTabContent('tab-saved')).toBe('select * from payroll');

    // The first write after the gate opens carries BOTH, which is what makes the survival durable
    // rather than momentary.
    await tabs.getState().saveTabs();
    const persisted = await seeded.app.getTabs();
    expect(persisted.tabs.map(tab => tab.title).sort()).toEqual(['Saved', 'Scratch']);
  });

  it('still honours the saved active tab when the user did nothing during the window', async () => {
    // The other half of the focus rule: with no live tab but Welcome, the saved `activeTabId` wins,
    // which is the returning-user behaviour the restore is for.
    const seeded = createAppStateDouble();
    await seeded.app.saveTabs(
      [
        { id: 'tab-a', type: 'query', title: 'A', content: 'select 1' },
        { id: 'tab-b', type: 'query', title: 'B', content: 'select 2' },
      ],
      'tab-b'
    );
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: seeded.app }));

    const tabs = createTabStore(createRendererStatePersistence());
    tabs.getState().hydrateWelcome(false);
    const { booted, releaseReconnect } = await bootWithSlowReconnect(tabs);

    releaseReconnect();
    await booted;

    expect(tabs.getState().activeTabId).toBe('tab-b');
    // Welcome first, then the restored pair, in saved order.
    expect(tabs.getState().tabs.map(tab => tab.type)).toEqual(['welcome', 'query', 'query']);
  });
});
