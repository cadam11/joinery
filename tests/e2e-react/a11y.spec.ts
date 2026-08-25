/**
 * The a11y sweep: **on the surfaces walked here, every element a Tab press can reach matches
 * `:focus-visible` and draws a visible indicator — and every docking move a drag can make is also
 * reachable from the keyboard.**
 *
 * PLAN.md Task 23. Note the scope in that first sentence: it says "the surfaces walked here", not
 * "every interactive element". The honest claim is **runtime-verified on the walked surfaces,
 * statically verified elsewhere** — see the PLAN.md Task 23 appendix for the static half and its
 * evidence. Overstating it was the review's I3 finding, and the list of what IS walked is the list
 * of `test()` blocks below:
 *
 *   connected shell · connection editor · all four settings groups · command palette ·
 *   backup dialog · restore dialog · query tab (both halves) · chat side panel · ERD tab
 *
 * The inventory is taken by walking the real tab order in the shipped bundle —
 * `tests/helpers/react/a11y.ts` explains why a source scan is the weaker instrument. Each walk is
 * attached as a markdown table, so a run of this file IS the inventory: open any attachment to see
 * every stop, its role, whether it matched `:focus-visible`, and what it was drawn with.
 *
 * ── The four exemptions ──────────────────────────────────────────────────────────────────────
 *
 * Four kinds of stop cannot be judged by reading the focused element's own computed style, and each
 * carries a positive assertion of its own — an exemption without one would be a hole rather than a
 * documented edge. `tests/helpers/react/a11y.ts` states each rationale in full; in short: Monaco and
 * AG Grid draw their indicator on a different element from the one that takes focus, the command
 * overlay's field is its surface's only focus stop (the caret is the indicator), and a Radix
 * roving-focus group root cannot hold focus at all. The last test in this file runs all four
 * `verify`s directly, so none of them can rot into a rubber stamp.
 *
 * Dockview is NOT among them: `shell/dockview-theme.css` gives `.dv-tab` a `:focus-visible` rule the
 * vendor sheet lacks, so its tabs pass the ordinary check.
 *
 * Separately, the measurement understands the `has-focus-visible:` pattern — `ui/switch.tsx` and
 * `ui/field.tsx` put the ring on an ancestor of a deliberately invisible control. That is not an
 * exemption; it is where the ring genuinely is. The credit is **differential**: an ancestor earns it
 * only by painting something while the stop is focused that it does not paint once focus has left.
 * "Some ancestor draws" is not enough and was not always rejected —
 * `'the ancestor credit is differential'` below is the negative control, using the case that caught
 * it (a ringless-by-design field three levels under a dialog whose shadow is permanent).
 *
 * Out of scope, per PLAN.md §8: a screen-reader audit beyond focus, contrast and keyboard.
 */

import {
  AG_GRID_EXEMPTION,
  COMMAND_OVERLAY_INPUT_EXEMPTION,
  MONACO_EXEMPTION,
  ROVING_TABLIST_EXEMPTION,
  UI_TIMEOUT_MS,
  connectFromSidebar,
  connectionEditor,
  createPostgresProfile,
  dismissToasts,
  ensureJoineryTestSeeded,
  executeQuery,
  expandTreeRow,
  attachFocusTable,
  gridRows,
  openBackupDialog,
  openConnectionEditor,
  openChatPanel,
  openQueryTab,
  openPalette,
  openRelationships,
  openRestoreDialog,
  openSettings,
  openSettingsGroup,
  overlay,
  queryEditor,
  selectDatabase,
  settingsDialog,
  typeSql,
  welcomePanel,
  openWelcome,
  unindicatedStops,
  walkTabOrder,
  withJoineryReact,
  workspaceTabs,
  type FocusExemption,
  type FocusStop,
  type FocusWalk,
  type SettingsGroup,
} from '../helpers/joinery-actions-react';

import { expect, test, type Page } from '@playwright/test';

const PROFILE = 'A11y PG';
const DATABASE = 'joinery_test';

/**
 * The four stops whose focus treatment `getComputedStyle` on the focused element cannot see, each
 * for a different reason and each carrying its own positive check. The exemptions test below runs
 * all four of them.
 */
const EXEMPTIONS: readonly FocusExemption[] = [
  MONACO_EXEMPTION,
  AG_GRID_EXEMPTION,
  COMMAND_OVERLAY_INPUT_EXEMPTION,
  ROVING_TABLIST_EXEMPTION,
];

