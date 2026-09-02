import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TEST_BUILD_MARKER_FILENAME,
  TEST_BUILD_WARNING,
  isTestCapableBuild,
} from './test-build-capability';

/**
 * The main process's half of the build-time test capability (J-167).
 *
 * Asserted against a real directory rather than a mocked `fs`: the claim is "this file is in this
 * build's `Contents/Resources`", so faking the file system would fake the claim. A vitest process
 * has no `process.resourcesPath` at all, which is itself one of the branches below.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function makeResourcesDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'joinery-capability-spec-'));
  temporaryDirectories.push(root);
  const resources = join(root, 'Resources');
  mkdirSync(resources);
  return resources;
}

describe('isTestCapableBuild', () => {
  it('is false for a release build — its resources carry no marker', () => {
    expect(isTestCapableBuild(makeResourcesDir())).toBe(false);
  });

  it('is true for a build the packaging step stamped', () => {
    const resources = makeResourcesDir();
    writeFileSync(join(resources, TEST_BUILD_MARKER_FILENAME), 'stamped\n');
    expect(isTestCapableBuild(resources)).toBe(true);
  });

  // The capability is a property of the ARTIFACT. Nothing in the environment appears above, and
  // that is the entire point of J-167: J-161 refuses `JOINERY_KEYCHAIN_SERVICE` in a packaged app
  // because an environment variable that changes what a signed build does is a hole, so the hatch
  // that reopens it must not be one either.
  it('reads no environment variable', () => {
    const resources = makeResourcesDir();
    process.env.JOINERY_TEST_BUILD = '1';
    try {
      expect(isTestCapableBuild(resources)).toBe(false);
    } finally {
      delete process.env.JOINERY_TEST_BUILD;
    }
  });

  // Outside Electron there is no `process.resourcesPath`, which is what every vitest and
  // Playwright process is. "No resources directory" is not a test-capable build, and answering
  // `false` is the same answer an unpackaged app needs.
  it('is false when the process has no resources directory', () => {
    expect(isTestCapableBuild(undefined)).toBe(false);
    expect(isTestCapableBuild('')).toBe(false);
    expect(isTestCapableBuild()).toBe(false);
  });
});

describe('TEST_BUILD_WARNING', () => {
  it('names the capability and says the build must not be distributed', () => {
    expect(TEST_BUILD_WARNING).toMatch(/test/i);
    expect(TEST_BUILD_WARNING).toMatch(/not be distributed/i);
  });
});
