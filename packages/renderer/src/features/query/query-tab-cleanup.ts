/**
 * Releasing a query tab's per-tab state when the TAB dies, rather than when its panel unmounts.
 *
 * Two stores key state by tab id — `query-execution` (the result, the running record and the SQL that
 * produced the result) and `query-plan` (the plan tree). Both used to be dropped from `<QueryPanel>`'s
 * unmount cleanup, guarded by "the tab is gone", and that guard cannot see the case that matters:
 * Dockview unmounts an inactive panel's subtree (PLAN.md R5 finding 4), so a tab closed while it is NOT
 * in front never gets another unmount and its result set, its recorded SQL and its plan tree stay in
 * memory for the rest of the session (J-62).
 *
 * The fix is the one `features/chat/chat-store-host.ts` already made for the chat stores: watch the
 * thing that actually ends a tab, `tabStore.tabs`. Same mechanism, one file over, for the two stores
 * whose entries a query tab owns.
 *
 * The subscription is started by the first query panel to mount and is never stopped. Chat's can stop
 * because its map going empty means nothing is tracked; here the stores are process-wide singletons
 * that a still-mounted panel can write to at any time, so a watcher that stopped at "both maps empty"
 * would have to be restarted by an event that does not exist. One closure for the session is cheaper
 * than the bookkeeping that would end it.
 */

import { queryExecutionStore } from '../../state/query-execution';
import { queryPlanStore } from '../../state/query-plan';
import { tabStore } from '../../state/tab';

let watching = false;

/** Drops every tab id in either store that is no longer an open tab. Bounded by the stores' size. */
function releaseClosedTabs(): void {
  const live = new Set(tabStore.getState().tabs.map(tab => tab.id));
  const execution = queryExecutionStore.getState();
  const plans = queryPlanStore.getState();
  const tracked = new Set([
    ...execution.running.keys(),
    ...execution.results.keys(),
    ...execution.sqlByTab.keys(),
    ...plans.plans.keys(),
  ]);
  for (const tabId of tracked) {
    if (live.has(tabId)) continue;
    execution.forgetTab(tabId);
    plans.forgetTab(tabId);
  }
}

/** Starts the one `tabStore.tabs` watcher. Idempotent — every query panel calls it on mount. */
export function watchQueryTabs(): void {
  if (watching) return;
  watching = true;
  tabStore.subscribe((state, previous) => {
    // Identity, not content: `tabs` is replaced only when a tab is opened, closed, renamed or
    // reordered, and this must not run on every keystroke's `setTabContent`.
    if (state.tabs === previous.tabs) return;
    releaseClosedTabs();
  });
}
