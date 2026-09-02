import { describe, expect, it } from 'vitest';
import { APP_ID } from '@joinery/shared';
import { KEYCHAIN_SERVICE_ENV_VAR, resolveKeychainServiceName } from './service-name';

const OVERRIDE = 'ca.adam11.joinery.tests';

/** An unpackaged (dev / test-launcher) process with the given environment. */
function unpackaged(env: NodeJS.ProcessEnv = {}) {
  return resolveKeychainServiceName({ isPackaged: false, env });
}

/** A packaged, shipped `Joinery.app` with the given environment — a RELEASE bundle. */
function packaged(env: NodeJS.ProcessEnv = {}) {
  return resolveKeychainServiceName({ isPackaged: true, isTestBuild: false, env });
}

/**
 * A packaged bundle stamped as a TEST build (J-167): `pnpm run package:test` writes
 * `Contents/Resources/joinery-test-build` into it, and `pnpm run verify:package` fails on a release
 * artifact that carries it. This is the only packaged shape that gets the override back.
 */
function packagedTestBuild(env: NodeJS.ProcessEnv = {}) {
  return resolveKeychainServiceName({ isPackaged: true, isTestBuild: true, env });
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
 *
 * J-167 adds the third case: a packaged bundle that carries the build-time test-capability marker
 * honours the override again, because `scripts/release/smoke-packaged-app.ts` boots a real bundle
 * and must not boot it against the developer's production vault. That capability is a property of
 * the artifact, not of the environment — a second environment variable would have reopened the
 * hole, since whoever can set one can set two.
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

    // The default, spelled out: a runtime that says nothing about the marker is not a test build.
    // The field is optional so a call site that forgets it fails CLOSED — it refuses the override
    // — rather than silently granting it.
    it('refuses the override when the runtime says nothing about the marker', () => {
      const resolution = resolveKeychainServiceName({
        isPackaged: true,
        env: { [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE },
      });

      expect(resolution.serviceName).toBe(APP_ID);
      expect(resolution.warning).toContain(KEYCHAIN_SERVICE_ENV_VAR);
    });
  });

  describe('packaged, stamped as a test build (J-167)', () => {
    it('honours the override — this is the whole point of the marker', () => {
      expect(packagedTestBuild({ [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE })).toEqual({
        serviceName: OVERRIDE,
      });
    });

    it('warns about nothing: the override was obeyed, so there is nothing to report', () => {
      expect(packagedTestBuild({ [KEYCHAIN_SERVICE_ENV_VAR]: OVERRIDE }).warning).toBeUndefined();
    });

    it('trims the override, exactly as an unpackaged process does', () => {
      expect(packagedTestBuild({ [KEYCHAIN_SERVICE_ENV_VAR]: `  ${OVERRIDE}\n` })).toEqual({
        serviceName: OVERRIDE,
      });
    });

    // Honouring the override means honouring the blank-is-a-bug rule with it. A stamped bundle is
    // only ever launched by our own smoke script, so a blank value there is a launcher bug that
    // must be loud — not a quiet fall-back to the production vault, which is the accident this
    // whole module exists to prevent.
    it.each(['', '   ', '\t\n'])(
      'rejects a blank override (%j) rather than falling back',
      blank => {
        expect(() => packagedTestBuild({ [KEYCHAIN_SERVICE_ENV_VAR]: blank })).toThrow(
          KEYCHAIN_SERVICE_ENV_VAR
        );
      }
    );

    it('still defaults to the application id when no override is set', () => {
      expect(packagedTestBuild({})).toEqual({ serviceName: APP_ID });
    });
  });
});
