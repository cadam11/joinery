/**
 * The chat surface, mounted for real over a doubled bridge.
 *
 * What this file is responsible for proving, in order of how much it matters:
 *
 * 1. **the no-provider degradation is honest** — an empty state that says what is missing and a composer
 *    that refuses rather than a spinner, a crash, or a send into a refusal;
 * 2. **the tool-confirmation flow**, including the description the Angular version never showed and the
 *    two paths out (approve → the main process decides; decline → the card says so immediately, because
 *    a declined tool produces no result chunk to patch it with);
 * 3. **conversation CRUD** through the store's IPC, including the two-step delete;
 * 4. **the markdown seam** — assistant content reaches the DOM through `src/markdown` and nowhere else,
 *    which the package-wide `ban-rules.spec.ts` enforces and this demonstrates end to end;
 * 5. **panel vs tab** differ in the two affordances they should differ in, and nothing else;
 * 6. the model override reaches `sendMessage`, and a `uiAction` reaches the command bus.
 *
 * The real `<Markdown>` is used rather than a double: it is the seam, and a double would make claim 4
 * unfalsifiable. `stream-render-isolation.spec.tsx` is the one that doubles it, because there the
 * subject is render counts rather than output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatMessage, ToolDefinition } from '@joinery/shared';

import { subscribeCommand } from '../../commands';
import { aiStore } from '../../state/ai';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { tabStore } from '../../state/tab';
import { TooltipProvider } from '../../ui';
import {
  anthropicVendor,
  configuredSettings,
  installChatDouble,
  makeChatStore,
  makeConversation,
  openRouterVendor,
  type ChatDouble,
  type ChatDoubleOptions,
} from '../../test/chat-double';
import { ChatSurface } from './chat-surface';
import type { ChatStore } from '../../state/chat';

const CONVERSATION_ID = 'conv-1';

const RUN_QUERY_TOOL: ToolDefinition = {
  name: 'run_query',
  description: 'Runs a SQL statement against the connected database and returns the rows.',
  parameters: {},
  requiresConfirmation: true,
  category: 'query',
};

const teardowns: (() => void)[] = [];
let double: ChatDouble;

function seeded(messages: ChatMessage[] = []): ChatDoubleOptions {
  return {
    conversations: [makeConversation({ id: CONVERSATION_ID, title: 'Schema chat', messages })],
    tools: [RUN_QUERY_TOOL],
    settings: configuredSettings(),
    vendors: [anthropicVendor()],
  };
}

/** Mounts the surface against a store pointed at the seeded conversation. */
async function mount(
  options: ChatDoubleOptions = seeded(),
  mode: 'panel' | 'tab' = 'panel',
  initialConversationId: string | undefined = CONVERSATION_ID
): Promise<{ store: ChatStore }> {
  double = installChatDouble(options);
  teardowns.push(double.teardown);

  const store = makeChatStore({ initialConversationId, loadTools: true });
  teardowns.push(() => store.getState().destroy());

  // The surface no longer hydrates `aiStore` — `features/ai-setup/AiSetupHost` owns that fetch now
  // (J-55), and in the app it is always mounted. Here the spec stands in for it, awaited before the
  // render so the model picker and the provider gate see real settings on the first commit.
  await aiStore.getState().initialize();

  render(
    <TooltipProvider>
      <ChatSurface store={store} mode={mode} />
    </TooltipProvider>
  );
  // `initialize()` on the chat store is a promise; this is what lets the conversation list and the
  // tool catalogue land before anything is asserted.
  await waitFor(() => expect(double.getToolsCalls()).toBeGreaterThan(0));
  return { store };
}

/** One streamed answer, delivered as the main process would deliver it. */
async function streamAnswer(store: ChatStore, text: string): Promise<void> {
  await store.getState().sendMessage('tell me');
  double.emit({ conversationId: CONVERSATION_ID, delta: text, done: false });
  double.emit({ conversationId: CONVERSATION_ID, done: true });
}

