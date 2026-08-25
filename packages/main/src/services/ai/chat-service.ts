/**
 * Chat Service - Orchestrates AI chat with streaming and tool calling
 *
 * Uses the multi-provider LLM abstraction (llm-providers.ts) for
 * provider-agnostic streaming. Supports Google, Anthropic, OpenAI, Groq, Cerebras.
 */

import { app, BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AIModel,
  AIVendor,
  ChatMessage,
  ChatRequest,
  ChatStreamChunk,
  ConfirmToolCallOutcome,
  Conversation,
  ToolCallResult,
  OpenRouterCostTier,
} from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { AIService, autoRouterCostTierFor } from './ai-service';
import { ToolRegistry } from './tool-registry';
import {
  getLLMProvider,
  type ChatMessage as LLMMessage,
  type StreamToolCall,
} from './llm-providers';
import { createStreamCoalescer, type StreamCoalescer } from './stream-coalescer';

const log = createLogger('Chat');

/**
 * The model chat starts a conversation with when the user has pinned none for this vendor:
 * the vendor's nominated default, else its most capable stable model.
 *
 * Meta/router models are explicit-pick only (`AIModel.excludeFromAutoSelect`), so every branch
 * here chooses among the auto-selectable models — four of the six shipping vendors nominate no
 * default at all, which makes the highest-power-rank fallback a live path, not a corner. A
 * vendor with nothing auto-selectable has no automatic choice, and the caller skips it.
 *
 * Pure, and exported for `chat-service.spec.ts`: the class itself needs Electron to construct.
 */
export function autoSelectModel(vendor: AIVendor): AIModel | null {
  const candidates = vendor.models.filter(model => !model.excludeFromAutoSelect);
  if (candidates.length === 0) return null;

  const nominated = candidates.find(model => model.default === true);
  if (nominated) return nominated;

  // Preview models lose to any stable sibling here, but remain an explicit pick.
  const stable = candidates
    .filter(model => !model.apiName.includes('preview'))
    .sort((a, b) => (b.powerRank ?? 0) - (a.powerRank ?? 0));

  return stable[0] ?? candidates[0];
}

/**
 * A resolved chat target: which vendor, which model on the wire, its key, and — for OpenRouter —
 * the cost band its auto-routers should route within.
 */
interface ChatTarget {
  vendorId: string;
  modelApiName: string;
  apiKey: string;
  costTier?: OpenRouterCostTier;
}

export class ChatService extends BaseSingleton {
  private conversations: Map<string, Conversation> = new Map();
  private toolRegistry: ToolRegistry;
  private aiService: AIService;
  private activeStreams: Map<string, AbortController> = new Map();
  /** Per-window delta batching for stream chunks (see sendChunk). */
  private chunkCoalescers = new WeakMap<BrowserWindow, StreamCoalescer>();
  /** Stores the latest editor content per conversation so tools can access it */
  private editorContent: Map<string, string> = new Map();
  /**
   * Tool-call ids already confirmed or declined, per conversation (J-60). Main is the authority
   * on this, not the renderer's disarmed card: the IPC message can be replayed, sent by a second
   * window, or sent twice by a store bug, and a second confirm used to mean a second execution.
   */
  private resolvedToolCalls: Map<string, Set<string>> = new Map();
  private storageDir: string;

  constructor() {
    super();
    this.toolRegistry = ToolRegistry.getInstance();
    this.aiService = AIService.getInstance();
    this.storageDir = path.join(app.getPath('userData'), 'chat-history');
    this.loadConversations();
  }

