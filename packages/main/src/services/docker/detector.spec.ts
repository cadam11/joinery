/**
 * `DockerDetector.stopContainer`'s answer, which J-71 made load-bearing: the
 * `docker:stop-container` handler now throws whatever `success: false` it gets, so anything this
 * method calls a failure reaches the user as a toast.
 *
 * Harness: `dockerode` is replaced with a class exposing the one member this method touches —
 * `getContainer(id).stop()`. The rejection it throws is the daemon's own, captured from a live
 * Docker 29.3.1 against a container that was already stopped:
 * `{ name: 'Error', message: '(HTTP code 304) container already stopped -  ', statusCode: 304,
 *   reason: 'container already stopped', json: … }`. So the double cannot encode a nicer error
 * than the real one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dockerode = vi.hoisted(() => ({
  stop: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('dockerode', () => ({
  default: class FakeDockerode {
    getContainer(id: string) {
      return { id, stop: dockerode.stop };
    }
  },
}));

// Static import, safe because vitest hoists the `vi.mock` above it.
import { DockerDetector } from './detector';

/** The daemon's 304, as dockerode surfaces it. */
function alreadyStopped(): Error {
  return Object.assign(new Error('(HTTP code 304) container already stopped -  '), {
    statusCode: 304,
    reason: 'container already stopped',
  });
}

let detector: DockerDetector;

beforeEach(() => {
  dockerode.stop.mockReset();
  DockerDetector.resetInstance();
  detector = DockerDetector.getInstance();
});

afterEach(() => {
  DockerDetector.resetInstance();
});

describe('DockerDetector.stopContainer', () => {
  it('reports success when the container was already stopped', async () => {
    // Docker's 304. The caller asked for "not running" and that is the state it is in, so calling
    // this a failure would put "(HTTP code 304) container already stopped" in a toast — which is
    // what would happen the moment the 30-second poll is behind the daemon.
    dockerode.stop.mockRejectedValue(alreadyStopped());

    await expect(detector.stopContainer('c1')).resolves.toEqual({
      success: true,
      containerId: 'c1',
    });
  });

  it('reports Docker’s own message when the stop really failed', async () => {
    dockerode.stop.mockRejectedValue(
      Object.assign(new Error('(HTTP code 404) no such container - No such container: c1 '), {
        statusCode: 404,
        reason: 'no such container',
      })
    );

    await expect(detector.stopContainer('c1')).resolves.toEqual({
      success: false,
      containerId: 'c1',
      error: '(HTTP code 404) no such container - No such container: c1 ',
    });
  });

  it('reports success when the stop worked', async () => {
    dockerode.stop.mockResolvedValue(undefined);

    await expect(detector.stopContainer('c1')).resolves.toEqual({
      success: true,
      containerId: 'c1',
    });
  });
});
