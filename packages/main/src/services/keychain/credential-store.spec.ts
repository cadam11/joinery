import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ID, type KeychainStatus, type LogEntry } from '@joinery/shared';
// Resolved to packages/main/src/__mocks__/keytar.ts via the vitest alias.
import * as keytar from 'keytar';
// Namespace import because `vi.spyOn` needs an object to patch; the store's own import style does
// not matter (CommonJS makes a named import the same property read), so the seam this drives is
// the call itself, not the import form (J-161).
import * as runtimeMode from '../../utils/runtime-mode';
// Same seam, same reason, for the other half of the packaged decision (J-167): whether the BUNDLE
// was stamped as a test build. Real production module — `isTestCapableBuild` reads
// `process.resourcesPath`, which is undefined in a vitest process, so it answers `false` here
// unless a spec says otherwise.
import * as testBuildCapability from '../../utils/test-build-capability';
import { onLogEntry } from '../../utils/logger';
import { CredentialStore } from './credential-store';
import { KEYCHAIN_SERVICE_ENV_VAR } from './service-name';

describe('CredentialStore cache loading', () => {
  let getPasswordSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    CredentialStore.resetInstance();
    await keytar.setPassword('svc', 'credentials-vault', JSON.stringify({ 'conn-1': 'secret' }));
    getPasswordSpy = vi.spyOn(keytar, 'getPassword').mockImplementation(async () => {
      // Simulate a slow keychain so concurrent loads overlap.
      await new Promise(resolve => setTimeout(resolve, 20));
      return JSON.stringify({ 'conn-1': 'secret' });
    });
  });

  afterEach(() => {
    getPasswordSpy.mockRestore();
  });

  it('deduplicates concurrent loadAllIntoCache calls into one keychain read', async () => {
    const store = CredentialStore.getInstance();

    await Promise.all([store.loadAllIntoCache(), store.loadAllIntoCache(), store.get('conn-1')]);

    expect(getPasswordSpy).toHaveBeenCalledTimes(1);
  });

  it('get() self-loads when startup did not await the cache', async () => {
    const store = CredentialStore.getInstance();

    const password = await store.get('conn-1');

    expect(password).toBe('secret');
    expect(getPasswordSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The degrade paths (J-118). Until this ticket the three catches below flipped a private flag
 * that nothing could observe, so the app carried on with memory-only credentials and the user's
 * account of it was "my passwords keep disappearing".
 */
describe('CredentialStore keychain degradation', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  /** Every status a subscriber was handed, in order. */
  function recordStatuses(store: CredentialStore): KeychainStatus[] {
    const seen: KeychainStatus[] = [];
    store.onStatusChanged(status => seen.push(status));
    return seen;
  }

  beforeEach(async () => {
    CredentialStore.resetInstance();
    await keytar.setPassword('svc', 'credentials-vault', JSON.stringify({ 'conn-1': 'secret' }));
  });

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
  });

  it('starts available, and stays available while the keychain answers', async () => {
    const store = CredentialStore.getInstance();
    const seen = recordStatuses(store);

    await store.loadAllIntoCache();
    await store.set('conn-2', 'another-secret');

    expect(store.isKeychainAvailable()).toBe(true);
    expect(seen).toEqual([]);
  });

  it('a refused startup read degrades the store and tells subscribers once', async () => {
    spies.push(
      vi
        .spyOn(keytar, 'getPassword')
        .mockRejectedValue(new Error('User interaction is not allowed'))
    );
    const store = CredentialStore.getInstance();
    const seen = recordStatuses(store);

    await store.loadAllIntoCache();

    expect(store.isKeychainAvailable()).toBe(false);
    expect(seen).toEqual([{ available: false }]);
  });

  it('a failed write degrades mid-session and keeps the password in memory', async () => {
    spies.push(vi.spyOn(keytar, 'setPassword').mockRejectedValue(new Error('keychain is locked')));
    const store = CredentialStore.getInstance();
    const seen = recordStatuses(store);

    await store.set('conn-2', 'another-secret');

    expect(store.isKeychainAvailable()).toBe(false);
    expect(seen).toEqual([{ available: false }]);
    // The whole reason the app degrades rather than failing: this session still works.
    expect(await store.get('conn-2')).toBe('another-secret');
  });

  it('a failed delete degrades, and still reports the entry as removed', async () => {
    const store = CredentialStore.getInstance();
    await store.loadAllIntoCache();
    spies.push(vi.spyOn(keytar, 'setPassword').mockRejectedValue(new Error('keychain is locked')));
    const seen = recordStatuses(store);

    const existed = await store.delete('conn-1');

    expect(existed).toBe(true);
    expect(store.isKeychainAvailable()).toBe(false);
    expect(seen).toEqual([{ available: false }]);
  });

  it('emits the degradation edge once, however many later writes fail', async () => {
    spies.push(vi.spyOn(keytar, 'setPassword').mockRejectedValue(new Error('keychain is locked')));
    const store = CredentialStore.getInstance();
    const seen = recordStatuses(store);

    await store.set('conn-2', 'a');
    await store.set('conn-3', 'b');
    await store.set('conn-4', 'c');

    expect(seen).toHaveLength(1);
  });

  it('carries availability and nothing else — no credential rides along', async () => {
    spies.push(vi.spyOn(keytar, 'setPassword').mockRejectedValue(new Error('keychain is locked')));
    const store = CredentialStore.getInstance();
    const seen = recordStatuses(store);

    await store.set('conn-2', 'super-secret-value');

    expect(Object.keys(seen[0])).toEqual(['available']);
    expect(JSON.stringify(seen)).not.toContain('super-secret-value');
    expect(JSON.stringify(seen)).not.toContain('conn-2');
  });

  it('stops delivering to a listener that has unsubscribed', async () => {
    spies.push(vi.spyOn(keytar, 'setPassword').mockRejectedValue(new Error('keychain is locked')));
    const store = CredentialStore.getInstance();
    const seen: KeychainStatus[] = [];
    const unsubscribe = store.onStatusChanged(status => seen.push(status));

    unsubscribe();
    await store.set('conn-2', 'another-secret');

    expect(store.isKeychainAvailable()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('keeps degrading even when a listener throws', async () => {
    spies.push(vi.spyOn(keytar, 'setPassword').mockRejectedValue(new Error('keychain is locked')));
    const store = CredentialStore.getInstance();
    store.onStatusChanged(() => {
      throw new Error('a broken subscriber');
    });
    const seen = recordStatuses(store);

    await store.set('conn-2', 'another-secret');

    expect(store.isKeychainAvailable()).toBe(false);
    expect(seen).toEqual([{ available: false }]);
  });
});

/**
 * Which Keychain service the vault actually lands in (J-96).
 *
 * The resolver is unit-tested next door; these two assert the WIRING — that the store reads it
 * once per instance and hands the result to every keytar call — because a resolver nothing calls
 * would leave the E2E tiers writing to the developer's real vault while looking fixed.
 */
describe('CredentialStore keychain service name', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  /** Spies whose signatures differ from the keytar ones above, restored the same way. */
  const otherSpies: { mockRestore(): void }[] = [];
  let previousOverride: string | undefined;

  beforeEach(() => {
    previousOverride = process.env[KEYCHAIN_SERVICE_ENV_VAR];
    delete process.env[KEYCHAIN_SERVICE_ENV_VAR];
    CredentialStore.resetInstance();
  });

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
    while (otherSpies.length > 0) otherSpies.pop()?.mockRestore();
    if (previousOverride === undefined) delete process.env[KEYCHAIN_SERVICE_ENV_VAR];
    else process.env[KEYCHAIN_SERVICE_ENV_VAR] = previousOverride;
  });

  /** The service name every keytar call in one `set()` round trip was given. */
  async function servicesTouchedByASet(): Promise<string[]> {
    const getPassword = vi.spyOn(keytar, 'getPassword').mockResolvedValue(null);
    const findCredentials = vi.spyOn(keytar, 'findCredentials').mockResolvedValue([]);
    const setPassword = vi.spyOn(keytar, 'setPassword').mockResolvedValue(undefined);
    spies.push(getPassword, findCredentials, setPassword);

    await CredentialStore.getInstance().set('conn-1', 'secret');

    return [
      ...getPassword.mock.calls.map(call => call[0] as string),
      ...findCredentials.mock.calls.map(call => call[0] as string),
      ...setPassword.mock.calls.map(call => call[0] as string),
    ];
  }

  it('uses the application id when nothing overrides it', async () => {
    const services = await servicesTouchedByASet();

    expect(services.length).toBeGreaterThan(0);
    expect(new Set(services)).toEqual(new Set([APP_ID]));
  });

  it('uses the override when JOINERY_KEYCHAIN_SERVICE is set', async () => {
    process.env[KEYCHAIN_SERVICE_ENV_VAR] = 'ca.adam11.joinery.tests';

    const services = await servicesTouchedByASet();

    expect(services.length).toBeGreaterThan(0);
    expect(new Set(services)).toEqual(new Set(['ca.adam11.joinery.tests']));
  });

  /**
   * The packaged half of the same wiring (J-161).
   *
   * These exist because hard-coding `isPackaged: false` at the call site — i.e. turning the whole
   * security fix off — left all 3502 tests green: `app.isPackaged` cannot be faked in a vitest
   * process (there is no electron in one), so the resolver's proven packaged branch was reachable
   * by nothing. Making the signal a call through `runtimeMode` gives the spec the same seam the
   * repo already uses for `mysql.createPool` — a property read at call time — so the packaged
   * branch of the WIRING is now asserted rather than described in a report.
   */
  function pretendPackaged(): void {
    otherSpies.push(vi.spyOn(runtimeMode, 'isPackagedApp').mockReturnValue(true));
    CredentialStore.resetInstance();
  }

  /**
   * A packaged bundle stamped as a test build (J-167). Both signals are spied, because the store
   * must read BOTH at the call site: `isTestCapableBuild` alone would leave a release build
   * honouring nothing, and `isPackagedApp` alone is what J-161 already covers.
   */
  function pretendPackagedTestBuild(): void {
    otherSpies.push(vi.spyOn(runtimeMode, 'isPackagedApp').mockReturnValue(true));
    otherSpies.push(vi.spyOn(testBuildCapability, 'isTestCapableBuild').mockReturnValue(true));
    CredentialStore.resetInstance();
  }

  it('refuses the override and keeps the application id when the app is packaged', async () => {
    process.env[KEYCHAIN_SERVICE_ENV_VAR] = 'ca.adam11.joinery.tests';
    pretendPackaged();

    const services = await servicesTouchedByASet();

    expect(services.length).toBeGreaterThan(0);
    expect(new Set(services)).toEqual(new Set([APP_ID]));
  });

  it('says so through the main logger, naming neither service', async () => {
    const entries: LogEntry[] = [];
    const stopListening = onLogEntry(entry => entries.push(entry));
    try {
      process.env[KEYCHAIN_SERVICE_ENV_VAR] = 'ca.adam11.joinery.tests';
      pretendPackaged();
      await servicesTouchedByASet();
    } finally {
      stopListening();
    }

    const refusals = entries.filter(
      entry =>
        entry.level === 'warn' &&
        entry.tag === 'CredentialStore' &&
        entry.message.includes(KEYCHAIN_SERVICE_ENV_VAR)
    );

    expect(refusals).toHaveLength(1);
    expect(refusals[0].message).not.toContain(APP_ID);
    expect(refusals[0].message).not.toContain('ca.adam11.joinery.tests');
  });

  /**
   * The J-167 half of the wiring, and the mutation that makes it non-vacuous: hard-coding
   * `isTestBuild: true` at the call site passes this test and fails the release one above, while
   * hard-coding `false` passes that one and fails this. Only a real read of both signals satisfies
   * both, which is the property `scripts/release/smoke-packaged-app.ts` depends on to boot a real
   * bundle without touching the developer's production vault.
   */
  it('honours the override in a packaged bundle stamped as a test build', async () => {
    process.env[KEYCHAIN_SERVICE_ENV_VAR] = 'ca.adam11.joinery.tests';
    pretendPackagedTestBuild();

    const services = await servicesTouchedByASet();

    expect(services.length).toBeGreaterThan(0);
    expect(new Set(services)).toEqual(new Set(['ca.adam11.joinery.tests']));
  });

  it('logs no refusal when a test build obeys the override', async () => {
    const entries: LogEntry[] = [];
    const stopListening = onLogEntry(entry => entries.push(entry));
    try {
      process.env[KEYCHAIN_SERVICE_ENV_VAR] = 'ca.adam11.joinery.tests';
      pretendPackagedTestBuild();
      await servicesTouchedByASet();
    } finally {
      stopListening();
    }

    expect(entries.filter(entry => entry.message.includes(KEYCHAIN_SERVICE_ENV_VAR))).toEqual([]);
  });

  it('stays silent about the environment when nothing overrides the service', async () => {
    const entries: LogEntry[] = [];
    const stopListening = onLogEntry(entry => entries.push(entry));
    try {
      pretendPackaged();
      await servicesTouchedByASet();
    } finally {
      stopListening();
    }

    expect(entries.filter(entry => entry.message.includes(KEYCHAIN_SERVICE_ENV_VAR))).toEqual([]);
  });
});
