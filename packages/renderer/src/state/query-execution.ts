/**
 * Query execution: which tabs are running something, and what each tab's current result is.
 *
 * This is the store the status bar's **executing** indicator reads, and Task 7 deliberately left that
 * indicator out rather than inventing a second source of truth for it (`shell/status-bar.tsx` header).
 * It is also where Task 11's results grid and Task 14's sub-panels read the current result from, which
 * is why the result lives here and not in the query panel's component state: three surfaces need it,
 * and a Dockview panel's React tree stays mounted while detached, so "the panel owns it" would mean an
 * unreachable owner.
 *
 * Ports `core/services/query-execution.service.ts` (27 LOC — the running-query registry the status bar
 * used) and the execution half of `query.component.ts:1779-1880`. Everything else in that method —
 * the placeholder prompt, the auto-rename, the history refresh — stays in the panel, because it is UI
 * sequencing rather than execution state.
 *
 * ── Keyed by tab, and why the queryId is not the key ────────────────────────────────────────
 *
 * A tab runs at most one query at a time and the UI asks its questions per tab ("is THIS editor
 * busy?", "what is THIS tab showing?"). The `queryId` is what the main process cancels by, so it is
 * carried in the value. The Angular original keyed its registry by tab too, and its `startExecution`
 * filtered out any existing entry for the same tab first — i.e. it already assumed one per tab.
 *
 * ── The stale-result rule, kept ────────────────────────────────────────────────────────────
 *
 * `query.component.ts:1835` drops a result whose `queryId` is no longer the tab's current one, which is
 * what stops a slow first query from overwriting the fast second one's results. That check is here,
 * against the store's own record, so it cannot be forgotten by a caller.
 */

import { create } from 'zustand';
import type { QueryResult } from '@joinery/shared';
import { ipc, isIpcAvailable } from '../ipc';
import { diagnostics, notify } from './diagnostics';

export interface RunningQuery {
  readonly tabId: string;
  readonly tabTitle: string;
  /** What `cancel` sends to the main process. */
  readonly queryId: string;
  readonly startedAt: number;
}

/** What a caller has to know to run something. The panel resolves all of it from its tab. */
export interface ExecuteRequest {
  readonly tabId: string;
  readonly tabTitle: string;
  readonly connectionId: string;
  readonly database: string | undefined;
  readonly sql: string;
  /** `QuerySettings.maxRowsToDisplay` — the executor truncates main-side, before IPC. */
  readonly maxRows: number;
  /**
   * `QuerySettings.defaultTimeout`, in milliseconds — the deadline the main-process executor
   * enforces per engine (J-54). The connection profile's own request timeout still applies, so
   * whichever of the two is shorter is what a query actually gets.
   */
  readonly timeout: number;
}

export interface QueryExecutionState {
  /** One entry per tab with a query in flight. */
  readonly running: ReadonlyMap<string, RunningQuery>;
  /** The current result per tab. Absent means "nothing has run in this tab yet". */
  readonly results: ReadonlyMap<string, QueryResult>;
  /**
   * The SQL that PRODUCED each tab's current result — not the editor's live text.
   *
   * Added by Task 14, which needs it for two things a result set cannot answer on its own: the row
   * inspector resolves the queried table from it to fetch the FK metadata the PostgreSQL and MySQL
   * executors do not attach (`main/.../query-executor.ts:94-125` enriches on the MSSQL path only),
   * and the history panel's "capture this result" writes it into the snapshot.
   *
   * It has to be here rather than read from `getTabContent(tabId)`, because the editor's text drifts
   * from the executed text the moment the user types — and an FK badge derived from a table the user
   * has just finished typing over would offer a link the displayed rows do not have. It moves in
   * lockstep with `results`: written by `execute`, replaced by `setResult`, dropped by `forgetTab`.
   */
  readonly sqlByTab: ReadonlyMap<string, string>;