beforeEach(() => {
  teardowns.push(
    setDiagnosticsSink({ error: () => undefined, warn: () => undefined }),
    setNotifier({
      success: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warning: () => undefined,
    })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  aiStore.setState(aiStore.getInitialState());
  tabStore.setState({ tabs: [], activeTabId: '' });
});

describe('with no AI provider configured', () => {
  it('says what is missing, and refuses to send instead of pretending', async () => {
    await mount({ ...seeded(), settings: undefined, vendors: [] });

    const emptyState = screen.getByTestId('chat-no-provider');
    expect(emptyState.textContent).toContain('No AI provider configured');
    // It no longer names a ticket, because the surface exists: the empty state offers the way out of
    // it. The button is a dispatch, so this asserts the wire rather than the dialog (Task 19a).
    expect(screen.getByTestId('chat-open-ai-setup')).toBeTruthy();

    // Not a spinner, and not a crash.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('chat-input').getAttribute('placeholder')).toBe(
      'Configure an AI provider to chat'
    );

    // Typing does not enable Send, because there is nowhere for it to go.
    await userEvent.type(screen.getByTestId('chat-input'), 'hello?');
    expect(screen.getByTestId('chat-send').hasAttribute('disabled')).toBe(true);
    expect(double.sends()).toHaveLength(0);
  });

  it('offers no model picker, rather than an empty menu', async () => {
    await mount({ ...seeded(), settings: undefined, vendors: [] });
    expect(screen.queryByTestId('chat-model-trigger')).toBeNull();
  });
});

