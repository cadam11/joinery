/**
 * The chat bridge, doubled — one place, because four specs need the same thing.
 *
 * `state/chat.spec.ts` gets by with `{ chat: { onStreamChunk } }` because it only drives chunks. The
 * Task 17 specs drive the whole surface: conversation CRUD, the tool catalogue, `sendMessage`, and the
 * AI settings that decide whether chat is available at all. Assembling that inline four times is how
 * four specs end up disagreeing about what the main process does.
 *
 * Two things this double is careful about, because they are the behaviours under test:
 *
 *  - **`onStreamChunk` is one subscription per store instance**, and `emit` pushes to every live
 *    listener — the same shape `packages/preload/src/index.ts:createEventListener` has, via
 *    `recordSubscription`. A double that fanned out differently would make per-instance filtering
 *    untestable;
 *  - **conversations are held here**, so `createConversation` then `listConversations` agrees with
 *    itself the way the main process's `chat-history` directory does.
 */

import type {
  AISettings,
  AIVendor,
  ChatStreamChunk,
  Conversation,
  ToolDefinition,
} from '@joinery/shared';
import { DEFAULT_AI_SETTINGS } from '@joinery/shared';

import { capabilitiesStore } from '../state/capabilities';
import { connectionStore } from '../state/connection';
import { createChatStore, type ChatStore, type ChatStoreOptions } from '../state/chat';
import { tabStore } from '../state/tab';
import { installJoineryMock, recordSubscription } from './joinery-mock';

export interface ChatDoubleOptions {
  readonly conversations?: readonly Conversation[];
  readonly tools?: readonly ToolDefinition[];
  readonly vendors?: readonly AIVendor[];
  readonly settings?: AISettings;
  /** Rejects every `sendMessage`, so the store's failure path can be driven. */
  readonly failSend?: boolean;
}

export interface ChatDouble {
  /** Pushes a chunk to every live listener, as the main process would. */
  readonly emit: (chunk: ChatStreamChunk) => void;
  /** Live `onStreamChunk` subscriptions — one per undestroyed store instance. */
  readonly liveSubscriptions: () => number;
  readonly conversations: () => readonly Conversation[];
  /** Every `confirmTool` call, in order. */
  readonly confirmations: () => readonly { toolCallId: string; confirmed: boolean }[];
  /** Every `sendMessage` request, in order. */
  readonly sends: () => readonly { conversationId: string; message: string; vendorId?: string }[];
  readonly cancels: () => readonly string[];
  readonly getToolsCalls: () => number;
  /**
   * The AI settings as the main process now holds them — i.e. after every `ai.setSettings` write.
   *
   * Held mutably here rather than answered from `options.settings` for the same reason
   * `conversations` is: a double that answered a write with the unchanged seed would make any
   * settings round-trip untestable, and the cost-tier control (J-92) is exactly such a round-trip.
   */
  readonly aiSettings: () => AISettings;
  readonly teardown: () => void;
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'New Chat',
    messages: [],
    createdAt: '2026-08-16T09:00:00.000Z',
    updatedAt: '2026-08-16T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * An AI settings object with one vendor holding a key, i.e. the provider-configured state.
 *
 * `vendorId` is a parameter rather than a constant so a spec can configure OpenRouter instead —
 * `selectEnabledVendors` filters the catalogue by this list, so the model picker only offers a
 * vendor that appears here.
 */
export function configuredSettings(vendorId = 'anthropic'): AISettings {
  return {
    ...DEFAULT_AI_SETTINGS,
    enabled: true,
    vendorSettings: [{ vendorId, enabled: true, apiKeyConfigured: true, priority: 1 }],
  };
}

export function anthropicVendor(): AIVendor {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    requiresApiKey: true,
    models: [
      {
        id: 'opus',
        name: 'Claude Opus',
        apiName: 'claude-opus',
        powerRank: 20,
        costTier: 'premium',
      },
      {
        id: 'haiku',
        name: 'Claude Haiku',
        apiName: 'claude-haiku',
        powerRank: 8,
        costTier: 'economy',
        default: true,
      },
    ],
  };
}

/**
 * OpenRouter as the catalogue has it, trimmed to the two models that matter to a test: one concrete,
 * one auto-router. The router's `apiName` is what the shared `OPENROUTER_AUTO_ROUTERS` map keys on,
 * so a surface gated on that map behaves here exactly as it does against the real vendor list.
 */
