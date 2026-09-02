/**
 * The one place the macOS Keychain service name is decided (J-96, gated by J-161).
 *
 * `CredentialStore` keeps every saved password — connection credentials and AI provider keys —
 * in a single Keychain item under this service. That item belongs to the INSTALLED app, and
 * until this module existed the name was a hard-coded constant, so anything that booted the
 * built app read and rewrote it: the Playwright tiers give each launch a fresh `userData` dir,
 * but the login keychain is not namespaced by it. A spec could therefore clobber a developer's
 * real credentials, leave its own behind, or — the case that prompted the ticket — flip the
 * renderer's `apiKeyConfigured` gate and reach a REAL, billed API key that had been saved on
 * that machine, all while staying green.
 *
 * The override is read in the main process only and never crosses the IPC boundary; the
 * renderer has no business knowing which vault it is talking to. And it is honoured only while
 * the app is UNPACKAGED — see {@link KeychainServiceRuntime.isPackaged} — or while a packaged
 * bundle carries the build-time test marker, see {@link KeychainServiceRuntime.isTestBuild}.
 *
 * Both inputs are arguments, not ambient reads, so every branch below is provable in the unit
 * tier: a spec cannot make itself a packaged Electron app, and this is the one decision where
 * the untestable branch is the one that protects real credentials.
 */

import { APP_ID } from '@joinery/shared';

/**
 * Environment variable that repoints the credential store at a throwaway Keychain service.
 *
 * Set by every launcher in `tests/` (guarded structurally by
 * `keychain-service-isolation.spec.ts`) — the Playwright/perf ones run the app unpackaged, and
 * `scripts/release/smoke-packaged-app.ts` runs a bundle stamped as a test build. Nothing sets it
 * in a shipped app, and a packaged RELEASE app refuses it even if something does, so production
 * resolves {@link APP_ID} exactly as it always did.
 */
export const KEYCHAIN_SERVICE_ENV_VAR = 'JOINERY_KEYCHAIN_SERVICE';

/** What the resolver needs to know about the process asking. */
export interface KeychainServiceRuntime {
  /**
   * Electron's `app.isPackaged` — true inside a shipped `Joinery.app`, false when the app runs
   * from `node_modules/electron` (dev, and every Playwright/perf launcher).
   *
   * A packaged Joinery is the signed binary the user has already trusted with their Keychain,
   * so it is Joinery that raises the "allow access?" prompt. Letting the environment aim it at
   * an arbitrary service name therefore borrows that trust to read items Joinery has no
   * business touching — and `credential-store.ts`'s legacy-credential migration would copy and
   * then DELETE whatever it found there. Unpackaged builds keep the override because that is
   * the only way the Electron test tiers can stay out of the developer's real vault.
   */
  isPackaged: boolean;
  /**
   * Whether the BUNDLE was built for testing — `isTestCapableBuild()` from
   * `../../utils/test-build-capability` (J-167).
   *
   * The one way back into the override for a packaged app, and it exists because
   * `scripts/release/smoke-packaged-app.ts` boots a real `Joinery.app` and must not boot it
   * against the developer's real vault, where this store's legacy migration copies and then
   * DELETES what it finds. The capability is a file the packaging step writes into a test bundle
   * (`Contents/Resources/joinery-test-build`) and nothing writes into a release bundle, so it is
   * not something a process environment can forge — which a second environment variable would
   * have been, leaving the hole open while the code read as fixed.
   *
   * Optional, and absent means `false`: a call site that forgets it refuses the override, which is
   * the safe direction to fail in.
   */
  isTestBuild?: boolean;
  /** The environment to read the override from. Passed in; never read from `process` here. */
  env: NodeJS.ProcessEnv;
}

/** The decision, plus anything the caller is obliged to say out loud about it. */
export interface KeychainServiceResolution {
  /** The Keychain service name to use. */
  serviceName: string;
  /**
   * Present only when an override was refused. The caller MUST log it: a refused override means
   * something aimed a shipped app at another vault, which is worth a line in the Output panel
   * even though the app carries on correctly. Carries no service name, by the same rule that
   * keeps credentials out of logs.
   */
  warning?: string;
}

/**
 * Resolve the Keychain service name for a process.
 *
 * Pure: the only inputs are the two fields of {@link KeychainServiceRuntime}.
 *
 * @throws if a process that is ALLOWED the override (unpackaged, or a packaged test build) sets
 *   it to a blank value — see below.
 */
export function resolveKeychainServiceName(
  runtime: KeychainServiceRuntime
): KeychainServiceResolution {
  const raw = runtime.env[KEYCHAIN_SERVICE_ENV_VAR];
  if (raw === undefined) return { serviceName: APP_ID };

  if (runtime.isPackaged && runtime.isTestBuild !== true) {
    // Refused, not obeyed, and not fatal: a user whose shell exports this variable must still
    // get a working app pointed at their own vault. Blank or not makes no difference here —
    // nothing about the value is used.
    return {
      serviceName: APP_ID,
      warning:
        `${KEYCHAIN_SERVICE_ENV_VAR} is set, but a packaged Joinery ignores it and uses its ` +
        `own keychain service. It is honoured only in unpackaged (development and test) ` +
        `builds. Unset it to silence this warning.`,
    };
  }

  const serviceName = raw.trim();
  if (serviceName.length === 0) {
    // Deliberately not a fall-back to the default: a caller that set the variable believes it is
    // isolated, and quietly handing it the production vault is the exact accident this module
    // exists to prevent. Nothing but a misconfigured launcher can reach this line.
    throw new Error(
      `${KEYCHAIN_SERVICE_ENV_VAR} is set but blank. Unset it to use the default keychain ` +
        `service, or give it a non-blank name.`
    );
  }
  return { serviceName };
}
