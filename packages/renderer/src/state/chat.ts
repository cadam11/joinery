/**
 * AI chat: conversations, messages, the streaming assembly, tool-call confirmation, and the UI
 * actions the model can request.
 *
 * ── Why this is one file and not two ────────────────────────────────────────────────────────
 *
 * The brief allows a merge where two Angular files are so entangled that keeping them apart costs
 * more than it explains, and `chat.state.ts` (384) / `chat-instance.state.ts` (354) are the case
 * it was written for. They are the same store twice: `setupStreamListener`, `newConversation`,
 * `selectConversation`, `deleteConversation`, `sendMessage`, `confirmToolCall`,
 * `renameConversation`, `cancelStream`, `consumeUiAction` and `handleUiAction` are duplicated
 * character-for-character, because Angular's `providedIn: 'root'` could not express "one of these
 * per chat tab" and a second, hand-copied class was the workaround. The only real differences are
 * that the side panel also owns `tools` and its open/closed flag, and that an instance may be
 * constructed pointing at an existing conversation.
 *
 * The store conventions already answer this properly: `createChatStore()` is the per-instance
 * store, and the side panel is one instance of it. Task 17 creates one per chat tab and calls
 * `destroy()` when the tab closes. Copying 300 lines to preserve a file boundary that only
 * existed to work around dependency injection would be porting the workaround, not the behaviour.
 *
 * Ported from both files. Conventions: `capabilities.ts`. Consumer: Task 17.
 */

import { create } from 'zustand';
import type {
  ChatMessage,
  ChatStreamChunk,
  Conversation,
  ToolCallResult,
  ToolDefinition,
} from '@joinery/shared';
import { ipc, isIpcAvailable } from '../ipc';

/**
 * A conversation as the sidebar list needs it: everything except the transcript.
 *
 * Named here rather than in `@joinery/shared` because it describes what this store keeps, not what
 * the IPC boundary carries — main still answers with whole conversations.
 */
export type ConversationSummary = Omit<Conversation, 'messages'>;

/** Drop the transcript. See the `conversations` field for why it must not be kept (J-63). */
function summarise(conversation: Conversation): ConversationSummary {
  const { messages: _messages, ...summary } = conversation;
  return summary;
}
import { capabilitiesStore, selectVariantFor, type CapabilitiesStore } from './capabilities';
import { connectionStore, selectProfileFor, type ConnectionStore } from './connection';
import { diagnostics } from './diagnostics';
import { selectActiveTab, tabStore, type TabStore } from './tab';

/** How much of the first user message becomes the conversation title. */
const TITLE_MAX_LENGTH = 50;

export type ChatUiAction = NonNullable<ChatStreamChunk['uiAction']>;

export interface ChatStoreState {
  /**
   * The sidebar list: metadata only, deliberately WITHOUT `messages` (J-63).
   *
   * `listConversations` answers with whole conversations, transcripts included. Held as-is, that
   * array is a snapshot taken once at load and never re-synced, while `applyChunk` patches the
   * live `messages` beside it — so any future reader of `conversations[].messages` would render a
   * transcript that stopped updating the moment a stream began. Nothing reads it today, which is
   * exactly when to remove the trap rather than to add a sync nobody needs. The transcript has one
   * source: `selectConversation`, which asks main.
   */
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId: string | null;
  readonly messages: readonly ChatMessage[];
  readonly streaming: boolean;
  readonly streamingContent: string;
  /** Tool definitions for the confirmation UI. Only the panel instance loads them. */
  readonly tools: readonly ToolDefinition[];
  readonly conversationsExpanded: boolean;
  /** A dialog-opening action the model asked for, waiting for a component to act on it. */
  readonly pendingUiAction: ChatUiAction | null;
  /** Side-panel visibility. Meaningful on the panel instance; inert on chat-tab instances. */
  readonly panelOpen: boolean;

  readonly togglePanel: () => void;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly toggleConversations: () => void;

  readonly initialize: () => Promise<void>;
  readonly newConversation: () => Promise<void>;
  readonly selectConversation: (id: string) => Promise<void>;
  readonly deleteConversation: (id: string) => Promise<void>;
  readonly renameConversation: (id: string, title: string) => Promise<void>;

