/**
 * Does the PACKAGED app still boot? (J-90)
 *
 *   node scripts/release/smoke-packaged-app.ts [path/to/Joinery.app] [--show]
 *
 * Launches the bundle `pnpm run package:dir` produced, waits for the main window to load the
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
 * ── The two things it refuses to touch ────────────────────────────────────────────────────────
 *
 *  - a fresh `mkdtemp` user-data directory per run, passed as Chromium's `--user-data-dir`, so
 *    window state, profiles and app state go somewhere thrown away in the `finally`;
 *  - `JOINERY_KEYCHAIN_SERVICE` pinned to the same service name every Electron launch in this repo
 *    uses (`tests/helpers/electron-app.ts`). The login keychain is per-USER and namespaced only by
 *    service name, so without this the boot would read and rewrite the vault the INSTALLED Joinery
 *    keeps a developer's real connection passwords and AI keys in. See J-96.
 *
 * By default the window stays hidden (`JOINERY_TEST=1`, honoured by `window.ts`'s `ready-to-show`
 * handler) so a run does not steal focus; the renderer still paints into Chromium's off-screen
 * surface, which is what every assertion below reads. Pass `--show` to watch a real window appear.
 *
 * Runs under Node's type stripping (>= 22.18), like every other `.ts` in this directory.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from '@playwright/test';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DEFAULT_APP = join(REPO_ROOT, 'release/mac-arm64/Joinery.app');

/** Same value as `TEST_KEYCHAIN_SERVICE` in `tests/helpers/electron-app.ts`, for the same reason. */
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

/** The executable inside a macOS bundle. electron-builder names it after `productName`. */
export function executableInBundle(appPath: string): string {
  return join(appPath, 'Contents', 'MacOS', 'Joinery');
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

async function smoke(args: Args): Promise<void> {
  const executable = executableInBundle(args.appPath);
  if (!existsSync(executable)) {
    throw new Error(`no packaged app at ${executable} — run "pnpm run package:dir" first`);
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'joinery-smoke-userdata-'));
  stdout.write(`  launching ${executable}\n`);
  stdout.write(`  user-data  ${userDataDir}\n`);

  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: launchEnv(args.show),
    timeout: BOOT_TIMEOUT_MS,
  });

  try {
    const window = await app.firstWindow({ timeout: BOOT_TIMEOUT_MS });
    stdout.write('  ok    main window created\n');

    await window.waitForLoadState('domcontentloaded');
    stdout.write(`  ok    renderer loaded — ${await window.url()}\n`);

    await window.waitForSelector(SHELL_SELECTORS, { state: 'attached', timeout: BOOT_TIMEOUT_MS });
    stdout.write(`  ok    shell mounted — title "${await window.title()}"\n`);
  } finally {
    // Both cleanups run, and a failure in either is reported rather than swallowed. Neither may
    // replace an assertion failure that is already propagating, so they print instead of throwing.
    try {
      await app.close();
      stdout.write('  ok    quit cleanly\n');
    } catch (error) {
      stderr.write(`  WARN  could not close the app: ${(error as Error).message}\n`);
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch (error) {
      stderr.write(`  WARN  could not remove ${userDataDir}: ${(error as Error).message}\n`);
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
