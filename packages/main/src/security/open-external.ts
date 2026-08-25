/**
 * The one gate between a URL and the OS browser (J-129).
 *
 * `shell.openExternal` is *passed in* rather than imported here, matching `harden.ts`: the side
 * effect stays visible at the call site, and this module needs no electron to be tested. What the
 * gate is worth comes from `no-unguarded-open-external.spec.ts`, which fails the build if any
 * main-process file calls `shell.openExternal(...)` directly instead of handing the reference to
 * this function.
 */

import { assertOpenableExternalUrl } from './external-url';

/** How a URL reaches the OS. `shell.openExternal` in production, a spy in tests. */
export type ExternalOpener = (url: string) => Promise<void>;

/**
 * Validate `url` against the scheme allowlist, then open it.
 *
 * Throws `UnsafeExternalUrlError` before `open` is called when the scheme is not allowed. Callers
 * that cannot propagate — Electron menu clicks, event listeners — must catch and log; see
 * `openMenuLink` in `menu.ts`.
 */
export async function openExternalSafely(url: string, open: ExternalOpener): Promise<void> {
  assertOpenableExternalUrl(url);
  await open(url);
}
