/**
 * Entra ID (Azure AD) authentication for Azure SQL Database.
 *
 * Follows the vscode-mssql pattern (RFC 8252):
 * - MSAL Auth Code Grant with PKCE (S256)
 * - Loopback HTTP server on 127.0.0.1:0
 * - System browser via shell.openExternal
 *
 * Uses a Microsoft-owned well-known public client ID (SSMS/SqlClient),
 * so no OAuth app registration is required in the user's tenant.
 *
 * MSAL token cache is persisted to the macOS Keychain, so users
 * stay signed in across app restarts and get silent refresh.
 */

import * as http from 'http';
import { shell } from 'electron';
import {
  PublicClientApplication,
  CryptoProvider,
  LogLevel,
  type AuthenticationResult,
  type Configuration,
  type AccountInfo,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';
import { openExternalSafely } from '../../security/open-external';
import { createLogger } from '../../utils/logger';
import { CredentialStore } from '../keychain/credential-store';

const log = createLogger('EntraAuth');

const SQL_SCOPE = 'https://database.windows.net/user_impersonation';

// Azure CLI's public client ID — the canonical "borrowed" client for
// third-party Azure SQL tools. Pre-registered by Microsoft with:
//   - http://localhost as a redirect URI (root path, any port) — so the
//     loopback callback must target root, NOT /redirect or any other path;
//   - direct preauthorization for database.windows.net/user_impersonation,
//     so we can request the SQL scope in a single interactive step.
//
// Other candidates and why they don't work here:
//   - a94f9c62-97fe-4d19-b06d-472bed8d2bcf (SSMS): only oauth2/nativeclient
//     redirect, rejects localhost.
//   - a69788c6-1d43-44ed-9ca3-b83e194da255 (vscode-mssql): localhost
//     redirect works, but NOT preauthorized for Azure SQL directly;
//     vscode-mssql logs in with ARM scope and silently exchanges for SQL.
//
// Using Azure CLI's ID means no OAuth app registration in the user's tenant.
const DEFAULT_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

const AUTHORITY_BASE = 'https://login.microsoftonline.com';
// "organizations" = any work/school tenant; Azure SQL doesn't accept personal MSAs.
const DEFAULT_TENANT = 'organizations';

// Key used in the credential store for the MSAL token cache blob.
const CACHE_KEY = '__entra_msal_cache__';

const LOGIN_TIMEOUT_MS = 120_000;

export interface EntraAuthOptions {
  /** Tenant (directory) ID. Defaults to "organizations". */
  tenantId?: string;
  /** Override the client ID. Defaults to the SSMS well-known ID. */
  clientId?: string;
  /**
   * MSAL homeAccountId the caller already logged in with. Binds silent
   * refresh to a specific account so multiple profiles with different
   * Entra accounts don't cross-contaminate each other.
   */
  homeAccountId?: string;
}

export interface EntraAuthResult {
  accessToken: string;
  /** The MSAL homeAccountId — persist this per profile to pin future logins. */
  homeAccountId: string;
}

// Module-level cache: one MSAL client per (clientId, authority) pair.
// Reinstantiating would reset the token-cache plugin and miss silent refresh.
let msalClient: PublicClientApplication | null = null;
let cachedClientSignature: string | null = null;

function createKeychainCachePlugin(): ICachePlugin {
  const store = CredentialStore.getInstance();
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      const data = await store.get(CACHE_KEY);
      if (data) ctx.tokenCache.deserialize(data);
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (!ctx.cacheHasChanged) return;
      await store.set(CACHE_KEY, ctx.tokenCache.serialize());
    },
  };
}

function resolveClientId(opts: EntraAuthOptions): string {
  return opts.clientId && opts.clientId.length > 0 ? opts.clientId : DEFAULT_CLIENT_ID;
}

function resolveAuthority(opts: EntraAuthOptions): string {
  const tenant = opts.tenantId && opts.tenantId.length > 0 ? opts.tenantId : DEFAULT_TENANT;
  return `${AUTHORITY_BASE}/${tenant}`;
}

function getClient(opts: EntraAuthOptions): PublicClientApplication {
  const clientId = resolveClientId(opts);
  const authority = resolveAuthority(opts);
  const signature = `${clientId}|${authority}`;

  if (msalClient && cachedClientSignature === signature) {
    return msalClient;
  }

  const config: Configuration = {
    auth: { clientId, authority },
    cache: { cachePlugin: createKeychainCachePlugin() },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Warning,
        loggerCallback: (_level, message) => log.debug(`[MSAL] ${message}`),
      },
    },
  };

  msalClient = new PublicClientApplication(config);
  cachedClientSignature = signature;
  log.info(`MSAL client initialized (clientId=${clientId}, authority=${authority})`);
  return msalClient;
}

/**
 * Acquire an Azure SQL access token via Entra ID.
 * If opts.homeAccountId is provided, tries silent refresh for that specific
 * account first. Otherwise (or if silent refresh fails) opens the system
 * browser for interactive login. Returns both the token AND the account ID
 * so callers can persist it to the profile and pin future logins.
 */
export async function acquireTokenInteractive(
  opts: EntraAuthOptions = {}
): Promise<EntraAuthResult> {
  const client = getClient(opts);

  const silent = await trySilentToken(client, opts.homeAccountId);
  if (silent) return silent;

  const result = await interactiveLoginViaLoopback(client);
  if (!result.account) {
    throw new Error('MSAL returned no account from interactive login');
  }
  log.info(
    `Entra ID token acquired for ${result.account.username} (tenant=${result.account.tenantId}, expires=${result.expiresOn?.toISOString()})`
  );
  return {
    accessToken: result.accessToken,
    homeAccountId: result.account.homeAccountId,
  };
}

