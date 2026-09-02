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
 * ── READ THIS BEFORE RUNNING IT ONCE J-161 (PR #113) HAS LANDED ────────────────────────────────
 *
 * **While `JOINERY_KEYCHAIN_SERVICE` is honoured — i.e. before PR #113 (J-161) lands — this smoke
 * run uses the hermetic test namespace and is safe. Once a packaged app ignores the override, this
 * script must NOT be run against a packaged build until a build-time test-capability flag exists,
 * because the boot path can MIGRATE — write and delete — production Keychain entries.**
 *
 * That is the correction to an earlier, weaker claim in this comment that the run was "read-only,
 * as long as you do not save a profile or run a query". Those are operator actions, and this script
 * performs none of them — but the boot does its own writing, before any assertion here runs:
 *
 *  - `packages/main/src/index.ts:137-139` fires `CredentialStore.getInstance().loadAllIntoCache()`
 *    on every `whenReady`, unconditionally and un-awaited;
 *  - `credential-store.ts:73-88` — when the vault key is absent but other accounts exist under the
 *    same service, that load takes the legacy-migration branch: `saveVault()` writes a vault entry,
 *    then `keytar.deletePassword` removes EVERY legacy item it found.
 *
 * So on a machine whose production vault is still in the pre-migration shape, one run of this
 * script against a packaged build that ignored the override would rewrite and then destroy those
 * items with nobody touching the UI. `PACKAGED_APP_HONOURS_KEYCHAIN_OVERRIDE` below is the gate:
 * flip it when #113 lands and this script refuses to launch until the capability flag replaces it.
 *
 * Two further reasons the same run is not as inert as it looks: the smoke bundle is unsigned
 * (`mac.identity: null`), so it is a different Keychain client than the installed app and reading a
 * production item raises macOS's "allow access?" prompt — and an operator who answers *Always
 * Allow* grants a throwaway binary standing access to that item.
 *
 * The env pin below stays regardless — it is what protects the run today, and it is what the J-96
 * structural guard checks for. J-161 refuses it only in a packaged app, and deliberately: the
 * shipped binary is the one the user trusted with their Keychain, so letting the environment aim it
 * elsewhere borrows that trust. Its own reasoning names this very case — "if a future tier ever has
 * to launch a packaged bundle, that wants an explicit, signed-build-only mechanism, not an env var"
 * — and this script is that case.
 *
 * J-161 also adds a third rule to `keychain-service-isolation.spec.ts`: a registered launch site
 * must not name a packaged-bundle path. This file names three of them by necessity, so on the
 * merged tree that rule fails here. Sequencing the two changes is the coordinator's call and is
 * deliberately not papered over here with an exemption — the reviewer recommends landing the
 * capability flag first rather than exempting this launcher from the rule.
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

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'electron-builder.yml');
const DEFAULT_APP = join(REPO_ROOT, 'release/mac-arm64/Joinery.app');

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

/**
 * Whether a PACKAGED Joinery still honours `JOINERY_KEYCHAIN_SERVICE`.
 *
 * `true` today, and that is a fact about `packages/main/src/services/keychain/service-name.ts`
 * rather than a preference: it reads the override with no reference to `app.isPackaged`. PR #113
 * (J-161) changes that on purpose, and when it lands **this constant must be set to `false` in the
 * same change**, at which point `assertKeychainIsolationHolds` below refuses to launch instead of
 * booting the packaged bundle against the developer's production Keychain namespace — where the
 * credential store's legacy-credential migration writes a vault entry and deletes every legacy item
 * it finds (`credential-store.ts:73-88`), with no operator action at all.
 *
 * A hand-maintained constant rather than a probe, deliberately. What would have to be detected is
 * the behaviour of a DIFFERENT process's resolver, and the only honest way to observe it is to boot
 * the app and read its log — which is the very thing that must not happen. A build-time
 * test-capability flag baked into the bundle is the real fix (ticket to be filed; relates J-88); at
 * that point this constant is replaced by reading the flag out of the bundle's own metadata, and
 * the refusal below becomes "this bundle was not built with the test capability".
 *
 * The failure mode of getting it wrong is one-directional and that is why it is safe as a constant:
 * stale-`true` after #113 is the dangerous state, and it is the state the reviewer, the PR body and
 * `plans/release/ASAR-INVENTORY.md` all name as the precondition for merging #113.
 */
const PACKAGED_APP_HONOURS_KEYCHAIN_OVERRIDE = true;

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
 * Refuse to launch when the bundle would ignore the keychain pin.
 *
 * Before the launch, not after: the damage this prevents happens during `whenReady`, so an
 * assertion that ran once a window existed would be too late.
 */
export function assertKeychainIsolationHolds(
  packagedAppHonoursOverride = PACKAGED_APP_HONOURS_KEYCHAIN_OVERRIDE
): void {
  if (packagedAppHonoursOverride) return;
  throw new Error(
    'a packaged Joinery ignores JOINERY_KEYCHAIN_SERVICE (J-161), so this smoke run would boot ' +
      "against the developer's production Keychain namespace, where the credential store's " +
      'legacy-credential migration writes and then deletes real entries. Refusing to launch until ' +
      'a build-time test-capability flag exists — see this file’s header.'
  );
}

async function smoke(args: Args): Promise<void> {
  assertKeychainIsolationHolds();
  const productName = productNameFromConfig(readFileSync(CONFIG_PATH, 'utf8'));
  const executable = executableInBundle(args.appPath, productName);
  if (!existsSync(executable)) {
    throw new Error(`no packaged app at ${executable} — run "pnpm run package:dir" first`);
  }

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
