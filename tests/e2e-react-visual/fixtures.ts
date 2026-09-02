/**
 * The React renderer's visual tier: what every spec here needs before it may take a picture.
 *
 * Three things, and each one closes a specific way a baseline goes bad:
 *
 *  1. **`withVisualApp` pins the device pixel ratio, the macOS scroller style and the theme before
 *     any state is built.** The DPR is the structural fix for the trap the Angular tier fell into;
 *     the scroller style is the second host variable (macOS resolves its `Automatic` default from
 *     the attached pointing device, and legacy scrollbars take 15px of layout width that overlay
 *     ones do not); the theme is the reason that tier is single-theme (a `system` preference
 *     resolves through `nativeTheme`, so an unpinned shot records the developer's macOS appearance
 *     setting rather than the app's). All three are asserted per launch, not merely requested.
 *  2. **`shoot` refuses to take a picture with a vacuous mask.** Playwright silently ignores a mask
 *     locator that matches nothing, so a mask outlives the element it was hiding and the baseline
 *     starts recording the volatile pixels it was written to exclude. Every mask here is asserted to
 *     resolve first, which turns mask rot into a failure with a name on it.
 *  3. **`VISUAL_THEMES` is the pair every surface is captured in**, so "dark and light" is a loop
 *     rather than a habit each spec has to remember.
 *
 * `test` came from `tests/e2e-react/fixtures.ts` until Task 24, for a fourth reason that no longer
 * exists: that auto fixture asserted every launch in the test showed the React renderer rather than
 * the Angular one the launcher defaulted to, because a baseline quietly captured from Angular would
 * have been a picture of the thing this rewrite replaced. With one renderer left it asserted
 * nothing, so it and its module were deleted and `test` comes straight from Playwright.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  CONNECT_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  withJoineryReact,
} from '../helpers/joinery-actions-react';
import type { LaunchedApp, MacScrollBarStyle } from '../helpers/electron-app';

export { expect, test };

/** The two canvases. Named `dark`/`light` after `[data-theme]`; the UI calls them Ink and Ivory. */
export type VisualTheme = 'dark' | 'light';

/**
 * Every surface in this tier is captured in both, which is the gap Task 22 exists to close: the
 * Angular tier's 11 baselines are almost all single-theme, so a regression that only showed up on
 * one canvas had nothing to fail against.
 */
export const VISUAL_THEMES: readonly VisualTheme[] = ['dark', 'light'];

/**
 * The device pixel ratio this tier's baselines are captured at, from the project's own config.
 *
 * Read from `metadata` rather than hard-coded here so the number lives with the project it
 * describes — see `playwright.config.ts`'s `visual-react` block for why it is `metadata` and not
 * `use.deviceScaleFactor`. `metadata` is untyped by Playwright, so the value is validated rather
 * than trusted: a config typo would otherwise reach `--force-device-scale-factor=undefined`.
 */
