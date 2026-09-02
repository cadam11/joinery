/**
 * Launching the PACKAGED bundle for the smoke tier, and proving the run left no trace (J-88).
 *
 * The other tiers' launcher is `tests/helpers/electron-app.ts`, which hands
 * `packages/main/dist/index.js` to the Electron binary. This one starts `Joinery.app` — the artefact
 * a user installs — so it carries two obligations that one does not.
 *
 * ── 1. It must refuse a bundle it is not allowed to boot ──────────────────────────────────────
 *
 * A packaged Joinery ignores `JOINERY_KEYCHAIN_SERVICE` (J-161) unless the BUNDLE carries the
 * build-time test marker (J-167), and the boot is not read-only: `packages/main/src/index.ts` fires
 * `CredentialStore.getInstance().loadAllIntoCache()` on `whenReady`, and `credential-store.ts` takes
 * a legacy-migration branch that writes a vault entry and then `keytar.deletePassword`s every legacy
 * item it found. So booting an UNMARKED bundle from here would rewrite and then destroy a
 * developer's real Keychain items with nobody touching the UI. {@link assertBundleIsTestCapable}
 * runs before `electron.launch`, not after a window exists — by then it would be too late — and it
 * is the same function `pnpm run smoke:package` calls, not a second copy of the rule.
 *
 * ── 2. It must clean up after itself, which the Playwright launcher cannot ─────────────────────
 *
 * `tests/helpers/electron-app.ts` pins ONE stable service name for every launch, and says why: a
 * per-launch name would leave a new orphan Keychain item behind on every run, forever, because
 * "nothing in a Playwright teardown can delete a keychain entry without loading keytar into the test
 * process". That is true of a Playwright worker and not of this tier — macOS ships a CLI, `security`,
 * that deletes generic passwords with no prompt (measured against a keytar-written item before this
 * was built). So every run here gets its OWN namespace under {@link SMOKE_KEYCHAIN_PREFIX} and
 * {@link LaunchedPackagedApp.close} deletes the lot.
 *
 * The sweep is by PREFIX rather than by this run's name, so a run that was killed before its
 * teardown is cleaned up by the next one instead of leaving an orphan nobody will ever look for.
 *
 * ── Where the app's log is, because it is not where you would look ───────────────────────────
 *
 * A packaged macOS Joinery writes NOTHING to the stdio it was launched with: measured on this
 * bundle, `app.process().stdout` and `.stderr` both receive zero bytes across a full boot, even
 * with `ELECTRON_ENABLE_LOGGING=1`. So a launcher here cannot capture the app's log by piping, and
 * this one does not pretend to. The tier reads it from inside the running app instead, over the
 * preload bridge's `logs.getRecent()` — the same ring buffer that feeds the Output panel.
 *
 * macOS only, like the bundle it launches and the Keychain it inspects.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ID } from '@joinery/shared';

import {
  DEFAULT_APP,
  assertBundleIsTestCapable,
  packagedExecutable,
} from '../../scripts/release/smoke-packaged-app.ts';

/**
 * The namespace every run of this tier stores credentials under, before its per-run suffix.
 *
 * Derived from `APP_ID` rather than written out, because
 * `packages/main/src/services/keychain/keychain-service-isolation.spec.ts` fails the unit tier if
 * any launcher names the production service as a string literal — the rule that stops the override
 * from being pinned back at the vault it exists to avoid.
 */
export const SMOKE_KEYCHAIN_PREFIX = `${APP_ID}.smoke.`;

const BOOT_TIMEOUT_MS = 60_000;

/** Bounds on the teardown, so no stage of it can hang the run. */
const CLOSE_TIMEOUT_MS = 10_000;
const EXIT_GRACE_MS = 5_000;

/**
 * The most items one namespace may hold before the sweep gives up and says so.
 *
 * `CredentialStore` keeps everything in a single `credentials-vault` entry, so the real number is
 * one; the cap is what turns "delete until the CLI says there are none left" into a bounded loop.
 */
const MAX_KEYCHAIN_ITEMS_PER_SERVICE = 32;

export interface LaunchedPackagedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** The throwaway Keychain service this launch was pointed at. */
  readonly keychainService: string;
  /** The `mkdtemp` directory Chromium was given as `--user-data-dir`. */
  readonly userDataDir: string;
  /**
   * Quit the app, delete the user-data directory, and delete every Keychain item this tier's
   * namespaces hold. Throws if any of the three could not be completed — a leaked Keychain item is
   * a failure of the tier, not a footnote to it.
   */
  close(): Promise<void>;
}

/**
 * Boot the packaged bundle with a throwaway Keychain namespace and an isolated user-data directory.
 *
 * @param appPath the bundle to launch; defaults to the one `pnpm run package:test` writes.
 * @throws before starting anything if that bundle was not built with the test capability.
 */
