/**
 * Was this build made for testing? A property of the ARTIFACT, never of the environment (J-167).
 *
 * J-161 has a packaged Joinery refuse `JOINERY_KEYCHAIN_SERVICE`, because the packaged binary is
 * the one the user has already trusted with their Keychain: letting whoever set the environment of
 * a launch aim it at another service name borrows that trust to read items Joinery has no business
 * touching, and `credential-store.ts`'s legacy migration would copy and then DELETE what it found
 * there.
 *
 * That leaves the packaged-app test paths — `scripts/release/smoke-packaged-app.ts` today, the J-88
 * packaged tier next — booting a real bundle against the developer's production vault, with the same
 * migration branch live and no operator action needed to reach it. They need the override back, and
 * a second environment variable cannot give it to them: an attacker who can set one can set two, so
 * the hatch would reopen the hole while the code read as fixed.
 *
 * So the hatch is a file the packaging step writes into a TEST bundle and nothing writes into a
 * release bundle: `Contents/Resources/joinery-test-build`. Made by `pnpm run package:test`
 * (`scripts/release/test-build-marker.ts --stamp`), and the release path proves its own artifact
 * lacks it — `pnpm run verify:package` fails on a bundle that carries it.
 *
 * Outside the asar on purpose. `app.asar` is the artifact J-90 shrank and J-88 exists to validate,
 * so a test bundle and a release bundle differ by one inert file and not by the archive under test.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The marker's name inside `Contents/Resources`.
 *
 * Duplicated as a literal in `scripts/release/test-build-marker.ts`, which cannot be imported here
 * (it runs under Node's type stripping; this package compiles as CommonJS). The duplication is
 * checked rather than remembered: `test-build-marker.spec.ts` fails the unit tier if the two
 * literals drift, because the dangerous direction is silent — an app honouring a marker the release
 * guard no longer looks for.
 */
export const TEST_BUILD_MARKER_FILENAME = 'joinery-test-build';

/** Logged at startup by a build that carries the marker. Says what it is and what it is not for. */
export const TEST_BUILD_WARNING =
  'This build carries the J-167 test capability marker ' +
  `(Contents/Resources/${TEST_BUILD_MARKER_FILENAME}), so it honours test-only environment ` +
  'hatches that a release build refuses. It must not be distributed — "pnpm run verify:package" ' +
  'fails on a bundle that carries it.';

/**
 * Whether this process is running a bundle built for testing.
 *
 * @param resourcesPath the bundle's `Contents/Resources`; defaults to Electron's own
 *   `process.resourcesPath`. Undefined outside Electron — every vitest process — and "no resources
 *   directory" is not a test build, which is the same answer an unpackaged app needs.
 */
export function isTestCapableBuild(
  resourcesPath: string | undefined = process.resourcesPath
): boolean {
  if (resourcesPath === undefined || resourcesPath === '') return false;
  return existsSync(join(resourcesPath, TEST_BUILD_MARKER_FILENAME));
}
