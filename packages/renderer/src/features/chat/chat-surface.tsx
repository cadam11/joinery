/**
 * The chat surface: one component, mounted twice — as the shell's side panel and as a dock tab.
 *
 * Replaces `features/chat/chat-panel.component.ts` (1,567 lines, of which ~790 were a stylesheet).
 * The Angular component took `isTabMode` and branched on it in fifteen places, including a
 * `[style.width.px]` and a `.collapsed { width: 0 !important }` for the panel case; here the shell
 * owns the panel's geometry (`app-shell.tsx` — a persisted split with a keyboard-operable divider)
 * and `mode` decides exactly three things: whether the header offers "open as a tab" and "close",
 * and which store instance the caller passes in.
 *
 * ── Which store, and why the caller chooses ────────────────────────────────────────────────
 *
 * `createChatStore` is per-instance (Task 4), so the panel has one and every chat tab has its own —
 * that is what keeps two open chats from writing each other's transcript, and `state/chat.spec.ts`
 * pins it. This component therefore takes the store as a prop and holds no module state of its own;
 * `chat-store-host.ts` owns the tab-id → store map, and `shell/chat-side-panel.tsx` passes the
 * singleton.
 *
 * ── What this component subscribes to, and what it does NOT ────────────────────────────────
 *
 * R3, restated as a rule about this file: **nothing here subscribes to `streamingContent`.** The
 * fields read below (`messages`, `conversations`, `streaming`, …) change once per message or once per
 * tool call, never per token; the in-flight text is read by `<StreamingTail>` alone, through a ref
 * and a 50ms boundary (`use-stream-tail.ts`). The composer owns its own text for the same reason.
 *
 * ── The model's UI actions land here ──────────────────────────────────────────────────────
 *
 * `ChatStoreState.pendingUiAction` is the store's parking space for a `uiAction` chunk the model
 * sent that a *component* has to act on — "open settings", "open the backup dialog". Consuming it
 * belongs to a mounted surface, and this is the mounted surface. Each instance consumes its own
 * parked action, so a panel and a tab cannot both open the same dialog.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { ChevronDown, PanelRightClose, Plus, SquareArrowOutUpRight, Sparkles } from 'lucide-react';
import type { OpenRouterCostTier, ToolDefinition } from '@joinery/shared';

import { dispatchCommand } from '../../commands';
import {
  selectEnabledVendors,
  selectHasConfiguredVendors,
  selectVendorSettings,
  useAIStore,
} from '../../state/ai';
import {
  selectFocusedConnectionId,
  selectFocusedDatabaseName,
  selectProfileFor,
  useConnectionStore,
} from '../../state/connection';
import {
  selectActiveConversation,
  selectHasPendingConfirmation,
  type ChatStore,
} from '../../state/chat';
import { selectEffectiveTheme, useSettingsStore } from '../../state/settings';
import { tabStore, useTabStore } from '../../state/tab';
import { Icon, Tooltip, cn } from '../../ui';
import { mermaidThemeFor } from './chat-message';
import { ChatComposer, type SelectedModel } from './chat-composer';
import { ChatTranscript } from './chat-transcript';
import { ConversationList } from './conversation-list';

/** The header's icon buttons. 20px in a 32px bar, with the focus ring dense chrome needs. */
const HEADER_BUTTON_CLASSES = cn(
  'flex size-5 shrink-0 items-center justify-center rounded-xs',
  'text-fg-muted hover:bg-hover hover:text-fg',
  'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
);

export type ChatSurfaceMode = 'panel' | 'tab';

export interface ChatSurfaceProps {
  readonly store: ChatStore;
  readonly mode: ChatSurfaceMode;
}

/**
 * What the model is told about the database, shown to the user.
 *
 * It reads the SAME source `sendMessage` does — `selectFocusedConnectionId`, which derives from the
 * **active tab** — so this line cannot claim context the model does not get.
 *
 * That used to mean a chat TAB had none at all: focus derived from the active QUERY tab, and with a
 * chat tab in front there is none. J-59 made a chat tab carry the connection it was opened from,
 * the way every other tab type does, so this line now reads that instead of apologising for it.
 * A tab opened with no context still says so.
 */
