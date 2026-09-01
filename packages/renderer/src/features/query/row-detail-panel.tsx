/**
 * The row inspector: one row of a result set read vertically, with its foreign keys followed.
 *
 * Replaces `row-detail-panel.component.ts` (1,315 lines). The pure half — the field model, the type
 * formatting, the FK resolution and the generated SQL — is in `row-detail.ts` and `fk-lookup.ts`;
 * what is left here is the surface and the two IPC calls it makes.
 *
 * ── A rail, not a modal ───────────────────────────────────────────────────────────────────────
 *
 * Angular rendered a `.detail-overlay` + `.detail-panel` pair: a scrim over the whole query tab, so
 * the grid the row came from was hidden behind the thing describing it, and every click outside
 * closed the panel. This is a rail inside the results pane instead — the grid stays visible and
 * addressable beside it, `Escape` still closes (from inside the rail, so the editor keeps its own
 * `Escape`), and there is no focus trap to fight because nothing is modal. PLAN.md's constraint for
 * this task is "panels WITHIN the query tab", and a scrim over the tab is the one thing that is not.
 *
 * ── Three Material tabs became one list ───────────────────────────────────────────────────────
 *
 * The original split a row across `Values`, `Full Value` and `Schema` tabs, which put a cell's value
 * in one tab and its type in another and made "what is in this column?" a two-click question. Here
 * each field carries its own type, its keys and its value, and a value too long for the rail expands
 * in place. The Schema tab's remaining content — nullability and defaults — is on the expanded field,
 * where it describes something the user is looking at.
 *
 * ── Where the FK preview runs, and why it is `query.fetchFkRecord` (J-145) ────────────────────
 *
 * On the bridge's purpose-built member, which for one release it was not. `fetchFkRecord` used to
 * build `SELECT TOP 1 * FROM [schema].[table]` in the main process for EVERY engine — T-SQL, and so
 * a syntax error on PostgreSQL and MySQL — so the React rewrite (with `packages/main` out of its
 * scope, PLAN.md §8) generated the SQL here instead and sent it down `query.execute`. That worked,
 * and it put the app's most data-driven lookup on the one channel entitled to MySQL's
 * multi-statement pool, with an escaped literal carrying a result-set cell. J-145 moved the SQL onto
 * the dialect layer and BOUND the value, so this file no longer generates any SQL it executes.
 *
 * Three consequences, all deliberate:
 *
 *  - the value is a bound parameter, not an escaped literal, and on MySQL the statement goes out on
 *    the restricted pool, where a second statement is not expressible at all (J-137);
 *  - the referenced row's primary key is marked on all three engines. The old path got that only on
 *    SQL Server, where the executor parsed the table back out of the SQL to enrich the columns; the
 *    handler is told the table outright;
 *  - the lookup NO LONGER lands in the query history. It did while it was a `query.execute` call,
 *    and CLAUDE.md's "SQL Transparency" rule is the argument for keeping it there — but a bound
 *    statement's history row would read `… WHERE "id" = $1` with the value absent, which is a worse
 *    record than none. It is still kept out of the result-history snapshots, as it always was.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Rows3,
  X,
} from 'lucide-react';
import type { ColumnMetadata, DatabaseEngine } from '@joinery/shared';

import { useIpcQuery } from '../../ipc';
import { diagnostics, notify } from '../../state/diagnostics';
import { selectProfileFor, useConnectionStore } from '../../state/connection';
import { selectSqlFor, useQueryExecutionStore } from '../../state/query-execution';
import { tabStore, useTabStore } from '../../state/tab';
import { Button, Spinner, Tooltip, cn } from '../../ui';
import {
  displayValue,
  fkOpenSql,
  fkTabTitle,
  mergeEnrichedColumns,
  parseSingleTableSelect,
  type FkTarget,
} from './fk-lookup';
import { buildRowFields, rowAsText, type RowField } from './row-detail';

/**
 * The displayed rows, as the grid sees them — post-sort, post-filter, in displayed order.
 *
 * Next/Previous walk THIS rather than `resultSet.rows`, which is the bug
 * `tests/e2e/row-detail.spec.ts` was written for: after a sort, displayed row N is not
 * `rows[N]`, so a drawer indexing the original array showed a different row than the one clicked.
 * The grid hands this over when it opens the rail, because the grid is the only thing that knows.
 */
