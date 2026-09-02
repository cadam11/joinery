/**
 * The tab workspace: Dockview 8, reconciled against `tabStore`, serialized through Task 5's
 * layout contract.
 *
 * Replaces `golden-layout-container.component.ts` (827) plus `golden-layout-manager.service.ts`
 * (713) — 1,540 lines that PLAN.md §1.6 names a top-3 source of the audit's `!important` debt.
 * Dockview was validated against the four hard requirements (PLAN.md R5) before any of this
 * existed; the spike's measurements are in the Task 7 report and the two that shaped this file are
 * cited inline.
 *
 * ── Who owns what ─────────────────────────────────────────────────────────────────────────
 *
 * `tabStore` is the source of truth for WHICH tabs exist and which one is active. Dockview is the
 * source of truth for the ARRANGEMENT — which group each panel sits in, and how big it is. Neither
 * is derived from the other, so both directions are wired:
 *
 *   store → dock   one effect, reconciling by id: add, close, retitle, re-activate, refresh params
 *   dock → store   three subscriptions: active panel changed, panel removed, layout changed
 *
 * ── The `applying` guard ──────────────────────────────────────────────────────────────────
 *
 * Every store → dock mutation is bracketed by a flag the dock → store handlers check, because
 * Dockview reports our own calls back to us: `addPanel` fires `onDidActivePanelChange`, `close`
 * fires `onDidRemovePanel`. Without the flag, closing a tab in the store would close the panel,
 * which would call `closeTab` again — terminating (the second call finds no tab) but only by
 * accident, and the activation round trip would fight the user mid-drag. One boolean, set in a
 * `try/finally` so a throw inside the reconciliation cannot leave it stuck on.
 *
 * `onDidLayoutChange` is deliberately NOT guarded: a panel this app added is a layout change worth
 * persisting. `layoutPersistence` owns both the debounce and the leaf gate that refuses every write
 * until the restore has finished — this component only hands over a way to read the arrangement.
 * The debounce lives there rather than here so that the pending write can be FLUSHED when the
 * window goes away instead of dying with the component (J-74).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewReactProps,
  type SerializedDockview,
} from 'dockview-react';

import { REACT_LAYOUT_VERSION, layoutPersistence } from '../../persistence';
import { logStore, useLogStore } from '../../state/logs';
import { tabStore, useTabStore, type Tab } from '../../state/tab';
import { diagnostics } from '../../state/diagnostics';
import { selectEffectiveTheme, useSettingsStore } from '../../state/settings';
import { useBootStore, type WorkspaceRestore } from '../boot';
import {
  OUTPUT_PANEL_ID,
  isTabPanelId,
  layoutHasOutputPanel,
  layoutTabStatesFrom,
  panelComponentFor,
  paramsSignature,
  tabPanelParams,
} from './dockview-sync';
import { OutputPanel } from './output-panel';
import { PanelTab, ReservedPanelTab } from './panel-tab';
import { QueryPanelHost } from './query-panel-host';
import { ChatTabPanel } from '../../features/chat';
import { ErdPanel } from '../../features/erd';
import { ObjectPanel } from '../../features/object-detail';
import { WelcomePanel } from '../../features/welcome';
import { WorkspaceWatermark } from './tab-panels';

/**
 * The five surfaces the dock mounts, plus the one reserved panel. Keys match `panelComponentFor`.
 *
 * All five are real as of Task 19a — `tab-panels.tsx` is down to the watermark. `query` is the only one
 * behind a lazy boundary; see `query-panel-host.tsx` for the 5MB reason.
 *
 * `erd` is NOT behind a lazy boundary. Its heaviest dependency is `@dagrejs/dagre` at ~40KB, which is
 * three orders of magnitude below the Monaco figure that earned `query` its boundary.
 */
const COMPONENTS: IDockviewReactProps['components'] = {
  welcome: () => <WelcomePanel />,
  query: QueryPanelHost,
  object: ObjectPanel,
  erd: ErdPanel,
  chat: ChatTabPanel,
  output: () => <OutputPanel />,
};

const TAB_COMPONENTS: NonNullable<IDockviewReactProps['tabComponents']> = {
  tab: PanelTab,
  reserved: ReservedPanelTab,
};

/**
 * Dockview's theme is a class name plus a few behavioural flags; `shell/dockview-theme.css` has the
 * variable map and the two-class rationale. `colorScheme` is what Dockview hands to panels that
 * want to know which palette is live, so it follows the resolved theme rather than being hardcoded.
 */
function dockTheme(colorScheme: 'dark' | 'light'): NonNullable<IDockviewReactProps['theme']> {
  return {
    name: 'joinery',
    className: 'dockview-theme-dark dockview-theme-joinery',
    colorScheme,
    dndTabIndicator: 'line',
    tabGroupIndicator: 'none',
  };
}