describe('with a provider configured', () => {
  it('offers the four openers and sends one', async () => {
    await mount();

    const suggestions = screen.getAllByTestId('chat-suggestion');
    expect(suggestions).toHaveLength(4);

    await userEvent.click(suggestions[0] as HTMLElement);

    await waitFor(() => expect(double.sends()).toHaveLength(1));
    expect(double.sends()[0]?.message).toBe('Show me all tables');
  });

  it('sends what was typed, on Enter, and clears the box', async () => {
    await mount();

    const box = screen.getByTestId('chat-input');
    await userEvent.type(box, 'which tables are biggest?{Enter}');

    await waitFor(() => expect(double.sends()).toHaveLength(1));
    expect(double.sends()[0]?.message).toBe('which tables are biggest?');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('treats ⇧↩ as a newline rather than a send', async () => {
    await mount();

    const box = screen.getByTestId('chat-input');
    await userEvent.type(box, 'first{Shift>}{Enter}{/Shift}second');

    expect(double.sends()).toHaveLength(0);
    expect((box as HTMLTextAreaElement).value).toBe('first\nsecond');
  });

  it('shows Stop while streaming, and cancels through it', async () => {
    const { store } = await mount();

    await userEvent.type(screen.getByTestId('chat-input'), 'go{Enter}');
    await waitFor(() => expect(screen.getByTestId('chat-stop')).not.toBeNull());
    expect(screen.queryByTestId('chat-send')).toBeNull();
    expect(screen.getByTestId('chat-input').hasAttribute('disabled')).toBe(true);

    await userEvent.click(screen.getByTestId('chat-stop'));

    expect(double.cancels()).toEqual([CONVERSATION_ID]);
    expect(store.getState().streaming).toBe(false);
  });

  it('keeps the half-answer when Stop is pressed, and says it was stopped', async () => {
    // What this closes: the main process emits nothing at all on abort, so before this the cancel
    // cleared `streamingContent` (unmounting the tail) and left the message marked `streaming: true` —
    // a typing indicator that never stopped, over an answer that had been thrown away.
    const { store } = await mount();

    await userEvent.type(screen.getByTestId('chat-input'), 'why is this slow?{Enter}');
    await waitFor(() => expect(store.getState().streaming).toBe(true));
    double.emit({
      conversationId: CONVERSATION_ID,
      delta: 'Because the index on `orders(created_at)` is',
      done: false,
    });
    await waitFor(() => expect(screen.getByTestId('chat-stream-tail')).not.toBeNull());

    await userEvent.click(screen.getByTestId('chat-stop'));

    // The tail's text is in the transcript, as a finished message.
    const body = await screen.findByTestId('chat-message-body');
    expect(body.textContent).toContain('Because the index on');
    expect(body.textContent).toContain('stopped');
    // Nothing is still writing, and nothing is still buffered.
    expect(screen.queryByTestId('chat-typing')).toBeNull();
    expect(screen.queryByTestId('chat-stream-tail')).toBeNull();
    expect(store.getState().streaming).toBe(false);
    expect(store.getState().streamingContent).toBe('');
    expect(store.getState().messages.at(-1)?.streaming).toBe(false);
    expect(double.cancels()).toEqual([CONVERSATION_ID]);
  });

  it('carries a chosen model on the next message, and back to Auto when re-chosen', async () => {
    await mount();

    await userEvent.click(screen.getByTestId('chat-model-trigger'));
    const options = await screen.findAllByTestId('chat-model-option');
    await userEvent.click(options[0] as HTMLElement);
    expect(screen.getByTestId('chat-model-label').textContent).toContain('Claude Opus');

    await userEvent.type(screen.getByTestId('chat-input'), 'explicit{Enter}');
    await waitFor(() => expect(double.sends()).toHaveLength(1));
    expect(double.sends()[0]?.vendorId).toBe('anthropic');

    // Re-selecting the same model is the way back to Auto.
    await userEvent.click(screen.getByTestId('chat-model-trigger'));
    const reopened = await screen.findAllByTestId('chat-model-option');
    await userEvent.click(reopened[0] as HTMLElement);
    expect(screen.getByTestId('chat-model-label').textContent).toContain('Auto');
  });
});

/**
 * J-92. The routing band was reachable only from the AI setup dialog, while the place a user pins
 * `openrouter/auto-beta` is the strip above the box — so pinning a router gave no hint that a band
 * existed at all.
 *
 * What matters here is not that a menu opens. It is that the control is a **second view of one
 * setting**: `AIVendorSettings.autoRouterCostTier`, per vendor, written through the store action the
 * dialog's own selector calls, and round-tripped through `ai.setSettings` exactly as the dialog's is.
 * The composer holds no copy — `chat-composer.spec.tsx` owns the component-level behaviour.
 */
describe('the auto-router cost tier in the model strip', () => {
  const OPENROUTER_SEED: ChatDoubleOptions = {
    conversations: [makeConversation({ id: CONVERSATION_ID, title: 'Schema chat' })],
    tools: [RUN_QUERY_TOOL],
    settings: configuredSettings('openrouter'),
    vendors: [openRouterVendor()],
  };

  /** Pins the model whose visible name is `label` in the strip's picker. */
  async function pinModel(label: string): Promise<void> {
    await userEvent.click(screen.getByTestId('chat-model-trigger'));
    const options = await screen.findAllByTestId('chat-model-option');
    const wanted = options.find(option => option.textContent?.includes(label));
    expect(wanted, `no model option named ${label}`).toBeTruthy();
    await userEvent.click(wanted as HTMLElement);
    expect(screen.getByTestId('chat-model-label').textContent).toContain(label);
  }

  function savedTier(): string | undefined {
    return double.aiSettings().vendorSettings.find(entry => entry.vendorId === 'openrouter')
      ?.autoRouterCostTier;
  }

  it('is offered for a pinned auto-router and not for a concrete model', async () => {
    await mount(OPENROUTER_SEED);

    // Auto is the resting state, and the main process picks the model on that path.
    expect(screen.queryByTestId('chat-cost-tier-trigger')).toBeNull();

    await pinModel('Claude Sonnet 4.5');
    expect(screen.queryByTestId('chat-cost-tier-trigger')).toBeNull();

    await pinModel('Auto Router (Beta)');
    expect(screen.queryByTestId('chat-cost-tier-trigger')).not.toBeNull();
  });

  it('writes the band through the same store field the setup dialog edits', async () => {
    await mount(OPENROUTER_SEED);
    await pinModel('Auto Router (Beta)');

    await userEvent.click(screen.getByTestId('chat-cost-tier-trigger'));
    const rows = await screen.findAllByTestId('chat-cost-tier-option');
    const high = rows.find(row => row.getAttribute('data-tier') === 'high');
    await userEvent.click(high as HTMLElement);

    // Through the bridge, per vendor, into `AIVendorSettings.autoRouterCostTier` — which is what
    // `ai-service.ts`'s `autoRouterCostTierFor` reads and what `ai-setup-dialog.tsx` renders.
    await waitFor(() => expect(savedTier()).toBe('high'));
    await waitFor(() =>
      expect(
        aiStore.getState().settings.vendorSettings.find(entry => entry.vendorId === 'openrouter')
          ?.autoRouterCostTier
      ).toBe('high')
    );
    // And the strip now shows it, because it renders the store rather than a local copy.
    expect(screen.getByTestId('chat-cost-tier-label').textContent).toBe('High');
  });

  it('shows a band written anywhere else, without being told', async () => {
    // The dialog's half of the same field. Writing it through the store is exactly what
    // `AutoRouterCostTier` does, and the strip has to follow — that is the "one source of truth"
    // claim, stated as a test rather than as a comment.
    await mount(OPENROUTER_SEED);
    await pinModel('Auto Router (Beta)');
    expect(screen.getByTestId('chat-cost-tier-label').textContent).toBe('Default');

    await aiStore.getState().setAutoRouterCostTier('openrouter', 'max');

    await waitFor(() => expect(screen.getByTestId('chat-cost-tier-label').textContent).toBe('Max'));
    expect(savedTier()).toBe('max');
  });

  it('clears back to no preference rather than to the cheapest band', async () => {
    await mount(OPENROUTER_SEED);
    await pinModel('Auto Router (Beta)');
    await aiStore.getState().setAutoRouterCostTier('openrouter', 'max');
    await waitFor(() => expect(screen.getByTestId('chat-cost-tier-label').textContent).toBe('Max'));

    await userEvent.click(screen.getByTestId('chat-cost-tier-trigger'));
    await userEvent.click(await screen.findByTestId('chat-cost-tier-unset'));

    // `undefined`, not `'low'`: with no preference OpenRouter chooses the band itself.
    await waitFor(() => expect(savedTier()).toBeUndefined());
    expect(screen.getByTestId('chat-cost-tier-label').textContent).toBe('Default');
  });
});

describe('the transcript', () => {
  it('renders assistant markdown through the sanitizing component and nothing else', async () => {
    const { store } = await mount();

    await streamAnswer(store, 'Use **VACUUM** and `ANALYZE`.\n\n<script>alert(1)</script>');

    const body = await screen.findByTestId('chat-message-body');
    const rendered = within(body).getByTestId('markdown-content');
    // Parsed…
    expect(rendered.innerHTML).toContain('<strong>VACUUM</strong>');
    expect(rendered.innerHTML).toContain('<code>ANALYZE</code>');
    // …and sanitized. The seam is the only reason this is not an executable script tag.
    expect(rendered.innerHTML).not.toContain('<script');
  });

  it('shows the user’s own message as text, never as markdown', async () => {
    const { store } = await mount();
    await store.getState().sendMessage('is `DROP TABLE` safe?');

    const user = screen
      .getAllByTestId('chat-message')
      .find(message => message.dataset['role'] === 'user') as HTMLElement;
    // The backticks are still backticks: a user's message is not model output and is not parsed.
    expect(user.textContent).toContain('is `DROP TABLE` safe?');
    expect(within(user).queryByTestId('markdown-content')).toBeNull();
  });
});

describe('the tool-confirmation flow', () => {
  /**
   * Sends a message and puts a pending tool call on the assistant placeholder — **and stops there,
   * with no `done: true`, because that is now the whole sequence the main process emits.**
   *
   * The absence of the terminal chunk is the shape of the feature (J-61). `ChatService` breaks its
   * agentic loop to wait for the user but does NOT declare the turn over: it stays open across the
   * confirmation, so the continuation's deltas land in a message the renderer is still treating as
   * streaming. An earlier version of this helper emitted `done: true` here, which was true of main
   * at the time and is not any more — every test in this block would have been driving a sequence
   * main can no longer produce. `streaming` is therefore TRUE while the card is on screen, and the
   * composer's second gate (`selectHasPendingConfirmation`) is what refuses a message, not `done`.
   */
  async function pendingConfirmation(store: ChatStore): Promise<void> {
    await store.getState().sendMessage('drop it');
    double.emit({
      conversationId: CONVERSATION_ID,
      toolCall: {
        id: 'tool-1',
        toolName: 'run_query',
        args: { sql: 'DROP TABLE orders' },
        pendingConfirmation: true,
      },
      done: false,
    });
  }

  it('states the tool, its description and its SQL — the description being what Angular never loaded', async () => {
    const { store } = await mount();
    await pendingConfirmation(store);

    const card = await screen.findByTestId('chat-tool-confirm');
    expect(card.textContent).toContain('run_query');
    // The `loadTools: true` decision, visible: without the catalogue this line is absent.
    expect(within(card).getByTestId('chat-tool-description').textContent).toContain(
      'Runs a SQL statement'
    );
    expect(within(card).getByTestId('chat-tool-args').textContent).toContain('DROP TABLE orders');
  });

  it('approves through IPC and leaves the outcome to the main process', async () => {
    const { store } = await mount();
    await pendingConfirmation(store);

    await userEvent.click(await screen.findByTestId('chat-tool-approve'));

    expect(double.confirmations()).toEqual([{ toolCallId: 'tool-1', confirmed: true }]);
    // Deliberately NOT patched locally: the tool has not run yet, and inventing a result here would
    // show an outcome the tool never produced. The card still reads as pending.
    expect(store.getState().messages.at(-1)?.toolCalls?.[0]?.pendingConfirmation).toBe(true);
  });

  it('runs a confirmed tool ONCE, however fast the button is clicked twice', async () => {
    // A second approval used to run the tool again and start a second agentic loop. For `execute_ddl`
    // that was two DROP TABLEs from one double-click. `ChatService.confirmToolCall` now refuses the
    // repeat itself (J-60, `chat-service.confirm-tool.spec.ts`); this side of the boundary keeps the
    // card armed once, so the second click never becomes an IPC message at all.
    const { store } = await mount();
    await pendingConfirmation(store);

    const approve = await screen.findByTestId('chat-tool-approve');
    const decline = screen.getByTestId('chat-tool-decline');
    await userEvent.click(approve);
    await userEvent.click(approve);

    expect(double.confirmations()).toEqual([{ toolCallId: 'tool-1', confirmed: true }]);
    // Visibly disarmed, not merely inert — and `Button`'s disabled-`primary` treatment drops the fill.
    expect(approve.hasAttribute('disabled')).toBe(true);
    expect(decline.hasAttribute('disabled')).toBe(true);
    // No invented result: the card still reads as pending until the real `toolResult` chunk lands.
    expect(store.getState().messages.at(-1)?.toolCalls?.[0]?.pendingConfirmation).toBe(true);
  });

  it('refuses to send another message while the confirmation is unanswered', async () => {
    // Two independent gates, and this pins both. Since J-61 the turn is still open while the card
    // waits, so `streaming` alone would already disable the box — but the reason the composer must
    // ALSO gate on `selectHasPendingConfirmation` is that a message sent from it orphans the card:
    // main's `confirmToolCall` looks the id up in the last assistant message, which a new turn
    // displaces. The placeholder proves which gate is doing the talking.
    const { store } = await mount();
    await pendingConfirmation(store);
    await screen.findByTestId('chat-tool-confirm');

    expect(store.getState().streaming).toBe(true);
    const box = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('placeholder')).toBe('Waiting on the tool request above');
    // Stop, not a disabled Send: the turn is open. Stop is `outline`, so the card's Run it is still
    // the only filled control on the surface (HOUSE-RULES §5).
    expect(screen.queryByTestId('chat-send')).toBeNull();
    expect(screen.getByTestId('chat-stop')).not.toBeNull();
    // And it says why, where the refusal is.
    expect(screen.getByTestId('chat-confirm-blocked').textContent).toContain('run it or cancel it');

    const sendsBefore = double.sends().length;
    await userEvent.type(box, 'never mind, do something else{Enter}');
    expect(double.sends()).toHaveLength(sendsBefore);

    // Answering the card gives the composer back — but only once main ends the turn it kept open.
    // A decline is answered with the terminal chunk from `ChatService.confirmToolCall`.
    await userEvent.click(screen.getByTestId('chat-tool-decline'));
    await waitFor(() => expect(screen.queryByTestId('chat-confirm-blocked')).toBeNull());
    double.emit({
      conversationId: CONVERSATION_ID,
      delta: '\n\nTool call cancelled by user.',
      done: true,
    });
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false)
    );
  });

  it('declines the tool call in the message that holds it, not the newest one', async () => {
    // The positional patch this replaces wrote to "the last assistant message", which is only the right
    // one while nothing has happened since. Here an assistant message follows the pending card.
    const { store } = await mount();
    await pendingConfirmation(store);

    const withCard = store.getState().messages.at(-1)?.id;
    store.setState(state => ({
      messages: [
        ...state.messages,
        {
          id: 'later-assistant',
          role: 'assistant' as const,
          content: 'Something else entirely.',
          timestamp: '2026-08-16T09:05:00.000Z',
          toolCalls: [],
        },
      ],
    }));

    await userEvent.click(await screen.findByTestId('chat-tool-decline'));

    const patched = store.getState().messages.find(message => message.id === withCard);
    expect(patched?.toolCalls?.[0]?.error).toBe('Cancelled by user');
    expect(patched?.toolCalls?.[0]?.pendingConfirmation).toBe(false);
    // The newer message was not touched, and grew no tool calls of its own.
    expect(store.getState().messages.at(-1)?.toolCalls).toHaveLength(0);
  });

  it('declines, and says so immediately because no result chunk is coming', async () => {
    const { store } = await mount();
    await pendingConfirmation(store);

    await userEvent.click(await screen.findByTestId('chat-tool-decline'));

    expect(double.confirmations()).toEqual([{ toolCallId: 'tool-1', confirmed: false }]);
    expect(store.getState().messages.at(-1)?.toolCalls?.[0]?.error).toBe('Cancelled by user');
    await waitFor(() => expect(screen.queryByTestId('chat-tool-confirm')).toBeNull());
    expect(await screen.findByTestId('chat-tool-status-error')).not.toBeNull();
  });

  it('shows a completed tool’s rows in a table, on demand', async () => {
    const { store } = await mount();
    await store.getState().sendMessage('count them');
    double.emit({
      conversationId: CONVERSATION_ID,
      toolResult: {
        id: 'tool-2',
        toolName: 'run_query',
        args: { sql: 'SELECT count(*) FROM orders' },
        success: true,
        durationMs: 12,
        result: { rows: [{ count: 42 }], rowCount: 1 },
      },
      done: false,
    });

    // Collapsed by default: a transcript of ten tool calls is unreadable with every result open.
    expect(screen.queryByTestId('chat-tool-table')).toBeNull();
    await userEvent.click(await screen.findByTestId('chat-tool-toggle'));

    const table = await screen.findByTestId('chat-tool-table');
    expect(table.textContent).toContain('count');
    expect(table.textContent).toContain('42');
    expect(screen.getByTestId('chat-tool-status-done')).not.toBeNull();
  });
});

