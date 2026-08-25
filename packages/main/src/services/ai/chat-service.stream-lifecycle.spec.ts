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

import type { ChatStreamChunk, ToolCallResult } from '@joinery/shared';

const doubles = vi.hoisted(() => ({
  storageDir: '',
  /** Tool calls the provider emits, one array per stream, consumed in order. */
  toolCallsPerStream: [] as { id: string; name: string; args: Record<string, unknown> }[][],
  streams: 0,
  /** Parks `executeTool`, so a test can press Stop while a confirmed tool is still running. */
  toolGate: null as Gate | null,
  /** Parks the provider on `streamGateIndex`, so a test can press Stop mid-continuation. */
  streamGate: null as Gate | null,
  streamGateIndex: -1,
}));

/**
 * A hold a test can put on a double, with a signal back for when the double reached it.
 *
 * The whole reason both Stop races escaped the first round of tests is that every case drove a
 * quiescent service: the doubles resolved immediately, so nothing was ever in flight when Stop
 * landed. `reached` is what makes racing them deterministic instead of tick-counting.
 */
interface Gate {
  readonly reached: Promise<void>;
  readonly held: Promise<void>;
  arrive(): void;
  release(): void;
}

function makeGate(): Gate {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => {
    arrive = resolve;
  });
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  return { reached, held, arrive, release };
}

vi.mock('electron', () => ({
  app: { getPath: () => doubles.storageDir },
  BrowserWindow: class {},
}));

