/**
 * The one place a launch can pin what `docker.detect` answers (J-76).
 *
 * ── The problem, and why it is a `packages/` one ────────────────────────────────────────────
 *
 * `DockerDetector` asks the local daemon for every container whose IMAGE looks like a database
 * (`detector.ts`'s `databaseEngineOf`), which is right for a user and fatal for a screenshot: the
 * Docker panel becomes a picture of the host's container inventory. Task 22 captured a baseline of
 * it and found the developer's own `mjpg`, `some-postgres` and `sql-cert-fts` containers in the
 * shot beside the test fixtures — a committed baseline would have been asserting one laptop's
 * `docker ps`, and it would have failed for every other developer for a reason that has nothing to
 * do with Joinery.
 *
 * Masking does not rescue it. Docker's status line ("Up 44 minutes (healthy)") is prose the panel
 * renders verbatim (`docker-model.ts`'s `ContainerRow.status`) and it changes every minute, so it
 * has to be masked in every row — roughly a third of each row — and the row SET stays
 * host-dependent regardless. So the surface was pulled from the visual tier with a note that a
 * portable baseline needs a deterministic source behind `docker.detect`. This is that source.
 *
 * ── What it is, and what it deliberately is not ─────────────────────────────────────────────
 *
 * One environment variable carrying the whole answer as JSON. Read here and nowhere else, applied
 * by `DockerDetector.detect()` and `.listVolumes()` — the two methods every read path funnels
 * through (`docker.ipc.ts` serves `detect`, `get-containers` and `get-volumes` from them, and
 * `use-docker.ts` is the renderer's only consumer), so pinning them pins the panel, the status-bar
 * pip and the welcome tab's summary at once.
 *
 * **Read-only.** `startContainer`, `stopContainer` and `createContainer` are untouched and still
 * talk to the real daemon, so a launch that pins a fixture and then presses Start reaches Docker
 * with an id it does not have and fails loudly. That is the honest outcome for a hatch whose
 * purpose is to make a picture reproducible, and faking a lifecycle would mean maintaining a
 * miniature daemon in the main process.
 *
 * **Not validated field by field.** The shape is checked far enough to fail with a name on it
 * rather than to fail three layers later in the renderer — an object, a `detect` result carrying
 * the two fields the panel branches on, and a `volumes` list if there is one. The containers
 * themselves are not walked, because the only author of a fixture is a test that builds it in
 * TypeScript against `DockerContainer` (`tests/e2e-react-visual/overlays.spec.ts`), where the
 * compiler is a better check than anything this module could repeat at runtime.
 *
 * ── Why an environment variable ─────────────────────────────────────────────────────────────
 *
 * The consumer is a Playwright spec, which drives the app from ANOTHER PROCESS: it can pass argv
 * and environment (`tests/helpers/electron-app.ts`'s `envOverrides`) and nothing else. Constructor
 * injection would be the shape to reach for inside one process and cannot cross this boundary. The
 * precedent is `services/keychain/service-name.ts`, whose `JOINERY_KEYCHAIN_SERVICE` is the same
 * arrangement for the same reason, including its refusal to fall back on a blank value — and,
 * since J-180, including the shared build predicate that shuts both hatches in a shipped release
 * bundle (`utils/runtime-mode.ts`'s `areTestHatchesHonoured`).
 */

import type { DockerDetectionResult, DockerVolume } from '@joinery/shared';

import { createLogger } from '../../utils/logger';
import { areTestHatchesHonoured, type RuntimeSignals } from '../../utils/runtime-mode';

const log = createLogger('DockerFixture');

/**
 * Environment variable that pins Docker's answers for the life of the process.
 *
 * Set by the visual tier only. Nothing sets it in a shipped app, so production reaches the daemon
 * exactly as it always did — which `docker-fixture.spec.ts` pins from both sides.
 */
export const DOCKER_FIXTURE_ENV_VAR = 'JOINERY_DOCKER_FIXTURE';

