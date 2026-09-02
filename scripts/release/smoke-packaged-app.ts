/**
 * Does the PACKAGED app still boot? (J-90)
 *
 *   node scripts/release/smoke-packaged-app.ts [path/to/Joinery.app] [--show]
 *
 * Launches the bundle `pnpm run package:test` produced, waits for the main window to load the
 * renderer and mount the shell, then quits it. No database, no query, no connection — this answers
 * exactly one question, and it is the question an asar exclusion can break: does the archive still
 * contain enough to start.
 *
 * ── Why this exists next to verify:package rather than inside it ───────────────────────────────
 *
 * `scripts/verify-package.js` extracts the archive and `require()`s each module the main process
 * depends on under plain Node. That catches a missing transitive dependency, which is the failure
 * it was written for, but it never starts Electron: the window, the preload bridge, the CSP and
 * the renderer's own file:// load are all outside what it can see. J-90 removed 121 MB from the
 * archive, so "the pieces resolve" needed to be joined by "and the app comes up".
 *
 * Kept out of `verify:package` on purpose — that script is a pure archive inspection that runs in
 * CI on a Linux runner as happily as on a Mac, while this one needs a real macOS app bundle and a
 * window server. Run it by hand after packaging.
 *
 * ── What it refuses to touch, and what makes the refusal real ─────────────────────────────────
 *
 *  - a fresh `mkdtemp` user-data directory per run, passed as Chromium's `--user-data-dir`, so
 *    window state, profiles and app state go somewhere thrown away in the `finally`;
 *  - `JOINERY_KEYCHAIN_SERVICE` pinned to the same service name every Electron launch in this repo
 *    uses (`tests/helpers/electron-app.ts`). The login keychain is per-USER and namespaced only by
 *    service name, so without this the boot would read and rewrite the vault the INSTALLED Joinery
 *    keeps a developer's real connection passwords and AI keys in. See J-96.
 *
 * That pin is not sufficient on its own, and this is the part worth reading before running it.
 * J-161 (PR #113) makes a PACKAGED Joinery refuse the override — correctly: the packaged binary is
 * the one the user trusted with their Keychain. This script launches exactly that, so an unmarked
 * bundle would boot against the production namespace, and the boot is not read-only:
 *
 *  - `packages/main/src/index.ts` fires `CredentialStore.getInstance().loadAllIntoCache()` on every
 *    `whenReady`, unconditionally and un-awaited;
 *  - `credential-store.ts` — when the vault key is absent but other accounts exist under the same
 *    service — takes the legacy-migration branch: `saveVault()` writes a vault entry, then
 *    `keytar.deletePassword` removes EVERY legacy item it found.
 *
 * So one run against a bundle that ignored the pin could rewrite and then destroy a developer's
 * real Keychain items with nobody touching the UI. `assertBundleIsTestCapable` below is what stops
 * it: the bundle must carry the build-time test-capability marker
 * (`scripts/release/test-build-marker.ts`, J-167), which only `pnpm run package:test` writes and no
 * environment can forge. It replaced a hand-maintained constant that had to be flipped by whoever
 * merged #113 — a fact about the bundle in front of us, rather than one somebody had to remember.
 *
 * Build what this script will accept with:
 *
 *   pnpm run package:test        # package:dir, then stamp the bundle as a test build
 *
 * One thing the marker does NOT fix: the bundle is unsigned (`mac.identity: null`), so it is a
 * different Keychain client than the installed app. It only ever asks for the test namespace now,
 * so there is nothing of the developer's for macOS to prompt about — but an operator who does see a
 * prompt and answers *Always Allow* is granting a throwaway binary standing access, so do not.
 *
 * Runs under Node's type stripping (>= 22.18), like every other `.ts` in this directory.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from '@playwright/test';
import { parse } from 'yaml';

import { bundleCarriesTestCapability } from './test-build-marker.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'electron-builder.yml');

/** The bundle `pnpm run package:dir` / `package:test` writes, and every caller's default. */
export const DEFAULT_APP = join(REPO_ROOT, 'release/mac-arm64/Joinery.app');

/**
 * The Keychain service this launch stores credentials under — the same value as
 * `TEST_KEYCHAIN_SERVICE` in `tests/helpers/electron-app.ts`, for the same reason: the macOS login
 * keychain is per-USER and namespaced only by service name, so a launch that does not say otherwise
 * reads and rewrites the vault holding a developer's real connection passwords and AI provider
 * keys (J-96).
 *
 * **Duplicated as a literal rather than imported, and that is forced rather than chosen.**
 * `tests/helpers/electron-app.ts` reads `__dirname` at module scope, which is fine under
 * Playwright's CJS-emitting loader and a `ReferenceError` under the ESM type stripping this
 * directory runs on — so importing the constant would break this script at load time. What makes
 * the duplication safe is that it is checked, not remembered:
 * `packages/main/src/services/keychain/keychain-service-isolation.spec.ts` lists this file among
 * its `LAUNCH_SITES` and fails the unit tier if the assignment below ever disappears (J-90 review,
 * blocker B1).
 */
const TEST_KEYCHAIN_SERVICE = 'ca.adam11.joinery.tests';

/** The shell's root element. `startup-screen` is what renders while it is still resolving state. */
const SHELL_SELECTORS = ['[data-testid="app-shell"]', '[data-testid="startup-screen"]'].join(', ');

const BOOT_TIMEOUT_MS = 60_000;

interface Args {
  readonly appPath: string;
  readonly show: boolean;
}