  readonly sendMessage: (
    content: string,
    vendorId?: string,
    modelApiName?: string
  ) => Promise<void>;
  readonly confirmToolCall: (toolCallId: string, confirmed: boolean) => Promise<void>;
  readonly cancelStream: () => void;
  readonly consumeUiAction: () => ChatUiAction | null;

  /** Tears down this instance's stream subscription. Call when the chat tab closes. */
  readonly destroy: () => void;
}

export interface ChatStoreDeps {
  readonly connection: ConnectionStore;
  readonly tab: TabStore;
  readonly capabilities: CapabilitiesStore;
}

export interface ChatStoreOptions {
  /** Start pointed at an existing conversation — a chat tab restored with a conversation id. */
  readonly initialConversationId?: string;
  /**
   * Load the tool catalogue during `initialize()`.
   *
   * A flag rather than an unconditional fetch because `chat-instance.state.ts` did not make the call
   * and the difference had to be portable. **Both callers now pass true** — see `createChatTabStore`
   * for why the Angular chat tab's omission was a bug rather than a saving. It stays a flag so a
   * future instance that renders no confirmations (a read-only transcript view) can say so.
   */
  readonly loadTools?: boolean;
}

/**
 * Replace the trailing assistant message, which is where every streaming update lands. Returns
 * the list unchanged when the last message is not an assistant message, exactly as the Angular
 * original did — a chunk that arrives after the placeholder is gone is dropped rather than
 * rewriting a user message.
 *
 * Only for the things that genuinely belong to the message being written: the delta, the `done`
 * finalization, a brand-new tool call. Anything addressed by a tool-call ID goes through
 * `patchToolCallById` instead — see its comment.
 */
function patchLastAssistantMessage(
  messages: readonly ChatMessage[],
  patch: (last: ChatMessage) => ChatMessage
): readonly ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'assistant') return messages;
  return [...messages.slice(0, -1), patch(last)];
}

/**
 * Patch ONE tool call, in whichever message holds it. Returns the list unchanged (by identity, so
 * callers can detect the miss) when no message carries that id.
 *
 * Addressing by id rather than by "the last assistant message" is not tidiness. A tool
 * confirmation can outlive the turn that produced it: the main process holds the turn open while it
 * waits for the answer (J-61), but the card itself survives the turn ending — it is still in the
 * transcript when the answer's result chunk lands, and a conversation reopened from `chat-history/`
 * can show one with no stream behind it at all. So the card can sit in a *finished* message that any
 * later message pushes out of last position. The composer refuses to send while a confirmation is
 * pending (`selectHasPendingConfirmation`), which is what stops that from happening at all — but "the
 * decline silently patched a newer message" is exactly the class of bug a positional patch invites,
 * and a result chunk that arrives late has the same shape.
 *
 * Identity is preserved for every message that is not the one being patched, which is what the R3
 * memo boundary in `features/chat/chat-message.tsx` depends on.
 */
function patchToolCallById(
  messages: readonly ChatMessage[],
  toolCallId: string,
  patch: (toolCall: ToolCallResult) => ToolCallResult
): readonly ChatMessage[] {
  const index = messages.findIndex(message =>
    (message.toolCalls ?? []).some(toolCall => toolCall.id === toolCallId)
  );
  const target = messages[index];
  if (target === undefined) return messages;

  const toolCalls = (target.toolCalls ?? []).map(toolCall =>
    toolCall.id === toolCallId ? patch(toolCall) : toolCall
  );
  return messages.map((message, at) => (at === index ? { ...target, toolCalls } : message));
}

/**
 * Answer every tool call still waiting on the user, as "stopped".
 *
 * Stop is the only control the composer offers while a card waits, so it has to be an answer
 * (J-131). Clearing `streaming` alone left the card armed and the composer still gated on it by
 * `selectHasPendingConfirmation`, and approving afterwards resumed a turn the transcript had
 * already closed — the J-61 hang, from the other end. `ChatService.stopStream` disarms main's copy
 * of the same calls over `chat:cancel-stream`; this is the local half, so the card changes the
 * moment Stop is pressed rather than a round trip later.
 *
 * Every message that holds no pending call is returned by identity, which is what the R3 memo
 * boundary in `features/chat/chat-message.tsx` depends on.
 */
