/**
 * Everything about a restore that has a right answer without a screen: which options each engine
 * actually honours, who creates the target database, when the operation is destructive, the T-SQL the
 * main process will run, and the wizard's phase machine.
 *
 * Pure — no React, no stores, no IPC — for the same reason `backup-model.ts` is: this is where the
 * engine-specific rules live, and they are the part of the dialog worth testing directly. Restore is
 * also the one workflow in the app that can destroy data, so "when is this destructive" is a function
 * with a name and a spec rather than a condition buried in JSX.
 *
 * ── Read against `packages/main`, which this task may not change ────────────────────────────
 *
 * Three engines, three completely different mechanisms, and the option matrix is the intersection of
 * what each one's code path actually reads:
 *
 *  | | how it runs | who creates the target | what "overwrite" does |
 *  | --- | --- | --- | --- |
 *  | **MSSQL** | `RESTORE DATABASE` inside the server (`tsql-builder.ts:149-185`) | the RESTORE itself | `WITH REPLACE` |
 *  | **PostgreSQL** | `pg_restore` on this machine (`backup-args.ts:27-52`) | **Joinery must, first** | `--clean --if-exists` |
 *  | **MySQL** | the `mysql` client on this machine (`mysql-backup.ts:243-262`) | the piped prelude | `DROP DATABASE` then `CREATE` |
 *
 * The PostgreSQL row is the one with teeth. `buildPgRestoreArgs` never passes `--create`, and
 * `pg-backup.ts:166-179` knows it — its post-restore verification exists precisely to catch
 * "pg_restore exited cleanly but the target database was not there". So a PostgreSQL restore into a
 * database that does not exist yet **cannot succeed**, and the Angular dialog offered it anyway: the
 * old e2e spec worked around it by pre-creating the target through the driver, with a comment saying
 * the dialog had no UI for it (`tests/e2e/backup-restore.spec.ts:24-27`). Here Joinery creates it,
 * says so before it does, and reports a creation failure as a failure instead of letting pg_restore
 * report a confusing one thirty seconds later.
 *
 * ── Two Angular controls are dropped, one is replaced ───────────────────────────────────────
 *
 *  1. **"Recovery" was inert.** `withRecovery` was read by nothing, anywhere — unchecking it changed
 *     the preview and nothing else. The two checkboxes are one two-member picker here, which is what
 *     the server actually has, and the dead field was deleted from `RestoreRequest` in J-51b.
 *  2. **STANDBY is not offered**, and can no longer be requested at all. The builder emitted
 *     `STANDBY = N'standby.dat'` — a *relative* path resolved against the server's working
 *     directory, so the undo file landed somewhere nobody could name. J-51c removed the union member
 *     along with the clause; offering it again means taking the path as a field first.
 *  3. **The T-SQL preview said `STATS = 10`; the builder emits `STATS = 5`,** and the preview also
 *     omitted the difference between "no recovery box ticked" and what the server does with that
 *     (it restores `WITH RECOVERY` regardless). A preview whose whole job is SQL transparency
 *     (CLAUDE.md) has to be the statement. `restore-model.spec.ts` pins it clause for clause.
 *
 * Both dropped controls are main-process gaps and are recorded in this task's report rather than
 * reproduced as affordances indistinguishable from working ones (PLAN.md 0.4).
 */

import type {
  BackupLogicalFile,
  DatabaseEngine,
  RestoreProgress,
  ServerDefaultPaths,
} from '@joinery/shared';

import { quoteIdentifier } from '../../shell/sidebar/sql-text';
import type { ProbePhase } from '../backup';
import { fileNameOf, joinServerPath } from '../backup';

/** The form the dialog edits. Total, which is `useFormValues`' stated precondition. */
export interface RestoreFormValues {
  /** The archive to read. A path on the server for MSSQL, on this machine otherwise. */
  readonly backupPath: string;
  /** The database to restore into — existing or not; `targetKind` is what decides which. */
  readonly targetDatabase: string;
  /** `WITH REPLACE` / `--clean --if-exists` / `DROP DATABASE`, depending on the engine. */
  readonly overwrite: boolean;
  /** `WITH NORECOVERY` — MSSQL only, and the only half of Angular's two checkboxes that reached it. */
  readonly noRecovery: boolean;
  /** What the user has typed into the confirmation box. Must equal `targetDatabase` to proceed. */
  readonly confirmation: string;
}