export interface DisplayedRows {
  readonly count: () => number;
  readonly at: (index: number) => Record<string, unknown> | null;
}

export interface RowDetailTarget {
  /** The DISPLAYED index, zero-based. The header shows it one-based. */
  readonly rowIndex: number;
  readonly row: Record<string, unknown>;
  readonly columns: readonly ColumnMetadata[];
  /** Displayed rows at the moment of opening — the bound Next stops at. */
  readonly totalRows: number;
  /**
   * Which result set of the batch the row came from. The pane compares it against the visible result
   * tab, so switching tabs retires a rail whose grid has been unmounted.
   */
  readonly resultIndex: number;
  readonly source: DisplayedRows;
}

/** What the user has opened on one row, and which row that was. See `interaction` below. */
interface FieldInteraction {
  readonly row: Record<string, unknown> | null;
  readonly expanded: string | null;
  readonly previewing: string | null;
}

const NO_INTERACTION: FieldInteraction = { row: null, expanded: null, previewing: null };

export interface RowDetailPanelProps {
  readonly tabId: string;
  readonly target: RowDetailTarget;
  readonly onClose: () => void;
  readonly onNavigate: (direction: 'next' | 'previous') => void;
}

export function RowDetailPanel({ tabId, target, onClose, onNavigate }: RowDetailPanelProps) {
  const connectionId = useTabStore(
    state => state.tabs.find(tab => tab.id === tabId)?.connectionId ?? null
  );
  const database = useTabStore(
    state => state.tabs.find(tab => tab.id === tabId)?.databaseName ?? null
  );
  const engine = useConnectionStore(selectProfileFor(connectionId))?.engine ?? null;
  const executedSql = useQueryExecutionStore(selectSqlFor(tabId));

  const columns = useEnrichedColumns({
    columns: target.columns,
    connectionId,
    database,
    engine,
    executedSql,
  });

  const fields = useMemo(() => buildRowFields(target.row, columns), [target.row, columns]);

  /**
   * Which field is expanded, which one's FK preview is open — and WHICH ROW that was decided about.
   *
   * Carrying the row is what resets both when Next moves the rail on, without an effect: an
   * interaction recorded against another row simply is not this row's, so `open` falls back to the
   * closed state. (The obvious `useEffect(() => { setExpanded(null); … }, [target.row])` is a
   * cascading render and `react-hooks/set-state-in-effect` rejects it — correctly: the reset is
   * derivable from the props, so it does not need a second render pass.)
   */
  const [interaction, setInteraction] = useState<FieldInteraction>(NO_INTERACTION);
  const open: FieldInteraction = interaction.row === target.row ? interaction : NO_INTERACTION;

  const toggleExpanded = useCallback(
    (name: string): void =>
      setInteraction(current => ({
        row: target.row,
        previewing: current.row === target.row ? current.previewing : null,
        expanded: current.row === target.row && current.expanded === name ? null : name,
      })),
    [target.row]
  );

  const togglePreview = useCallback(
    (name: string): void =>
      setInteraction(current => ({
        row: target.row,
        expanded: current.row === target.row ? current.expanded : null,
        previewing: current.row === target.row && current.previewing === name ? null : name,
      })),
    [target.row]
  );

  const host = useRef<HTMLElement | null>(null);
  // Focus the rail when it opens: Escape has to reach it, and a user who just opened a panel with a
  // keyboard command should be in it. Deliberately once per mount — re-focusing on navigation would
  // pull focus off the Next button the user is clicking.
  useEffect(() => {
    host.current?.focus();
  }, []);

  /**
   * Escape closes the rail — from a listener on the rail's own element rather than a JSX handler on a
   * non-interactive `<aside>` (`jsx-a11y/no-noninteractive-element-interactions`) and rather than on
   * `document`, which is where Angular put it (`@HostListener('document:keydown.escape')`) and which
   * would take Escape away from Monaco's find widget three panes over. `stopPropagation` keeps it from
   * bubbling to anything that also listens.
   */
  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const copyText = useCallback((text: string, what: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => notify.info(`Copied ${what}`))
      .catch(error => {
        notify.error('Could not copy to the clipboard');
        diagnostics.error('clipboard write failed', error);
      });
  }, []);

  const openInTab = useCallback(
    (fkTarget: FkTarget): void => {
      if (connectionId === null || database === null || engine === null) return;
      openReferencedRowTab({ connectionId, database, engine, target: fkTarget });
    },
    [connectionId, database, engine]
  );

  const canGoPrevious = target.rowIndex > 0;
  const canGoNext = target.rowIndex < target.totalRows - 1;
  const fkReady = connectionId !== null && database !== null && engine !== null;

  return (
    <aside
      ref={host}
      tabIndex={-1}
      data-testid="rowdetail-panel"
      aria-label="Row detail"
      // 336px: wide enough for a name/value pair at the 12px body floor without crowding the grid at
      // the 800px window minimum. On the spacing ladder's 4px grid, per HOUSE-RULES §6.
      className="flex w-84 min-w-0 shrink-0 flex-col border-l border-rule bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    >
      <header className="flex h-(--panel-header-height) shrink-0 items-center gap-2 border-b border-rule px-2">
        <Rows3 className="size-4 shrink-0 stroke-fg-muted" aria-hidden />
        <h2
          data-testid="rowdetail-title"
          className="min-w-0 grow truncate font-mono text-2xs tracking-eyebrow text-fg-muted uppercase"
        >
          Row <span className="tabular-nums text-fg">{target.rowIndex + 1}</span> of{' '}
          <span className="tabular-nums">{target.totalRows.toLocaleString()}</span>
        </h2>
        <Tooltip content="Copy every field">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            leadingIcon={Copy}
            aria-label="Copy every field"
            data-testid="rowdetail-copy-all"
            onClick={() => copyText(rowAsText(fields), 'the row')}
          />
        </Tooltip>
        <Tooltip content="Close (Esc)">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            leadingIcon={X}
            aria-label="Close the row detail"
            data-testid="rowdetail-close"
            onClick={onClose}
          />
        </Tooltip>
      </header>

      <div className="min-h-0 grow overflow-y-auto" data-testid="rowdetail-fields">
        {fields.map(field => {
          // Bound once per field so every closure below shares ONE narrowing of `foreignKey`. The
          // alternative — re-testing `field.foreignKey !== null` inside each handler — needs a cast
          // in the JSX prop, which is the thing this shape exists to avoid.
          const reference = field.foreignKey;
          const followable = reference !== null && fkReady;

          return (
            <FieldRow
              key={field.name}
              field={field}
              expanded={open.expanded === field.name}
              previewing={open.previewing === field.name}
              followable={followable}
              onToggleExpand={() => toggleExpanded(field.name)}
              onCopy={() => copyText(field.isNull ? 'NULL' : field.fullValue, field.name)}
              onTogglePreview={() => togglePreview(field.name)}
              onOpenInTab={() => {
                if (reference !== null) openInTab(reference);
              }}
              preview={
                followable &&
                open.previewing === field.name &&
                connectionId !== null &&
                database !== null &&
                engine !== null ? (
                  <FkPreview
                    target={reference}
                    connectionId={connectionId}
                    database={database}
                    onOpenInTab={() => openInTab(reference)}
                  />
                ) : null
              }
            />
          );
        })}
      </div>

      <footer className="flex h-(--panel-header-height) shrink-0 items-center gap-2 border-t border-rule px-2">
        <p className="min-w-0 grow truncate font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
          <span className="tabular-nums">{fields.length}</span>{' '}
          {fields.length === 1 ? 'column' : 'columns'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={ChevronLeft}
          disabled={!canGoPrevious}
          data-testid="rowdetail-previous"
          onClick={() => onNavigate('previous')}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          trailingIcon={ChevronRight}
          disabled={!canGoNext}
          data-testid="rowdetail-next"
          onClick={() => onNavigate('next')}
        >
          Next
        </Button>
      </footer>
    </aside>
  );
}

