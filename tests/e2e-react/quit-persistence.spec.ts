/**
 * A real quit, and whether the geometry survives it (J-74).
 *
 * ── What this tier can prove that no other can ────────────────────────────────────────────────
 *
 * The renderer debounces shell geometry by 250ms, and until J-74 nothing emptied that debounce when
 * the app went away. The unit tiers prove the pieces with a controllable clock — the flush itself
 * (`state/workbench.spec.ts`), the registry (`persistence/flush-on-exit.spec.ts`), the shutdown
 * ORDERING (`main/src/shutdown.spec.ts`) and the request's bound
 * (`main/src/services/config/renderer-flush.spec.ts`). What none of them can do is run the actual
 * exchange: a real `app.quit()`, a real `before-quit` handler, a real `webContents.send`, a real
 * preload bridge, a real reply, and a real `app-state.json` on disk afterwards. That is this file.
 *
 * ── The one timing dependency, stated out loud ────────────────────────────────────────────────
 *
 * The gesture has to land inside the 250ms window for the flush to be what saves it — outside it,
 * the ordinary debounce would have written anyway and the assertion would pass for the wrong
 * reason. The gap between the keystroke and `app.quit()` is one IPC round trip, so it is
 * comfortably inside; but it is wall-clock, so the gap is MEASURED and asserted. A machine slow
 * enough to miss it fails with a message that says the run was inconclusive, rather than passing
 * vacuously — the position `playwright.config.ts` takes on `retries: 0`, applied here.
 *
 * No `ensureJoineryTestSeeded` and no profile: nothing here talks to a database, so this spec runs
 * with the containers down — the same property `shell.spec.ts` documents and is worth keeping true.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchJoinery } from '../helpers/electron-app';
import { waitForShell } from '../helpers/react/app';
import { resizeHandle, resizeHandleValue } from '../helpers/react/workbench';

/** `state/workbench.ts`'s `SAVE_DEBOUNCE_MS`. The window this spec has to stay inside. */
const GEOMETRY_DEBOUNCE_MS = 250;

interface PersistedAppState {
  appState: { sidebarWidth?: number };
}

test('a quit one keystroke after a resize still persists the width (J-74)', async () => {
  const launched = await launchJoinery();
  try {
    await waitForShell(launched.window);

    // A real user gesture on a real control: the divider implements the ARIA window-splitter
    // pattern, and ArrowRight is its 8px step (`shell/resize-handle.tsx`).
    const handle = resizeHandle(launched.window, 'sidebar');
    const before = await resizeHandleValue(launched.window, 'sidebar');
    await handle.focus();
    await handle.press('ArrowRight');
    await expect(handle).not.toHaveAttribute('aria-valuenow', String(before));
    const widened = await resizeHandleValue(launched.window, 'sidebar');
    expect(widened).toBeGreaterThan(before);

    // ⌘Q, from the main process's point of view: the menu's Quit role and the keystroke both land
    // on `app.quit()`, and neither emits a `close` on the window — which is the whole reason the
    // renderer's own unload listeners cannot cover this path.
    const gestureAt = Date.now();
    await launched.app.evaluate(({ app }) => {
      app.quit();
    });
    const gapMs = Date.now() - gestureAt;
    await launched.app.waitForEvent('close');

    expect(
      gapMs,
      `inconclusive: ${gapMs}ms elapsed between the resize and the quit, so the ordinary ` +
        `${GEOMETRY_DEBOUNCE_MS}ms debounce could have written the value on its own`
    ).toBeLessThan(GEOMETRY_DEBOUNCE_MS);

    // The next launch reads this file. Before J-74 it still said `before`.
    const raw = readFileSync(join(launched.userDataDir, 'app-state.json'), 'utf8');
    const persisted = JSON.parse(raw) as PersistedAppState;
    expect(persisted.appState.sidebarWidth).toBe(widened);
  } finally {
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
