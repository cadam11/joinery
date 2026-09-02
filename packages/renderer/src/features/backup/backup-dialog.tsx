/**
 * The backup wizard — one database, one destination, one progress stream, one terminal state.
 *
 * Replaces `shared/components/backup-dialog/backup-dialog.component.ts` (674 LOC). The engine rules,
 * the T-SQL preview and the phase machine are in `backup-model.ts`; the path arithmetic is in
 * `server-path.ts`; what is left here is markup, five handlers and one subscription.
 *
 * ── Everything the user is told, they are told inside this dialog ────────────────────────────
 *
 * J-42: a toast raised while a modal is open is **inert** — Radix sets `pointer-events: none` on
 * `<body>` and re-enables it only inside the dialog, so sonner's close button cannot be clicked and
 * the toast sits behind the interaction barrier until the dialog closes. The Angular dialog reported
 * every outcome through `NotificationService`: the completion, the failure, the clipboard copy, the
 * probe error, the re-check result. Of those, only the completion was ever seen, and only because the
 * dialog closed itself on the same tick.
 *
 * So this dialog has **no toast at all**. Six phases (`BackupPhase`) each render their own statement
 * in the body or in the answer band, and the two side-channel actions — copying an install command
 * and opening a download page — confirm themselves in place.
 *
 * ── The form stays visible while the backup runs ─────────────────────────────────────────────
 *
 * Rather than swapping the body for a progress screen: the user is watching a five-minute dump and
 * "which database, to which path" is the context that makes the progress line mean anything. The
 * controls are disabled, the answer band above the actions carries the stream, and the same band
 * carries the success and failure statements afterwards — one place, three phases, so a terminal
 * state cannot be missed because it rendered somewhere the eye was not.
 *
 * ── There is no Cancel-the-backup button, and that is deliberate ─────────────────────────────
 *
 * `BackupRestoreService.cancel` (`packages/main/src/services/sql/backup-restore.ts:363-369`) sets a
 * flag whose only effect is to stop the progress *poll*; its own comment says so. The `BACKUP.CANCEL`
 * handler routes to that service for every engine, so it never reaches the PG/MySQL services' own
 * operation maps at all. A Cancel button would therefore stop the progress readout and leave the dump
 * running — worse than no button. Closing the dialog is offered instead, with the truth stated inline.
 * Real cancellation is a main-process follow-up.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { CircleCheck, CircleX, DatabaseBackup, FolderOpen, TriangleAlert } from 'lucide-react';
import type { BackupHistoryEntry, BackupRequest, DatabaseEngine } from '@joinery/shared';

import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Select,
  SelectItem,
  Spinner,
  cn,
} from '../../ui';
import { useIpcEvent, useIpcMutation, useIpcQuery } from '../../ipc';
import type { DbOperationRun } from '../../state/db-operations';
import { diagnostics } from '../../state/diagnostics';
import { FormAnswerBand, FormNote, FormSection, useFormValues } from '../forms';
import { MissingCliTools } from './missing-cli-tools';
import { ServerFileBrowser } from './server-file-browser';
import { joinServerPath } from './server-path';
import {
  BACKUP_TYPES,
  applyProgress,
  backupTsql,
  bindRunId,
  cliEngineFor,
  defaultBackupValues,
  destinationIsServerSide,
  engineBackupOptions,
  formatBytes,
  derivePhase,
  phaseForToolsResult,
  progressLabel,
  progressPercent,
  suggestedFileName,
  type BackupFormValues,
  type BackupPhase,
} from './backup-model';

/**
 * The window's record of long-running operations, as this dialog needs it.
 *
 * The record itself lives in `state/db-operations.ts` because a dump outlives the dialog that started
 * it and because a **restore** of this database collides with a dump of it just as badly as a second
 * dump would — see that module's header. Passed in rather than read here so this component keeps one
 * source of truth for "is something already running", and so its spec can mount it with an inert one.
 */
