/**
 * Electron launch helper for E2E tests.
 *
 * Spins up the built Joinery app via Playwright's Electron driver, waits for
 * the renderer to load, and returns the app + first window. Each test should
 * call `launchJoinery()` and `await app.close()` (or use the helper's
 * `withJoinery` form for guaranteed teardown).
 *
 * Requires `pnpm run build` to have produced packages/main/dist/index.js and
 * packages/renderer/dist/browser/index.html.
 *
 * ── One renderer, and what that deleted (Task 24) ───────────────────────────
 *
 * Until the cutover this helper took a `renderer: 'angular' | 'react'` option
 * (defaulting to `$JOINERY_E2E_RENDERER`, then `angular`) and reached the React
 * build by re-pointing the already-created BrowserWindow at a second index.html
 * after launch — because `window.ts` hard-coded the Angular path and the main
 * process was out of scope for the rewrite tasks.
 *
 * `packages/renderer` is now the React renderer, so `window.ts` loads it
 * directly and the redirect is gone with the option, the env var and the
 * per-target font table. That is worth ~790ms per launch (measured Task 20:
 * `react=1301ms` vs `angular=510ms` launch-to-window), and at ~160 launches a
 * full run, roughly two minutes.
 *
 * The isolation that made the redirect safe is unchanged and still load-bearing
 * on its own: the per-launch `mkdtemp` userData dir below means whatever a boot
 * writes goes to a directory deleted in `withJoinery`'s `finally`.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Playwright's TS loader emits CJS, so `__dirname` is available natively.
// Avoiding `import.meta.url` keeps this helper loadable from playwright specs.
const REPO_ROOT = join(__dirname, '..', '..');
const MAIN_ENTRY = join(REPO_ROOT, 'packages', 'main', 'dist', 'index.js');

/**
 * macOS's three scroller-style settings, spelled as Cocoa's `AppleShowScrollBars` preference does.
 *
 * `Always` is legacy (space-taking) scrollbars, `WhenScrolling` is overlay, and `Automatic` — the
 * system default — resolves to one of the two from the attached pointing device. See
 * `LaunchOptions.macScrollBarStyle` for why a test would pin it.
 */
export type MacScrollBarStyle = 'Always' | 'Automatic' | 'WhenScrolling';

const MAC_SCROLL_BAR_STYLES: readonly MacScrollBarStyle[] = [
  'Always',
  'Automatic',
  'WhenScrolling',
];

/** The built renderer `window.ts` loads under `NODE_ENV=production`. */
const RENDERER_INDEX = join(REPO_ROOT, 'packages', 'renderer', 'dist', 'browser', 'index.html');

/**
 * The faces the renderer actually paints with, forced before any assertion —
 * see the `document.fonts.load` block below for why passively awaiting
 * `document.fonts.ready` is not enough.
 *
 * **Re-verified against the shipped CSS at Task 20**, which is the check PLAN.md
 * asks for — a face list is only useful if every entry resolves:
 *
 *  - the three families are exactly the ones `theme.css:267-274` binds to
 *    `--font-display` / `--font-interface` / `--font-technical`, and the
 *    `@import`s at `theme.css:40-45` are what provide them;
 *  - `"Archivo Variable"` at 800 is real: `@fontsource-variable/archivo/wdth.css`
 *    declares `font-weight: 100 900` on that family, so the display weight the
 *    brand uses (Archivo Narrow ExtraBold, reproduced from the variable family)
 *    is inside the range rather than being synthesised;
 *  - IBM Plex Mono is a static family here, and only 400 and 500 are imported —
 *    which is why the list asks for those two and no others.
 *
 * There is no Material Icons entry because there is no icon font: the renderer
 * draws its icons as lucide SVGs.
 */
const RENDERER_FONTS: readonly string[] = [
  '400 1em "Instrument Sans Variable"',
  '500 1em "Instrument Sans Variable"',
  '800 1em "Archivo Variable"',
  '400 1em "IBM Plex Mono"',
  '500 1em "IBM Plex Mono"',
];

