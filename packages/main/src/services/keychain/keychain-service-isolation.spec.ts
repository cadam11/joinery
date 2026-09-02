import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_ID } from '@joinery/shared';
import { KEYCHAIN_SERVICE_ENV_VAR } from './service-name';

/**
 * The structural guard on keychain hermeticity in the Electron-launching test tiers (J-96).
 *
 * Nothing in a Playwright run can observe which Keychain service the app under test picked:
 * there is no IPC that reports it, and asserting on the real login keychain from a spec would
 * mean touching the very namespace this is trying to protect. So the check is on the SOURCE of
 * every launcher, in the same spirit as the renderer's `no-local-storage-writes.spec.ts` — real
 * user data is at stake (a developer's saved connection passwords and AI keys live in the
 * production vault) and "remember to set the env var" is not a property that survives on a
 * comment through the next launcher refactor.
 *
 * Two rules for every launcher, and they are the two halves of the same guarantee:
 *
 *  1. it sets `JOINERY_KEYCHAIN_SERVICE` in the environment it hands Electron — without it the
 *     app resolves the production default and reads/rewrites the developer's real vault;
 *  2. it never names the production service as a string literal — so the override can never be
 *     pinned back at the thing it exists to avoid.
 *
 * And one more rule for a launcher that starts a PACKAGED bundle, because for that launcher rule 1
 * is not sufficient on its own (J-167). A packaged Joinery is the signed binary the user trusted
 * with their Keychain, so J-161 has it refuse the override — which leaves a packaged launcher
 * setting a variable the app ignores, booting against the production vault, where the credential
 * store's legacy migration writes a vault entry and deletes every legacy item it finds. So:
 *
 *  3. a packaged launcher refuses to launch a bundle that was not built with the build-time test
 *     capability (`scripts/release/test-build-marker.ts`), which is the only thing an environment
 *     cannot forge.
 */

/**
 * Vitest is configured at the repo root and runs from it, so `cwd` is the root. Derived that way
 * rather than from this file's own location because this package compiles as CommonJS, where
 * `import.meta.url` is a type error, while vitest loads the same file as ESM, where `__dirname`
 * does not exist. `beforeAll` asserts the assumption instead of trusting it.
 */
const REPO_ROOT = process.cwd();

/**
 * Every file in the repo that starts a real Electron process.
 *
 * Kept honest by grepping for the launch APIs rather than by memory: `_electron`,
 * `electron.launch` and `executablePath` appear in exactly these files and nowhere else. A new
 * launcher that is not listed here is invisible to this guard, which is the one failure mode the
 * guard cannot catch itself — so adding one means adding a line here.
 */
const UNPACKAGED_LAUNCH_SITES = [
  // The one launcher behind all five Playwright projects (e2e, perf, visual, docs-shots).
  'tests/helpers/electron-app.ts',
  // The manual cold-start benchmark. Not a Playwright tier, but it boots the same app.
  'tests/scripts/perf-baseline.mjs',
] as const;

/**
 * Launchers that start a PACKAGED bundle — `Joinery.app/Contents/MacOS/Joinery` — rather than
 * handing `packages/main/dist/index.js` to the Electron binary. Split out from the list above
 * because rule 3 applies to these and only these: an unpackaged launcher's environment pin is
 * honoured, so it needs no marker, and requiring one would fail every Playwright tier.
 */
const PACKAGED_LAUNCH_SITES = ['scripts/release/smoke-packaged-app.ts'] as const;

const LAUNCH_SITES = [...UNPACKAGED_LAUNCH_SITES, ...PACKAGED_LAUNCH_SITES] as const;

/** The production service name, as a source-code string literal in each of the three quote styles. */
const PRODUCTION_SERVICE_LITERAL = new RegExp(`['"\`]${APP_ID.replace(/\./g, '\\.')}['"\`]`);

beforeAll(() => {
  expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
});

function readLaunchSite(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** A file's lines with prose stripped, so a promise in a comment cannot satisfy any rule below. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('*') && !line.startsWith('//'));
}

/** The env-key occurrences of the override, ignoring prose in comments. */
function envAssignments(source: string): string[] {
  return codeLines(source).filter(line =>
    new RegExp(`\\[?${KEYCHAIN_SERVICE_ENV_VAR}\\]?\\s*:`).test(line)
  );
}

/**
 * Lines that CALL the refusal, which is not the same as lines that mention it (J-167 review, B1).
 *
 * The first version of this matched `/assertBundleIsTestCapable\(/` anywhere in the file, and the
 * function's own `export function assertBundleIsTestCapable(` satisfied it — so the call could be
 * deleted and the guard stayed green, which is precisely the tree that boots a release-shaped bundle
 * against the developer's production vault. Declarations are excluded, and comments are already
 * gone, so what is left is a call.
 */
function refusalCalls(source: string): string[] {
  return codeLines(source)
    .filter(line => !/^(export\s+)?(async\s+)?function\s/.test(line))
    .filter(line => /assertBundleIsTestCapable\s*\(/.test(line));
}

describe.each(LAUNCH_SITES)('%s launches Electron with an isolated keychain', relativePath => {
  const source = readLaunchSite(relativePath);

  it(`sets ${KEYCHAIN_SERVICE_ENV_VAR} in the launch environment`, () => {
    expect(envAssignments(source)).not.toHaveLength(0);
  });

  it('never names the production keychain service', () => {
    expect(source).not.toMatch(PRODUCTION_SERVICE_LITERAL);
  });
});

describe.each(PACKAGED_LAUNCH_SITES)('%s refuses a bundle it must not boot', relativePath => {
  const source = readLaunchSite(relativePath);

  /**
   * A call, not a mention: the refusal has to run before `electron.launch`, and a comment — or the
   * function's own declaration — promising it is exactly what this guard exists not to trust.
   * `assertBundleIsTestCapable` itself is unit-tested against real stamped and unstamped bundles in
   * `scripts/release/test-build-marker.spec.ts` and `scripts/release/smoke-packaged-app.spec.ts`.
   */
  it('asserts the bundle carries the build-time test capability before launching', () => {
    expect(refusalCalls(source)).not.toHaveLength(0);
  });
});