export function defaultRestoreValues(): RestoreFormValues {
  return {
    backupPath: '',
    targetDatabase: '',
    overwrite: false,
    noRecovery: false,
    confirmation: '',
  };
}

/** Whether the archive lives on the **database server** rather than on this machine. */
export function sourceIsServerSide(engine: DatabaseEngine): boolean {
  return engine === 'mssql';
}

/**
 * Who brings the target database into existence.
 *
 * `'restore'` — the restore mechanism does it: SQL Server's `RESTORE DATABASE`, or the
 * `CREATE DATABASE IF NOT EXISTS` prelude `mysql-backup.ts` pipes ahead of the dump.
 *
 * `'joinery'` — nothing in the restore path will, so the wizard has to call `database.create` first.
 * PostgreSQL only, and it is not a preference: `buildPgRestoreArgs` never passes `--create`.
 */
export type TargetCreator = 'restore' | 'joinery';

export function targetCreatedBy(engine: DatabaseEngine): TargetCreator {
  return engine === 'postgresql' ? 'joinery' : 'restore';
}

/** Which controls an engine gets, and what they are called. One record, read by the markup. */
export interface EngineRestoreOptions {
  /** `WITH NORECOVERY`. MSSQL only — the CLI tools have no equivalent. */
  readonly showRecoveryState: boolean;
  /** The MOVE list. MSSQL only: `RESTORE FILELISTONLY` is the only source of logical file names. */
  readonly showRelocations: boolean;
  /** The T-SQL preview and the backup history — both MSSQL-only surfaces. */
  readonly showTsqlPreview: boolean;
  /**
   * `msdb`'s backup history, offered as a source picker. `backup.ipc.ts:125-128` answers `[]` for PG
   * and MySQL because neither keeps the metadata, so asking would render an empty panel.
   */
  readonly showHistory: boolean;
  readonly pathLabel: string;
  readonly pathPlaceholder: string;
  /** Extension used to narrow the file browser and the open dialog's filter. */
  readonly extension: string;
  /** What overwriting actually does on this engine, stated where the checkbox is. */
  readonly overwriteHint: string;
  /** What the archive format is, for the engines that have one worth naming. */
  readonly formatNote: string | null;
}

const ENGINE_OPTIONS: Record<DatabaseEngine, EngineRestoreOptions> = {
  mssql: {
    showRecoveryState: true,
    showRelocations: true,
    showTsqlPreview: true,
    showHistory: true,
    pathLabel: 'Backup file on the server',
    pathPlaceholder: 'C:\\Backups\\sales.bak',
    extension: 'bak',
    overwriteHint:
      'WITH REPLACE. SQL Server refuses to restore over a database that already exists without it.',
    formatNote: null,
  },
  postgresql: {
    showRecoveryState: false,
    showRelocations: false,
    showTsqlPreview: false,
    showHistory: false,
    pathLabel: 'Backup file on this machine',
    pathPlaceholder: '/tmp/sales.dump',
    extension: 'dump',
    overwriteHint:
      'pg_restore --clean --if-exists. Every object the archive contains is dropped from the target before it is recreated.',
    formatNote: 'pg_restore reads the custom-format archive pg_dump writes.',
  },
  mysql: {
    showRecoveryState: false,
    showRelocations: false,
    showTsqlPreview: false,
    showHistory: false,
    pathLabel: 'Backup file on this machine',
    pathPlaceholder: '/tmp/sales.sql',
    extension: 'sql',
    overwriteHint:
      'DROP DATABASE, then CREATE. The whole target database goes, including tables the dump does not contain.',
    formatNote: 'The mysql client replays the plain SQL script mysqldump writes.',
  },
};

