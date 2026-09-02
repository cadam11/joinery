/**
 * The Docker fixture hatch (J-76): what `docker.detect` answers when a launch pins it.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────────────────────
 *
 * `DockerDetector` asks the local daemon for every container whose IMAGE looks like a database,
 * which makes the Docker panel a picture of the host's container inventory rather than of Joinery.
 * Task 22 captured a baseline of it, found the developer's own `mjpg` / `some-postgres` /
 * `sql-cert-fts` containers in the shot beside the test fixtures, and pulled the surface — and
 * masking does not rescue it, because Docker's status line ("Up 44 minutes (healthy)") is prose the
 * panel renders verbatim and it changes every minute.
 *
 * So a launch can pin the answer. This spec covers the two halves separately:
 *
 *  1. the resolver, which is pure — an environment in, a fixture or `null` or a throw out;
 *  2. the detector honouring it, which is the load-bearing claim.
 *
 * ── The double, and why a pass proves something ────────────────────────────────────────────
 *
 * `dockerode` is replaced by a class whose every method REJECTS. It is not standing in for the
 * daemon's replies — nothing here needs one — it stands in for "the daemon was consulted", and it
 * is verified against the real module by construction: the four methods below are exactly the ones
 * `detector.ts` calls on the paths under test (`ping`, `listContainers`, `listVolumes`,
 * `getContainer`), and a strictly-worse-than-real double cannot encode the bug under test. If a
 * fixture-pinned `detect()` ever reached dockerode again, these tests reject rather than passing on
 * whatever the developer's machine happened to be running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerDetectionResult, DockerVolume } from '@joinery/shared';

import { DOCKER_FIXTURE_ENV_VAR, resolveDockerFixture, type DockerFixture } from './docker-fixture';
import type { RuntimeSignals } from '../../utils/runtime-mode';
import { DockerDetector } from './detector';

vi.mock('dockerode', () => ({
  default: class UnreachableDockerode {
    async ping(): Promise<never> {
      throw new Error('the daemon was consulted');
    }
    async listContainers(): Promise<never> {
      throw new Error('the daemon was consulted');
    }
    async listVolumes(): Promise<never> {
      throw new Error('the daemon was consulted');
    }
    getContainer(): never {
      throw new Error('the daemon was consulted');
    }
  },
}));

const CONTAINER = {
  id: 'fixture-pg',
  name: 'joinery-fixture-postgres',
  image: 'postgres:16-alpine',
  state: 'running',
  status: 'Up 2 hours',
  port: 15432,
  hostBinding: '0.0.0.0',
  volumeMappings: [],
  created: '2026-01-01T00:00:00.000Z',
} as const satisfies DockerDetectionResult['containers'][number];

const VOLUME: DockerVolume = {
  name: 'joinery_fixture_pgdata',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/joinery_fixture_pgdata/_data',
};

const FIXTURE: DockerFixture = {
  detect: { dockerRunning: true, containers: [CONTAINER] },
  volumes: [VOLUME],
};

/**
 * An unpackaged launch — a developer, or a Playwright/visual tier — with the hatch set to `value`.
 *
 * Unpackaged because that is the build the hatch exists for; the packaged cases live in
 * `utils/env-hatch-gating.spec.ts`, which drives every hatch through all four combinations of
 * `isPackaged` x `isTestBuild` against the one shared predicate (J-180).
 */
function launch(value?: string): RuntimeSignals {
  return {
    isPackaged: false,
    isTestBuild: false,
    env: value === undefined ? {} : { [DOCKER_FIXTURE_ENV_VAR]: value },
  };
}

