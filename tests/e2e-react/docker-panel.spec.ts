/**
 * The Docker panel against the real daemon.
 *
 * ── THE CONSTRAINT, stated where anyone editing this file will read it ──────────────────────
 *
 * **Nothing in this file may stop, start, restart or remove a `joinery-test-*` container.** The whole
 * integration/e2e tier depends on those five containers being up: `ensureJoineryTestSeeded`, every
 * connection spec, the backup and restore specs and the query specs all connect to them. Stopping one
 * mid-run does not fail one test, it fails the suite — and Craig starts Docker Desktop by hand, so a
 * killed container is a manual recovery.
 *
 * So the harness containers get **read-only assertions only**: the panel lists them, names their engine,
 * reports their published port and their state. Nothing here clicks their Stop button.
 *
 * The lifecycle half is covered by a **throwaway container of this spec's own**, created outside Joinery
 * from the `postgres:16-alpine` image the harness has already pulled (so there is no download), with
 * `sleep` as its command (so starting it is instant, it stays up, and it needs no environment) and **no
 * published port** (so it cannot collide with anything). The spec starts it and stops it through the
 * panel, which is the real lifecycle path, and removes it afterwards whatever happens.
 *
 * Create is NOT covered here: `docker.createContainer` hardcodes SQL Server's image, and pulling
 * `mcr.microsoft.com/mssql/server:2022-latest` inside a test is a multi-gigabyte download. The create
 * form's rules and its bridge call are asserted in `features/docker/docker-panel.spec.tsx` against the
 * bridge double, and the reason is recorded here rather than left implicit.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import {
  closeDockerPanel,
  dockerContainerNames,
  dockerContainerRow,
  dockerPanel,
  dockerPip,
  ensureJoineryTestSeeded,
  openDockerPanel,
  openPalette,
  runPaletteCommand,
  withJoineryReact,
} from '../helpers/joinery-actions-react';

const run = promisify(execFile);

/** The harness containers this spec reads and must never touch. */
const HARNESS_POSTGRES = 'joinery-test-postgres';
const HARNESS_MYSQL = 'joinery-test-mysql';

/** This spec's own container. The name is deliberately NOT `joinery-test-*`. */
const THROWAWAY = 'joinery-e2e-throwaway-pg';
/** Already on the machine — the harness runs it — so `docker create` pulls nothing. */
const THROWAWAY_IMAGE = 'postgres:16-alpine';

test.beforeAll(ensureJoineryTestSeeded);

async function removeThrowaway(): Promise<void> {
  // `-f` so a running one goes too; the failure when it does not exist is expected and ignored, which is
  // the one place in this file swallowing an error is right: this is idempotent cleanup.
  await run('docker', ['rm', '-f', THROWAWAY]).catch(() => undefined);
}

async function createThrowaway(): Promise<void> {
  await removeThrowaway();
  // Created, not run: it starts stopped, which is the state the panel's Start button needs. `sleep` as
  // the command because the real postgres entrypoint exits without a password, and a container that
  // exits immediately cannot be asserted as running.
  await run('docker', ['create', '--name', THROWAWAY, THROWAWAY_IMAGE, 'sleep', '600']);
}

async function containerState(name: string): Promise<string> {
  const { stdout } = await run('docker', ['inspect', '--format', '{{.State.Status}}', name]);
  return stdout.trim();
}

