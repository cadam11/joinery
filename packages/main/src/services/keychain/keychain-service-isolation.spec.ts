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
 * Two rules per launcher, and they are the two halves of the same guarantee:
 *
 *  1. it sets `JOINERY_KEYCHAIN_SERVICE` in the environment it hands Electron — without it the
 *     app resolves the production default and reads/rewrites the developer's real vault;
 *  2. it never names the production service as a string literal — so the override can never be
 *     pinned back at the thing it exists to avoid.
 */

/**
 * Vitest is configured at the repo root and runs from it, so `cwd` is the root. Derived that way
 * rather than from this file's own location because this package compiles as CommonJS, where
 * `import.meta.url` is a type error, while vitest loads the same file as ESM, where `__dirname`
 * does not exist. `beforeAll` asserts the assumption instead of trusting it.
 */
const REPO_ROOT = process.cwd();

/** Every file in the repo that starts a real Electron process. */
const LAUNCH_SITES = [
  // The one launcher behind all five Playwright projects (e2e, perf, visual, docs-shots).
  'tests/helpers/electron-app.ts',
  // The manual cold-start benchmark. Not a Playwright tier, but it boots the same app.
  'tests/scripts/perf-baseline.mjs',
] as const;

/** The production service name, as a source-code string literal in each of the three quote styles. */
const PRODUCTION_SERVICE_LITERAL = new RegExp(`['"\`]${APP_ID.replace(/\./g, '\\.')}['"\`]`);

beforeAll(() => {
  expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
});

function readLaunchSite(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** The env-key occurrences of the override, ignoring prose in comments. */
function envAssignments(source: string): string[] {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('*') && !line.startsWith('//'))
    .filter(line => new RegExp(`\\[?${KEYCHAIN_SERVICE_ENV_VAR}\\]?\\s*:`).test(line));
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
