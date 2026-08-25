/**
 * Launching the React renderer, and the three things every other module in this directory needs:
 * the two timeout budgets, the exact-match text matcher, and the native-menu channel.
 *
 * ── Why this directory exists ────────────────────────────────────────────────
 *
 * `tests/helpers/joinery-actions-react.ts` accreted one section per Phase B task and reached 1,737
 * lines. Task 20 split it here, one module per surface family, and left that file as a barrel so no
 * spec's imports had to move — which is what makes the split provably behaviour-preserving: the
 * suite that was green before the split is byte-identical after it.
 *
 * ── Locator rules, and they are the whole point ──────────────────────────────
 *
 *  - `data-testid` for anything this suite asserts on or drives;
 *  - ARIA roles and states where the platform already names the thing (`role="menuitem"`,
 *    `aria-level`, `aria-expanded`) — those are contracts, not implementation details;
 *  - **zero** structural classes, zero component-library internals, zero icon ligature text —
 *    except the three documented vendor exemptions (Monaco, AG Grid, Dockview), each of which is
 *    confined to the one module that owns that surface and carries its own rationale.
 *
 * The seeded database fixtures below — `TEST_PG` and `ensureJoineryTestSeeded` — are about the
 * *container*, not the UI. They lived in `tests/helpers/joinery-actions.ts` while that file existed
 * and moved here unchanged at Task 24, when the Angular tier and its Material-coupled helper were
 * deleted.
 */

import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { Client as PgClient } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withJoinery, type LaunchOptions, type LaunchedApp } from '../electron-app';

// Test PG container connection details (matches docker-compose.test.yml).
export const TEST_PG = {
  host: '127.0.0.1',
  port: 15432,
  user: 'joinery',
  password: 'joinery',
  database: 'joinery_test',
} as const;

/**
 * Idempotently seed the default `joinery_test` database with the synthetic
 * schema + data so functional / visual specs that connect via the UI find
 * a populated database. The integration tier uses isolated per-test DBs
 * via `withFreshDatabase` and never touches `joinery_test`.
 *
 * Two distinct schemas are seeded:
 *   - `public.*` — synthetic e-commerce (products / customers / orders /
 *     order_items). Used by everyday spec/visual tests.
 *   - `app_meta.*` — minimal app-metadata shape (user / application / entity)
 *     in a non-public schema. Used by the cross-schema-query regression
 *     tests; row counts chosen to match the legacy 31-suite expectations
 *     (11 applications, 24 entities).
 *
 * Each schema's presence is checked independently so adding either to an
 * existing seeded database doesn't redo the other.
 */
