/**
 * The execution plan against the seeded PostgreSQL container: a real `EXPLAIN (FORMAT JSON)` becomes a
 * real tree, and the surface's two honest refusals happen where they say they do.
 *
 * PostgreSQL is the engine this tier covers because it is the one that answers without running the
 * statement, so the test is free of side effects. SQL Server's path — `SET STATISTICS PROFILE`, which
 * DOES run it — is covered in the unit tier against a transcript of what that really returns
 * (`features/query/execution-plan.spec.ts`), plus the confirmation gate asserted here.
 */

import { expect, test } from '@playwright/test';
import {
  connectFromSidebar,
  createPostgresProfile,
  ensureJoineryTestSeeded,
  executeQuery,
  gridColumnValues,
  openPalette,
  openPaletteFromEditor,
  openQueryTab,
  paletteRowState,
  planNodeTypes,
  planNodes,
  planTab,
  runPaletteCommand,
  selectDatabase,
  showExecutionPlan,
  typeSql,
  withJoineryReact,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Plan PG';

test.beforeAll(ensureJoineryTestSeeded);

async function readyEditor(window: Parameters<typeof openQueryTab>[0]) {
  await createPostgresProfile(window, PROFILE);
  await connectFromSidebar(window, PROFILE);
  await selectDatabase(window, 'joinery_test');
  return openQueryTab(window);
}

test.describe('Joinery (React) — the execution plan', () => {
  test('renders a real PostgreSQL plan as a tree, with costs and a warning', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      // A join across the two seeded tables, so the plan has a shape rather than one node.
      await typeSql(
        window,
        'SELECT c.email, o.id FROM customers c JOIN orders o ON o.customer_id = c.id ORDER BY c.email'
      );

      const plan = await showExecutionPlan(window);

      // More than one operator, and every one of them has a name — a plan that parsed into a single
      // "Unknown" node is the shape a broken parser produces.
      const types = await planNodeTypes(window);
      expect(types.length).toBeGreaterThan(1);
      for (const type of types) expect(type.trim()).not.toBe('');
      // The join is what the SQL asked for, whichever strategy the planner picked.
      expect(types.some(type => /join|loop/i.test(type))).toBe(true);

      // Depths, not just a flat list: the join has children.
      const depths = await planNodes(window).evaluateAll(rows =>
        rows.map(row => Number(row.getAttribute('data-depth')))
      );
      expect(Math.max(...depths)).toBeGreaterThan(0);

      // The claim the pane makes about itself. PostgreSQL was not asked to run anything.
      await expect(plan.getByTestId('plan-kind')).toHaveText('Estimated plan');
      await expect(plan).toContainText('Total cost');
      // At least one node names the table it reads.
      await expect(plan.getByTestId('plan-node-object').first()).toBeVisible();
    });
  });

  test('does not run the statement to plan it', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      // If asking for a plan executed this, the row would be gone. `EXPLAIN` without ANALYZE does not.
      await typeSql(window, 'DELETE FROM orders WHERE id = (SELECT MIN(id) FROM orders)');

      await showExecutionPlan(window);
      await expect(planTab(window)).toBeVisible();

      // Count the rows afterwards, through the app: still there.
      await typeSql(window, 'SELECT count(*) AS n FROM orders');
      await executeQuery(window);
      await window.getByTestId('query-results-tab').first().click();
      await expect(window.getByTestId('results-row-count')).toHaveText('1');
      const [count] = await gridColumnValues(window, 'n');
      expect(Number(count)).toBeGreaterThan(0);
    });
  });

  test('the plan tab is retired by the next ordinary run', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await typeSql(window, 'SELECT id FROM customers ORDER BY id');
      await showExecutionPlan(window);
      await expect(planTab(window)).toBeVisible();

      // The Angular `planData` signal was cleared only by the next PLAN request, so the tab stayed up
      // showing the previous statement's plan after any Execute.
      await executeQuery(window);
      await expect(planTab(window)).toBeHidden();
    });
  });

  test('refuses an empty editor, and says so', async () => {
    await withJoineryReact(async ({ window }) => {
      await readyEditor(window);
      await window.getByTestId('query-execution-plan').click();
      await expect(window.getByText('No SQL to explain')).toBeVisible();
      await expect(planTab(window)).toBeHidden();
    });
  });

  test('is reachable from the palette, and greyed with a reason without a query tab', async () => {
    await withJoineryReact(async ({ window }) => {
      await createPostgresProfile(window, PROFILE);
      await connectFromSidebar(window, PROFILE);

      // No query tab in front: the entry is present and disabled, never hidden.
      await openPalette(window);
      expect(await paletteRowState(window, 'command:show-execution-plan')).toBe('unavailable');
      await window.keyboard.press('Escape');

      await selectDatabase(window, 'joinery_test');
      await openQueryTab(window);
      await typeSql(window, 'SELECT 1');

      // ⇧⌘P, the palette's second binding. ⌘K works from inside Monaco too since J-73 released it
      // (`query-keybindings.spec.ts` presses it there); this stays as the ⇧⌘P path's coverage.
      await openPaletteFromEditor(window);
      expect(await paletteRowState(window, 'command:show-execution-plan')).toBe('ready');
      await runPaletteCommand(window, 'command:show-execution-plan');

      await expect(planTab(window)).toBeVisible({ timeout: 20_000 });
    });
  });
});