function pinnedDeviceScaleFactor(): number {
  const raw: unknown = test.info().project.metadata['deviceScaleFactor'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `[visual] the visual-react project must set metadata.deviceScaleFactor to a positive ` +
        `number; got ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

/**
 * Pick a theme from the status bar's own theme menu, and wait for the DOM to have adopted it.
 *
 * The status bar rather than the settings panel (`helpers/react/dialogs.ts:setTheme`), because that
 * helper needs the settings dialog open and this tier has to pin the theme *before* it builds a
 * surface — including surfaces that are themselves modal dialogs, which the panel could not be
 * opened over. The two controls write the same store; `features/settings`' unit spec pins that they
 * offer the same three choices.
 *
 * The wait is on `<html data-theme>`, which is the settings store's single writer of the resolved
 * value and therefore the only observable proof the change landed. `system` is deliberately not
 * accepted: it resolves through Electron's `nativeTheme`, i.e. through the developer's macOS
 * appearance setting, which is exactly the non-determinism this function exists to remove.
 */
async function pinTheme(window: Page, theme: VisualTheme): Promise<void> {
  const trigger = window.getByTestId('status-theme-trigger');
  await trigger.click();
  await window.getByTestId(`status-theme-${theme}`).click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', theme, {
    timeout: UI_TIMEOUT_MS,
  });
  // The menu closes on select; a shot taken with it still up would frame a dropdown over the
  // surface under test. Radix animates the exit, so this is a wait rather than an assumption.
  await expect(window.getByTestId('status-theme-menu')).toBeHidden({ timeout: UI_TIMEOUT_MS });

  // ── Put the trigger back to rest ──────────────────────────────────────────────────────────
  //
  // Two Radix behaviours conspire here, and the first capture of this tier caught both: closing a
  // `DropdownMenu` returns focus to its trigger, and `Tooltip` opens on FOCUS as well as on hover.
  // So a theme pin left "Theme: Ink" floating over the bottom-right corner of every surface that
  // reaches that far down — reproducibly, which is exactly what makes it dangerous rather than
  // flaky. The pointer is moved off the bar first: `click()` really does move the mouse there, so
  // the hover half would re-open the tip on its own.
  await window.mouse.move(0, 0);

  // ── Why this converges instead of firing once (Task 24 review, I2) ─────────────────────────
  //
  // A single `blur()` here was a RACE, and it cost the tier two red runs in three: the menu's exit
  // animation and Radix's focus-restore effect are not ordered against each other, so a `blur()`
  // that lands BEFORE the restore is undone by it. The trigger ends up focused with the pointer
  // elsewhere, nothing closes the tip again, and `toHaveCount(0)` then watches a stuck tooltip for
  // the full timeout (measured: 24 polls, 1 element every time).
  //
  // So the blur is retried until BOTH facts hold at once. Focus is the load-bearing half — a
  // tooltip has an open delay, so "no tooltip right now" can be true a tick before one appears,
  // while "the trigger is not focused" means none can be opened by focus at all. Bounded by
  // `toPass`'s own timeout, per the house rule on loops.
  //
  // Nothing here touches the page's pixels: `blur()` and a pointer move off-window change no
  // layout, and the baselines are unchanged by this fix (verified over repeat runs, no
  // `--update-snapshots`).
  await expect(async () => {
    await trigger.blur();
    await expect(trigger).not.toBeFocused({ timeout: 500 });
    await expect(window.locator('[role="tooltip"]:visible')).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: UI_TIMEOUT_MS, intervals: [50, 100, 250, 500] });
}

/**
 * The macOS scroller style this tier's baselines are captured in, from the project's own config.
 *
 * Only `Always` (legacy, space-taking scrollbars) is accepted, and the throw is not pedantry: the
 * per-launch guard below knows exactly one expectation — that a scrolling container has a non-zero
 * scrollbar gutter — so a project that pinned `WhenScrolling` or `Automatic` would run with a guard
 * asserting the opposite of what it asked for. Read from `metadata` for the same reason the DPR is:
 * the number lives with the project it describes, and `metadata` is untyped by Playwright, so it is
 * validated rather than trusted.
 */
function pinnedScrollBarStyle(): MacScrollBarStyle {
  const raw: unknown = test.info().project.metadata['macScrollBarStyle'];
  if (raw !== 'Always') {
    throw new Error(
      `[visual] the visual-react project must set metadata.macScrollBarStyle to "Always" — the ` +
        `baselines are captured with legacy (space-taking) scrollbars and the launch guard only ` +
        `knows that expectation; got ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

/**
 * Measure how many CSS pixels a scrolling container loses to its scrollbar, in this window.
 *
 * This is the observable that separates the two macOS scroller styles: legacy scrollbars take
 * layout width (15px on macOS today), overlay scrollbars float above the content and take none. It
 * is measured rather than read from a preference API because the preference is not what the layout
 * obeys — Chromium's own resolution of it is.
 *
 * **Measured inside an iframe**, whose document inherits no author CSS. The React renderer ships no
 * `::-webkit-scrollbar` rules today, so a bare `<div>` in the page reads the same number (probed:
 * both say 0 unpinned, both say 15 pinned) — but the day a stylesheet gives scrollbars a width of
 * their own, a bare div would report that width in BOTH modes and this guard would quietly stop
 * distinguishing them. The iframe keeps the guard a question about the platform.
 *
 * String form keeps the DOM lib out of a file the tests tsconfig compiles as node, matching
 * `forceFonts` in the launcher.
 */
async function scrollBarGutterPx(window: Page): Promise<number> {
  const measured: unknown = await window.evaluate(`(async () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;top:-9999px;width:200px;height:200px;border:0;';
    frame.srcdoc = '<!doctype html><body style="margin:0">' +
      '<div id="probe" style="width:100px;height:100px;overflow:scroll">' +
      '<div style="width:300px;height:300px"></div></div>';
    const loaded = new Promise(resolve => { frame.onload = resolve; });
    document.body.appendChild(frame);
    await loaded;
    const probe = frame.contentDocument && frame.contentDocument.getElementById('probe');
    if (!probe) {
      frame.remove();
      throw new Error('[visual] the scrollbar probe iframe did not render — cannot read the gutter');
    }
    const gutter = probe.offsetWidth - probe.clientWidth;
    frame.remove();
    return gutter;
  })()`);
  if (typeof measured !== 'number' || !Number.isFinite(measured)) {
    throw new Error(`[visual] the scrollbar probe returned ${JSON.stringify(measured)}`);
  }
  return measured;
}

/**
 * Launch the React renderer with the DPR pinned and the theme set, then run the body.
 *
 * The `devicePixelRatio` assertion is the point of the whole arrangement: `--force-device-scale-factor`
 * is a Chromium switch this suite passes through Electron, and a switch that stopped being honoured
 * (an Electron upgrade, a display-specific override) would otherwise re-introduce the exact
 * capture-at-2/compare-at-1 geometry failure J-21 records — silently, and only for whoever next ran
 * the tier on a Retina display. Asserted per launch, it fails here instead, naming the ratio.
 *
 * The scrollbar assertion is the same arrangement for the second host variable. macOS resolves its
 * default `Automatic` scroller style from the attached pointing device, so an unpinned run captures
 * (or compares against) whichever style the developer's desk implies — a 15px reflow of every
 * scrolling panel, which cost this tier 3 outright failures out of 22 the first time the host
 * resolved the other way. `-AppleShowScrollBars Always` pins it per process through Cocoa's argument
 * domain, and the gutter is re-measured here so an Electron that stopped honouring the argument
 * domain fails with a name on it rather than re-arming the trap.
 *
 * `options.envOverrides` is the one launch knob a spec here may reach, and it is spelled out rather
 * than taking the launcher's whole `LaunchOptions`: the DPR and the scroller style are properties of
 * the TIER, so a spec that could pass them would be able to capture a baseline the rest of the tier
 * cannot compare against. The Docker panel is what needs it — `JOINERY_DOCKER_FIXTURE` pins what
 * `docker.detect` answers (J-76, `packages/main/src/services/docker/docker-fixture.ts`), which is
 * what makes that surface a picture of Joinery rather than of the host's `docker ps`.
 */
export async function withVisualApp(
  theme: VisualTheme,
  body: (launched: LaunchedApp) => Promise<void>,
  options: { readonly envOverrides?: Record<string, string> } = {}
): Promise<void> {
  const deviceScaleFactor = pinnedDeviceScaleFactor();
  const macScrollBarStyle = pinnedScrollBarStyle();

  await withJoineryReact(
    { deviceScaleFactor, macScrollBarStyle, envOverrides: options.envOverrides },
    async launched => {
      const actual = await launched.window.evaluate('window.devicePixelRatio');
      expect(
        actual,
        '--force-device-scale-factor was not honoured — every baseline in this tier would be captured ' +
          'at the display DPR, which is the J-21 geometry trap'
      ).toBe(deviceScaleFactor);

      // Greater-than-zero rather than exactly 15: the two modes are 15 and 0, so "takes layout space"
      // is the whole distinction, and pinning the metric as well would turn a Chromium change in
      // scrollbar WIDTH into a guard failure — when the honest place for that is the baselines, which
      // would show it as the pixel difference it is.
      const gutter = await scrollBarGutterPx(launched.window);
      expect(
        gutter,
        `-AppleShowScrollBars ${macScrollBarStyle} was not honoured: a scrolling container lost ` +
          `${gutter}px to its scrollbar, i.e. this launch has macOS OVERLAY scrollbars. Every ` +
          `baseline in this tier was captured with LEGACY scrollbars, which take 15px of layout ` +
          `width out of every scrolling panel — comparing across the two is a reflow, not a UI change`
      ).toBeGreaterThan(0);

      await pinTheme(launched.window, theme);
      await body(launched);
    }
  );
}

/**
 * Take one baseline, after proving every mask still has something to hide.
 *
 * `mask` is Playwright's own volatile-region mechanism (it paints each match over before
 * comparing), and its failure mode is silence: a locator that matches nothing is skipped, so the
 * baseline starts including the pixels the mask was written for and the next release's version
 * bump — or the next container restart's uptime string — reads as a UI regression. Asserting each
 * locator resolves makes the mask list a checked claim about the surface.
 *
 * `Page | Locator` because some surfaces are the whole window (the shell, where the frame IS the
 * subject) and some are one element (a dialog, where the scrim behind it is not).
 */
export async function shoot(
  target: Page | Locator,
  name: string,
  options: { readonly mask?: readonly Locator[] } = {}
): Promise<void> {
  const page = 'reload' in target ? target : target.page();

  // No tooltip may be up when a picture is taken. This is not hypothetical tidiness: the theme pin
  // leaves focus on the status bar's theme trigger, and Radix opens a tooltip on FOCUS as well as on
  // hover — so the first capture of this tier had "Theme: Ink" floating over the bottom-right corner
  // of the welcome panel. It was perfectly reproducible, which is the trap: a deterministic artefact
  // passes a self-consistency check and becomes part of what every future run is compared against.
  // Radix puts `role="tooltip"` on its tooltip content (`@radix-ui/react-tooltip`:
  // `role: ariaLabel ? void 0 : "tooltip"`, and this app never passes `ariaLabel`).
  //
  // `:visible` is load-bearing and was arrived at by probe, not by taste: **Monaco keeps two hidden
  // `role="tooltip"` widgets mounted for the life of an editor** (`.monaco-hover fade-in hidden`,
  // one of them `editor.contrib.modesGlyphHoverWidget`), so an unfiltered count is 2 in every shot
  // that contains a query tab. Filtering on visibility is what makes this assert "nothing is
  // showing" rather than "nothing is mounted".
  await expect(
    page.locator('[role="tooltip"]:visible'),
    `a tooltip was showing when ${name} was captured — it would be baked into the baseline`
  ).toHaveCount(0, { timeout: UI_TIMEOUT_MS });

  const mask = options.mask ?? [];
  for (const [index, region] of mask.entries()) {
    await expect(
      region,
      `mask ${index} for ${name} matched nothing — a mask that hides nothing lets the volatile ` +
        `pixels it was written for into the baseline`
    ).not.toHaveCount(0, { timeout: UI_TIMEOUT_MS });
  }

  // The union has to be split: `expect()` resolves to a different matcher type for each side, and
  // `toHaveScreenshot` is not callable on the union of the two.
  if ('reload' in target) {
    await expect(target).toHaveScreenshot(name, { mask: [...mask] });
    return;
  }
  await expect(target).toHaveScreenshot(name, { mask: [...mask] });
}

/**
 * The status bar's two volatile readouts, masked in every shot that frames the whole window.
 *
 *  - `status-version` is `Joinery v<package version>`, so every full-window baseline in the repo
 *    would go red on the next release bump — a version string is not a UI regression.
 *  - `status-docker-count` is how many database containers Docker is running right now. This tier
 *    needs Docker up (the seeded containers ARE the fixtures), but the count also moves when
 *    `tests/e2e-react/docker-panel.spec.ts` stops one, or when a developer has a database container
 *    of their own running. Both are true facts about the host and neither is a fact about Joinery.
 */
export function statusBarVolatile(window: Page): readonly Locator[] {
  return [window.getByTestId('status-version'), window.getByTestId('status-docker-count')];
}

/**
 * Drop focus to `<body>`, so nothing in the shot is focused because of how the state was built.
 *
 * ── Why this is necessary, with the measurement ────────────────────────────────────────────────
 *
 * Monaco draws its own caret as a `<div class="cursor">` in a cursors layer, and Playwright's
 * `caret: 'hide'` does not reach it — that option hides the NATIVE text caret. So whether the shell
 * baseline contains a caret comes down to whether the editor still had focus, and that was not
 * deterministic: `dismissToasts` only clicks when a toast is still alive, and connecting raises two
 * that auto-dismiss after a few seconds. A run where they were clicked away moved focus out of the
 * editor (no caret); a run where they had already faded left focus in it (caret). Byte-comparing
 * repeated captures showed it precisely — exactly 40 pixels, a 2×20 rectangle at the end of the last
 * line of SQL, appearing and disappearing between otherwise identical images.
 *
 * `locator.blur()` is not usable on Monaco's textarea: it runs actionability checks first and that
 * element is a 1px, transparent input, so the call times out (30s, observed). Blurring
 * `document.activeElement` is the honest one-liner, and the assertion below is what makes it a
 * checked operation rather than a hopeful one.
 */
export async function blurFocus(window: Page): Promise<void> {
  await window.evaluate(
    'document.activeElement instanceof HTMLElement && document.activeElement.blur()'
  );
  expect(await window.evaluate('document.activeElement?.tagName')).toBe('BODY');
}

/**
 * Wait until both of the status bar's volatile readouts have arrived, so masking them is stable.
 *
 * Necessary because **a mask's rectangle is the element's box, and both of these elements grow as
 * their content lands.** `status-version` renders the word "Joinery" until `app.getVersion` answers
 * and "Joinery v41.10.5" afterwards; the Docker pip renders no count at all while its probe is in
 * flight. A shot taken mid-flight therefore has a narrower pink rectangle (a pixel diff around its
 * edges) or a missing one (which trips `shoot`'s own mask assertion). Neither is a UI change, and
 * one full-tier run produced exactly that class of failure.
 *
 * `CONNECT_TIMEOUT_MS` rather than the UI budget: both are IPC round trips, and the Docker one talks
 * to the daemon.
 */
export async function settleStatusBar(window: Page): Promise<void> {
  await expect(window.getByTestId('status-version')).toHaveText(/^Joinery v\d/, {
    timeout: CONNECT_TIMEOUT_MS,
  });
  await expect(window.getByTestId('status-docker-toggle')).not.toHaveAttribute(
    'data-docker-state',
    'checking',
    { timeout: CONNECT_TIMEOUT_MS }
  );
  await expect(window.getByTestId('status-docker-count')).toBeVisible({
    timeout: CONNECT_TIMEOUT_MS,
  });
}
