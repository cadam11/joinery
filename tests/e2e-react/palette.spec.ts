/**
 * The command palette in the real app — the surface PLAN.md 0.4 was written about.
 *
 * The unit tier owns the exhaustive walk over every row (`command-palette.spec.tsx`). What this adds
 * is the part a unit test cannot: that in the **shipped bundle**, with the real shell mounted and a
 * real connection open, choosing a palette row makes something happen — and that the rows whose
 * owners have not shipped are visibly disabled rather than quietly dead.
 *
 * There was no Angular equivalent of this spec. There could not have been: ten of that palette's
 * entries dispatched `CustomEvent`s nothing listened for, and a test that clicked one and asserted
 * "the palette closed" would have passed.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  closeOverlay,
  connectFromSidebar,
  createPostgresProfile,
  ensureJoineryTestSeeded,
  executeQuery,
  filterOverlay,
  openPalette,
  openPaletteFromEditor,
  openQueryTab,
  openShortcuts,
  overlayRows,
  paletteRow,
  paletteRowState,
  resolvedTheme,
  runPaletteCommand,
  selectDatabase,
  typeSql,
  withJoineryReact,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Test PG';

test.beforeAll(ensureJoineryTestSeeded);

/** A connection and a database, which is what the connection-gated entries need. */
async function connected(window: Page): Promise<void> {
  await createPostgresProfile(window, PROFILE);
  await connectFromSidebar(window, PROFILE);
  await selectDatabase(window, 'joinery_test');
}