function disarmPendingToolCalls(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.map(message => {
    const toolCalls = message.toolCalls ?? [];
    if (!toolCalls.some(toolCall => toolCall.pendingConfirmation === true)) return message;
    return {
      ...message,
      toolCalls: toolCalls.map(toolCall =>
        toolCall.pendingConfirmation === true
          ? { ...toolCall, pendingConfirmation: false, success: false, error: 'Stopped by user' }
          : toolCall
      ),
    };
  });
}

/**
 * What a stopped answer says. The main process emits no partial text when a stream is aborted
 * (`cancelStream` just aborts the controller; the terminal chunk `stopStream` may send for a parked
 * confirmation carries no content), so the renderer is the only place that can write the partial
 * answer into the transcript — and a truncated answer that does not say it was truncated is a lie
 * about what the model said.
 */
function stoppedContent(partial: string): string {
  const kept = partial.trimEnd();
  return kept === '' ? '_Stopped before the answer began._' : `${kept}\n\n_— stopped_`;
}

export type ChatStore = ReturnType<typeof createChatStore>;

export function createChatStore(deps: ChatStoreDeps, options: ChatStoreOptions = {}) {
  let streamCleanup: (() => void) | null = null;

  const store = create<ChatStoreState>()((set, get) => {
    const handleUiAction = (action: ChatUiAction): void => {
      const params = action.params ?? {};
      switch (action.type) {
        case 'open-query-tab': {
          const connectionId = deps.connection.getState().focusedConnectionId();
          const database =
            (params['database'] as string | undefined) ??
            deps.connection.getState().focusedDatabaseName();
          if (connectionId && database) {
            deps.tab
              .getState()
              .openQueryTab(
                connectionId,
                database,
                params['sql'] as string | undefined,
                (params['autoExecute'] as boolean | undefined) ?? false
              );
          }
          break;
        }
        case 'navigate-database': {
          const focused = deps.connection.getState().focusedConnectionId();
          if (params['database'] && focused) {
            deps.connection.getState().selectDatabase(focused, params['database'] as string);
          }
          break;
        }
        default:
          // open-settings / open-create-db-dialog / open-backup-dialog: a component owns the
          // dialog, so the action is parked for it to consume.
          set({ pendingUiAction: action });
          break;
      }
    };

    const applyChunk = (chunk: ChatStreamChunk): void => {
      // One bridge subscription serves every instance, so each one filters by conversation. This
      // is what keeps two open chat tabs from writing each other's tokens.
      if (chunk.conversationId !== get().activeConversationId) return;

      if (chunk.delta) {
        set(state => ({ streamingContent: state.streamingContent + chunk.delta }));
      }

      if (chunk.toolCall) {
        // Either awaiting confirmation or already running; `success` flips when the result lands.
        const toolEntry: ToolCallResult = {
          id: chunk.toolCall.id,
          toolName: chunk.toolCall.toolName,
          args: chunk.toolCall.args,
          success: false,
          pendingConfirmation: chunk.toolCall.pendingConfirmation || false,
        };
        set(state => ({
          messages: patchLastAssistantMessage(state.messages, last => ({
            ...last,
            toolCalls: [...(last.toolCalls ?? []), toolEntry],
          })),
        }));
      }

      const toolResult = chunk.toolResult;
      if (toolResult) {
        set(state => {
          // By id first: a confirmed tool's result arrives a whole confirmation later than the card
          // that announced it, so the card it belongs to is not necessarily in the last message.
          const patched = patchToolCallById(state.messages, toolResult.id, () => toolResult);
          if (patched !== state.messages) return { messages: patched };
          // Auto-executed tools never announced themselves as a toolCall first, so there is nothing
          // to find and the running message is where the record belongs.
          return {
            messages: patchLastAssistantMessage(state.messages, last => ({
              ...last,
              toolCalls: [...(last.toolCalls ?? []), toolResult],
            })),
          };
        });
      }

      if (chunk.uiAction) handleUiAction(chunk.uiAction);

      if (chunk.done) {
        // Finalize the placeholder and always clear the streaming flag, even if no delta arrived.
        const content = get().streamingContent;
        set(state => ({
          messages: patchLastAssistantMessage(state.messages, last =>
            last.streaming ? { ...last, content: content || last.content, streaming: false } : last
          ),
          streaming: false,
          streamingContent: '',
        }));
      }
    };

    if (isIpcAvailable()) {
      streamCleanup = ipc().chat.onStreamChunk(applyChunk);
    }

    return {
      conversations: [],
      activeConversationId: options.initialConversationId ?? null,
      messages: [],
      streaming: false,
      streamingContent: '',
      tools: [],
      conversationsExpanded: false,
      pendingUiAction: null,
      panelOpen: false,

      togglePanel: () => set(state => ({ panelOpen: !state.panelOpen })),
      openPanel: () => set({ panelOpen: true }),
      closePanel: () => set({ panelOpen: false }),
      toggleConversations: () =>
        set(state => ({ conversationsExpanded: !state.conversationsExpanded })),

      initialize: async () => {
        if (!isIpcAvailable()) return;
        try {
          const [tools, conversations] = await Promise.all([
            options.loadTools ? ipc().chat.getTools() : Promise.resolve<ToolDefinition[]>([]),
            ipc().chat.listConversations(),
          ]);
          set({ tools, conversations: conversations.map(summarise) });

          // A tab restored against an existing conversation loads its transcript.
          const activeId = get().activeConversationId;
          if (activeId) {
            const conversation = await ipc().chat.getConversation(activeId);
            if (conversation) set({ messages: conversation.messages });
          }
        } catch (error) {
          diagnostics.error('failed to initialize chat state', error);
        }
      },

      newConversation: async () => {
        if (!isIpcAvailable()) return;
        try {
          const conversation = await ipc().chat.createConversation();
          set(state => ({
            conversations: [summarise(conversation), ...state.conversations],
            activeConversationId: conversation.id,
            messages: [],
            streamingContent: '',
          }));
        } catch (error) {
          diagnostics.error('failed to create conversation', error);
        }
      },

      selectConversation: async id => {
        if (!isIpcAvailable()) return;
        // Set first: chunks for the newly selected conversation must not be filtered out while
        // its transcript is still loading.
        set({ activeConversationId: id });
        try {
          const conversation = await ipc().chat.getConversation(id);
          if (conversation) set({ messages: conversation.messages });
        } catch (error) {
          diagnostics.error('failed to load conversation', error);
        }
      },

      deleteConversation: async id => {
        if (!isIpcAvailable()) return;
        try {
          await ipc().chat.deleteConversation(id);
          set(state => ({
            conversations: state.conversations.filter(c => c.id !== id),
            ...(state.activeConversationId === id
              ? { activeConversationId: null, messages: [] }
              : {}),
          }));
        } catch (error) {
          diagnostics.error('failed to delete conversation', error);
        }
      },

      renameConversation: async (id, title) => {
        if (!isIpcAvailable()) return;
        // Optimistic: the list updates before the round-trip so the rename feels immediate.
        set(state => ({
          conversations: state.conversations.map(c => (c.id === id ? { ...c, title } : c)),
        }));
        try {
          await ipc().chat.renameConversation(id, title);
        } catch (error) {
          diagnostics.error('failed to rename conversation', error);
        }
      },

      sendMessage: async (content, vendorId, modelApiName) => {
        if (!isIpcAvailable() || !content.trim()) return;

        let conversationId = get().activeConversationId;
        if (!conversationId) {
          await get().newConversation();
          conversationId = get().activeConversationId;
        }
        if (!conversationId) return;

        const timestamp = new Date().toISOString();
        const userMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: content.trim(),
          timestamp,
        };
        // The placeholder the stream fills in.
        const assistantMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          timestamp,
          streaming: true,
          toolCalls: [],
        };

        const title =
          content.substring(0, TITLE_MAX_LENGTH) + (content.length > TITLE_MAX_LENGTH ? '...' : '');

        set(state => ({
          messages: [...state.messages, userMessage, assistantMessage],
          streaming: true,
          streamingContent: '',
          conversations: state.conversations.map(c =>
            c.id === conversationId ? { ...c, title, updatedAt: timestamp } : c
          ),
        }));

        // Context the model gets for free: the connection, database, engine, and whatever SQL the
        // user is looking at.
        const connection = deps.connection.getState();
        const focusedConnectionId = connection.focusedConnectionId();
        const tabs = deps.tab.getState();
        const activeTab = selectActiveTab(tabs);
        const activeEditorContent =
          activeTab?.type === 'query' ? tabs.getTabContent(activeTab.id) : undefined;

        try {
          await ipc().chat.sendMessage({
            conversationId,
            message: content.trim(),
            connectionId: focusedConnectionId ?? undefined,
            databaseName: connection.focusedDatabaseName() ?? undefined,
            databaseEngine: selectProfileFor(focusedConnectionId)(connection)?.engine ?? undefined,
            engineVariant: selectVariantFor(focusedConnectionId ?? undefined)(
              deps.capabilities.getState()
            ),
            activeEditorContent: activeEditorContent || undefined,
            vendorId: vendorId || undefined,
            modelApiName: modelApiName || undefined,
          });
        } catch (error) {
          diagnostics.error('failed to send message', error);
          set(state => ({
            streaming: false,
            messages: patchLastAssistantMessage(state.messages, last =>
              last.streaming
                ? {
                    ...last,
                    content: 'Failed to get a response. Please try again.',
                    streaming: false,
                  }
                : last
            ),
          }));
        }
      },

      confirmToolCall: async (toolCallId, confirmed) => {
        const conversationId = get().activeConversationId;
        if (!conversationId || !isIpcAvailable()) return;

        // Only the decline path patches locally: an accepted call's outcome arrives as a
        // toolResult chunk, and pre-empting it would show a result the tool never produced.
        if (!confirmed) {
          set(state => ({
            messages: patchToolCallById(state.messages, toolCallId, toolCall => ({
              ...toolCall,
              pendingConfirmation: false,
              success: false,
              error: 'Cancelled by user',
            })),
          }));
        }

        try {
          await ipc().chat.confirmTool(conversationId, toolCallId, confirmed);
        } catch (error) {
          diagnostics.error('failed to confirm tool call', error);
        }
      },

      cancelStream: () => {
        const conversationId = get().activeConversationId;
        if (!conversationId || !isIpcAvailable()) return;
        // Fire-and-forget, but never silent: the local flags clear immediately so the UI stops
        // showing a spinner even if the main process is slow to acknowledge.
        ipc()
          .chat.cancelStream(conversationId)
          .catch(error => diagnostics.warn('failed to cancel chat stream', error));

        // **The partial answer is finalized here, and only here.** Clearing `streamingContent`
        // unmounts the tail, and no partial text ever comes back from main on a stop: a `done`
        // chunk may follow — `stopStream` sends one when it answers a parked confirmation, and an
        // aborted loop sends its own — but a terminal chunk carries no content, and by the time it
        // lands `streaming` is already false here, so it patches nothing. A cancel that only
        // cleared the flags therefore left the message marked `streaming: true` with an eternal
        // typing indicator under it and the text the model had already produced thrown away. The
        // content is read BEFORE the clear for that reason, and `stoppedContent` marks the
        // truncation so the transcript does not read like a complete answer that happens to stop
        // mid-sentence.
        const partial = get().streamingContent;
        set(state => ({
          messages: disarmPendingToolCalls(
            patchLastAssistantMessage(state.messages, last =>
              last.streaming === true
                ? { ...last, content: stoppedContent(partial || last.content), streaming: false }
                : last
            )
          ),
          streaming: false,
          streamingContent: '',
        }));
      },

      consumeUiAction: () => {
        const action = get().pendingUiAction;
        set({ pendingUiAction: null });
        return action;
      },

      destroy: () => {
        streamCleanup?.();
        streamCleanup = null;
      },
    };
  });

  return store;
}