export function engineRestoreOptions(engine: DatabaseEngine): EngineRestoreOptions {
  return ENGINE_OPTIONS[engine];
}

// ── The target database ─────────────────────────────────────────────────────────────────────

/**
 * What restoring into `name` would do, decided against the databases the server actually reports.
 *
 * **Derived from the name, never from a mode toggle**, and that is the single most important decision
 * in this file. A wizard that decides "is this destructive" from which radio button is selected has a
 * hole in it the moment a user picks "create a new database" and types a name that already exists —
 * which is exactly what someone restoring yesterday's backup over today's database would type. The
 * name is the only thing that determines what the server will do, so it is the only thing consulted.
 *
 * `'unknown'` is the fail-safe: the database list has not loaded, or the call failed, so Joinery
 * cannot prove the target is new. It is treated as an overwrite, because being asked to confirm a
 * restore into an empty database costs a sentence and the other mistake costs a database.
 *
 * ── The limit, and what each engine does when it is hit ──────────────────────────────────────
 *
 * `databases` was fetched when the dialog opened, so another client creating the target between that
 * fetch and the submit leaves this answering `'create'` for a database that now exists — and the
 * wizard therefore skips the confirmation. Asking main again at submit time would not close it:
 * `MetadataService` caches the database list for 60 seconds (J-51 item d). So the window is real, and
 * what happens inside it is **not** the same on all three engines:
 *
 *  - **PostgreSQL fails safe.** The plan says `createsTarget`, so `database.create` runs first and
 *    answers `{ success: false }` for a name that is already taken (`database.ipc.ts:43-50`). The
 *    dialog reports that as a failure and **no restore is attempted**; nothing is written.
 *  - **MSSQL fails safe.** `createsTarget` is never set, and `RESTORE DATABASE` without `WITH REPLACE`
 *    is refused by the server for an existing database. `restoreProblem` also blocks the submit as
 *    soon as the list says the name exists, so the only way through is with the list stale — and then
 *    the server is the one that says no.
 *  - **MySQL does NOT.** `mysql-backup.ts:243-262` pipes `CREATE DATABASE IF NOT EXISTS` ahead of the
 *    dump, so a target that appeared during the window is simply written into — the dump's statements
 *    replay over whatever is already in it, **with no confirmation ever shown**. Closing this needs
 *    an atomic answer from `packages/main` (a create-or-fail, or a "does this exist" read that is not
 *    cached), which is why it is stated here rather than papered over: this file cannot make the
 *    renderer's snapshot atomic.
 */
export type TargetKind = 'create' | 'overwrite' | 'unknown';

export function targetKindFor(name: string, databases: readonly string[] | null): TargetKind {
  const trimmed = name.trim();
  if (trimmed === '') return 'unknown';
  if (databases === null) return 'unknown';
  return databases.includes(trimmed) ? 'overwrite' : 'create';
}

/** Whether reaching `restore.start` requires the user to have typed the target name out. */
export function confirmationRequired(kind: TargetKind): boolean {
  return kind !== 'create';
}

/**
 * Whether the typed confirmation matches the name of the database that is about to be overwritten.
 *
 * Exact, including case, and deliberately not "close enough": PostgreSQL identifiers are
 * case-sensitive, MySQL's are case-sensitive on some filesystems and not others, and SQL Server's
 * depend on the server collation. A confirmation that accepted `SALES` for `sales` would be teaching
 * the user that the two are the same name, on the one screen where that could be false.
 *
 * **`target` is the name from the frozen `RestorePlan`, never the live form field**, and the parameter
 * is spelled out rather than read off `RestoreFormValues` so it cannot accidentally be the other one.
 * The dialog has three call sites — the button's `disabled`, the Enter handler in the box, and the
 * belt-and-braces re-check inside `runPlan` — and if any of them compared against a different name
 * from the others, the destructive gate would have a seam in it. One predicate, one name.
 */
export function confirmationSatisfied(typed: string, target: string, kind: TargetKind): boolean {
  if (!confirmationRequired(kind)) return true;
  const expected = target.trim();
  return expected !== '' && typed === expected;
}

