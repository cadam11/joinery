import { describe, expect, it } from 'vitest';
import { APP_ID } from '@joinery/shared';
import { KEYCHAIN_SERVICE_ENV_VAR, resolveKeychainServiceName } from './service-name';

/**
 * The resolver behind the one keychain service name (J-96).
 *
 * The override exists so the Playwright tiers stop sharing a Keychain namespace with the
 * installed app: before this, every E2E launch read and rewrote the developer's real
 * `ca.adam11.joinery` vault, which is how a seeded test could reach a real saved API key.
 * Production must be unaffected, so the default is asserted here as hard as the override is.
 */
describe('resolveKeychainServiceName', () => {
  it('defaults to the application id when the override is absent', () => {
    expect(resolveKeychainServiceName({})).toBe(APP_ID);
  });

  it('returns the override when one is set', () => {
    expect(
      resolveKeychainServiceName({ [KEYCHAIN_SERVICE_ENV_VAR]: 'ca.adam11.joinery.tests' })
    ).toBe('ca.adam11.joinery.tests');
  });

  it('trims surrounding whitespace off an override', () => {
    expect(
      resolveKeychainServiceName({ [KEYCHAIN_SERVICE_ENV_VAR]: '  ca.adam11.joinery.tests\n' })
    ).toBe('ca.adam11.joinery.tests');
  });

  // A blank override is a configuration bug in whatever set it. Falling back to the default
  // would silently hand the caller the PRODUCTION vault while it believed it was isolated —
  // the exact failure this resolver exists to prevent — so it is rejected loudly instead.
  it.each(['', '   ', '\t\n'])('rejects a blank override (%j) rather than falling back', blank => {
    expect(() => resolveKeychainServiceName({ [KEYCHAIN_SERVICE_ENV_VAR]: blank })).toThrow(
      KEYCHAIN_SERVICE_ENV_VAR
    );
  });

  it('reads the process environment when no environment is passed', () => {
    const previous = process.env[KEYCHAIN_SERVICE_ENV_VAR];
    process.env[KEYCHAIN_SERVICE_ENV_VAR] = 'ca.adam11.joinery.from-process-env';
    try {
      expect(resolveKeychainServiceName()).toBe('ca.adam11.joinery.from-process-env');
    } finally {
      if (previous === undefined) delete process.env[KEYCHAIN_SERVICE_ENV_VAR];
      else process.env[KEYCHAIN_SERVICE_ENV_VAR] = previous;
    }
  });
});