/** Everything the two read paths need, which is everything the panel renders. */
export interface DockerFixture {
  /** What `detect()` answers verbatim — including `dockerRunning: false` with an error, if asked. */
  readonly detect: DockerDetectionResult;
  /** What `listVolumes()` answers. Absent in the fixture means none. */
  readonly volumes: readonly DockerVolume[];
}

/**
 * The pinned fixture, or `null` when the daemon is the source.
 *
 * @param signals the build asking — `runtimeSignals()` at every production call site. The
 *   environment is a field of it rather than a separate argument so that the gate below and the
 *   value it gates cannot come from different places (J-180).
 * @throws when a build ALLOWED the hatch sets the variable to something unusable — blank, not
 *   JSON, or the wrong shape. Never a fall-back to the daemon: a caller that set this believes the
 *   answer is pinned, and quietly handing it the host's real container inventory is the accident
 *   this module exists to prevent. `detect()` lets the throw out to `safeHandle`, which logs the
 *   channel and rejects, so a malformed fixture is a named failure in the Output panel rather than
 *   a mystery empty panel.
 */
export function resolveDockerFixture(signals: RuntimeSignals): DockerFixture | null {
  const raw = signals.env[DOCKER_FIXTURE_ENV_VAR];
  if (raw === undefined) return null;

  // J-180: a shipped release bundle refuses the hatch, on the same predicate as every other
  // test-only hatch — unpackaged, or a bundle stamped with the J-167 build marker. Refused and
  // warned rather than fatal, matching `service-name.ts`: a user whose shell happens to export
  // this variable must still get a working Docker panel pointed at their own daemon. Checked
  // before the value is parsed, so a malformed value cannot take a release build down either.
  if (!areTestHatchesHonoured(signals)) {
    log.warn(
      `${DOCKER_FIXTURE_ENV_VAR} is set, but this Joinery ignores it and reads the real Docker ` +
        `daemon. It is honoured only by a development build or a bundle built for testing. Unset ` +
        `it to silence this warning.`
    );
    return null;
  }

  if (raw.trim().length === 0) {
    throw new Error(
      `${DOCKER_FIXTURE_ENV_VAR} is set but blank. Unset it to read the real Docker daemon, or ` +
        `give it a JSON object of the shape { detect, volumes? }.`
    );
  }

  const fixture = parseFixture(raw);
  return { detect: detectResultOf(fixture), volumes: volumesOf(fixture) };
}

function parseFixture(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${DOCKER_FIXTURE_ENV_VAR} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${DOCKER_FIXTURE_ENV_VAR} must be a JSON object of the shape { detect, volumes? }; got ` +
        JSON.stringify(parsed)
    );
  }
  return parsed;
}

function detectResultOf(fixture: Record<string, unknown>): DockerDetectionResult {
  const detect = fixture['detect'];
  if (!isRecord(detect)) {
    throw new Error(`${DOCKER_FIXTURE_ENV_VAR} must carry a "detect" object`);
  }
  // The two fields every consumer branches on: `toPip` reads `isRunning` (which `docker.ipc.ts`
  // maps from `dockerRunning`) before anything else, and `toRows` maps the container list.
  if (typeof detect['dockerRunning'] !== 'boolean') {
    throw new Error(`${DOCKER_FIXTURE_ENV_VAR}'s detect.dockerRunning must be a boolean`);
  }
  if (!Array.isArray(detect['containers'])) {
    throw new Error(`${DOCKER_FIXTURE_ENV_VAR}'s detect.containers must be an array`);
  }
  return detect as unknown as DockerDetectionResult;
}

function volumesOf(fixture: Record<string, unknown>): readonly DockerVolume[] {
  const volumes = fixture['volumes'];
  if (volumes === undefined) return [];
  if (!Array.isArray(volumes)) {
    throw new Error(`${DOCKER_FIXTURE_ENV_VAR}'s volumes must be an array`);
  }
  return volumes as DockerVolume[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
