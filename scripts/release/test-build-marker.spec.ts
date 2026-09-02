/**
 * The build-time test-capability marker, and the guard that keeps it out of a release (J-167).
 *
 * Everything here runs against a REAL bundle-shaped directory in `mkdtemp` rather than a mocked
 * `fs`. The whole claim being tested is "does this file exist inside this bundle", so a double for
 * `existsSync` would be a double for the claim itself — the failure mode this repo has been bitten
 * by three times.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAIN_PROCESS_READER,
  TEST_BUILD_MARKER_FILENAME,
  bundleCarriesTestCapability,
  markerPathInBundle,
  parseArgs,
  stampBundle,
} from './test-build-marker';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** Every temp tree this file made, removed in `afterEach` whether the spec passed or threw. */
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** A bundle-shaped directory: `<tmp>/Joinery.app/Contents/Resources` exists and is empty. */
function makeBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'joinery-marker-spec-'));
  temporaryDirectories.push(root);
  const appPath = join(root, 'Joinery.app');
  mkdirSync(join(appPath, 'Contents', 'Resources'), { recursive: true });
  return appPath;
}

describe('markerPathInBundle', () => {
  it('points inside Contents/Resources, beside app.asar rather than inside it', () => {
    expect(markerPathInBundle('/tmp/Joinery.app')).toBe(
      `/tmp/Joinery.app/Contents/Resources/${TEST_BUILD_MARKER_FILENAME}`
    );
  });
});

describe('stampBundle', () => {
  it('writes the marker into a bundle that does not carry one', () => {
    const appPath = makeBundle();
    expect(bundleCarriesTestCapability(appPath)).toBe(false);

    const markerPath = stampBundle(appPath);

    expect(markerPath).toBe(markerPathInBundle(appPath));
    expect(bundleCarriesTestCapability(appPath)).toBe(true);
  });

  it('says why the file is there, for whoever finds it in a bundle', () => {
    const appPath = makeBundle();
    stampBundle(appPath);
    const contents = readFileSync(markerPathInBundle(appPath), 'utf8');
    expect(contents).toMatch(/J-167/);
    expect(contents).toMatch(/never be distributed/i);
  });

  it('is idempotent, so re-stamping a test bundle is not an error', () => {
    const appPath = makeBundle();
    stampBundle(appPath);
    expect(() => stampBundle(appPath)).not.toThrow();
    expect(bundleCarriesTestCapability(appPath)).toBe(true);
  });

  it('refuses a path that is not an app bundle rather than creating one', () => {
    const root = mkdtempSync(join(tmpdir(), 'joinery-marker-spec-'));
    temporaryDirectories.push(root);
    const notABundle = join(root, 'Joinery.app');

    expect(() => stampBundle(notABundle)).toThrow(/Contents\/Resources/);
    expect(existsSync(notABundle)).toBe(false);
  });
});

describe('bundleCarriesTestCapability', () => {
  it('is false for a bundle built by the release path', () => {
    expect(bundleCarriesTestCapability(makeBundle())).toBe(false);
  });

  it('is true once the marker is in Contents/Resources', () => {
    const appPath = makeBundle();
    writeFileSync(markerPathInBundle(appPath), 'anything\n');
    expect(bundleCarriesTestCapability(appPath)).toBe(true);
  });

  // A guard that passes when it cannot run is the vacuity `asar-inventory.ts --check` and
  // `verify-package.js` both refuse: a release check must not report "clean" for a bundle it never
  // looked at.
  it('throws rather than reporting a missing bundle as clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'joinery-marker-spec-'));
    temporaryDirectories.push(root);
    expect(() => bundleCarriesTestCapability(join(root, 'Joinery.app'))).toThrow(/no app bundle/);
  });
});

describe('parseArgs', () => {
  it('reports on the bundle package:dir writes when given nothing', () => {
    const parsed = parseArgs([]);
    expect(parsed.appPath).toMatch(/release\/mac-arm64\/Joinery\.app$/);
    expect(parsed.mode).toBe('report');
  });

  it('takes --stamp and --check with an explicit bundle path', () => {
    expect(parseArgs(['--stamp', '/tmp/Other.app'])).toEqual({
      appPath: '/tmp/Other.app',
      mode: 'stamp',
    });
    expect(parseArgs(['/tmp/Other.app', '--check'])).toEqual({
      appPath: '/tmp/Other.app',
      mode: 'check',
    });
  });

  it('rejects stamping and checking in one run', () => {
    expect(() => parseArgs(['--stamp', '--check'])).toThrow(/--stamp/);
  });

  it('rejects an unknown flag rather than treating it as a bundle path', () => {
    expect(() => parseArgs(['--force'])).toThrow(/--force/);
  });
});

/**
 * The marker filename is a literal in two places that cannot import each other: this script runs
 * under Node's type stripping, and the main process is bundled as CommonJS out of
 * `packages/main/src`. Drift in the dangerous direction is silent — the app would honour a marker
 * the release guard no longer looks for — so it is asserted rather than remembered, the same way
 * `keychain-service-isolation.spec.ts` holds the duplicated test keychain service name.
 */
describe('the marker filename', () => {
  it('is the same literal the main process reads', () => {
    const reader = readFileSync(join(REPO_ROOT, MAIN_PROCESS_READER), 'utf8');
    expect(reader).toContain(`'${TEST_BUILD_MARKER_FILENAME}'`);
  });
});
