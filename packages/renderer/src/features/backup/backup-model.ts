/**
 * Everything about a backup that has a right answer without a screen: which options the engine
 * actually honours, what the destination path should default to, the T-SQL the main process will
 * run, and the wizard's phase machine.
 *
 * Pure — no React, no stores, no IPC — because this is where the engine-specific rules live and
 * they are the part of the dialog worth testing directly. `backup-dialog.tsx` is then markup, four
 * handlers and one subscription.
 *
 * ── Why the option matrix is smaller than Angular's ─────────────────────────────────────────
 *
 * `shared/components/backup-dialog/backup-dialog.component.ts` offered nine controls. Six of them
 * reach the engine; **three did nothing at all**, and one more silently did the wrong thing. Read
 * against `packages/main/src/services/sql/` — which this task may not change — the facts are:
 *
 *  1. **PG/MySQL "Dump Format" was inert.** `pg-backup.ts` hard-coded `-F c` and
 *     `mysql-backup.ts` never read `backupType`, so all three PostgreSQL options and the single
 *     MySQL one produced byte-identical dumps. Here the format is stated as a fact
 *     (`formatNote`), not offered as a choice. **Closed in J-48d**: the choice is gone from the
 *     types too — the format each engine writes lives in `backup-args.ts`
 *     (`buildPgDumpArgs`, `buildMysqlDumpArgs`), those services take a `CliBackupRequest` with no
 *     `backupType` on it, and this dialog omits the field rather than sending a placeholder.
 *  2. **MSSQL "Copy-Only" was inert**, and **3. "Checksum" was inert** — `copyOnly` was read by
 *     nothing anywhere, and `checksum` arrived at the builder as a `verify` it never read. Both
 *     are wired now (J-48b, J-48c), so the fields work for any caller of `backup.start`; the two
 *     checkboxes are still absent from this form, which is a UI decision rather than a lie.
 *  4. **MSSQL "Transaction Log Backup" ran a FULL backup.** `backupType: 'log'` fell through both
 *     arms of the builder's type branch and picked up `INIT`, so it emitted
 *     `BACKUP DATABASE … WITH INIT` — a full backup *overwriting* the destination — under a label
 *     promising a log backup. **Fixed in J-48a**: the builder now emits `BACKUP LOG … WITH NOINIT`,
 *     which appends rather than discarding the chain, so the option is offered again below.
 *
 * All four are closed. Reproducing a control before its engine gap was closed would have
 * reproduced exactly the class of bug PLAN.md 0.4 exists to kill: an affordance
 * indistinguishable from a working one.
 */

import type {
  BackupProgress,
  BackupType,
  CliDepsResult,
  CliEngine,
  DatabaseEngine,
} from '@joinery/shared';

import { quoteIdentifier } from '../../shell/sidebar/sql-text';

/** The form the dialog edits. Total, which is `useFormValues`' stated precondition. */
export interface BackupFormValues {
  readonly backupType: BackupType;
  readonly backupPath: string;
  readonly description: string;
  readonly compression: boolean;
}

/**
 * The engine whose host CLI tools have to be present, or `null` when the server does the work
 * itself.
 *
 * MSSQL runs `BACKUP DATABASE` inside the server, so there is nothing on this machine to probe and
 * the deps check is skipped entirely — `CliEngine` is `'postgresql' | 'mysql'` for that reason.
 */
export function cliEngineFor(engine: DatabaseEngine): CliEngine | null {
  return engine === 'mssql' ? null : engine;
}

/**
 * Whether the destination path names a location on the **database server** rather than on this
 * machine.
 *
 * This is the one distinction the whole destination affordance turns on. `BACKUP DATABASE TO DISK`
 * writes with the SQL Server service account on the server's own filesystem, so the path is picked
 * with the server file browser; `pg_dump -f` and `mysqldump >` run here, so it is picked with the
 * native save dialog. Gated on the engine rather than on a capability flag because
 * `EngineCapabilities` has no member for it — the main-process guard is
 * `server-fs.ipc.ts:assertServerFileBrowsing`, which reads the dialect.
 */
