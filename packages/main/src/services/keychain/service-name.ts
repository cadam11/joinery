/**
 * The one place the macOS Keychain service name is decided (J-96).
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
 * renderer has no business knowing which vault it is talking to.
 */

import { APP_ID } from '@joinery/shared';

/**
 * Environment variable that repoints the credential store at a throwaway Keychain service.
 *
 * Set by every launcher in `tests/` (guarded structurally by
 * `keychain-service-isolation.spec.ts`). Nothing sets it in a shipped app, so production
 * resolves {@link APP_ID} exactly as it always did.
 */
export const KEYCHAIN_SERVICE_ENV_VAR = 'JOINERY_KEYCHAIN_SERVICE';

/**
 * Resolve the Keychain service name for this process.
 *
 * @param env the environment to read; defaults to the process's own.
 * @throws if the override is present but blank — see below.
 */
export function resolveKeychainServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[KEYCHAIN_SERVICE_ENV_VAR];
  if (raw === undefined) return APP_ID;

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
  return serviceName;
}