/**
 * The Keychain service every Electron launch in this repo stores credentials under.
 *
 * ── Why a launch needs to say anything about the keychain at all (J-96) ────────────────────
 *
 * The per-launch `--user-data-dir` in `launchJoinery` isolates everything the app writes to DISK,
 * and it is easy to read that as isolating the app. It does not: `CredentialStore` keeps its vault in the macOS login
 * keychain, which is scoped to the logged-in USER and namespaced only by a service name. So
 * before this constant every test launch read, rewrote and left entries in the same item the
 * INSTALLED Joinery uses — a developer's real connection passwords and AI provider keys.
 *
 * That is not a theoretical leak. `seedAiProvider` (tests/helpers/react/chat.ts) flips
 * `apiKeyConfigured`, which is all the renderer gates the chat UI on; the key itself comes from
 * the vault. On a machine where a real key had ever been saved, a spec that sent a message would
 * have made a real, billed LLM call and stayed green.
 *
 * ── Why one stable name rather than one per launch ─────────────────────────────────────────
 *
 * A per-launch name would be marginally more hermetic and would leave a new orphan keychain item
 * behind on every run, forever — nothing in a Playwright teardown can delete a keychain entry
 * without loading keytar into the test process. Each launch already gets fresh profile UUIDs from
 * its fresh user-data dir, so there is nothing for two runs to collide over inside the vault. One
 * obviously-named item a developer can find and delete is the better trade.
 *
 * Read by `packages/main/src/services/keychain/service-name.ts`, whose
 * `keychain-service-isolation.spec.ts` fails the unit tier if a launcher here ever stops setting
 * it.
 */
export const TEST_KEYCHAIN_SERVICE = 'ca.adam11.joinery.tests';

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  /** Per-launch userData dir (isolated tmp). Cleaned up by withJoinery. */
  userDataDir: string;
}

export interface LaunchOptions {
  /**
   * Extra env vars to merge over the default Joinery launch env. Useful
   * for tests that need to perturb the host (e.g. restricting PATH so
   * the CLI dep probe fails and the missing-tools view renders).
   *
   * Wins over every default except the keychain service pin, which is applied after these for
   * the reason given on {@link TEST_KEYCHAIN_SERVICE}: which vault the app under test writes to
   * is a safety property of the tier, not a per-spec knob.
   */
  envOverrides?: Record<string, string>;
  /**
   * Pin the window's device pixel ratio, in device pixels per CSS pixel.
   *
   * **Omitted by default, and that is deliberate: the functional tiers launch exactly as they always
   * did.** Only the visual tier passes it (`tests/e2e-react-visual/fixtures.ts`), because only a
   * screenshot cares.
   *
   * ── The defect this exists to prevent (J-21, ledger Ruling 5) ──────────────────────────────
   *
   * The Angular visual tier is RED for two reasons, and the second one is not about pixels at all:
   * its baselines were captured on a display that reported `devicePixelRatio: 2`, so every PNG is
   * 2800×1800 for a 1400×900 window. A run whose window reports `1` produces a 1400×900 image, and
   * `toHaveScreenshot` compares SIZES before it compares content — so the tier fails with a
   * geometry mismatch on a machine where the UI is byte-identical, and the failure says nothing
   * about the UI. Nothing in that tier states a DPR anywhere, so which of the two a developer gets
   * is a property of the display they happen to be on.
   *
   * **Playwright's own `use.deviceScaleFactor` cannot fix it here.** That option is applied by
   * `browser.newContext`, and this suite has no browser context: `_electron.launch` starts a real
   * Electron whose windows are created by `packages/main/src/window.ts`. Setting it in the config
   * would type-check, do nothing, and read as though the tier were pinned. The honest lever is
   * Chromium's own `--force-device-scale-factor`, which Electron passes through to the compositor —
   * the same mechanism `--user-data-dir` above is honoured by. It scales rasterization only:
   * `BrowserWindow`'s width/height are CSS pixels either way, so the layout under test is unchanged
   * and only the image's pixel dimensions move.
   *
   * The visual tier asserts `window.devicePixelRatio` equals what it asked for, so a switch that
   * ever stopped being honoured fails there rather than silently re-introducing the trap.
   */
  deviceScaleFactor?: number;
  /**
   * Pin macOS's scroller style for this process, as the `AppleShowScrollBars` preference names it.
   *
   * **Omitted by default, exactly like `deviceScaleFactor` above: absent, the argv is byte-identical
   * to what it always was**, so the functional tiers launch as they always did. Only the visual tier
   * passes it, because only a screenshot cares.
   *
   * ── The defect this exists to prevent ─────────────────────────────────────────────────────────
   *
   * macOS has two scroller styles. *Legacy* scrollbars take layout space — a scrolling container is
   * 15 CSS px narrower inside than out — while *overlay* scrollbars float above the content and take
   * none. The React renderer ships no `::-webkit-scrollbar` rules, so the platform's choice is the
   * app's layout: every scrolling panel's content reflows by 15px between the two modes.
   *
   * The system default is `Automatic`, and macOS resolves *that* from the pointing device attached
   * at the time — plug in a mouse and it becomes legacy, unplug it and it becomes overlay. So which
   * mode a baseline is captured in, and which one it is later compared in, is a property of what was
   * on the developer's desk. Measured on this tier: baselines captured in legacy mode fail 3 of 22
   * outright in overlay mode, with a fourth passing only inside the pixel tolerance — a red tier that
   * says nothing about the UI, which is the same class of defect as the DPR trap above.
   *
   * ── Why argv, and the probe that says it is honoured ──────────────────────────────────────────
   *
   * Cocoa builds an `NSArgumentDomain` from the process's own argv: a `-key value` pair becomes a
   * `NSUserDefaults` entry for this process only, and it outranks every persisted domain. So this is
   * a *per-launch* pin that never touches the user's settings — no `defaults write`, nothing to clean
   * up, nothing that can leak into another app or survive a crashed run.
   *
   * That Electron/Chromium actually honours it was verified rather than assumed (throwaway probe,
   * measuring `offsetWidth - clientWidth` of a scrolling div inside a CSS-free iframe):
   *
   * | launch | scrollbar gutter |
   * | --- | --- |
   * | no pin (host resolves `Automatic`) | **0 px** (overlay) |
   * | `-AppleShowScrollBars Always` | **15 px** (legacy) |
   * | `-AppleShowScrollBars WhenScrolling` | 0 px |
   * | `-AppleShowScrollBars Automatic` | 0 px |
   *
   * The visual tier measures that same gutter after launch and asserts the mode it asked for, so an
   * Electron that stopped honouring the argument domain fails there instead of quietly re-arming the
   * trap. macOS-only by nature; the visual tier is macOS-only anyway (its fixture paths are POSIX
   * literals).
   *
   * The long-term structural alternative — styling the app's scrollbars so the platform mode stops
   * mattering — is a `packages/` change and is recorded in `plans/renderer-rewrite/PLAN.md`.
   */
  macScrollBarStyle?: MacScrollBarStyle;
  /**
   * Write files into the launch's isolated user-data directory before Electron starts.
   *
   * **Omitted by default**, like the two options above, so a launch that does not ask for it is
   * byte-identical to what it always was. The directory is a fresh `mkdtemp` per launch and is the
   * one `--user-data-dir` points at, so anything written here is thrown away with it.
   *
   * ── What it is for, and why nothing else would do ──────────────────────────────────────────
   *
   * Some state the app reads at STARTUP has no IPC channel to write it through. `ChatService` loads
   * `<userData>/chat-history/*.json` in its constructor, so a conversation that already contains 50
   * messages and one still streaming — the state Task 23's chat benchmark needs before it injects a
   * single chunk — can only be produced by putting the file there first. Driving the UI to build one
   * would mean calling an LLM, which no tier does.
   *
   * The alternative was for the perf tier to fork the launcher, which would have made "the app under
   * test" mean something different in that tier than in every other one. A four-line, opt-in hook on
   * the one launcher is the smaller price.
   *
   * Runs synchronously, before `electron.launch`, so the files are there when the main process reads
   * them. A throw propagates and no app is started.
   */
  seedUserData?: (userDataDir: string) => void;
}

