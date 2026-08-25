/**
 * Chat Agent Types
 * Types for AI chat with tool calling capability
 */

/**
 * A single message in a conversation
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  /** Tool calls made during this message (assistant only) */
  toolCalls?: ToolCallResult[];
  /** Whether this message is still being streamed */
  streaming?: boolean;
}

/**
 * A tool that the AI can call
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: Record<string, unknown>;
  /** Whether the tool requires user confirmation before executing */
  requiresConfirmation?: boolean;
  /** Category for grouping in UI */
  category: 'database' | 'query' | 'schema' | 'server' | 'utility';
}

/**
 * Result of a tool call
 */
export interface ToolCallResult {
  id: string;
  toolName: string;
  /** The arguments the AI passed to the tool */
  args: Record<string, unknown>;
  /** The result of the tool execution */
  result?: unknown;
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Error message if the tool failed */
  error?: string;
  /** Whether the user confirmed the tool call */
  confirmed?: boolean;
  /** Whether waiting for user confirmation */
  pendingConfirmation?: boolean;
  /** Execution time in ms */
  durationMs?: number;
}

/**
 * A conversation (collection of messages)
 */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  /** Database context when the conversation was started */
  connectionId?: string;
  databaseName?: string;
  /** Database engine type for dialect-aware prompts */
  databaseEngine?: 'mssql' | 'postgresql' | 'mysql';
}

/**
 * Request to send a chat message
 */
export interface ChatRequest {
  conversationId: string;
  message: string;
  /** Current database context */
  connectionId?: string;
  databaseName?: string;
  /** Database engine type for dialect-aware prompts */
  databaseEngine?: 'mssql' | 'postgresql' | 'mysql';
  /** Engine sub-variant for dialect-aware prompts (e.g. Aurora DSQL) */
  engineVariant?: 'dsql';
  /** Contents of the user's active query editor tab (if any) */
  activeEditorContent?: string;
  /** Available schema for context */
  schemaContext?: SchemaContext;
  /** Override vendor (e.g. 'google', 'anthropic') — if omitted, uses default selection */
  vendorId?: string;
  /** Override model API name (e.g. 'gemini-3.1-flash-lite-preview') — if omitted, uses default */
  modelApiName?: string;
}

/**
 * Schema context passed to the AI for tool calling
 */
export interface SchemaContext {
  tables: Array<{
    schema: string;
    name: string;
    columns: Array<{ name: string; type: string }>;
  }>;
  database: string;
}

/**
 * Streaming chat response chunk
 */
export interface ChatStreamChunk {
  conversationId: string;
  /** Delta text content */
  delta?: string;
  /** Tool call in progress */
  toolCall?: {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    /** Whether waiting for user confirmation */
    pendingConfirmation?: boolean;
  };
  /** Tool call result */
  toolResult?: ToolCallResult;
  /** UI action to trigger in the renderer */
  uiAction?: {
    type:
      | 'open-query-tab'
      | 'open-create-db-dialog'
      | 'navigate-database'
      | 'open-backup-dialog'
      | 'open-settings';
    params?: Record<string, unknown>;
  };
  /** Whether the response is complete */
  done: boolean;
  /** Full message ID once complete */
  messageId?: string;
}

/**
 * What the main process did with a tool confirmation (J-60).
 *
 * Main, not the renderer, is the authority on whether a pending tool call has already been
 * answered: `already-resolved` is a repeat confirm or decline that was refused outright — the tool
 * did NOT run a second time. Lives here because it crosses the IPC boundary as the
 * `chat:confirm-tool` reply.
 */
export type ConfirmToolCallOutcome =
  'executed' | 'declined' | 'already-resolved' | 'no-such-conversation' | 'no-such-tool-call';

/**
 * Chat IPC Channels
 */
export const CHAT_IPC_CHANNELS = {
  SEND_MESSAGE: 'chat:send-message',
  STREAM_CHUNK: 'chat:stream-chunk',
  CONFIRM_TOOL: 'chat:confirm-tool',
  CANCEL_STREAM: 'chat:cancel-stream',
  LIST_CONVERSATIONS: 'chat:list-conversations',
  GET_CONVERSATION: 'chat:get-conversation',
  CREATE_CONVERSATION: 'chat:create-conversation',
  DELETE_CONVERSATION: 'chat:delete-conversation',
  RENAME_CONVERSATION: 'chat:rename-conversation',
  GET_TOOLS: 'chat:get-tools',
} as const;
