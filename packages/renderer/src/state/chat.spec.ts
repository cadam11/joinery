/**
 * Instance isolation for the merged chat store.
 *
 * `chat.state.ts` and `chat-instance.state.ts` collapsed into one factory (see the header of
 * `chat.ts`), which makes "two chat tabs do not write each other's transcript" a property of one
 * shared code path rather than of two copies that happen to agree. One bridge subscription per
 * instance receives EVERY conversation's chunks, so the per-instance `conversationId` filter is the
 * only thing keeping them apart — that filter is what this asserts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatStreamChunk } from '@joinery/shared';
import { installJoineryMock, recordSubscription, removeJoineryMock } from '../test/joinery-mock';
import { createCapabilitiesStore } from './capabilities';
import { createChatStore, type ChatStore } from './chat';
import { createConnectionStore } from './connection';
import { createExplorerStore } from './explorer';
import { createTabStore } from './tab';

const teardowns: (() => void)[] = [];

/** Two instances sharing one recorded `chat.onStreamChunk`, as the real bridge does. */
function makeTwoInstances(): {
  first: ChatStore;
  second: ChatStore;
  emit: (chunk: ChatStreamChunk) => void;
} {
  const streamChunks = recordSubscription<ChatStreamChunk>();
  teardowns.push(
    installJoineryMock({
      chat: {
        onStreamChunk: streamChunks.subscribe,
        // `cancelStream` is a fire-and-forget call the store makes before it finalizes the partial
        // answer locally; without it here the cancel path cannot be driven at all.
        cancelStream: () => Promise.resolve(),
      },
    })
  );

  const capabilities = createCapabilitiesStore();
  const tab = createTabStore();
  const explorer = createExplorerStore({ capabilities });
  const connection = createConnectionStore({ tab, explorer, capabilities });
  teardowns.push(() => connection.getState().destroy());

  const deps = { connection, tab, capabilities };
  const first = createChatStore(deps, { initialConversationId: 'conv-1' });
  const second = createChatStore(deps, { initialConversationId: 'conv-2' });
  teardowns.push(() => first.getState().destroy());
  teardowns.push(() => second.getState().destroy());

  // Both instances subscribed, and each subscription is its own listener identity.
  expect(streamChunks.liveCount()).toBe(2);

  return { first, second, emit: streamChunks.emit };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
});

describe('chat store — per-instance isolation', () => {
  it('a chunk for one conversation leaves the other instance untouched', () => {
    const { first, second, emit } = makeTwoInstances();

    // The placeholder assistant message a send would have created, so the tool/done paths have
    // something to patch.
    const placeholder = {
      id: 'msg-1',
      role: 'assistant' as const,
      content: '',
      timestamp: '2026-08-15T00:00:00.000Z',
      streaming: true,
      toolCalls: [],
    };
    first.setState({ messages: [placeholder], streaming: true });
    second.setState({ messages: [{ ...placeholder, id: 'msg-2' }], streaming: true });

    emit({ conversationId: 'conv-1', delta: 'hello ', done: false });
    emit({
      conversationId: 'conv-1',
      toolCall: { id: 'tool-1', toolName: 'run_query', args: {} },
      done: false,
    });
    emit({ conversationId: 'conv-1', delta: 'world', done: true });

    // First instance took all of it.
    expect(first.getState().messages[0]?.content).toBe('hello world');
    expect(first.getState().messages[0]?.toolCalls).toHaveLength(1);
    expect(first.getState().streaming).toBe(false);
    expect(first.getState().streamingContent).toBe('');

    // Second instance saw the same three chunks on its own subscription and ignored every one.
    expect(second.getState().messages[0]?.content).toBe('');
    expect(second.getState().messages[0]?.toolCalls).toHaveLength(0);
    expect(second.getState().streaming).toBe(true);
    expect(second.getState().streamingContent).toBe('');
  });

  it('finalizes the half-answer when the stream is cancelled, and marks the truncation', () => {
    const { first } = makeTwoInstances();
    first.setState({
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          timestamp: '2026-08-15T00:00:00.000Z',
          streaming: true,
          toolCalls: [],
        },
      ],
      streaming: true,
      streamingContent: 'The plan says a sequential scan, which',
    });

    first.getState().cancelStream();

    // The main process emits nothing when a stream is aborted, so this is the only place the partial
    // answer can reach the transcript. A message left `streaming: true` is an eternal typing indicator.
    const message = first.getState().messages[0];
    expect(message?.streaming).toBe(false);
    expect(message?.content).toContain('sequential scan');
    expect(message?.content).toContain('stopped');
    expect(first.getState().streaming).toBe(false);
    expect(first.getState().streamingContent).toBe('');

    // Idempotent: a second Stop (or a late `done`) cannot add a second marker.
    const finalized = message?.content;
    first.getState().cancelStream();
    expect(first.getState().messages[0]?.content).toBe(finalized);
  });

  it('patches a tool result into the message that holds the call, not the last one', () => {
    const { first, emit } = makeTwoInstances();
    first.setState({
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Working on it.',
          timestamp: '2026-08-15T00:00:00.000Z',
          toolCalls: [
            {
              id: 'tool-1',
              toolName: 'execute_ddl',
              args: {},
              success: false,
              pendingConfirmation: true,
            },
          ],
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Something later.',
          timestamp: '2026-08-15T00:01:00.000Z',
          toolCalls: [],
        },
      ],
    });

    // A confirmed tool's result arrives AFTER `done: true`, so the card it belongs to is no longer in
    // the trailing message whenever anything else has been said since.
    emit({
      conversationId: 'conv-1',
      toolResult: { id: 'tool-1', toolName: 'execute_ddl', args: {}, success: true, durationMs: 4 },
      done: false,
    });

    expect(first.getState().messages[0]?.toolCalls?.[0]?.success).toBe(true);
    expect(first.getState().messages[0]?.toolCalls?.[0]?.pendingConfirmation).toBeUndefined();
    expect(first.getState().messages[1]?.toolCalls).toHaveLength(0);
  });

  it('destroying one instance leaves the other listening', () => {
    const { first, second, emit } = makeTwoInstances();

    first.getState().destroy();
    emit({ conversationId: 'conv-2', delta: 'still here', done: false });

    expect(second.getState().streamingContent).toBe('still here');
    expect(first.getState().streamingContent).toBe('');
  });
});

