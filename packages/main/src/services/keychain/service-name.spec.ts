import { describe, expect, it } from 'vitest';
import { APP_ID } from '@joinery/shared';
import { KEYCHAIN_SERVICE_ENV_VAR, resolveKeychainServiceName } from './service-name';

const OVERRIDE = 'ca.adam11.joinery.tests';

/** An unpackaged (dev / test-launcher) process with the given environment. */
function unpackaged(env: NodeJS.ProcessEnv = {}) {
  return resolveKeychainServiceName({ isPackaged: false, env });
}

/** A packaged, shipped `Joinery.app` with the given environment. */
function packaged(env: NodeJS.ProcessEnv = {}) {
  return resolveKeychainServiceName({ isPackaged: true, env });
}

/**
 * The resolver behind the one keychain service name (J-96, gated by J-161).
 *
 * The override exists so the Playwright tiers stop sharing a Keychain namespace with the
 * installed app: before this, every E2E launch read and rewrote the developer's real
 * `ca.adam11.joinery` vault, which is how a seeded test could reach a real saved API key.
 * Production must be unaffected, so the default is asserted here as hard as the override is.
 *
 * J-161 adds the second half: a PACKAGED app refuses the override outright. Joinery is the
 * signed, user-trusted binary that raises the Keychain prompt, so honouring an env var there
 * lets anything that can set the process environment aim a trusted app at another service's
 * items — which `credential-store.ts`'s legacy-migration path would then copy and DELETE.
 * The resolver takes the packaged flag as an argument rather than reading Electron, so both
 * halves are provable in the unit tier.
 */
describe('resolveKeychainServiceName', () => {
  describe('unpackaged (dev, and every Electron test launcher)', () => {
    it('defaults to the application id when the override is absent', () => {
      expect(unpackaged({})).toEqual({ serviceName: APP_ID });
    });

    it('returns the override when one is set', () => {
      expect(unpackaged({ [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE })).toEqual({
        serviceName: OVERRIDE,
      });
    });

    it('trims surrounding whitespace off an override', () => {
      expect(unpackaged({ [KEYCHAIN_SERVICE_ENV_VAR]: `  ${OVERRIDE}\n` })).toEqual({
        serviceName: OVERRIDE,
      });
    });

    // A blank override is a configuration bug in whatever set it. Falling back to the default
    // would silently hand the caller the PRODUCTION vault while it believed it was isolated —
    // the exact failure this resolver exists to prevent — so it is rejected loudly instead.
    it.each(['', '   ', '\t\n'])(
      'rejects a blank override (%j) rather than falling back',
      blank => {
        expect(() => unpackaged({ [KEYCHAIN_SERVICE_ENV_VAR]: blank })).toThrow(
          KEYCHAIN_SERVICE_ENV_VAR
        );
      }
    );
  });

  describe('packaged (a shipped, signed Joinery.app)', () => {
    it('ignores an override and uses the application id', () => {
      expect(packaged({ [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE }).serviceName).toBe(APP_ID);
    });

    it('hands the caller a warning to log when it refuses an override', () => {
      const warning = packaged({ [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE }).warning;
      expect(warning).toContain(KEYCHAIN_SERVICE_ENV_VAR);
    });

    // Same rule as everywhere else in the credential path: nothing about the vault's identity
    // reaches a log line. Naming the attacker's chosen service, or the real one, would make the
    // log the map to what to attack next.
    it('names neither the refused override nor the production service in the warning', () => {
      const warning = packaged({ [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE }).warning ?? '';
      expect(warning).not.toContain(OVERRIDE);
      expect(warning).not.toContain(APP_ID);
    });

    // A blank override is a launcher bug when unpackaged, but in a shipped app it is just more
    // environment noise: refusing it is the whole point, and throwing would take startup down
    // for a user whose shell happens to export it.
    it.each(['', '   ', '\t\n'])('refuses a blank override (%j) without throwing', blank => {
      const resolution = packaged({ [KEYCHAIN_SERVICE_ENV_VAR]: blank });
      expect(resolution.serviceName).toBe(APP_ID);
      expect(resolution.warning).toContain(KEYCHAIN_SERVICE_ENV_VAR);
    });

    it('says nothing when no override is set — the normal case for every user', () => {
      expect(packaged({})).toEqual({ serviceName: APP_ID });
    });
  });
});
