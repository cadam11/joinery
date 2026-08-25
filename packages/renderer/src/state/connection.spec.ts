/**
 * Ported from `packages/renderer/src/app/core/state/connection.state.spec.ts`, which encodes the
 * `multi-connection-first-class` contract (per-target disconnect, focus derived from the active
 * tab, per-connection heartbeat, and the `lastConnectionId` → `lastConnectedProfileIds` migration).
 * Every scenario survives. What changed, and why:
 *
 * 1. **The harness shrank by half.** The original's `Injector.create`, the `@angular/compiler`
 *    side-effect import, and the `vi.mock('@angular/core/rxjs-interop')` that stubbed
 *    `toObservable` all existed to keep Angular's DI and effect scheduler out of a unit test. None
 *    of it has an equivalent here.
 *
 * 2. **The tab and explorer stubs are gone; the real stores are used.** The original hand-rolled
 *    both because instantiating them required a bootstrapped Angular platform. The store factories
 *    have no such requirement, so the ported spec exercises the real `openQueryTab`,
 *    `addServerNode` and `removeServerNode`. That is strictly more coverage — `expandNode` in
 *    particular was a `vi.fn()` no-op before and now really runs.
 *
 * 3. **`ipc.isAvailable` has no analogue.** The original defaulted it to `false`, which made
 *    `saveState`/`restoreState` no-ops while every other stubbed method still worked — an artifact
 *    of the stub, since a renderer with no bridge cannot connect either. Here the bridge mock is
 *    installed for every test, so `connect()` now also reaches `app.setState`. No assertion
 *    depended on it not being called.
 *
 * 4. **One assertion could not port and was replaced.** `expect(ConnectionStateService.prototype
 *    .disconnect.length).toBe(1)` proved "calling disconnect without an argument is a type error"
 *    by counting declared parameters on a class prototype. A store action is a closure on a state
 *    object, and `Function.length` on it proves nothing about the caller. The scenario is asserted
 *    at the type level instead — a consumed `@ts-expect-error`, which fails the build rather than a
 *    test run if the signature ever grows a default.
 *
 * 5. **Profile seeding no longer breaks encapsulation.** The original reached into the private
 *    `_profiles` signal. `connection.list` is mocked instead and `loadProfiles()` is awaited, which
 *    is how production gets its profiles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_CAPABILITIES } from '@joinery/shared';
import type {
  ActiveConnection,
  ConnectionProfile,
  DatabaseInfo,
  EngineCapabilities,
} from '@joinery/shared';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createCapabilitiesStore, selectCapabilitiesFor, selectVariantFor } from './capabilities';
import {
  createConnectionStore,
  selectFocusedConnectionId,
  selectFocusedDatabaseName,
  type ConnectionStore,
} from './connection';
import { setDiagnosticsSink, setNotifier, type Notifier } from './diagnostics';
import { createExplorerStore, type ExplorerStore } from './explorer';
import { createTabStore, type TabStore } from './tab';

const HEARTBEAT_INTERVAL_MS = 30_000;

interface BridgeSpies {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly ping: ReturnType<typeof vi.fn>;
  readonly listDatabases: ReturnType<typeof vi.fn>;
  readonly setState: ReturnType<typeof vi.fn>;
  readonly getState: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly connection: ConnectionStore;
  readonly tab: TabStore;
  readonly explorer: ExplorerStore;
  readonly capabilities: ReturnType<typeof createCapabilitiesStore>;
  readonly notifier: Notifier;
  readonly bridge: BridgeSpies;
  /** Everything the store reported to the diagnostics sink, so nothing can be swallowed. */
  readonly logged: readonly { context: string; cause: unknown }[];
}

interface HarnessOptions {
  readonly profiles?: readonly ConnectionProfile[];
  readonly databasesByProfile?: Record<string, DatabaseInfo[]>;
  readonly appState?: Record<string, unknown>;
  readonly connectResult?: ActiveConnection;
}

