/**
 * One chat store per chat TAB, and the `destroy()` that goes with the tab closing.
 *
 * `state/chat.ts` names this file's job in its own header: "Task 17 owns the tab-id → store map and
 * the `destroy()` on close." The map exists because the store has to outlive any single mount of the
 * component that renders it: `ChatStoreState.destroy` is the only thing that unsubscribes the store
 * from the stream bridge, so a store held as component state would lose the transcript and leak a
 * listener every time the component was rebuilt. Keyed by tab id here, a tab keeps its conversation,
 * its in-flight stream and its ONE subscription across every re-mount — which is what
 * `chat-tab-panel.spec.tsx` pins.
 *
 * ── Why the release is watched here rather than done on unmount ────────────────────────────
 *
 * Because `chat-tab-panel.tsx` has no unmount cleanup at all. This watcher is the ONLY thing that ever
 * calls `destroy()`, so without it a closed tab's store would keep its bridge subscription for the
 * rest of the session. That is the entire argument, and it is a fact about this package rather than a
 * claim about Dockview.
 *
 * **This block used to say that Dockview unmounts a deactivated panel, and that was false** (J-62).
 * PLAN.md R5 finding 4 measured the opposite: with the default `onlyWhenVisible` renderer the panel's
 * React component **stays mounted** and only its DOM subtree is detached from the document. The J-62
 * review then showed, with a real `DockviewReact`, that closing an INACTIVE panel fires
 * `onDidRemovePanel` **before** the React unmount — so `workspace.tsx`'s `closeTab` always lands
 * first, and an unmount cleanup guarded by "the tab is gone" would in fact run. The correction is
 * recorded rather than merely deleted because the false sentence had already been copied once, into a
 * query-panel "fix" for a leak that did not exist (PR #123, closed). Do not reintroduce it.
 *
 * One subscription, started with the first tab store rather than at import so a renderer that never
 * opens a chat tab pays nothing, and stopped when the last store goes.
 */
import { createChatTabStore, type ChatStore } from '../../state/chat';
import { tabStore } from '../../state/tab';

const stores = new Map<string, ChatStore>();

/** The `tabStore` subscription that prunes closed tabs. Non-null exactly while `stores` is non-empty. */
let unwatchTabs: (() => void) | null = null;

/** Releases the store of every tab that is no longer open. Bounded by the size of the map. */
function releaseClosedTabs(): void {
  const live = new Set(tabStore.getState().tabs.map(tab => tab.id));
  for (const tabId of [...stores.keys()]) {
    if (!live.has(tabId)) releaseChatStore(tabId);
  }
}

function watchTabs(): void {
  if (unwatchTabs !== null) return;
  unwatchTabs = tabStore.subscribe((state, previous) => {
    // Identity, not content: `tabs` is replaced only when a tab is opened, closed, renamed or
    // reordered, and this must not run on every keystroke's `setTabContent`.
    if (state.tabs === previous.tabs) return;
    releaseClosedTabs();
  });
}

function stopWatchingTabs(): void {
  unwatchTabs?.();
  unwatchTabs = null;
}

/**
 * The store for one chat tab, created on first use.
 *
 * `conversationId` is read only when the store is created — it becomes the instance's
 * `initialConversationId`, which is how a tab restored from a persisted layout comes back pointing at
 * the transcript it had. A later call with a different id does NOT re-point the store: selecting a
 * conversation is `selectConversation`'s job, and quietly rebuilding the instance would drop an
 * in-flight stream.
 */
export function chatStoreForTab(tabId: string, conversationId?: string): ChatStore {
  const existing = stores.get(tabId);
  if (existing !== undefined) return existing;

  const created = createChatTabStore(conversationId);
  stores.set(tabId, created);
  watchTabs();
  return created;
}

/** Drops one tab's store and unsubscribes it from the bridge. Idempotent. */
export function releaseChatStore(tabId: string): void {
  const store = stores.get(tabId);
  if (store === undefined) return;
  stores.delete(tabId);
  store.getState().destroy();
  if (stores.size === 0) stopWatchingTabs();
}

/** How many tab stores are live. For tests, and for a leak assertion that means something. */
export function liveChatStoreCount(): number {
  return stores.size;
}

/** Drops every tab store. Tests only — production releases per tab. */
export function releaseAllChatStores(): void {
  for (const tabId of [...stores.keys()]) releaseChatStore(tabId);
}
