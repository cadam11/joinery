/**
 * The startup path, end to end in jsdom: seed the Angular localStorage keys, hydrate, and check that
 * the stores hold what the user had — then do it again against a wiped browser profile, which is the
 * "second boot" the gate asks for.
 *
 * Since Task 24 the migration also REMOVES the keys it lifted, so the round trip below is the
 * cutover's no-data-loss proof: a profile that has only ever run the Angular app gets its data on
 * the first React launch, the keys are empty afterwards, and the marker keeps a second boot from
 * lifting anything a second time.
 *
 * The stores here are fresh instances rather than the app singletons, so a failure names one store
 * and the specs do not leak state into each other.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@joinery/shared';
import type { LayoutConfig, TabState } from '@joinery/shared';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createAppStateDouble, type AppStateDouble } from '../test/app-state-double';
import { setDiagnosticsSink } from '../state/diagnostics';
import { createSettingsStore } from '../state/settings';
import { createTabStore } from '../state/tab';
import { hydrateRendererState, hydrateWorkspace } from './hydrate';
import { encodeReactLayout, createLayoutPersistence, REACT_LAYOUT_VERSION } from './layout';
import { LEGACY_KEYS } from './legacy-local-storage';
import { createRendererStatePersistence } from './renderer-state';
import { THEME_MIRROR_KEY } from './theme-mirror';

function seedAngularLocalStorage(): void {
  window.localStorage.setItem(
    LEGACY_KEYS.settings,
    JSON.stringify({ theme: 'light', editor: { fontSize: 18 } })
  );
  window.localStorage.setItem(LEGACY_KEYS.completedTours, JSON.stringify(['welcome']));
  window.localStorage.setItem(LEGACY_KEYS.welcomeDismissed, 'true');
  window.localStorage.setItem(
    LEGACY_KEYS.snippets,
    JSON.stringify([
      { id: 'snip-1', name: 'Orders', sql: 'SELECT 1', tags: ['a'], createdAt: 'then' },
      { id: 'snip-2', name: 'Counts', sql: 'SELECT 2', tags: [], createdAt: 'then' },
    ])
  );
  window.localStorage.setItem(LEGACY_KEYS.ctrlEConfirmed, 'true');
  window.localStorage.setItem(
    LEGACY_KEYS.flywayPlaceholderValues,
    JSON.stringify({ schema: 'dbo' })
  );
}

/** One "process": a persistence writer plus the two stores that hydrate from it. */
function makeRenderer() {
  const persistence = createRendererStatePersistence();
  return {
    persistence,
    settings: createSettingsStore(persistence),
    tabs: createTabStore(persistence),
  };
}

let bridge: AppStateDouble;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  bridge = createAppStateDouble();
  teardowns.push(installJoineryMock({ app: bridge.app }));
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  window.localStorage.clear();
});