/**
 * The result's columns with the table's catalogue metadata folded in, fetched once per table.
 *
 * Unconditional rather than "only when the result lacks FK info": the MSSQL executor attaches keys
 * and nothing else, so the branch would have bought one avoided call per table per 30 seconds at the
 * price of two code paths and a worse panel on SQL Server. `enabled` is the only gate, and it is
 * about whether the question is answerable at all — a JOIN, a CTE or a batch has no single table,
 * and `parseSingleTableSelect` says so rather than guessing.
 */
function useEnrichedColumns(input: {
  readonly columns: readonly ColumnMetadata[];
  readonly connectionId: string | null;
  readonly database: string | null;
  readonly engine: DatabaseEngine | null;
  readonly executedSql: string | null;
}): readonly ColumnMetadata[] {
  const { columns, connectionId, database, engine, executedSql } = input;

  const table = useMemo(() => {
    if (executedSql === null || engine === null || database === null) return null;
    return parseSingleTableSelect(executedSql, engine, database);
  }, [executedSql, engine, database]);

  const enabled = table !== null && connectionId !== null && database !== null;

  const enriched = useIpcQuery({
    namespace: 'explorer',
    operation: 'getEnrichedColumns',
    args: [connectionId ?? '', database ?? '', table?.schema ?? '', table?.table ?? ''],
    keyArgs: [connectionId, database, table?.schema, table?.table],
    enabled,
  });

  return useMemo(() => {
    if (enriched.data === undefined) return columns;
    return mergeEnrichedColumns(columns, enriched.data);
  }, [columns, enriched.data]);
}

