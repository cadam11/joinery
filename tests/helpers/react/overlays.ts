/**
 * The four command overlays — palette, object search, snippet library, cheatsheet — plus the two
 * popovers the status bar owns: the Docker panel and the guided tour's spotlight.
 *
 * Four surfaces, four testid prefixes: `palette-*`, `objsearch-*`, `snippets-*`, `shortcuts-*`.
 * All four are the same `CommandOverlay` shape (`ui/command-overlay.tsx`), which is why the
 * helpers below are parameterised over the prefix rather than written four times.
 *
 * **Every one of them is opened by a keystroke the RENDERER owns** — ⌘K/⇧⌘P, ⌘P, ⌥⌘S — chosen
 * because no `menu.ts` accelerator has them (`commands/catalogue.ts`, and a unit test pins the
 * no-collision rule). So `keyboard.press` here is the real user path, not a shortcut around the
 * UI. The cheatsheet is the exception: Help ▸ Keyboard Shortcuts is a menu item, so it arrives
 * through `sendMenuCommand` like the settings panel does.
 */

import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { UI_TIMEOUT_MS, CONNECT_TIMEOUT_MS, sendMenuCommand } from './app';

/** The prefixes the four overlays use. */
export type OverlayPrefix = 'palette' | 'objsearch' | 'snippets';

/** One of the overlays, if it is open. */
export function overlay(window: Page, prefix: OverlayPrefix): Locator {
  return window.getByTestId(`${prefix}-overlay`);
}

/** Every rendered row of one overlay. */
export function overlayRows(window: Page, prefix: OverlayPrefix): Locator {
  return window.getByTestId(`${prefix}-row`);
}

/** Types into an overlay's search box and waits for the row count to settle. */
export async function filterOverlay(
  window: Page,
  prefix: OverlayPrefix,
  text: string
): Promise<void> {
  const input = window.getByTestId(`${prefix}-input`);
  await input.fill(text);
  await expect(input).toHaveValue(text, { timeout: UI_TIMEOUT_MS });
}

/** Closes whichever overlay is open, the way Escape does. */
export async function closeOverlay(window: Page, prefix: OverlayPrefix): Promise<void> {
  await window.keyboard.press('Escape');
  await expect(overlay(window, prefix)).toBeHidden({ timeout: UI_TIMEOUT_MS });
}

/** Opens the command palette with ⌘K and waits for its rows. */
export async function openPalette(window: Page): Promise<Locator> {
  return pressForPalette(window, 'ControlOrMeta+k');
}

/**
 * Open the command palette with **⇧⌘P** rather than ⌘K.
 *
 * This existed because ⌘K did not reach the renderer while Monaco had focus: Monaco binds it as a chord
 * prefix and swallowed the keydown, so `openPalette` could not be used from inside a query editor.
 * **J-73 fixed that** — `editor/sql-editor.tsx` releases ⌘K back to the window with a null-command
 * keybinding rule, and `query-keybindings.spec.ts` presses ⌘K in a focused editor to prove it.
 *
 * The helper stays because ⇧⌘P is the palette's second advertised binding (`command-palette.tsx:85`,
 * `palette-actions.ts`) and the callers below are the tier's only coverage of it. It is no longer a
 * workaround, and a spec that wants ⌘K from an editor should use `openPalette`.
 */
export async function openPaletteFromEditor(window: Page): Promise<Locator> {
  return pressForPalette(window, 'ControlOrMeta+Shift+p');
}