describe('hydrateRendererState — first launch after Angular', () => {
  it('migrates, then hydrates the settings store from the migrated data', async () => {
    seedAngularLocalStorage();
    const renderer = makeRenderer();

    const hydrated = await hydrateRendererState(renderer);

    expect(hydrated.migration.outcome).toBe('migrated');
    const settings = renderer.settings.getState().settings;
    expect(settings.theme).toBe('light');
    expect(settings.editor.fontSize).toBe(18);
    // Merged group by group, so a field the stored object never mentioned still exists.
    expect(settings.editor.tabSize).toBe(DEFAULT_SETTINGS.editor.tabSize);
    expect(settings.grid).toEqual(DEFAULT_SETTINGS.grid);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('hydrates the welcome flag into the tab store', async () => {
    seedAngularLocalStorage();
    const renderer = makeRenderer();

    await hydrateRendererState(renderer);

    expect(renderer.tabs.getState().tabs).toEqual([]);
    expect(renderer.tabs.getState().activeTabId).toBe('');
  });

  it('shows the Welcome tab when the user never dismissed it', async () => {
    const renderer = makeRenderer();

    await hydrateRendererState(renderer);

    expect(renderer.tabs.getState().tabs.map(t => t.type)).toEqual(['welcome']);
    expect(renderer.tabs.getState().activeTabId).toBe('welcome');
  });

  it('hands back the three domains whose surfaces do not exist yet', async () => {
    seedAngularLocalStorage();

    const hydrated = await hydrateRendererState(makeRenderer());

    expect(hydrated.snippets.map(s => s.id)).toEqual(['snip-1', 'snip-2']);
    expect(hydrated.completedTours).toEqual(['welcome']);
    expect(hydrated.confirmedCtrlEExecute).toBe(true);
    expect(hydrated.flywayPlaceholderValues).toEqual({ schema: 'dbo' });
  });

  it('primes the FOUC mirror, so the next boot paints the right canvas', async () => {
    seedAngularLocalStorage();

    await hydrateRendererState(makeRenderer());

    expect(window.localStorage.getItem(THEME_MIRROR_KEY)).toBe('light');
  });

  it('never WRITES an Angular key — the only thing it does to one is remove it', async () => {
    seedAngularLocalStorage();

    const renderer = makeRenderer();
    await hydrateRendererState(renderer);
    // A settings change after hydration is the dangerous case: it must reach AppState and the
    // mirror, and it must not resurrect an Angular-owned key with React's idea of its contents.
    renderer.settings.getState().updateEditorSetting('fontSize', 21);
    await renderer.persistence.read();

    expect(window.localStorage.getItem(LEGACY_KEYS.settings)).toBeNull();
    expect(window.localStorage.getItem(THEME_MIRROR_KEY)).toBe('light');
    expect(bridge.snapshot().reactRendererState?.settings?.editor?.fontSize).toBe(21);
  });

  /*
   * The cutover's no-data-loss invariant, end to end and in one test, because it is the one thing
   * this PR could get wrong that a user would never recover from.
   *
   * The profile it describes is the real one: Craig's packaged app ships Angular today, so his
   * snippet library exists in `joinery-snippets` and NOWHERE else. It has never run the React
   * renderer, so there is no marker and nothing in `AppState` to fall back on.
   */
  it('lifts a virgin profile, empties the keys, and does not lift twice', async () => {
    seedAngularLocalStorage();

    // Boot 1 — the first React launch this profile has ever had.
    const first = await hydrateRendererState(makeRenderer());

    expect(first.migration.outcome).toBe('migrated');
    expect(first.snippets.map(s => s.id)).toEqual(['snip-1', 'snip-2']);
    expect([...first.migration.keysCleared].sort()).toEqual([...Object.values(LEGACY_KEYS)].sort());
    for (const key of Object.values(LEGACY_KEYS)) {
      expect(window.localStorage.getItem(key), key).toBeNull();
    }

    // Boot 2 — a fresh process against the same AppState. The data is still there, the marker stops
    // a second lift, and no write is issued: nothing has changed to write.
    const rebooted = bridge.reboot();
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: rebooted.app }));

    const second = await hydrateRendererState(makeRenderer());

    expect(second.migration.outcome).toBe('already-migrated');
    expect(second.migration.keysCleared).toEqual([]);
    expect(second.snippets.map(s => s.id)).toEqual(['snip-1', 'snip-2']);
    expect(second.completedTours).toEqual(['welcome']);
    expect(second.confirmedCtrlEExecute).toBe(true);
    expect(second.flywayPlaceholderValues).toEqual({ schema: 'dbo' });
    expect(rebooted.calls.setState).toBe(0);
  });
});

describe('hydrateRendererState — the second boot', () => {
  it('reads the same values back with localStorage wiped, and does not migrate again', async () => {
    seedAngularLocalStorage();
    await hydrateRendererState(makeRenderer());

    // Quit, wipe the browser profile, boot again. Only AppState survives.
    const rebooted = bridge.reboot();
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: rebooted.app }));
    window.localStorage.clear();

    const renderer = makeRenderer();
    const hydrated = await hydrateRendererState(renderer);

    expect(hydrated.migration.outcome).toBe('already-migrated');
    expect(renderer.settings.getState().settings.editor.fontSize).toBe(18);
    expect(hydrated.snippets).toHaveLength(2);
    expect(hydrated.welcomeDismissed).toBe(true);
    expect(rebooted.calls.setState).toBe(0);
  });

  it('is safe to run twice in one process', async () => {
    // What a StrictMode double-effect does. Both the migration and the two store hydrations are
    // idempotent, and the Welcome tab must not be added twice.
    const renderer = makeRenderer();

    await hydrateRendererState(renderer);
    await hydrateRendererState(renderer);

    expect(renderer.tabs.getState().tabs).toHaveLength(1);
    expect(bridge.calls.setState).toBe(0);
  });
});

/*
 * Settings precedence across boots, which is where every silent-and-permanent failure in this task
 * lives. The migration runs at most once, so whatever it decides about `settings` is final, and there
 * are two opposite ways to get it wrong:
 *
 *   - lift too little: boot 1's migration fails (no marker), the user nudges a setting, a
 *     DEFAULT-derived object lands in `AppState`, boot 2 treats it as newer — the user's real Angular
 *     settings are never lifted. (Review round 1.)
 *   - lift too much: boot 1 legitimately finds nothing to migrate (`no-data`, fresh install, which
 *     deliberately writes no marker so a later Angular session can still be lifted), the user makes a
 *     real choice in React, then opens Angular once — whose `settings.service.ts:149` rewrites its
 *     WHOLE settings object — and boot 2 overwrites the React choice with Angular defaults. (Review
 *     round 2.)
 *
 * Neither the missing marker nor the shape of the stored object separates those cases; a user may
 * deliberately pick the defaults. Provenance does, and it is recorded rather than inferred:
 * `settingsAuthoredByReactAt`, stamped by the settings store's write path, which only runs once
 * hydration has confirmed the migration settled. The four sequences below are the specification.
 */
