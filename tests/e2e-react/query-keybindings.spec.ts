/**
 * Which editor a keystroke reaches, when more than one query tab exists.
 *
 * **The gap this file closes.** Every execute-key press in the rest of the tier — `query-editor`'s
 * three ⌃E presses, `object-search`'s ⌘↩, `a11y`'s ⌃M — runs with exactly one query tab in
 * existence, and `query-editor.spec.ts` › `a re-activated tab keeps its SQL and its measurements`
 * opens a second tab but never presses a key in it. So the tier had no coverage at all for the
 * state J-132 is about, and could not have noticed the bug or its reintroduction.
 *
 * **What that bug was, because it is the reason these assertions are worth their runtime.**
 * `editor.addCommand` registers its keybinding rule against Monaco's PROCESS-GLOBAL standalone
 * keybinding service, with no when-clause and no way to remove it. The resolver walks its rule list
 * backwards and takes the first match (`keybindingResolver.js:281-290`), so the newest editor's rule
 * won every press: with two query tabs open, **F5 and ⌘↩ in the first tab did nothing at all** — the
 * keystroke ran the other tab's execute, and the tab the user was looking at never populated. And
 * after closing the second tab its rule was still there, now closing over a disposed editor, so ⌃M
 * in the survivor reached an editor whose `trigger` returns early (`codeEditorWidget.js:821`) and
 * the Tab-focus escape hatch silently stopped working. Both are user-visible; neither was covered.
 *
 * These three tests fail on the commit before the fix — that is what makes them worth having, and it
 * was verified in both directions rather than assumed.
 *
 * Locators follow the tier's rule: Joinery's own surfaces by testid, tabs through
 * `helpers/react/workbench.ts`, and Monaco only through the vendor exemption its neighbours use.
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  activeTabTitle,
  connectFromSidebar,
  createPostgresProfile,
  ensureJoineryTestSeeded,
  gridColumnHeaders,
  newQueryTabFromMenu,
  openQueryTab,
  queryEditor,
  selectDatabase,
  typeSql,
  visibleSql,
  withJoineryReact,
  workspaceTab,
  closeTabTitled,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Test PG';
const DATABASE = 'joinery_test';

test.beforeAll(ensureJoineryTestSeeded);

/** Connect, pick the seeded database, and land in a query tab. */
async function readyEditor(window: Page): Promise<void> {
  await createPostgresProfile(window, PROFILE);
  await connectFromSidebar(window, PROFILE);
  await selectDatabase(window, DATABASE);
  await openQueryTab(window);
}

/**
 * Puts the caret in the visible editor.
 *
 * `.view-lines` is Monaco's own DOM — the vendor exemption `helpers/react/query.ts` documents and
 * `query-editor.spec.ts` uses for the same purpose. A keybinding test has to press the key with
 * focus where a user's would be, because the whole subject is which editor's context the keystroke
 * resolves against.
 */
async function focusEditor(window: Page): Promise<void> {
  await queryEditor(window).locator('.view-lines').click();
}

/** Is the caret inside Monaco's focus sink? Mirrors `a11y.spec.ts`'s check of the same thing. */
async function inMonaco(window: Page): Promise<boolean> {
  return window.evaluate(() => {
    const active = document.activeElement;
    return (
      active !== null &&
      (active.classList.contains('inputarea') || active.classList.contains('native-edit-context'))
    );
  });
}

/**
 * Two query tabs, each holding a distinctly-named column, with the FIRST one active and focused.
 *
 * Returns nothing: what matters is the state it leaves behind, and the caller asserts on it. The
 * second tab is opened through File ▸ New Query rather than the sidebar button, which refuses a
 * second tab for a connection that already has one (`helpers/react/workbench.ts`).
 */
async function twoTabsBackOnTheFirst(app: ElectronApplication, window: Page): Promise<void> {
  await readyEditor(window);
  await typeSql(window, 'SELECT 111 AS marker_one');
  const firstTitle = await activeTabTitle(window);

  // The second editor mounts now, so ITS keybinding rules are the newest in the global list — the
  // ones that used to win every press regardless of focus.
  await newQueryTabFromMenu(app, window);
  await typeSql(window, 'SELECT 222 AS marker_two');

  await workspaceTab(window, firstTitle).click();
  await expect.poll(async () => visibleSql(window)).toContain('marker_one');
  await focusEditor(window);
}

test.describe('Joinery (React) — editor keys with more than one query tab', () => {
  test('F5 runs the tab it was pressed in, not the newest one', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await twoTabsBackOnTheFirst(app, window);

      await window.keyboard.press('F5');

      // Before the fix this timed out: the keystroke ran the OTHER tab's execute, so the pane the
      // user was looking at never populated at all.
      await expect(window.getByTestId('query-results')).toBeVisible({ timeout: 20_000 });
      expect(await gridColumnHeaders(window)).toEqual(['marker_one']);
    });
  });

  test('⌘↩ runs the tab it was pressed in, not the newest one', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await twoTabsBackOnTheFirst(app, window);

      await window.keyboard.press('ControlOrMeta+Enter');

      await expect(window.getByTestId('query-results')).toBeVisible({ timeout: 20_000 });
      expect(await gridColumnHeaders(window)).toEqual(['marker_one']);
    });
  });

  test('⌃M still frees Tab in the tab that is left after another is closed', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT 1');
      const survivorTitle = await activeTabTitle(window);

      // Open a second tab and close it again. Its editor is disposed; before the fix its keybinding
      // rules were not, and they were the newest in the list.
      await newQueryTabFromMenu(app, window);
      await closeTabTitled(window, await activeTabTitle(window));
      await workspaceTab(window, survivorTitle).click();

      await focusEditor(window);
      expect(await inMonaco(window), 'the test did not start with focus in the editor').toBe(true);
      await window.keyboard.press('Tab');
      expect(
        await inMonaco(window),
        'Tab moved focus out before ⌃M — the premise has changed'
      ).toBe(true);

      // The escape hatch J-83 added. Before the fix the closed tab's stale rule answered this press
      // and its disposed editor did nothing with it, so Tab went on inserting tab characters.
      await window.keyboard.press('Control+m');
      await window.keyboard.press('Tab');

      expect(
        await inMonaco(window),
        '⌃M did not free Tab in the surviving editor — a closed tab is answering for it'
      ).toBe(false);
    });
  });
});