/**
 * A MySQL target name `mysql-backup.ts:163-167` will refuse, as the reason it refuses it — or `null`.
 *
 * Checked here rather than left to the rejection, because the rejection arrives as a thrown string
 * from a channel typed `Promise<void>` and the user has by then already worked through a confirmation
 * step. The rule is the main process's, quoted: letters, digits and underscores.
 */
export function targetNameProblem(name: string, engine: DatabaseEngine): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (engine !== 'mysql') return null;
  if (/^[A-Za-z0-9_]+$/.test(trimmed)) return null;
  return `MySQL restores can only target a name made of letters, digits and underscores — “${trimmed}” has something else in it.`;
}

/**
 * A target name suggested from the archive's own file name.
 *
 * `<stem>` with any Joinery backup stamp trimmed off, so `sales_2026-08-16T09-12-04.dump` suggests
 * `sales` rather than a name nobody would choose. Restoring onto the same name is the *destructive*
 * case, which the confirmation then covers — this is a starting point, not a recommendation.
 */
export function suggestedTargetName(backupPath: string): string {
  const leaf = fileNameOf(backupPath.trim());
  if (leaf === '') return '';
  const stem = leaf.replace(/\.[^./\\]+$/, '');
  // `fileStamp` writes `2026-08-16T09-12-04`; strip it and the separator before it.
  return stem.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/, '');
}

// ── MSSQL file relocation ───────────────────────────────────────────────────────────────────

/** One `MOVE N'logical' TO N'physical'`, as the form edits it. */
export interface Relocation {
  readonly logicalName: string;
  /** `D` data or `L` log, which is what decides the default directory and the extension. */
  readonly fileType: 'D' | 'L';
  /** Where the file was when the backup was taken. Shown, never sent. */
  readonly originalPath: string;
  /** Where it should go. Sent as a MOVE when it differs from `originalPath`. */
  readonly newPath: string;
}

/**
 * Default relocations for one backup, aimed at the server's own data and log directories.
 *
 * The Angular dialog defaulted every path to the file's **original** physical name, which makes the
 * common case fail: restoring `sales.bak` into a new database `sales_copy` on the same server tries
 * to write `sales.mdf`, which the live `sales` database still has open, and SQL Server answers
 * "The file … cannot be overwritten. It is being used by database 'sales'." Naming the files after
 * the *target* database in the server's default directories is the only default that works for both
 * the copy case and the same-name case.
 */
export function suggestedRelocations(
  files: readonly BackupLogicalFile[],
  targetDatabase: string,
  defaults: ServerDefaultPaths | undefined
): Relocation[] {
  return files.map(file => {
    const fileType = file.fileType === 'L' || file.type === 'L' ? 'L' : 'D';
    const directory = (fileType === 'L' ? defaults?.logPath : defaults?.dataPath) ?? '';
    const leaf = `${sanitizeFileStem(targetDatabase)}_${sanitizeFileStem(file.logicalName)}.${fileType === 'L' ? 'ldf' : 'mdf'}`;
    return {
      logicalName: file.logicalName,
      fileType,
      originalPath: file.physicalName,
      newPath: directory === '' ? file.physicalName : joinServerPath(directory, leaf),
    };
  });
}

/** Everything a filesystem would object to, as an underscore. Bounded, and never empty. */
function sanitizeFileStem(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  return cleaned === '' ? 'restored' : cleaned.slice(0, 64);
}

/**
 * The relocations that are worth sending: the ones that actually move a file.
 *
 * `backup-restore.ts:256-261` maps every relocation it is given into a `MOVE`, so sending the
 * unchanged ones would emit a `MOVE` to the path the file is already at — legal, but noise in a
 * statement the user is being shown for transparency.
 */
export function changedRelocations(relocations: readonly Relocation[]): Relocation[] {
  return relocations.filter(r => r.newPath.trim() !== '' && r.newPath !== r.originalPath);
}

// ── The statement ───────────────────────────────────────────────────────────────────────────