const teardowns: (() => void)[] = [];

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const databasesByProfile = options.databasesByProfile ?? {};
  const bridge: BridgeSpies = {
    connect: vi.fn(() => Promise.resolve(options.connectResult)),
    ping: vi.fn(() => Promise.resolve(true)),
    listDatabases: vi.fn((id: string) => Promise.resolve(databasesByProfile[id] ?? [])),
    setState: vi.fn(() => Promise.resolve()),
    getState: vi.fn(() => Promise.resolve(options.appState ?? {})),
  };

  teardowns.push(
    installJoineryMock({
      connection: {
        list: () => Promise.resolve([...(options.profiles ?? [])]),
        connect: bridge.connect,
        disconnect: () => Promise.resolve(),
        ping: bridge.ping,
      },
      database: { list: bridge.listDatabases },
      explorer: { getChildren: () => Promise.resolve([]) },
      app: {
        getState: bridge.getState,
        setState: bridge.setState,
        saveTabs: () => Promise.resolve(),
      },
    })
  );

  const notifier: Notifier = {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  };
  teardowns.push(setNotifier(notifier));
  // Recorded rather than silenced: a store that logs an unexpected failure should be visible when
  // a test fails, and never printed when it passes.
  const logged: { context: string; cause: unknown }[] = [];
  teardowns.push(
    setDiagnosticsSink({
      error: (context, cause) => logged.push({ context, cause }),
      warn: (context, cause) => logged.push({ context, cause }),
    })
  );

  const capabilities = createCapabilitiesStore();
  const tab = createTabStore();
  const explorer = createExplorerStore({ capabilities });
  const connection = createConnectionStore({ tab, explorer, capabilities });
  teardowns.push(() => connection.getState().destroy());

  if (options.profiles?.length) {
    await connection.getState().loadProfiles();
  }

  return { connection, tab, explorer, capabilities, notifier, bridge, logged };
}

function pingCallsFor(bridge: BridgeSpies, connectionId: string): number {
  return bridge.ping.mock.calls.filter(([id]) => id === connectionId).length;
}

/** The original stubbed `tabState.activeTab`; here focus is set by opening a real query tab. */
function focusQueryTab(tab: TabStore, connectionId: string, databaseName: string): void {
  tab.getState().openQueryTab(connectionId, databaseName, undefined, false, false);
}

const profileA: ConnectionProfile = {
  id: 'profile-a',
  name: 'Profile A',
  engine: 'postgresql',
  server: 'host-a',
  port: 5432,
  authenticationType: 'sql',
  encrypt: false,
  trustServerCertificate: true,
  connectionTimeout: 30,
};
const profileB: ConnectionProfile = { ...profileA, id: 'profile-b', name: 'Profile B' };
const profileC: ConnectionProfile = { ...profileA, id: 'profile-c', name: 'Profile C' };

const ALL_THREE = [profileA, profileB, profileC];
const NO_DATABASES = {
  [profileA.id]: [],
  [profileB.id]: [],
  [profileC.id]: [],
};