interface FieldRowProps {
  readonly field: RowField;
  readonly expanded: boolean;
  readonly previewing: boolean;
  /**
   * This cell points somewhere AND the tab has the connection, database and engine needed to follow
   * it. False makes the value plain text rather than a link that could not resolve.
   */
  readonly followable: boolean;
  readonly onToggleExpand: () => void;
  readonly onCopy: () => void;
  readonly onTogglePreview: () => void;
  readonly onOpenInTab: () => void;
  readonly preview: ReactNode;
}

function FieldRow({
  field,
  expanded,
  previewing,
  followable,
  onToggleExpand,
  onCopy,
  onTogglePreview,
  onOpenInTab,
  preview,
}: FieldRowProps) {
  // What expanding adds: the untruncated value, or the catalogue facts about the column. With
  // neither there is nothing behind the disclosure, so it is not offered.
  const hasMore =
    field.isTruncated || field.nullable !== undefined || field.defaultValue !== undefined;

  return (
    <div
      data-testid="rowdetail-field"
      data-field={field.name}
      className="flex flex-col gap-1 border-b border-rule px-2 py-1.5"
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        {field.isPrimaryKey ? <Badge title="Primary key">pk</Badge> : null}
        {field.reference === null ? null : (
          <Badge title={`References ${field.reference}`}>fk</Badge>
        )}
        {field.isIdentity ? <Badge title="Identity / auto-increment">id</Badge> : null}
        <span className="min-w-0 truncate font-mono text-sm text-fg">{field.name}</span>
        <span className="shrink-0 font-mono text-2xs tracking-eyebrow text-fg-subtle uppercase">
          {field.type}
        </span>
      </div>

      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 grow">
          {field.isNull ? (
            // `text-fg-muted italic` is the grid's own NULL treatment (`results-grid-theme.css`'s
            // `cell-null`, measured at 8.46:1 / 5.82:1 by the Task 11 gate), so the two surfaces agree
            // about what an absent value looks like — and it clears AA body in both themes, which
            // `text-fg-subtle` does not on the ivory canvas.
            <span data-testid="rowdetail-null" className="font-mono text-sm text-fg-muted italic">
              NULL
            </span>
          ) : followable ? (
            <button
              type="button"
              data-testid="rowdetail-fk-link"
              aria-label={`Preview the row ${field.name} references`}
              onClick={onTogglePreview}
              aria-expanded={previewing}
              // The accent is the UNDERLINE, not the text: `--color-accent` measures 3.50:1 on
              // `bg-surface` under ivory (gate-measured), which is short of AA body for something a
              // user reads — and HOUSE-RULES §5 says accent on a raised surface is a fill or a
              // border, not body text. The word stays `text-fg` at 14.39:1 and the affordance is the
              // dotted oxide underline plus the link glyph, which is the same marking the grid's
              // `cell-fk` cells carry.
              className={cn(
                'flex min-w-0 items-center gap-1 text-left font-mono text-sm text-fg',
                'underline decoration-accent decoration-dotted underline-offset-2 hover:decoration-solid',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
              )}
            >
              <span className="min-w-0 truncate">{field.previewValue}</span>
              <Link2 className="size-3.5 shrink-0 stroke-accent" aria-hidden />
            </button>
          ) : (
            <span
              data-testid="rowdetail-value"
              className="font-mono text-sm break-words whitespace-pre-wrap text-fg"
            >
              {field.previewValue}
            </span>
          )}
        </div>

        {hasMore ? (
          <Tooltip content={expanded ? 'Collapse' : 'Show everything'}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              leadingIcon={expanded ? ChevronUp : ChevronDown}
              aria-label={expanded ? `Collapse ${field.name}` : `Expand ${field.name}`}
              aria-expanded={expanded}
              data-testid="rowdetail-expand"
              onClick={onToggleExpand}
            />
          </Tooltip>
        ) : null}
        {followable ? (
          <Tooltip content="Open the referenced row in a new tab">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              leadingIcon={ExternalLink}
              aria-label={`Open the row ${field.name} references in a new tab`}
              data-testid="rowdetail-fk-open"
              onClick={onOpenInTab}
            />
          </Tooltip>
        ) : null}
        <Tooltip content="Copy this value">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            leadingIcon={Copy}
            aria-label={`Copy ${field.name}`}
            data-testid="rowdetail-copy-value"
            onClick={onCopy}
          />
        </Tooltip>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-1" data-testid="rowdetail-expanded">
          {field.isNull ? null : (
            <pre className="max-h-64 overflow-auto rounded-sm bg-canvas p-1.5 font-mono text-sm break-words whitespace-pre-wrap text-fg">
              {field.fullValue}
            </pre>
          )}
          <dl className="flex flex-wrap gap-x-3 font-mono text-2xs tracking-eyebrow text-fg-subtle uppercase">
            {field.nullable === undefined ? null : (
              <div className="flex gap-1">
                <dt>nullable</dt>
                <dd className="text-fg-muted">{field.nullable ? 'yes' : 'no'}</dd>
              </div>
            )}
            {field.defaultValue === undefined || field.defaultValue === '' ? null : (
              <div className="flex min-w-0 gap-1">
                <dt>default</dt>
                <dd className="min-w-0 truncate text-fg-muted">{field.defaultValue}</dd>
              </div>
            )}
            {field.reference === null ? null : (
              <div className="flex min-w-0 gap-1">
                <dt>references</dt>
                <dd className="min-w-0 truncate text-fg-muted">{field.reference}</dd>
              </div>
            )}
          </dl>
        </div>
      ) : null}

      {preview}
    </div>
  );
}