describe('resolveDockerFixture', () => {
  it('answers null when nothing pinned it — the daemon is the source', () => {
    expect(resolveDockerFixture(launch())).toBeNull();
  });

  it('parses a pinned fixture', () => {
    expect(resolveDockerFixture(launch(JSON.stringify(FIXTURE)))).toEqual(FIXTURE);
  });

  it('defaults the volumes to none, so a fixture may omit them', () => {
    const pinned = resolveDockerFixture(launch(JSON.stringify({ detect: FIXTURE.detect })));
    expect(pinned?.volumes).toEqual([]);
  });

  // Deliberately not a fall-back to the daemon, for the reason `service-name.ts` gives about the
  // keychain override: a caller that set the variable believes the answer is pinned, and quietly
  // handing it the host's real container inventory is the accident this module exists to prevent.
  it('refuses a blank value rather than falling back to the daemon', () => {
    expect(() => resolveDockerFixture(launch('   '))).toThrow(DOCKER_FIXTURE_ENV_VAR);
  });

  it('refuses a value that is not JSON, naming the variable', () => {
    expect(() => resolveDockerFixture(launch('{ not json'))).toThrow(DOCKER_FIXTURE_ENV_VAR);
  });

  it.each([
    ['a JSON scalar', '"postgres"'],
    ['no detect result', '{}'],
    ['a detect result that is not an object', '{"detect":7}'],
    ['no dockerRunning flag', '{"detect":{"containers":[]}}'],
    ['containers that are not a list', '{"detect":{"dockerRunning":true,"containers":{}}}'],
    [
      'volumes that are not a list',
      '{"detect":{"dockerRunning":true,"containers":[]},"volumes":"none"}',
    ],
  ])('refuses %s', (_case, raw) => {
    expect(() => resolveDockerFixture(launch(raw))).toThrow(DOCKER_FIXTURE_ENV_VAR);
  });
});

describe('DockerDetector with a pinned fixture', () => {
  beforeEach(() => {
    DockerDetector.resetInstance();
    process.env[DOCKER_FIXTURE_ENV_VAR] = JSON.stringify(FIXTURE);
  });

  afterEach(() => {
    delete process.env[DOCKER_FIXTURE_ENV_VAR];
    DockerDetector.resetInstance();
  });

  it('answers detect() from the fixture without consulting the daemon', async () => {
    await expect(DockerDetector.getInstance().detect()).resolves.toEqual(FIXTURE.detect);
  });

  it('answers listVolumes() from the fixture without consulting the daemon', async () => {
    await expect(DockerDetector.getInstance().listVolumes()).resolves.toEqual([VOLUME]);
  });

  it('reports Docker down when that is what the fixture says', async () => {
    process.env[DOCKER_FIXTURE_ENV_VAR] = JSON.stringify({
      detect: { dockerRunning: false, containers: [], error: 'Docker is not running.' },
    });
    await expect(DockerDetector.getInstance().detect()).resolves.toEqual({
      dockerRunning: false,
      containers: [],
      error: 'Docker is not running.',
    });
  });

  // The hatch is READ-ONLY: nothing pretends to start or stop a container. A fixture launch that
  // pressed Start would reach the real daemon with an id it does not have, which fails loudly —
  // and that is the honest outcome, so it is pinned rather than left to be discovered.
  it('leaves the lifecycle calls pointed at the real daemon', async () => {
    await expect(DockerDetector.getInstance().startContainer(CONTAINER.id)).resolves.toMatchObject({
      success: false,
    });
  });
});

describe('DockerDetector with no fixture', () => {
  beforeEach(() => {
    DockerDetector.resetInstance();
    delete process.env[DOCKER_FIXTURE_ENV_VAR];
  });

  afterEach(() => {
    DockerDetector.resetInstance();
  });

  // The other half of the hatch: unpinned, the detector talks to the daemon exactly as it always
  // did. With the daemon replaced by the rejecting double, that is observable as the error result
  // `detect()`'s own catch produces.
  it('goes to the daemon, which is what the shipped app does', async () => {
    const result = await DockerDetector.getInstance().detect();
    expect(result.dockerRunning).toBe(false);
    expect(result.error).toMatch(/Docker is not running/);
  });
});