beforeEach(() => {
  // Every describe block in the original used fake timers, because the heartbeat uses real ones
  // and a leaked interval outlives the test that created it.
  vi.useFakeTimers();
  // jsdom keeps localStorage across the tests in a file. Since Task 5 no store reads it — the
  // welcome flag and the settings object come from main-process `AppState` through
  // `persistence/hydrate.ts` — so this is now hygiene rather than a precondition.
  window.localStorage.clear();
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('connection store — disconnect requires connectionId (Phase 4)', () => {
  it('disconnect(connectionId) must require an explicit connectionId argument', async () => {
    // Spec: "Calling disconnect without an argument is a type error". Replaces the original's
    // `prototype.disconnect.length` count — see note 4 in the module comment.
    const { connection } = await makeHarness();
    // @ts-expect-error -- a bare disconnect() must not compile: the connectionId is required.
    await connection.getState().disconnect();
    // And at runtime it is inert rather than destructive — nothing was connected to begin with.
    expect(connection.getState().connectedProfileIds.size).toBe(0);
  });

  it('disconnects only the targeted profile when multiple are connected', async () => {
    // Spec: "Per-target disconnect" — disconnecting profile X SHALL affect only profile X.
    const { connection, explorer, tab } = await makeHarness({
      profiles: ALL_THREE,
      databasesByProfile: {
        [profileA.id]: [{ name: 'db-a' } as DatabaseInfo],
        [profileB.id]: [{ name: 'db-b' } as DatabaseInfo],
        [profileC.id]: [{ name: 'db-c' } as DatabaseInfo],
      },
    });

    for (const profile of ALL_THREE) {
      await connection.getState().connect(profile.id);
      explorer.getState().addServerNode(profile.id, profile.name);
    }

    // Focus profile A but ask for profile B to be disconnected.
    focusQueryTab(tab, profileA.id, 'db-a');

    await connection.getState().disconnect(profileB.id);

    const connected = connection.getState().connectedProfileIds;
    expect(connected.has(profileA.id)).toBe(true);
    expect(connected.has(profileB.id)).toBe(false);
    expect(connected.has(profileC.id)).toBe(true);
  });
});

describe('connection store — explorer survives single disconnect (spec 1.2)', () => {
  it('disconnecting one of three connections leaves the other two server nodes in rootNodes', async () => {
    const { connection, explorer, tab } = await makeHarness({
      profiles: ALL_THREE,
      databasesByProfile: NO_DATABASES,
    });

    for (const profile of ALL_THREE) {
      await connection.getState().connect(profile.id);
      explorer.getState().addServerNode(profile.id, profile.name);
    }

    focusQueryTab(tab, profileA.id, 'db-a');

    await connection.getState().disconnect(profileA.id);

    const connectionIds = explorer.getState().rootNodes.map(n => n.connectionId);
    expect(connectionIds).toEqual(expect.arrayContaining([profileB.id, profileC.id]));
    expect(connectionIds).not.toContain(profileA.id);
  });
});

describe('connection store — focus derives from the active tab (spec 1.3)', () => {
  it('returns the active query tab connectionId', async () => {
    const { connection, tab } = await makeHarness({ profiles: [profileA, profileB] });
    focusQueryTab(tab, profileA.id, 'db-a');
    expect(connection.getState().focusedConnectionId()).toBe(profileA.id);
    expect(connection.getState().focusedDatabaseName()).toBe('db-a');
  });

  it('updates when the active tab switches', async () => {
    const { connection, tab } = await makeHarness({ profiles: [profileA, profileB] });
    focusQueryTab(tab, profileA.id, 'db-a');
    expect(connection.getState().focusedConnectionId()).toBe(profileA.id);
    focusQueryTab(tab, profileB.id, 'db-b');
    expect(connection.getState().focusedConnectionId()).toBe(profileB.id);
    expect(connection.getState().focusedDatabaseName()).toBe('db-b');
  });

  it('is null when the active tab is not a query tab', async () => {
    const { connection, tab } = await makeHarness();
    // The workspace starts empty since Task 5 (hydration decides whether Welcome belongs), so the
    // welcome tab is opened explicitly here rather than assumed.
    tab.getState().showWelcome();
    expect(connection.getState().focusedConnectionId()).toBeNull();
    expect(connection.getState().focusedDatabaseName()).toBeNull();
  });

  it('is null when there is no active tab', async () => {
    const { connection, tab } = await makeHarness();
    tab.getState().closeAllTabs();
    expect(connection.getState().focusedConnectionId()).toBeNull();
    expect(connection.getState().focusedDatabaseName()).toBeNull();
  });
});

/*
 * Phase 7 — per-connection heartbeat.
 *
 * `connect(profileId)` calls `loadDatabases(profileId)`, which invokes `database.list` once at
 * connect time. Once the heartbeat starts, each 30s tick invokes `connection.ping` instead — the
 * cheap probe. So "did the heartbeat fire?" is answered by counting pings after the connect, not
 * by counting database reads.
 */
describe('connection store — per-connection heartbeat (spec 1.7)', () => {
  it('runs an independent heartbeat per connected profile', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);

    const baselineA = pingCallsFor(bridge, profileA.id);
    const baselineB = pingCallsFor(bridge, profileB.id);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(pingCallsFor(bridge, profileA.id)).toBe(baselineA + 1);
    expect(pingCallsFor(bridge, profileB.id)).toBe(baselineB + 1);
  });

  it('disconnecting one profile stops only its heartbeat; the other keeps ticking', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);
    await connection.getState().disconnect(profileA.id);

    const baselineA = pingCallsFor(bridge, profileA.id);
    const baselineB = pingCallsFor(bridge, profileB.id);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(pingCallsFor(bridge, profileA.id)).toBe(baselineA);
    expect(pingCallsFor(bridge, profileB.id)).toBe(baselineB + 1);
  });

  it('destroy() clears every per-connection heartbeat timer', async () => {
    const { connection } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);

    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

    connection.getState().destroy();

    // Let in-flight microtasks settle so the assertion sees the post-teardown timer queue.
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/*
 * Phase 8 — persistence migration (lastConnectionId → lastConnectedProfileIds[]).
 *
 * `restoreState()` is the only path that reads the legacy key. The rule: prefer
 * `lastConnectedProfileIds`; fall back to a one-element list from `lastConnectionId` only when the
 * new key is absent or empty.
 */
describe('connection store — persistence migration (spec 1.8)', () => {
  it('reconnects every id in lastConnectedProfileIds', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: ALL_THREE,
      databasesByProfile: NO_DATABASES,
      appState: { lastConnectedProfileIds: [profileA.id, profileB.id] },
    });

    await connection.getState().restoreState();

    const connected = connection.getState().connectedProfileIds;
    expect(connected.has(profileA.id)).toBe(true);
    expect(connected.has(profileB.id)).toBe(true);
    // C wasn't in the persisted list.
    expect(connected.has(profileC.id)).toBe(false);

    // Sanity: connect() invoked once per persisted id, not once per profile.
    const connectIds = bridge.connect.mock.calls.map(([id]) => id);
    expect(connectIds).toEqual(expect.arrayContaining([profileA.id, profileB.id]));
    expect(connectIds).not.toContain(profileC.id);
  });

  it('forward-migrates legacy lastConnectionId to a single-element restore list', async () => {
    const { connection } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
      appState: { lastConnectionId: profileA.id },
    });

    await connection.getState().restoreState();

    expect(connection.getState().connectedProfileIds.has(profileA.id)).toBe(true);
    expect(connection.getState().connectedProfileIds.has(profileB.id)).toBe(false);
  });

  it('prefers lastConnectedProfileIds when both old and new keys are present', async () => {
    const { connection } = await makeHarness({
      profiles: ALL_THREE,
      databasesByProfile: NO_DATABASES,
      appState: {
        lastConnectionId: profileC.id,
        lastConnectedProfileIds: [profileA.id, profileB.id],
      },
    });

    await connection.getState().restoreState();

    // The new key wins outright — the migration is forward-only, with no double restore.
    const connected = connection.getState().connectedProfileIds;
    expect(connected.has(profileA.id)).toBe(true);
    expect(connected.has(profileB.id)).toBe(true);
    expect(connected.has(profileC.id)).toBe(false);
  });
});

