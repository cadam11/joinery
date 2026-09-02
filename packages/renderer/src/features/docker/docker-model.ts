/**
 * What the Docker bridge says, turned into what the pip and the panel show.
 *
 * Pure, and separate from the components, because three of the four things here are judgements the
 * Angular renderer got wrong in three different places and there was nowhere to test any of them.
 *
 * ── The four findings, and what main can and cannot be trusted for ──────────────────────────
 *
 * 1. **`isSqlServer` is meaningless.** `main/src/ipc/docker.ipc.ts:30` sets it to `true` on **every**
 *    container it returns, unconditionally. The filtering already happened in the detector, which keeps
 *    mssql / postgres / mysql / mariadb / postgis images and drops the rest
 *    (`services/docker/detector.ts:57-69`). So the Angular panel's `filter(c => c.isSqlServer)` was a
 *    no-op that only looked correct, and its empty state said "No SQL Server containers found" on a
 *    machine full of PostgreSQL ones. Nothing here reads that flag; the engine is derived from the
 *    IMAGE, which is the same thing the detector decided on.
 * 2. **`ports[0].internal` is always 1433.** The same handler hardcodes it
 *    (`ports: c.port ? [{ internal: 1433, external: c.port }] : []`), so a PostgreSQL container is
 *    reported as listening on 1433 internally. The detector's `port` field IS right — it is the public
 *    binding of whichever default port that engine uses — so `containerPort` reads `port` and the
 *    internal number is derived from the engine rather than believed.
 * 3. **`docker.getVolumes()` used to always return `[]`** (`docker.ipc.ts:36-39`, "could be expanded
 *    later"), which would have made a Volumes list a permanently empty section — a decorative control,
 *    which J-44 forbids. J-70 fixed main: it now answers with the named volumes the database containers
 *    mount, via dockerode's `listVolumes`. The panel renders those AND the volumes each container
 *    actually **binds** (`DockerContainer.volumeMappings`, which the detector fills in from
 *    `container.Mounts`); the Volumes section is still conditional, because a container that only
 *    bind-mounts contributes no named volume.
 * 4. **A failed stop reports success.** `docker.ipc.ts:53-58` awaits `stopContainer` and throws away its
 *    `{ success: false, error }` result, unlike the start handler beside it. So the renderer cannot tell
 *    a stop that failed from one that worked, and must confirm by re-reading the container's state —
 *    which is what `settledState` is for. J-71.
 */

import type { DockerContainer, DockerStatus, DockerVolumeMapping } from '@joinery/shared';

/** The engines a database container can be. `unknown` only for an image the detector let through. */
export type ContainerEngine = 'mssql' | 'postgresql' | 'mysql' | 'unknown';

/** The port each engine listens on inside its container. Finding 2's replacement for a hardcoded 1433. */
const DEFAULT_PORTS: Record<ContainerEngine, number | null> = {
  mssql: 1433,
  postgresql: 5432,
  mysql: 3306,
  unknown: null,
};

const ENGINE_LABELS: Record<ContainerEngine, string> = {
  mssql: 'SQL Server',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  unknown: 'Database',
};

/**
 * Which engine an image is, by the same tests the main-process detector uses to decide a container is a
 * database at all. Restated here rather than imported because the renderer may not import from
 * `packages/main`; `docker-model.spec.ts` pins the image names the detector accepts.
 */
export function engineOf(image: string): ContainerEngine {
  const lower = image.toLowerCase();
  if (lower.includes('mssql') || lower.includes('sqlserver') || lower.includes('azure-sql-edge')) {
    return 'mssql';
  }
  if (lower.includes('postgres') || lower.includes('postgis')) return 'postgresql';
  if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
  return 'unknown';
}

/** One container, as the panel needs it. */
export interface ContainerRow {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly engine: ContainerEngine;
  readonly label: string;
  readonly running: boolean;
  /** Docker's own status line ("Up 3 hours", "Exited (0) 2 days ago"). Shown verbatim. */
  readonly status: string;
  /** The host port the container is published on, or `null` when it publishes none. */
  readonly hostPort: number | null;
  /** The port inside the container, derived from the engine — see finding 2. */
  readonly containerPort: number | null;
  readonly binds: readonly DockerVolumeMapping[];
}

export function toRow(container: DockerContainer): ContainerRow {
  const engine = engineOf(container.image);
  return {
    id: container.id,
    name: container.name,
    image: container.image,
    engine,
    label: ENGINE_LABELS[engine],
    // `state`, not the `status` STRING — `status` is prose ("Up 3 hours") and matching on it is how a
    // locale or a Docker version change silently turns every container grey.
    running: container.state === 'running',
    status: container.status,
    hostPort: container.port ?? container.ports?.[0]?.external ?? null,
    containerPort: DEFAULT_PORTS[engine],
    binds: container.volumeMappings ?? [],
  };
}