export async function ensureJoineryTestSeeded(): Promise<void> {
  const client = new PgClient({ ...TEST_PG });
  await client.connect();
  try {
    const fixturesRoot = join(__dirname, '..', '..', 'fixtures', 'postgres');

    // Public e-commerce schema.
    const ecomSeeded = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products'"
    );
    if (!(ecomSeeded.rowCount && ecomSeeded.rowCount > 0)) {
      await client.query(readFileSync(join(fixturesRoot, 'schema.sql'), 'utf8'));
      await client.query(readFileSync(join(fixturesRoot, 'seed.sql'), 'utf8'));
    }

    // app_meta schema.
    const appMetaSeeded = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'app_meta' AND table_name = 'entity'"
    );
    if (!(appMetaSeeded.rowCount && appMetaSeeded.rowCount > 0)) {
      await client.query(readFileSync(join(fixturesRoot, 'app-meta-schema.sql'), 'utf8'));
      await client.query(readFileSync(join(fixturesRoot, 'app-meta-seed.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

/** How long a real connect to the seeded container is allowed to take. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** Everything else: a store write plus a React commit. */
export const UI_TIMEOUT_MS = 10_000;

/**
 * The seeded MySQL container, mirroring `TEST_PG`.
 *
 * Declared here rather than imported from `db-fixtures.ts` for the reason `TEST_PG`'s own comment
 * gives: that module is the integration tier's, and this tier only needs the four connection facts.
 * The values match `TEST_CONNECTIONS.mysql` there.
 */
export const TEST_MYSQL = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: 'joinery',
  database: 'joinery_test',
} as const;

/**
 * An anchored regex for `filter({ hasText })`, so a filter means "is this text" and not
 * "contains this text".
 *
 * Playwright's `hasText` is a case-insensitive **substring** match on a string, and a whole class
 * of this suite's frailty lived there: `treeRow(window, 'orders')` also matched an
 * `orders_archive` row, `selectDatabase(window, 'joinery_test')` also matched a
 * `joinery_test_copy` menu item, and a `.first()` at the end of the chain turned the ambiguity into
 * a silently wrong target rather than an error. A `RegExp` `hasText` is matched against the
 * element's text instead, so anchoring it is exact.
 *
 * The escape covers the characters a database or profile name may legally contain (`.` and `$` most
 * of all) — an unescaped `.` would make the anchors decorative.
 */
export function exactly(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

/**
 * `withJoinery` plus the boot gate: the body runs with the shell already on screen.
 *
 * It used to pin the launcher's `renderer` option to `react` as well — the launcher defaulted to
 * Angular while the two renderers coexisted, and `tests/e2e-react/fixtures.ts` carried a fixture
 * asserting every launch had gone through here. Task 24 deleted the Angular renderer, so both
 * halves went with it and what is left is the `waitForShell`, which every spec in the tier needs
 * before its first locator means anything.
 */
export async function withJoineryReact<T>(fn: (launched: LaunchedApp) => Promise<T>): Promise<T>;
export async function withJoineryReact<T>(
  options: LaunchOptions,
  fn: (launched: LaunchedApp) => Promise<T>
): Promise<T>;
export async function withJoineryReact<T>(
  optionsOrFn: LaunchOptions | ((launched: LaunchedApp) => Promise<T>),
  maybeFn?: (launched: LaunchedApp) => Promise<T>
): Promise<T> {
  const [options, fn] =
    typeof optionsOrFn === 'function'
      ? [{}, optionsOrFn]
      : [optionsOrFn, maybeFn as (launched: LaunchedApp) => Promise<T>];

  return withJoinery(options, async launched => {
    await waitForShell(launched.window);
    return fn(launched);
  });
}

/**
 * The boot gate: `AppShell` renders the startup screen until the stores are
 * hydrated (`renderer/src/shell/boot.ts`), so `app-shell` appearing is
 * the earliest moment any other locator means anything.
 */
export async function waitForShell(window: Page): Promise<void> {
  await expect(window.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId('sidebar')).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

/**
 * Dismiss every visible toast, so nothing overlaps the surface under assertion.
 *
 * Sonner stacks bottom-right and auto-dismisses after a few seconds; a save followed immediately by
 * an assertion on the status bar can race that. Bounded at ten so a toast that refuses to close fails
 * the loop's own cap rather than spinning.
 *
 * **Only callable with no modal dialog open**, and the assertion below enforces it rather than
 * letting the call hang for its full timeout. Radix sets `pointer-events: none` on `<body>` while a
 * modal is up and re-enables it only inside the dialog content, so a toast raised during a dialog is
 * visible (sonner's container sits far above the scrim's `z-40`) but inert until the dialog closes.
 * That is the correct modal contract — a modal blocks interaction with everything behind it — so this
 * helper states the precondition instead of working around it.
 */
export async function dismissToasts(window: Page): Promise<void> {
  // The modal precondition is gone with J-42: a toast over a dialog is clickable now, and the
  // dialog no longer treats that click as a click outside itself. The assertion stays as a
  // NARROWER one — it is still worth knowing which dialog is open when a toast refuses to go —
  // but it no longer forbids the combination.

  const closeButton = window.locator('[data-sonner-toast] [data-close-button]').first();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!(await closeButton.isVisible())) return;
    await closeButton.click();
    await expect(closeButton).toBeHidden({ timeout: UI_TIMEOUT_MS });
  }
  const openDialogs = await window.locator('[role="dialog"]').count();
  throw new Error(
    `[joinery-actions-react] more than ten toasts refused to dismiss (${openDialogs} dialog(s) open)`
  );
}

/**
 * Fires one of the native menu's `menu:*` channels from the main process.
 *
 * The only way to reach a menu-only command from this tier. Electron menu
 * accelerators are handled by the native menu, which CDP-injected keystrokes
 * never reach, and `Menu.getApplicationMenu()` item clicks would exercise
 * `menu.ts`'s own wiring rather than the renderer's — that wiring is
 * `packages/main`'s and is covered there. What this drives is the renderer half:
 * the channel arrives, `shell/menu-bridge.tsx` maps it to a command id, and the
 * command bus delivers it. Which is exactly the path a user takes when they pick
 * Query ▸ Execute Selection.
 */
export async function sendMenuCommand(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) throw new Error('no BrowserWindow to send a menu command to');
    window.webContents.send(name);
  }, channel);
}