/*
 * Phase 7 supplementary — the bounded-retry contract from CLAUDE.md, plus the reentrancy lock, the
 * stale tick after disconnect, and the per-id (not global) reconnect lock.
 */
describe('connection store — heartbeat failure handling (spec 1.7 supplementary)', () => {
  it('three consecutive ping+reconnect failures self-stop the heartbeat for that id', async () => {
    const { connection, bridge, notifier, logged } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);

    // From here every call for profileA fails, reconnects included. profileB stays healthy.
    bridge.ping.mockImplementation((id: string) =>
      id === profileA.id ? Promise.reject(new Error('ping failed')) : Promise.resolve(true)
    );
    bridge.connect.mockImplementation((id: string) =>
      id === profileA.id
        ? Promise.reject(new Error('reconnect failed'))
        : Promise.resolve(undefined)
    );

    // Three ticks: each fails for A and increments its consecutive-failure count. The third
    // self-stops A's heartbeat and notifies.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(connection.getState().healthByConnection.get(profileA.id)).toBe(false);
    expect(notifier.error).toHaveBeenCalledWith(expect.stringContaining(profileA.name));

    // After the self-stop, further ticks fire no pings for A.
    const callsAAfterStop = pingCallsFor(bridge, profileA.id);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(pingCallsFor(bridge, profileA.id)).toBe(callsAAfterStop);

    // B is unaffected: still healthy, still ticking.
    expect(connection.getState().healthByConnection.get(profileB.id)).toBe(true);

    // New: the failures reached the diagnostics sink rather than being swallowed by the catch
    // blocks that keep the heartbeat alive.
    expect(
      logged.some(entry => entry.context.includes(`heartbeat ping failed for ${profileA.id}`))
    ).toBe(true);
    expect(
      logged.some(entry => entry.context.includes(`heartbeat reconnect failed for ${profileA.id}`))
    ).toBe(true);
  });

  it('a tick fired after disconnect is a no-op (stale-tick safety)', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);
    await connection.getState().disconnect(profileA.id);

    const beforeA = pingCallsFor(bridge, profileA.id);
    const beforeB = pingCallsFor(bridge, profileB.id);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);

    expect(pingCallsFor(bridge, profileA.id)).toBe(beforeA);
    expect(pingCallsFor(bridge, profileB.id)).toBeGreaterThan(beforeB);
  });

  it('reconnect lock is per-id — A reconnecting does not block B from ticking', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);

    bridge.ping.mockImplementation((id: string) =>
      id === profileA.id ? Promise.reject(new Error('ping failed')) : Promise.resolve(true)
    );
    bridge.connect.mockImplementation((id: string) =>
      id === profileA.id
        ? Promise.reject(new Error('reconnect failed'))
        : Promise.resolve(undefined)
    );

    const beforeB = pingCallsFor(bridge, profileB.id);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // B ticked exactly once in the same window — the reconnect lock is not a global gate.
    expect(pingCallsFor(bridge, profileB.id)).toBe(beforeB + 1);
    expect(connection.getState().healthByConnection.get(profileB.id)).toBe(true);
  });
});

