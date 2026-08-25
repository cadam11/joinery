/**
 * Connections: the profile list, which of them are open, each one's database list and health,
 * and the per-connection heartbeat that keeps that health honest. Multi-connection is
 * first-class — every map here is keyed by profile id and every teardown touches exactly one
 * key, which is the property the ported spec exists to pin.
 *
 * Ported from `packages/renderer/src/app/core/state/connection.state.ts`. Conventions:
 * `capabilities.ts`.
 *
 * Focus is *derived* from the active query tab and is never set directly, so this store reads
 * the tab store rather than owning a "current connection" field. The three heartbeat bookkeeping
 * collections are closure resources, not state: nothing renders an interval handle, and a
 * re-render per heartbeat tick would be a re-render per 30 seconds per connection for no visible
 * change.
 */

import { create } from 'zustand';
import { useMemo } from 'react';
import { FULL_CAPABILITIES } from '@joinery/shared';
import type {
  AppState,
  ConnectionProfile,
  DatabaseInfo,
  TestConnectionResult,
} from '@joinery/shared';
import { ipc, isIpcAvailable } from '../ipc';
import { capabilitiesStore, type CapabilitiesStore } from './capabilities';
import { diagnostics, notify } from './diagnostics';
import { explorerStore, type ExplorerStore } from './explorer';
import {
  selectActiveTab,
  tabStore,
  useTabStore,
  type Tab,
  type TabsSlice,
  type TabStore,
} from './tab';

/**
 * Heartbeat tuning, carried over unchanged. 30s tick; each tick has 10s to complete its IPC call
 * before counting as a failure (strictly less than the interval so ticks cannot overlap); after
 * 3 consecutive failures the heartbeat stops itself and the user is told — bounded retry per
 * CLAUDE.md.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TICK_TIMEOUT_MS = 10_000;
const HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Hard cap on launch reconnects. 20 is well above any realistic user count; the cap is the
 * "bound every loop" guard against pathological persisted state. Raising it likely means there
 * is a bug elsewhere.
 */
const MAX_RESTORE_CONNECTIONS = 20;

/**
 * Bounds an async operation by racing it against a timer. Rejects if it does not settle within
 * `ms`; the underlying promise is left to settle on its own — best effort, because the bridge
 * has no cancellation.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the connection editor can actually produce. A profile being created has no id yet — the main
 * process assigns one (`connection-profiles.ts:121-129`) — but preload declares
 * `connection.save(profile: ConnectionProfile)` with `id` required, so the type cannot express it.
 * Derived from the shared type rather than hand-written, and the single cast it forces lives inside
 * `saveProfile`. The Angular renderer did the same thing at `ipc.service.ts:474-481`, one layer
 * further out and undocumented.
 */
export type ProfileDraft = Omit<ConnectionProfile, 'id'> & { id?: string };

export interface ConnectionStoreState {
  readonly profiles: readonly ConnectionProfile[];
  readonly connecting: boolean;
  readonly loadingDatabases: boolean;
  readonly connectedProfileIds: ReadonlySet<string>;
  readonly databasesByConnection: ReadonlyMap<string, readonly DatabaseInfo[]>;
  readonly selectedDatabaseByConnection: ReadonlyMap<string, string | null>;
  readonly healthByConnection: ReadonlyMap<string, boolean>;

  readonly loadProfiles: () => Promise<void>;
  readonly saveProfile: (
    profile: ProfileDraft,
    password?: string,
    sshPassword?: string,
    sshPassphrase?: string
  ) => Promise<ConnectionProfile | null>;
  readonly deleteProfile: (profileId: string) => Promise<boolean>;
  readonly testConnection: (
    profile: ConnectionProfile,
    password?: string,
    sshPassword?: string,
    sshPassphrase?: string,
    opts?: { notifyErrors?: boolean }
  ) => Promise<TestConnectionResult>;

  readonly connect: (profileId: string) => Promise<boolean>;
  /** No default argument: `disconnect()` is a compile error, by design. */
  readonly disconnect: (connectionId: string) => Promise<void>;

  readonly loadDatabases: (connectionId: string) => Promise<void>;
  readonly getDatabasesForConnection: (connectionId: string) => Promise<readonly DatabaseInfo[]>;
  readonly clearDatabaseCache: (connectionId: string) => void;
  readonly selectDatabase: (connectionId: string, name: string | null) => void;