export function destinationIsServerSide(engine: DatabaseEngine): boolean {
  return engine === 'mssql';
}

/**
 * The three backup types that reach the T-SQL. SQL Server's picker only; see gap 4 in the header
 * for why `'log'` was withheld until J-48a, and gap 1 for why the other engines get no picker.
 */
export const BACKUP_TYPES: readonly { readonly value: BackupType; readonly label: string }[] = [
  { value: 'full', label: 'Full backup' },
  { value: 'differential', label: 'Differential backup' },
  // Back only since J-48a. Before that this label promised a log backup and ran a full one that
  // overwrote the destination file.
  { value: 'log', label: 'Transaction log backup' },
];

/** Which controls an engine gets, and what they are called. One record, read by the markup. */
export interface EngineBackupOptions {
  /** The backup-type picker. MSSQL only — the other two engines have one dump format each. */
  readonly showBackupType: boolean;
  /** `WITH COMPRESSION`. MSSQL only; the CLI dumps compress by format, not by flag. */
  readonly showCompression: boolean;
  /** `WITH DESCRIPTION = N'…'`, which only the MSSQL backup header carries. */
  readonly showDescription: boolean;
  /** The T-SQL preview, and the backup history — both MSSQL-only surfaces. */
  readonly showTsqlPreview: boolean;
  /**
   * The backup history list. `backup.ipc.ts:125-128` returns `[]` for PG and MySQL because
   * neither keeps backup metadata in a system table, so asking would render an empty panel.
   */
  readonly showHistory: boolean;
  readonly pathLabel: string;
  readonly pathPlaceholder: string;
  /** Extension used for the suggested file name and the save dialog's filter. */
  readonly extension: string;
  /** What the format IS, stated once, for the engines that offer no choice of it. */
  readonly formatNote: string | null;
}

const ENGINE_OPTIONS: Record<DatabaseEngine, EngineBackupOptions> = {
  mssql: {
    showBackupType: true,
    showCompression: true,
    showDescription: true,
    showTsqlPreview: true,
    showHistory: true,
    pathLabel: 'Backup path on the server',
    pathPlaceholder: 'C:\\Backups\\sales.bak',
    extension: 'bak',
    formatNote: null,
  },
  postgresql: {
    showBackupType: false,
    showCompression: false,
    showDescription: false,
    showTsqlPreview: false,
    showHistory: false,
    pathLabel: 'Backup file on this machine',
    pathPlaceholder: '/tmp/sales.dump',
    extension: 'dump',
    formatNote:
      'pg_dump writes a compressed custom-format archive. Restore it with Joinery, or with pg_restore.',
  },
  mysql: {
    showBackupType: false,
    showCompression: false,
    showDescription: false,
    showTsqlPreview: false,
    showHistory: false,
    pathLabel: 'Backup file on this machine',
    pathPlaceholder: '/tmp/sales.sql',
    extension: 'sql',
    formatNote:
      'mysqldump writes a plain SQL script. Restore it with Joinery, or with the mysql client.',
  },
};

export function engineBackupOptions(engine: DatabaseEngine): EngineBackupOptions {
  return ENGINE_OPTIONS[engine];
}

/** An empty form for one engine. `compression` defaults on, as the Angular dialog did. */
export function defaultBackupValues(engine: DatabaseEngine): BackupFormValues {
  return {
    backupType: 'full',
    backupPath: '',
    description: '',
    compression: destinationIsServerSide(engine),
  };
}

/**
 * A filesystem-safe stamp — `2026-08-16T14-32-05` — from a `Date`.
 *
 * Colons are illegal in a Windows path and awkward in a shell argument, so the ISO form is rewritten
 * rather than trimmed to the date: two backups of one database on one day must not collide, and the
 * MSSQL path is written `WITH INIT`, which overwrites.
 */
