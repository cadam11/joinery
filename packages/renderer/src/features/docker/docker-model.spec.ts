/**
 * The main-process findings, as tests. Each one is a claim about what the bridge does that would
 * otherwise live only in a comment. Finding 4 (a failed stop reporting success) moved to
 * `main/src/ipc/docker.ipc.spec.ts` when J-71 fixed the handler: the renderer no longer confirms a
 * stop by looking, so there is nothing pure left here to test.
 */

import { describe, expect, it } from 'vitest';
import type { DockerContainer, DockerStatus } from '@joinery/shared';

import {
  engineOf,
  toPip,
  toRow,
  toRows,
  validateContainerName,
  validateContainerPassword,
  validateContainerPort,
} from './docker-model';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer => ({
  id: 'c1',
  name: 'joinery-test-postgres',
  image: 'postgres:16-alpine',
  state: 'running',
  status: 'Up 3 hours',
  ...overrides,
});

describe('engineOf', () => {
  it('recognises every image family the main-process detector accepts', () => {
    // The detector's own list (`services/docker/detector.ts:57-65`), restated because the renderer may
    // not import from packages/main. A family it accepts and this does not would render as "Database".
    expect(engineOf('mcr.microsoft.com/mssql/server:2022-latest')).toBe('mssql');
    expect(engineOf('mcr.microsoft.com/azure-sql-edge')).toBe('mssql');
    expect(engineOf('SomeRegistry/SqlServer:latest')).toBe('mssql');
    expect(engineOf('postgres:16')).toBe('postgresql');
    expect(engineOf('bitnami/postgresql:15')).toBe('postgresql');
    expect(engineOf('postgis/postgis')).toBe('postgresql');
    expect(engineOf('mysql:8')).toBe('mysql');
    expect(engineOf('mariadb:11')).toBe('mysql');
  });

  it('says unknown rather than guessing', () => {
    expect(engineOf('redis:7')).toBe('unknown');
  });
});

describe('toRow — findings 1 and 2', () => {
  it('ignores isSqlServer entirely, because main sets it to true for everything', () => {
    // `docker.ipc.ts:30` — `isSqlServer: true` unconditionally. The Angular panel's
    // `filter(c => c.isSqlServer)` was therefore a no-op that looked like a filter.
    const asMainSendsIt = toRow(container({ image: 'postgres:16', isSqlServer: true }));
    expect(asMainSendsIt.engine).toBe('postgresql');
    expect(asMainSendsIt.label).toBe('PostgreSQL');
  });

  it('derives the container port from the engine, not from the hardcoded 1433 main sends', () => {
    // `docker.ipc.ts:31` — `ports: c.port ? [{ internal: 1433, external: c.port }] : []`, for every
    // engine. Believing that reports a PostgreSQL container as listening on 1433 internally.
    const pg = toRow(
      container({ image: 'postgres:16', port: 55432, ports: [{ internal: 1433, external: 55432 }] })
    );
    expect(pg.hostPort).toBe(55432);
    expect(pg.containerPort).toBe(5432);

    const mysql = toRow(container({ image: 'mysql:8', port: 33061 }));
    expect(mysql.containerPort).toBe(3306);

    const mssql = toRow(container({ image: 'mssql/server', port: 14330 }));
    expect(mssql.containerPort).toBe(1433);
  });

  it('reports no published port rather than inventing one', () => {
    const row = toRow(container({ port: null, ports: [] }));
    expect(row.hostPort).toBeNull();
  });

  it('reads running from `state`, not from the prose in `status`', () => {
    // `status` is "Up 3 hours" / "Exited (0) 2 days ago" — matching on it makes the panel wrong the day
    // Docker rewords it.
    expect(toRow(container({ state: 'exited', status: 'Up 3 hours' })).running).toBe(false);
    expect(toRow(container({ state: 'running', status: 'anything at all' })).running).toBe(true);
  });

  it('carries the bind mounts, which are the volume data that actually exists', () => {
    const row = toRow(
      container({
        volumeMappings: [{ hostPath: '/Users/me/dumps', containerPath: '/backups', mode: 'ro' }],
      })
    );
    expect(row.binds).toEqual([
      { hostPath: '/Users/me/dumps', containerPath: '/backups', mode: 'ro' },
    ]);
  });
});

