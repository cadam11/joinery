/**
 * The pure half of `smoke-packaged-app.ts` (J-90 review, findings 5 and 6).
 *
 * The launch itself cannot be unit-tested — it needs a real macOS app bundle and a window server,
 * which is why `pnpm run smoke:package` exists as a command rather than a tier. What CAN be
 * asserted is everything the launcher decides BEFORE it spawns anything: where the executable is,
 * and what the product is called. Both were wrong-by-construction before this file: the bundle's
 * executable name was the literal `Joinery`, so a `productName` change in `electron-builder.yml`
 * would have failed with "no packaged app at …" pointing at a path that never existed.
 *
 * Keychain hermeticity is NOT asserted here. It is asserted structurally, against this file's
 * source, by `packages/main/src/services/keychain/keychain-service-isolation.spec.ts` — which is
 * the right place for it, because no assertion inside this process can observe which Keychain
 * namespace a launched Electron picked.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertBundleIsTestCapable,
  executableInBundle,
  parseArgs,
  productNameFromConfig,
} from './smoke-packaged-app';
import { stampBundle } from './test-build-marker.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('productNameFromConfig', () => {
  it('reads the product name electron-builder names the executable after', () => {
    expect(productNameFromConfig('appId: ca.adam11.joinery\nproductName: Joinery\n')).toBe(
      'Joinery'
    );
  });

  it('reads the real electron-builder.yml, so a rename cannot leave this launcher behind', () => {
    const config = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
    expect(productNameFromConfig(config)).toBe('Joinery');
  });

  it('throws rather than guessing when the config declares no product name', () => {
    expect(() => productNameFromConfig('appId: ca.adam11.joinery\n')).toThrow(/productName/);
  });
});

describe('executableInBundle', () => {
  it('points at the binary inside a macOS bundle, named after the product', () => {
    expect(executableInBundle('/tmp/Joinery.app', 'Joinery')).toBe(
      '/tmp/Joinery.app/Contents/MacOS/Joinery'
    );
  });

  it('follows a renamed product rather than the hardcoded name it used to assume', () => {
    expect(executableInBundle('/tmp/Cabinet.app', 'Cabinet')).toBe(
      '/tmp/Cabinet.app/Contents/MacOS/Cabinet'
    );
  });
});

describe('parseArgs', () => {
  it('defaults to the arm64 bundle package:dir writes, window hidden', () => {
    const parsed = parseArgs([]);
    expect(parsed.appPath).toMatch(/release\/mac-arm64\/Joinery\.app$/);
    expect(parsed.show).toBe(false);
  });

  it('takes a bundle path and the --show opt-in', () => {
    const parsed = parseArgs(['/tmp/Other.app', '--show']);
    expect(parsed.appPath).toBe('/tmp/Other.app');
    expect(parsed.show).toBe(true);
  });

  it('rejects an unknown flag rather than treating it as a path', () => {
    expect(() => parseArgs(['--visible'])).toThrow(/--visible/);
  });
});

/**
 * The pre-launch refusal (J-167).
 *
 * This replaced a hand-maintained `PACKAGED_APP_HONOURS_KEYCHAIN_OVERRIDE` constant, which existed
 * only because there was nothing observable to read: what had to be known was another process's
 * resolver, and booting the app to find out is the very act that had to be prevented. The
 * build-time marker is that observable thing, so the refusal is now a fact about the bundle in
 * front of it rather than a fact somebody had to remember to update.
 */
describe('assertBundleIsTestCapable', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeBundle(): string {
    const root = mkdtempSync(join(tmpdir(), 'joinery-smoke-spec-'));
    temporaryDirectories.push(root);
    const appPath = join(root, 'Joinery.app');
    mkdirSync(join(appPath, 'Contents', 'Resources'), { recursive: true });
    return appPath;
  }

  it('refuses a bundle the release path built', () => {
    // The refusal has to happen BEFORE the launch: the writes it prevents happen during
    // `whenReady`, so a check that ran once a window existed would be too late.
    expect(() => assertBundleIsTestCapable(makeBundle())).toThrow(/test capability/i);
  });

  it('names the command that builds a bundle it would accept', () => {
    expect(() => assertBundleIsTestCapable(makeBundle())).toThrow(/package:test/);
  });

  it('lets the launch proceed for a bundle stamped with the test capability', () => {
    const appPath = makeBundle();
    stampBundle(appPath);
    expect(() => assertBundleIsTestCapable(appPath)).not.toThrow();
  });
});
