/**
 * The settings panel, in the real app, against the seeded PostgreSQL container.
 *
 * This replaces `tests/e2e/settings.spec.ts`, which asserted one thing — that a `mat-select` was visible
 * inside `app-settings-panel .settings-panel` — and explicitly declined to assert any value ("not their
 * exact values, since those depend on user preferences that aren't part of the regression contract").
 * That is precisely the gap J-44 lived in: the panel opened, the controls moved, the settings persisted,
 * and **nine of them changed nothing** for months, because no test ever asked whether anything happened.
 *
 * So the contract here is the opposite one. Every test below changes a setting and then asserts the
 * OBSERVABLE consequence somewhere else in the app: the editor's rendered font size, the grid's row
 * height, the ordinal column's existence, the Messages pane's duration line, the confirmation a plain
 * Execute now raises. The controls themselves are barely asserted at all — a control that flips is not
 * evidence of anything.
 *
 * The theme is `theme.spec.ts`, which owns the `[data-theme]` contract and its persistence.
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  connectFromSidebar,
  createPostgresProfile,
  ensureJoineryTestSeeded,
  executeQuery,
  gridRows,
  openQueryTab,
  openSettings,
  openSettingsGroup,
  closeSettings,
  resultsGrid,
  selectDatabase,
  setNumberSetting,
  setToggleSetting,
  settingsDialog,
  typeSql,
  withJoineryReact,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Test PG';
const CUSTOMERS_SQL = 'SELECT id, email FROM customers ORDER BY id';

test.beforeAll(ensureJoineryTestSeeded);

/** A connection, a database, and a query tab with Monaco painted. */
async function readyEditor(window: Page) {
  await createPostgresProfile(window, PROFILE);
  await connectFromSidebar(window, PROFILE);
  await selectDatabase(window, 'joinery_test');
  return openQueryTab(window);
}

/** Monaco's rendered font size, in pixels, read off a painted line rather than off the option. */
async function editorFontSize(window: Page): Promise<number> {
  return window
    .getByTestId('query-editor')
    .locator('.view-line')
    .first()
    .evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
}

/** Changes one setting in one group and closes the panel again. */
async function withSettings(
  app: ElectronApplication,
  window: Page,
  group: Parameters<typeof openSettingsGroup>[1],
  change: (window: Page) => Promise<void>
): Promise<void> {
  await openSettings(app, window);
  await openSettingsGroup(window, group);
  await change(window);
  await closeSettings(window);
}

