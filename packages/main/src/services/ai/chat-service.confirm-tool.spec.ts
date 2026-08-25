/**
 * J-60 — `ChatService.confirmToolCall` is the authority on whether a pending tool call has
 * already been answered.
 *
 * The renderer's confirmation card disarms both buttons on the first click, but the renderer is
 * not the authority: the IPC message can be replayed, a second window can send it, and a store
 * bug can send it twice. Before this spec a repeat confirm ran the tool a second time AND started
 * a second agentic loop (overwriting `activeStreams`, which orphans the first controller) — for
 * `execute_ddl` that is two DROP TABLEs from one user intent.
 *
 * The class needs Electron to construct, so electron is replaced with the single member the
 * constructor touches (`app.getPath`, pointed at a scratch dir so the real `saveConversation`
 * writes somewhere harmless), and the three collaborators it reaches for are replaced with
 * counting doubles. Nothing here talks to an LLM or a database.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { ChatMessage, ChatStreamChunk, Conversation, ToolCallResult } from '@joinery/shared';

/** `vi.hoisted` because the `vi.mock` factories below run before this module's body. */
const doubles = vi.hoisted(() => ({
  storageDir: '',
  /** Every `toolRegistry.executeTool` call, in order — the count IS the assertion. */
  executions: [] as { name: string; args: Record<string, unknown> }[],
  /** Every continuation-loop stream, i.e. every agentic loop `confirmToolCall` started. */
  streams: 0,
}));

vi.mock('electron', () => ({
  app: { getPath: () => doubles.storageDir },
  // Value-imported by chat-service but used only in type positions; present so the require works.
  BrowserWindow: class {},
}));

vi.mock('./tool-registry', () => ({
  ToolRegistry: {
    getInstance: () => ({
      executeTool: async (name: string, args: Record<string, unknown>) => {
        doubles.executions.push({ name, args });
        return { ok: true };
      },
      getTool: (name: string) => ({ name, requiresConfirmation: true }),
      getTools: () => [],
      getToolsForAPI: () => [],
      setEditorContent: () => {
        // The double records nothing: no assertion in this file reads the editor content.
      },
    }),
  },
}));

vi.mock('./ai-service', () => ({
  AIService: {
    getInstance: () => ({
      getSettings: () => ({
        vendorSettings: [{ vendorId: 'test', enabled: true, apiKeyConfigured: true, priority: 0 }],
      }),
      getVendors: () => [
        {
          id: 'test',
          name: 'Test',
          requiresApiKey: true,
          models: [{ id: 'm', name: 'm', apiName: 'm', powerRank: 1, costTier: 'standard' }],
        },
      ],
      getApiKeyForVendor: async () => 'test-key',
    }),
  },
  autoRouterCostTierFor: () => undefined,
}));

vi.mock('./llm-providers', () => ({
  getLLMProvider: () => ({
    // A continuation that says nothing and calls no tool: the loop breaks on the first pass.
    streamChat: async (_req: unknown, callbacks: { onComplete: () => void }) => {
      doubles.streams += 1;
      callbacks.onComplete();
    },
  }),
}));

// Static import, safe because vitest hoists the mocks above every import in this file.
import { ChatService } from './chat-service';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'joinery-confirm-tool-'));
doubles.storageDir = scratch;

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

interface FakeWindow {
  readonly chunks: ChatStreamChunk[];
  readonly webContents: { send: (channel: string, chunk: ChatStreamChunk) => void };
}

function makeWindow(): FakeWindow {
  const chunks: ChatStreamChunk[] = [];
  return {
    chunks,
    webContents: { send: (_channel, chunk) => chunks.push(chunk) },
  };
}

function pendingToolCall(id: string): ToolCallResult {
  return {
    id,
    toolName: 'execute_ddl',
    args: { sql: 'DROP TABLE orders' },
    success: false,
    pendingConfirmation: true,
  };
}

/**
 * A conversation whose last assistant message carries `ids` as pending confirmations — the exact
 * shape `continueAfterToolConfirmation` leaves behind when it breaks the loop to ask the user.
 */
function seedConversation(service: ChatService, ...ids: string[]): Conversation {
  const conversation = service.createConversation('J-60');
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    toolCalls: ids.map(pendingToolCall),
  };
  conversation.messages.push(
    { id: 'user-1', role: 'user', content: 'drop it', timestamp: new Date().toISOString() },
    assistant
  );
  return conversation;
}

let service: ChatService;
let win: FakeWindow;

/** The cast is the test harness admitting its window is a stub, in one place. */
function confirm(conversationId: string, toolCallId: string, confirmed = true) {
  return service.confirmToolCall(
    conversationId,
    toolCallId,
    confirmed,
    win as unknown as BrowserWindow
  );
}

beforeEach(() => {
  doubles.executions = [];
  doubles.streams = 0;
  // The constructor loads whatever is on disk, so each test starts from an empty scratch dir.
  // (`ChatService` puts its files in a `chat-history` subdirectory of the userData path.)
  fs.rmSync(path.join(scratch, 'chat-history'), { recursive: true, force: true });
  ChatService.resetInstance();
  service = new ChatService();
  win = makeWindow();
});

