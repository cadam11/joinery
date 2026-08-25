/**
 * The query-history dialog: search everything this app has executed, and open one of it back up.
 *
 * Replaces `shared/components/query-history-dialog/query-history-dialog.component.ts` (608).
 *
 * ── One filter, not two ─────────────────────────────────────────────────────────────────────
 *
 * The Angular dialog searched **twice**: a local `computed()` over the entries already loaded, and a
 * debounced `historyState.search()` that asked the main process to filter as well. Both matched on the
 * same three fields (`sql`, `database`, `connectionName`), which is what made the duplication invisible
 * — and wrong in one direction that matters. The main process applies `filter.limit` *after* its search
 * (`services/config/query-history.ts:87-108`), so a remote search reaches every entry in the store,
 * while a local filter can only ever see the 100 the last load returned. The local half is deleted:
 * typing here narrows the whole history, not the visible page of it.
 *
 * The debounce stays, because each keystroke is an IPC round trip.
 *
 * ── Load vs execute ─────────────────────────────────────────────────────────────────────────
 *
 * Two actions per row, and the difference is the `autoExecute` flag on the new tab — the same flag the
 * explorer's "select top 1000" uses, so a re-executed history entry follows exactly the path a
 * double-clicked table does. Which connection they land on is `history-target.ts`, which is also where
 * the Angular bug in that resolution is written down.
 *
 * Keyboard: ↑/↓ move, Enter loads, ⇧Enter executes, Esc closes (Radix). The Angular version installed a
 * capturing `document` keydown listener for this and removed it in `ngOnDestroy`; here it is an
 * `onKeyDown` on the dialog, which cannot outlive the surface it belongs to.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Clock, Play, Trash2, TriangleAlert } from 'lucide-react';
import type { QueryHistoryEntry } from '@joinery/shared';

import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Icon,
  Input,
  Spinner,
  Tooltip,
  cn,
} from '../../ui';
import { useQueryHistoryStore } from '../../state/query-history';
import { firstSqlLine, formatDuration, formatRelativeTime, shortError } from './history-format';

/** How long typing settles before the search goes to the main process. The Angular value (`:486`). */
export const SEARCH_DEBOUNCE_MS = 200;

export interface QueryHistoryDialogProps {
  readonly onDismiss: () => void;
  /** Open the entry in a new query tab. */
  readonly onLoad: (entry: QueryHistoryEntry) => void;
  /** Open it in a new query tab and run it immediately. */
  readonly onExecute: (entry: QueryHistoryEntry) => void;
}