  readonly addDatabaseLocal: (connectionId: string, info: DatabaseInfo) => void;
  readonly removeDatabaseLocal: (connectionId: string, name: string) => void;
  readonly renameDatabaseLocal: (connectionId: string, oldName: string, newName: string) => void;

  readonly restoreState: () => Promise<void>;
  readonly saveState: () => Promise<void>;

  /**
   * Imperative reads of tab-derived focus, for callers that are not components (the chat store,
   * the Task 7 native-menu bridge). Components subscribe with `selectFocusedConnectionId` /
   * `useMostRecentConnectionId` instead.
   */
  readonly focusedConnectionId: () => string | null;
  readonly focusedDatabaseName: () => string | null;
  readonly mostRecentConnectionId: () => string | null;

  /** Clears every heartbeat this store owns. The window-close / hot-reload teardown. */
  readonly destroy: () => void;
}

export interface ConnectionStoreDeps {
  readonly tab: TabStore;
  readonly explorer: ExplorerStore;
  readonly capabilities: CapabilitiesStore;
}

export type ConnectionStore = ReturnType<typeof createConnectionStore>;

export function createConnectionStore(deps: ConnectionStoreDeps) {
  // Heartbeat bookkeeping — resources, not state. See the module comment.
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  const reconnecting = new Set<string>();
  const consecutiveFailures = new Map<string, number>();

  return create<ConnectionStoreState>()((set, get) => {
    const setHealth = (connectionId: string, healthy: boolean): void =>
      set(state => {
        const healthByConnection = new Map(state.healthByConnection);
        healthByConnection.set(connectionId, healthy);
        return { healthByConnection };
      });

    const setDatabases = (connectionId: string, databases: readonly DatabaseInfo[]): void =>
      set(state => {
        const databasesByConnection = new Map(state.databasesByConnection);
        databasesByConnection.set(connectionId, databases);
        return { databasesByConnection };
      });

    const stopHeartbeat = (connectionId: string): void => {
      const handle = heartbeats.get(connectionId);
      if (handle) {
        clearInterval(handle);
        heartbeats.delete(connectionId);
      }
      reconnecting.delete(connectionId);
      consecutiveFailures.delete(connectionId);
    };

    const pingConnection = async (connectionId: string): Promise<boolean> => {
      try {
        await withTimeout(
          ipc().connection.ping(connectionId),
          HEARTBEAT_TICK_TIMEOUT_MS,
          `heartbeat ping for ${connectionId}`
        );
        return true;
      } catch (error) {
        diagnostics.warn(`heartbeat ping failed for ${connectionId}`, error);
        return false;
      }
    };

    // One retry per failed tick. After MAX_CONSECUTIVE_FAILURES the heartbeat stops itself and
    // the user is told to reconnect manually — bounded retry per CLAUDE.md.
    const attemptReconnect = async (connectionId: string): Promise<void> => {
      reconnecting.add(connectionId);
      try {
        // Capabilities are deliberately not re-synced: they are set on the initial connect(),
        // are stable per profile, and are only cleared on disconnect.
        await withTimeout(
          ipc().connection.connect(connectionId),
          HEARTBEAT_TICK_TIMEOUT_MS,
          `heartbeat reconnect for ${connectionId}`
        );
        setHealth(connectionId, true);
        consecutiveFailures.set(connectionId, 0);
        notify.info('Connection restored');
      } catch (error) {
        diagnostics.warn(`heartbeat reconnect failed for ${connectionId}`, error);
        const failures = (consecutiveFailures.get(connectionId) ?? 0) + 1;
        consecutiveFailures.set(connectionId, failures);
        if (failures >= HEARTBEAT_MAX_CONSECUTIVE_FAILURES) {
          const profileName = selectProfileFor(connectionId)(get())?.name ?? connectionId;
          notify.error(
            `Lost connection to ${profileName} after ${failures} attempts. Reconnect manually to retry.`
          );
          stopHeartbeat(connectionId);
        }
      } finally {
        reconnecting.delete(connectionId);
      }
    };

    const heartbeatTick = async (connectionId: string): Promise<void> => {
      // Reentrancy guard: a previous tick is still mid-reconnect.
      if (reconnecting.has(connectionId)) return;
      // The connection went away after the interval was scheduled.
      if (!get().connectedProfileIds.has(connectionId)) {
        stopHeartbeat(connectionId);
        return;
      }

      if (await pingConnection(connectionId)) {
        setHealth(connectionId, true);
        consecutiveFailures.set(connectionId, 0);
        return;
      }

      setHealth(connectionId, false);
      await attemptReconnect(connectionId);
    };

    // Idempotent: restarting an existing heartbeat replaces the prior interval handle.
    const startHeartbeat = (connectionId: string): void => {
      stopHeartbeat(connectionId);
      setHealth(connectionId, true);
      consecutiveFailures.set(connectionId, 0);
      heartbeats.set(
        connectionId,
        setInterval(() => void heartbeatTick(connectionId), HEARTBEAT_INTERVAL_MS)
      );
    };

    // Strictly per-connection teardown — touches only the targeted id's state.
    const cleanupConnectionState = (connectionId: string): void => {
      set(state => {
        const connectedProfileIds = new Set(state.connectedProfileIds);
        connectedProfileIds.delete(connectionId);
        const databasesByConnection = new Map(state.databasesByConnection);
        databasesByConnection.delete(connectionId);
        const selectedDatabaseByConnection = new Map(state.selectedDatabaseByConnection);
        selectedDatabaseByConnection.delete(connectionId);
        const healthByConnection = new Map(state.healthByConnection);
        healthByConnection.delete(connectionId);
        return {
          connectedProfileIds,
          databasesByConnection,
          selectedDatabaseByConnection,
          healthByConnection,
        };
      });
      stopHeartbeat(connectionId);
      deps.explorer.getState().removeServerNode(connectionId);
      deps.capabilities.getState().clearCapabilities(connectionId);
    };

    // Prefer the new key. If it is absent (state written before the multi-connection upgrade)
    // and the deprecated single-id key is set, treat that as a one-element list. This is the
    // ONLY path that reads `lastConnectionId`.
    const resolveProfileIdsToRestore = (state: AppState): string[] => {
      const fromNewKey = state.lastConnectedProfileIds ?? [];
      if (fromNewKey.length > 0) return fromNewKey.slice(0, MAX_RESTORE_CONNECTIONS);
      const legacyId = state.lastConnectionId ?? null;
      return legacyId ? [legacyId] : [];
    };

    // Reconnect each profile independently — `allSettled` so one failure does not block the
    // others. Each success adds its server node to the explorer; failures already toasted
    // inside connect().
    const reconnectProfiles = async (profileIds: readonly string[]): Promise<void> => {
      const profiles = get().profiles;
      const results = await Promise.allSettled(
        profileIds.map(async id => {
          const profile = profiles.find(p => p.id === id);
          if (!profile) return;
          if (!(await get().connect(id))) return;
          deps.explorer.getState().addServerNode(id, profile.name);
          void deps.explorer.getState().expandNode(`server-${id}`);
        })
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          diagnostics.error('failed to restore connection', result.reason);
        }
      }
    };

    return {
      profiles: [],
      connecting: false,
      loadingDatabases: false,
      connectedProfileIds: new Set<string>(),
      databasesByConnection: new Map(),
      selectedDatabaseByConnection: new Map(),
      healthByConnection: new Map(),

      loadProfiles: async () => {
        try {
          set({ profiles: await ipc().connection.list() });
        } catch (error) {
          notify.error('Failed to load connection profiles');
          diagnostics.error('failed to load profiles', error);
        }
      },

      saveProfile: async (profile, password, sshPassword, sshPassphrase) => {
        try {
          // The one cast `ProfileDraft` exists to localise: a draft with no id is exactly what the
          // main process expects for a create, and preload's declaration cannot say so.
          const saved = await ipc().connection.save(
            profile as ConnectionProfile,
            password,
            sshPassword,
            sshPassphrase
          );
          await get().loadProfiles();
          notify.success('Connection saved successfully');
          return saved;
        } catch (error) {
          // Main-process errors (e.g. duplicate-name rejection) carry a useful user-facing
          // message; surface it rather than the generic fallback.
          const message = error instanceof Error ? error.message : null;
          notify.error(message || 'Failed to save connection');
          diagnostics.error('failed to save profile', error);
          return null;
        }
      },

      deleteProfile: async profileId => {
        try {
          if (get().connectedProfileIds.has(profileId)) {
            await get().disconnect(profileId);
          }
          await ipc().connection.delete(profileId);
          await get().loadProfiles();
          notify.success('Connection deleted');
          return true;
        } catch (error) {
          notify.error('Failed to delete connection');
          diagnostics.error('failed to delete profile', error);
          return false;
        }
      },

      /**
       * Always resolves with a full `TestConnectionResult` (including error code and guidance) so
       * callers can render the details inline; a bridge-level throw is folded into a synthesized
       * failure rather than a second shape. Callers that render failures themselves pass
       * `notifyErrors: false` to suppress the error toast — the success toast always fires.
       */
      testConnection: async (profile, password, sshPassword, sshPassphrase, opts = {}) => {
        const notifyErrors = opts.notifyErrors ?? true;
        try {
          set({ connecting: true });
          const result = await ipc().connection.test(profile, password, sshPassword, sshPassphrase);
          if (result.success) {
            notify.success(`Connected to ${result.serverVersion || 'SQL Server'}`);
          } else if (notifyErrors) {
            notify.error(result.error || 'Connection failed');
          }
          return result;
        } catch (error) {
          if (notifyErrors) notify.error('Connection test failed');
          diagnostics.error('connection test failed', error);
          return { success: false, error: 'Connection test failed' };
        } finally {
          set({ connecting: false });
        }
      },

      connect: async profileId => {
        const profile = get().profiles.find(p => p.id === profileId);
        if (!profile) {
          notify.error('Connection profile not found');
          return false;
        }

        try {
          set({ connecting: true });
          const active = await ipc().connection.connect(profileId);
          // `?.` deliberately: preload types this non-nullable, but a main-process handler that
          // resolves without a value would otherwise crash here instead of degrading to
          // "fully capable", which is this store's documented default.
          deps.capabilities.getState().setCapabilities(profileId, {
            capabilities: active?.capabilities ?? FULL_CAPABILITIES,
            variant: active?.engineVariant,
          });
          set(state => {
            if (state.connectedProfileIds.has(profileId)) return state;
            const connectedProfileIds = new Set(state.connectedProfileIds);
            connectedProfileIds.add(profileId);
            return { connectedProfileIds };
          });
          setHealth(profileId, true);
          notify.success(`Connected to ${profile.name}`);
          await get().loadDatabases(profileId);
          void get().saveState();
          startHeartbeat(profileId);
          return true;
        } catch (error) {
          notify.error('Failed to connect');
          diagnostics.error('failed to connect', error);
          return false;
        } finally {
          set({ connecting: false });
        }
      },

      // Other open connections — heartbeats, caches, server nodes — are untouched.
      disconnect: async connectionId => {
        if (!get().connectedProfileIds.has(connectionId)) return;

        try {
          await ipc().connection.disconnect(connectionId);
        } catch (error) {
          diagnostics.error('error disconnecting', error);
        }

        // Both the happy and the error path route here, so per-connection resources never leak.
        cleanupConnectionState(connectionId);
        notify.info('Disconnected');
        void get().saveState();
      },

      loadDatabases: async connectionId => {
        try {
          set({ loadingDatabases: true });
          setDatabases(connectionId, await ipc().database.list(connectionId));
        } catch (error) {
          notify.error('Failed to load databases');
          diagnostics.error('failed to load databases', error);
        } finally {
          set({ loadingDatabases: false });
        }
      },

      /**
       * Databases for any connection, cached and fetched on demand. Used by per-tab database
       * pickers, which may reference a connection that is not the focused one.
       */
      getDatabasesForConnection: async connectionId => {
        const cached = get().databasesByConnection.get(connectionId);
        if (cached) return cached;
        const databases = await ipc().database.list(connectionId);
        setDatabases(connectionId, databases);
        return databases;
      },

      clearDatabaseCache: connectionId =>
        set(state => {
          if (!state.databasesByConnection.has(connectionId)) return state;
          const databasesByConnection = new Map(state.databasesByConnection);
          databasesByConnection.delete(connectionId);
          return { databasesByConnection };
        }),

      selectDatabase: (connectionId, name) => {
        set(state => {
          const selectedDatabaseByConnection = new Map(state.selectedDatabaseByConnection);
          selectedDatabaseByConnection.set(connectionId, name);
          return { selectedDatabaseByConnection };
        });
        void get().saveState();
      },

      /*
       * The three local mutators: use them from CRUD handlers (create / drop / rename / restore)
       * when the operation succeeded and the new state is known — they skip the loadDatabases()
       * round-trip and let the picker and the tree update synchronously. On *failure* the caller
       * falls back to loadDatabases() to re-sync from the server. All three are idempotent.
       */
      addDatabaseLocal: (connectionId, info) =>
        set(state => {
          const current = state.databasesByConnection.get(connectionId) ?? [];
          if (current.some(d => d.name === info.name)) return state;
          const databasesByConnection = new Map(state.databasesByConnection);
          databasesByConnection.set(connectionId, [...current, info]);
          return { databasesByConnection };
        }),

      removeDatabaseLocal: (connectionId, name) =>
        set(state => {
          const current = state.databasesByConnection.get(connectionId);
          if (!current || !current.some(d => d.name === name)) return state;
          const databasesByConnection = new Map(state.databasesByConnection);
          databasesByConnection.set(
            connectionId,
            current.filter(d => d.name !== name)
          );
          return { databasesByConnection };
        }),

      renameDatabaseLocal: (connectionId, oldName, newName) =>
        set(state => {
          const current = state.databasesByConnection.get(connectionId);
          if (!current || !current.some(d => d.name === oldName)) return state;
          const databasesByConnection = new Map(state.databasesByConnection);
          databasesByConnection.set(
            connectionId,
            current.map(d => (d.name === oldName ? { ...d, name: newName } : d))
          );
          return { databasesByConnection };
        }),

      /**
       * Initialize from saved app state on startup. Forward-migrates the legacy
       * `lastConnectionId` to `lastConnectedProfileIds` on the first launch after the
       * multi-connection upgrade.
       */
      restoreState: async () => {
        if (!isIpcAvailable()) return;

        try {
          const idsToRestore = resolveProfileIdsToRestore(await ipc().app.getState());
          if (idsToRestore.length === 0) return;
          if (get().profiles.length === 0) {
            await get().loadProfiles();
          }
          await reconnectProfiles(idsToRestore);
        } catch (error) {
          diagnostics.error('failed to restore connection state', error);
          notify.warning('Could not restore previous connections');
        }
      },

      /**
       * Persist the set of currently-connected profile ids. Per-tab `(connectionId,
       * databaseName)` is persisted independently by the tab store; the legacy global
       * `lastDatabase` key is no longer written.
       */
      saveState: async () => {
        if (!isIpcAvailable()) return;
        try {
          await ipc().app.setState({
            lastConnectedProfileIds: Array.from(get().connectedProfileIds),
          });
        } catch (error) {
          diagnostics.error('failed to save connection state', error);
        }
      },

      focusedConnectionId: () => selectFocusedConnectionId(deps.tab.getState()),
      focusedDatabaseName: () => selectFocusedDatabaseName(deps.tab.getState()),
      mostRecentConnectionId: () => {
        const tabs = deps.tab.getState();
        return resolveMostRecentConnectionId(
          get().connectedProfileIds,
          tabs.tabs,
          tabs.activeTabId
        );
      },

      destroy: () => {
        for (const handle of heartbeats.values()) clearInterval(handle);
        heartbeats.clear();
        reconnecting.clear();
        consecutiveFailures.clear();
      },
    };
  });
}

