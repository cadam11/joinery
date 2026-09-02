/**
 * Credential Store - Securely stores passwords in macOS Keychain
 * Uses a single JSON blob to minimize keychain access (only once at startup)
 */

import * as keytar from 'keytar';
import { app, type App } from 'electron';
import { type KeychainStatus } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { resolveKeychainServiceName } from './service-name';

const log = createLogger('CredentialStore');

const CREDENTIALS_KEY = 'credentials-vault';

interface CredentialsVault {
  [key: string]: string;
}

/** What an availability listener is handed. Availability state only — never a credential. */
export type KeychainStatusListener = (status: KeychainStatus) => void;

export class CredentialStore extends BaseSingleton {
  /**
   * The Keychain service every entry below lives under, resolved once per instance in the
   * constructor (J-96, J-161). Read here and nowhere else, so a test launcher can repoint the
   * whole store at a throwaway namespace by setting one variable before Electron starts.
   */
  private readonly serviceName: string;
  // In-memory cache - all credentials loaded from single keychain entry
  private cache: Map<string, string> = new Map();
  private cacheLoaded = false;
  private keychainAvailable = true;
  /** In-flight load, so concurrent callers share one keychain read. */
  private loadInFlight: Promise<void> | null = null;
  /**
   * Who wants to be told when the keychain stops working. The IPC layer subscribes here
   * rather than polling or reaching into this class's fields (J-118).
   */
  private statusListeners: Set<KeychainStatusListener> = new Set();

  constructor() {
    super();
    // Both ambient reads that decide which vault this process touches are here, at the call
    // site, and the decision itself is a pure function (J-161) — the packaged branch is
    // unreachable from a unit test, so it has to be provable somewhere.
    //
    // `app` is typed non-optional and inside Electron it is. Under vitest the `electron`
    // specifier resolves to the npm shim, whose export is the binary's PATH rather than the API,
    // so the binding really is undefined; a bare `app.isPackaged` here fails 63 unit tests
    // across 8 files, because the setup file pulls this class in through the connection pool.
    // Absent Electron means not a shipped app, which is the same answer `isPackaged: false` is.
    const electronApp: App | undefined = app;
    const resolution = resolveKeychainServiceName({
      isPackaged: electronApp?.isPackaged === true,
      env: process.env,
    });
    if (resolution.warning !== undefined) log.warn(resolution.warning);
    this.serviceName = resolution.serviceName;
  }

  /**
   * Load all credentials from keychain into memory cache. Startup kicks this
   * off without awaiting (window creation is no longer gated on the
   * keychain); every accessor awaits it internally, and concurrent calls
   * coalesce onto a single keychain read.
   */
  loadAllIntoCache(): Promise<void> {
    if (this.cacheLoaded) return Promise.resolve();
    if (this.loadInFlight) return this.loadInFlight;

    this.loadInFlight = this.loadVault().finally(() => {
      this.loadInFlight = null;
    });
    return this.loadInFlight;
  }

  private async loadVault(): Promise<void> {
    log.info('Loading credentials vault from keychain...');
    try {
      // First, try to load the new single-entry vault
      const vaultJson = await keytar.getPassword(this.serviceName, CREDENTIALS_KEY);

      if (vaultJson) {
        // Parse the JSON vault
        const vault: CredentialsVault = JSON.parse(vaultJson);
        for (const [key, value] of Object.entries(vault)) {
          this.cache.set(key, value);
        }
        log.info(`Loaded ${this.cache.size} credentials from vault`);
      } else {
        // Migration: Check for old individual entries and migrate them
        log.info('No vault found, checking for legacy credentials...');
        const legacyCredentials = await keytar.findCredentials(this.serviceName);
        const nonVaultCredentials = legacyCredentials.filter(c => c.account !== CREDENTIALS_KEY);

        if (nonVaultCredentials.length > 0) {
          log.info(`Migrating ${nonVaultCredentials.length} legacy credentials...`);
          for (const cred of nonVaultCredentials) {
            this.cache.set(cred.account, cred.password);
          }
          // Save to new vault format
          await this.saveVault();
          // Clean up old individual entries
          for (const cred of nonVaultCredentials) {
            await keytar.deletePassword(this.serviceName, cred.account);
          }
          log.info('Migration complete');
        }
      }

      this.cacheLoaded = true;
    } catch (error) {
      // Keychain access denied or unavailable - app will continue without saved credentials,
      // and the status bar says so for the rest of the session (J-118).
      this.markKeychainUnavailable();
      this.cacheLoaded = true;
      log.warn(
        'Keychain access unavailable - saved credentials will not be loaded. Grant keychain access to enable credential storage.'
      );
      log.debug('Keychain error details:', error);
    }
  }