function ChatContextLine() {
  const connectionId = useTabStore(selectFocusedConnectionId);
  const database = useTabStore(selectFocusedDatabaseName);
  const profile = useConnectionStore(selectProfileFor(connectionId));

  const text =
    profile === undefined || profile === null
      ? 'No database context — open a query tab'
      : `${profile.name}${database === null ? '' : ` → ${database}`}`;

  return (
    <p
      data-testid="chat-context"
      className="flex h-6 shrink-0 items-center gap-1 border-b border-rule px-3 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase"
    >
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}

export function ChatSurface({ store, mode }: ChatSurfaceProps) {
  const conversations = useStore(store, state => state.conversations);
  const activeConversationId = useStore(store, state => state.activeConversationId);
  const messages = useStore(store, state => state.messages);
  const streaming = useStore(store, state => state.streaming);
  const tools = useStore(store, state => state.tools);
  const conversationsExpanded = useStore(store, state => state.conversationsExpanded);
  const pendingUiAction = useStore(store, state => state.pendingUiAction);
  const activeConversation = useStore(store, selectActiveConversation);
  // A pending tool confirmation is a second reason the composer refuses, and it is NOT a sub-case of
  // `streaming` — the stream is already finished when the card appears. See the selector.
  const awaitingConfirmation = useStore(store, selectHasPendingConfirmation);

  const providerConfigured = useAIStore(selectHasConfiguredVendors);
  const vendors = useAIStore(useShallow(selectEnabledVendors));
  const theme = useSettingsStore(selectEffectiveTheme);

  const [model, setModel] = useState<SelectedModel | null>(null);

  /**
   * The pinned model's vendor's routing band — read straight out of `aiStore`, never copied into
   * this component (J-92).
   *
   * That is the whole shared-state claim: the composer's picker and the AI setup dialog's selector
   * both render `AIVendorSettings.autoRouterCostTier` for the same vendor and both write it through
   * `setAutoRouterCostTier`, so a change in either is a change in the other, and the main process
   * reads the one field either way (`ai-service.ts`'s `autoRouterCostTierFor`).
   *
   * A scalar subscription, not one that returns the settings object: `selectVendorSettings` may
   * answer `undefined` for a vendor with no entry, and subscribing to the record would hand zustand
   * a new identity on every store write (`state/capabilities.ts` rule 3).
   */
  const costTier = useAIStore(state =>
    model === null ? undefined : selectVendorSettings(model.vendorId)(state)?.autoRouterCostTier
  );

  const changeCostTier = useCallback(
    (next: OpenRouterCostTier | undefined): void => {
      // Guarded rather than asserted non-null: the picker only renders beside a pinned model, but a
      // menu selection resolving after the model was cleared must write nothing rather than throw.
      if (model === null) return;
      void useAIStore.getState().setAutoRouterCostTier(model.vendorId, next);
    },
    [model]
  );

  /**
   * The chat store, on every mount — **except while a stream is open.**
   *
   * No once-only latch, deliberately: re-mounting is how a user re-opens this surface, and the
   * conversation list may have changed in another instance, so the refresh is one they should get.
   *
   * The `streaming` guard is not defensive dressing; it closes a real hole this port opens. Angular's
   * panel was never unmounted — closing it set `width: 0` — so its `ngOnInit` ran once per window. Here
   * ⇧⌘I unmounts the panel and re-opening it re-runs this effect, and `initialize()` refetches the
   * active conversation from the main process, whose saved copy does NOT contain the in-flight assistant
   * message. Without the guard, closing and re-opening the panel mid-answer would replace the transcript
   * with the persisted one, unmount the tail, and silently drop the answer being written.
   *
   * **`aiStore` is deliberately NOT hydrated here.** Task 17 did it from this effect because nothing
   * else did, and the side effect was that opening the assistant was what switched auto-rename and
   * query-assist on for a user with existing keys. Task 19a's `features/ai-setup/AiSetupHost` is
   * always mounted and owns that fetch now (J-55), so there is exactly one caller of
   * `aiStore.initialize()` and it runs before this surface exists.
   */
  useEffect(() => {
    if (!store.getState().streaming) void store.getState().initialize();
  }, [store]);

  // There is deliberately NO `destroy()` on unmount here. The panel's store is a module singleton
  // whose bridge subscription is set up once, at construction, and `destroy()` cannot be undone — so
  // tearing it down when the panel closed would leave a reopened panel permanently deaf to the stream.
  // A chat TAB's store is owned by `chat-store-host.ts`, which destroys it when the TAB goes away
  // (which is not the same event as this component unmounting: Dockview unmounts an inactive panel).

  // A dialog the model asked for. Consumed (so it fires once) and routed through the command bus, so
  // the surface that owns each dialog stays its only owner.
  useEffect(() => {
    if (pendingUiAction === null) return;
    const action = store.getState().consumeUiAction();
    if (action === null) return;
    if (action.type === 'open-settings') dispatchCommand('open-settings');
    else if (action.type === 'open-backup-dialog') dispatchCommand('open-backup-dialog');
    else if (action.type === 'open-create-db-dialog') dispatchCommand('create-database');
  }, [pendingUiAction, store]);

  /** Tool name → definition. Memoised so `<ChatMessageView>`'s memo boundary holds. */
  const definitions = useMemo(
    () => new Map<string, ToolDefinition>(tools.map(tool => [tool.name, tool])),
    [tools]
  );

  const send = useCallback(
    (text: string): void => {
      void store.getState().sendMessage(text, model?.vendorId, model?.modelApiName);
    },
    [store, model]
  );

  const stop = useCallback((): void => store.getState().cancelStream(), [store]);

  const popOutToTab = useCallback((): void => {
    // Read BEFORE the panel closes and before the new tab becomes active: both change what the
    // focus selectors answer, and the point is to carry the context the user was looking at into
    // the tab (J-59). A panel with no context hands none on, which is correct.
    const tabs = tabStore.getState();
    const target = {
      connectionId: selectFocusedConnectionId(tabs) ?? undefined,
      databaseName: selectFocusedDatabaseName(tabs) ?? undefined,
    };

    // Closing first, then opening: the tab takes the conversation with it, and leaving both on screen
    // would give one conversation two live instances writing the same transcript.
    store.getState().closePanel();
    tabStore.getState().openChatTab(store.getState().activeConversationId ?? undefined, target);
  }, [store]);

  return (
    <div
      data-testid={mode === 'panel' ? 'chat-panel' : 'chat-tab'}
      data-chat-mode={mode}
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col',
        mode === 'panel' ? 'bg-chrome' : 'bg-canvas'
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-rule px-2">
        <Icon icon={Sparkles} size="sm" className="shrink-0 stroke-fg-muted" />

        <button
          type="button"
          data-testid="chat-conversations-toggle"
          aria-expanded={conversationsExpanded}
          onClick={() => store.getState().toggleConversations()}
          className={cn(
            'flex min-w-0 grow items-center gap-1 rounded-xs px-1 py-0.5 text-left',
            'hover:bg-hover',
            'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
          )}
        >
          <span data-testid="chat-title" className="min-w-0 truncate text-base text-fg">
            {activeConversation?.title ?? 'New chat'}
          </span>
          <Icon
            icon={ChevronDown}
            size="sm"
            className={cn('shrink-0 stroke-fg-muted', conversationsExpanded && 'rotate-180')}
          />
        </button>

        <Tooltip content="New conversation">
          <button
            type="button"
            aria-label="New conversation"
            data-testid="chat-new-conversation"
            onClick={() => void store.getState().newConversation()}
            className={HEADER_BUTTON_CLASSES}
          >
            <Icon icon={Plus} size="sm" />
          </button>
        </Tooltip>

        {mode === 'panel' ? (
          <>
            <Tooltip content="Open this conversation as a tab">
              <button
                type="button"
                aria-label="Open this conversation as a tab"
                data-testid="chat-pop-out"
                onClick={popOutToTab}
                className={HEADER_BUTTON_CLASSES}
              >
                <Icon icon={SquareArrowOutUpRight} size="sm" />
              </button>
            </Tooltip>
            <Tooltip content="Close the assistant (⇧⌘I)">
              <button
                type="button"
                aria-label="Close the assistant"
                data-testid="chat-panel-close"
                onClick={() => store.getState().closePanel()}
                className={HEADER_BUTTON_CLASSES}
              >
                <Icon icon={PanelRightClose} size="sm" />
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>

      {conversationsExpanded ? (
        <ConversationList
          store={store}
          conversations={conversations}
          activeConversationId={activeConversationId}
        />
      ) : null}

      <ChatContextLine />

      <ChatTranscript
        store={store}
        messages={messages}
        definitions={definitions}
        mermaidTheme={mermaidThemeFor(theme)}
        providerConfigured={providerConfigured}
        onSend={send}
      />

      <ChatComposer
        streaming={streaming}
        awaitingConfirmation={awaitingConfirmation}
        providerConfigured={providerConfigured}
        vendors={vendors}
        model={model}
        onModelChange={setModel}
        costTier={costTier}
        onCostTierChange={changeCostTier}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