test.describe('Joinery — the command palette', () => {
  test('opens on ⌘K or ⇧⌘P, filters, and closes on Escape', async () => {
    await withJoineryReact(async ({ window }) => {
      await openPalette(window);
      const total = await overlayRows(window, 'palette').count();
      expect(total).toBeGreaterThan(20);

      await filterOverlay(window, 'palette', 'sidebar');
      await expect(overlayRows(window, 'palette')).toHaveCount(1);
      await expect(window.getByTestId('palette-count')).toHaveText(`1 of ${total}`);

      await closeOverlay(window, 'palette');

      // The second binding, asserted here rather than only implied by `openPaletteFromEditor`:
      // ⇧⌘P is the chord the Angular tier's `ui-actions.spec.ts` drove, and it exists because it is
      // VS Code muscle memory (`palette-actions.ts`). Both must reach the same overlay, and it must
      // open with the filter cleared rather than remembering the last search.
      await openPaletteFromEditor(window);
      await expect(overlayRows(window, 'palette')).toHaveCount(total);
      await closeOverlay(window, 'palette');
    });
  });

  test('runs a command that a real handler owns', async () => {
    await withJoineryReact(async ({ window }) => {
      await expect(window.getByTestId('sidebar')).toBeVisible();

      await openPalette(window);
      await runPaletteCommand(window, 'command:toggle-sidebar');

      // The observable effect of the command, not the palette's own closing: `toggle-sidebar` is one of
      // the eleven the Task 7 shell owns, and the pane is what it moves.
      await expect(window.getByTestId('sidebar')).toBeHidden();

      await openPalette(window);
      await runPaletteCommand(window, 'command:toggle-sidebar');
      await expect(window.getByTestId('sidebar')).toBeVisible();
    });
  });

  test('runs a local action — the theme entries repaint the app', async () => {
    await withJoineryReact(async ({ window }) => {
      await openPalette(window);
      await runPaletteCommand(window, 'action:theme-ivory');
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

      await openPalette(window);
      await runPaletteCommand(window, 'action:theme-ink');
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await resolvedTheme(window)).toBe('dark');
    });
  });

  test('opens another surface: the palette reaches the cheatsheet, and it is derived', async () => {
    await withJoineryReact(async ({ window }) => {
      await openPalette(window);
      await runPaletteCommand(window, 'command:show-shortcuts');

      const dialog = window.getByTestId('shortcuts-dialog');
      await expect(dialog).toBeVisible();
      const rows = dialog.getByTestId('shortcuts-row');
      expect(await rows.count()).toBeGreaterThan(15);
      // ⌘\ is Toggle Sidebar in `menu.ts`, and the sheet reads its keys from the same table the palette
      // does — so a drifted accelerator would be a wrong label here as well as a failing unit test.
      await expect(
        dialog.getByTestId('shortcuts-row').filter({ hasText: 'Toggle sidebar' })
      ).toContainText('⌘\\');
    });
  });

  test('the same cheatsheet arrives from Help ▸ Keyboard Shortcuts', async () => {
    await withJoineryReact(async ({ app, window }) => {
      const dialog = await openShortcuts(app, window);
      // Every row says where its keystroke is bound — the distinction between a menu accelerator and a
      // renderer keydown, which is why ⌘K works in a text field and ⌘S does not reach the renderer.
      await expect(dialog.getByTestId('shortcuts-row-source').first()).toHaveText(
        /Menu|App|Editor/
      );
    });
  });

  test('shows an unowned command disabled, naming the task that owes it', async () => {
    await withJoineryReact(async ({ window }) => {
      // The server-properties surface has no consumer yet. The palette lists it — hiding it would teach
      // the user nothing — and marks it inert with the owner the registry names. This is J-44's rule
      // applied to commands, and it is what the ten dead Angular entries needed.
      //
      // The row this test needs is a command that is unowned AND whose precondition is MET, because
      // `unavailable` (a requirement not met) is reported ahead of `unowned`. It was
      // `open-query-history` until Task 19a shipped that dialog, then `start-tour` until Task 19b shipped
      // the tour — and both of those needed nothing. Every id still unowned carries `NEEDS_CONNECTION`,
      // so this test now connects first, which is a stronger check anyway: it proves the two states are
      // reported in the documented order rather than avoiding the question.
      await connected(window);
      await openPalette(window);

      expect(await paletteRowState(window, 'command:show-server-properties')).toBe('unowned');
      const row = paletteRow(window, 'command:show-server-properties');
      await expect(row).toHaveAttribute('data-disabled', 'true');
      await expect(row).toContainText('Not wired yet');
      await expect(row).toContainText(/Task \d+/);

      // And a click does nothing at all: the overlay stays up, because an inert row is not a dismissal.
      await row.click({ force: true });
      await expect(window.getByTestId('palette-overlay')).toBeVisible();
    });
  });

  test('gates the connection-dependent entries until something is connected', async () => {
    await withJoineryReact(async ({ window }) => {
      await openPalette(window);
      expect(await paletteRowState(window, 'command:open-backup-dialog')).toBe('unavailable');
      await expect(paletteRow(window, 'command:open-backup-dialog')).toContainText(
        'Connect to a server first'
      );
      await closeOverlay(window, 'palette');

      await connected(window);

      await openPalette(window);
      expect(await paletteRowState(window, 'command:open-backup-dialog')).toBe('ready');
      // And it really opens the dialog Task 12 built.
      await runPaletteCommand(window, 'command:open-backup-dialog');
      await expect(window.getByTestId('backup-dialog')).toBeVisible({ timeout: 20_000 });
    });
  });

  test('offers a query that has been run, and re-opens it without executing it', async () => {
    await withJoineryReact(async ({ window }) => {
      await connected(window);
      await typeSql(window, 'SELECT id, email FROM customers ORDER BY id');
      await executeQuery(window);

      await openPalette(window);
      await filterOverlay(window, 'palette', 'customers');
      const recent = overlayRows(window, 'palette').filter({ hasText: 'FROM customers' }).first();
      await expect(recent).toBeVisible({ timeout: 20_000 });
      await recent.click();

      // A new tab with the SQL in it, and NOT running: only an affordance whose label promises a run may
      // execute on open (Ruling 13). The status bar's executing indicator is the observable form of that.
      await expect(window.getByTestId('status-executing')).toBeHidden();
      const editor = await openQueryTab(window);
      await expect(editor.locator('.view-lines')).toContainText('FROM customers');
    });
  });
});