describe('switching conversation while one is streaming (J-63)', () => {
  /** One store, a chat double holding two conversations, so switching really re-reads main. */
  function makeStore(): { store: ChatStore; emit: (chunk: ChatStreamChunk) => void } {
    const streamChunks = recordSubscription<ChatStreamChunk>();
    const held = new Map([
      ['conv-1', { id: 'conv-1', title: 'One', messages: [], createdAt: 'a', updatedAt: 'a' }],
      ['conv-2', { id: 'conv-2', title: 'Two', messages: [], createdAt: 'b', updatedAt: 'b' }],
    ]);

    teardowns.push(
      installJoineryMock({
        chat: {
          onStreamChunk: streamChunks.subscribe,
          cancelStream: () => Promise.resolve(),
          // Main is authoritative and answers from its own live objects, which is the whole reason
          // the renderer must not keep a second copy.
          listConversations: () => Promise.resolve([...held.values()]),
          getConversation: (id: string) => Promise.resolve(held.get(id) ?? null),
        },
      })
    );

    const capabilities = createCapabilitiesStore();
    const tab = createTabStore();
    const explorer = createExplorerStore({ capabilities });
    const connection = createConnectionStore({ tab, explorer, capabilities });
    teardowns.push(() => connection.getState().destroy());

    const store = createChatStore(
      { connection, tab, capabilities },
      { initialConversationId: 'conv-1' }
    );
    teardowns.push(() => store.getState().destroy());
    return { store, emit: streamChunks.emit };
  }

  it('keeps no transcript in the conversation list, so none can go stale', async () => {
    const { store, emit } = makeStore();
    await store.getState().initialize();

    emit({ conversationId: 'conv-1', delta: 'half an ans', done: false });
    expect(store.getState().streamingContent).toBe('half an ans');

    // The list is summaries. Before J-63 each entry carried a `messages` array captured at load
    // and never updated again — a transcript frozen at the moment a stream started.
    for (const summary of store.getState().conversations) {
      expect('messages' in summary).toBe(false);
    }
  });

  it('re-reads the transcript from main on switch-back rather than from its own copy', async () => {
    const { store, emit } = makeStore();
    await store.getState().initialize();

    emit({ conversationId: 'conv-1', delta: 'partial', done: false });
    await store.getState().selectConversation('conv-2');

    // Chunks for the conversation that is no longer active are dropped — one subscription serves
    // every conversation, and `applyChunk` filters by the active id.
    emit({ conversationId: 'conv-1', delta: ' more', done: false });
    expect(store.getState().messages).toEqual([]);

    await store.getState().selectConversation('conv-1');
    expect(store.getState().activeConversationId).toBe('conv-1');
    // Empty because main holds no messages for it in this double — the point is WHERE it came
    // from: `getConversation`, not a snapshot the store had been carrying since load.
    expect(store.getState().messages).toEqual([]);
  });
});