export function QueryHistoryDialog({ onDismiss, onLoad, onExecute }: QueryHistoryDialogProps) {
  const entries = useQueryHistoryStore(state => state.entries);
  const loading = useQueryHistoryStore(state => state.loading);

  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * The debounced remote search. The cleanup is what makes it a debounce rather than a queue: a
   * keystroke inside the window cancels the pending call, so a burst of typing costs one round trip.
   *
   * **The first run is skipped** (J-121). This effect ran on mount with an empty box and fetched
   * the whole history again 200ms later — a second identical IPC round trip on EVERY open, on top
   * of the one the command handler had already made. It also made
   * `query-history-host.spec.tsx` flaky at about one run in three: under full-suite load the test
   * outlived the debounce window, so the second fetch landed before the assertion counted them.
   *
   * A ref rather than comparing `search` to `''`: typing and then clearing the box back to empty
   * IS a real search, and must still reach the main process.
   */
  const searchHasChanged = useRef(false);
  useEffect(() => {
    if (!searchHasChanged.current) {
      searchHasChanged.current = true;
      return;
    }

    const timer = setTimeout(() => {
      void useQueryHistoryStore.getState().search(search);
      setSelectedIndex(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // The selection has to stay inside the list when the list shrinks under it.
  const boundedIndex = entries.length === 0 ? 0 : Math.min(selectedIndex, entries.length - 1);

  /**
   * The clock the relative timestamps are measured against, ticking once a minute.
   *
   * State plus an effect rather than `Date.now()` in the render body: reading the clock while
   * rendering is impure (`react-hooks/purity` says so), and it also silently froze the row's "12m ago"
   * for as long as the dialog stayed open. The interval is what makes the label true a minute later.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Radix focuses the first tabbable element in the content, which is the header's close button. The
   * search field is where typing should land, and `autoFocus` is banned by `jsx-a11y/no-autofocus`, so
   * the move happens once on mount instead.
   */
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const act = (entry: QueryHistoryEntry | undefined, kind: 'load' | 'execute'): void => {
    if (entry === undefined) return;
    if (kind === 'execute') onExecute(entry);
    else onLoad(entry);
    onDismiss();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(Math.max(boundedIndex + step, 0), Math.max(entries.length - 1, 0));
      setSelectedIndex(next);
      // `block: 'nearest'` so a row already on screen does not scroll the list under the pointer.
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      act(entries[boundedIndex], event.shiftKey ? 'execute' : 'load');
    }
  };

  return (
    <Dialog open onOpenChange={next => (next ? undefined : onDismiss())}>
      <DialogContent
        size="lg"
        data-testid="query-history-dialog"
        className="h-[70dvh]"
        onKeyDown={onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Query history</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-3">
          <Input
            name="query-history-search"
            aria-label="Search query history"
            data-testid="query-history-search"
            placeholder="Search SQL, database or connection…"
            ref={searchRef}
            autoComplete="off"
            spellCheck={false}
            fieldClassName="grow"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <span
            data-testid="query-history-count"
            className="shrink-0 text-sm text-fg-muted tabular-nums"
          >
            {entries.length} {entries.length === 1 ? 'query' : 'queries'}
          </span>
          <Tooltip content="Clear all history">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              leadingIcon={Trash2}
              aria-label="Clear all history"
              data-testid="query-history-clear"
              disabled={entries.length === 0}
              // The store rethrows a failed clear, which is the one action here that must not look
              // like it worked; the toast it raises first is what the user sees.
              onClick={() =>
                void useQueryHistoryStore
                  .getState()
                  .clearHistory()
                  .catch(() => undefined)
              }
            />
          </Tooltip>
        </div>

        <DialogBody ref={listRef} className="p-0">
          {loading && entries.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Loading history…" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                size="sm"
                icon={Clock}
                title={search === '' ? 'No queries yet' : 'Nothing matches that'}
                description={
                  search === ''
                    ? 'Execute a query and it appears here — every statement this app runs is recorded.'
                    : `No statement, database or connection matches “${search}”.`
                }
              />
            </div>
          ) : (
            entries.map((entry, index) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                index={index}
                now={now}
                selected={index === boundedIndex}
                onSelect={() => setSelectedIndex(index)}
                onLoad={() => act(entry, 'load')}
                onExecute={() => act(entry, 'execute')}
              />
            ))
          )}
        </DialogBody>

        <DialogActions>
          <p className="mr-auto text-sm text-fg-muted">
            Enter opens in a new tab · ⇧Enter opens and runs it
          </p>
          <DialogClose asChild>
            <Button data-testid="query-history-close">Close</Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

interface HistoryRowProps {
  readonly entry: QueryHistoryEntry;
  readonly index: number;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onLoad: () => void;
  readonly onExecute: () => void;
}

/**
 * One row: the whole statement is the LOAD affordance, and running it is a button beside it.
 *
 * **No double-click handler**, unlike the Angular row. A `dblclick` that means something different from
 * the `click` it is built out of is a race the DOM does not let you win — the click fires first — so a
 * "double-click to run" row that also loads on click opens two tabs and runs one of them. Angular
 * avoided it only because its single click merely *selected*, which left the footer hint ("Click to
 * open in new tab, double-click to execute") describing behaviour the component did not have. Here the
 * two actions are two affordances, and the hint matches the code.
 *
 * The statement is a real `<button>` rather than a div with a click handler, so it is reachable by Tab
 * and announces itself; the execute button is its sibling, because a button inside a button is invalid
 * markup that Chromium resolves by dropping one of them.
 */
function HistoryRow({ entry, index, now, selected, onSelect, onLoad, onExecute }: HistoryRowProps) {
  return (
    <div
      data-testid="query-history-row"
      data-index={index}
      data-selected={selected ? 'true' : undefined}
      data-failed={entry.success ? undefined : 'true'}
      onMouseEnter={onSelect}
      className={cn(
        'flex items-start gap-2 border-b border-rule pr-2',
        // `bg-active` is the oxide selected-row wash the tree uses — HOUSE-RULES §5 lists it among
        // oxide's jobs, so a selected row costs the dialog nothing from its one filled-oxide budget.
        selected ? 'bg-active' : 'hover:bg-hover'
      )}
    >
      <button
        type="button"
        aria-label={`Open in a new tab: ${firstSqlLine(entry.sql, 60)}`}
        data-testid="query-history-load"
        onClick={onLoad}
        onFocus={onSelect}
        className="flex min-w-0 grow items-start gap-3 px-4 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        <Icon
          icon={entry.success ? Clock : TriangleAlert}
          size="sm"
          className={cn('mt-0.5', entry.success ? 'stroke-fg-subtle' : 'stroke-danger')}
        />

        <span className="flex min-w-0 grow flex-col gap-1">
          <span
            data-testid="query-history-sql"
            className="truncate font-mono text-sm text-fg"
            title={entry.sql}
          >
            {firstSqlLine(entry.sql)}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span data-testid="query-history-database">{entry.database}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatRelativeTime(entry.executedAt, now)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatDuration(entry.executionTimeMs)}</span>
            {entry.success && entry.rowCount !== undefined ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{entry.rowCount} rows</span>
              </>
            ) : null}
            {!entry.success && entry.error !== undefined ? (
              <span className="text-danger" title={entry.error}>
                {shortError(entry.error)}
              </span>
            ) : null}
          </span>
        </span>
      </button>

      <Tooltip content="Open and run">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          leadingIcon={Play}
          aria-label="Open and run"
          data-testid="query-history-execute"
          className="mt-1.5"
          onClick={onExecute}
        />
      </Tooltip>
    </div>
  );
}
