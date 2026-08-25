/**
 * Chat IPC Handlers
 * Bridges chat operations between renderer and main process
 */

import { BrowserWindow } from 'electron';
import { CHAT_IPC_CHANNELS } from '@joinery/shared';
import type { ChatRequest } from '@joinery/shared';
import { ChatService } from '../services/ai/chat-service';
import { safeHandle } from './safe-handle';
import { createLogger } from '../utils/logger';

const log = createLogger('ChatIPC');

export function registerChatHandlers(): void {
  const chatService = ChatService.getInstance();

  safeHandle(CHAT_IPC_CHANNELS.GET_TOOLS, async () => {
    return chatService.getTools();
  });

  safeHandle(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, async () => {
    return chatService.listConversations();
  });

  safeHandle(CHAT_IPC_CHANNELS.GET_CONVERSATION, async (_event, id: string) => {
    return chatService.getConversation(id);
  });

  safeHandle(CHAT_IPC_CHANNELS.CREATE_CONVERSATION, async (_event, title?: string) => {
    return chatService.createConversation(title);
  });

  safeHandle(CHAT_IPC_CHANNELS.DELETE_CONVERSATION, async (_event, id: string) => {
    return chatService.deleteConversation(id);
  });

  safeHandle(CHAT_IPC_CHANNELS.RENAME_CONVERSATION, async (_event, id: string, title: string) => {
    return chatService.renameConversation(id, title);
  });

  safeHandle(CHAT_IPC_CHANNELS.SEND_MESSAGE, async (event, request: ChatRequest) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) throw new Error('No window found');
    // Fire-and-forget — response comes via stream chunks
    chatService.sendMessage(request, mainWindow).catch(err => {
      // Through the logger, so it reaches the Output panel like every other main-process failure.
      // A `console.error` here was invisible to the user and to the log file (J-128).
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Chat message failed: ${message}`);
    });
    return { started: true };
  });

  safeHandle(
    CHAT_IPC_CHANNELS.CONFIRM_TOOL,
    async (event, conversationId: string, toolCallId: string, confirmed: boolean) => {
      const mainWindow = BrowserWindow.fromWebContents(event.sender);
      if (!mainWindow) throw new Error('No window found');
      // The outcome rides back so a refused repeat is visible to the renderer rather than
      // indistinguishable from the run that did happen (J-60).
      const outcome = await chatService.confirmToolCall(
        conversationId,
        toolCallId,
        confirmed,
        mainWindow
      );
      return { confirmed, outcome };
    }
  );

  safeHandle(CHAT_IPC_CHANNELS.CANCEL_STREAM, async (event, conversationId: string) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) throw new Error('No window found');
    // The window is needed because Stop may have to end a turn parked on a confirmation, which
    // means emitting the terminal chunk nothing else will now send (J-131).
    chatService.stopStream(conversationId, mainWindow);
    return { cancelled: true };
  });
}