/**
 * The T-SQL `packages/main` will actually run for this form.
 *
 * A transcription of `TsqlBuilder.restore` (`packages/main/src/utils/tsql-builder.ts:149-185`),
 * including the `STATS = 5` the user never chose and the `RECOVERY` the builder emits whether or not
 * anything was ticked. Duplication rather than an import, because the renderer may not import from
 * `packages/main`.
 *
 * **What the spec around this actually guards, precisely:** `restore-model.spec.ts` pins *this
 * function's* output — the clauses, their order, the quoting and the escaping — against the strings
 * that were read out of `tsql-builder.ts:149-185` when this was written. So an edit to this file that
 * changes the preview fails a test. **Nothing here detects a change to `tsql-builder.ts` itself**:
 * the spec has no access to that file, does not import it, and derives nothing from it. If the main
 * process starts emitting `STATS = 10`, or drops the implicit `RECOVERY`, this preview goes quietly
 * wrong and the suite stays green until somebody re-reads both files. A real drift alarm would need a
 * test that imports the builder (or a fixture generated from it), which this task may not add —
 * `packages/main` and the shared package are out of scope. Recorded in the task report as such.
 */
export function restoreTsql(values: RestoreFormValues, relocations: readonly Relocation[]): string {
  const target = values.targetDatabase.trim();
  const name = quoteIdentifier(target === '' ? '<database>' : target, 'mssql');
  const path = escapeSqlString(
    values.backupPath.trim() === '' ? '<path>' : values.backupPath.trim()
  );

  const withOptions: string[] = [];
  for (const move of changedRelocations(relocations)) {
    withOptions.push(
      `MOVE N'${escapeSqlString(move.logicalName)}' TO N'${escapeSqlString(move.newPath)}'`
    );
  }
  if (values.overwrite) withOptions.push('REPLACE');
  withOptions.push(values.noRecovery ? 'NORECOVERY' : 'RECOVERY');
  withOptions.push('STATS = 5');

  return `RESTORE DATABASE ${name}\nFROM DISK = N'${path}'\nWITH\n    ${withOptions.join(',\n    ')};`;
}

/** `TsqlBuilder.escapeString` — doubling is the only escape a T-SQL literal needs. */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

// ── What the user is about to do ────────────────────────────────────────────────────────────

/**
 * The decision, frozen at the moment the user leaves the form.
 *
 * Captured rather than re-read from the form afterwards, so the confirmation names what will happen,
 * the progress names what is happening, and the terminal state names what happened — even if the
 * form behind them is edited or the database list refreshes underneath.
 */
export interface RestorePlan {
  readonly backupPath: string;
  readonly targetDatabase: string;
  readonly kind: TargetKind;
  readonly overwrite: boolean;
  readonly noRecovery: boolean;
  readonly relocations: readonly Relocation[];
  /** Whether Joinery must create the target itself before the restore runs. See `targetCreatedBy`. */
  readonly createsTarget: boolean;
}

export function planFor(
  values: RestoreFormValues,
  engine: DatabaseEngine,
  kind: TargetKind,
  relocations: readonly Relocation[]
): RestorePlan {
  const options = engineRestoreOptions(engine);
  return {
    backupPath: values.backupPath.trim(),
    targetDatabase: values.targetDatabase.trim(),
    kind,
    // Every engine honours overwrite; only its mechanism differs (`overwriteHint`).
    overwrite: values.overwrite,
    // The rest are dropped for the engines whose controls are hidden, so a value left over from a
    // different engine cannot ride along in the request.
    noRecovery: options.showRecoveryState ? values.noRecovery : false,
    relocations: options.showRelocations ? changedRelocations(relocations) : [],
    // Only when Joinery can prove the target is new. An existing one is already there to write into,
    // and `'unknown'` — the database list did not load — must not turn into a CREATE that fails on a
    // name that was there all along: `pg-backup.ts:166-179` already reports a missing target clearly,
    // so the honest move is to let the restore say so rather than to guess and create.
    createsTarget: targetCreatedBy(engine) === 'joinery' && kind === 'create',
  };
}