  /**
   * Save the entire vault to keychain (debounced to batch rapid updates)
   */
  private async saveVault(): Promise<void> {
    const vault: CredentialsVault = Object.fromEntries(this.cache);
    const vaultJson = JSON.stringify(vault);
    await keytar.setPassword(this.serviceName, CREDENTIALS_KEY, vaultJson);
    log.debug(`Saved vault with ${this.cache.size} credentials`);
  }

  /**
   * Store a password for a connection
   */
  async set(connectionId: string, password: string): Promise<void> {
    log.debug(`Storing password for: ${connectionId}`);
    try {
      // Ensure cache is loaded first
      if (!this.cacheLoaded) {
        await this.loadAllIntoCache();
      }

      // Update cache (always store in memory even if keychain is unavailable)
      this.cache.set(connectionId, password);

      // Only attempt to persist if keychain is available
      if (this.keychainAvailable) {
        await this.saveVault();
        log.debug(`Stored password for: ${connectionId}`);
      } else {
        log.warn(`Password cached in memory for: ${connectionId} (keychain unavailable)`);
      }
    } catch (error) {
      // Keychain became unavailable - mark it and keep in memory cache
      this.markKeychainUnavailable();
      log.warn(
        `Failed to persist credential for ${connectionId} - keychain access denied. Cached in memory for this session.`
      );
      log.debug('Keychain error details:', error);
    }
  }

  /**
   * Retrieve a password for a connection (uses cache after initial load)
   */
  async get(connectionId: string): Promise<string | null> {
    // Ensure cache is loaded
    if (!this.cacheLoaded) {
      await this.loadAllIntoCache();
    }

    // Return from cache
    const cached = this.cache.get(connectionId);
    if (cached !== undefined) {
      log.debug(`Cache hit for: ${connectionId}`);
      return cached;
    }

    log.debug(`Cache miss for: ${connectionId}`);
    return null;
  }

  /**
   * Delete a password for a connection
   */
  async delete(connectionId: string): Promise<boolean> {
    try {
      // Ensure cache is loaded first
      if (!this.cacheLoaded) {
        await this.loadAllIntoCache();
      }

      // Remove from cache
      const existed = this.cache.has(connectionId);
      this.cache.delete(connectionId);

      // Save updated vault to keychain (only if available)
      if (existed && this.keychainAvailable) {
        await this.saveVault();
      }

      return existed;
    } catch (error) {
      // Keychain became unavailable - still removed from memory cache
      this.markKeychainUnavailable();
      log.warn('Failed to persist deletion - keychain unavailable');
      log.debug('Keychain error details:', error);
      return true; // Still removed from memory
    }
  }

  /**
   * Check if keychain access is available
   */
  isKeychainAvailable(): boolean {
    return this.keychainAvailable;
  }

  /**
   * Subscribe to availability changes; returns the unsubscribe.
   *
   * Only the degradation edge is ever emitted, and only once per session — see
   * {@link markKeychainUnavailable}. Callers that mount after the edge has already passed
   * must read {@link isKeychainAvailable} instead of waiting for an event.
   */
  onStatusChanged(listener: KeychainStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Record that the keychain has stopped working, and tell subscribers once.
   *
   * Idempotent by design: every later failure in the same session finds the flag already
   * down and emits nothing, so a renderer cannot be woken per failed write.
   */
  private markKeychainUnavailable(): void {
    if (!this.keychainAvailable) return;
    this.keychainAvailable = false;

    const status: KeychainStatus = { available: false };
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        // A broken listener must not take the credential path down with it, but it is a
        // real defect, so it is logged rather than dropped.
        log.warn('A keychain status listener threw; continuing without it');
        log.debug('Keychain status listener error:', error);
      }
    }
  }

  /**
   * Find all stored credentials for this app (uses cache after initial load)
   */
  async findAll(): Promise<Array<{ account: string; password: string }>> {
    // Ensure cache is loaded
    if (!this.cacheLoaded) {
      await this.loadAllIntoCache();
    }

    // Return from cache
    return Array.from(this.cache.entries()).map(([account, password]) => ({
      account,
      password,
    }));
  }
}