/**
 * The side panel's instance. Created at module scope, which is where its bridge subscription
 * starts — the same point Angular's root-provided `ChatStateService` subscribed. Deferring the
 * subscription to first use was considered and rejected: `sendMessage` can create its own
 * conversation, so a lazy listener could miss the opening chunks of the first message.
 */
export const chatPanelStore = createChatStore(
  { connection: connectionStore, tab: tabStore, capabilities: capabilitiesStore },
  { loadTools: true }
);
export const useChatPanelStore = chatPanelStore;

/**
 * One chat-tab instance. `features/chat/chat-store-host.ts` owns the tab-id → store map and the
 * `destroy()` on close.
 *
 * **`loadTools: true`, resolving the Task 4 review's carried decision.** A chat tab renders tool
 * confirmations exactly as the panel does, and `ToolDefinition.description` is what a confirmation
 * needs in order to be one — `chat-instance.state.ts` never loaded the catalogue, which is why the
 * Angular chat tab asked "Execute run_query?" and said nothing about what that would do. The two
 * candidate fixes were this flag and reading the catalogue off `chatPanelStore`; per-tab load wins on
 * three counts:
 *
 *  - **it is not a cheap fetch made expensive.** `chat.getTools()` returns the tool registry's static
 *    in-process array (`chat-service.ts:getTools`), so the "N fetches" sharing would avoid are N cheap
 *    round trips of the same constant, bounded by the number of chat tabs a user opens;
 *  - **sharing would make a tab depend on the panel's lifetime.** `chatPanelStore.tools` is only
 *    populated by that instance's `initialize()`, which runs when the side panel MOUNTS — so a tab's
 *    confirmations would carry descriptions only if the user had opened the panel at some point in the
 *    session. A confirmation that is informative depending on unrelated UI history is worse than one
 *    that is always informative;
 *  - **failure stays local**, which is the property the per-instance factory exists for: a tab whose
 *    catalogue read failed shows name-only confirmations instead of every surface losing them at once.
 */
