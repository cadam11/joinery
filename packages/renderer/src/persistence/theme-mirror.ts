/**
 * The one localStorage key the React renderer writes, and the reason it has to exist.
 *
 * ── The problem ──────────────────────────────────────────────────────────────────────────────
 *
 * Settings now live in main-process `AppState` (`renderer-state.ts`), reachable only through async
 * IPC. But the FOUC fix that Task 2 built — and that PLAN.md 0.7 requires — is a script in
 * `index.html` that runs BEFORE the bundle is requested and writes `data-theme` synchronously.
 * There is no await there. Something local and synchronous has to hold the theme preference.
 *
 * ── The two options, and why this one ────────────────────────────────────────────────────────
 *
 * The alternative was to have main inject the theme (a query parameter on the dev URL, or a
 * `contextBridge` global set before load). Rejected on two counts: it needs changes in
 * `packages/main`/`packages/preload`, which this task is forbidden to touch, and a preload-injected
 * global still is not available to a `<head>` script that runs before preload's world is
 * consulted for anything.
 *
 * So: a mirror. It is deliberately NOT the Angular `joinery-settings` key — writing that would have
 * meant the React renderer overwriting Angular's whole settings object on every settings change.
 * A separate key holding ONE string kept "React reads Angular's localStorage, never writes it" true
 * literally, and it is why this key survived the cutover when the six Angular ones did not.
 *
 * ── The ruling at cutover (Task 24, PLAN.md §3.1) ────────────────────────────────────────────
 *
 * **The mirror stays.** The pre-mount script in `index.html` has no other synchronous source: the
 * alternative — main injecting the theme via a query parameter or a `contextBridge` global — is not
 * available to a `<head>` script that runs before preload's world is consulted.
 *
 * **Its `joinery-settings` fallback goes.** Reads used to be mirror-first with the Angular settings
 * object behind it, so a user whose migration had not run yet still got their real theme. With
 * Angular deleted the migration removes that key on the first React boot, so the fallback would be
 * dead from the second boot on. The cost of dropping it is one boot: a profile migrating from the
 * Angular app paints the default canvas until `hydrate()` writes the mirror (`state/settings.ts`),
 * and every boot after that is flash-free. Keeping a read of a key the same PR deletes, to buy one
 * frame once, is not worth the second source of truth. The pre-mount copy of this read was
 * shortened to match.
 *
 * ── Where the pre-mount copy lives now (J-22) ────────────────────────────────────────────────
 *
 * `packages/renderer/public/theme-boot.js`, loaded by a `<script src>` in `index.html` rather than
 * written inline there. Nothing about the timing or the trade above changed — it is still a
 * classic, parser-blocking `<head>` script that runs before the module bundle — but the main
 * process now ships a Content-Security-Policy whose production `script-src` is `'self'`, and an
 * inline script does not satisfy that. The `sha256-` escape hatch was tried and MEASURED not to
 * work over `file://`; `public/theme-boot.js` records the measurement.
 */

import type { ThemePreference } from '@joinery/shared';
import { diagnostics } from '../state/diagnostics';

/** React-owned. One value: `'system' | 'light' | 'dark'`, unquoted. */
export const THEME_MIRROR_KEY = 'joinery:theme-preference';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * The preference the pre-mount script would have found: the mirror, else `'system'`.
 *
 * Never throws. Storage can be blocked outright (some Electron sandboxes, some privacy modes) and
 * a theme is not worth failing a boot over.
 */
export function readMirroredThemePreference(): ThemePreference {
  const mirrored = readKey(THEME_MIRROR_KEY);
  return isThemePreference(mirrored) ? mirrored : 'system';
}

/** Keeps the pre-mount script's source in step. Called on every settings write and on hydration. */
export function writeMirroredThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_MIRROR_KEY, preference);
  } catch (error) {
    diagnostics.warn('could not mirror the theme preference for the pre-mount script', error);
  }
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    diagnostics.warn(`could not read localStorage key ${key}`, error);
    return null;
  }
}