test.describe('Joinery — the settings panel', () => {
  test('opens from ⌘, and shows all five groups', async () => {
    await withJoineryReact(async ({ app, window }) => {
      const dialog = await openSettings(app, window);

      // One group per tab, and each one really mounts its controls — an inactive Radix tab panel is not
      // in the DOM, so this is a stronger statement than "five buttons exist".
      await openSettingsGroup(window, 'appearance');
      await expect(dialog.getByTestId('settings-theme-system')).toBeAttached();
      await openSettingsGroup(window, 'editor');
      await expect(dialog.getByTestId('settings-editor-font-size')).toBeVisible();
      await openSettingsGroup(window, 'query');
      await expect(dialog.getByTestId('settings-query-max-rows')).toBeVisible();
      await openSettingsGroup(window, 'grid');
      await expect(dialog.getByTestId('settings-grid-row-height')).toBeVisible();
      // The fifth is J-92's, and holds a door rather than a preference — `ai-entry-points.spec.ts`
      // owns where that door leads.
      await openSettingsGroup(window, 'ai');
      await expect(dialog.getByTestId('settings-open-ai-setup')).toBeVisible();

      await closeSettings(window);
      await expect(settingsDialog(window)).toBeHidden();
    });
  });

  /*
   * The last control in this panel that had no consumer, now that it has one (J-54): the timeout is
   * set to its minimum and a query that sleeps well past it is stopped and says so.
   *
   * Asserted here rather than only in the unit tier because nothing below this level can see the
   * whole chain: the setting is written in the renderer, sent as `QueryRequest.timeout`, and enforced
   * by a timer in the main process that aborts the real pg client. The seeded container's `pg_sleep`
   * is what makes the deadline the only reason the query could end.
   */
  test('stops a query at the timeout the panel was given', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);

      await withSettings(app, window, 'query', async page => {
        await setNumberSetting(page, 'settings-query-timeout', 5);
      });

      await typeSql(window, 'SELECT pg_sleep(30)');
      await executeQuery(window);

      // The message names the setting, so a user who did not remember lowering it can find it.
      await expect(window.getByTestId('query-results-error-text')).toContainText(/timed out/i);
      await expect(window.getByTestId('query-results-error-text')).toContainText(/5s/);
    });
  });

  test('an editor setting reaches the editor that is already open', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT 1;');
      const before = await editorFontSize(window);

      await withSettings(app, window, 'editor', async page => {
        await setNumberSetting(page, 'settings-editor-font-size', 20);
      });

      // The editor was never reopened: `<SqlEditor>` pushes changed settings through `updateOptions`
      // rather than recreating the instance, which is what keeps the document and the undo stack. In
      // Angular this assertion was impossible to write — the option was hardcoded at 14 (J-44).
      await expect.poll(() => editorFontSize(window), { timeout: 10_000 }).toBeCloseTo(20, 0);
      expect(before).not.toBeCloseTo(20, 0);
      await expect(window.getByTestId('query-editor').locator('.view-line').first()).toContainText(
        'SELECT 1;'
      );
    });
  });

  test('the minimap toggle adds and removes the minimap', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT 1;');
      const minimap = window.getByTestId('query-editor').locator('.minimap');

      // Monaco's own element, located structurally under the vendor exemption.
      //
      // **The shipped default is OFF.** This assertion used to read `toBeVisible()` with the comment
      // "Default is on", which was true when the spec was written (94fd4ba) and stopped being true
      // fourteen hours later when `25f9a2d fix(shared): default the editor minimap off for shipped
      // visual parity (J-44)` flipped `settings.types.ts` without updating the test. It has been RED
      // on `main` ever since; Task 23 is only the run that noticed.
      //
      // Corrected in the stronger direction rather than the cheap one: the toggle is now driven BOTH
      // ways from the real default, so the test covers adding the minimap as well as removing it —
      // which is what its own title claims and what the old version never did.
      await expect(
        minimap,
        'the minimap is on at rest, but the shipped default is off'
      ).toBeHidden();

      await withSettings(app, window, 'editor', async page => {
        await setToggleSetting(page, 'settings-editor-minimap', true);
      });
      await expect(minimap, 'turning the minimap on did not reach the editor').toBeVisible();

      await withSettings(app, window, 'editor', async page => {
        await setToggleSetting(page, 'settings-editor-minimap', false);
      });
      await expect(minimap, 'turning the minimap off did not reach the editor').toBeHidden();
    });
  });

  test('a grid setting reaches the grid that is already showing rows', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);
      await typeSql(window, CUSTOMERS_SQL);
      await executeQuery(window);
      await expect(gridRows(window).first()).toBeVisible();

      await withSettings(app, window, 'grid', async page => {
        await setNumberSetting(page, 'settings-grid-row-height', 40);
        await setToggleSetting(page, 'settings-grid-row-numbers', false);
      });

      // No re-run: the grid subscribes through `selectGridSettings`, so AG Grid adopts the new row
      // height and the new column set over the rows it already has.
      await expect
        .poll(
          () =>
            gridRows(window)
              .first()
              .evaluate(node => Math.round(node.getBoundingClientRect().height)),
          { timeout: 10_000 }
        )
        .toBe(40);
      await expect(resultsGrid(window).locator('.ag-cell[col-id="rowNumber"]')).toHaveCount(0);
    });
  });

  test('the row cap is the setting, and the grid says when it bit', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);

      await withSettings(app, window, 'query', async page => {
        await setNumberSetting(page, 'settings-query-max-rows', 100);
      });

      // 250 rows against a 100-row cap. The executor truncates main-side, before the result crosses
      // IPC, so this proves the setting reached `QueryRequest.maxRows` rather than a client-side slice.
      await typeSql(window, 'SELECT generate_series(1, 250) AS n');
      await executeQuery(window);

      await expect(window.getByTestId('results-truncated')).toBeVisible({ timeout: 20_000 });
      await expect(window.getByTestId('results-displayed-count')).toHaveText('100');
      await expect(window.getByTestId('results-row-count')).toHaveText('250');
    });
  });

  test('turning off the duration line removes it from the Messages pane', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);
      await typeSql(window, CUSTOMERS_SQL);
      await executeQuery(window);
      await window.getByTestId('query-results-tab-messages').click();
      await expect(window.getByTestId('query-messages-execution-time')).toBeVisible();

      await withSettings(app, window, 'query', async page => {
        await setToggleSetting(page, 'settings-query-show-execution-time', false);
      });

      await expect(window.getByTestId('query-messages-execution-time')).toHaveCount(0);
      // The pane is otherwise intact: the setting hides one line, not the messages.
      await expect(window.getByTestId('query-messages')).toBeVisible();
    });
  });

  test('confirm-before-execute gates a plain Execute, and cancelling runs nothing', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await readyEditor(window);

      await withSettings(app, window, 'query', async page => {
        await setToggleSetting(page, 'settings-query-confirm-before-execute', true);
      });

      await typeSql(window, CUSTOMERS_SQL);
      await window.getByTestId('query-execute').click();

      const confirm = window.getByTestId('query-confirm-execute');
      await expect(confirm).toBeVisible();
      // The permanent gate, not the one-time ⌃E one — and it offers no "don't ask me again", because
      // that would be a second, hidden way to turn a setting off.
      await expect(confirm).toHaveAttribute('data-gate', 'always');
      await expect(window.getByTestId('query-confirm-execute-remember')).toHaveCount(0);

      await window.getByTestId('query-confirm-execute-cancel').click();
      await expect(confirm).toBeHidden();
      await expect(gridRows(window)).toHaveCount(0);

      // And confirming runs it.
      await window.getByTestId('query-execute').click();
      await window.getByTestId('query-confirm-execute-run').click();
      await expect(window.getByTestId('status-executing')).toBeHidden({ timeout: 20_000 });
      await expect(gridRows(window).first()).toBeVisible();
    });
  });

  test('reset to defaults needs two presses, and puts every group back', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await openSettings(app, window);
      await openSettingsGroup(window, 'grid');
      await setNumberSetting(window, 'settings-grid-row-height', 40);

      await window.getByTestId('settings-reset').click();
      // One press arms it. Resetting every preference from a single click beside four groups of
      // controls is too easy to do by accident.
      await expect(window.getByTestId('settings-reset')).toContainText('Reset everything?');
      await expect(window.getByTestId('settings-grid-row-height')).toHaveValue('40');

      await window.getByTestId('settings-reset').click();

      await expect(window.getByTestId('settings-grid-row-height')).toHaveValue('24');
      await openSettingsGroup(window, 'editor');
      await expect(window.getByTestId('settings-editor-font-size')).toHaveValue('13');
    });
  });

  test('settings survive a restart, through AppState rather than localStorage', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await openSettings(app, window);
      await openSettingsGroup(window, 'editor');
      await setNumberSetting(window, 'settings-editor-font-size', 17);
      await closeSettings(window);

      // Everything the renderer keeps in localStorage is wiped, so a value that comes back can only
      // have come from main-process `AppState`. (The one key React owns there is the theme mirror, and
      // `theme.spec.ts` makes the same point about the theme.)
      await window.evaluate(() => window.localStorage.clear());
      await window.reload();
      await expect(window.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });

      await openSettings(app, window);
      await openSettingsGroup(window, 'editor');
      await expect(window.getByTestId('settings-editor-font-size')).toHaveValue('17');
    });
  });
});