/**
 * The first reason this form cannot be submitted, or `null`.
 *
 * Ordered so the user is told about the thing they would hit first. The confirmation is **not** in
 * here: it gates a separate phase rather than the form, so that there is no expression in this
 * codebase of "started a destructive restore straight from the options screen".
 */
export function restoreProblem(
  values: RestoreFormValues,
  engine: DatabaseEngine,
  kind: TargetKind,
  canCreateDatabases: boolean
): string | null {
  if (values.backupPath.trim() === '') return 'Choose the backup file to restore from.';

  const target = values.targetDatabase.trim();
  if (target === '') return 'Name the database to restore into.';

  const nameProblem = targetNameProblem(target, engine);
  if (nameProblem !== null) return nameProblem;

  if (kind !== 'overwrite' && targetCreatedBy(engine) === 'joinery' && !canCreateDatabases) {
    return `pg_restore cannot create a database, and this connection is not allowed to either. Restore into a database that already exists.`;
  }

  if (kind === 'overwrite' && engine === 'mssql' && !values.overwrite) {
    return `${target} already exists. SQL Server will refuse the restore unless you turn on Overwrite.`;
  }

  return null;
}

// ── The wizard's phases ─────────────────────────────────────────────────────────────────────
//
// The union is what makes the illegal states inexpressible, and there is one here that matters more
// than any of `backup-model.ts`'s: **`options` and `running` cannot both be true, and neither can be
// reached from the other without passing through `confirming` when the target already exists.** The
// Angular dialog held `restoring`, `progress`, `checkingTools` and `showMissingTools` as four
// independent signals with no confirmation step at all, so a double-click on Start Restore sent two
// RESTOREs.

export type RestorePhase =
  /** The three the tools probe implies, shared with the backup wizard. */
  | ProbePhase
  /**
   * The point of no return, and the only phase `restore.start` can be reached from.
   *
   * A phase rather than a section inside the form, so the options screen has no button that can
   * destroy anything: its primary reads "Review the restore" and lands here.
   */
  | { readonly kind: 'confirming'; readonly plan: RestorePlan }
  /** Joinery is creating the target database, because pg_restore will not. */
  | { readonly kind: 'preparing'; readonly plan: RestorePlan }
  /**
   * The restore is in flight.
   *
   * `restoreId` is learned rather than generated: every engine mints its own id and the START reply
   * is the earliest honest source (`bindRestoreRunId`), with the first progress event as the
   * fallback. `null` is the window in between, which `applyRestoreProgress` guards with the caller's
   * in-flight record.
   */
  | {
      readonly kind: 'running';
      readonly plan: RestorePlan;
      readonly restoreId: string | null;
      readonly progress: RestoreProgress | null;
    }
  | { readonly kind: 'done'; readonly plan: RestorePlan; readonly elapsedMs?: number }
  /**
   * Failed, or cancelled by something outside this dialog. Recoverable — back to `options`.
   *
   * `leftoverDatabase` names a database **Joinery created** on the way to a restore that then failed:
   * an empty database, still on the server, that the user asked for only as a side effect of asking
   * for a restore. PostgreSQL is the only engine that reaches it (`targetCreatedBy`), and only once
   * the CREATE has succeeded — a creation that failed leaves nothing behind and sets nothing here.
   */
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly leftoverDatabase?: string;
    };

/**
 * A failure that also discloses the database Joinery created for it.
 *
 * Not cosmetic. `runPlan` creates the target *before* `pg_restore` runs, so a failed PostgreSQL
 * restore into a new database leaves an empty database behind. Left unsaid, that has two costs: the
 * user is not told about a database they now own, and the retry silently changes character — the
 * target now exists, so `targetKindFor` calls it an overwrite and the wizard demands the typed-name
 * confirmation for a database Joinery itself had just made, which is exactly how a confirmation stops
 * meaning anything.
 */
function failedAfter(plan: RestorePlan, message: string): RestorePhase {
  return {
    kind: 'failed',
    message,
    ...(plan.createsTarget ? { leftoverDatabase: plan.targetDatabase } : {}),
  };
}

