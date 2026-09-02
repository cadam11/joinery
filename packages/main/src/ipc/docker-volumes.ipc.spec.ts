/**
 * The `docker:get-volumes` channel (J-70).
 *
 * The handler used to answer `[]` unconditionally ("could be expanded later"), so the panel's
 * Volumes section — rendered only when the list is non-empty — could never be drawn. This spec
 * pins the answer at the channel boundary, which is where the renderer actually asks.
 *
 * ── Why the fixtures are typed against the real dockerode ──────────────────────────────────
 *
 * `dockerode` is replaced at runtime, but the fixtures below are typed `Dockerode.ContainerInfo`
 * and `Dockerode.VolumeInspectInfo` through an `import type` that the mock cannot touch. So the
 * double is checked against the shipped `@types/dockerode` at compile time: if the daemon's
 * reply shape drifts, `pnpm run typecheck` fails rather than this spec passing on a fiction.
 *
 * Harness: electron is replaced with the one member this file touches, following
 * `app.ipc.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@joinery/shared';
import type Dockerode from 'dockerode';

import { registerDockerHandlers } from './docker.ipc';
import { DockerDetector } from '../services/docker/detector';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  containers: [] as unknown[],
  volumes: [] as unknown[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
}));

vi.mock('dockerode', () => ({
  default: class FakeDockerode {
    async ping(): Promise<undefined> {
      return undefined;
    }
    async listContainers(): Promise<unknown[]> {
      return harness.containers;
    }
    async listVolumes(): Promise<{ Volumes: unknown[]; Warnings: string[] }> {
      return { Volumes: harness.volumes, Warnings: [] };
    }
  },
}));

/** A `docker ps` row, with only the fields the detector reads filled in meaningfully. */
function containerInfo(
  image: string,
  mounts: Dockerode.ContainerInfo['Mounts'],
  ports: Dockerode.Port[] = []
): Dockerode.ContainerInfo {
  return {
    Id: `id-${image}`,
    Names: [`/${image.replace(/[^a-z0-9]/gi, '-')}`],
    Image: image,
    ImageID: `sha256:${image}`,
    Command: 'run',
    Created: 1_700_000_000,
    Ports: ports,
    Labels: {},
    State: 'running',
    Status: 'Up 3 hours',
    HostConfig: { NetworkMode: 'bridge' },
    NetworkSettings: { Networks: {} },
    Mounts: mounts,
  };
}

/** A `docker volume ls` row. `Options` is typed nullable and is null in practice for defaults. */
function volumeInfo(name: string): Dockerode.VolumeInspectInfo {
  return {
    Name: name,
    Driver: 'local',
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Labels: {},
    Scope: 'local',
    Options: null,
  };
}

const namedMount = (
  name: string,
  destination: string
): Dockerode.ContainerInfo['Mounts'][number] => ({
  Name: name,
  Type: 'volume',
  Source: `/var/lib/docker/volumes/${name}/_data`,
  Destination: destination,
  Driver: 'local',
  Mode: 'z',
  RW: true,
  Propagation: '',
});

const bindMount = (
  source: string,
  destination: string
): Dockerode.ContainerInfo['Mounts'][number] => ({
  Type: 'bind',
  Source: source,
  Destination: destination,
  Mode: 'rw',
  RW: true,
  Propagation: 'rprivate',
});

const published = (privatePort: number, publicPort: number): Dockerode.Port => ({
  IP: '0.0.0.0',
  PrivatePort: privatePort,
  PublicPort: publicPort,
  Type: 'tcp',
});

async function getVolumes(): Promise<unknown> {
  const handler = harness.handlers.get(IPC_CHANNELS.DOCKER.GET_VOLUMES);
  expect(handler, 'docker:get-volumes must be registered').toBeDefined();
  return handler?.({} as Electron.IpcMainInvokeEvent);
}

describe('docker:get-volumes', () => {
  beforeEach(() => {
    harness.handlers.clear();
    harness.containers = [];
    harness.volumes = [];
    DockerDetector.resetInstance();
    registerDockerHandlers();
  });

  it('lists the named volumes a database container mounts', async () => {
    harness.containers = [
      containerInfo('postgres:16', [
        namedMount('joinery_pgdata', '/var/lib/postgresql/data'),
        bindMount('/tmp/dumps', '/backups'),
      ]),
    ];
    harness.volumes = [volumeInfo('joinery_pgdata')];

    await expect(getVolumes()).resolves.toEqual([
      {
        name: 'joinery_pgdata',
        driver: 'local',
        mountpoint: '/var/lib/docker/volumes/joinery_pgdata/_data',
      },
    ]);
  });

  it('leaves out volumes no database container mounts', async () => {
    harness.containers = [
      containerInfo('mysql:8', [namedMount('joinery_mysqldata', '/var/lib/mysql')]),
      // Not a database image, so its volume is none of the panel's business.
      containerInfo('nginx:1.27', [namedMount('website', '/usr/share/nginx/html')]),
    ];
    harness.volumes = [
      volumeInfo('joinery_mysqldata'),
      volumeInfo('website'),
      // Dangling: mounted by nothing at all. A dev box carries dozens of these.
      volumeInfo('orphan_cache'),
    ];

    const listed = (await getVolumes()) as Array<{ name: string }>;
    expect(listed.map(v => v.name)).toEqual(['joinery_mysqldata']);
  });

  it('answers with an empty list when the database containers only bind-mount', async () => {
    harness.containers = [containerInfo('postgres:16', [bindMount('/tmp/dumps', '/backups')])];
    harness.volumes = [volumeInfo('orphan_cache')];

    await expect(getVolumes()).resolves.toEqual([]);
  });
});

/**
 * `detect()`'s image test moved into the `databaseEngineOf` helper `listVolumes()` shares, so the
 * engine each image resolves to — and the port it therefore looks for — is pinned here. Nothing
 * else covered it main-side.
 */
describe('docker:detect — the engine an image resolves to', () => {
  beforeEach(() => {
    harness.handlers.clear();
    harness.volumes = [];
    harness.containers = [
      containerInfo('postgres:16-alpine', [], [published(5432, 55432)]),
      containerInfo('mcr.microsoft.com/mssql/server:2022-latest', [], [published(1433, 51433)]),
      containerInfo('mariadb:11', [], [published(3306, 53306)]),
      containerInfo('nginx:1.27', [], [published(80, 8080)]),
    ];
    DockerDetector.resetInstance();
    registerDockerHandlers();
  });

  it('keeps a container per engine, on that engine’s own port, and drops the rest', async () => {
    const handler = harness.handlers.get(IPC_CHANNELS.DOCKER.DETECT);
    const status = (await handler?.({} as Electron.IpcMainInvokeEvent)) as {
      isRunning: boolean;
      containers: Array<{ image: string; port: number | null }>;
    };

    expect(status.isRunning).toBe(true);
    expect(status.containers.map(c => [c.image, c.port])).toEqual([
      ['postgres:16-alpine', 55432],
      ['mcr.microsoft.com/mssql/server:2022-latest', 51433],
      ['mariadb:11', 53306],
    ]);
  });
});