export function Workspace() {
  const api = useRef<DockviewApi | null>(null);
  /**
   * Set while a store → dock mutation is in flight. A ref rather than state: it is read inside
   * Dockview callbacks and must never cause a render.
   */
  const applying = useRef(false);
  /** Panel id → the `paramsSignature` last written, so params are refreshed only when they change. */
  const paramsWritten = useRef(new Map<string, string>());
  const [ready, setReady] = useState(false);

  const tabs = useTabStore(state => state.tabs);
  const activeTabId = useTabStore(state => state.activeTabId);
  const outputOpen = useLogStore(state => state.isOpen);
  const restore = useBootStore(state => state.workspaceRestore);
  const theme = useSettingsStore(selectEffectiveTheme);

  /**
   * Hands the arrangement to `layoutPersistence`, which owns the debounce and its flush (J-74).
   * The reader is a closure so `toJSON()` runs once, when the write goes out, rather than on every
   * `onDidLayoutChange` — see `ReadLayoutPayload`.
   */
  const scheduleSave = useCallback((dock: DockviewApi): void => {
    layoutPersistence.scheduleSave(() => ({
      version: REACT_LAYOUT_VERSION,
      dockview: dock.toJSON() as unknown as Record<string, unknown>,
      activeTabId: dock.activePanel?.id ?? null,
    }));
  }, []);

  // A pending debounce is a resource, and the dock handle the pending reader closed over is going
  // away with this component — so a hot reload or a remount drops it rather than writing it. The
  // window going away is the other case and is NOT this one: `flush-on-exit.ts` fires on
  // `beforeunload`, which is before any of this unmounts.
  useEffect(() => () => layoutPersistence.cancelPendingSave(), []);

  const onReady = useCallback<IDockviewReactProps['onReady']>(
    event => {
      const dock = event.api;
      api.current = dock;

      dock.onDidActivePanelChange(change => {
        if (applying.current) return;
        const id = change.panel?.id;
        if (id !== undefined && isTabPanelId(id)) tabStore.getState().activateTab(id);
      });

      dock.onDidRemovePanel(panel => {
        if (applying.current) return;
        // The user closed it — from our close button, the tab context menu, or a drag out of the
        // window. The store is told here and only here, so there is one path for "a panel went
        // away" no matter which affordance triggered it.
        if (panel.id === OUTPUT_PANEL_ID) logStore.getState().close();
        else tabStore.getState().closeTab(panel.id);
      });

      dock.onDidLayoutChange(() => scheduleSave(dock));

      setReady(true);
    },
    [scheduleSave]
  );

  // ── Restore: Decision C, once, before anything is allowed to be written ──────────────────
  useEffect(() => {
    const dock = api.current;
    if (!dock || !ready || restore.status !== 'restored' || restore.applied) return;

    applyRestore(dock, restore, applying);
    // Marking it applied in the boot store rather than in a local ref: React may re-run this
    // effect after a StrictMode remount with the same restore payload, and re-applying a layout
    // would discard whatever the user has done since.
    //
    // This call also OPENS THE LAYOUT WRITE GATE (`boot.ts:markRestoreApplied` →
    // `layoutPersistence.unlock`), which is why it is the statement immediately after the apply and
    // why nothing may be inserted between them: until it runs, `scheduleSave` below is a no-op, and
    // that is what stops Dockview's own initial empty arrangement from being saved over the user's.
    useBootStore.getState().markRestoreApplied();
  }, [ready, restore]);

  // ── store → dock ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const dock = api.current;
    // `restore.applied` gates the whole reconciliation: adding panels from the tab list before the
    // saved arrangement is in would put every tab in one default group and then immediately
    // rearrange them.
    if (!dock || !ready || !restore.applied) return;

    applying.current = true;
    try {
      reconcileTabs(dock, tabs, activeTabId, paramsWritten.current);
      reconcileOutputPanel(dock, outputOpen);
    } finally {
      applying.current = false;
    }
  }, [ready, restore.applied, tabs, activeTabId, outputOpen]);

  return (
    <div className="min-h-0 min-w-0 grow" data-testid="workspace">
      <DockviewReact
        className="size-full"
        theme={dockTheme(theme)}
        components={COMPONENTS}
        tabComponents={TAB_COMPONENTS}
        // Dockview's own no-panels overlay paints nothing under this theme, so an empty workspace
        // was a blank rectangle with no way back into the app.
        watermarkComponent={WorkspaceWatermark}
        // No `getTabContextMenuItems`: the tab strip owns its own context menu (`panel-tab.tsx`,
        // the port of the Angular one), and Dockview's built-in tab menu is an enterprise module
        // this app does not have — passing the prop only earns a runtime warning telling you so.
        // Floating and popout groups are real features, but they are window management this task
        // has not designed, tested or persisted — and a floating group the user cannot find again
        // is worse than not having them. Revisit with Task 23.
        disableFloatingGroups
        singleTabMode="default"
        onReady={onReady}
      />
    </div>
  );
}