/** Every group the settings dialog offers (`features/settings/settings-dialog.tsx:63`). */
const SETTINGS_GROUPS: readonly SettingsGroup[] = ['appearance', 'editor', 'query', 'grid'];

test.beforeAll(async () => {
  await ensureJoineryTestSeeded();
});

/**
 * The gate, applied to one walk: **every stop matches `:focus-visible` AND draws a visible
 * indicator**, minus the three documented exemptions.
 *
 * A function rather than three copied lines, because the failure message is the thing a reader will
 * meet first and it should say the same thing on every surface.
 */
function assertEveryStopRinged(walk: FocusWalk, surface: string): void {
  const missing = unindicatedStops(walk.stops, EXEMPTIONS);
  expect(
    missing.map(
      stop => `${stop.id} (focus-visible: ${stop.focusVisible}, ring: ${stop.indicated})`
    ),
    `${surface}: these focus stops fail the :focus-visible + visible-indicator gate`
  ).toEqual([]);
}

test.describe('focus is visible everywhere a Tab press can land', () => {
  test('the shell — sidebar, tab strip, splitters and status bar', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);

      // From a named anchor, like every other walk here: without one the walk begins wherever
      // `dismissToasts` happened to leave focus, and the longest table in the suite would be the
      // one least reproducible between runs.
      const walk = await walkTabOrder(window, window.getByTestId('sidebar-tree'));
      await attachFocusTable('shell-tab-order.md', 'Connected shell', walk);

      // Non-vacuous: a walk that found three stops would pass the assertion below and mean nothing.
      // The connected shell has the sidebar's controls, the tab strip, two splitters and the status
      // bar in its order; 12 is comfortably under that and well over an accidental early exit.
      expect(
        walk.stops.length,
        'the tab order walk found too few stops to be meaningful'
      ).toBeGreaterThan(12);
      expect(walk.outcome, 'the shell walk should end by wrapping to its first stop').toBe(
        'cycled'
      );

      assertEveryStopRinged(walk, 'connected shell');
    });
  });

  test('a modal dialog rings every stop and traps focus inside itself', async () => {
    await withJoineryReact(async ({ window }) => {
      await openConnectionEditor(window);

      const walk = await walkTabOrder(window, connectionEditor(window));
      await attachFocusTable('connection-editor-tab-order.md', 'Connection editor dialog', walk);

      // A modal's order MUST cycle: Radix traps focus, so Tab from the last control returns to the
      // first. `cycled` specifically, not "did not hit the cap" — `stuck` would mean Tab stopped
      // moving at all, which is a different bug that used to be reported as this one.
      expect(
        walk.outcome,
        'focus escaped the connection editor rather than cycling inside it'
      ).toBe('cycled');
      expect(walk.stops.length).toBeGreaterThan(5);

      assertEveryStopRinged(walk, 'connection editor');
    });
  });

  test('every settings group, and the command palette', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await openSettings(app, window);

      // ALL FOUR groups (`settings-dialog.tsx:63`), not just the one the dialog opens on. Each is a
      // separate panel of controls that a Tab press can reach and that nothing else in this suite
      // walks — the review's I3 finding was that "the settings dialog" meant `appearance` only.
      for (const group of SETTINGS_GROUPS) {
        await openSettingsGroup(window, group);
        const walk = await walkTabOrder(window, settingsDialog(window));
        await attachFocusTable(`settings-${group}-tab-order.md`, `Settings — ${group}`, walk);
        expect(walk.outcome, `focus escaped the settings dialog on the ${group} group`).toBe(
          'cycled'
        );
        // Non-vacuous per group: the close button and the four tab triggers alone are five stops,
        // so a group whose own controls were never reached would fall under this.
        expect(walk.stops.length, `the ${group} group contributed no controls`).toBeGreaterThan(5);
        assertEveryStopRinged(walk, `settings/${group}`);
      }

      await window.keyboard.press('Escape');
      await expect(settingsDialog(window)).toBeHidden({ timeout: UI_TIMEOUT_MS });

      await openPalette(window);
      const palette = await walkTabOrder(window, overlay(window, 'palette'));
      await attachFocusTable('palette-tab-order.md', 'Command palette', palette);
      // The palette is a search overlay: its rows are driven by arrow keys off the input (cmdk's
      // roving model), so the TAB order is one stop by design, and that stop passes through
      // `COMMAND_OVERLAY_INPUT_EXEMPTION` — whose `verify` checks the claim the design rests on.
      assertEveryStopRinged(palette, 'command palette');

      // ── The one place `stuck` does not mean "trap" ──────────────────────────────────────────
      //
      // Asserted rather than left unexamined, because an unasserted label is a label free to drift.
      // The classifier cannot tell "this surface intentionally has one stop" from "focus got caught
      // here", and on this surface it is the former: Tab stays on the field ON PURPOSE, which is the
      // very claim `COMMAND_OVERLAY_INPUT_EXEMPTION.verify` re-measures. One stop plus `stuck` is
      // therefore the correct reading of a correct surface — and if the palette ever grows a second
      // Tab stop, this line fails and the exemption's rationale needs revisiting with it.
      expect(palette.stops.length, 'the command palette grew a second Tab stop').toBe(1);
      expect(
        palette.outcome,
        'the palette field stopped holding focus — the ringless-field exemption rests on it doing so'
      ).toBe('stuck');
    });
  });

  test('the ancestor credit is differential, not "something up there draws"', async () => {
    await withJoineryReact(async ({ app, window }) => {
      // ── Both controls in one test, because each is meaningless without the other ─────────────
      //
      // The credit exists so `ui/switch.tsx`'s deliberate pattern — a transparent `<input>` with the
      // ring on its TRACK, via `has-focus-visible:` — is not reported as a missing ring. Its danger
      // is that a mechanism loose enough to allow that also allows any ancestor that happens to
      // paint: the re-review found `palette-input` and a `TabsList` both credited to
      // `ui/dialog.tsx`'s `DialogContent`, whose `shadow-overlay` is unconditional, one to three
      // levels up and well inside the four-level bound. Seven of this file's thirteen walks are
      // built on that dialog.
      //
      // So: the switch MUST be credited and the palette field MUST NOT. A mechanism that gets either
      // one wrong fails here.
      await openSettings(app, window);
      await openSettingsGroup(window, 'editor');
      const settings = await walkTabOrder(window, settingsDialog(window));

      const wordWrap = settings.stops.find(stop => stop.id === 'settings-editor-word-wrap');
      expect(
        wordWrap,
        'the editor group no longer has a word-wrap switch to measure'
      ).toBeDefined();
      expect(
        wordWrap?.indicatedOn,
        'the switch draws no ring of its own and its track ring was not credited — the ' +
          '`has-focus-visible:` pattern is no longer recognised'
      ).toBe('ancestor');

      await window.keyboard.press('Escape');
      await expect(settingsDialog(window)).toBeHidden({ timeout: UI_TIMEOUT_MS });

      await openPalette(window);
      const palette = await walkTabOrder(window, overlay(window, 'palette'));

      const input = palette.stops.find(stop => stop.id === 'palette-input');
      expect(input, 'the palette walk did not reach its field').toBeDefined();
      expect(
        input?.indicatedOn,
        "the palette field was credited with an ancestor's indicator. It has none of its own by " +
          'design, and the nearest ancestor that paints is DialogContent, whose shadow is on ' +
          'whether or not anything is focused — the credit is not differential'
      ).toBe('none');
      // And therefore it passes only through its exemption, which is the honest route.
      expect(COMMAND_OVERLAY_INPUT_EXEMPTION.matches(input as FocusStop)).toBe(true);
    });
  });

  test('the backup and restore dialogs', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);

      // Two of the largest forms in the app, and neither was walked before the review's I3. Both
      // open on a host-tool probe, which the helpers already wait out.
      const backup = await openBackupDialog(window);
      const backupWalk = await walkTabOrder(window, backup);
      await attachFocusTable('backup-tab-order.md', 'Backup dialog', backupWalk);
      expect(backupWalk.outcome, 'focus escaped the backup dialog').toBe('cycled');
      expect(backupWalk.stops.length).toBeGreaterThan(3);
      assertEveryStopRinged(backupWalk, 'backup dialog');

      await window.keyboard.press('Escape');
      await expect(backup).toBeHidden({ timeout: UI_TIMEOUT_MS });

      const restore = await openRestoreDialog(window);
      const restoreWalk = await walkTabOrder(window, restore);
      await attachFocusTable('restore-tab-order.md', 'Restore dialog', restoreWalk);
      expect(restoreWalk.outcome, 'focus escaped the restore dialog').toBe('cycled');
      expect(restoreWalk.stops.length).toBeGreaterThan(3);
      assertEveryStopRinged(restoreWalk, 'restore dialog');
    });
  });

  test('the query tab, where the two vendor surfaces live', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);

      // A result set, so the grid is mounted and its cells are in the document.
      await typeSql(window, 'SELECT id, email FROM customers ORDER BY id LIMIT 20');
      await executeQuery(window);
      await expect(gridRows(window).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });

      // ── TWO segments, and the reason is a real property of the surface ──────────────────────
      //
      // Monaco binds Tab to "insert a tab character", so a walk that reaches the editor cannot
      // leave it: focus stays put and the walk reports `stuck`. That is asserted here rather than
      // worked around, because it is exactly the trap the old descriptor-keyed walk mistook for a
      // clean cycle — and mistaking it cost this test the whole results half of the panel, in the
      // test named for the two vendor surfaces.
      const upToEditor = await walkTabOrder(window, window.getByTestId('sidebar-tree'));
      await attachFocusTable(
        'query-tab-order-1-editor.md',
        'Query tab — sidebar through the editor',
        upToEditor
      );
      expect(upToEditor.outcome, 'the walk was expected to be trapped by Monaco').toBe('stuck');
      // Through the exemption's own predicate rather than a class name spelled out here, so the two
      // cannot disagree about what "Monaco's focus sink" is — they already did once, which is how
      // `native-edit-context` was found.
      expect(
        upToEditor.stuckAt !== null && MONACO_EXEMPTION.matches(upToEditor.stuckAt),
        `the walk got stuck on ${upToEditor.stuckAt?.id ?? '?'}, not on Monaco — a new finding`
      ).toBe(true);

      // Segment two starts on the far side of the trap, at the results pane's own tab strip — the
      // first focusable thing below the editor — and runs all the way round: the results controls,
      // AG Grid's headers and cells, the status bar, the titlebar, the sidebar, the workspace tab
      // strip, and finally back into Monaco, where it is trapped again. `stuck` is therefore the
      // honest ending for this segment too, and it is the SECOND time round that proves the loop
      // closed rather than a `cycled` that never happens.
      //
      // (Monaco's own ⌃M `toggleTabFocusMode` would give a single continuous walk and was tried
      // first; that keystroke does not reach the editor through Electron here. J-83 therefore
      // binds ⌃M explicitly in `editor/sql-editor.tsx`, and the test above proves it frees Tab.
      // This walk still runs in two segments on purpose: it measures the DEFAULT order, where Tab
      // indents, which is what a user who has not pressed ⌃M experiences.)
      const pastEditor = await walkTabOrder(window, window.getByTestId('query-results-tabs'));
      await attachFocusTable(
        'query-tab-order-2-results.md',
        'Query tab — results pane, grid and status bar',
        pastEditor
      );
      expect(
        pastEditor.stops.some(stop => stop.id.startsWith('status-')),
        'the resumed walk never reached the status bar'
      ).toBe(true);
      expect(
        pastEditor.stops.some(stop => stop.id === 'sidebar-tree'),
        'the resumed walk never wrapped round to the sidebar'
      ).toBe(true);

      assertEveryStopRinged(upToEditor, 'query tab (editor half)');
      assertEveryStopRinged(pastEditor, 'query tab (results half)');

      // Both vendor surfaces really were reached — which is what this test's name claims and what
      // the single truncated walk never delivered.
      const stops = [...upToEditor.stops, ...pastEditor.stops];
      expect(
        stops.some(stop => MONACO_EXEMPTION.matches(stop)),
        'the walk never reached Monaco'
      ).toBe(true);
      expect(
        stops.some(stop => AG_GRID_EXEMPTION.matches(stop)),
        'the walk never reached AG Grid'
      ).toBe(true);
    });
  });

  test('the chat side panel', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);

      // The chat panel is a docked side panel rather than a modal, so its controls join the shell's
      // own tab order — which is why this walk starts at the top of the shell rather than inside it.
      await openChatPanel(window);
      const chat = await walkTabOrder(window, window.getByTestId('sidebar-tree'));
      await attachFocusTable('chat-tab-order.md', 'Shell with the chat panel open', chat);
      expect(chat.outcome).toBe('cycled');
      assertEveryStopRinged(chat, 'chat side panel');
      // Non-vacuous: the panel's composer and conversation controls have to be IN the walk for it to
      // say anything about the chat surface at all.
      expect(chat.stops.some(stop => stop.id.startsWith('chat-'))).toBe(true);
    });
  });

  test('the ERD canvas', async () => {
    await withJoineryReact(async ({ window }) => {
      // The same walk down the tree `erd.spec.ts` uses: "Show relationships" is a table node's
      // context-menu item, so the Tables folder has to be open before it exists.
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await expandTreeRow(window, PROFILE);
      await expandTreeRow(window, DATABASE);
      await expandTreeRow(window, 'public');
      await expandTreeRow(window, 'Tables');
      await openRelationships(window, 'order_items');
      await dismissToasts(window);

      const erd = await walkTabOrder(window, window.getByTestId('sidebar-tree'));
      await attachFocusTable('erd-tab-order.md', 'ERD tab', erd);
      expect(erd.outcome).toBe('cycled');
      assertEveryStopRinged(erd, 'ERD tab');
      expect(erd.stops.some(stop => stop.id.startsWith('erd-'))).toBe(true);
      // The details rail emits `erd-relationship-row` once per relationship, which is what the old
      // descriptor-keyed walk mistook for a cycle at stop 11. Reaching the status bar past it is the
      // observable proof that identity-keyed termination fixed it.
      expect(
        erd.stops.some(stop => stop.id.startsWith('status-')),
        'the ERD walk stopped before the status bar — the duplicate-testid truncation is back'
      ).toBe(true);
    });
  });

  test('the SQL editor has a keyboard way out, which is what WCAG asks for (J-83)', async () => {
    await withJoineryReact(async ({ window }) => {
      await typeSql(window, 'SELECT 1');

      // Focus is in Monaco's input sink. Tab inserts a tab character here — correct for a SQL
      // editor, and a keyboard trap without an exit (WCAG 2.1.2, Level A).
      const inMonaco = async (): Promise<boolean> =>
        window.evaluate(() => {
          const active = document.activeElement;
          return (
            active !== null &&
            (active.classList.contains('inputarea') ||
              active.classList.contains('native-edit-context'))
          );
        });

      expect(await inMonaco(), 'the test did not start with focus in the editor').toBe(true);
      await window.keyboard.press('Tab');
      expect(await inMonaco(), 'Tab moved focus out of the editor — the premise has changed').toBe(
        true
      );

      // ⌃M — `editor.action.toggleTabFocusMode`, bound explicitly in `editor/sql-editor.tsx`
      // because Monaco's own binding for it does not reach the editor here. This is the exit.
      await window.keyboard.press('Control+m');
      await window.keyboard.press('Tab');
      expect(await inMonaco(), 'Control+M did not free Tab — the editor is still a trap').toBe(
        false
      );
    });
  });

  test('all four exemptions hold up the claim they make for themselves', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);
      await typeSql(window, 'SELECT id, email FROM customers ORDER BY id LIMIT 20');
      await executeQuery(window);
      await expect(gridRows(window).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });

      // Each exemption's positive half, driven directly rather than through a walk: an exemption
      // whose element a walk happened not to reach would otherwise go unchecked, and an exemption
      // nobody checks is a hole in the sweep rather than a documented one.
      await queryEditor(window).locator('.view-lines').click();
      await MONACO_EXEMPTION.verify(window);

      await gridRows(window).first().locator('.ag-cell').first().click();
      await AG_GRID_EXEMPTION.verify(window);

      await openPalette(window);
      await COMMAND_OVERLAY_INPUT_EXEMPTION.verify(window);
      await window.keyboard.press('Escape');

      await openSettings(app, window);
      await ROVING_TABLIST_EXEMPTION.verify(window);
    });
  });
});

