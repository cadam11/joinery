/**
 * J-61: the turn was reported finished the moment it PAUSED to ask.
 *
 * `done: true` went out right after the pendingConfirmation chunk, so the renderer cleared
 * `streaming`: the composer offered Send instead of Stop, and when the user approved, the
 * continuation's deltas arrived in a segment nothing was treating as a stream — bypassing the tail
 * coalescer that exists to keep a long answer from re-rendering per token.
 *
 * A separate file from `chat-service.confirm-tool.spec.ts` because it needs a different LLM double:
 * that one's provider never emits a tool call, which is what keeps its stream COUNTS meaningful,
 * and the first pause cannot be reached without one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserWindow } from 'electron';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatStreamChunk } from '@joinery/shared';

const doubles = vi.hoisted(() => ({
  storageDir: '',
  /** Tool calls the provider emits, one array per stream, consumed in order. */
  toolCallsPerStream: [] as { id: string; name: string; args: Record<string, unknown> }[][],
  streams: 0,
}));

vi.mock('electron', () => ({
  app: { getPath: () => doubles.storageDir },
  BrowserWindow: class {},
}));

vi.mock('./tool-registry', () => ({
  ToolRegistry: {
    getInstance: () => ({
      executeTool: async () => ({ ok: true }),
      // Every tool needs confirmation here: this file is about the pause.
      getTool: (name: string) => ({ name, requiresConfirmation: true }),
      getTools: () => [],
      getToolsForAPI: () => [],
      setEditorContent: () => {
        // Nothing reads editor content in this file.
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
    streamChat: async (
      _req: unknown,
      callbacks: {
        onToolCall?: (call: { id: string; name: string; args: Record<string, unknown> }) => void;
        onComplete: () => void;
      }
    ) => {
      const calls = doubles.toolCallsPerStream[doubles.streams] ?? [];
      doubles.streams += 1;
      for (const call of calls) callbacks.onToolCall?.(call);
      callbacks.onComplete();
    },
  }),
}));

import { ChatService } from './chat-service';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'joinery-stream-lifecycle-'));
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
  return { chunks, webContents: { send: (_channel, chunk) => chunks.push(chunk) } };
}

let service: ChatService;
let win: FakeWindow;

beforeEach(() => {
  doubles.streams = 0;
  doubles.toolCallsPerStream = [];
  fs.rmSync(path.join(scratch, 'chat-history'), { recursive: true, force: true });
  ChatService.resetInstance();
  service = new ChatService();
  win = makeWindow();
});

/** One tool call on the first stream, nothing after — the shape that pauses on the user. */
function pauseOnFirstStream(): void {
  doubles.toolCallsPerStream = [
    [{ id: 'tool-1', name: 'execute_ddl', args: { sql: 'DROP TABLE orders' } }],
  ];
}

describe('the stream across a confirmation (J-61)', () => {
  it('does not declare the turn over while it is waiting on the user', async () => {
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');

    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );

    const pending = win.chunks.filter(chunk => chunk.toolCall?.pendingConfirmation === true);
    expect(pending, 'the run did not reach a confirmation at all').toHaveLength(1);

    // The bug: a terminal chunk right behind the question. The renderer takes `done: true` as
    // "the turn is finished" and clears `streaming` — so Stop disappears and the continuation
    // streams into a conversation nobody is treating as streaming.
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(0);
  });

  it('declares it over once the continuation finishes', async () => {
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );

    await service.confirmToolCall(conversation.id, 'tool-1', true, win as unknown as BrowserWindow);

    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });

  it('declares it over when the user declines instead', async () => {
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );

    await service.confirmToolCall(
      conversation.id,
      'tool-1',
      false,
      win as unknown as BrowserWindow
    );

    const terminal = win.chunks.filter(chunk => chunk.done === true);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.delta ?? '').toContain('cancelled');
  });

  it('still ends a turn that never pauses', async () => {
    // The other half: with no confirmation in play the terminal chunk must still arrive, or every
    // ordinary answer would hang as "streaming" forever.
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'hello' },
      win as unknown as BrowserWindow
    );

    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });
});