export async function launchJoinery(options: LaunchOptions = {}): Promise<LaunchedApp> {
  // Argument preconditions first, before anything is created — a throw below the `mkdtemp` would
  // leak the user-data dir it had already made (Task 22 review, M1).
  //
  // Both checks are opt-in: an option that was not passed contributes no argv at all, so an
  // unpinned launch's command line is byte-identical to what it was before either existed.
  if (options.deviceScaleFactor !== undefined && !(options.deviceScaleFactor > 0)) {
    throw new Error(
      `[electron-app] deviceScaleFactor must be a positive number, got ${String(options.deviceScaleFactor)}`
    );
  }
  if (
    options.macScrollBarStyle !== undefined &&
    !MAC_SCROLL_BAR_STYLES.includes(options.macScrollBarStyle)
  ) {
    throw new Error(
      `[electron-app] macScrollBarStyle must be one of ${MAC_SCROLL_BAR_STYLES.join(', ')}, ` +
        `got ${JSON.stringify(options.macScrollBarStyle)}`
    );
  }

  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `[electron-app] expected built main process at ${MAIN_ENTRY}. ` +
        `Run \`pnpm run build\` first.`
    );
  }
  if (!existsSync(RENDERER_INDEX)) {
    throw new Error(
      `[electron-app] expected the renderer build at ${RENDERER_INDEX}. ` +
        `Run \`pnpm run build\` first.`
    );
  }

  // Isolated user-data dir per launch so any profiles / settings created
  // during a test never leak into the next launch (which would shift the
  // welcome screen baseline once a saved profile starts showing up there).
  // The --user-data-dir flag is honored by Electron and routes electron-store
  // into the temp dir. It does NOT touch the keychain: the login keychain is a
  // per-USER store with no per-profile namespace, which is what
  // TEST_KEYCHAIN_SERVICE below exists to handle (J-96).
  const userDataDir = mkdtempSync(join(tmpdir(), 'joinery-test-userdata-'));

  // Before the app exists, because the state this writes is read at startup. A throw here leaves a
  // temp directory behind and no Electron process, which is the safe half of the two.
  options.seedUserData?.(userDataDir);

  // Both spreads are empty unless the caller asked, so an unpinned launch's argv is byte-identical
  // to what it was. See each option's own documentation for the defect it prevents.
  const scaleFactorArgs =
    options.deviceScaleFactor === undefined
      ? []
      : [`--force-device-scale-factor=${options.deviceScaleFactor}`];
  // A Cocoa `-key value` pair, not a Chromium `--switch`: it lands in this process's
  // NSArgumentDomain and is read from there by AppKit. Two argv entries, deliberately.
  const scrollBarArgs =
    options.macScrollBarStyle === undefined
      ? []
      : ['-AppleShowScrollBars', options.macScrollBarStyle];

  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, ...scaleFactorArgs, ...scrollBarArgs],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // JOINERY_TEST signals the main process to skip non-essential startup
      // (currently: keep the window hidden so it doesn't flash during tests).
      JOINERY_TEST: '1',
      // Force production mode so the main process loads the built renderer
      // from disk instead of trying to connect to localhost:4200.
      NODE_ENV: 'production',
      // Surface main-process console output so test failures around IPC /
      // connection / keytar are diagnosable.
      ELECTRON_ENABLE_LOGGING: '1',
      // Per-test overrides land here so they win over the defaults above.
      ...(options.envOverrides ?? {}),
      // Last, and deliberately past the overrides: no spec may aim the credential store at the
      // real vault. See TEST_KEYCHAIN_SERVICE for what that would cost.
      JOINERY_KEYCHAIN_SERVICE: TEST_KEYCHAIN_SERVICE,
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await forceFonts(window);
  return { app, window, userDataDir };
}