/** The rows, newest-looking first: running before stopped, then by name. */
export function toRows(containers: readonly DockerContainer[]): readonly ContainerRow[] {
  return [...containers]
    .map(toRow)
    .sort((left, right) =>
      left.running === right.running ? left.name.localeCompare(right.name) : left.running ? -1 : 1
    );
}

/** What the pip is showing. One closed set, so neither the glyph nor the tooltip can invent a state. */
export type DockerPipState = 'checking' | 'absent' | 'stopped' | 'idle' | 'running';

export interface DockerPip {
  readonly state: DockerPipState;
  /** How many database containers are up. Rendered beside the glyph only when it is above zero. */
  readonly runningCount: number;
  readonly totalCount: number;
  /** The tooltip, which is the only place the whole picture fits in a 28px bar. */
  readonly tooltip: string;
}

/**
 * The pip, from the two things the bridge answers.
 *
 * `status.isAvailable` is `true` whenever `docker.detect` returned at all — main sets it
 * unconditionally, with a comment saying "if we get a response, Docker socket exists" — so
 * `isRunning` is the field that carries the real answer and `absent` is reserved for a REJECTED
 * detect. The Angular status bar branched on `isAvailable` first, which meant "Docker not available"
 * was unreachable and a machine without Docker showed "Docker not running".
 */
export function toPip(input: {
  readonly status: DockerStatus | undefined;
  readonly containers: readonly DockerContainer[] | undefined;
  readonly failed: boolean;
  readonly loading: boolean;
}): DockerPip {
  const { status, containers, failed, loading } = input;

  if (failed) {
    return { state: 'absent', runningCount: 0, totalCount: 0, tooltip: 'Docker is not available' };
  }
  if (loading || status === undefined) {
    return { state: 'checking', runningCount: 0, totalCount: 0, tooltip: 'Checking Docker…' };
  }
  if (status.isRunning !== true) {
    return {
      state: 'stopped',
      runningCount: 0,
      totalCount: 0,
      // The reason main gave, when it gave one — "Docker is not running. Please start Docker Desktop."
      tooltip: status.error ?? 'Docker is not running',
    };
  }

  const rows = toRows(containers ?? []);
  const runningCount = rows.filter(row => row.running).length;
  if (rows.length === 0) {
    return {
      state: 'idle',
      runningCount: 0,
      totalCount: 0,
      tooltip: 'Docker is running — no database containers',
    };
  }
  return {
    state: runningCount > 0 ? 'running' : 'idle',
    runningCount,
    totalCount: rows.length,
    tooltip: `Docker: ${runningCount} of ${rows.length} database containers running`,
  };
}

/**
 * Did the container end up in the state we asked for?
 *
 * Finding 4's guard. `docker.stopContainer` resolves whether or not the container stopped, so "it
 * worked" is only knowable by looking. Returns `null` when the container is no longer in the list at
 * all, which is a legitimate outcome for a container somebody removed underneath us — and NOT a
 * failure to report as one.
 */
export function settledState(
  containers: readonly DockerContainer[] | undefined,
  containerId: string
): boolean | null {
  const found = (containers ?? []).find(container => container.id === containerId);
  return found === undefined ? null : found.state === 'running';
}

/**
 * The password rule for a new SQL Server container, as SQL Server itself enforces it.
 *
 * `main`'s `createContainer` passes the value straight to `MSSQL_SA_PASSWORD`, and SQL Server refuses to
 * start when it does not meet its own policy — the container exits, `docker create` reports success, and
 * the Angular panel showed "Container created and started" for a container that was already dead. So the
 * rule is checked here, with the reason, before the round trip.
 *
 * The policy: at least 8 characters, and three of the four categories (upper, lower, digit, symbol).
 */
export function validateContainerPassword(password: string): string | null {
  if (password.length < 8) {
    return 'SQL Server needs at least 8 characters, or the container starts and immediately exits.';
  }
  const categories = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern =>
    pattern.test(password)
  ).length;
  if (categories < 3) {
    return 'SQL Server needs three of: an upper-case letter, a lower-case letter, a digit, a symbol.';
  }
  return null;
}

/** A container name Docker will accept: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. */
export function validateContainerName(name: string, taken: readonly string[]): string | null {
  if (name.trim() === '') return 'Give the container a name.';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    return 'Letters, numbers, dots, dashes and underscores, starting with a letter or number.';
  }
  if (taken.includes(name)) return `There is already a container called ${name}.`;
  return null;
}

/** A host port that can actually be published. */
export function validateContainerPort(
  port: number,
  taken: readonly (number | null)[]
): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    return 'Pick a port between 1 and 65535.';
  if (port < 1_024) return 'Ports below 1024 need elevated privileges — pick a higher one.';
  if (taken.includes(port)) return `Another container is already published on port ${port}.`;
  return null;
}