export function fileStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** `<database>_<stamp>.<ext>` — the leaf name both destination pickers start from. */
export function suggestedFileName(databaseName: string, engine: DatabaseEngine, now: Date): string {
  return `${databaseName}_${fileStamp(now)}.${engineBackupOptions(engine).extension}`;
}

/**
 * The T-SQL `packages/main` will actually run for this form.
 *
 * A transcription of `TsqlBuilder.backup` (`packages/main/src/utils/tsql-builder.ts:131-168`),
 * including the two options the user never chose — `INIT`, which is why a repeated path overwrites
 * rather than appends, and `STATS = 5`, which is what makes the server's percentage progress
 * arrive at all. The Angular preview omitted both and invented `COPY_ONLY`/`CHECKSUM` clauses the
 * server never received, so it described a statement that was never executed. A preview whose whole
 * job is "SQL transparency" (CLAUDE.md) has to be the statement or it is worse than nothing.
 *
 * Duplication rather than an import: the builder lives in `packages/main`, which the renderer may
 * not import from. Two tests hold the copies together, and it is worth knowing which does what:
 *
 *  - `backup-model.spec.ts` pins *this* function's clauses, so an edit here that changes the
 *    preview fails a test;
 *  - `../tsql-preview-drift.spec.ts` compares its output against
 *    `tests/fixtures/tsql-preview/mssql-statements.sql`, which is **generated from the main
 *    process's own builder** by `packages/main/src/services/sql/mssql-preview-fixture.spec.ts`.
 *    That is what catches a change on the far side of the IPC boundary — before J-112 nothing did,
 *    and a builder change falsified this preview with the suite green.
 */
export function backupTsql(values: BackupFormValues, databaseName: string): string {
  const name = quoteIdentifier(databaseName, 'mssql');
  const path = escapeSqlString(values.backupPath === '' ? '<path>' : values.backupPath);

  const isLog = values.backupType === 'log';

  const withOptions: string[] = [];
  if (values.backupType === 'differential') withOptions.push('DIFFERENTIAL');
  // `NOINIT` for a log backup: it appends to the file instead of discarding the chain already in
  // it. Transcribed from `TsqlBuilder.backup`, which is the statement main actually runs.
  withOptions.push(isLog ? 'NOINIT' : 'INIT');
  if (values.compression) withOptions.push('COMPRESSION');
  if (values.description !== '') {
    withOptions.push(`DESCRIPTION = N'${escapeSqlString(values.description)}'`);
  }
  withOptions.push('STATS = 5');

  const verb = isLog ? 'BACKUP LOG' : 'BACKUP DATABASE';
  return `${verb} ${name}\nTO DISK = N'${path}'\nWITH ${withOptions.join(', ')};`;
}

/** `TsqlBuilder.escapeString` — doubling is the only escape a T-SQL literal needs. */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Human byte size. Ported from the Angular dialog's `formatBytes`, minus its `sizes[i]` gap. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // Clamped, so a size beyond petabytes reads as a large PB rather than as `undefined`.
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / Math.pow(1024, exponent);
  return `${Number.parseFloat(scaled.toFixed(1))} ${units[exponent]}`;
}

// ── The wizard's phases ─────────────────────────────────────────────────────────────────────
//
// Six states, one of which is on screen at a time, and the union is what makes "the form is up AND
// a backup is running" inexpressible. The Angular dialog spread the same information over four
// independent signals (`checkingTools`, `showMissingTools`, `backing`, `progress`) plus a computed,
// so the illegal combinations were all reachable — and one of them was reached: a failed backup
// left `backing` false with a stale `progress` and no visible statement of the failure, because the
// failure went to a toast that a modal makes inert (J-42).