export const connectionStore = createConnectionStore({
  tab: tabStore,
  explorer: explorerStore,
  capabilities: capabilitiesStore,
});
export const useConnectionStore = connectionStore;

// ── Selectors ────────────────────────────────────────────────────────────────────────────────

export function selectHasProfiles(state: ConnectionStoreState): boolean {
  return state.profiles.length > 0;
}

/** True when at least one connection is open — the sidebar tree's visibility key. */
export function selectHasAnyConnection(state: ConnectionStoreState): boolean {
  return state.connectedProfileIds.size > 0;
}

export function selectIsConnected(connectionId: string) {
  return (state: ConnectionStoreState): boolean => state.connectedProfileIds.has(connectionId);
}

/** Stable identity per connection while the list is unchanged; the empty case is a fresh []. */
export function selectDatabasesFor(connectionId: string | null) {
  return (state: ConnectionStoreState): readonly DatabaseInfo[] => {
    if (!connectionId) return EMPTY_DATABASES;
    return state.databasesByConnection.get(connectionId) ?? EMPTY_DATABASES;
  };
}

/** Shared so the "no databases" answer has one identity and cannot look like a change. */
const EMPTY_DATABASES: readonly DatabaseInfo[] = [];

export function selectSelectedDatabaseFor(connectionId: string | null) {
  return (state: ConnectionStoreState): string | null => {
    if (!connectionId) return null;
    return state.selectedDatabaseByConnection.get(connectionId) ?? null;
  };
}