/**
 * Self-hosted fonts load async (font-display: swap), so screenshots can race
 * font loading and visual baselines flip between fallback-font and real
 * renders. Passively watching document.fonts.status is NOT enough — it reads
 * "loaded" before any text has even requested a face. Force every face the
 * renderer uses, then await completion.
 *
 * String form keeps this file free of the DOM lib (the tests tsconfig targets
 * node), which is also why the face list is interpolated rather than passed as
 * an argument.
 */
export async function forceFonts(window: Page): Promise<void> {
  const loads = RENDERER_FONTS.map(face => `document.fonts.load(${JSON.stringify(face)})`).join(
    ',\n      '
  );
  await window.evaluate(`(async () => {
    await Promise.all([
      ${loads},
    ]);
    await document.fonts.ready;
  })()`);
}

/**
 * Convenience wrapper that guarantees teardown even if the test body throws.
 *
 * `optionsOrFn` keeps the original 1-arg form (`withJoinery(fn)`) working
 * while letting newer tests pass launch options too: `withJoinery({
 * envOverrides }, fn)`.
 */
export async function withJoinery<T>(fn: (launched: LaunchedApp) => Promise<T>): Promise<T>;
export async function withJoinery<T>(
  options: LaunchOptions,
  fn: (launched: LaunchedApp) => Promise<T>
): Promise<T>;
export async function withJoinery<T>(
  optionsOrFn: LaunchOptions | ((launched: LaunchedApp) => Promise<T>),
  maybeFn?: (launched: LaunchedApp) => Promise<T>
): Promise<T> {
  const [options, fn]: [LaunchOptions, (launched: LaunchedApp) => Promise<T>] =
    typeof optionsOrFn === 'function' ? [{}, optionsOrFn] : [optionsOrFn, maybeFn!];
  const launched = await launchJoinery(options);
  try {
    return await fn(launched);
  } finally {
    /* eslint-disable no-console --
       Cleanup failures in a `finally` cannot be rethrown: doing so would replace whatever the test
       actually failed with, and the message a reader needs would be gone. They cannot be swallowed
       either (house rule), so they are printed. `console` is the only reporting channel a Playwright
       helper has — there is no logger in this process and no test context to attach to at this
       point in the teardown. */
    try {
      await launched.app.close();
    } catch (err) {
      console.error('[electron-app] failed to close Joinery cleanly:', err);
    }
    try {
      rmSync(launched.userDataDir, { recursive: true, force: true });
    } catch (err) {
      console.error('[electron-app] failed to clean userData dir:', err);
    }
    /* eslint-enable no-console */
  }
}