/**
 * The other half of the Task 23 plan line: docking, which was drag-only.
 *
 * Asserted through what a user SEES rather than through Dockview's group count: two panels visible
 * at once is what a split is, and exactly one visible is what a single group is (Dockview detaches
 * an inactive panel's DOM under the default renderer — PLAN.md R5 measurement 4). So no assertion
 * here names a vendor class except the one that cannot be avoided: `.dv-tab` is the element
 * Dockview focuses, and focusing it is the precondition for pressing a key at it at all.
 */
test.describe('docking is operable from the keyboard', () => {
  /**
   * Focuses the active tab header of the `index`-th group — the element Dockview gives the roving
   * `tabindex` to, and the only one a keystroke can reach.
   *
   * The `aria-keyshortcuts` assertion is not decoration: it is the one observable proof that
   * `panel-tab.tsx` found its `.dv-tab` ancestor and attached the listener. Without it a Dockview
   * upgrade that renamed the class would make every test below fail on a symptom four steps away.
   */
  async function focusActiveTab(window: Page, index = 0): Promise<void> {
    const tab = window.locator('.dv-tab.dv-active-tab').nth(index);
    await expect(tab).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await tab.focus();
    await expect(tab).toHaveAttribute('aria-keyshortcuts', /⌥/, { timeout: UI_TIMEOUT_MS });
  }

  test('Option+Arrow splits a tab into a new group, and Option+Shift+Arrow merges it back', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);
      await openWelcome(window);
      await openQueryTab(window);

      // One group: only the active panel's DOM is in the document.
      await expect(welcomePanel(window)).toBeHidden({ timeout: UI_TIMEOUT_MS });

      // The query tab is the active one, so this splits it into a new group on the right and leaves
      // Welcome behind in the original.
      await focusActiveTab(window);
      await window.keyboard.press('Alt+ArrowRight');

      // Two groups, side by side — both panels are now mounted and visible at once.
      await expect(welcomePanel(window)).toBeVisible({ timeout: UI_TIMEOUT_MS });
      await expect(window.getByTestId('query-panel')).toBeVisible({ timeout: UI_TIMEOUT_MS });

      // Merge back the other way round: Welcome — the first group's only tab — moves INTO the second
      // group, which empties the first and leaves one group with both tabs in it. Welcome ends up
      // active there, so the query panel is the one that gets detached.
      await focusActiveTab(window);
      await window.keyboard.press('Alt+Shift+ArrowRight');

      await expect(window.getByTestId('query-panel')).toBeHidden({ timeout: UI_TIMEOUT_MS });
      await expect(welcomePanel(window)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    });
  });

  test('the docking keys keep out of the tab-rename field', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);
      await selectDatabase(window, DATABASE);
      await dismissToasts(window);
      await openWelcome(window);
      await openQueryTab(window);

      // Two tabs in one group, so a split IS available — which is what makes the assertion below
      // mean "the keys declined" rather than "there was nothing they could have done".
      await expect(welcomePanel(window)).toBeHidden({ timeout: UI_TIMEOUT_MS });

      const activeTab = window.locator('.dv-tab.dv-active-tab').first();
      await activeTab.dblclick();
      const rename = window.locator('[data-testid^="workspace-tab-rename-"]');
      await expect(rename).toBeVisible({ timeout: UI_TIMEOUT_MS });
      await rename.fill('renamed tab');

      // ⌥→ is macOS's "move by word". The docking listener is NATIVE on `.dv-tab`, an ancestor of
      // this input, and React 19 dispatches synthetic events from the root — so the input's own
      // `stopPropagation` runs AFTER this listener and cannot protect it. Before the target check in
      // `useDockingKeys`, this keystroke split the panel and the blur committed a half-typed name.
      await window.keyboard.press('Alt+ArrowRight');
      await window.keyboard.press('Alt+ArrowLeft');

      // Nothing docked: still one group, so the inactive panel is still detached.
      await expect(welcomePanel(window)).toBeHidden({ timeout: UI_TIMEOUT_MS });
      // And the field is still open, still focused, still holding what was typed — i.e. the keys
      // reached the input as ordinary caret motion rather than being eaten.
      await expect(rename).toBeVisible();
      await expect(rename).toBeFocused();
      await expect(rename).toHaveValue('renamed tab');

      // Escape abandons the rename, which is the pre-existing behaviour this must not have changed.
      await window.keyboard.press('Escape');
      await expect(rename).toBeHidden({ timeout: UI_TIMEOUT_MS });
    });
  });

  test('a move it cannot make says so instead of doing nothing', async () => {
    await withJoineryReact(async ({ window }) => {
      // No connection: a launch with nothing connected shows the Welcome tab and only that, which is
      // exactly the one-tab-in-one-group state both refusals are about.
      await openWelcome(window);
      await expect(workspaceTabs(window)).toHaveCount(1);
      await dismissToasts(window);

      // A keyboard user's whole signal that the key was heard is the toast, so a refusal that said
      // nothing would be indistinguishable from a shortcut that does not exist.
      await focusActiveTab(window);
      await window.keyboard.press('Alt+ArrowRight');
      await expect(window.locator('[data-sonner-toast]')).toContainText(/only one in its group/, {
        timeout: UI_TIMEOUT_MS,
      });

      await dismissToasts(window);
      await focusActiveTab(window);
      await window.keyboard.press('Alt+Shift+ArrowRight');
      await expect(window.locator('[data-sonner-toast]')).toContainText(/no group on that side/, {
        timeout: UI_TIMEOUT_MS,
      });
    });
  });
});
