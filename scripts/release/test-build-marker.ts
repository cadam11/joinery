/**
 * The build-time test capability: stamp it into a test bundle, and prove a release bundle lacks it
 * (J-167).
 *
 *   node scripts/release/test-build-marker.ts [path/to/Joinery.app]           # report
 *   node scripts/release/test-build-marker.ts --stamp [path/to/Joinery.app]   # make it a test build
 *   node scripts/release/test-build-marker.ts --check [path/to/Joinery.app]   # guard: exit 1 if stamped
 *
 * Defaults to the bundle `pnpm run package:dir` writes, the same one `scripts/verify-package.js`
 * probes and `scripts/release/smoke-packaged-app.ts` launches. Runs under Node's type stripping
 * (>= 22.18), like every other `.ts` in this directory.
 *
 * ── What the marker is for ────────────────────────────────────────────────────────────────────
 *
 * J-161 makes a packaged Joinery refuse `JOINERY_KEYCHAIN_SERVICE`, which is right — the signed
 * binary is the one the user trusted with their Keychain — and which leaves every packaged-app test
 * path booting against the developer's PRODUCTION vault, where the credential store's legacy
 * migration writes a vault entry and then deletes every legacy item it finds
 * (`packages/main/src/services/keychain/credential-store.ts`), with nobody touching the UI.
 *
 * A second environment variable cannot be the way back in: whoever can set one can set two. So the
 * capability is a file in the bundle — `Contents/Resources/joinery-test-build` — written by
 * `pnpm run package:test` and by nothing else. An environment cannot forge it, and the release path
 * proves its own artifact does not carry it, because `--check` is chained into
 * `pnpm run verify:package`.
 *
 * ── Why a file in Contents/Resources rather than `extraMetadata` ──────────────────────────────
 *
 * `extraMetadata` would stamp the key into the `package.json` INSIDE `app.asar`, which makes a test
 * bundle's archive differ from the release archive — the archive J-90 shrank and J-88 exists to
 * validate. Outside the asar, the two bundles differ by one inert file. It is also readable without
 * extracting an archive, which matters because three different runtimes have to read it: this
 * script, the CommonJS `scripts/verify-package.js`, and the main process
 * (`packages/main/src/utils/test-build-capability.ts`).
 *
 * Everything above `stampBundle` is pure; `stampBundle` and `bundleCarriesTestCapability` touch
 * disk, and `test-build-marker.spec.ts` exercises both against real bundle-shaped temp directories.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DEFAULT_APP = join(REPO_ROOT, 'release/mac-arm64/Joinery.app');

/**
 * The marker's name inside `Contents/Resources`.
 *
 * The same literal appears in {@link MAIN_PROCESS_READER}, which cannot import it: this file runs
 * under type stripping and that one compiles into the main process bundle. The unit tier asserts
 * the two agree.
 */
export const TEST_BUILD_MARKER_FILENAME = 'joinery-test-build';

/** The main process's reader of the same marker, relative to the repository root. */
export const MAIN_PROCESS_READER = 'packages/main/src/utils/test-build-capability.ts';

/** What the marker file says, for whoever finds it inside a bundle and wonders. */
const MARKER_CONTENTS = `Joinery test-capability marker (J-167).

This bundle was built by "pnpm run package:test". Its presence tells the main process that this is
a TEST build, which is what lets the packaged test paths keep the JOINERY_KEYCHAIN_SERVICE
override that a release build refuses (J-161) — so that booting a packaged Joinery for a test does
not read and migrate the developer's real Keychain vault.

A release build must never be distributed with this file: "pnpm run verify:package" fails on a
bundle that carries it. Delete the file to turn this bundle back into a release-shaped one.
`;

export type Mode = 'report' | 'stamp' | 'check';

export interface Args {
  readonly appPath: string;
  readonly mode: Mode;
}

export function parseArgs(args: readonly string[]): Args {
  let appPath = DEFAULT_APP;
  let stamp = false;
  let check = false;

  for (const arg of args) {
    if (arg === '--stamp') stamp = true;
    else if (arg === '--check') check = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else appPath = arg;
  }

  // Not "last one wins": one of them makes the bundle a test build and the other fails the release
  // on exactly that, so a run that was handed both was misunderstood by whoever wrote it.
  if (stamp && check) throw new Error('--stamp and --check are mutually exclusive');

  return { appPath, mode: stamp ? 'stamp' : check ? 'check' : 'report' };
}

/** Where the marker lives in a macOS bundle: beside `app.asar`, not inside it. */
export function markerPathInBundle(appPath: string): string {
  return join(appPath, 'Contents', 'Resources', TEST_BUILD_MARKER_FILENAME);
}

/**
 * Write the marker into a bundle, making it a test build.
 *
 * @returns the path written.
 * @throws if `appPath` is not a macOS bundle — creating the directories would produce a marker in
 *   a place nothing reads, and a `--stamp` that silently did nothing is how a smoke run ends up
 *   pointed at an unmarked bundle.
 */
export function stampBundle(appPath: string): string {
  const resourcesDir = join(appPath, 'Contents', 'Resources');
  if (!existsSync(resourcesDir) || !statSync(resourcesDir).isDirectory()) {
    throw new Error(`${appPath} has no Contents/Resources — it is not a packaged macOS bundle`);
  }

  const markerPath = markerPathInBundle(appPath);
  writeFileSync(markerPath, MARKER_CONTENTS);
  return markerPath;
}

/**
 * Whether a bundle on disk was built with the test capability.
 *
 * @throws if there is no bundle at `appPath`. A release guard that reported an absent artifact as
 *   clean would pass without having looked at anything — the vacuity `verify-package.js` and
 *   `asar-inventory.ts --check` both refuse.
 */
export function bundleCarriesTestCapability(appPath: string): boolean {
  if (!existsSync(join(appPath, 'Contents'))) {
    throw new Error(`no app bundle at ${appPath} — run "pnpm run package:dir" first`);
  }
  return existsSync(markerPathInBundle(appPath));
}

/** Run the mode and return the process exit code. */
function run(args: Args): number {
  if (args.mode === 'stamp') {
    stdout.write(`  stamped ${stampBundle(args.appPath)}\n`);
    stdout.write('  this bundle is now a TEST build and must not be distributed\n');
    return 0;
  }

  const carries = bundleCarriesTestCapability(args.appPath);

  if (args.mode === 'check') {
    if (!carries) {
      stdout.write(`  ok    no test-capability marker in ${args.appPath}\n`);
      return 0;
    }
    stderr.write(
      `  FAIL  ${markerPathInBundle(args.appPath)} exists, so this bundle honours test-only\n` +
        '        environment hatches (J-167). It was built by "pnpm run package:test" and must\n' +
        '        not ship. Rebuild with "pnpm run package" for a release artifact.\n'
    );
    return 1;
  }

  stdout.write(`  ${args.appPath}\n  ${carries ? 'TEST build' : 'release build'}\n`);
  return 0;
}

// Run only when invoked as a script; importing this file from a test must not touch a bundle.
if (fileURLToPath(import.meta.url) === argv[1]) {
  try {
    process.exitCode = run(parseArgs(argv.slice(2)));
  } catch (error) {
    stderr.write(`\ntest-build-marker: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
