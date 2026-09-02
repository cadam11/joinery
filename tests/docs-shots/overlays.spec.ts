/**
 * Documentation shots — the four surfaces that float over the workbench.
 *
 * All four are captured as ELEMENTS. An overlay's job is to be a legible card over a dimmed app, and
 * framing the window would put whatever happens to be behind it into the picture — which, for a page
 * about the palette, is a page about the workspace.
 *
 * Each is opened the way its page tells a reader to open it: ⌘K for the palette, ⌘P for object
 * search, ⌥⌘S for the snippet library, Help ▸ Keyboard Shortcuts for the cheatsheet. So these shots
 * are also a check that the documented path works.
 */

import { blurFocus, capture, expect, test, withDocsApp } from './fixtures';
import { PAGE_THEMES } from './catalogue';
import {
  connectFromSidebar,
  createPostgresProfile,
  createSnippet,
  dismissToasts,
  ensureJoineryTestSeeded,
  objectSearchRow,
  openObjectSearch,
  openPalette,
  openShortcuts,
  openSnippets,
  overlayRows,
  selectDatabase,
  snippetRow,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Local Postgres';
const DATABASE = 'joinery_test';

/** A snippet with a name, a tag and a body — the library is empty until something is in it. */
const SNIPPET = {
  name: 'Recent orders by customer',
  tags: 'orders, reporting',
  sql: [
    'SELECT c.full_name, o.status, o.total_cents',
    'FROM orders o',
    'JOIN customers c ON c.id = o.customer_id',
    'ORDER BY o.order_date DESC;',
  ].join('\n'),
} as const;

test.beforeAll(ensureJoineryTestSeeded);

for (const theme of PAGE_THEMES) {
  test.describe(`docs shots — overlays, ${theme}`, () => {
    test('the command palette', async () => {
      await withDocsApp(theme, async ({ window }) => {
        await createPostgresProfile(window, PROFILE);
        await connectFromSidebar(window, PROFILE);
        await selectDatabase(window, DATABASE);
        await dismissToasts(window);
        // Connecting can open a query tab on its own, so focus may be in Monaco by now. J-73 made
        // ⌘K work from there — `editor/sql-editor.tsx` releases the keystroke back to the window —
        // so this is no longer a workaround for a swallowed key. It stays because a focused editor
        // draws a caret and a focus ring behind the overlay, and a docs screenshot should not change
        // depending on whether the sidebar happened to open a tab.
        await blurFocus(window);

        const palette = await openPalette(window);
        // Connected on purpose: roughly half the catalogue is `unavailable` without a connection,
        // and the row treatment for an available command is the one a reader will see.
        await expect(overlayRows(window, 'palette').first()).toBeVisible();
        // No query has run in this launch, so there is no "recent queries" section — which keeps
        // the row list a function of the catalogue rather than of history.
        await expect(window.locator('[data-palette-key^="recent:"]')).toHaveCount(0);

        await capture(
          palette,
          'command-palette',
          theme,
          'The command palette over a connected app'
        );
      });
    });

    test('object search', async () => {
      await withDocsApp(theme, async ({ window }) => {
        await createPostgresProfile(window, PROFILE);
        await connectFromSidebar(window, PROFILE);
        await selectDatabase(window, DATABASE);
        await dismissToasts(window);
        await blurFocus(window);

        const overlay = await openObjectSearch(window);
        // A named fixture object, so the shot is provably of a loaded index rather than of an
        // overlay still fetching one.
        await expect(objectSearchRow(window, 'public.products')).toBeVisible();
        await capture(
          overlay,
          'object-search',
          theme,
          'The object search overlay listing the loaded schema'
        );
      });
    });

    test('the snippet library', async () => {
      await withDocsApp(theme, async ({ window }) => {
        // No connection: the library is app state, not database state, and a page about saving SQL
        // should not imply a server is needed to look at it.
        const overlay = await openSnippets(window);
        await createSnippet(window, SNIPPET);
        await expect(snippetRow(window, SNIPPET.name)).toBeVisible();
        await blurFocus(window);
        await capture(overlay, 'snippets', theme, 'The snippet library with a saved snippet');
      });
    });

    test('the keyboard cheatsheet', async () => {
      await withDocsApp(theme, async ({ app, window }) => {
        const dialog = await openShortcuts(app, window);
        await expect(dialog).toBeVisible();
        await blurFocus(window);
        await capture(dialog, 'keyboard-shortcuts', theme, 'The keyboard cheatsheet');
      });
    });
  });
}
