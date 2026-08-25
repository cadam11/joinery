/**
 * The Electron wiring for J-22: it installs the pure decisions from `navigation-guard.ts` and
 * `content-security-policy.ts` onto a real `WebContents` and `Session`.
 *
 * Deliberately thin — every branch worth testing lives in the pure modules — and every side
 * effect it performs is either passed in (`openExternal`) or named in the function's own name
 * (`readInlineScriptHashes` reads a file).
 */

import { createLogger } from '../utils/logger';
import { CSP_HEADER_NAME } from './content-security-policy';
import { type AppEntry, decideNavigation, decideWindowOpen } from './navigation-guard';

/** The logger tag every refusal is recorded under, so the Output panel can be filtered by it. */
export const SECURITY_LOG_TAG = 'Security';

const log = createLogger(SECURITY_LOG_TAG);

export interface NavigationGuardOptions {
  /** The document `window.ts` loaded. Everything else is external or blocked. */
  readonly entry: AppEntry;
  /**
   * Where a forwarded URL goes. Injected rather than imported so the side effect is visible at
   * the call site — and so this module is testable without electron.
   */
  readonly openExternal: (url: string) => Promise<void>;
}

/**
 * Hand `url` to the OS, logging a failure rather than leaving an unhandled rejection behind.
 *
 * Both callers below are synchronous by contract: Electron does not await a `will-navigate`
 * listener or a window-open handler, so the promise has to be detached here.
 */
function forwardToOs(url: string, openExternal: (url: string) => Promise<void>): void {
  openExternal(url).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    // The URL is omitted on purpose: it can carry a token, and this reaches the Output panel.
    log.error(`Failed to open a link in the OS handler: ${message}`);
  });
}

/**
 * Install the `setWindowOpenHandler` and `will-navigate` guards on one `WebContents`.
 *
 * Called once per window, from `createMainWindow`.
 */
export function installNavigationGuards(
  contents: Electron.WebContents,
  options: NavigationGuardOptions
): void {
  const { entry, openExternal } = options;

  contents.setWindowOpenHandler(details => {
    const decision = decideWindowOpen(details.url);
    if (decision.kind === 'open-externally') {
      forwardToOs(decision.url, openExternal);
    } else {
      log.warn(decision.reason);
    }
    // Always deny: a child BrowserWindow would inherit this window's webPreferences, preload
    // bridge included.
    return { action: 'deny' };
  });

  contents.on('will-navigate', details => {
    const decision = decideNavigation(details.url, entry);
    if (decision.kind === 'allow') return;

    details.preventDefault();
    if (decision.kind === 'open-externally') {
      forwardToOs(decision.url, openExternal);
    } else {
      log.warn(decision.reason);
    }
  });
}

/**
 * Stamp `policy` onto every response in `session`.
 *
 * `webRequest.onHeadersReceived` rather than a `<meta http-equiv>` tag in the entry HTML: it
 * covers the dev server and the packaged `file://` build with one code path, keeps the dev/prod
 * split in the main process where the flag already lives, and — unlike a meta tag — can carry
 * `frame-ancestors`, which is ignored in meta form.
 */
export function installContentSecurityPolicy(session: Electron.Session, policy: string): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string | string[]> = { ...(details.responseHeaders ?? {}) };

    // Two enforcing policies are intersected by the browser, which makes the effective policy
    // impossible to reason about — so any casing of the header we are about to set is dropped
    // first. `…-Report-Only` is a different header and is left alone.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === CSP_HEADER_NAME.toLowerCase()) delete headers[name];
    }
    headers[CSP_HEADER_NAME] = [policy];

    callback({ responseHeaders: headers });
  });
}