  // ---- Persistence ----

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private loadConversations(): void {
    try {
      this.ensureStorageDir();
      const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = fs.readFileSync(path.join(this.storageDir, file), 'utf-8');
          const conv = JSON.parse(data) as Conversation;
          if (conv.id && conv.title) {
            this.conversations.set(conv.id, conv);
          }
        } catch {
          log.warn(`Failed to load conversation file: ${file}`);
        }
      }
      log.info(`Loaded ${this.conversations.size} conversations from disk`);
    } catch {
      log.warn('Failed to load conversations directory');
    }
  }

  private saveConversation(conv: Conversation): void {
    try {
      this.ensureStorageDir();
      const filePath = path.join(this.storageDir, `${conv.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    } catch (error) {
      log.error('Failed to save conversation:', error);
    }
  }

  private deleteConversationFile(id: string): void {
    try {
      const filePath = path.join(this.storageDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      log.error('Failed to delete conversation file:', error);
    }
  }

  // ---- Public API ----

  getTools() {
    return this.toolRegistry.getTools();
  }

  listConversations(): Conversation[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  getConversation(id: string): Conversation | null {
    return this.conversations.get(id) || null;
  }

  createConversation(title?: string): Conversation {
    const conversation: Conversation = {
      id: uuidv4(),
      title: title || 'New Chat',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.conversations.set(conversation.id, conversation);
    this.saveConversation(conversation);
    return conversation;
  }

  deleteConversation(id: string): boolean {
    this.cancelStream(id);
    this.deleteConversationFile(id);
    this.forgetResolvedToolCalls(id);
    return this.conversations.delete(id);
  }

  /**
   * Drop the confirmed/declined tool-call ids remembered for a conversation. Called when the
   * conversation goes away — the ids can never be quoted at us again, so keeping them would be
   * pure growth. The saved `pendingConfirmation: false` on each tool call is the durable record;
   * this map is only the fast path.
   */
  forgetResolvedToolCalls(conversationId: string): void {
    this.resolvedToolCalls.delete(conversationId);
  }

  /** How many resolved ids are being remembered for a conversation. Diagnostics and the J-60 bound. */
  resolvedToolCallCount(conversationId: string): number {
    return this.resolvedToolCalls.get(conversationId)?.size ?? 0;
  }

  renameConversation(id: string, title: string): Conversation | null {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    conv.title = title;
    conv.updatedAt = new Date().toISOString();
    this.saveConversation(conv);
    return conv;
  }

  cancelStream(conversationId: string): void {
    const controller = this.activeStreams.get(conversationId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(conversationId);
    }
  }

  /**
   * Abort all active streams (used during app shutdown)
   */
  abortAll(): void {
    for (const [id, controller] of this.activeStreams) {
      controller.abort();
      log.info(`Shutdown: aborted chat stream ${id}`);
    }
    this.activeStreams.clear();
  }

  /**
   * Send a message and stream the response back via IPC events
   */
  async sendMessage(request: ChatRequest, mainWindow: BrowserWindow): Promise<void> {
    let conversation = this.conversations.get(request.conversationId);
    if (!conversation) {
      conversation = this.createConversation();
      conversation.id = request.conversationId;
      this.conversations.set(conversation.id, conversation);
    }

    // Store context — always update so the conversation tracks the latest state
    if (request.connectionId) conversation.connectionId = request.connectionId;
    if (request.databaseName) conversation.databaseName = request.databaseName;
    if (request.databaseEngine) conversation.databaseEngine = request.databaseEngine;

    // Store active editor content so AI tools can access it
    if (request.activeEditorContent) {
      this.editorContent.set(conversation.id, request.activeEditorContent);
    } else {
      this.editorContent.delete(conversation.id);
    }
    this.toolRegistry.setEditorContent(conversation.id, request.activeEditorContent);

    // Add user message
    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: request.message,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(userMessage);
    conversation.updatedAt = new Date().toISOString();

    // Auto-title on first message
    if (conversation.messages.filter(m => m.role === 'user').length === 1) {
      conversation.title =
        request.message.substring(0, 50) + (request.message.length > 50 ? '...' : '');
    }
    this.saveConversation(conversation);

    const abortController = new AbortController();
    this.activeStreams.set(conversation.id, abortController);

    try {
      await this.generateResponse(conversation, request, mainWindow, abortController.signal);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        log.error('Chat error:', error);
        this.sendChunk(mainWindow, {
          conversationId: conversation.id,
          delta: `\n\nError: ${(error as Error).message}`,
          done: true,
        });
      }
    } finally {
      this.activeStreams.delete(conversation.id);
    }
  }

  /** Per conversation, past which the oldest remembered id is evicted. See `markToolCallResolved`. */
  static readonly MAX_RESOLVED_TOOL_CALLS_PER_CONVERSATION = 200;

  /**
   * Remember a tool-call id as answered, oldest-out past the cap.
   *
   * The cap is what keeps a long-lived conversation from growing this map without limit. Eviction
   * cannot re-open an execution: `isToolCallResolved` also reads the saved
   * `pendingConfirmation: false` on the tool call itself, which outlives anything evicted here.
   */
  private markToolCallResolved(conversationId: string, toolCallId: string): void {
    let resolved = this.resolvedToolCalls.get(conversationId);
    if (!resolved) {
      resolved = new Set<string>();
      this.resolvedToolCalls.set(conversationId, resolved);
    }
    resolved.add(toolCallId);

    // A Set iterates in insertion order, so `values().next()` is the oldest id. Bounded: every
    // pass deletes one entry, so the size strictly decreases toward the cap.
    while (resolved.size > ChatService.MAX_RESOLVED_TOOL_CALLS_PER_CONVERSATION) {
      const oldest = resolved.values().next();
      if (oldest.done) break;
      resolved.delete(oldest.value);
    }
  }

  /**
   * True when this tool call has already been confirmed or declined. Two independent records, so
   * neither alone has to be perfect: the bounded in-memory set, and the tool call's own saved
   * state (`pendingConfirmation: false`, which both answer paths write).
   */
  private isToolCallResolved(
    conversationId: string,
    toolCallId: string,
    toolCall: ToolCallResult | undefined
  ): boolean {
    if (this.resolvedToolCalls.get(conversationId)?.has(toolCallId)) return true;
    // Strict `=== false`: an auto-executed call leaves this undefined, and it never needed an answer.
    return toolCall?.pendingConfirmation === false;
  }

  /** The pending tool call an id names, looked up where the confirmation card's id can still reach. */
  private findToolCall(conversation: Conversation, toolCallId: string): ToolCallResult | undefined {
    const lastMsg = [...conversation.messages].reverse().find(m => m.role === 'assistant');
    return lastMsg?.toolCalls?.find(tc => tc.id === toolCallId);
  }

  /**
   * Confirm (or decline) a pending tool call, then continue the agentic loop.
   *
   * Answering the same tool call twice is refused outright (J-60). Before that guard existed, a
   * replayed or double-sent confirm ran the tool a second time and started a second agentic loop
   * over the same conversation — which for `execute_ddl` is two DROP TABLEs from one user intent,
   * and which also overwrote `activeStreams`, orphaning the first loop's abort controller. The
   * renderer disarms its card on the first click, but that is a courtesy; this is the authority.
   *
   * Returns what it did, so a refusal is visible to the caller instead of an indistinguishable
   * silent return.
   */
  async confirmToolCall(
    conversationId: string,
    toolCallId: string,
    confirmed: boolean,
    mainWindow: BrowserWindow
  ): Promise<ConfirmToolCallOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      log.warn(`Tool confirmation for unknown conversation ${conversationId}; ignoring`);
      return 'no-such-conversation';
    }

    // An empty id would collapse every unanswered call in the conversation onto one key.
    if (!toolCallId) {
      log.error(`Tool confirmation with an empty tool call id in ${conversationId}; refusing`);
      return 'no-such-tool-call';
    }

    const toolCall = this.findToolCall(conversation, toolCallId);

    if (this.isToolCallResolved(conversationId, toolCallId, toolCall)) {
      log.warn(
        `Refusing repeat ${confirmed ? 'confirmation' : 'decline'} of tool call ${toolCallId} ` +
          `in conversation ${conversationId}: already answered`
      );
      return 'already-resolved';
    }

    if (!confirmed) {
      // Marked before anything else, so a confirm racing this decline finds it answered.
      this.markToolCallResolved(conversationId, toolCallId);
      if (toolCall) {
        toolCall.pendingConfirmation = false;
        toolCall.confirmed = false;
        toolCall.success = false;
        toolCall.error = 'Cancelled by user';
        this.saveConversation(conversation);
      }
      this.sendChunk(mainWindow, {
        conversationId,
        delta: '\n\nTool call cancelled by user.',
        done: true,
      });
      return 'declined';
    }

    if (!toolCall) {
      // An orphaned card: a later turn displaced the assistant message holding the id. Nothing
      // was answered, so nothing is remembered — there is nothing here to run twice.
      log.warn(`Confirmed tool call ${toolCallId} is not in conversation ${conversationId}`);
      return 'no-such-tool-call';
    }

    // Claimed synchronously, BEFORE the first await below: two confirms arriving back to back are
    // two separate turns of this event loop, and only the first may get past the guard above.
    this.markToolCallResolved(conversationId, toolCallId);

    await this.runConfirmedToolCall(conversation, toolCall, mainWindow);
    return 'executed';
  }

  /**
   * Run an approved tool call, publish its result, and continue the agentic loop over it.
   *
   * Split out of `confirmToolCall` unchanged when the J-60 guard was added, so the decision of
   * whether to run stays readable apart from the running. Only ever reached once per tool call.
   */
  private async runConfirmedToolCall(
    conversation: Conversation,
    toolCall: ToolCallResult,
    mainWindow: BrowserWindow
  ): Promise<void> {
    const conversationId = conversation.id;

    // Execute the confirmed tool
    const start = Date.now();
    try {
      const result = await this.toolRegistry.executeTool(
        toolCall.toolName,
        toolCall.args,
        conversation.connectionId,
        conversation.databaseName,
        conversation.id
      );
      toolCall.result = result;
      toolCall.success = true;
      toolCall.confirmed = true;
      toolCall.pendingConfirmation = false;
      toolCall.durationMs = Date.now() - start;
    } catch (error) {
      toolCall.error = (error as Error).message;
      toolCall.success = false;
      toolCall.confirmed = true;
      toolCall.pendingConfirmation = false;
      toolCall.durationMs = Date.now() - start;
    }

    this.saveConversation(conversation);

    // Send tool result to UI
    this.sendChunk(mainWindow, {
      conversationId,
      toolResult: toolCall,
      done: false,
    });

    // Continue the agentic loop — feed the tool result back to the LLM
    const abortController = new AbortController();
    this.activeStreams.set(conversationId, abortController);

    try {
      await this.continueAfterToolConfirmation(conversation, mainWindow, abortController.signal);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        log.error('Post-confirmation loop error:', error);
        this.sendChunk(mainWindow, {
          conversationId,
          delta: `\n\nError: ${(error as Error).message}`,
          done: true,
        });
      }
    } finally {
      this.activeStreams.delete(conversationId);
    }
  }

  /**
   * After a confirmed tool executes, continue the agentic loop so the
   * LLM can reason over the result (or call more tools).
   */
  private async continueAfterToolConfirmation(
    conversation: Conversation,
    mainWindow: BrowserWindow,
    signal: AbortSignal
  ): Promise<void> {
    const selection = await this.selectVendorAndModel();
    if (!selection) {
      this.sendChunk(mainWindow, { conversationId: conversation.id, done: true });
      return;
    }

    const { vendorId, modelApiName, apiKey, costTier } = selection;
    const provider = getLLMProvider(vendorId);
    const systemPrompt = this.buildSystemPrompt({
      conversationId: conversation.id,
      message: '',
      connectionId: conversation.connectionId,
      databaseName: conversation.databaseName,
      databaseEngine: conversation.databaseEngine,
    });
    const tools = this.toolRegistry.getToolsForAPI();

    // Build full LLM message history (includes the just-confirmed tool result)
    const llmMessages = this.buildLLMMessages(conversation.messages);

    // Get the existing assistant message to append to
    const assistantMessage = [...conversation.messages].reverse().find(m => m.role === 'assistant');
    if (!assistantMessage) {
      this.sendChunk(mainWindow, { conversationId: conversation.id, done: true });
      return;
    }

    let accumulatedContent = assistantMessage.content || '';

    // Continue the agentic loop
    for (let iteration = 0; iteration < ChatService.MAX_TOOL_ITERATIONS; iteration++) {
      if (signal.aborted) break;

      let iterationContent = '';
      const iterationToolCalls: StreamToolCall[] = [];

      await provider.streamChat(
        {
          messages: llmMessages,
          systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          model: modelApiName,
          apiKey,
          costTier,
          temperature: 0.7,
          maxTokens: 4096,
          signal,
        },
        {
          onContent: (text: string) => {
            if (signal.aborted) return;
            accumulatedContent += text;
            iterationContent += text;
            this.sendChunk(mainWindow, {
              conversationId: conversation.id,
              delta: text,
              done: false,
            });
          },
          onToolCall: (call: StreamToolCall) => {
            if (signal.aborted) return;
            iterationToolCalls.push(call);
          },
          onComplete: () => {},
          onError: (error: Error) => {
            if (error.name !== 'AbortError') log.error('Stream error:', error);
          },
        }
      );

      if (iterationToolCalls.length === 0) break;

      // Only auto-execute safe tools in the continuation loop
      const needsConfirmation = iterationToolCalls.some(
        tc => this.toolRegistry.getTool(tc.name)?.requiresConfirmation
      );

      if (needsConfirmation) {
        for (const tc of iterationToolCalls) {
          const toolCallId = tc.id || uuidv4();
          const toolDef = this.toolRegistry.getTool(tc.name);
          if (toolDef?.requiresConfirmation) {
            const pending: ToolCallResult = {
              id: toolCallId,
              toolName: tc.name,
              args: tc.args,
              success: false,
              pendingConfirmation: true,
            };
            assistantMessage.toolCalls!.push(pending);
            this.sendChunk(mainWindow, {
              conversationId: conversation.id,
              toolCall: {
                id: toolCallId,
                toolName: tc.name,
                args: tc.args,
                pendingConfirmation: true,
              },
              done: false,
            });
          } else {
            const result = await this.executeTool(
              tc.id || uuidv4(),
              tc.name,
              tc.args,
              conversation
            );
            assistantMessage.toolCalls!.push(result);
            this.sendChunk(mainWindow, {
              conversationId: conversation.id,
              toolResult: result,
              done: false,
            });
          }
        }
        break;
      }

      llmMessages.push({
        role: 'assistant',
        content: iterationContent || '',
        toolCalls: iterationToolCalls,
      });

      for (const tc of iterationToolCalls) {
        const toolCallId = tc.id || uuidv4();
        this.sendChunk(mainWindow, {
          conversationId: conversation.id,
          toolCall: { id: toolCallId, toolName: tc.name, args: tc.args },
          done: false,
        });
        const result = await this.executeTool(toolCallId, tc.name, tc.args, conversation);
        assistantMessage.toolCalls!.push(result);

        const chunk: ChatStreamChunk = {
          conversationId: conversation.id,
          toolResult: result,
          done: false,
        };
        const resultObj = result.result as Record<string, unknown> | undefined;
        if (resultObj?._uiAction)
          chunk.uiAction = resultObj._uiAction as ChatStreamChunk['uiAction'];
        this.sendChunk(mainWindow, chunk);

        llmMessages.push({
          role: 'tool',
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
          toolCallId,
          toolName: tc.name,
        });
      }
    }

    assistantMessage.content = accumulatedContent;
    conversation.updatedAt = new Date().toISOString();
    this.saveConversation(conversation);

    this.sendChunk(mainWindow, {
      conversationId: conversation.id,
      done: true,
      messageId: assistantMessage.id,
    });
  }

  // ---- Core generation with agentic tool-calling loop ----

  private static readonly MAX_TOOL_ITERATIONS = 10;

  private async generateResponse(
    conversation: Conversation,
    request: ChatRequest,
    mainWindow: BrowserWindow,
    signal: AbortSignal
  ): Promise<void> {
    // Use per-message override if provided, otherwise fall back to default selection
    const selection =
      request.vendorId && request.modelApiName
        ? await this.resolveExplicitModel(request.vendorId, request.modelApiName)
        : await this.selectVendorAndModel();
    if (!selection) {
      this.sendChunk(mainWindow, {
        conversationId: conversation.id,
        delta: 'No AI provider configured. Go to Settings to add an API key.',
        done: true,
      });
      return;
    }

    const { vendorId, modelApiName, apiKey, costTier } = selection;
    const provider = getLLMProvider(vendorId);

    const systemPrompt = this.buildSystemPrompt(request);
    const tools = this.toolRegistry.getToolsForAPI();

    // Local LLM message history (includes tool call/result turns the user doesn't see)
    const llmMessages = this.buildLLMMessages(conversation.messages);

    // The assistant message we'll save to the conversation
    const assistantMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      toolCalls: [],
    };

    let accumulatedContent = '';

    for (let iteration = 0; iteration < ChatService.MAX_TOOL_ITERATIONS; iteration++) {
      if (signal.aborted) break;

      let iterationContent = '';
      const iterationToolCalls: StreamToolCall[] = [];

      await provider.streamChat(
        {
          messages: llmMessages,
          systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          model: modelApiName,
          apiKey,
          costTier,
          temperature: 0.7,
          maxTokens: 4096,
          signal,
        },
        {
          onContent: (text: string) => {
            if (signal.aborted) return;
            accumulatedContent += text;
            iterationContent += text;
            this.sendChunk(mainWindow, {
              conversationId: conversation.id,
              delta: text,
              done: false,
            });
          },
          onToolCall: (call: StreamToolCall) => {
            if (signal.aborted) return;
            iterationToolCalls.push(call);
          },
          onComplete: () => {},
          onError: (error: Error) => {
            if (error.name !== 'AbortError') {
              log.error('Stream error:', error);
            }
          },
        }
      );

      // No tool calls — LLM is done, break the loop
      if (iterationToolCalls.length === 0) break;

      // Check if any tool requires user confirmation — break loop, let user decide
      const needsConfirmation = iterationToolCalls.some(
        tc => this.toolRegistry.getTool(tc.name)?.requiresConfirmation
      );

      if (needsConfirmation) {
        for (const tc of iterationToolCalls) {
          const toolCallId = tc.id || uuidv4();
          const toolDef = this.toolRegistry.getTool(tc.name);

          if (toolDef?.requiresConfirmation) {
            const pending: ToolCallResult = {
              id: toolCallId,
              toolName: tc.name,
              args: tc.args,
              success: false,
              pendingConfirmation: true,
            };
            assistantMessage.toolCalls!.push(pending);
            this.sendChunk(mainWindow, {
              conversationId: conversation.id,
              toolCall: {
                id: toolCallId,
                toolName: tc.name,
                args: tc.args,
                pendingConfirmation: true,
              },
              done: false,
            });
          } else {
            // Auto-execute safe tools even in a mixed batch
            const result = await this.executeTool(
              tc.id || uuidv4(),
              tc.name,
              tc.args,
              conversation
            );
            assistantMessage.toolCalls!.push(result);
            this.sendChunk(mainWindow, {
              conversationId: conversation.id,
              toolResult: result,
              done: false,
            });
          }
        }
        break; // Wait for user confirmation before continuing
      }

      // All tools are auto-execute — run them and feed results back to LLM
      // Add assistant turn (with tool calls) to LLM history
      llmMessages.push({
        role: 'assistant',
        content: iterationContent || '',
        toolCalls: iterationToolCalls,
      });

      log.info(
        `Agentic loop iteration ${iteration + 1}: executing ${iterationToolCalls.length} tool(s)`
      );

      for (const tc of iterationToolCalls) {
        const toolCallId = tc.id || uuidv4();

        // Notify UI that tool is running (shows spinning indicator)
        this.sendChunk(mainWindow, {
          conversationId: conversation.id,
          toolCall: { id: toolCallId, toolName: tc.name, args: tc.args },
          done: false,
        });

        const result = await this.executeTool(toolCallId, tc.name, tc.args, conversation);
        assistantMessage.toolCalls!.push(result);

        // Update UI with result (card shows ✓/✗)
        const chunk: ChatStreamChunk = {
          conversationId: conversation.id,
          toolResult: result,
          done: false,
        };

        // Forward UI actions from tool results
        const resultObj = result.result as Record<string, unknown> | undefined;
        if (resultObj?._uiAction) {
          chunk.uiAction = resultObj._uiAction as ChatStreamChunk['uiAction'];
        }
        this.sendChunk(mainWindow, chunk);

        // Add tool result to LLM history so it can reason over it
        llmMessages.push({
          role: 'tool',
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
          toolCallId,
          toolName: tc.name,
        });
      }

      // Loop continues — LLM will see tool results and decide what to do next
    }

    // Finalize the assistant message
    assistantMessage.content = accumulatedContent;
    conversation.messages.push(assistantMessage);
    conversation.updatedAt = new Date().toISOString();
    this.saveConversation(conversation);

    this.sendChunk(mainWindow, {
      conversationId: conversation.id,
      done: true,
      messageId: assistantMessage.id,
    });
  }

  private async executeTool(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    conversation: Conversation
  ): Promise<ToolCallResult> {
    const start = Date.now();
    const toolResult: ToolCallResult = {
      id: toolCallId,
      toolName,
      args,
      success: false,
    };

    try {
      const result = await this.toolRegistry.executeTool(
        toolName,
        args,
        conversation.connectionId,
        conversation.databaseName,
        conversation.id
      );
      toolResult.result = result;
      toolResult.success = true;
      toolResult.durationMs = Date.now() - start;

      // If navigate_to_database was called, update the conversation context
      // so subsequent tool calls target the new database
      if (toolName === 'navigate_to_database' && args.database) {
        conversation.databaseName = args.database as string;
      }
    } catch (error) {
      toolResult.error = (error as Error).message;
      toolResult.durationMs = Date.now() - start;
    }

    return toolResult;
  }

  // ---- Vendor/Model Selection ----

  private async selectVendorAndModel(): Promise<ChatTarget | null> {
    const settings = this.aiService.getSettings();
    const vendors = this.aiService.getVendors();

    // Try enabled vendors in priority order
    const enabledVendors = settings.vendorSettings
      .filter(v => v.enabled && v.apiKeyConfigured)
      .sort((a, b) => a.priority - b.priority);

    for (const vs of enabledVendors) {
      const vendor = vendors.find(v => v.id === vs.vendorId);
      if (!vendor) continue;

      const apiKey = await this.aiService.getApiKeyForVendor(vs.vendorId);
      if (!apiKey) continue;

      // The user's explicit pick wins outright — including a meta/router model, which is the
      // only way one is ever used. Everything else goes through the automatic choice.
      const preferred = vs.preferredModelId
        ? (vendor.models.find(m => m.id === vs.preferredModelId) ?? null)
        : null;
      const model = preferred ?? autoSelectModel(vendor);
      if (!model) {
        log.warn(`Vendor ${vendor.id} offers no auto-selectable model; skipping it`);
        continue;
      }

      return {
        vendorId: vendor.id,
        modelApiName: model.apiName,
        apiKey,
        costTier: vs.autoRouterCostTier,
      };
    }

    return null;
  }

  /**
   * Resolve an explicitly requested vendor+model (from the chat model picker).
   * Returns null if the vendor's API key is missing.
   *
   * This is the path a pinned auto-router actually arrives on, so it is the one the cost tier
   * matters most to — the picker is the only place a router can be chosen at all.
   */
  private async resolveExplicitModel(
    vendorId: string,
    modelApiName: string
  ): Promise<ChatTarget | null> {
    const apiKey = await this.aiService.getApiKeyForVendor(vendorId);
    if (!apiKey) return null;
    const costTier = autoRouterCostTierFor(this.aiService.getSettings(), vendorId);
    return { vendorId, modelApiName, apiKey, costTier };
  }

  // ---- Message Building ----

  private buildSystemPrompt(request: ChatRequest): string {
    const engineLabel =
      request.databaseEngine === 'postgresql'
        ? 'PostgreSQL'
        : request.databaseEngine === 'mysql'
          ? 'MySQL'
          : 'SQL Server';
    const dialectHint =
      request.databaseEngine === 'postgresql'
        ? 'PostgreSQL SQL'
        : request.databaseEngine === 'mysql'
          ? 'MySQL SQL'
          : 'T-SQL';

    let prompt = `You are Joinery AI, a helpful database assistant built into Joinery — a multi-database management tool.
The user is currently connected to a ${engineLabel} database. Generate ${dialectHint} syntax for all queries.
You help users manage their databases through natural conversation. You can execute SQL queries, create databases, inspect schema, and more using the available tools.

Guidelines:
- Be concise and helpful
- When the user asks about data, use the execute_query tool to run SQL
- When the user asks about schema, use describe_table or list_tables
- For destructive operations (DROP, DELETE, ALTER), explain what you'll do and use tools that require confirmation
- Format SQL code in markdown code blocks
- If you're unsure what the user wants, ask for clarification
- When the user asks you to run or show a query interactively, use open_query_tab with autoExecute=true so it opens in the editor AND runs immediately
- After calling tools, always summarize the results in natural language — don't just show raw data`;

    if (request.engineVariant === 'dsql') {
      prompt += `

This server is an Amazon Aurora DSQL cluster (PostgreSQL 16-compatible) with hard restrictions you MUST respect:
- The cluster hosts a single database named "postgres" — never CREATE, DROP, or RENAME databases.
- No foreign keys, triggers, PL/pgSQL, temporary tables, TRUNCATE, or extensions. Use LANGUAGE SQL for functions.
- CREATE INDEX must be CREATE INDEX ASYNC (monitor with SELECT * FROM sys.jobs).
- DDL and DML cannot share a transaction; at most one DDL statement per transaction.
- A single transaction can modify at most 3,000 rows — batch large writes.
- Isolation is fixed at REPEATABLE READ; write conflicts surface as serialization errors, so retry idempotently.
- pg_proc, pg_database, pg_stat_* and pg_stat_activity are unavailable; prefer pg_class.reltuples over COUNT(*) for row counts.`;
    }

    if (request.databaseName) {
      prompt += `\n\nCurrent database: ${request.databaseName}`;
      prompt += `\nAll tool calls (execute_query, execute_ddl, etc.) automatically run against this database — you do not need to add USE statements.`;
    } else {
      prompt += `\n\nNo database is currently selected. If the user wants to work with a specific database, use navigate_to_database first to set the context, then subsequent tool calls will target that database.`;
    }

    if (request.schemaContext?.tables.length) {
      const tableList = request.schemaContext.tables
        .slice(0, 20)
        .map(t => `- ${t.schema}.${t.name} (${t.columns.map(c => c.name).join(', ')})`)
        .join('\n');
      prompt += `\n\nAvailable tables:\n${tableList}`;
    }

    // Include active editor content preview
    if (request.activeEditorContent) {
      const lines = request.activeEditorContent.split('\n');
      const maxPreviewLines = 200;
      const preview = lines
        .slice(0, maxPreviewLines)
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n');
      prompt += `\n\nActive query editor contents (${lines.length} line${lines.length === 1 ? '' : 's'}):`;
      prompt += `\n\`\`\`sql\n${preview}\n\`\`\``;
      if (lines.length > maxPreviewLines) {
        prompt += `\n(Showing first ${maxPreviewLines} of ${lines.length} lines. Use the read_editor_content tool to view specific line ranges, or search_editor_content to search.)`;
      }
    }

    return prompt;
  }

  private buildLLMMessages(messages: ChatMessage[]): LLMMessage[] {
    const llmMessages: LLMMessage[] = [];

    for (const m of messages) {
      if (m.role === 'system') continue;

      // If an assistant message had tool calls, include them so the LLM has context
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const toolCalls: StreamToolCall[] = m.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.toolName,
          args: tc.args,
        }));

        llmMessages.push({
          role: 'assistant',
          content: m.content || '',
          toolCalls,
        });

        // Add tool result messages
        for (const tc of m.toolCalls) {
          if (tc.success || tc.error) {
            llmMessages.push({
              role: 'tool',
              content: JSON.stringify(tc.success ? tc.result : { error: tc.error }),
              toolCallId: tc.id,
              toolName: tc.toolName,
            });
          }
        }
      } else {
        llmMessages.push({
          role: m.role as LLMMessage['role'],
          content: m.content || '(empty)',
        });
      }
    }

    return llmMessages;
  }

  /**
   * Per-token deltas are batched (~40ms) before crossing IPC; control
   * chunks pass straight through in order. See stream-coalescer.ts.
   */
  private sendChunk(mainWindow: BrowserWindow, chunk: ChatStreamChunk): void {
    let coalescer = this.chunkCoalescers.get(mainWindow);
    if (!coalescer) {
      coalescer = createStreamCoalescer(batched => this.sendChunkNow(mainWindow, batched));
      this.chunkCoalescers.set(mainWindow, coalescer);
    }
    coalescer.push(chunk);
  }

  private sendChunkNow(mainWindow: BrowserWindow, chunk: ChatStreamChunk): void {
    try {
      mainWindow.webContents.send('chat:stream-chunk', chunk);
    } catch (error) {
      log.warn('Dropped stream chunk — window likely closed:', error);
    }
  }
}