/* Phase 8 supplementary — failure isolation, the restore cap, and the saved shape. */
describe('connection store — persistence migration edge cases (spec 1.8 supplementary)', () => {
  it('one failed reconnect does not block the others (allSettled semantics)', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: ALL_THREE,
      databasesByProfile: NO_DATABASES,
      appState: { lastConnectedProfileIds: [profileA.id, profileB.id, profileC.id] },
    });

    bridge.connect.mockImplementation((id: string) =>
      id === profileB.id ? Promise.reject(new Error('B unreachable')) : Promise.resolve(undefined)
    );

    await connection.getState().restoreState();

    const connected = connection.getState().connectedProfileIds;
    expect(connected.has(profileA.id)).toBe(true);
    expect(connected.has(profileB.id)).toBe(false);
    expect(connected.has(profileC.id)).toBe(true);
  });

  it('caps restore at MAX_RESTORE_CONNECTIONS (20) when the persisted list overflows', async () => {
    const manyProfiles = Array.from({ length: 25 }, (_, i) => ({
      ...profileA,
      id: `profile-${i.toString().padStart(2, '0')}`,
      name: `Profile ${i}`,
    }));
    const databasesByProfile: Record<string, DatabaseInfo[]> = {};
    for (const p of manyProfiles) databasesByProfile[p.id] = [];

    const { connection, bridge } = await makeHarness({
      profiles: manyProfiles,
      databasesByProfile,
      appState: { lastConnectedProfileIds: manyProfiles.map(p => p.id) },
    });

    await connection.getState().restoreState();

    const connectIds = bridge.connect.mock.calls.map(([id]) => id);
    expect(connectIds).toHaveLength(20);
    for (const profile of manyProfiles.slice(0, 20)) {
      expect(connectIds).toContain(profile.id);
    }
    for (const profile of manyProfiles.slice(20)) {
      expect(connectIds).not.toContain(profile.id);
    }
  });

  it('saveState writes lastConnectedProfileIds and never the legacy key', async () => {
    const { connection, bridge } = await makeHarness({
      profiles: [profileA, profileB],
      databasesByProfile: NO_DATABASES,
    });

    await connection.getState().connect(profileA.id);
    await connection.getState().connect(profileB.id);

    // connect() calls saveState() itself, so the last call reflects the post-connect-B state.
    const lastCall = bridge.setState.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(lastCall).toBeDefined();
    expect(lastCall?.['lastConnectedProfileIds']).toEqual(
      expect.arrayContaining([profileA.id, profileB.id])
    );
    expect(lastCall).not.toHaveProperty('lastConnectionId');
  });
});

