/**
 * The chat tab — the same surface as the side panel, mounted by Dockview.
 *
 * Replaces the `ChatPanel` placeholder in `shell/workspace/tab-panels.tsx`. It reads `params.tabId`
 * and nothing else from the dock, which is the contract every Phase B surface consumes
 * (`features/query/query-panel.tsx` does the same), and it is not behind a lazy boundary: the chat
 * surface's heaviest dependency is the markdown renderer, which the side panel already pulls into the
 * eager chunk, and mermaid is `import()`ed on first diagram inside `src/markdown/`.
 *
 * Two things happen here that the surface itself must not do:
 *
 *  1. **the store hand-off** — `chat-store-host.ts` holds it, because this component unmounts whenever
 *     Dockview deactivates the panel and the store has to outlive that;
 *  2. **the tab title** follows the conversation, so two chat tabs are told apart by what is in them.
 *     `openChatTab` titles every tab "AI Chat"; the conversation gets its own title from the first
 *     message the user sends (`state/chat.ts:sendMessage`), and that is a far better tab label than a
 *     type name repeated.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import type { IDockviewPanelProps } from 'dockview-react';

import { selectActiveConversation } from '../../state/chat';
import { tabStore } from '../../state/tab';
import { ChatSurface } from './chat-surface';
import { chatStoreForTab } from './chat-store-host';

/** The conversation a restored tab was opened against, out of the tab's own metadata. */
function conversationIdFor(tabId: string): string | undefined {
  const metadata = tabStore.getState().tabs.find(tab => tab.id === tabId)?.metadata;
  const conversationId = metadata?.['conversationId'];
  return typeof conversationId === 'string' ? conversationId : undefined;
}

export function ChatTabPanel(props: IDockviewPanelProps) {
  const tabId = typeof props.params['tabId'] === 'string' ? props.params['tabId'] : props.api.id;

  // Created on the first mount for this tab and reused on every later one. `useMemo` rather than an
  // effect: the surface below needs the store on its first render, and a store arriving one commit
  // late would mean a frame with no transcript in it every time the tab is re-activated.
  const store = useMemo(() => chatStoreForTab(tabId, conversationIdFor(tabId)), [tabId]);

  const conversationTitle = useStore(store, selectActiveConversation)?.title;
  /** The conversation title this component last pushed onto the tab. See the effect below. */
  const applied = useRef<string | undefined>(undefined);

  /**
   * Follow the conversation's title — but only when the CONVERSATION's title changes, never merely
   * when the two disagree.
   *
   * The difference is a bug: the tab strip has its own rename affordance
   * (`shell/workspace/panel-tab.tsx`), and a "rename whenever they differ" effect reverts a user's tab
   * name on the very next render. Comparing against what this effect last applied means the user's
   * name survives until the conversation is itself renamed or switched, which is the only moment the
   * tab has a new fact to follow.
   */
  useEffect(() => {
    if (conversationTitle === undefined || conversationTitle === applied.current) return;
    applied.current = conversationTitle;
    tabStore.getState().renameTab(tabId, conversationTitle);
  }, [conversationTitle, tabId]);

  /**
   * **No release effect here, deliberately** — `chat-store-host.ts` watches `tabStore.tabs` and
   * releases the store when the tab dies.
   *
   * Because this component has no cleanup of its own, that watcher is the only path that ever calls
   * `destroy()`. The host's comment carries the argument — including the correction (J-62) to what
   * this comment used to claim about Dockview unmounting a deactivated panel, which it does not do.
   */

  return <ChatSurface store={store} mode="tab" />;
}