export interface BackupRunCoordination {
  /**
   * An operation against **this** database that has not reported a terminal event yet, or `null`. It
   * may be a restore rather than a dump, which is why the panel below reads its `kind`.
   */
  readonly inFlight: DbOperationRun | null;
  /** This dialog has just asked the main process to start a dump to `path`. */
  readonly onStarted: (path: string) => void;
  /** The operation id of this dialog's run, as soon as it is known. */
  readonly onBound: (backupId: string) => void;
  /** The start call was refused, so there is no run to record — retire the entry `onStarted` made. */
  readonly onFailedToStart: () => void;
  /** Whether an operation id belongs to some *other* run — `applyProgress`'s guard. */
  readonly isForeignRun: (backupId: string) => boolean;
}

export interface BackupDialogProps {
  readonly connectionId: string;
  readonly databaseName: string;
  /** The profile's engine. Every option decision in this dialog reads it. */
  readonly engine: DatabaseEngine;
  /** The in-flight record, which outlives this dialog. */
  readonly run: BackupRunCoordination;
  /** Escape, the close button, or Close/Cancel. */
  readonly onDismiss: () => void;
}

export function BackupDialog({
  connectionId,
  databaseName,
  engine,
  run,
  onDismiss,
}: BackupDialogProps) {
  const options = engineBackupOptions(engine);
  const cliEngine = cliEngineFor(engine);
  const serverSide = destinationIsServerSide(engine);

  const form = useForm<BackupFormValues>({ defaultValues: defaultBackupValues(engine) });
  const values = useFormValues(form);

  /**
   * The phase a *user action* has put the dialog in, or `null` for "whatever the probe implies".
   *
   * Split that way because `react-hooks/set-state-in-effect` is an error here and the probe resolves
   * outside render — see `derivePhase`. It also means the checking→form transition has no state to get
   * wrong.
   */
  const [actionPhase, setActionPhase] = useState<BackupPhase | null>(null);
  const [browsing, setBrowsing] = useState(false);
  /** A non-blocking note above the actions, set by an action. The probe's own note is derived below. */
  const [actionHint, setActionHint] = useState<string | undefined>(undefined);
  /** Which install command was last copied, so the copy button can confirm itself in place. */
  const [copiedCommand, setCopiedCommand] = useState<string | undefined>(undefined);

  // ── The host-tool probe (PG / MySQL only) ────────────────────────────────────────────────
  //
  // `staleTime: Infinity` because the answer is a property of this machine, and `retry: false`
  // because a failed probe does not become a successful one by asking again — the recheck mutation
  // is the deliberate second ask.
  //
  // `args` has to be a valid `CliEngine` even when the hook is disabled, because the type is checked
  // against preload regardless of `enabled`. The placeholder is never called: `cliEngine === null`
  // means MSSQL, which disables the query, and it is `keyArgs` that carries the `null` into the cache
  // key so the disabled state cannot collide with a real PostgreSQL probe.
  const toolsProbe = useIpcQuery({
    namespace: 'backup',
    operation: 'checkTools',
    args: cliEngine === null ? (['postgresql'] as const) : ([cliEngine] as const),
    keyArgs: [cliEngine],
    enabled: cliEngine !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const recheck = useIpcMutation({ namespace: 'backup', operation: 'recheckTools' });

  const probeFailed = toolsProbe.error !== null;
  const phase =
    actionPhase ?? derivePhase(engine, { result: toolsProbe.data, failed: probeFailed });

  // The probe's own note, derived rather than stored — an action's note wins when there is one, so a
  // "could not copy" line is not hidden behind a probe warning the user has already read past.
  const probeHint = probeFailed
    ? `Joinery could not check for the ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} command-line tools. The backup may fail if they are missing.`
    : undefined;
  const hint = actionHint ?? probeHint;

  // The one thing a failed probe still owes: a log line. Reported in an effect because rendering is not
  // where side effects belong, and keyed on the error so one failure is reported once.
  useEffect(() => {
    if (toolsProbe.error === null) return;
    diagnostics.warn('the backup CLI-tools probe failed', toolsProbe.error);
  }, [toolsProbe.error]);

  // ── The MSSQL-only reads: the server's default backup directory, and the backup history ──
  const defaultPaths = useIpcQuery({
    namespace: 'serverFs',
    operation: 'getDefaultPaths',
    args: [connectionId],
    keyArgs: [connectionId],
    enabled: serverSide,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const history = useIpcQuery({
    namespace: 'backup',
    operation: 'getHistory',
    args: [connectionId, databaseName],
    keyArgs: [connectionId, databaseName],
    enabled: options.showHistory,
    retry: false,
  });

  // The suggested destination, written once and only into an untouched field — `isDirty` is the guard,
  // so a path the user has already typed is never overwritten by a late-arriving query. The Angular
  // version assigned unconditionally, which raced the user on a slow server.
  useEffect(() => {
    const directory = defaultPaths.data?.backupPath;
    if (directory === undefined || directory === '') return;
    if (form.getFieldState('backupPath').isDirty) return;
    form.setValue(
      'backupPath',
      joinServerPath(directory, suggestedFileName(databaseName, engine, new Date()))
    );
  }, [defaultPaths.data, form, databaseName, engine]);

  // ── The run ─────────────────────────────────────────────────────────────────────────────
  const start = useIpcMutation({ namespace: 'backup', operation: 'start' });
  const saveDialog = useIpcMutation({ namespace: 'app', operation: 'showSaveDialog' });
  const openExternal = useIpcMutation({ namespace: 'app', operation: 'openExternal' });

  // One subscription for the whole dialog's lifetime, and the updater form is what makes it safe:
  // `applyProgress` reads the previous phase, so the handler never closes over a stale one, and it
  // returns the SAME object when the event is not ours — an unrelated operation's progress costs no
  // render.
  useIpcEvent('backup', 'onProgress', progress => {
    // Asked here rather than inside the updater: the updater has to be pure, and this is a read of
    // state outside React that a double-invoked updater should not be making.
    const foreign = run.isForeignRun(progress.backupId);
    // `null` means no action has moved the dialog off the probe's phase, so no backup of ours is
    // running and there is nothing for this event to change.
    setActionPhase(previous =>
      previous === null ? null : applyProgress(previous, progress, () => foreign)
    );
  });

  const startBackup = form.handleSubmit(current => {
    // A dump of this database that this window started is still going, and neither end can stop it
    // (J-48 items e and f). Refusing is the only answer that cannot corrupt an archive.
    if (run.inFlight !== null) return;

    const path = current.backupPath.trim();
    if (path === '') {
      setActionHint('Choose where the backup should be written.');
      form.setFocus('backupPath');
      return;
    }

    const request: BackupRequest = {
      connectionId,
      database: databaseName,
      backupPath: path,
      // Omitted entirely off SQL Server: pg_dump and mysqldump each write one format, so there is
      // nothing here to choose and nothing to send (J-48d).
      ...(options.showBackupType ? { backupType: current.backupType } : {}),
      ...(options.showCompression ? { compression: current.compression } : {}),
      ...(options.showDescription && current.description !== ''
        ? { description: current.description }
        : {}),
    };

    setActionHint(undefined);
    setActionPhase({ kind: 'running', path, backupId: null, progress: null });
    run.onStarted(path);

    // The mutation resolves as soon as the main process has *started* the operation; completion
    // arrives on `onProgress`. A rejection here means it never started at all, which is a terminal
    // failure for this attempt.
    start.mutate([request], {
      onSuccess: id => {
        // The declaration says `Promise<string>` since J-48h, so the id arrives typed rather than
        // recovered by inspection. The check stays and is now loud: a type is a claim about the
        // handler, and binding an empty id would detach the run from its own progress events —
        // the dialog would sit on "starting" forever with the dump still going.
        if (typeof id !== 'string' || id === '') {
          diagnostics.error(
            'the backup started without an operation id',
            new Error(`backup.start resolved with ${typeof id}`)
          );
          return;
        }
        setActionPhase(previous => (previous === null ? null : bindRunId(previous, id)));
        run.onBound(id);
      },
      onError: error => {
        diagnostics.error('the backup could not be started', error);
        setActionPhase({ kind: 'failed', message: error.message });
        // Nothing is running, so the record must not keep saying one is — otherwise a refused start
        // locks this database out of the feature for the rest of the session.
        run.onFailedToStart();
      },
    });
  });

  /** The native save dialog, for the engines whose destination is on this machine. */
  const chooseLocalPath = async (): Promise<void> => {
    try {
      const result = await saveDialog.mutateAsync([
        {
          title: 'Save the backup as',
          defaultPath: suggestedFileName(databaseName, engine, new Date()),
          filters: [
            {
              name: `${engine === 'mysql' ? 'SQL dump' : 'pg_dump archive'}`,
              extensions: [options.extension],
            },
            { name: 'All files', extensions: ['*'] },
          ],
        },
      ]);
      if (result.canceled || result.filePath === undefined) return;
      form.setValue('backupPath', result.filePath, { shouldDirty: true });
      setActionHint(undefined);
    } catch (error) {
      diagnostics.error('the save dialog could not be opened', error);
      setActionHint('Joinery could not open the save dialog. Type the path instead.');
    }
  };

  const copyCommand = async (command: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
    } catch (error) {
      diagnostics.error('the install command could not be copied', error);
      setActionHint(
        'Joinery could not reach the clipboard. Select the command and copy it manually.'
      );
    }
  };

  const running = phase.kind === 'running';
  /**
   * The form is read-only while a dump is in flight AND after it has finished, because in neither case
   * is there anything an edit could do — the run is over and this dialog has no second one in it. It
   * stays editable in `failed`, which is the whole point of the retry: the usual reason a dump fails is
   * the path, and the user fixes it here before pressing Try again.
   */
  const controlsDisabled = running || phase.kind === 'done';

  // ── The browser step replaces the body and the actions, per its own header ───────────────
  if (browsing) {
    return (
      <BackupShell
        title="Choose a backup location"
        description="Folders on the database server, as the server sees them."
        onDismiss={onDismiss}
      >
        <ServerFileBrowser
          connectionId={connectionId}
          mode="save"
          initialPath={values.backupPath === '' ? undefined : values.backupPath}
          extension={options.extension}
          defaultFileName={suggestedFileName(databaseName, engine, new Date())}
          onCancel={() => setBrowsing(false)}
          onPick={pick => {
            form.setValue('backupPath', pick.path, { shouldDirty: true });
            setActionHint(undefined);
            setBrowsing(false);
          }}
        />
      </BackupShell>
    );
  }

  if (phase.kind === 'checking') {
    return (
      <BackupShell
        title={`Back up ${databaseName}`}
        description="Checking this machine for the command-line tools the dump needs."
        onDismiss={onDismiss}
      >
        <DialogBody data-testid="backup-tools-checking">
          <div className="flex h-24 items-center justify-center">
            <Spinner label="Checking for the required CLI tools…" />
          </div>
        </DialogBody>
        <DialogActions>
          <Button variant="outline" data-testid="backup-close" onClick={onDismiss}>
            Close
          </Button>
        </DialogActions>
      </BackupShell>
    );
  }

  if (phase.kind === 'tools-missing') {
    const instructions = phase.result.installInstructions;
    return (
      <BackupShell
        title={`Back up ${databaseName}`}
        description="One more step before Joinery can dump this database."
        onDismiss={onDismiss}
      >
        <DialogBody>
          {instructions === undefined ? (
            // `CliDepsResult` types `installInstructions` as optional and documents it as present
            // whenever `allAvailable` is false. This arm is what a broken promise looks like, stated
            // rather than crashed on.
            <FormNote data-testid="backup-tools-unknown">
              Some required command-line tools are missing, and Joinery has no install instructions
              for this platform. Install{' '}
              {phase.result.tools
                .filter(tool => !tool.available)
                .map(tool => tool.tool)
                .join(', ')}{' '}
              and re-open this dialog.
            </FormNote>
          ) : (
            <MissingCliTools
              instructions={instructions}
              tools={phase.result.tools}
              rechecking={recheck.isPending}
              copiedCommand={copiedCommand}
              onRecheck={() => {
                if (cliEngine === null) return;
                setActionHint(undefined);
                recheck.mutate([cliEngine], {
                  onSuccess: result => setActionPhase(phaseForToolsResult(result)),
                  onError: error => {
                    diagnostics.error('the CLI-tools re-check failed', error);
                    setActionHint(`Joinery could not re-check the tools: ${error.message}`);
                  },
                });
              }}
              onCopyCommand={command => void copyCommand(command)}
              onOpenLink={url => {
                openExternal.mutate([url], {
                  onError: error => {
                    diagnostics.error('the download page could not be opened', error);
                    setActionHint(`Joinery could not open ${url}.`);
                  },
                });
              }}
            />
          )}
        </DialogBody>
        <FormAnswerBand hint={hint} hintTestId="backup-hint" />
        <DialogActions>
          <Button variant="outline" data-testid="backup-close" onClick={onDismiss}>
            Close
          </Button>
        </DialogActions>
      </BackupShell>
    );
  }

  return (
    <BackupShell
      title={`Back up ${databaseName}`}
      description={
        serverSide
          ? 'SQL Server writes the file itself, so the path is a path on the server.'
          : 'The dump is written on this machine by the command-line tools.'
      }
      onDismiss={onDismiss}
      // The header's ✕ goes away while a dump runs; the action row's Close stays, next to the line that
      // says closing will not stop it. One deliberate exit rather than two, one of which is a stray
      // click away from a user who thinks it cancelled the backup.
      showClose={!running}
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={event => {
          void startBackup(event);
        }}
      >
        <DialogBody className="flex flex-col gap-3">
          {options.showBackupType ? (
            <Select
              label="Backup type"
              name="backupType"
              value={values.backupType}
              disabled={controlsDisabled}
              onValueChange={next =>
                form.setValue('backupType', next as BackupFormValues['backupType'], {
                  shouldDirty: true,
                })
              }
              data-testid="backup-type"
            >
              {BACKUP_TYPES.map(type => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </Select>
          ) : null}

          <div className="flex items-end gap-2">
            <Input
              label={options.pathLabel}
              fieldClassName="flex-1"
              className="font-mono"
              placeholder={options.pathPlaceholder}
              disabled={controlsDisabled}
              data-testid="backup-path"
              {...form.register('backupPath')}
            />
            <Button
              variant="outline"
              leadingIcon={FolderOpen}
              disabled={controlsDisabled}
              data-testid="backup-browse"
              onClick={() => {
                if (serverSide) {
                  setBrowsing(true);
                  return;
                }
                void chooseLocalPath();
              }}
            >
              Choose…
            </Button>
          </div>

          {options.formatNote === null ? null : (
            <FormNote data-testid="backup-format-note">{options.formatNote}</FormNote>
          )}

          {options.showCompression || options.showDescription ? (
            <FormSection title="Options">
              {options.showCompression ? (
                <Checkbox
                  label="Compress the backup"
                  hint="WITH COMPRESSION. Smaller file, more CPU on the server."
                  disabled={controlsDisabled}
                  data-testid="backup-compression"
                  {...form.register('compression')}
                />
              ) : null}
              {options.showDescription ? (
                <Input
                  label="Description (optional)"
                  hint="Stored in the backup header, and shown in the history below."
                  disabled={controlsDisabled}
                  data-testid="backup-description"
                  {...form.register('description')}
                />
              ) : null}
            </FormSection>
          ) : null}

          {options.showTsqlPreview ? (
            <FormSection title="Statement">
              {/* CLAUDE.md's SQL-transparency rule: the statement shown IS the statement
                  `TsqlBuilder.backup` will run, INIT and STATS included. */}
              <pre
                data-testid="backup-tsql"
                className="overflow-x-auto rounded-sm border border-rule bg-canvas p-2 font-mono text-sm whitespace-pre-wrap text-fg"
              >
                {backupTsql(values, databaseName)}
              </pre>
            </FormSection>
          ) : null}

          {options.showHistory ? (
            <FormSection title="Recent backups">
              <BackupHistory
                entries={history.data ?? []}
                loading={history.isPending}
                failed={history.error !== null}
              />
            </FormSection>
          ) : null}
        </DialogBody>

        {/* One band, three phases, and **one child expression**. Three sibling ternaries would make
            `children` an ARRAY of three nulls, which is not `null` — so the band would render its rule
            and its padding around nothing at all. Its own header warns about the shape; the first run
            of the Task 12 gate photographed the empty strip. */}
        <FormAnswerBand
          hint={hint}
          hintTestId="backup-hint"
          // Named so its ABSENCE is assertable: an empty band is a rule and 12px of padding above the
          // action row, which is visible and means nothing.
          data-testid="backup-answer-band"
        >
          {answerPanel(phase, run.inFlight)}
        </FormAnswerBand>

        <DialogActions>
          <Button
            variant="ghost"
            data-testid={phase.kind === 'options' ? 'backup-cancel' : 'backup-close'}
            onClick={onDismiss}
          >
            {phase.kind === 'options' ? 'Cancel' : 'Close'}
          </Button>
          {phase.kind === 'failed' ? (
            <Button
              variant="primary"
              data-testid="backup-retry"
              onClick={() => {
                setActionHint(undefined);
                setActionPhase({ kind: 'options' });
              }}
            >
              Try again
            </Button>
          ) : null}
          {phase.kind === 'options' ? (
            <Button
              variant="primary"
              type="submit"
              leadingIcon={DatabaseBackup}
              // Refused while this window's own dump of this database is still going. The band above
              // says why; see `InFlightPanel`.
              disabled={run.inFlight !== null}
              data-testid="backup-start"
            >
              Start backup
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </BackupShell>
  );
}

/**
 * Whatever the last action had to say, as **one** node or `null`.
 *
 * A function rather than three ternaries in the JSX for the reason `FormAnswerBand`'s header states:
 * the band renders nothing only when `children` is `null`, and three sibling ternaries produce an array
 * of three nulls, which is not.
 */
function answerPanel(phase: BackupPhase, inFlight: DbOperationRun | null): ReactNode {
  if (phase.kind === 'running') return <ProgressPanel phase={phase} />;
  if (phase.kind === 'done') return <DonePanel path={phase.path} elapsedMs={phase.elapsedMs} />;
  if (phase.kind === 'failed') return <FailedPanel message={phase.message} />;
  // The form, re-opened onto an operation that is still going. Stated here rather than as a hint
  // because it is the reason the button next to it will not do anything.
  if (inFlight !== null) return <InFlightPanel run={inFlight} />;
  return null;
}

/**
 * The re-opened dialog, over an operation on this database that is still running.
 *
 * Blocking rather than warning, and the reason is that neither end can undo the alternative: nothing
 * in `packages/main` refuses a second dump of the same database (J-48 item f — `pg-backup.ts` mints a
 * fresh operation id per call and never looks at the destination), two `pg_dump` processes writing one
 * archive corrupt it while **both** report success, and there is no working cancel to recover with
 * (J-48 item e). A warning the user can click past buys nothing here: the run they would be racing is
 * one they started seconds ago and can simply wait out.
 *
 * The blocking run may be a **restore**, because the record is shared (`state/db-operations.ts`) — a
 * dump of a database that is being rewritten underneath it is a torn archive that looks complete.
 */
function InFlightPanel({ run }: { readonly run: DbOperationRun }) {
  const restoring = run.kind === 'restore';
  return (
    <div
      className="flex items-start gap-2 rounded-sm border-l-2 border-warning bg-surface p-3"
      data-testid="backup-in-flight"
    >
      <Icon icon={TriangleAlert} size="md" className="mt-0.5 shrink-0 stroke-warning" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md text-fg">
          {restoring
            ? 'A restore into this database is still running'
            : 'A backup of this database is still running'}
        </p>
        <p className="text-sm break-words text-fg-muted text-pretty">
          Started from this window, {restoring ? 'restoring from ' : 'writing to '}
          <span className="font-mono break-all">{run.path}</span>. Wait for it to finish before
          starting another —{' '}
          {restoring
            ? 'a dump taken while the database is being rewritten is a torn archive that looks complete'
            : 'a second dump can’t be cancelled and can corrupt the first one’s file'}
          .
        </p>
      </div>
    </div>
  );
}

/**
 * The dialog frame every phase shares, so the header cannot drift between them and there is exactly
 * one `Dialog` root for the whole flow — including the browser step, which is why that step is a body
 * swap rather than a nested modal.
 */
function BackupShell({
  title,
  description,
  onDismiss,
  showClose = true,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly onDismiss: () => void;
  readonly showClose?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onDismiss())}>
      <DialogContent size="md" data-testid="backup-dialog">
        <DialogHeader showClose={showClose}>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <Icon icon={DatabaseBackup} size="sm" className="stroke-fg-muted" />
              {title}
            </span>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The live stream. `aria-live="polite"` on the phase line so a screen-reader user hears the dump move
 * without the bar's numbers being read on every tick.
 */
function ProgressPanel({ phase }: { readonly phase: Extract<BackupPhase, { kind: 'running' }> }) {
  const percent = progressPercent(phase.progress);
  const label = progressLabel(phase.progress);

  return (
    <div
      className="flex flex-col gap-2 rounded-sm border border-rule bg-surface p-3"
      data-testid="backup-progress"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span aria-live="polite" className="min-w-0 truncate text-md text-fg">
          {label}
        </span>
        <span className="shrink-0 font-mono text-sm text-fg-muted tabular-nums">
          {percent === null ? 'working' : `${percent}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Backup progress"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted entirely when indeterminate, which is what tells assistive technology "unknown"
        // rather than "zero". `pg_dump` reports no percentage at all (`pg-backup.ts:296`).
        aria-valuenow={percent ?? undefined}
        data-testid="backup-progress-bar"
        className="h-1.5 overflow-hidden rounded-full bg-active"
      >
        <div
          className={cn(
            'h-full rounded-full bg-accent',
            percent === null ? 'w-full animate-pulse' : 'w-(--backup-percent)'
          )}
          // The width is data, so it travels as a custom property and the utility reads it —
          // `general.md`'s rule for dynamic values. The cast is the same one `ui/tree.tsx` carries.
          style={
            percent === null
              ? undefined
              : ({ '--backup-percent': `${percent}%` } as unknown as CSSProperties)
          }
        />
      </div>
      <p className="text-sm text-fg-muted text-pretty">
        Closing this dialog won’t stop the backup — it will finish in the background.
      </p>
    </div>
  );
}

/** Success, stated where the eye already is. Chartreuse on a dark well is one of §5's two jobs for it. */
function DonePanel({
  path,
  elapsedMs,
}: {
  readonly path: string;
  readonly elapsedMs: number | undefined;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-sm border-l-2 border-success bg-surface p-3"
      data-testid="backup-success"
    >
      <Icon icon={CircleCheck} size="md" className="mt-0.5 shrink-0 stroke-success" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md text-fg">
          Backup complete
          {elapsedMs === undefined ? null : (
            <span className="text-fg-muted tabular-nums"> · {Math.round(elapsedMs / 1000)}s</span>
          )}
        </p>
        <p data-testid="backup-success-path" className="font-mono text-sm break-all text-fg-muted">
          {path}
        </p>
      </div>
    </div>
  );
}

/** The failure, in the same slot the progress was in, so nothing about it can be missed. */
function FailedPanel({ message }: { readonly message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-sm border-l-2 border-danger bg-surface p-3"
      data-testid="backup-error"
    >
      <Icon icon={CircleX} size="md" className="mt-0.5 shrink-0 stroke-danger" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md text-fg">The backup failed</p>
        <p className="text-sm break-words text-fg-muted text-pretty">{message}</p>
      </div>
    </div>
  );
}

/**
 * `msdb`'s record of what has been backed up. MSSQL-only — `backup.ipc.ts:125-128` answers `[]` for
 * PG and MySQL because neither keeps the metadata, which is why this panel is gated on the engine
 * rather than on the list being empty.
 */
function BackupHistory({
  entries,
  loading,
  failed,
}: {
  readonly entries: readonly BackupHistoryEntry[];
  readonly loading: boolean;
  readonly failed: boolean;
}) {
  if (loading) return <Spinner size="sm" label="Reading the backup history…" />;
  if (failed) {
    return (
      <FormNote data-testid="backup-history-error">The backup history could not be read.</FormNote>
    );
  }
  if (entries.length === 0) {
    return (
      <FormNote data-testid="backup-history-empty">No backups recorded for this database.</FormNote>
    );
  }

  return (
    <ul className="flex max-h-40 flex-col overflow-y-auto" data-testid="backup-history">
      {entries.map(entry => (
        <li
          key={`${entry.backupStartDate}-${entry.physicalDeviceName}`}
          className="flex flex-col gap-0.5 border-b border-rule py-1.5 last:border-b-0"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base text-fg">{entry.backupType}</span>
            <span className="shrink-0 text-sm text-fg-muted tabular-nums">
              {formatTimestamp(entry.backupFinishDate)}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-sm text-fg-muted">
              {entry.physicalDeviceName}
            </span>
            <span className="shrink-0 font-mono text-sm text-fg-muted tabular-nums">
              {formatBytes(entry.backupSizeBytes)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A `msdb` timestamp as the host would write it, or the raw string when it will not parse. */
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
