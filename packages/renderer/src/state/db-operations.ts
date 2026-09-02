/**
 * The window's record of long-running database operations — dumps and restores — that are still
 * going, so a second one over the same database can be refused rather than allowed to corrupt the
 * first.
 *
 * ── Why this is one record shared by two features, and not one per feature ──────────────────
 *
 * Task 12 kept this as module state inside `features/backup/backup-dialogs.tsx`, and its own header
 * said the restore wizard "should reuse this record rather than start a second one: a restore of a
 * database that is mid-dump is the same class of collision." Two separate records could not see each
 * other, so the three collisions that actually lose data would each be missed by one of them:
 *
 *  - **dump + dump** of one database — two `pg_dump` processes interleaving into one archive, both
 *    reporting success (J-48 item f);
 *  - **restore + restore** of one target — `pg_restore --clean` dropping objects a second restore is
 *    still writing, or two `mysql` clients racing the same `DROP DATABASE`/`CREATE DATABASE` prelude;
 *  - **dump + restore** of one database — a dump of a database that is being rewritten underneath it
 *    is a torn archive that looks complete, and a restore over a database that is being read produces
 *    a dump of neither the before nor the after state.
 *
 * So the key is connection + database with **no kind in it**: whatever is running on that database is
 * what the next operation has to wait for. The kind is a field, so the refusal can name it.
 *
 * ── Why the record outlives the dialog ──────────────────────────────────────────────────────
 *
 * Neither operation can be cancelled. `BackupRestoreService.cancel`
 * (`packages/main/src/services/sql/backup-restore.ts:363-369`) sets a flag whose only effect is to
 * stop the progress *poll* — its own comment says so — and both the `BACKUP.CANCEL` and
 * `RESTORE.CANCEL` handlers route every engine there, so it never reaches the PG/MySQL services'
 * own operation maps. Closing the dialog therefore does not stop the work, which is why the record
 * has to survive the close and why the subscriptions that retire an entry live on the always-mounted
 * `BackupDialogs` / `RestoreDialogs` rather than on the wizards.
 *
 * It is a mitigation, not the fix: it only knows about runs this window started, and it dies with the
 * window. The authoritative guard belongs in main, which is what J-48 item f asks for.
 *
 * ── Store conventions ───────────────────────────────────────────────────────────────────────
 *
 * Factory plus singleton, exported selectors rather than fields, clone-on-write — the four rules
 * `state/capabilities.ts` states for every store in this directory. Clone-on-write is what makes
 * `selectLiveRun(key)` a referentially stable snapshot: records are replaced, never mutated, so a
 * subscriber only re-renders when its own run actually changed.
 */

import { create } from 'zustand';

/** Which of the two long-running operations a record describes. */
export type DbOperationKind = 'backup' | 'restore';

/** One operation this window started. Kept after it finishes — see `finished`. */
export interface DbOperationRun {
  readonly kind: DbOperationKind;
  /**
   * The file it is working with: the destination a dump writes, or the archive a restore reads.
   * Carried so the refusal can name it rather than saying only "something is running".
   */
  readonly path: string;
  /** The main process's operation id, once known. `null` until the START reply or the first event. */
  readonly operationId: string | null;
  /**
   * Whether it has reported a terminal event.
   *
   * Finished runs are **kept rather than deleted**, and that is the one non-obvious thing in this
   * file. Two subscribers see each progress event — the open wizard's, which asks `isRunOwnedByAnother`
   * whether the event is somebody else's, and the always-mounted host's, which retires the run — and
   * nothing orders them. If retiring meant deleting, whether an event is recognised as foreign would
   * depend on which subscriber ran first. Keeping the record makes the answer the same either way.
   * They are pruned on insert, so the map cannot grow without bound.
   */
  readonly finished: boolean;
}

/** How many records are kept. Finished ones are dropped oldest-first past this; live ones never are. */
const MAX_RUN_RECORDS = 32;

/**
 * The record's key.
 *
 * Connection + database rather than the file path, because the database is what the user is choosing
 * when they open the dialog and the path is not settled until they have typed it. It is also the
 * stricter of the two: two dumps of one database to two paths are a load problem on the server, where
 * two dumps to one path are a corrupt archive.
 *
 * A restore keys on its **target** database — the one being written — which is what makes a restore
 * into a database that is mid-dump collide with that dump.
 */
export function dbOperationKey(connectionId: string, databaseName: string): string {
  // NUL rather than a printable separator: a database name may contain anything, and `a` + `b c`
  // must not be able to produce the same key as `a b` + `c`.
  return `${connectionId}\u0000${databaseName}`;
}

export interface DbOperationsState {
  readonly runs: ReadonlyMap<string, DbOperationRun>;

