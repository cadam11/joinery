/**
 * The one source of truth for "what is Docker doing", shared by the status-bar pip, the panel and the
 * welcome tab.
 *
 * ── Why this exists rather than three effects ────────────────────────────────────────────────
 *
 * There were three, and they disagreed. The Angular status bar polled `detect` + `getContainers` every
 * 30s into its own signals (`status-bar.component.ts:539`); the Docker panel called both again on every
 * open into its own signals and refreshed them after every action; and Task 19a's welcome tab added a
 * third one-shot effect for its own summary line. So opening the panel gave numbers the bar could
 * disagree with for up to 30 seconds, and starting a container from the panel left the bar's count stale.
 *
 * Two TanStack queries under stable keys is the whole fix: every consumer of `useDocker()` shares one
 * fetch and one cache entry, and a mutation invalidates the key rather than telling each consumer to
 * re-read. The 30s interval is the Angular one, kept.
 */

import { useCallback } from 'react';
import type { DockerStatus, DockerVolume } from '@joinery/shared';

import { isIpcAvailable, useIpcMutation, useIpcQuery, useInvalidateIpc } from '../../ipc';
import { diagnostics, notify } from '../../state/diagnostics';
import { toPip, toRows, type ContainerRow, type DockerPip } from './docker-model';

/** The Angular poll interval, kept: Docker state changes without the app being told. */
export const DOCKER_POLL_MS = 30_000;

export interface DockerView {
  readonly pip: DockerPip;
  readonly rows: readonly ContainerRow[];
  readonly status: DockerStatus | undefined;
  /** The named volumes the database containers mount — see `docker-model.ts` finding 3 (J-70). */
  readonly volumes: readonly DockerVolume[];
  readonly loading: boolean;
  /** The detect call rejected. Distinct from "Docker is not running", which is a successful answer. */
  readonly failed: boolean;
  /** Re-reads both queries. The panel's Refresh, and what every mutation does on the way out. */
  readonly refresh: () => void;
}

/**
 * Docker's state. Safe to call from several components at once — that is the point.
 *
 * `enabled: isIpcAvailable()` rather than a guard at each call site: in a plain browser tab (the dev
 * pages, a unit test without the mock) there is no bridge, and a query that would throw is better not
 * started than caught.
 */
export function useDocker(): DockerView {
  const available = isIpcAvailable();

  const status = useIpcQuery({
    namespace: 'docker',
    operation: 'detect',
    enabled: available,
    refetchInterval: DOCKER_POLL_MS,
  });

  const containers = useIpcQuery({
    namespace: 'docker',
    operation: 'getContainers',
    // Only once Docker is up: `getContainers` calls `detect` again main-side, so asking it while the
    // daemon is down is a second pointless failure every 30 seconds.
    enabled: available && status.data?.isRunning === true,
    refetchInterval: DOCKER_POLL_MS,
  });

  const volumes = useIpcQuery({
    namespace: 'docker',
    operation: 'getVolumes',
    enabled: available && status.data?.isRunning === true,
  });

  const invalidate = useInvalidateIpc();
  // The whole namespace, because the three read the same container list and must not disagree about
  // which containers count. They do NOT go stale together: only `detect` and `getContainers` carry
  // `refetchInterval`, so a named volume that appears between refreshes waits for an invalidate
  // while its container row shows up within 30s. Deliberate — the volumes are visible only in the
  // panel, and polling them would cost every running app an extra `listVolumes` + `docker ps` every
  // 30 seconds for a list nobody is looking at. Refresh and every mutation invalidate.
  const refresh = useCallback(() => {
    void invalidate.namespace('docker');
  }, [invalidate]);

  return {
    pip: toPip({
      status: status.data,
      containers: containers.data,
      failed: status.isError,
      loading: available && status.isPending,
    }),
    rows: toRows(containers.data ?? []),
    status: status.data,
    volumes: volumes.data ?? [],
    loading: status.isPending || containers.isPending,
    failed: status.isError,
    refresh,
  };
}

export interface DockerActions {
  readonly start: (container: ContainerRow) => Promise<void>;
  readonly stop: (container: ContainerRow) => Promise<void>;
  readonly create: (options: {
    readonly name: string;
    readonly password: string;
    readonly port: number;
  }) => Promise<boolean>;
  /** The container id an action is in flight for, or `null`. Drives one spinner, on one row. */
  readonly busyId: string | null;
  readonly creating: boolean;
}

/**
 * Start, stop and create. Separate from `useDocker` because only the panel needs them — the pip and the
 * welcome tab are read-only, and a hook that handed them three mutations they never call would put three
 * more subscriptions in the status bar.
 *
 * Start and stop are the same six lines because both handlers now reject with Docker's own message
 * (`main/src/ipc/docker.ipc.ts`). Stop used to re-read the container list afterwards and report "… is
 * still running" itself, because its handler dropped the detector's `{ success: false, error }` — J-71
 * fixed the handler, so the catch arm is the whole report and the extra round trip is gone.
 */
export function useDockerActions(refresh: () => void): DockerActions {
  const startContainer = useIpcMutation({ namespace: 'docker', operation: 'startContainer' });
  const stopContainer = useIpcMutation({ namespace: 'docker', operation: 'stopContainer' });
  const createContainer = useIpcMutation({ namespace: 'docker', operation: 'createContainer' });

  const start = useCallback(
    async (container: ContainerRow): Promise<void> => {
      try {
        await startContainer.mutateAsync([container.id]);
        notify.success(`Started ${container.name}`);
      } catch (error) {
        notify.error(`Could not start ${container.name}: ${messageOf(error)}`);
        diagnostics.error('failed to start a Docker container', error);
      } finally {
        refresh();
      }
    },
    [refresh, startContainer]
  );

  const stop = useCallback(
    async (container: ContainerRow): Promise<void> => {
      try {
        await stopContainer.mutateAsync([container.id]);
        notify.success(`Stopped ${container.name}`);
      } catch (error) {
        notify.error(`Could not stop ${container.name}: ${messageOf(error)}`);
        diagnostics.error('failed to stop a Docker container', error);
      } finally {
        refresh();
      }
    },
    [refresh, stopContainer]
  );

  const create = useCallback(
    async (options: {
      readonly name: string;
      readonly password: string;
      readonly port: number;
    }): Promise<boolean> => {
      try {
        // `acceptEula: true` because the dialog says so in words the user reads before pressing the
        // button — see `docker-panel.tsx`. `image` is deliberately not passed: main's `createContainer`
        // sets `ACCEPT_EULA` and `MSSQL_SA_PASSWORD` and publishes 1433 whatever image it is given, so a
        // PostgreSQL image would produce a container that cannot start.
        const result = await createContainer.mutateAsync([
          { name: options.name, password: options.password, port: options.port, acceptEula: true },
        ]);
        if (result.success !== true) {
          notify.error(result.error ?? 'Docker refused to create the container');
          return false;
        }
        notify.success(`Created ${options.name}`);
        return true;
      } catch (error) {
        notify.error(`Could not create ${options.name}: ${messageOf(error)}`);
        diagnostics.error('failed to create a Docker container', error);
        return false;
      } finally {
        refresh();
      }
    },
    [createContainer, refresh]
  );

  return {
    start,
    stop,
    create,
    // One id, because one row at a time: both mutations are awaited and the row's controls are disabled
    // while they are. `variables` is the mutation's argument tuple, so `[0]` is the container id.
    busyId: startContainer.isPending
      ? (startContainer.variables?.[0] ?? null)
      : stopContainer.isPending
        ? (stopContainer.variables?.[0] ?? null)
        : null,
    creating: createContainer.isPending,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