  /**
   * Runs the SQL and stores the result. Resolves with the result it stored, or `null` when the
   * request was superseded, the bridge is missing, or the tab already had a query in flight that
   * could not be cancelled.
   */
  readonly execute: (request: ExecuteRequest) => Promise<QueryResult | null>;
  /** Cancels the tab's in-flight query, if any. */
  readonly cancel: (tabId: string) => Promise<void>;
  /**
   * Replaces a tab's displayed result — Task 14's "view this historical snapshot" path.
   *
   * `sql` is what produced the replacement (a snapshot's own `sql`), and omitting it FORGETS the
   * tab's recorded SQL rather than leaving the previous run's in place: a result and the statement
   * it came from must never be able to disagree.
   */
  readonly setResult: (tabId: string, result: QueryResult | null, sql?: string) => void;
  /** Forgets a tab's result and any running record. Called when the tab closes. */
  readonly forgetTab: (tabId: string) => void;
}

export type QueryExecutionStore = ReturnType<typeof createQueryExecutionStore>;

/**
 * A monotonic counter behind `nextQueryId`, module-scoped because the ids must be unique across every
 * store instance in the page (the app has one; the tests make several) and a per-store counter would
 * let two of them mint the same id. Nothing else may read it.
 */
let queryIdCounter = 0;

/**
 * `query-<millis>-<n>` — the Angular id format (`:1811`) plus a monotonic suffix.
 *
 * The prefix and the timestamp are kept so main-process logs stay greppable, but `Date.now()` alone is
 * NOT unique: two executes in the same millisecond produce the same id, and this store's supersede rule
 * is `running.get(tabId)?.queryId !== queryId`. Equal ids make that comparison say "still ours" for a
 * request that has in fact been replaced, so the superseded run stores its result over the newer one's
 * and the `finally` clears the newer one's running record. Two executes a millisecond apart is exactly
 * what a double-click on Execute, or an auto-execute racing a keystroke, produces.
 */
function nextQueryId(): string {
  queryIdCounter += 1;
  return `query-${Date.now()}-${queryIdCounter}`;
}