describe('the conversation list', () => {
  it('creates, selects, renames and deletes', async () => {
    await mount({
      ...seeded(),
      conversations: [
        makeConversation({ id: CONVERSATION_ID, title: 'Schema chat' }),
        makeConversation({ id: 'conv-2', title: 'Index tuning' }),
      ],
    });

    // Collapsed to start with: the panel is 400px wide and the transcript is what it is for.
    expect(screen.queryByTestId('chat-conversations')).toBeNull();
    await userEvent.click(screen.getByTestId('chat-conversations-toggle'));
    expect(screen.getAllByTestId('chat-conversation')).toHaveLength(2);

    // Create.
    await userEvent.click(screen.getByTestId('chat-new-conversation'));
    await waitFor(() => expect(double.conversations()).toHaveLength(3));
    expect(screen.getByTestId('chat-title').textContent).toContain('New Chat');

    // Select — and the list closes, because selecting one is what it was open for. The list is still
    // open here: creating a conversation does not collapse it.
    const rows = screen.getAllByTestId('chat-conversation');
    const tuning = rows.find(row => row.textContent?.includes('Index tuning')) as HTMLElement;
    await userEvent.click(within(tuning).getByTestId('chat-conversation-select'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-title').textContent).toContain('Index tuning')
    );
    expect(screen.queryByTestId('chat-conversations')).toBeNull();

    // Rename, in the row that was clicked.
    await userEvent.click(screen.getByTestId('chat-conversations-toggle'));
    const again = screen
      .getAllByTestId('chat-conversation')
      .find(row => row.textContent?.includes('Index tuning')) as HTMLElement;
    await userEvent.click(within(again).getByTestId('chat-conversation-rename'));
    const input = screen.getByTestId('chat-conversation-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'Index work{Enter}');
    await waitFor(() =>
      expect(double.conversations().find(c => c.id === 'conv-2')?.title).toBe('Index work')
    );
  });

  it('asks twice before deleting a transcript', async () => {
    await mount({
      ...seeded(),
      conversations: [makeConversation({ id: 'conv-2', title: 'Index tuning' })],
    });
    await userEvent.click(screen.getByTestId('chat-conversations-toggle'));

    await userEvent.click(screen.getByTestId('chat-conversation-delete'));
    // One click arms it and deletes nothing — the Angular version deleted here.
    expect(double.conversations()).toHaveLength(1);

    await userEvent.click(screen.getByTestId('chat-conversation-delete-confirm'));
    await waitFor(() => expect(double.conversations()).toHaveLength(0));
  });

  it('cancels a rename on Escape, leaving the title alone', async () => {
    await mount();
    await userEvent.click(screen.getByTestId('chat-conversations-toggle'));
    await userEvent.click(screen.getByTestId('chat-conversation-rename'));

    const input = screen.getByTestId('chat-conversation-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'nonsense{Escape}');

    expect(double.conversations()[0]?.title).toBe('Schema chat');
    expect(screen.queryByTestId('chat-conversation-rename-input')).toBeNull();
  });

  it('says the list is empty rather than showing nothing', async () => {
    await mount({ ...seeded(), conversations: [] }, 'panel', undefined);
    await userEvent.click(screen.getByTestId('chat-conversations-toggle'));

    expect(screen.getByTestId('chat-conversations-empty').textContent).toContain(
      'No conversations yet'
    );
  });
});

describe('panel and tab', () => {
  it('offers close and pop-out in the panel only', async () => {
    await mount(seeded(), 'panel');
    expect(screen.getByTestId('chat-panel')).not.toBeNull();
    expect(screen.getByTestId('chat-pop-out')).not.toBeNull();
    expect(screen.getByTestId('chat-panel-close')).not.toBeNull();
  });

  it('offers neither in a tab, where the dock owns both', async () => {
    await mount(seeded(), 'tab');
    expect(screen.getByTestId('chat-tab')).not.toBeNull();
    expect(screen.queryByTestId('chat-pop-out')).toBeNull();
    expect(screen.queryByTestId('chat-panel-close')).toBeNull();
  });

  it('pops out to a tab carrying the conversation, and closes the panel behind it', async () => {
    const { store } = await mount();
    store.setState({ panelOpen: true });

    await userEvent.click(screen.getByTestId('chat-pop-out'));

    const chatTab = tabStore.getState().tabs.find(tab => tab.type === 'chat');
    expect(chatTab?.metadata?.['conversationId']).toBe(CONVERSATION_ID);
    // Both on screen would be two live instances writing one transcript.
    expect(store.getState().panelOpen).toBe(false);
  });

  it('closes the panel from its own button', async () => {
    const { store } = await mount();
    store.setState({ panelOpen: true });

    await userEvent.click(screen.getByTestId('chat-panel-close'));
    expect(store.getState().panelOpen).toBe(false);
  });
});

describe('re-opening the surface', () => {
  it('does not refetch the transcript while a stream is open, which would drop the answer', async () => {
    // Angular's panel was never unmounted (closing it set `width: 0`), so its `ngOnInit` ran once per
    // window. Here ⇧⌘I unmounts it, and `initialize()` refetches the active conversation — whose SAVED
    // copy has no in-flight assistant message in it. Without the guard, closing and re-opening the panel
    // mid-answer replaces the transcript with the persisted one and the answer being written is lost.
    const { store } = await mount();
    await store.getState().sendMessage('a long question');
    double.emit({ conversationId: CONVERSATION_ID, delta: 'half an answer', done: false });

    const messagesBefore = store.getState().messages.length;
    expect(store.getState().streaming).toBe(true);

    // Re-mounting the surface against the same store is what closing and re-opening the panel does.
    render(
      <TooltipProvider>
        <ChatSurface store={store} mode="panel" />
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getAllByTestId('chat-message').length).toBeGreaterThan(0));

    // The placeholder and the buffered text are both still there.
    expect(store.getState().messages).toHaveLength(messagesBefore);
    expect(store.getState().messages.at(-1)?.streaming).toBe(true);
    expect(store.getState().streamingContent).toBe('half an answer');
  });

  it('does refresh the conversation list when nothing is streaming', async () => {
    const { store } = await mount();
    const callsBefore = double.getToolsCalls();

    render(
      <TooltipProvider>
        <ChatSurface store={store} mode="panel" />
      </TooltipProvider>
    );

    // `initialize()` ran again — the list may have changed in another instance, and that refresh is the
    // reason there is no once-only latch.
    await waitFor(() => expect(double.getToolsCalls()).toBe(callsBefore + 1));
  });
});

describe('the model’s UI actions', () => {
  it('routes an open-settings action to the command that owns the dialog', async () => {
    const { store } = await mount();
    const handler = vi.fn();
    teardowns.push(subscribeCommand('open-settings', handler));

    await store.getState().sendMessage('open settings for me');
    double.emit({
      conversationId: CONVERSATION_ID,
      uiAction: { type: 'open-settings' },
      done: false,
    });

    await waitFor(() => expect(handler).toHaveBeenCalledOnce());
    // Consumed, so a re-render cannot fire it again.
    expect(store.getState().pendingUiAction).toBeNull();
  });

  it('routes an open-backup-dialog action to Task 12’s consumer', async () => {
    const { store } = await mount();
    const handler = vi.fn();
    teardowns.push(subscribeCommand('open-backup-dialog', handler));

    await store.getState().sendMessage('back it up');
    double.emit({
      conversationId: CONVERSATION_ID,
      uiAction: { type: 'open-backup-dialog' },
      done: false,
    });

    await waitFor(() => expect(handler).toHaveBeenCalledOnce());
  });
});

describe('the database context line', () => {
  it('says there is none when nothing in front carries a connection', async () => {
    await mount();
    // The line reads the same source `sendMessage` does, so with no context it has to say so
    // rather than imply one.
    expect(screen.getByTestId('chat-context').textContent).toContain('No database context');
  });
});