/** The shared body of the two palette openers, which differed only in the chord. */
async function pressForPalette(window: Page, chord: string): Promise<Locator> {
  await window.keyboard.press(chord);
  const surface = overlay(window, 'palette');
  await expect(surface).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(overlayRows(window, 'palette').first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return surface;
}

/** One palette row, addressed by the command id or action id behind it. */
export function paletteRow(window: Page, key: string): Locator {
  return window
    .getByTestId('palette-row')
    .filter({ has: window.locator(`[data-palette-key="${key}"]`) });
}

/**
 * Runs a palette entry by its key, and waits for the palette to have closed.
 *
 * Keyed rather than by label because the key is the command id: a test that says
 * `runPaletteCommand(window, 'command:toggle-sidebar')` is naming the thing whose handler it
 * expects to fire, which is the property this whole surface exists to guarantee.
 */
export async function runPaletteCommand(window: Page, key: string): Promise<void> {
  const row = paletteRow(window, key);
  await expect(row).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await row.click();
  await expect(overlay(window, 'palette')).toBeHidden({ timeout: UI_TIMEOUT_MS });
}

/** What the palette says about one row: `ready`, `unowned` or `unavailable`. */
export async function paletteRowState(window: Page, key: string): Promise<string | null> {
  return window.locator(`[data-palette-key="${key}"]`).getAttribute('data-palette-state');
}

/** Opens the object search with ⌘P and waits for the loaded object list. */
export async function openObjectSearch(window: Page): Promise<Locator> {
  await window.keyboard.press('ControlOrMeta+p');
  const surface = overlay(window, 'objsearch');
  await expect(surface).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(overlayRows(window, 'objsearch').first()).toBeVisible({
    timeout: CONNECT_TIMEOUT_MS,
  });
  return surface;
}

/** One object-search row, addressed by the qualified name it shows. */
export function objectSearchRow(window: Page, qualifiedName: string): Locator {
  return window.getByTestId('objsearch-row').filter({
    has: window.getByTestId('objsearch-row-name').getByText(qualifiedName, { exact: true }),
  });
}

/** Opens the snippet library with ⌥⌘S. Tolerant of an empty library, which renders no rows. */
export async function openSnippets(window: Page): Promise<Locator> {
  await window.keyboard.press('Alt+ControlOrMeta+s');
  const surface = overlay(window, 'snippets');
  await expect(surface).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return surface;
}

/** One snippet row, addressed by its name. */
export function snippetRow(window: Page, name: string): Locator {
  return window
    .getByTestId('snippets-row')
    .filter({ has: window.getByTestId('snippets-row-name').getByText(name, { exact: true }) });
}

/** Saves a new snippet through the library's own form, and waits for the row to appear. */
export async function createSnippet(
  window: Page,
  values: { readonly name: string; readonly tags?: string; readonly sql?: string }
): Promise<void> {
  await window.getByTestId('snippets-new').click();
  await expect(window.getByTestId('snippets-form')).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await window.getByTestId('snippets-form-name').fill(values.name);
  if (values.tags !== undefined) await window.getByTestId('snippets-form-tags').fill(values.tags);
  if (values.sql !== undefined) await window.getByTestId('snippets-form-sql').fill(values.sql);
  await window.getByTestId('snippets-form-save').click();
  await expect(window.getByTestId('snippets-form')).toBeHidden({ timeout: UI_TIMEOUT_MS });
  await expect(snippetRow(window, values.name)).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

/** Opens the keyboard cheatsheet the way Help ▸ Keyboard Shortcuts does. */
export async function openShortcuts(app: ElectronApplication, window: Page): Promise<Locator> {
  await sendMenuCommand(app, 'menu:show-shortcuts');
  const dialog = window.getByTestId('shortcuts-dialog');
  await expect(dialog).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return dialog;
}

/** The status bar's Docker pip. */
export function dockerPip(window: Page): Locator {
  return window.getByTestId('status-docker-toggle');
}

/** The Docker panel, in its popover. */
export function dockerPanel(window: Page): Locator {
  return window.getByTestId('docker-panel');
}

/** Open the panel from the pip, and wait for it to have settled out of `checking`. */
export async function openDockerPanel(window: Page): Promise<Locator> {
  await expect(dockerPip(window)).not.toHaveAttribute('data-docker-state', 'checking', {
    timeout: CONNECT_TIMEOUT_MS,
  });
  await dockerPip(window).click();
  await expect(dockerPanel(window)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return dockerPanel(window);
}

/**
 * Close it by pressing the pip again.
 *
 * NOT Escape, and the reason is a real Radix property rather than a test convenience: `Popover` is
 * non-modal (`ui/popover.tsx` — the workbench underneath has to stay usable), so it does not move focus
 * into its content on open and its Escape handling needs focus to be inside. A test that has just clicked
 * the trigger, or run a palette command, has focus outside — so Escape there would be asserting nothing
 * about the panel. `docker-panel.spec.ts` covers the Escape path separately, from inside.
 */
export async function closeDockerPanel(window: Page): Promise<void> {
  await dockerPip(window).click();
  await expect(dockerPanel(window)).toBeHidden({ timeout: UI_TIMEOUT_MS });
}

/** One container row, addressed by the name Docker gave it. */
export function dockerContainerRow(window: Page, name: string): Locator {
  return window.locator(`[data-testid="docker-container"][data-container-name="${name}"]`);
}

/** The names the panel is listing. */
export async function dockerContainerNames(window: Page): Promise<string[]> {
  return window
    .getByTestId('docker-container')
    .evaluateAll(rows => rows.map(row => row.getAttribute('data-container-name') ?? ''));
}

/** The tour spotlight overlay. */
export function tourOverlay(window: Page): Locator {
  return window.getByTestId('tour-overlay');
}

/** Start the guided tour through the palette and wait for its first step. */
export async function startTour(window: Page): Promise<Locator> {
  await openPalette(window);
  await runPaletteCommand(window, 'command:start-tour');
  await expect(tourOverlay(window)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return tourOverlay(window);
}

/** The tour's step counter, as `[current, total]`. */
export async function tourStep(window: Page): Promise<[number, number]> {
  const text = (await window.getByTestId('tour-tooltip').textContent()) ?? '';
  const match = /(\d+) of (\d+)/.exec(text);
  return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
}