export function createQueryExecutionStore() {
  return create<QueryExecutionState>()((set, get) => {
    /** Replace one key in a Map without touching the other entries' identities. */
    const patchMap = <T>(map: ReadonlyMap<string, T>, key: string, value: T | null) => {
      const next = new Map(map);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    };

    const startRunning = (entry: RunningQuery): void =>
      set(state => ({ running: patchMap(state.running, entry.tabId, entry) }));

    const stopRunning = (tabId: string): void =>
      set(state => ({ running: patchMap(state.running, tabId, null) }));

    return {
      running: new Map(),
      results: new Map(),
      sqlByTab: new Map(),

      execute: async request => {
        if (!isIpcAvailable()) return null;

        // A tab that is already running something: cancel it first, exactly as `:1804-1806` did.
        // Awaited here, unlike the original's fire-and-forget `.catch(() => {})`, so the two queries
        // cannot both be in flight against the same pool — which is what made the stale-result check
        // load-bearing rather than defensive.
        const inFlight = get().running.get(request.tabId);
        if (inFlight !== undefined) await get().cancel(request.tabId);

        const queryId = nextQueryId();
        startRunning({
          tabId: request.tabId,
          tabTitle: request.tabTitle,
          queryId,
          startedAt: Date.now(),
        });
        // Clear the previous result the moment a new run starts: leaving it up means a grid showing
        // last query's rows under a spinner. The recorded SQL goes with it, for the same reason.
        set(state => ({
          results: patchMap(state.results, request.tabId, null),
          sqlByTab: patchMap(state.sqlByTab, request.tabId, null),
        }));

        try {
          const result = await ipc().query.execute({
            connectionId: request.connectionId,
            database: request.database,
            sql: request.sql,
            queryId,
            // Lets the main process persist the result snapshot itself instead of the renderer
            // round-tripping the whole result set back over IPC (`:1826-1828`).
            tabId: request.tabId,
            maxRows: request.maxRows,
            timeout: request.timeout,
          });

          // Superseded: another execute (or a cancel) replaced this tab's record while we waited.
          if (get().running.get(request.tabId)?.queryId !== queryId) return null;

          set(state => ({
            results: patchMap(state.results, request.tabId, result),
            sqlByTab: patchMap(state.sqlByTab, request.tabId, request.sql),
          }));
          return result;
        } catch (error) {
          if (get().running.get(request.tabId)?.queryId !== queryId) return null;
          // A rejected execute is a result too: the panel renders `result.error`, and the Angular
          // version built exactly this shape in its catch (`:1862-1867`).
          const failure: QueryResult = {
            queryId,
            success: false,
            error: error instanceof Error ? error.message : 'Query execution failed',
            executionTime: Date.now() - (get().running.get(request.tabId)?.startedAt ?? Date.now()),
          };
          diagnostics.error('query execution failed', error);
          set(state => ({
            results: patchMap(state.results, request.tabId, failure),
            sqlByTab: patchMap(state.sqlByTab, request.tabId, request.sql),
          }));
          return failure;
        } finally {
          // Only if it is still ours: a superseding execute has already installed its own record and
          // must not be marked finished by the one it replaced.
          if (get().running.get(request.tabId)?.queryId === queryId) stopRunning(request.tabId);
        }
      },

      cancel: async tabId => {
        const entry = get().running.get(tabId);
        if (entry === undefined || !isIpcAvailable()) return;
        // Cleared BEFORE the await: the cancel itself is a round trip, and until it returns the
        // toolbar would otherwise offer Cancel again for a query already being cancelled.
        stopRunning(tabId);
        try {
          await ipc().query.cancel(entry.queryId);
          notify.info('Query cancelled');
        } catch (error) {
          notify.error('Could not cancel the query');
          diagnostics.error('failed to cancel query', error);
        }
      },

      setResult: (tabId, result, sql) =>
        set(state => ({
          results: patchMap(state.results, tabId, result),
          sqlByTab: patchMap(state.sqlByTab, tabId, sql ?? null),
        })),

      forgetTab: tabId =>
        set(state => ({
          running: patchMap(state.running, tabId, null),
          results: patchMap(state.results, tabId, null),
          sqlByTab: patchMap(state.sqlByTab, tabId, null),
        })),
    };
  });
}

export const queryExecutionStore = createQueryExecutionStore();
export const useQueryExecutionStore = queryExecutionStore;

/** Is THIS tab busy? The selector the toolbar and the editor's disabled states use. */
export function selectIsExecuting(tabId: string | undefined) {
  return (state: Pick<QueryExecutionState, 'running'>): boolean =>
    tabId !== undefined && state.running.has(tabId);
}

/** Is anything busy? The status bar's indicator. Ported from `isAnyRunning`. */
export function selectAnyExecuting(state: Pick<QueryExecutionState, 'running'>): boolean {
  return state.running.size > 0;
}

/** How many. Ported from `runningCount` — the status bar shows it once it exceeds one. */
export function selectRunningCount(state: Pick<QueryExecutionState, 'running'>): number {
  return state.running.size;
}

export function selectResultFor(tabId: string | undefined) {
  return (state: Pick<QueryExecutionState, 'results'>): QueryResult | null =>
    tabId === undefined ? null : (state.results.get(tabId) ?? null);
}

/**
 * The statement that produced the tab's current result. A primitive, so a component may subscribe to
 * it directly — the row inspector does, and it must not re-render on every keystroke.
 */
export function selectSqlFor(tabId: string | undefined) {
  return (state: Pick<QueryExecutionState, 'sqlByTab'>): string | null =>
    tabId === undefined ? null : (state.sqlByTab.get(tabId) ?? null);
}