export function parseArgs(args: readonly string[]): Args {
  let appPath = DEFAULT_APP;
  let show = false;

  for (const arg of args) {
    if (arg === '--show') show = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else appPath = arg;
  }

  return { appPath, show };
}

/**
 * The product name electron-builder names the bundle's executable after.
 *
 * Read from the config rather than hardcoded (review finding 6): a `productName` change used to
 * make this script fail with "no packaged app at …" naming a path that had never existed, which
 * points a reader at the bundle instead of at the rename.
 */
export function productNameFromConfig(configSource: string): string {
  const config = parse(configSource) as { productName?: unknown };
  if (typeof config.productName !== 'string' || config.productName === '') {
    throw new Error('electron-builder.yml declares no productName');
  }
  return config.productName;
}

/** The executable inside a macOS bundle. electron-builder names it after `productName`. */
export function executableInBundle(appPath: string, productName: string): string {
  return join(appPath, 'Contents', 'MacOS', productName);
}

function launchEnv(show: boolean): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }
  // Deliberately last: no caller and no ambient environment may aim the credential store at the
  // real vault.
  return {
    ...inherited,
    ...(show ? {} : { JOINERY_TEST: '1' }),
    ELECTRON_ENABLE_LOGGING: '1',
    JOINERY_KEYCHAIN_SERVICE: TEST_KEYCHAIN_SERVICE,
  };
}

/**
 * Refuse to launch a bundle that was not built with the test capability.
 *
 * Before the launch, not after: the damage this prevents happens during `whenReady`, so an
 * assertion that ran once a window existed would be too late.
 */
export function assertBundleIsTestCapable(appPath: string): void {
  if (bundleCarriesTestCapability(appPath)) return;
  throw new Error(
    `${appPath} was not built with the J-167 test capability, so a packaged Joinery would ` +
      'ignore the JOINERY_KEYCHAIN_SERVICE pin this launcher sets (J-161) and boot against the ' +
      "developer's production Keychain namespace, where the credential store's legacy-credential " +
      'migration writes and then deletes real entries. Build a bundle this can launch with ' +
      '"pnpm run package:test".'
  );
}

/**
 * The executable inside a packaged bundle, or a throw naming the command that builds one.
 *
 * The three decisions a launcher makes before it spawns anything, in one place so the packaged-app
 * smoke TIER (`tests/smoke-packaged/packaged-app.ts`, J-88) makes them identically rather than
 * restating them: the product name comes from the real `electron-builder.yml` (a rename used to
 * make this fail naming a path that had never existed), the bundle layout is macOS's, and a missing
 * bundle is reported as "package one" rather than as a spawn failure.
 *
 * Says nothing about whether the bundle may be LAUNCHED — that is
 * {@link assertBundleIsTestCapable}, which every caller must also call.
 */
export function packagedExecutable(appPath: string = DEFAULT_APP): string {
  const productName = productNameFromConfig(readFileSync(CONFIG_PATH, 'utf8'));
  const executable = executableInBundle(appPath, productName);
  if (!existsSync(executable)) {
    throw new Error(`no packaged app at ${executable} — run "pnpm run package:test" first`);
  }
  return executable;
}

async function smoke(args: Args): Promise<void> {
  const executable = packagedExecutable(args.appPath);
  assertBundleIsTestCapable(args.appPath);

  const userDataDir = mkdtempSync(join(tmpdir(), 'joinery-smoke-userdata-'));
  stdout.write(`  launching ${executable}\n`);
  stdout.write(`  user-data  ${userDataDir}\n`);

  // The directory is owned from the line after it is created, so a launch that throws or times out
  // cannot leak it (review finding 5) — `electron.launch` is INSIDE this try, not above it.
  try {
    await withLaunchedApp(executable, userDataDir, args.show);
  } finally {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch (error) {
      stderr.write(`  WARN  could not remove ${userDataDir}: ${(error as Error).message}\n`);
    }
  }
}

/** Launch, assert the boot, and always quit. Split out so `smoke` owns only the temp directory. */
async function withLaunchedApp(
  executable: string,
  userDataDir: string,
  show: boolean
): Promise<void> {
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: launchEnv(show),
    timeout: BOOT_TIMEOUT_MS,
  });

  try {
    const window = await app.firstWindow({ timeout: BOOT_TIMEOUT_MS });
    stdout.write('  ok    main window created\n');

    await window.waitForLoadState('domcontentloaded');
    stdout.write(`  ok    renderer loaded — ${window.url()}\n`);

    await window.waitForSelector(SHELL_SELECTORS, { state: 'attached', timeout: BOOT_TIMEOUT_MS });
    stdout.write(`  ok    shell mounted — title "${await window.title()}"\n`);
  } finally {
    // A close failure is reported rather than swallowed, and must not replace an assertion failure
    // that is already propagating — so it prints instead of throwing.
    try {
      await app.close();
      stdout.write('  ok    quit cleanly\n');
    } catch (error) {
      stderr.write(`  WARN  could not close the app: ${(error as Error).message}\n`);
    }
  }
}

// Run only when invoked as a script; importing this file from a test must not launch anything.
if (fileURLToPath(import.meta.url) === argv[1]) {
  smoke(parseArgs(argv.slice(2)))
    .then(() => stdout.write('\nThe packaged app boots.\n'))
    .catch((error: Error) => {
      stderr.write(`\nsmoke-packaged-app: ${error.message}\n`);
      process.exitCode = 1;
    });
}
