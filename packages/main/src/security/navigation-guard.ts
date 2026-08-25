/**
 * What the app's one `BrowserWindow` is allowed to navigate to, and what `window.open` gets.
 *
 * The window holds the preload bridge, so any document it loads inherits the whole
 * `window.joinery` surface — every SQL, keychain, filesystem and AI channel. `contextIsolation`
 * and `sandbox: true` do not change that: they isolate the bridge's *implementation*, not its
 * *audience*. So the rule is that the window only ever holds the document the main process
 * loaded, and anything a link wants to reach goes to the OS browser instead.
 *
 * Pure by design: no electron, no I/O. `harden.ts` is the wiring; these are the decisions.
 */

import { resolve } from 'node:path';

import { isOpenableExternalUrl } from './external-url';

/**
 * The document `window.ts` loaded — the one origin/path that counts as "the app".
 *
 * Two shapes because the two builds are genuinely different: dev is a Vite server on a port and
 * anything within that origin is app code, while production is a single `index.html` inside the
 * asar and a sibling file in the same directory is NOT the app.
 */
export type AppEntry =
  | { readonly kind: 'dev-server'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string };

export type NavigationDecision =
  /** Let Electron proceed: the target is the app's own document. */
  | { readonly kind: 'allow' }
  /** Cancel the navigation and hand the URL to the OS browser. */
  | { readonly kind: 'open-externally'; readonly url: string }
  /** Cancel the navigation and do nothing else. `reason` is for the log. */
  | { readonly kind: 'block'; readonly reason: string };

/**
 * A `window.open` never produces a window, so `allow` is not in the union — a child
 * `BrowserWindow` would be created with the parent's `webPreferences`, preload included.
 */
export type WindowOpenDecision = Exclude<NavigationDecision, { kind: 'allow' }>;

/** For the log: the scheme, or a fixed phrase. Never the rest of the URL — it can carry secrets. */
function describe(target: string): string {
  try {
    return `"${new URL(target).protocol}"`;
  } catch {
    return 'an unparseable target';
  }
}

/**
 * The filesystem path a `file:` URL points at.
 *
 * `pathname` is percent-encoded, and on Windows it carries a leading slash before the drive
 * letter (`/C:/…`). Returns `undefined` when the encoding is malformed rather than guessing.
 */
function fileUrlPath(url: URL): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent-escape. Not a path we can compare, so not the app document.
    return undefined;
  }
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/** True when `target` is the exact document `entry` describes. */
function isAppDocument(target: URL, entry: AppEntry): boolean {
  if (entry.kind === 'dev-server') {
    let expected: string;
    try {
      expected = new URL(entry.url).origin;
    } catch {
      // A malformed entry URL is a programming error, not a navigation to allow.
      return false;
    }
    // `origin` compares scheme + host + port, so a different port or an http/https swap is a
    // different origin and falls through to the external/blocked branches below.
    return target.origin === expected;
  }

  if (target.protocol !== 'file:') return false;
  const path = fileUrlPath(target);
  if (path === undefined) return false;
  // `resolve` collapses `..`, so a traversal out of the bundle cannot match. Compared whole
  // rather than by prefix: `…/index.html.evil` starts with the entry path.
  return resolve(path) === resolve(entry.path);
}

/**
 * What to do about a `will-navigate` on the app window.
 *
 * Order matters: the app's own document wins first, then the schemes we are willing to hand to
 * the OS, then everything else is refused. Fragment and `history.pushState` navigations never
 * reach here — Electron does not emit `will-navigate` for same-document navigation.
 */
export function decideNavigation(target: string, entry: AppEntry): NavigationDecision {
  if (typeof target !== 'string') {
    return { kind: 'block', reason: 'blocked navigation to a non-string target' };
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { kind: 'block', reason: 'blocked navigation to an unparseable target' };
  }

  if (isAppDocument(url, entry)) return { kind: 'allow' };
  if (isOpenableExternalUrl(target)) return { kind: 'open-externally', url: target };

  return { kind: 'block', reason: `blocked navigation to ${describe(target)}` };
}

/**
 * What to do about a `window.open` from the renderer. Every answer denies the window; the only
 * question is whether the URL is worth forwarding to the OS browser.
 */
export function decideWindowOpen(target: string): WindowOpenDecision {
  if (typeof target === 'string' && isOpenableExternalUrl(target)) {
    return { kind: 'open-externally', url: target };
  }
  return { kind: 'block', reason: `denied window.open for ${describe(String(target))}` };
}