test.describe('Joinery (React) — the Docker panel', () => {
  test('the pip reports the running containers, and the panel lists the real ones', async () => {
    await withJoineryReact(async ({ window }) => {
      // Docker is up for this tier by definition — the harness containers are how the other specs
      // connect — so the pip must settle on `running`, not on `stopped` or `absent`.
      await expect(dockerPip(window)).toHaveAttribute('data-docker-state', 'running', {
        timeout: 30_000,
      });
      const count = Number((await window.getByTestId('status-docker-count').textContent()) ?? '0');
      expect(count).toBeGreaterThan(0);

      const panel = await openDockerPanel(window);
      const names = await dockerContainerNames(window);
      // Read-only: the harness containers are listed and nothing is done to them.
      expect(names).toContain(HARNESS_POSTGRES);
      expect(names).toContain(HARNESS_MYSQL);

      const pg = dockerContainerRow(window, HARNESS_POSTGRES);
      await expect(pg).toHaveAttribute('data-running', 'true');
      // The engine comes from the image, and the internal port from the engine — main claims 1433 for
      // every container it returns, which is what the Angular panel would have shown here.
      await expect(pg).toContainText('PostgreSQL');
      await expect(pg).toContainText(':15432 → 5432');
      await expect(pg).not.toContainText('1433');

      const mysql = dockerContainerRow(window, HARNESS_MYSQL);
      await expect(mysql).toContainText('MySQL');
      await expect(mysql).toContainText(':13306 → 3306');

      // The empty state is not showing, and the panel does not claim these are SQL Server containers.
      await expect(panel.getByTestId('docker-empty')).toBeHidden();
      await expect(panel).not.toContainText('No SQL Server containers');

      // Escape closes it from inside, which is the keyboard path. It has to be from INSIDE, and
      // `docker-refresh` in particular: that button carries a tooltip, a Radix tooltip's content is a
      // dismissable layer of its own, and the layer stack is what used to swallow the key. J-72 moved
      // the handling into `ui/popover.tsx` — its header has the root cause, and
      // `ui/navigation.spec.tsx` plus `features/docker/docker-panel.spec.tsx` assert it without Docker.
      await panel.getByTestId('docker-refresh').focus();
      await window.keyboard.press('Escape');
      await expect(dockerPanel(window)).toBeHidden({ timeout: 10_000 });
    });
  });

  test('opens from the palette as well as from the pip', async () => {
    await withJoineryReact(async ({ window }) => {
      // The Angular panel was reachable only by clicking the pip, so a user who did not know the glyph
      // was a button never found it.
      await expect(dockerPip(window)).not.toHaveAttribute('data-docker-state', 'checking', {
        timeout: 30_000,
      });
      await openPalette(window);
      await runPaletteCommand(window, 'command:open-docker-panel');
      await expect(dockerPanel(window)).toBeVisible({ timeout: 10_000 });
      await closeDockerPanel(window);
    });
  });

  test('starts and stops a container of its own — never a harness one', async () => {
    await createThrowaway();
    try {
      await withJoineryReact(async ({ window }) => {
        await openDockerPanel(window);

        const row = dockerContainerRow(window, THROWAWAY);
        // The panel found it because its IMAGE looks like a database, not because of a flag main sets
        // to `true` for everything.
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row).toHaveAttribute('data-running', 'false');
        await expect(row).toContainText('PostgreSQL');
        // Created with no published port, so Connect has nothing to offer and says so by being disabled.
        await expect(row).toContainText('no published port');

        await row.getByTestId('docker-start').click();
        await expect(row).toHaveAttribute('data-running', 'true', { timeout: 60_000 });
        expect(await containerState(THROWAWAY)).toBe('running');

        await row.getByTestId('docker-stop').click();
        await expect(row).toHaveAttribute('data-running', 'false', { timeout: 60_000 });
        expect(await containerState(THROWAWAY)).toBe('exited');

        // The harness containers are exactly where they were.
        expect(await containerState(HARNESS_POSTGRES)).toBe('running');
        expect(await containerState(HARNESS_MYSQL)).toBe('running');

        await closeDockerPanel(window);
      });
    } finally {
      await removeThrowaway();
    }
  });

  test('Connect opens the connection editor with the container’s host and port filled in', async () => {
    await withJoineryReact(async ({ window }) => {
      await openDockerPanel(window);

      const row = dockerContainerRow(window, HARNESS_POSTGRES);
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Read-only as far as the container is concerned: this opens a dialog, it does not connect.
      await row.getByTestId('docker-connect').click();

      const editor = window.getByTestId('connection-editor');
      await expect(editor).toBeVisible({ timeout: 10_000 });
      // The `prefill` prop Task 9 added for this entry point and nothing passed until now.
      await expect(editor.getByLabel('Server', { exact: true })).toHaveValue('localhost');
      await expect(editor.getByLabel('Port', { exact: true })).toHaveValue('15432');

      await window.keyboard.press('Escape');
      await expect(editor).toBeHidden({ timeout: 10_000 });
    });
  });
});
