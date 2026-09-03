/**
 * The React query editor, against the seeded PostgreSQL container.
 *
 * Replaces `tests/e2e/query-editor.spec.ts`, whose four locators (`.query-toolbar:visible`,
 * `.monaco-editor:visible`, `.view-line`, `mat-icon:text("history")`) between them encode two things
 * that are no longer true: that the toolbar and the editor need a `:visible` filter because Golden
 * Layout kept every inactive tab's Monaco in the document, and that icons are ligature text. PLAN.md's
 * Task 20 trap (b) says to assert the new behaviour rather than inherit the workaround, and the first
 * test below does exactly that.
 *
 * What this tier is for, and what it is not: it proves Monaco really mounts, tokenizes, completes and
 * takes keystrokes **inside the packaged main process over a real connection** — the things a jsdom test
 * cannot reach at all. Colour measurement, contrast and the theme screenshots belong to the browser
 * gate (`.superpowers/sdd/PLAN/task-10-gate.mjs`), and the wrapper's decisions are covered by
 * `sql-editor.spec.tsx`.
 */

import { expect, test } from '@playwright/test';
import {
  connectFromSidebar,
  createPostgresProfile,
  ensureJoineryTestSeeded,
  executeQuery,
  focusEditor,
  gridColumnHeaders,
  openNodeMenu,
  openQueryTab,
  queryEditor,
  selectDatabase,
  sendMenuCommand,
  suggestionsContaining,
  typeSql,
  visibleSql,
  withJoineryReact,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Test PG';

test.beforeAll(ensureJoineryTestSeeded);

/** Connect, pick the seeded database, and land in a query tab. */
async function readyEditor(window: Parameters<typeof openQueryTab>[0]) {
  await createPostgresProfile(window, PROFILE);
  await connectFromSidebar(window, PROFILE);
  await selectDatabase(window, 'joinery_test');
  return openQueryTab(window);
}

test.describe('Joinery (React) — the query editor', () => {
  test('mounts one Monaco per visible group, and tokenizes SQL with the brand theme', async () => {
    await withJoineryReact(async ({ window }) => {
      const editor = await readyEditor(window);
      await typeSql(window, "SELECT id FROM customers WHERE email = 'x' -- note");

      // The "exactly one `.monaco-editor`" assertion that used to live here has MOVED to `a
      // re-activated tab keeps its SQL and its measurements`, and the Task 20 review is why: with a
      // single query tab open, `toHaveCount(1)` cannot fail for the regression it claimed to guard —
      // a Dockview that started keeping detached panels mounted would still leave one editor in a
      // document that only ever had one. The count is only evidence with TWO tabs open and one of them
      // inactive, which is the state that test already sets up.

      // Tokenized, which means the `sql` tokenizer's lazy chunk resolved from inside the bundle. More
      // than one `.mtk*` class is the proof: an untokenized document renders every character in one.
      const tokenClasses = await editor
        .locator('.view-line span[class^="mtk"]')
        .evaluateAll(nodes => Array.from(new Set(nodes.map(node => node.className))));
      expect(tokenClasses.length).toBeGreaterThan(3);

      // And the theme that is live is OURS. Asserted on the painted background rather than on a class
      // name, because the background is the thing a user sees and Monaco's stock themes have their own
      // (`#1e1e1e` for vs-dark, `#fffffe` for vs) — neither of which is a Joinery canvas.
      const background = await editor
        .locator('.monaco-editor-background')
        .evaluate(node => getComputedStyle(node).backgroundColor);
      expect(['rgb(23, 24, 23)', 'rgb(242, 239, 231)']).toContain(background);
    });
  });

  test('typing makes the tab dirty and drives the status bar caret readout', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);

      // Nothing typed yet: no caret readout, because Task 7's segment hides itself until the editor
      // produces one, and no dirty marker.
      await expect(window.getByTestId('status-cursor')).toContainText('Ln 1, Col 1');

      await typeSql(window, 'SELECT 1');

      await expect(window.getByTestId('status-cursor')).toContainText('Ln 1, Col 9');
      // The dock's own tab header, which reads `tabStore`'s dirty flag — so this is the whole chain
      // from a Monaco content event through `setTabContent` to the tab strip.
      await expect(window.locator('[data-testid^="workspace-tab-dirty-"]').first()).toBeVisible();
    });
  });

  test('completes the seeded tables after FROM', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT * FROM ');

      // `suggestionsContaining` rather than `suggestions`: Monaco computes a completion list once per
      // trigger and never recomputes it when the provider's metadata lands afterwards, so a single
      // trigger races `sqlIntellisense.loadMetadata` — reliably in isolation, not under a full-tier run.
      const rows = await suggestionsContaining(window, 'public.customers');

      // The ported provider's FROM branch, which could never fire in the Angular original (its
      // `text.trim()` removed the whitespace its own regex required). These names come from the live
      // metadata load, so this also proves the explorer IPC path the provider depends on.
      await expect(rows.filter({ hasText: 'public.customers' })).toHaveCount(1);
      await expect(rows.filter({ hasText: 'public.orders' })).toHaveCount(1);
    });
  });

  test('⌃E asks once, then remembers', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT 1');

      // Every press below is preceded by `focusEditor`, and that is the test's subject rather than
      // ceremony: ⌃E is declared `source: 'editor'` and bound by Monaco, so it fires only while the
      // editor holds DOM focus. The Radix confirm dialog restores focus asynchronously after its close
      // animation, and under a full-tier load that restore lost the race — the second press landed on
      // `document.body` and the dialog never reopened (J-217).

      // First press: the gate. Cancelling runs nothing.
      await focusEditor(window);
      await window.keyboard.press('ControlOrMeta+e');
      await expect(window.getByTestId('query-confirm-execute')).toBeVisible();
      await window.getByTestId('query-confirm-execute-cancel').click();
      await expect(window.getByTestId('query-confirm-execute')).toBeHidden();
      await expect(window.getByTestId('query-results-empty')).toBeVisible();

      // Second press, with "don't ask again": it runs, and the flag is persisted.
      await focusEditor(window);
      await window.keyboard.press('ControlOrMeta+e');
      await window.getByTestId('query-confirm-execute-remember').check();
      await window.getByTestId('query-confirm-execute-run').click();
      await expect(window.getByTestId('query-results')).toBeVisible({ timeout: 20_000 });

      // Third press: no dialog at all.
      await typeSql(window, 'SELECT 2');
      await focusEditor(window);
      await window.keyboard.press('ControlOrMeta+e');
      await expect(window.getByTestId('query-confirm-execute')).toHaveCount(0);
      await expect(window.getByTestId('query-results')).toBeVisible({ timeout: 20_000 });
    });
  });

  test('a re-activated tab keeps its SQL and its measurements', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT 42');

      // A second query tab, from the database node's context menu — the sidebar's New Query BUTTON
      // refuses a second tab for a connection that already has one. Counted as a DELTA, because
      // connecting opens a query tab of its own beside the Welcome tab.
      const tabsBefore = await window.locator('.dv-tab').count();
      const menu = await openNodeMenu(window, 'joinery_test');
      await menu.getByTestId('sidebar-menu-new-query').click();
      await expect(window.locator('.dv-tab')).toHaveCount(tabsBefore + 1);

      // **PLAN.md trap (b), asserted where the assertion can actually fail.** Two query tabs now exist
      // and exactly one is active, so this is the state that discriminates: Golden Layout kept every
      // inactive tab's Monaco mounted, which is the only reason the Angular suite needed
      // `.monaco-editor:visible`. Dockview's default renderer detaches instead (R5 finding 4), so ONE
      // editor is in the document. A Dockview that changed its mind would make this 2 — and the whole
      // React tier, which carries no `:visible` filter anywhere, would need one again.
      await expect(window.locator('.monaco-editor')).toHaveCount(1);

      // Switch away and back. Under Dockview's default renderer the panel's DOM was DETACHED while it
      // was inactive (PLAN R5 finding 4), so this is the round trip that left Monaco at its 5×5
      // minimum until `layout()` was called on activation.
      await window.locator('.dv-tab').filter({ hasText: 'Query' }).first().click();

      expect(await visibleSql(window)).toContain('SELECT 42');
      const box = await queryEditor(window).locator('.monaco-editor').boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(200);
      expect(box?.height ?? 0).toBeGreaterThan(100);
    });
  });

  test('formats the SQL in place, undoably', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await typeSql(window, 'select id,email from customers where id=1');

      await window.getByTestId('query-format').click();

      await expect.poll(async () => visibleSql(window)).toContain('SELECT');
      expect(await visibleSql(window)).toContain('FROM');

      // `executeEdits`, not `setValue` — so the user can undo a format they did not want. The Angular
      // version used `setValue` and discarded the undo stack.
      await queryEditor(window).locator('.view-lines').click();
      await window.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => visibleSql(window)).toContain('select id,email');
    });
  });

  test('Execute Selection runs a ⌘A select-all instead of refusing it', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT id, email FROM customers ORDER BY id');

      // Select everything, deliberately, the way a user asks for "run all of this".
      await queryEditor(window).locator('.view-lines').click();
      await window.keyboard.press('ControlOrMeta+a');

      // Query ▸ Execute Selection. Sent as its menu channel because a native accelerator is not
      // reachable from CDP-injected keystrokes — see `sendMenuCommand`.
      await sendMenuCommand(app, 'menu:execute-selection');

      // It RUNS. The first implementation inferred "nothing is selected" from the selected text being
      // equal to the whole buffer, so this exact sequence was answered with "Select some SQL to
      // execute" — the toast asserted absent below.
      await expect(window.getByTestId('status-executing')).toBeHidden({ timeout: 20_000 });
      await expect(window.getByTestId('query-results')).toBeVisible();
      expect(await gridColumnHeaders(window)).toEqual(['id', 'email']);
      await expect(
        window.locator('[data-sonner-toast]').filter({ hasText: 'Select some SQL to execute' })
      ).toHaveCount(0);
    });
  });

  test('runs a real query and puts its rows in the results pane', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT id, email FROM customers ORDER BY id');

      await executeQuery(window);

      // Task 11 replaced the pane's labelled slot with the grid, so the columns are now AG Grid's
      // header cells and the count is the toolbar's readout. `results-grid.spec.ts` owns the grid's own
      // behaviour; what this test still asserts is that executing from the editor lands rows.
      await expect(window.getByTestId('query-results')).toBeVisible();
      expect(await gridColumnHeaders(window)).toEqual(['id', 'email']);
      await expect(window.getByTestId('results-row-count')).not.toHaveText('0');
      await expect(window.getByTestId('query-results-error')).toHaveCount(0);
    });
  });
});