/*
 * Capabilities wiring. The original's default stub resolved `connect` with `undefined`, so the
 * branch reading real `capabilities`/`engineVariant` off an `ActiveConnection` had no coverage;
 * these two specs pin both sides of that fallback.
 */
describe('connection store — capabilities wiring', () => {
  const dsqlCapabilities: EngineCapabilities = {
    supportsMultipleDatabases: false,
    supportsDatabaseManagement: false,
    supportsStoredProcedures: false,
    supportsTriggers: false,
    supportsBackupRestore: false,
  };

  it('connect() populates the store from a real ActiveConnection, and disconnect() reverts it', async () => {
    const activeConnection: ActiveConnection = {
      id: profileA.id,
      profile: profileA,
      status: 'connected',
      engineVariant: 'dsql',
      capabilities: dsqlCapabilities,
    };
    const { connection, capabilities } = await makeHarness({
      profiles: [profileA],
      databasesByProfile: { [profileA.id]: [] },
      connectResult: activeConnection,
    });

    await connection.getState().connect(profileA.id);

    expect(selectCapabilitiesFor(profileA.id)(capabilities.getState())).toEqual(dsqlCapabilities);
    expect(selectVariantFor(profileA.id)(capabilities.getState())).toBe('dsql');

    await connection.getState().disconnect(profileA.id);

    expect(selectCapabilitiesFor(profileA.id)(capabilities.getState())).toEqual(FULL_CAPABILITIES);
    expect(selectVariantFor(profileA.id)(capabilities.getState())).toBeUndefined();
  });

  it('connect() falls back to FULL_CAPABILITIES / undefined variant when connect resolves undefined', async () => {
    // No `connectResult`, pinning the `active?.capabilities ?? FULL_CAPABILITIES` branch.
    const { connection, capabilities } = await makeHarness({
      profiles: [profileA],
      databasesByProfile: { [profileA.id]: [] },
    });

    await connection.getState().connect(profileA.id);

    expect(selectCapabilitiesFor(profileA.id)(capabilities.getState())).toEqual(FULL_CAPABILITIES);
    expect(selectVariantFor(profileA.id)(capabilities.getState())).toBeUndefined();
  });
});

describe('where database context comes from (J-59)', () => {
  /**
   * Focus used to derive from the active QUERY tab and nothing else. The chat SIDE PANEL therefore
   * had context — the query tab behind it was still active — while a chat TAB had none, and the
   * model was asked about "your database" with no connection, no database and no engine. The tab
   * is the surface a user opens for the LONGER conversation, so it was the weaker one.
   */
  function tabsWith(active: { type: string; connectionId?: string; databaseName?: string }) {
    const tab = { id: 't1', title: 't', icon: 'i', ...active } as never;
    return { tabs: [tab], activeTabId: 't1' } as never;
  }

  it('reads a query tab, as it always has', () => {
    const state = tabsWith({ type: 'query', connectionId: 'c1', databaseName: 'sales' });
    expect(selectFocusedConnectionId(state)).toBe('c1');
    expect(selectFocusedDatabaseName(state)).toBe('sales');
  });

  it('reads a chat tab’s own target, which it could not before', () => {
    const state = tabsWith({ type: 'chat', connectionId: 'c1', databaseName: 'sales' });
    expect(selectFocusedConnectionId(state)).toBe('c1');
    expect(selectFocusedDatabaseName(state)).toBe('sales');
  });

  it('still answers null for a chat tab opened without one', () => {
    // Opening from a surface that had no context hands none on — and the context line says so
    // rather than implying a database the model was never told about.
    const state = tabsWith({ type: 'chat' });
    expect(selectFocusedConnectionId(state)).toBeNull();
    expect(selectFocusedDatabaseName(state)).toBeNull();
  });

  it('still answers null for a tab type that carries no connection', () => {
    // Deliberately NOT widened to every tab type: a welcome tab has no target to speak for.
    const state = tabsWith({ type: 'welcome' });
    expect(selectFocusedConnectionId(state)).toBeNull();
  });
});