export async function launchPackagedJoinery(
  appPath: string = DEFAULT_APP
): Promise<LaunchedPackagedApp> {
  // Both preconditions before anything is created, so a throw cannot leak a temp directory.
  const executable = packagedExecutable(appPath);
  assertBundleIsTestCapable(appPath);

  const keychainService = `${SMOKE_KEYCHAIN_PREFIX}${randomUUID().slice(0, 8)}`;
  const userDataDir = mkdtempSync(join(tmpdir(), 'joinery-smoke-tier-userdata-'));

  try {
    const app = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userDataDir}`],
      env: launchEnv(keychainService),
      timeout: BOOT_TIMEOUT_MS,
    });
    const window = await app.firstWindow({ timeout: BOOT_TIMEOUT_MS });
    await window.waitForLoadState('domcontentloaded');

    return {
      app,
      window,
      keychainService,
      userDataDir,
      close: () => teardown(app, userDataDir),
    };
  } catch (error) {
    // The launch owns the directory from the line after it was created (the same rule
    // `scripts/release/smoke-packaged-app.ts` states), so a failed boot cleans up its own mess.
    rmSync(userDataDir, { recursive: true, force: true });
    sweepSmokeKeychainServices();
    throw error;
  }
}

/**
 * The environment the bundle is launched with.
 *
 * The Keychain pin is deliberately LAST: no ambient environment and no caller may aim the packaged
 * credential store at the developer's real vault. `NODE_ENV` is deliberately absent — J-167 leaves
 * the development hatch gated on `isPackaged` alone, so setting it would do nothing except make a
 * reader think a test bundle can be served a dev renderer.
 */
function launchEnv(keychainService: string): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }
  return {
    ...inherited,
    // Honoured because the bundle carries the J-167 marker; keeps the window off the screen.
    JOINERY_TEST: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    JOINERY_KEYCHAIN_SERVICE: keychainService,
  };
}

/** Every stage bounded, so nothing here can hang a run. */
async function teardown(app: ElectronApplication, userDataDir: string): Promise<void> {
  const failures: string[] = [];

  await endAppProcess(app).catch((error: unknown) => {
    failures.push(`could not end the app process: ${(error as Error).message}`);
  });

  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch (error) {
    failures.push(`could not remove ${userDataDir}: ${(error as Error).message}`);
  }

  // After the process is gone, never before: a quitting app can still write its vault.
  try {
    sweepSmokeKeychainServices();
  } catch (error) {
    failures.push(`could not clear the keychain namespace: ${(error as Error).message}`);
  }

  if (failures.length > 0)
    throw new Error(`[smoke-packaged] teardown failed: ${failures.join('; ')}`);
}

/** A bounded wait, so each stage of {@link endAppProcess} has a stated maximum. */
function afterMs(milliseconds: number): Promise<'timeout'> {
  return new Promise(resolve => setTimeout(() => resolve('timeout'), milliseconds));
}

/**
 * Ask the app to quit, then make sure it did.
 *
 * `ElectronApplication.close()` can hang without bound on a loaded machine — measured during J-99
 * Phase 3, where it cost more than a dozen capture tests. The SIGKILL stage is what turns this
 * teardown into a guarantee rather than a hope, and this tier can afford it: the user-data directory
 * is a `mkdtemp` deleted on the next line, and the Keychain sweep after it does not need the app's
 * cooperation.
 */
async function endAppProcess(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<void>(resolve => {
    if (hasExited()) return resolve();
    child.once('exit', () => resolve());
  });

  await Promise.race([app.close().catch(() => undefined), afterMs(CLOSE_TIMEOUT_MS)]);
  if (!hasExited()) child.kill('SIGKILL');

  const outcome = await Promise.race([exited, afterMs(EXIT_GRACE_MS)]);
  if (outcome === 'timeout') throw new Error('the app survived SIGKILL');
}

// ── Reading and clearing the login Keychain, through the CLI macOS already ships ───────────────
//
// `security dump-keychain` prints ATTRIBUTES only, never a password, so it raises no access prompt
// — which is what makes it usable from an unattended test. `-w`, which would print a password,
// is never passed here and must not be.

/** Every generic-password item's service name, one entry per item. */
function keychainServiceNames(): string[] {
  const dump = execFileSync('security', ['dump-keychain'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...dump.matchAll(/^\s*"svce"<blob>="(.*)"$/gm)].map(match => match[1] ?? '');
}

/** How many items the login keychain holds under one exact service name. */
export function keychainItemCount(service: string): number {
  return keychainServiceNames().filter(name => name === service).length;
}

/** The service names this tier has left behind — this run's, and any a killed run orphaned. */
export function smokeKeychainServices(): string[] {
  return [
    ...new Set(keychainServiceNames().filter(name => name.startsWith(SMOKE_KEYCHAIN_PREFIX))),
  ];
}

/**
 * Delete every item under every one of this tier's namespaces.
 *
 * @returns the service names it deleted items from.
 * @throws if a namespace still has items after {@link MAX_KEYCHAIN_ITEMS_PER_SERVICE} deletions —
 *   the cap is what makes "delete until there are none left" a bounded loop rather than a hope.
 */
export function sweepSmokeKeychainServices(): string[] {
  const cleared: string[] = [];
  for (const service of smokeKeychainServices()) {
    deleteKeychainService(service);
    cleared.push(service);
  }
  return cleared;
}

function deleteKeychainService(service: string): void {
  for (let deleted = 0; deleted < MAX_KEYCHAIN_ITEMS_PER_SERVICE; deleted += 1) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', service], { stdio: 'ignore' });
    } catch {
      // The CLI exits non-zero once there is nothing left to delete, which is the loop's exit.
      return;
    }
  }
  throw new Error(
    `${service} still holds items after ${MAX_KEYCHAIN_ITEMS_PER_SERVICE} deletions — ` +
      'sweeping it would not terminate'
  );
}