describe('hydrateRendererState — settings precedence across boots', () => {
  /** A bridge whose `setState` fails until `allowWrites()` is called. */
  function flakyBridge() {
    const backing = createAppStateDouble();
    let failing = true;
    removeJoineryMock();
    teardowns.push(
      installJoineryMock({
        app: {
          getState: backing.app.getState,
          setState: (partial: Parameters<typeof backing.app.setState>[0]) =>
            failing
              ? Promise.reject(new Error('main process went away'))
              : backing.app.setState(partial),
        },
      })
    );
    return {
      backing,
      allowWrites: () => {
        failing = false;
      },
    };
  }

  it('(a) unsettled boot 1: withholds the write, and boot 2 lifts the real Angular settings', async () => {
    seedAngularLocalStorage();
    const { backing, allowWrites } = flakyBridge();

    const boot1 = makeRenderer();
    expect((await hydrateRendererState(boot1)).migration.outcome).toBe('failed');

    // The failure was transient — writes work again — and the user changes a setting.
    allowWrites();
    boot1.settings.getState().updateEditorSetting('fontSize', 9);
    await boot1.persistence.read();

    // The gate held: nothing of ours is in AppState, so boot 2 has a clean slate to migrate into.
    expect(backing.snapshot().reactRendererState).toBeUndefined();

    const boot2 = makeRenderer();
    expect((await hydrateRendererState(boot2)).migration.outcome).toBe('migrated');
    expect(boot2.settings.getState().settings.editor.fontSize).toBe(18);
    expect(boot2.settings.getState().settings.theme).toBe('light');
  });

  it('(a2) recovers even if an unstamped settings object did reach AppState first', async () => {
    // The same case with the store taken out of the picture: something else (a future task, a hand
    // edit) put settings in `AppState` with no marker and no provenance stamp. Unstamped means
    // "nobody claims to have chosen this", so the lift still wins.
    seedAngularLocalStorage();
    const renderer = makeRenderer();
    await renderer.persistence.update(current => ({
      ...current,
      settings: { theme: 'system', editor: { fontSize: 13 } },
    }));

    const hydrated = await hydrateRendererState(renderer);

    expect(hydrated.migration.outcome).toBe('migrated');
    expect(renderer.settings.getState().settings.editor.fontSize).toBe(18);
    expect(renderer.settings.getState().settings.theme).toBe('light');
  });

  it('(b) settled `no-data` boot 1 + a real React choice: boot 2 keeps the React settings', async () => {
    // Fresh install, React first. Nothing to migrate, so no marker — by design, so that a later
    // Angular session can still be lifted. The user then makes a deliberate choice in React, and only
    // afterwards opens Angular once and changes one thing, which rewrites Angular's whole settings
    // object. Boot 2 must not mistake that object for something newer.
    const boot1 = makeRenderer();
    expect((await hydrateRendererState(boot1)).migration.outcome).toBe('no-data');

    boot1.settings.getState().updateEditorSetting('fontSize', 21);
    boot1.settings.getState().updateTheme('dark');
    await boot1.persistence.read();

    const stored = bridge.snapshot().reactRendererState;
    expect(stored?.settings?.editor?.fontSize).toBe(21);
    expect(stored?.settingsAuthoredByReactAt).toBeTypeOf('string');
    expect(stored?.migratedFromLocalStorageAt).toBeUndefined();

    // The Angular session happens here.
    seedAngularLocalStorage();

    const boot2 = makeRenderer();
    const hydrated = await hydrateRendererState(boot2);

    // The migration still runs — the marker was absent — and still lifts everything else.
    expect(hydrated.migration.outcome).toBe('migrated');
    expect(boot2.settings.getState().settings.editor.fontSize).toBe(21);
    expect(boot2.settings.getState().settings.theme).toBe('dark');
    // (d) the collections came across regardless.
    expect(hydrated.snippets.map(s => s.id)).toEqual(['snip-1', 'snip-2']);
    expect(hydrated.completedTours).toEqual(['welcome']);
    expect(hydrated.confirmedCtrlEExecute).toBe(true);
    expect(hydrated.flywayPlaceholderValues).toEqual({ schema: 'dbo' });
  });

  it('(c) settled `no-data` boot 1 with no React write: boot 2 lifts the Angular settings', async () => {
    // The whole point of not writing a marker on a fresh install. Nothing claims authorship, so the
    // Angular data that appears later is the only considered thing there is.
    const boot1 = makeRenderer();
    expect((await hydrateRendererState(boot1)).migration.outcome).toBe('no-data');
    expect(bridge.calls.setState).toBe(0);

    seedAngularLocalStorage();

    const boot2 = makeRenderer();
    const hydrated = await hydrateRendererState(boot2);

    expect(hydrated.migration.outcome).toBe('migrated');
    expect(boot2.settings.getState().settings.editor.fontSize).toBe(18);
    expect(boot2.settings.getState().settings.theme).toBe('light');
    expect(hydrated.snippets).toHaveLength(2);
  });

  it('(d) collections are never overwritten by the lift, stamped or not', async () => {
    // The mirror image of the settings rule, in both provenance states: a React-created snippet must
    // survive a migration either way, because a collection can only have grown.
    const renderer = makeRenderer();
    await hydrateRendererState(renderer);
    await renderer.persistence.update(current => ({
      ...current,
      snippets: [{ id: 'react-made', sql: 'SELECT 3' }],
      completedTours: ['react-tour'],
    }));

    seedAngularLocalStorage();
    const hydrated = await hydrateRendererState(makeRenderer());

    expect(hydrated.migration.outcome).toBe('migrated');
    expect(hydrated.snippets.map(s => s.id)).toEqual(['react-made']);
    expect(hydrated.completedTours).toEqual(['react-tour']);
  });
});