export function selectHealthFor(connectionId: string | null) {
  // Absent entry = healthy: no heartbeat result has come back yet.
  return (state: ConnectionStoreState): boolean => {
    if (!connectionId) return true;
    return state.healthByConnection.get(connectionId) ?? true;
  };
}

export function selectProfileFor(connectionId: string | null) {
  return (state: ConnectionStoreState): ConnectionProfile | null => {
    if (!connectionId) return null;
    return state.profiles.find(p => p.id === connectionId) ?? null;
  };
}

/**
 * The database a "new query" action should target for this connection:
 *   1. the user's last-selected database for it;
 *   2. the profile's configured default, but only if it is actually in the loaded list — this
 *      guards a stale `profile.database` pointing at a dropped database;
 *   3. the first database the server returned.
 * Null only when the connection has no databases at all.
 */
export function selectDefaultDatabaseFor(connectionId: string) {
  return (state: ConnectionStoreState): string | null => {
    const selected = selectSelectedDatabaseFor(connectionId)(state);
    if (selected) return selected;
    const profile = selectProfileFor(connectionId)(state);
    const databases = selectDatabasesFor(connectionId)(state);
    if (profile?.database && databases.some(d => d.name === profile.database)) {
      return profile.database;
    }
    return databases[0]?.name ?? null;
  };
}