vi.mock('./tool-registry', () => ({
  ToolRegistry: {
    getInstance: () => ({
      executeTool: async () => {
        const gate = doubles.toolGate;
        if (gate) {
          gate.arrive();
          await gate.held;
        }
        return { ok: true };
      },
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
      const index = doubles.streams;
      const calls = doubles.toolCallsPerStream[index] ?? [];
      doubles.streams += 1;
      for (const call of calls) callbacks.onToolCall?.(call);
      const gate = doubles.streamGate;
      if (gate && doubles.streamGateIndex === index) {
        gate.arrive();
        await gate.held;
      }
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
  doubles.toolGate = null;
  doubles.streamGate = null;
  doubles.streamGateIndex = -1;
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

/** Two dangerous calls in one pause: answering one leaves the other armed beside a live turn. */
function pauseOnTwoCalls(): void {
  doubles.toolCallsPerStream = [
    [
      { id: 'tool-1', name: 'execute_ddl', args: { sql: 'DROP TABLE orders' } },
      { id: 'tool-2', name: 'execute_ddl', args: { sql: 'DROP TABLE items' } },
    ],
  ];
}

/** The card as it was persisted — where `confirmToolCall` and `stopStream` both look it up. */
function savedCard(conversationId: string, toolCallId: string): ToolCallResult | undefined {
  const messages = service.getConversation(conversationId)?.messages ?? [];
  return [...messages]
    .reverse()
    .find(message => message.role === 'assistant')
    ?.toolCalls?.find(toolCall => toolCall.id === toolCallId);
}

/** Pause, then send the message that reaches it. */
async function reachTheConfirmation(title: string): Promise<string> {
  const conversation = service.createConversation(title);
  await service.sendMessage(
    { conversationId: conversation.id, message: 'drop it' },
    win as unknown as BrowserWindow
  );
  return conversation.id;
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

  it('ends the turn when the conversation is gone before the answer', async () => {
    // Deleting the conversation mid-pause leaves nobody to run the tool and nobody to send the
    // terminal chunk. Without one the renderer streams forever: indicator on, composer locked.
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );
    service.deleteConversation(conversation.id);

    const outcome = await service.confirmToolCall(
      conversation.id,
      'tool-1',
      true,
      win as unknown as BrowserWindow
    );

    expect(outcome).toBe('no-such-conversation');
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });

  it('ends the turn when the answer carries no tool call id', async () => {
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );

    const outcome = await service.confirmToolCall(
      conversation.id,
      '',
      true,
      win as unknown as BrowserWindow
    );

    expect(outcome).toBe('no-such-tool-call');
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });

  it('ends the turn when the card names a tool call that is not there', async () => {
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );

    const outcome = await service.confirmToolCall(
      conversation.id,
      'tool-that-was-displaced',
      true,
      win as unknown as BrowserWindow
    );

    expect(outcome).toBe('no-such-tool-call');
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });

  it('does not end the turn twice when the same answer arrives again', async () => {
    // The J-60 guard's branch must stay silent: the first answer already owns the terminal chunk,
    // and a second one here would cut a continuation that is still streaming.
    pauseOnFirstStream();
    const conversation = service.createConversation('J-61');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );
    await service.confirmToolCall(conversation.id, 'tool-1', true, win as unknown as BrowserWindow);

    const outcome = await service.confirmToolCall(
      conversation.id,
      'tool-1',
      true,
      win as unknown as BrowserWindow
    );

    expect(outcome).toBe('already-resolved');
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });

  it('ends the turn and disarms the card when the user stops while it waits (J-131)', async () => {
    // Stop has to be a real exit from the paused state. While paused there is no controller to
    // abort — the loop already returned at the break — so a Stop that only aborted did nothing at
    // all here, leaving the card armed for an approval that would resume a finished turn.
    pauseOnFirstStream();
    const conversation = service.createConversation('J-131');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );

    service.stopStream(conversation.id, win as unknown as BrowserWindow);

    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
    const card = savedCard(conversation.id, 'tool-1');
    expect(card?.pendingConfirmation).toBe(false);
    expect(card?.error).toBe('Stopped by user');
  });

  it('refuses an approval that arrives after Stop, with no second terminal chunk (J-131)', async () => {
    // The J-61 hang, from the other end: approving a card Stop left on screen used to start a
    // continuation streaming into a message the renderer had already finalized.
    pauseOnFirstStream();
    const conversation = service.createConversation('J-131');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'drop it' },
      win as unknown as BrowserWindow
    );
    service.stopStream(conversation.id, win as unknown as BrowserWindow);

    const outcome = await service.confirmToolCall(
      conversation.id,
      'tool-1',
      true,
      win as unknown as BrowserWindow
    );

    expect(outcome).toBe('already-resolved');
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
    // No continuation loop: the provider was asked exactly once, for the turn Stop ended.
    expect(doubles.streams).toBe(1);
  });

  it('sends nothing when Stop arrives with no confirmation parked (J-131)', async () => {
    // The other half of the pair: Stop on an ordinary turn stays the renderer's business, and a
    // second terminal chunk here would finalize a message twice.
    const conversation = service.createConversation('J-131');
    await service.sendMessage(
      { conversationId: conversation.id, message: 'hello' },
      win as unknown as BrowserWindow
    );
    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);

    service.stopStream(conversation.id, win as unknown as BrowserWindow);

    expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
  });

  /**
   * Stop raced against work that is still in flight.
   *
   * Since J-61 the turn is held open through the approved tool's execution AND the whole
   * continuation, so the composer keeps offering Stop in both. Every other case in this file drives
   * a quiescent service — nothing running when Stop lands — which is exactly why the first round of
   * this fix shipped two double-terminator races. `activeStreams` is the guard that decides whether
   * anything else will end the turn, so each test here asserts the terminal-chunk TOTAL.
   */
  describe('while something is still running (J-131)', () => {
    it('leaves a tool call that is already running to finish its own turn', async () => {
      // `confirmToolCall` claims the id synchronously before the first await, then `executeTool`
      // runs for seconds. Answering that claim again from Stop both ended the turn a second time
      // and wrote `Stopped by user` onto a card that went on to succeed.
      pauseOnFirstStream();
      const conversationId = await reachTheConfirmation('J-131');

      const gate = makeGate();
      doubles.toolGate = gate;
      const running = service.confirmToolCall(
        conversationId,
        'tool-1',
        true,
        win as unknown as BrowserWindow
      );
      await gate.reached;

      service.stopStream(conversationId, win as unknown as BrowserWindow);

      // Read while the tool is STILL running, which is the only window in which the difference
      // shows: the claimed card must be left alone, not persisted as stopped-and-failed for the
      // seconds until the real result lands on it.
      const midFlight = savedCard(conversationId, 'tool-1');
      expect(midFlight?.pendingConfirmation).toBe(true);
      expect(midFlight?.error).toBeUndefined();

      gate.release();
      await running;

      expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
      const card = savedCard(conversationId, 'tool-1');
      expect(card?.success).toBe(true);
      // A card cannot be both stopped and successful; the record has to pick one.
      expect(card?.error).toBeUndefined();
    });

    it('ends the turn once when Stop lands mid-execution with a second card armed', async () => {
      // The residual the `isToolCallResolved` filter alone does not close: the second card IS
      // unanswered, so Stop still has work to do — but the turn is owned by the tool running
      // beside it, and ending it here truncates the continuation.
      pauseOnTwoCalls();
      const conversationId = await reachTheConfirmation('J-131');

      const gate = makeGate();
      doubles.toolGate = gate;
      const running = service.confirmToolCall(
        conversationId,
        'tool-1',
        true,
        win as unknown as BrowserWindow
      );
      await gate.reached;

      service.stopStream(conversationId, win as unknown as BrowserWindow);
      gate.release();
      await running;

      expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
      // Stop still answers the card nothing else owns.
      const armed = savedCard(conversationId, 'tool-2');
      expect(armed?.pendingConfirmation).toBe(false);
      expect(armed?.error).toBe('Stopped by user');
    });

    it('ends the turn once when Stop aborts a live continuation with a card still armed', async () => {
      // `cancelStream` deletes the `activeStreams` entry, so a guard that reads it AFTER the abort
      // cannot see the loop it just aborted — which is still running and still owes a terminal
      // chunk on its aborted break.
      pauseOnTwoCalls();
      const conversationId = await reachTheConfirmation('J-131');

      const gate = makeGate();
      doubles.streamGate = gate;
      doubles.streamGateIndex = 1;
      const running = service.confirmToolCall(
        conversationId,
        'tool-1',
        true,
        win as unknown as BrowserWindow
      );
      await gate.reached;

      service.stopStream(conversationId, win as unknown as BrowserWindow);
      gate.release();
      await running;

      expect(win.chunks.filter(chunk => chunk.done === true)).toHaveLength(1);
      const armed = savedCard(conversationId, 'tool-2');
      expect(armed?.pendingConfirmation).toBe(false);
      expect(armed?.error).toBe('Stopped by user');
    });
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
