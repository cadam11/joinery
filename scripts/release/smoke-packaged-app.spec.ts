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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertKeychainIsolationHolds,
  executableInBundle,
  parseArgs,
  productNameFromConfig,
} from './smoke-packaged-app';

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

describe('assertKeychainIsolationHolds', () => {
  it('lets the launch proceed while a packaged app still honours the override', () => {
    expect(() => assertKeychainIsolationHolds(true)).not.toThrow();
  });

  it('refuses to launch once a packaged app would ignore the override', () => {
    // The refusal has to happen BEFORE the launch: the writes it prevents happen during
    // `whenReady`, so a check that ran once a window existed would be too late.
    expect(() => assertKeychainIsolationHolds(false)).toThrow(/production Keychain/);
  });

  it('does not refuse today, because nothing in the current resolver consults isPackaged', () => {
    // This is the assertion that keeps `PACKAGED_APP_HONOURS_KEYCHAIN_OVERRIDE` honest, and it is
    // deliberately pointed at the OTHER process's resolver rather than at a comment. J-161 (PR
    // #113) makes `resolveKeychainServiceName` branch on `runtime.isPackaged` and refuse the
    // override in a packaged app; on the merged tree this test goes red, which is what forces
    // whoever lands it to flip the constant instead of remembering to.
    const resolver = readFileSync(
      join(REPO_ROOT, 'packages/main/src/services/keychain/service-name.ts'),
      'utf8'
    );
    expect(resolver).not.toContain('isPackaged');
    expect(() => assertKeychainIsolationHolds()).not.toThrow();
  });
});