/**
 * Focus derives from the active tab: a query tab, or a chat tab carrying the target it was opened
 * from (J-59). A null or otherwise-typed active tab means no focus, and the status bar shows
 * disconnected. Selectors over the TAB store, because that is the state they read.
 *
 * The chat arm is what closes J-59. Focus used to be the active QUERY tab and nothing else, so the
 * chat SIDE PANEL had context — the query tab behind it was still active — while a chat TAB had
 * none: the model was asked about "your database" with no connection, no database and no engine,
 * on the surface a user opens for the LONGER conversation. A chat tab now carries its target the
 * way every other tab type does, set when it is opened.
 */
export function selectFocusedConnectionId(state: TabsSlice): string | null {
  const tab = selectActiveTab(state);
  if (!tab || (tab.type !== 'query' && tab.type !== 'chat')) return null;
  return tab.connectionId ?? null;
}

export function selectFocusedDatabaseName(state: TabsSlice): string | null {
  const tab = selectActiveTab(state);
  if (!tab || (tab.type !== 'query' && tab.type !== 'chat')) return null;
  return tab.databaseName ?? null;
}

/**
 * The connection a user-driven action like ⌘N should target by default. Three stages:
 *   1. the focused query tab's connection — what the user is "in";
 *   2. the most recently opened query tab whose connection is still live. Tab order is creation
 *      order, so the last query tab is the one most recently spawned; this survives the user
 *      closing the active tab as long as another tab targets the same connection;
 *   3. the most recently added entry of `connectedProfileIds` (the last successful connect).
 * Null only when nothing is connected.
 */
export function resolveMostRecentConnectionId(
  connectedProfileIds: ReadonlySet<string>,
  tabs: readonly Tab[],
  activeTabId: string
): string | null {
  const focused = selectFocusedConnectionId({ tabs, activeTabId });
  if (focused && connectedProfileIds.has(focused)) return focused;

  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i];
    if (tab?.type === 'query' && tab.connectionId && connectedProfileIds.has(tab.connectionId)) {
      return tab.connectionId;
    }
  }

  const ids = [...connectedProfileIds];
  return ids[ids.length - 1] ?? null;
}

/**
 * The cross-store read as a hook, because it needs both stores and both the sidebar and the
 * status bar re-render on it. Three narrow subscriptions rather than one wide one: a
 * database-list change must not recompute it.
 */
export function useMostRecentConnectionId(): string | null {
  const connectedProfileIds = useConnectionStore(state => state.connectedProfileIds);
  const tabs = useTabStore(state => state.tabs);
  const activeTabId = useTabStore(state => state.activeTabId);

  return useMemo(
    () => resolveMostRecentConnectionId(connectedProfileIds, tabs, activeTabId),
    [connectedProfileIds, tabs, activeTabId]
  );
}