describe('hydrateRendererState — fresh install', () => {
  it('hydrates defaults and writes nothing', async () => {
    const renderer = makeRenderer();

    const hydrated = await hydrateRendererState(renderer);

    expect(hydrated.migration.outcome).toBe('no-data');
    expect(renderer.settings.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(hydrated.snippets).toEqual([]);
    expect(bridge.calls.setState).toBe(0);
  });

  it('hydrates defaults when there is no bridge at all', async () => {
    // `pnpm --filter @joinery/renderer start` in a browser tab. Nothing to hydrate from, and
    // a boot must not fail over it.
    removeJoineryMock();
    const renderer = makeRenderer();

    const hydrated = await hydrateRendererState(renderer);

    expect(hydrated.migration.outcome).toBe('unavailable');
    expect(renderer.settings.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('hydrateWorkspace', () => {
  const SAVED_TABS: TabState[] = [
    {
      id: 'tab-1',
      type: 'query',
      title: 'Orders',
      content: 'SELECT * FROM orders',
      databaseName: 'sales',
      isPinned: true,
    },
    { id: 'tab-2', type: 'query', title: 'Query 2', content: '' },
  ];

  it('restores the saved tabs and the saved React layout', async () => {
    const layoutConfig: LayoutConfig = encodeReactLayout({
      version: REACT_LAYOUT_VERSION,
      dockview: { grid: {} },
      activeTabId: 'tab-1',
    });
    const seeded = createAppStateDouble({
      openTabs: SAVED_TABS,
      activeTabId: 'tab-2',
      workspaceLayout: layoutConfig,
    });
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: seeded.app }));
    const renderer = makeRenderer();

    const payload = await hydrateWorkspace('profile-a', {
      tabs: renderer.tabs,
      layout: createLayoutPersistence(),
    });

    const tabs = renderer.tabs.getState();
    expect(tabs.tabs.map(t => t.id)).toEqual(['tab-1', 'tab-2']);
    expect(tabs.activeTabId).toBe('tab-2');
    expect(tabs.getTabContent('tab-1')).toBe('SELECT * FROM orders');
    // A tab that never had a connection of its own adopts the restored one.
    expect(tabs.tabs[1]?.connectionId).toBe('profile-a');
    expect(payload?.activeTabId).toBe('tab-1');
  });

  it('returns undefined for an unrecognised layout config, leaving it in place', async () => {
    const foreign: LayoutConfig = { root: { type: 'row', content: [{ type: 'stack' }] } };
    const seeded = createAppStateDouble({ openTabs: SAVED_TABS, workspaceLayout: foreign });
    removeJoineryMock();
    teardowns.push(installJoineryMock({ app: seeded.app }));
    const renderer = makeRenderer();

    const payload = await hydrateWorkspace('profile-a', {
      tabs: renderer.tabs,
      layout: createLayoutPersistence(),
    });

    // Decision C: rebuild from the tab list, which is still fully intact.
    expect(payload).toBeUndefined();
    expect(renderer.tabs.getState().tabs).toHaveLength(2);
    expect(seeded.snapshot().workspaceLayout).toEqual(foreign);
  });
});