describe('ChatService.confirmToolCall idempotency', () => {
  it('runs a confirmed tool once, however many times the confirm arrives', async () => {
    const conversation = seedConversation(service, 'tool-1');

    const first = await confirm(conversation.id, 'tool-1');
    const second = await confirm(conversation.id, 'tool-1');

    expect(doubles.executions).toEqual([
      { name: 'execute_ddl', args: { sql: 'DROP TABLE orders' } },
    ]);
    expect(first).toBe('executed');
    expect(second).toBe('already-resolved');
  });

  it('starts no second agentic loop for the repeat', async () => {
    const conversation = seedConversation(service, 'tool-1');

    await confirm(conversation.id, 'tool-1');
    await confirm(conversation.id, 'tool-1');

    // A second loop would also have overwritten `activeStreams`, orphaning the first controller.
    expect(doubles.streams).toBe(1);
  });

  it('refuses the two confirms even when they overlap, having marked the id before awaiting', async () => {
    const conversation = seedConversation(service, 'tool-1');

    // Both calls are started before either is awaited — the double-click race, exactly.
    const [first, second] = await Promise.all([
      confirm(conversation.id, 'tool-1'),
      confirm(conversation.id, 'tool-1'),
    ]);

    expect(doubles.executions).toHaveLength(1);
    expect([first, second].filter(outcome => outcome === 'executed')).toHaveLength(1);
    expect([first, second].filter(outcome => outcome === 'already-resolved')).toHaveLength(1);
  });

  it('never runs a tool the user declined, however the confirm arrives afterwards', async () => {
    const conversation = seedConversation(service, 'tool-1');

    expect(await confirm(conversation.id, 'tool-1', false)).toBe('declined');
    expect(await confirm(conversation.id, 'tool-1', true)).toBe('already-resolved');

    expect(doubles.executions).toEqual([]);
    expect(doubles.streams).toBe(0);
  });

  it('records the decline on the tool call itself, so the refusal survives a restart', async () => {
    const conversation = seedConversation(service, 'tool-1');

    await confirm(conversation.id, 'tool-1', false);

    const toolCall = conversation.messages.at(-1)?.toolCalls?.[0];
    expect(toolCall?.pendingConfirmation).toBe(false);
    expect(toolCall?.confirmed).toBe(false);
    expect(toolCall?.error).toBe('Cancelled by user');
    // Still told the user, exactly as before the guard existed.
    expect(win.chunks.some(chunk => chunk.delta?.includes('cancelled'))).toBe(true);
  });

  it('refuses a repeat read off the persisted record when the in-memory set has been evicted', async () => {
    // The bounded set is not the only line of defence: `pendingConfirmation === false` on the
    // saved tool call outlives it, so eviction cannot re-open a DROP TABLE.
    const conversation = seedConversation(service, 'tool-1');
    await confirm(conversation.id, 'tool-1');
    service.forgetResolvedToolCalls(conversation.id);

    expect(await confirm(conversation.id, 'tool-1')).toBe('already-resolved');
    expect(doubles.executions).toHaveLength(1);
  });

  it('holds each pending call independent of its siblings', async () => {
    const conversation = seedConversation(service, 'tool-1', 'tool-2');

    expect(await confirm(conversation.id, 'tool-1')).toBe('executed');
    expect(await confirm(conversation.id, 'tool-2')).toBe('executed');

    expect(doubles.executions).toHaveLength(2);
  });

  it('answers a confirm for a conversation or tool call it does not have, rather than nothing', async () => {
    const conversation = seedConversation(service, 'tool-1');

    expect(await confirm('no-such-conversation', 'tool-1')).toBe('no-such-conversation');
    expect(await confirm(conversation.id, 'tool-9')).toBe('no-such-tool-call');
    expect(await confirm(conversation.id, '')).toBe('no-such-tool-call');
    expect(doubles.executions).toEqual([]);
  });

  it('declines an orphaned card — the id is gone, the refusal is still recorded', async () => {
    // The renderer comment's case: a new turn displaced the assistant message holding the id.
    const conversation = seedConversation(service, 'tool-1');

    expect(await confirm(conversation.id, 'tool-9', false)).toBe('declined');
    expect(await confirm(conversation.id, 'tool-9', true)).toBe('already-resolved');
    expect(doubles.executions).toEqual([]);
  });
});

describe('ChatService resolved-tool-call bookkeeping is bounded', () => {
  it('remembers no more ids per conversation than its cap, evicting the oldest', async () => {
    const cap = ChatService.MAX_RESOLVED_TOOL_CALLS_PER_CONVERSATION;
    const ids = Array.from({ length: cap + 25 }, (_, i) => `tool-${i}`);
    const conversation = seedConversation(service, ...ids);

    for (const id of ids) {
      expect(await confirm(conversation.id, id)).toBe('executed');
    }

    expect(doubles.executions).toHaveLength(ids.length);
    expect(service.resolvedToolCallCount(conversation.id)).toBe(cap);
  });

  it('forgets the ids of a conversation that has been deleted', async () => {
    const conversation = seedConversation(service, 'tool-1');
    await confirm(conversation.id, 'tool-1');
    expect(service.resolvedToolCallCount(conversation.id)).toBe(1);

    expect(service.deleteConversation(conversation.id)).toBe(true);

    expect(service.resolvedToolCallCount(conversation.id)).toBe(0);
  });
});
