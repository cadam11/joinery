/**
 * The workspace-layout persistence contract. Three things to prove:
 *
 * 1. A React layout round-trips through the `LayoutConfig` type, under `AppState.workspaceLayout`.
 * 2. A stored value this renderer does not recognise is IGNORED on read — "migrate by reset" — and
 *    is never partially honoured.
 * 3. J-89: state left under the retired `goldenLayoutConfig` key is neither read nor written. There
 *    is no migration, by decision.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayoutConfig } from '@joinery/shared';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createAppStateDouble, type AppStateDouble } from '../test/app-state-double';
import type { AppStateWithReactRenderer } from './renderer-state';
import { setDiagnosticsSink } from '../state/diagnostics';
import {
  createLayoutPersistence,
  decodeReactLayout,
  encodeReactLayout,
  REACT_LAYOUT_COMPONENT_TYPE,
  REACT_LAYOUT_VERSION,
  type ReactLayoutPayload,
} from './layout';

/** A layout tree of a shape this renderer never writes — a pre-rewrite Golden Layout config. */
const FOREIGN_LAYOUT: LayoutConfig = {
  root: {
    type: 'row',
    content: [
      {
        type: 'stack',
        content: [
          {
            type: 'component',
            componentType: 'tab-component',
            componentState: { tabId: 'tab-1', tabType: 'query', title: 'Query 1' },
          },
        ],
      },
    ],
  },
  dimensions: { headerHeight: 32, borderWidth: 2 },
};

const PAYLOAD: ReactLayoutPayload = {
  version: REACT_LAYOUT_VERSION,
  dockview: { grid: { root: { type: 'branch' } }, panels: { 'tab-1': { id: 'tab-1' } } },
  activeTabId: 'tab-1',
};

let bridge: AppStateDouble;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  bridge = createAppStateDouble();
  teardowns.push(installJoineryMock({ app: bridge.app }));
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
});

describe('React layout payload', () => {
  it('round-trips through the LayoutConfig type', () => {
    expect(decodeReactLayout(encodeReactLayout(PAYLOAD))).toEqual(PAYLOAD);
  });

  it('decodes a foreign layout tree as "nothing to honour"', () => {
    expect(decodeReactLayout(FOREIGN_LAYOUT)).toBeUndefined();
    expect(decodeReactLayout(undefined)).toBeUndefined();
  });

  it('decodes an unknown version, an empty state and a junk blob as undefined', () => {
    const encoded = encodeReactLayout(PAYLOAD);
    const withVersion = (version: unknown): LayoutConfig => ({
      root: { ...encoded.root, componentState: { ...encoded.root.componentState, version } },
    });

    expect(decodeReactLayout(withVersion(REACT_LAYOUT_VERSION + 1))).toBeUndefined();
    expect(decodeReactLayout(withVersion(undefined))).toBeUndefined();
    expect(
      decodeReactLayout({
        root: {
          type: 'component',
          componentType: REACT_LAYOUT_COMPONENT_TYPE,
          componentState: { version: REACT_LAYOUT_VERSION, dockview: 'not an object' },
        },
      })
    ).toBeUndefined();
  });
});

describe('layout persistence', () => {
  /**
   * An instance with the restore-before-save gate already open. Every test that exercises
   * `save()` uses it, because the gate is not what those tests are about; the two tests that ARE
   * about the gate build their own instance and leave it shut.
   */
  const unlockedPersistence = () => {
    const layout = createLayoutPersistence();
    layout.unlock();
    return layout;
  };

  it('refuses to save until the restore has unlocked it', async () => {
    // The layout half of the restore-before-save contract. Dockview fires onDidLayoutChange while
    // it builds its initial empty state, so the workspace has a live save subscription before it
    // has any panels; without this gate that empty state overwrites the saved arrangement.
    const layout = createLayoutPersistence();

    expect(layout.isUnlocked()).toBe(false);
    expect(await layout.save(PAYLOAD)).toBe('locked');
    expect(bridge.calls.saveLayout).toBe(0);
    expect(bridge.calls.setState).toBe(0);
  });

  it('saves once unlocked, and stays unlocked', async () => {
    const layout = createLayoutPersistence();
    layout.unlock();

    expect(layout.isUnlocked()).toBe(true);
    expect(await layout.save(PAYLOAD)).toBe('saved');
    expect(await layout.save({ ...PAYLOAD, activeTabId: 'tab-2' })).toBe('saved');
  });

  it('reads back what it saved', async () => {
    const layout = unlockedPersistence();

    expect(await layout.save(PAYLOAD)).toBe('saved');
    expect(await layout.read()).toEqual(PAYLOAD);
  });

  it('ignores an unrecognised config stored under its own key', async () => {
    const seeded = createAppStateDouble({ workspaceLayout: FOREIGN_LAYOUT });
    removeJoineryMock();
    installJoineryMock({ app: seeded.app });

    const payload = await createLayoutPersistence().read();

    expect(payload).toBeUndefined();
    // Read means read: the stored config is exactly where it was.
    expect(seeded.snapshot().workspaceLayout).toEqual(FOREIGN_LAYOUT);
    expect(seeded.calls.setState).toBe(0);
  });

  it('saves under the workspaceLayout key', async () => {
    const layout = unlockedPersistence();

    expect(await layout.save(PAYLOAD)).toBe('saved');
    expect(decodeReactLayout(bridge.snapshot().workspaceLayout)).toEqual(PAYLOAD);
  });

  it('ignores state left under the retired goldenLayoutConfig key', async () => {
    // J-89: the key was renamed with no migration. A pre-rename config is not read, not archived
    // and not overwritten — it is simply not the key this code looks at any more.
    const stale = { goldenLayoutConfig: FOREIGN_LAYOUT } as unknown as AppStateWithReactRenderer;
    const seeded = createAppStateDouble(stale);
    removeJoineryMock();
    installJoineryMock({ app: seeded.app });
    const layout = createLayoutPersistence();
    layout.unlock();

    expect(await layout.read()).toBeUndefined();
    expect(await layout.save(PAYLOAD)).toBe('saved');

    const snapshot = seeded.snapshot() as unknown as { goldenLayoutConfig?: LayoutConfig };
    expect(snapshot.goldenLayoutConfig).toEqual(FOREIGN_LAYOUT);
    expect(decodeReactLayout(seeded.snapshot().workspaceLayout)).toEqual(PAYLOAD);
    expect(seeded.calls.setState).toBe(0);
  });

  it('reports an unavailable bridge rather than throwing', async () => {
    removeJoineryMock();
    const layout = unlockedPersistence();

    expect(await layout.read()).toBeUndefined();
    expect(await layout.save(PAYLOAD)).toBe('unavailable');
  });

  it('reports a rejected save', async () => {
    removeJoineryMock();
    installJoineryMock({
      app: {
        getState: bridge.app.getState,
        setState: bridge.app.setState,
        getLayout: bridge.app.getLayout,
        saveLayout: () => Promise.reject(new Error('nope')),
      },
    });

    expect(await unlockedPersistence().save(PAYLOAD)).toBe('failed');
  });
});