/**
 * Applies a persisted arrangement, then makes the tab store agree with it.
 *
 * The order matters. `fromJSON` mounts panels whose `params` carry a `LayoutTabState`, and
 * `syncTabsFromLayout` turns any of those the store has never heard of into real tabs — which is
 * how an ERD, object or chat tab survives a restart at all, given `saveTabs` persists query tabs
 * only. Panels whose tab cannot be reconstructed are closed rather than left as headers with
 * nothing behind them.
 */
function applyRestore(
  dock: DockviewApi,
  restore: Extract<WorkspaceRestore, { status: 'restored' }>,
  applying: { current: boolean }
): void {
  applying.current = true;
  try {
    const payload = restore.layout;
    if (payload !== undefined) {
      try {
        dock.fromJSON(payload.dockview as unknown as SerializedDockview);
        tabStore.getState().syncTabsFromLayout(layoutTabStatesFrom(payload.dockview));
        if (layoutHasOutputPanel(payload.dockview)) logStore.getState().open();
      } catch (error) {
        // A layout Dockview cannot load is Decision C's first-launch case arriving late: clear it
        // and let the reconciliation rebuild from the tab list.
        diagnostics.error(
          'could not restore the saved workspace layout; rebuilding from tabs',
          error
        );
        dock.clear();
      }
    }

    // Drop restored panels with no tab behind them. `closeAllGroups` is not used: the surviving
    // panels' arrangement is the thing being restored.
    const knownTabIds = new Set(tabStore.getState().tabs.map(t => t.id));
    for (const panel of [...dock.panels]) {
      if (isTabPanelId(panel.id) && !knownTabIds.has(panel.id)) panel.api.close();
    }
  } finally {
    applying.current = false;
  }
}

/**
 * Makes the dock's tab panels match the store's tab list — add, close, retitle, re-activate, and
 * refresh the serialization params.
 *
 * MEASURED IN THE SPIKE: `addPanel` with no `position` puts every panel in a NEW group, so four
 * tabs became four side-by-side groups. Tabs have to be placed `within` an existing tab panel's
 * group to share one strip, and the anchor has to be a TAB panel — anchoring on
 * `dock.panels[0]` would drop a new tab into the Output panel's group whenever that was first.
 */
function reconcileTabs(
  dock: DockviewApi,
  tabs: readonly Tab[],
  activeTabId: string,
  paramsWritten: Map<string, string>
): void {
  for (const tab of tabs) {
    const params = tabPanelParams(tab);
    const signature = paramsSignature(params);
    const existing = dock.getPanel(tab.id);

    if (!existing) {
      const anchor = dock.panels.find(panel => isTabPanelId(panel.id));
      dock.addPanel({
        id: tab.id,
        component: panelComponentFor(tab.type),
        tabComponent: 'tab',
        title: tab.title,
        params,
        inactive: tab.id !== activeTabId,
        ...(anchor === undefined
          ? {}
          : { position: { referencePanel: anchor.id, direction: 'within' as const } }),
      });
      paramsWritten.set(tab.id, signature);
      continue;
    }

    if (existing.title !== tab.title) existing.api.setTitle(tab.title);
    if (paramsWritten.get(tab.id) !== signature) {
      existing.update({ params });
      paramsWritten.set(tab.id, signature);
    }
  }

  const openTabIds = new Set(tabs.map(t => t.id));
  for (const panel of [...dock.panels]) {
    if (!isTabPanelId(panel.id) || openTabIds.has(panel.id)) continue;
    panel.api.close();
    paramsWritten.delete(panel.id);
  }

  const active = activeTabId === '' ? undefined : dock.getPanel(activeTabId);
  if (active && dock.activePanel?.id !== active.id) active.api.setActive();
}

/**
 * Opens or closes the Output panel. `direction: 'below'` on first open puts it under the whole
 * grid, which is where a console belongs and where the Angular strip was — the difference being
 * that this one can then be resized, moved or docked elsewhere, and its position persists.
 */
function reconcileOutputPanel(dock: DockviewApi, open: boolean): void {
  const existing = dock.getPanel(OUTPUT_PANEL_ID);

  if (!open) {
    existing?.api.close();
    return;
  }
  if (existing) {
    if (dock.activePanel?.id !== existing.id) existing.api.setActive();
    return;
  }

  dock.addPanel({
    id: OUTPUT_PANEL_ID,
    component: 'output',
    tabComponent: 'reserved',
    title: 'Output',
    position: { direction: 'below' },
    // A third of a 900px window, which is close to the Angular strip's 220px and gives the
    // timeline enough rows to be worth opening.
    initialHeight: 260,
  });
}