  /** This window has just asked the main process to start `kind` against `key`, working on `path`. */
  readonly begin: (key: string, kind: DbOperationKind, path: string) => void;
  /** Bind `key`'s run to the operation id the START reply carried. A no-op once bound. */
  readonly bind: (key: string, operationId: string) => void;
  /**
   * The start call was refused, so there is no run to record — drop the entry `begin` made.
   *
   * Dropped rather than marked finished: there was never a run, so there is no id to recognise, and a
   * refused start that left a record behind would lock that database out of the feature for the rest
   * of the session.
   */
  readonly retire: (key: string) => void;
  /**
   * Fold one progress event into the record: claim an id an unbound run of the same kind can own, and
   * mark the run finished when the event is terminal.
   */
  readonly settle: (kind: DbOperationKind, operationId: string, terminal: boolean) => void;
}

export type DbOperationsStore = ReturnType<typeof createDbOperationsStore>;

/** Insert or replace one record, pruning finished ones so the map stays bounded. */
function withRecord(
  runs: ReadonlyMap<string, DbOperationRun>,
  key: string,
  record: DbOperationRun
): Map<string, DbOperationRun> {
  const next = new Map(runs);
  next.set(key, record);
  // Map iterates in insertion order, so the first finished entry is the oldest one.
  for (const [candidate, existing] of next) {
    if (next.size <= MAX_RUN_RECORDS) break;
    if (existing.finished) next.delete(candidate);
  }
  return next;
}

/**
 * The key of the one live run of `kind` that has no id yet, if there is exactly one.
 *
 * The fallback for a START reply that carried no id: without it a live record could never be retired
 * and its database would be blocked for the rest of the session, which is a worse failure than the one
 * this record exists to prevent. "Exactly one" is the whole condition — with two unbound runs there is
 * no evidence which one an event belongs to, so neither is guessed at.
 *
 * Filtered by kind, which the shared record makes necessary: a dump's progress event must not be able
 * to claim an unbound *restore*, or the restore would spend the rest of its life answering to the
 * wrong id.
 */
function unclaimedRunKey(
  runs: ReadonlyMap<string, DbOperationRun>,
  kind: DbOperationKind,
  operationId: string
): string | null {
  let candidate: string | null = null;
  for (const [key, run] of runs) {
    if (run.operationId === operationId) return null; // already owned
    if (run.finished || run.operationId !== null || run.kind !== kind) continue;
    if (candidate !== null) return null; // ambiguous
    candidate = key;
  }
  return candidate;
}

export function createDbOperationsStore() {
  return create<DbOperationsState>()(set => ({
    runs: new Map(),

    begin: (key, kind, path) =>
      set(state => ({
        runs: withRecord(state.runs, key, { kind, path, operationId: null, finished: false }),
      })),

    bind: (key, operationId) =>
      set(state => {
        const run = state.runs.get(key);
        if (run === undefined || run.operationId !== null) return state;
        return { runs: withRecord(state.runs, key, { ...run, operationId }) };
      }),

    retire: key =>
      set(state => {
        if (!state.runs.has(key)) return state;
        const next = new Map(state.runs);
        next.delete(key);
        return { runs: next };
      }),

    settle: (kind, operationId, terminal) =>
      set(state => {
        const claimed = unclaimedRunKey(state.runs, kind, operationId);
        if (claimed !== null) {
          const run = state.runs.get(claimed);
          if (run !== undefined) {
            return {
              runs: withRecord(state.runs, claimed, { ...run, operationId, finished: terminal }),
            };
          }
        }
        if (!terminal) return state;
        for (const [key, run] of state.runs) {
          if (run.operationId !== operationId || run.finished) continue;
          return { runs: withRecord(state.runs, key, { ...run, finished: true }) };
        }
        return state;
      }),
  }));
}

export const dbOperationsStore = createDbOperationsStore();
export const useDbOperationsStore = dbOperationsStore;

/**
 * The live run for `key`, or `null`. Finished records are history, not a reason to refuse.
 *
 * `key` may be `null` — the state a host is in before a command has named a target — which answers
 * `null` rather than forcing every caller to branch first.
 */
export function selectLiveRun(key: string | null) {
  return (state: DbOperationsState): DbOperationRun | null => {
    if (key === null) return null;
    const run = state.runs.get(key);
    if (run === undefined || run.finished) return null;
    return run;
  };
}

/**
 * True for an id that belongs to a run other than `key`'s.
 *
 * This is the predicate the wizards' progress folding takes as `isForeignRun`: before a run has bound
 * its own id, only events the window can *prove* belong to somebody else are refused, so a stream that
 * reports completion before its first progress line still lands.
 */
export function isRunOwnedByAnother(
  state: DbOperationsState,
  key: string | null,
  operationId: string
): boolean {
  if (key === null) return false;
  for (const [otherKey, run] of state.runs) {
    if (otherKey !== key && run.operationId === operationId) return true;
  }
  return false;
}

/**
 * Drop every record. Store state outlives a test, so a spec that starts a dump would block the next
 * one; this is the only reason it is exported.
 */
export function resetDbOperationsForTests(): void {
  dbOperationsStore.setState({ runs: new Map() });
}