/** A `pk` / `fk` / `id` marker. Mono uppercase 10px, which is what HOUSE-RULES §2 reserves it for. */
function Badge({ children, title }: { readonly children: string; readonly title: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-xs border border-rule-strong px-1 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase"
    >
      {children}
    </span>
  );
}

interface FkPreviewProps {
  readonly target: FkTarget;
  readonly connectionId: string;
  readonly database: string;
  readonly onOpenInTab: () => void;
}

/**
 * The referenced row, fetched on demand.
 *
 * Mounted only while a field's preview is open, so the query's lifetime is the disclosure's — and
 * closing it cancels nothing that matters (a single-row lookup) while re-opening it inside the
 * cache's 30-second staleness window costs no round trip.
 *
 * `query.fetchFkRecord`, not `query.execute` (J-145): the main process builds the statement from
 * the dialect and BINDS the cell value, so nothing on this path interpolates a value into SQL. See
 * the module doc above, and `main/services/sql/fk-record.ts`.
 */
function FkPreview({ target, connectionId, database, onOpenInTab }: FkPreviewProps) {
  const lookup = useIpcQuery({
    namespace: 'query',
    operation: 'fetchFkRecord',
    args: [
      {
        connectionId,
        database,
        schema: target.schema,
        table: target.table,
        column: target.column,
        value: target.value,
      },
    ],
    // Never `args`: the cell value goes in as its display text rather than as itself, because a
    // key is serialised and a Date or a JSON object has no stable serialisation there.
    keyArgs: [
      connectionId,
      database,
      target.schema,
      target.table,
      target.column,
      displayValue(target.value),
    ],
  });

  const record = lookup.data?.record;
  const failure = lookup.error?.message ?? lookup.data?.error;

  return (
    <section
      data-testid="rowdetail-fk-preview"
      aria-label={`Row referenced by ${target.column}`}
      className="mt-1 flex flex-col rounded-sm border border-rule bg-canvas"
    >
      <header className="flex items-center gap-1.5 border-b border-rule px-1.5 py-1">
        <Link2 className="size-3.5 shrink-0 stroke-fg-muted" aria-hidden />
        <p
          data-testid="rowdetail-fk-target"
          className="min-w-0 grow truncate font-mono text-2xs tracking-eyebrow text-fg-muted uppercase"
        >
          {target.schema}.{target.table}
        </p>
        <Tooltip content="Open in a new tab">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            leadingIcon={ExternalLink}
            aria-label="Open the referenced row in a new tab"
            data-testid="rowdetail-fk-preview-open"
            onClick={onOpenInTab}
          />
        </Tooltip>
      </header>

      {lookup.isPending ? (
        <div className="p-2">
          <Spinner size="sm" label="Loading the referenced row…" />
        </div>
      ) : failure !== undefined ? (
        <p
          data-testid="rowdetail-fk-error"
          className="border-l-2 border-danger px-1.5 py-1 font-mono text-sm text-danger"
        >
          {failure}
        </p>
      ) : record === undefined ? (
        <p data-testid="rowdetail-fk-empty" className="px-1.5 py-1 text-sm text-fg-muted">
          No row in {target.table} has {target.column} = {displayValue(target.value)}.
        </p>
      ) : (
        <dl className="flex flex-col p-1.5">
          {(lookup.data?.columns ?? []).map(column => (
            <div key={column.name} className="flex min-w-0 items-baseline gap-2 py-0.5">
              <dt className="flex min-w-0 shrink-0 basis-1/3 items-baseline gap-1 font-mono text-2xs tracking-eyebrow text-fg-subtle uppercase">
                {column.isPrimaryKey === true ? (
                  <KeyRound className="size-3.5 shrink-0 stroke-fg-muted" aria-hidden />
                ) : null}
                <span className="min-w-0 truncate">{column.name}</span>
              </dt>
              <dd
                className={cn(
                  'min-w-0 grow truncate font-mono text-sm',
                  record[column.name] === null || record[column.name] === undefined
                    ? 'text-fg-muted italic'
                    : 'text-fg'
                )}
              >
                {displayValue(record[column.name])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * Opens the referenced row in its own query tab, auto-executing.
 *
 * Exported because it is the whole of what J-46's two cell-context-menu FK items need — this task
 * owns the FK machinery, J-46 owns the menu that has not been built yet, and the seam between them
 * is this function plus `fkTargetFor`. See the Task 14 report.
 */
export function openReferencedRowTab(request: {
  readonly connectionId: string;
  readonly database: string;
  readonly engine: DatabaseEngine;
  readonly target: FkTarget;
}): string {
  const tabId = tabStore
    .getState()
    .openQueryTab(
      request.connectionId,
      request.database,
      fkOpenSql(request.target, request.engine, request.database),
      true,
      false
    );
  tabStore.getState().renameTab(tabId, fkTabTitle(request.target));
  return tabId;
}
