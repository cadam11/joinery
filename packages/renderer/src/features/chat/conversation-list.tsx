/**
 * The conversation list: select, rename, delete.
 *
 * ── Not a menu, and not the Angular dropdown ───────────────────────────────────────────────
 *
 * Angular built this as a hand-rolled absolute-positioned dropdown with a `document.addEventListener`
 * outside-click closer set up inside a `setTimeout(0)` (`:1299-1330`), and it renamed in a DIFFERENT
 * place from the row you clicked: the row's pencil switched the *header title* into an input, after a
 * `setTimeout(50)` and a `document.querySelector('.conv-rename-input')` to find it.
 *
 * This is an expanding region under the header instead, driven by `conversationsExpanded` — a flag
 * the store already had and nothing read. Three consequences worth stating:
 *
 *  - **no outside-click listener**, because nothing is floating over the app;
 *  - **rename happens in the row**, so the thing being renamed is the thing under the cursor, and the
 *    input is reached by a ref rather than by querying the document;
 *  - a Radix menu was considered and rejected: its typeahead owns every printable key inside it, so a
 *    text field in a menu item cannot be typed into.
 *
 * ── Delete asks twice ──────────────────────────────────────────────────────────────────────
 *
 * Angular deleted on the first click, with no confirmation and no undo — a whole transcript, gone to a
 * mis-click on a 16px glyph. The armed state is inline rather than a dialog: a modal for one row in a
 * side panel is heavier than the action, and the second click is what an accidental first one never
 * gets.
 */

import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ChatStore, ConversationSummary } from '../../state/chat';
import { Icon, Tooltip, cn } from '../../ui';
import { formatConversationDate } from './tool-result';

/** The row's two icon buttons share this. 20px, with the focus ring dense chrome needs. */
const ROW_BUTTON_CLASSES = cn(
  'flex size-5 shrink-0 items-center justify-center rounded-xs',
  'text-fg-muted hover:bg-hover hover:text-fg',
  'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
);

export interface ConversationListProps {
  readonly store: ChatStore;
  /**
   * Summaries, not whole conversations: this list renders titles and dates, and the store
   * deliberately does not keep transcripts that would go stale beside a live stream (J-63).
   */
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId: string | null;
}

export function ConversationList({
  store,
  conversations,
  activeConversationId,
}: ConversationListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  /** The row whose delete button has been clicked once. Cleared by any other action. */
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const renameBox = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId === null) return;
    renameBox.current?.focus();
    renameBox.current?.select();
  }, [renamingId]);

  const commitRename = (): void => {
    const id = renamingId;
    const title = renameText.trim();
    setRenamingId(null);
    if (id === null || title === '') return;
    void store.getState().renameConversation(id, title);
  };

  const startRename = (conversation: ConversationSummary): void => {
    setArmedDeleteId(null);
    setRenameText(conversation.title);
    setRenamingId(conversation.id);
  };

  const select = (id: string): void => {
    setArmedDeleteId(null);
    void store.getState().selectConversation(id);
    store.getState().toggleConversations();
  };

  const remove = (id: string): void => {
    if (armedDeleteId !== id) {
      setArmedDeleteId(id);
      return;
    }
    setArmedDeleteId(null);
    void store.getState().deleteConversation(id);
  };

  return (
    <div
      data-testid="chat-conversations"
      aria-label="Conversations"
      className="flex max-h-48 shrink-0 flex-col overflow-y-auto border-b border-rule bg-chrome"
    >
      {conversations.length === 0 ? (
        <p data-testid="chat-conversations-empty" className="px-3 py-2 text-sm text-fg-muted">
          No conversations yet.
        </p>
      ) : null}

      {conversations.map(conversation => {
        const active = conversation.id === activeConversationId;
        const renaming = conversation.id === renamingId;
        const armed = conversation.id === armedDeleteId;

        return (
          <div
            key={conversation.id}
            data-testid="chat-conversation"
            data-active={active}
            className={cn('flex min-w-0 items-center gap-1 px-2 py-1', active && 'bg-active')}
          >
            {renaming ? (
              <input
                ref={renameBox}
                aria-label={`Rename ${conversation.title}`}
                data-testid="chat-conversation-rename-input"
                value={renameText}
                onChange={event => setRenameText(event.target.value)}
                onBlur={commitRename}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitRename();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setRenamingId(null);
                  }
                }}
                className={cn(
                  'min-w-0 grow rounded-xs border border-rule-strong bg-surface px-1 text-sm text-fg',
                  'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
                )}
              />
            ) : (
              <>
                <button
                  type="button"
                  data-testid="chat-conversation-select"
                  onClick={() => select(conversation.id)}
                  className={cn(
                    'min-w-0 grow truncate rounded-xs px-1 py-0.5 text-left text-sm',
                    active ? 'text-fg' : 'text-fg-muted hover:text-fg',
                    'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
                  )}
                >
                  {conversation.title}
                </button>

                {/* `text-fg-muted`, not subtle: HOUSE-RULES §5 measures subtle at 3.11:1 on ivory
                    chrome and reserves it for metadata nobody reads. This date is how a user picks
                    between two conversations, so it is read. Verified by the browser gate. */}
                <span className="shrink-0 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
                  {formatConversationDate(conversation.updatedAt)}
                </span>

                <Tooltip content="Rename">
                  <button
                    type="button"
                    aria-label={`Rename ${conversation.title}`}
                    data-testid="chat-conversation-rename"
                    onClick={() => startRename(conversation)}
                    className={ROW_BUTTON_CLASSES}
                  >
                    <Icon icon={Pencil} size="sm" />
                  </button>
                </Tooltip>

                {armed ? (
                  <button
                    type="button"
                    data-testid="chat-conversation-delete-confirm"
                    onClick={() => remove(conversation.id)}
                    className={cn(
                      'shrink-0 rounded-xs px-1 text-xs text-danger hover:bg-hover',
                      'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
                    )}
                  >
                    Delete?
                  </button>
                ) : (
                  <Tooltip content="Delete">
                    <button
                      type="button"
                      aria-label={`Delete ${conversation.title}`}
                      data-testid="chat-conversation-delete"
                      onClick={() => remove(conversation.id)}
                      className={ROW_BUTTON_CLASSES}
                    >
                      <Icon icon={Trash2} size="sm" />
                    </button>
                  </Tooltip>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
