/**
 * The Electron wiring for J-22: it installs the pure decisions from `navigation-guard.ts` and
 * `content-security-policy.ts` onto a real `WebContents` and `Session`.
 *
 * Deliberately thin — every branch worth testing lives in the pure modules — and the one side
 * effect it performs beyond registering handlers, opening a URL in the OS browser, is passed in
 * rather than imported, so it is visible at the call site in `window.ts`.
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
 * Install the `setWindowOpenHandler`, `will-navigate` and `will-redirect` guards on one
 * `WebContents`.
 *
 * Prefer `installNavigationGuardsForEveryWindow` — this is exported for the tests and for a
 * caller that holds a `WebContents` directly.
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

  // `will-redirect` carries the same guarantee as `will-navigate` and none of its coverage: a
  // server-side 30x is not a navigation the renderer initiated, so it never reaches the listener
  // below. Neither loader can be redirected today — production is `file://` and dev talks only to
  // the local Vite server — which is why J-22 could defer it. Both events get the same decision.
  const guard = (details: Electron.Event<{ url: string }>): void => {
    const decision = decideNavigation(details.url, entry);
    if (decision.kind === 'allow') return;

    details.preventDefault();
    if (decision.kind === 'open-externally') {
      forwardToOs(decision.url, openExternal);
    } else {
      log.warn(decision.reason);
    }
  };

  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
}

/**
 * Guard every `WebContents` the app will ever create, including ones it does not create yet.
 *
 * J-22 installed the guards at the single `new BrowserWindow(...)` call site, which was correct
 * and structurally fragile: a second window added later would carry the whole `window.joinery`
 * preload bridge with no navigation protection, and nothing would fail to say so. Hooking
 * `web-contents-created` makes coverage a property of the app rather than a thing each call site
 * must remember.
 *
 * Register before the first window is created — `index.ts` does this inside `whenReady`, above
 * `createMainWindow()`.
 */
export function installNavigationGuardsForEveryWindow(
  electronApp: Electron.App,
  options: NavigationGuardOptions
): void {
  electronApp.on('web-contents-created', (_event, contents) => {
    installNavigationGuards(contents, options);
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