/**
 * The operation id on a restore progress event, whatever the engine called it.
 *
 * This is not defensive coding, it is the actual shape of the channel. `RestoreProgress` declares
 * `restoreId` as required, and **two of the three engines never set it**: `pg-backup.ts:289-303` and
 * `mysql-backup.ts:407-421` build one object for both channels and populate `backupId` and
 * `operationId`, casting it to `BackupProgress | RestoreProgress` — which compiles, because the
 * `BackupProgress` arm of that union is satisfied. Only `backup-restore.ts` (MSSQL) sends `restoreId`.
 *
 * A guard that read `progress.restoreId` alone therefore compared `undefined` against a bound id on
 * PostgreSQL and MySQL and discarded every event, leaving the dialog spinning through a restore that
 * had already finished.
 *
 * **Fixed in J-51a**: every engine now builds its event through `operationProgressEvent`, which keys
 * a restore event with `restoreId`. The `operationId` fallback stays — it is a declared alias on the
 * type, and a reader that survives both spellings costs one `??`. The `backupId` fallback is gone
 * with the bug that needed it.
 */
export function restoreOperationId(progress: RestoreProgress): string | null {
  return progress.restoreId ?? progress.operationId ?? null;
}

/**
 * Bind a running phase to the operation id `restore.start` answered with, once.
 *
 * `restore.start` resolves with the operation id and is declared as doing so (J-51f/J-48h; it was
 * `Promise<void>` while every handler returned a string). A no-op unless the phase
 * is still running and still unbound: an event that got there first came from the operation that is
 * actually reporting, which is the better answer.
 */
export function bindRestoreRunId(phase: RestorePhase, restoreId: string): RestorePhase {
  if (phase.kind !== 'running') return phase;
  if (phase.restoreId !== null) return phase;
  return { ...phase, restoreId };
}

/**
 * Fold one `restore.onProgress` event into the phase.
 *
 * Same three rules as `applyProgress`: events that arrive while nothing of ours is running are
 * ignored, the returned phase is the **same object** when nothing changed so the caller's
 * unconditional `setState` costs no render, and before the id is bound only events the window can
 * *prove* belong to another run are refused — an unknown id is still ours, which is what keeps a
 * stream that reports completion before its first progress line from hanging the dialog.
 */
export function applyRestoreProgress(
  phase: RestorePhase,
  progress: RestoreProgress,
  isForeignRun: (operationId: string) => boolean = () => false
): RestorePhase {
  if (phase.kind !== 'running') return phase;

  const eventId = restoreOperationId(progress);
  if (phase.restoreId !== null) {
    if (eventId !== phase.restoreId) return phase;
  } else if (eventId !== null && isForeignRun(eventId)) {
    return phase;
  }

  if (progress.status === 'completed') {
    return { kind: 'done', plan: phase.plan, ...(elapsed(progress) ?? {}) };
  }
  if (progress.status === 'failed') {
    return failedAfter(phase.plan, progress.error ?? 'The restore failed.');
  }
  if (progress.status === 'cancelled') {
    return failedAfter(phase.plan, 'The restore was cancelled.');
  }
  return { kind: 'running', plan: phase.plan, restoreId: eventId ?? phase.restoreId, progress };
}

function elapsed(progress: RestoreProgress): { elapsedMs: number } | null {
  return progress.elapsedMs === undefined ? null : { elapsedMs: progress.elapsedMs };
}

/**
 * The phase line under the bar. Never empty — a bar with no caption says nothing.
 *
 * The backup wizard's `progressLabel` is not reused because its two fallbacks name a backup; the
 * percentage helper (`progressPercent`) is, because a percentage has no wording in it.
 */
export function restoreProgressLabel(progress: RestoreProgress | null): string {
  if (progress === null) return 'Starting the restore…';
  const phase = progress.currentPhase;
  if (phase !== undefined && phase.trim() !== '') return phase;
  return progress.status === 'starting' ? 'Starting the restore…' : 'Restoring…';
}
