/**
 * The Docker lifecycle channels (J-71).
 *
 * `docker:stop-container` used to `await dockerDetector.stopContainer(id)` and drop the
 * `{ success: false, error }` it answers with, so a stop Docker refused resolved exactly like one
 * that worked and the renderer had to re-read the container list to find out. This spec pins the
 * two lifecycle handlers to the same contract: reject with Docker's own message on failure.
 *
 * Harness: electron is replaced with the one member these handlers touch — `ipcMain.handle`,
 * captured so a handler can be invoked directly — following `credentials.ipc.spec.ts`. The
 * detector is the REAL `DockerDetector` with only `startContainer` / `stopContainer` stubbed, and
 * the stubs return the exact shapes `detector.ts` returns (`{ success, containerId }` on the happy
 * path, `{ success: false, containerId, error }` in its catch) so the double cannot drift from the
 * source it stands in for. Its constructor only builds a `Dockerode` object, which opens nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@joinery/shared';
import type { StartContainerResult } from '@joinery/shared';

import { DockerDetector } from '../services/docker/detector';
import { registerDockerHandlers } from './docker.ipc';

/** `vi.hoisted` because the `vi.mock` factory below runs before this module's own body. */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    },
  },
}));

/** Calls the registered invoke handler the way `ipcRenderer.invoke` would. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  expect(handler, `${channel} was never registered`).toBeDefined();
  return handler?.({}, ...args);
}

let detector: DockerDetector;

beforeEach(() => {
  electron.handlers.clear();
  DockerDetector.resetInstance();
  registerDockerHandlers();
  detector = DockerDetector.getInstance();
});

afterEach(() => {
  vi.restoreAllMocks();
  DockerDetector.resetInstance();
});

/** The detector's own failure shape — `detector.ts:161-167`. */
const refused = (containerId: string, error: string): StartContainerResult => ({
  success: false,
  containerId,
  error,
});

/** The detector's own success shape — `detector.ts:156-159`. */
const worked = (containerId: string): StartContainerResult => ({ success: true, containerId });

describe('docker:stop-container', () => {
  it('rejects with Docker’s own message when the detector refused the stop', async () => {
    const stop = vi
      .spyOn(detector, 'stopContainer')
      .mockResolvedValue(refused('c1', '(HTTP code 500) server error - cannot stop container'));

    await expect(invoke(IPC_CHANNELS.DOCKER.STOP_CONTAINER, 'c1')).rejects.toThrow(
      'cannot stop container'
    );
    expect(stop).toHaveBeenCalledWith('c1');
  });

  it('falls back to a stated reason when the detector gave no message', async () => {
    vi.spyOn(detector, 'stopContainer').mockResolvedValue({ success: false, containerId: 'c1' });

    await expect(invoke(IPC_CHANNELS.DOCKER.STOP_CONTAINER, 'c1')).rejects.toThrow(
      'Failed to stop container'
    );
  });

  it('resolves with nothing when the container stopped', async () => {
    vi.spyOn(detector, 'stopContainer').mockResolvedValue(worked('c1'));

    await expect(invoke(IPC_CHANNELS.DOCKER.STOP_CONTAINER, 'c1')).resolves.toBeUndefined();
  });
});

describe('docker:start-container', () => {
  it('rejects with Docker’s own message when the detector refused the start', async () => {
    vi.spyOn(detector, 'startContainer').mockResolvedValue(
      refused('c1', 'port is already allocated')
    );

    await expect(invoke(IPC_CHANNELS.DOCKER.START_CONTAINER, 'c1')).rejects.toThrow(
      'port is already allocated'
    );
  });

  it('resolves with nothing when the container started', async () => {
    vi.spyOn(detector, 'startContainer').mockResolvedValue(worked('c1'));

    await expect(invoke(IPC_CHANNELS.DOCKER.START_CONTAINER, 'c1')).resolves.toBeUndefined();
  });
});