/**
 * The three phases the **probe alone** implies — i.e. everything before the user has done anything.
 *
 * A type of its own, and not only for tidiness: the restore wizard's phase union has a different
 * `running`/`done` (it names a target database, not a file it wrote) but exactly these three openings,
 * because the tools probe is the same call for the same reason on both. Naming the shared part is what
 * lets `derivePhase` and `phaseForToolsResult` serve both wizards without either one owning a copy.
 */
export type ProbePhase =
  /** The host-tool probe is out. PG/MySQL only; MSSQL skips straight to `options`. */
  | { readonly kind: 'checking' }
  /** The probe came back short. Carries the whole result so the view can name what is missing. */
  | { readonly kind: 'tools-missing'; readonly result: CliDepsResult }
  /** The form. */
  | { readonly kind: 'options' };

export type BackupPhase =
  | ProbePhase
  /**
   * A backup is in flight.
   *
   * `backupId` is learned rather than generated here: PG/MySQL mint their own uuid regardless of
   * `BackupRequest.backupId` (`pg-backup.ts:47`), so the main process is the only honest source. It is
   * bound from the START reply where that reply carries it (`bindRunId`) and from the first progress
   * event otherwise — `null` is the window in between, which `applyProgress` guards with the caller's
   * in-flight record.
   *
   * `path` is captured at start rather than read from the form when the run finishes, so the
   * terminal state names the file that was actually written even if the form is later reset.
   */
  | {
      readonly kind: 'running';
      readonly path: string;
      readonly backupId: string | null;
      readonly progress: BackupProgress | null;
    }
  /** Finished. The path is carried so the terminal state can name the file it wrote. */
  | { readonly kind: 'done'; readonly path: string; readonly elapsedMs?: number }
  /** Failed, or cancelled by something outside this dialog. Recoverable — back to `options`. */
  | { readonly kind: 'failed'; readonly message: string };

/** What a completed probe means. `allAvailable` with no instructions is still a pass. */
export function phaseForToolsResult(result: CliDepsResult): ProbePhase {
  return result.allAvailable ? { kind: 'options' } : { kind: 'tools-missing', result };
}

/** What the dialog knows about the host-tool probe, as the query layer reports it. */
export interface ToolsProbe {
  readonly result: CliDepsResult | undefined;
  /** The probe call itself rejected — which is not the same as "the tools are missing". */
  readonly failed: boolean;
}

/**
 * The phase implied by the engine and the probe alone — i.e. the phase before the user has done
 * anything.
 *
 * Derived rather than stored, and that is not a style preference: `react-hooks/set-state-in-effect`
 * is an **error** in this package, so folding a resolving query into a `useState` inside a
 * `useEffect` does not compile. Deriving it also removes the two illegal states that shape allowed —
 * "the probe came back but we are still showing the spinner", and "a refetch dragged a running backup
 * back to the form".
 *
 * The dialog then holds only the phases a *user action* produces (`running`, `done`, `failed`, and the
 * `options` a successful re-check or a retry moves to), and falls back to this when it holds none.
 *
 * A **failed probe opens the form.** Failing to ask is not the same as being told no: the tools may
 * well be there, and the backup is the user's to attempt. The reason is stated above the button.
 */
export function derivePhase(engine: DatabaseEngine, probe: ToolsProbe): ProbePhase {
  if (cliEngineFor(engine) === null) return { kind: 'options' };
  if (probe.failed) return { kind: 'options' };
  if (probe.result === undefined) return { kind: 'checking' };
  return phaseForToolsResult(probe.result);
}

/**
 * Bind a running phase to the operation id `backup.start` answered with, once.
 *
 * The id is bound as early as it can be — from the START reply rather than from the first progress
 * event — so the identity check in `applyProgress` is armed from the first tick instead of only after
 * an event has already been adopted. `backup.start` is typed `Promise<void>` in preload while the main
 * handler returns the id (`backup.ipc.ts:49`), so the caller has to recover it at runtime; that
 * mistyping is J-48 item h.
 *
 * A no-op unless the phase is still running and still unbound: an event that got there first is the
 * better answer, because it came from the operation that is actually reporting.
 */