async function trySilentToken(
  client: PublicClientApplication,
  homeAccountId: string | undefined
): Promise<EntraAuthResult | null> {
  if (!homeAccountId) return null;

  const account = await findAccount(client, homeAccountId);
  if (!account) {
    log.info(`No cached MSAL account matches homeAccountId=${homeAccountId}`);
    return null;
  }

  try {
    const result = await client.acquireTokenSilent({
      scopes: [SQL_SCOPE],
      account,
    });
    if (!result?.accessToken) return null;
    log.info(`Entra ID token refreshed silently for ${account.username}`);
    return { accessToken: result.accessToken, homeAccountId: account.homeAccountId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`Silent token refresh failed (${msg}), falling back to interactive`);
    return null;
  }
}

async function findAccount(
  client: PublicClientApplication,
  homeAccountId: string
): Promise<AccountInfo | null> {
  const cache = client.getTokenCache();
  const direct = await cache.getAccountByHomeId(homeAccountId);
  if (direct) return direct;
  const all = await cache.getAllAccounts();
  return all.find(a => a.homeAccountId === homeAccountId) ?? null;
}

/**
 * Interactive login using a loopback HTTP server (RFC 8252).
 * - Binds to 127.0.0.1 on a random free port.
 * - Opens the MS login URL in the user's system browser.
 * - MS redirects back to http://localhost:{port} (root) with ?code and ?state.
 */
async function interactiveLoginViaLoopback(
  client: PublicClientApplication
): Promise<AuthenticationResult> {
  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const nonce = crypto.createNewGuid();

  const { server, port } = await startLoopbackServer();
  // Azure CLI's registration only accepts http://localhost:<port> (root path,
  // any port). Adding /redirect or similar triggers AADSTS50011.
  const redirectUri = `http://localhost:${port}`;
  log.info(`Loopback server listening at ${redirectUri}`);

  try {
    const codePromise = waitForRedirect(server, nonce);

    const authCodeUrl = await client.getAuthCodeUrl({
      scopes: [SQL_SCOPE],
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state: nonce,
      prompt: 'select_account',
    });

    // MSAL builds this from the configured authority, so it is https today — but "today" is a
    // property of a dependency's behaviour, not of this code, and it is the one URL here that is
    // not a literal. It goes through the same allowlist as everything else (J-129).
    await openExternalSafely(authCodeUrl, shell.openExternal);
    const code = await codePromise;

    const result = await client.acquireTokenByCode({
      code,
      scopes: [SQL_SCOPE],
      redirectUri,
      codeVerifier: verifier,
    });
    if (!result) {
      throw new Error('MSAL returned no result from acquireTokenByCode');
    }
    return result;
  } finally {
    await closeServer(server);
  }
}

async function startLoopbackServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Loopback server did not report a port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

/**
 * Registers a single-shot request handler that resolves with the auth code
 * on a valid /redirect hit, or rejects on error / timeout / state mismatch.
 * The server itself is torn down by the caller.
 */
function waitForRedirect(server: http.Server, expectedNonce: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      // Mark settled so a late redirect from the browser shows the
      // failure page (instead of a misleading success page) — the
      // outer promise has already rejected at this point.
      settled = true;
      reject(new Error(`Entra ID login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`));
    }, LOGIN_TIMEOUT_MS);

    server.on('request', (req, res) => {
      if (settled) {
        respond(res, 408, failurePage('Sign-in timed out. Please try again.'));
        return;
      }
      if (!req.url) {
        respond(res, 400, failurePage('Malformed request'));
        return;
      }

      const reqUrl = new URL(req.url, 'http://localhost');
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const errorCode = reqUrl.searchParams.get('error');
      const errorDesc = reqUrl.searchParams.get('error_description');

      // Ignore incidental requests (favicon, etc.) — wait for the real callback.
      if (!code && !errorCode) {
        respond(res, 404, '');
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (errorCode || !code) {
        const msg = errorDesc || errorCode || 'No authorization code in redirect';
        respond(res, 400, failurePage(msg));
        reject(new Error(`Entra ID login failed: ${msg}`));
        return;
      }

      if (state !== expectedNonce) {
        respond(res, 400, failurePage('State/nonce mismatch. Please try again.'));
        reject(new Error('Entra ID login: state/nonce mismatch'));
        return;
      }

      respond(res, 200, successPage());
      resolve(code);
    });
  });
}

function respond(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function successPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;color:#333;background:#fafafa}
.card{max-width:420px;margin:auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h2{margin:0 0 12px;font-weight:500}</style></head>
<body><div class="card"><h2>Signed in to Microsoft Entra ID</h2>
<p>You can close this window and return to Joinery.</p></div></body></html>`;
}

function failurePage(msg: string): string {
  const safe = msg.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;color:#333;background:#fafafa}
.card{max-width:420px;margin:auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h2{margin:0 0 12px;font-weight:500;color:#b00020}</style></head>
<body><div class="card"><h2>Sign-in failed</h2><p>${safe}</p></div></body></html>`;
}

export function clearEntraAuthCache(): void {
  msalClient = null;
  cachedClientSignature = null;
  CredentialStore.getInstance()
    .delete(CACHE_KEY)
    .catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to clear Entra ID cache from Keychain: ${msg}`);
    });
}