/**
 * Every item in the real application menu, as `"Top ▸ Item"` paths.
 *
 * The companion to `sendMenuCommand`, and the half it deliberately cannot cover: that helper proves
 * the renderer reacts to a channel, but a channel nothing sends is still an unreachable feature.
 * This reads `Menu.getApplicationMenu()` — the menu the OS is actually showing — so a *missing* item
 * fails rather than passing quietly. One level deep, which is as deep as `menu.ts` goes.
 */
export async function applicationMenuPaths(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (menu === null) throw new Error('no application menu is set');
    return menu.items.flatMap(top =>
      (top.submenu?.items ?? []).map(item => `${top.label} ▸ ${item.label}`)
    );
  });
}

/**
 * Clicks **every** menu item carrying `label`, in the main process, and answers the channels their
 * handlers sent — one entry per send, in click order.
 *
 * `item.click()` runs the template's own handler, so this exercises the half `sendMenuCommand` skips
 * — that helper fires the channel itself and so cannot tell a wired menu item from a missing one.
 *
 * **All matches, not the first.** `menu.ts` deliberately duplicates some items across submenus —
 * Settings is in the macOS app menu *and* in Edit, and J-92's `AI Setup…` follows it into both. A
 * `find()` here would only ever have clicked the app-menu copy, so a second copy wired to the wrong
 * channel (or to nothing) would have passed. The caller compares the returned list against the
 * number of items it found in `applicationMenuPaths`, which makes every copy load-bearing.
 *
 * ── The two things this stands in for, and why each is honest ───────────────────────────────
 *
 *  - **`BrowserWindow.getFocusedWindow()`**. Every handler in `menu.ts` resolves its target that
 *    way, and under a headless Playwright launch nothing is focused, so the real handler would
 *    silently send to nobody. It is stubbed to the app's only window for the duration of the clicks —
 *    which is precisely what the OS reports when a user clicks the menu of the app they are in. The
 *    stub is a lambda over one window, not a general fake, and it is restored in `finally`.
 *  - **`webContents.send`**. Wrapped to record, and it still forwards, so the renderer really does
 *    receive the event. A handler that reached no window contributes nothing to the list and fails
 *    the caller's assertion rather than passing quietly.
 */
export async function clickMenuItem(app: ElectronApplication, label: string): Promise<string[]> {
  return app.evaluate(({ Menu, BrowserWindow }, wanted) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) throw new Error('no BrowserWindow for a menu click to reach');

    const menu = Menu.getApplicationMenu();
    if (menu === null) throw new Error('no application menu is set');
    const items = menu.items
      .flatMap(top => top.submenu?.items ?? [])
      .filter(candidate => candidate.label === wanted);
    if (items.length === 0) throw new Error(`no menu item labelled ${JSON.stringify(wanted)}`);

    const sent: string[] = [];
    const contents = window.webContents;
    const originalSend = contents.send.bind(contents);
    const originalFocused = BrowserWindow.getFocusedWindow;

    contents.send = (channel: string, ...args: unknown[]) => {
      sent.push(channel);
      originalSend(channel, ...args);
    };
    BrowserWindow.getFocusedWindow = () => window;
    try {
      // Bounded by the number of matching items, which is a property of the static template.
      for (const item of items) item.click();
    } finally {
      contents.send = originalSend;
      BrowserWindow.getFocusedWindow = originalFocused;
    }
    return sent;
  }, label);
}