export function bindRunId(phase: BackupPhase, backupId: string): BackupPhase {
  if (phase.kind !== 'running') return phase;
  if (phase.backupId !== null) return phase;
  return { ...phase, backupId };
}

/**
 * Fold one `backup.onProgress` event into the phase.
 *
 * Ignores events that arrive while no backup of ours is running — the channel is per-window, not
 * per-dialog, so a restore's sibling channel or a stale event from a previous invocation must not
 * resurrect a closed flow. That is also why the returned phase is the *same object* when nothing
 * changed: the caller sets state unconditionally and `Object.is` keeps the render out.
 *
 * `isForeignRun` is what protects the window before the id is bound. A dump the user started, closed
 * the dialog on, and left running keeps emitting on this same channel; its `completed` could otherwise
 * be adopted by a *later* run that has not learned its own id yet, and the dialog would report a
 * success for a file it never wrote. The caller answers from the in-flight record it keeps across
 * dialog lifetimes (`backup-dialogs.tsx`), so only ids known to belong to another run are refused —
 * an unknown id is still ours, which is what keeps a `completed`-first stream (a dump that finishes
 * before its first progress line) from hanging the dialog on a spinner.
 */
export function applyProgress(
  phase: BackupPhase,
  progress: BackupProgress,
  isForeignRun: (backupId: string) => boolean = () => false
): BackupPhase {
  if (phase.kind !== 'running') return phase;
  // A second operation's events cannot reach a dialog that has already bound its id; before it has
  // one, they cannot reach it either if the window knows they belong to a different run.
  if (phase.backupId !== null) {
    if (progress.backupId !== phase.backupId) return phase;
  } else if (isForeignRun(progress.backupId)) {
    return phase;
  }

  if (progress.status === 'completed') {
    return { kind: 'done', path: phase.path, ...(elapsed(progress) ?? {}) };
  }
  if (progress.status === 'failed') {
    return { kind: 'failed', message: progress.error ?? 'The backup failed.' };
  }
  if (progress.status === 'cancelled') {
    return { kind: 'failed', message: 'The backup was cancelled.' };
  }
  return { kind: 'running', path: phase.path, backupId: progress.backupId, progress };
}

function elapsed(progress: BackupProgress): { elapsedMs: number } | null {
  return progress.elapsedMs === undefined ? null : { elapsedMs: progress.elapsedMs };
}

/**
 * The one field a percentage needs, so the restore wizard can pass its own event shape.
 *
 * `RestoreProgress` and `BackupProgress` differ only in the name of their id field, and a percentage
 * does not read it — so the parameter is narrowed to what is actually used rather than the restore
 * event being cast to a backup one.
 */
export interface PercentReadout {
  readonly percentComplete: number;
}

/**
 * The percentage to paint, or `null` for an indeterminate bar.
 *
 * `pg-backup.ts` reports `-1` on purpose (`sendProgress`) — pg_dump, pg_restore, mysqldump and the mysql client
 * all emit phase lines and never a percentage — and the Angular bar rendered that as `0%` next to an
 * indeterminate track, which read as a stalled operation. `null` is the honest answer and the bar has
 * a mode for it.
 */
export function progressPercent(progress: PercentReadout | null): number | null {
  if (progress === null) return null;
  const percent = progress.percentComplete;
  if (!Number.isFinite(percent) || percent < 0) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** The phase line under the bar. Never empty — a bar with no caption says nothing. */
export function progressLabel(progress: BackupProgress | null): string {
  if (progress === null) return 'Starting the backup…';
  const phase = progress.currentPhase;
  if (phase !== undefined && phase.trim() !== '') return phase;
  return progress.status === 'starting' ? 'Starting the backup…' : 'Backing up…';
}