export function createChatTabStore(initialConversationId?: string): ChatStore {
  return createChatStore(
    { connection: connectionStore, tab: tabStore, capabilities: capabilitiesStore },
    { initialConversationId, loadTools: true }
  );
}

export function selectActiveConversation(
  state: Pick<ChatStoreState, 'conversations' | 'activeConversationId'>
): ConversationSummary | null {
  return state.conversations.find(c => c.id === state.activeConversationId) ?? null;
}

export function selectHasConversations(state: Pick<ChatStoreState, 'conversations'>): boolean {
  return state.conversations.length > 0;
}

/**
 * Is a tool call in this conversation waiting on the user?
 *
 * The composer is gated on this as well as on `streaming`, because the two are not the same state.
 * They do overlap now: since J-61 the main process holds the turn open across a confirmation — the
 * `pendingConfirmation` chunk goes out and `done: true` does not follow until the call is answered —
 * so `streaming` is **true** while the card is on screen. But a pending card still reaches a state with
 * no stream behind it: one restored from `chat-history/` when the conversation is reopened, where an
 * ungated composer is fully live with a filled Send in it. (Stop used to be a second such state; since
 * J-131 it disarms the card instead of leaving it armed over a closed turn.)
 * Sending then orphans the card — the local decline would patch a message that is no longer the one
 * holding the tool call, and the main process's own `confirmToolCall` looks the id up in the LAST
 * assistant message (`ChatService.findToolCall`), which the new turn displaced, so approving runs
 * nothing. Since J-60 it at least answers `'no-such-tool-call'` and logs the miss instead of
 * returning silently, but nothing on screen says so — which is why the composer is gated here.
 *
 * Cheap by shape rather than by memoisation: the scan stops at the first pending call, and `messages`
 * only changes once per message or tool event — never per token.
 */
export function selectHasPendingConfirmation(state: Pick<ChatStoreState, 'messages'>): boolean {
  return state.messages.some(message =>
    (message.toolCalls ?? []).some(toolCall => toolCall.pendingConfirmation === true)
  );
}