export function openRouterVendor(): AIVendor {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    requiresApiKey: true,
    models: [
      {
        id: 'openrouter-sonnet',
        name: 'Claude Sonnet 4.5',
        apiName: 'anthropic/claude-sonnet-4.5',
        powerRank: 16,
        costTier: 'standard',
        default: true,
      },
      {
        id: 'openrouter-auto-beta',
        name: 'Auto Router (Beta)',
        apiName: 'openrouter/auto-beta',
        powerRank: 17,
        costTier: 'premium',
        excludeFromAutoSelect: true,
      },
    ],
  };
}

/** Installs the bridge. Call before creating any store — a store subscribes at construction. */
export function installChatDouble(options: ChatDoubleOptions = {}): ChatDouble {
  const chunks = recordSubscription<ChatStreamChunk>();
  let conversations = [...(options.conversations ?? [])];
  let aiSettings: AISettings = options.settings ?? { ...DEFAULT_AI_SETTINGS };
  const confirmations: { toolCallId: string; confirmed: boolean }[] = [];
  const sends: { conversationId: string; message: string; vendorId?: string }[] = [];
  const cancels: string[] = [];
  let getToolsCalls = 0;
  let created = 0;

  const bridge = {
    chat: {
      onStreamChunk: chunks.subscribe,
      getTools: async () => {
        getToolsCalls += 1;
        return [...(options.tools ?? [])];
      },
      listConversations: async () => [...conversations],
      getConversation: async (id: string) => conversations.find(c => c.id === id) ?? null,
      createConversation: async () => {
        created += 1;
        const conversation = makeConversation({ id: `conv-new-${created}` });
        conversations = [conversation, ...conversations];
        return conversation;
      },
      deleteConversation: async (id: string) => {
        conversations = conversations.filter(c => c.id !== id);
        return true;
      },
      renameConversation: async (id: string, title: string) => {
        conversations = conversations.map(c => (c.id === id ? { ...c, title } : c));
        return conversations.find(c => c.id === id) ?? null;
      },
      sendMessage: async (request: {
        conversationId: string;
        message: string;
        vendorId?: string;
      }) => {
        if (options.failSend === true) throw new Error('no provider');
        sends.push({
          conversationId: request.conversationId,
          message: request.message,
          vendorId: request.vendorId,
        });
        return { started: true };
      },
      confirmTool: async (_conversationId: string, toolCallId: string, confirmed: boolean) => {
        confirmations.push({ toolCallId, confirmed });
        // The reply main sends (J-60). Always the first-answer outcome: the store ignores the value,
        // and the card disarms, so no spec here drives the `'already-resolved'` refusal —
        // `packages/main/src/services/ai/chat-service.confirm-tool.spec.ts` owns that.
        return { confirmed, outcome: confirmed ? 'executed' : 'declined' };
      },
      cancelStream: async (conversationId: string) => {
        cancels.push(conversationId);
        return { cancelled: true };
      },
    },
    ai: {
      getVendors: async () => [...(options.vendors ?? [])],
      getSettings: async () => aiSettings,
      // The main process merges shallowly and answers with what it now holds
      // (`services/ai/ai-service.ts:setSettings`), and `state/ai.ts` stores the answer rather than
      // its own optimistic guess — so this double has to merge too, or every write would appear to
      // be discarded.
      setSettings: async (partial: Partial<AISettings>) => {
        aiSettings = { ...aiSettings, ...partial };
        return aiSettings;
      },
    },
    app: {
      openExternal: async () => undefined,
    },
  } as unknown as Parameters<typeof installJoineryMock>[0];

  const removeMock = installJoineryMock(bridge);

  return {
    emit: chunks.emit,
    liveSubscriptions: chunks.liveCount,
    conversations: () => conversations,
    confirmations: () => confirmations,
    sends: () => sends,
    cancels: () => cancels,
    getToolsCalls: () => getToolsCalls,
    aiSettings: () => aiSettings,
    teardown: removeMock,
  };
}

/**
 * A chat store wired to the app's real dependency stores, which is what the surface renders against.
 * The caller destroys it — every instance holds a bridge subscription.
 */
export function makeChatStore(options: ChatStoreOptions = {}): ChatStore {
  return createChatStore(
    { connection: connectionStore, tab: tabStore, capabilities: capabilitiesStore },
    options
  );
}