describe('toRows', () => {
  it('puts running containers first, then sorts by name', () => {
    const rows = toRows([
      container({ id: '1', name: 'zeta', state: 'exited' }),
      container({ id: '2', name: 'beta', state: 'running' }),
      container({ id: '3', name: 'alpha', state: 'exited' }),
      container({ id: '4', name: 'aleph', state: 'running' }),
    ]);
    expect(rows.map(row => row.name)).toEqual(['aleph', 'beta', 'alpha', 'zeta']);
  });
});

describe('toPip', () => {
  it('is checking while the first detect is in flight', () => {
    const pip = toPip({ status: undefined, containers: undefined, failed: false, loading: true });
    expect(pip.state).toBe('checking');
    expect(pip.tooltip).toBe('Checking Docker…');
  });

  it('says ABSENT only when detect rejected', () => {
    // The Angular bar branched on `isAvailable` first, and main sets that to `true` for every answer it
    // gives ("if we get a response, Docker socket exists"), so its "Docker not available" branch was
    // unreachable and a machine with no Docker read "Docker not running".
    const pip = toPip({ status: undefined, containers: undefined, failed: true, loading: false });
    expect(pip.state).toBe('absent');
    expect(pip.tooltip).toBe('Docker is not available');
  });

  it('carries main’s own reason when the daemon is down', () => {
    const status: DockerStatus = {
      isAvailable: true,
      isRunning: false,
      error: 'Docker is not running. Please start Docker Desktop.',
    };
    const pip = toPip({ status, containers: [], failed: false, loading: false });
    expect(pip.state).toBe('stopped');
    expect(pip.tooltip).toBe('Docker is not running. Please start Docker Desktop.');
  });

  it('is idle with no containers, and running with at least one up', () => {
    const status: DockerStatus = { isAvailable: true, isRunning: true };
    expect(toPip({ status, containers: [], failed: false, loading: false })).toMatchObject({
      state: 'idle',
      runningCount: 0,
      tooltip: 'Docker is running — no database containers',
    });

    const pip = toPip({
      status,
      containers: [container({ id: '1' }), container({ id: '2', state: 'exited' })],
      failed: false,
      loading: false,
    });
    expect(pip).toMatchObject({ state: 'running', runningCount: 1, totalCount: 2 });
    expect(pip.tooltip).toBe('Docker: 1 of 2 database containers running');
  });

  it('is idle, not running, when containers exist but none is up', () => {
    const pip = toPip({
      status: { isAvailable: true, isRunning: true },
      containers: [container({ state: 'exited' })],
      failed: false,
      loading: false,
    });
    expect(pip.state).toBe('idle');
    expect(pip.runningCount).toBe(0);
  });
});

describe('the create form’s three rules', () => {
  it('applies SQL Server’s own password policy before the round trip', () => {
    // `docker create` succeeds and SQL Server then exits on a password it rejects, so the Angular panel
    // said "created and started" about a container that was already dead.
    expect(validateContainerPassword('short1!')).toContain('at least 8');
    expect(validateContainerPassword('alllowercase')).toContain('three of');
    expect(validateContainerPassword('lowerUPPER1')).toBeNull();
    expect(validateContainerPassword('Strong!Pass123')).toBeNull();
  });

  it('applies Docker’s name rule and refuses a collision by name', () => {
    expect(validateContainerName('', [])).toContain('Give the container a name');
    expect(validateContainerName('-leading-dash', [])).toContain('starting with a letter');
    expect(validateContainerName('has spaces', [])).toContain('starting with a letter');
    expect(validateContainerName('joinery.mssql-1_a', [])).toBeNull();
    expect(validateContainerName('taken', ['taken'])).toBe(
      'There is already a container called taken.'
    );
  });

  it('refuses a port that cannot be published, and one already in use', () => {
    expect(validateContainerPort(0, [])).toContain('between 1 and 65535');
    expect(validateContainerPort(70_000, [])).toContain('between 1 and 65535');
    expect(validateContainerPort(80, [])).toContain('elevated privileges');
    expect(validateContainerPort(1433, [1433])).toContain('already published on port 1433');
    // A container with no published port contributes `null`, which must not collide with anything.
    expect(validateContainerPort(1433, [null])).toBeNull();
  });
});
