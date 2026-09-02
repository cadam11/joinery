/**
 * The restore wizard — one archive, one target database, one confirmation, one progress stream.
 *
 * Replaces `shared/components/restore-dialog/restore-dialog.component.ts` (971 LOC). The engine rules,
 * the destructive-target decision, the T-SQL transcription and the phase machine are in
 * `restore-model.ts`; the server file browser, the remediation view, the phase openings and the path
 * arithmetic are Task 12's, imported rather than copied. What is left here is markup, six handlers and
 * one subscription.
 *
 * ── This is the one workflow in Joinery that destroys data ──────────────────────────────────
 *
 * **The Angular dialog had no confirmation at all.** `startRestore` (`:918-952`) went straight from a
 * `Start Restore` click to `ipc.startRestore`, with `canRestore()` checking only that a path had been
 * typed. Restoring over a live database — the default, since `ngOnInit` pre-filled the target with the
 * database the user had selected — was one click, with `withReplace` unchecked so SQL Server would
 * refuse but `pg_restore`/`mysql` would happily write into it anyway.
 *
 * This is the one place the rewrite is deliberately **stricter** than parity, and the sanctioned
 * deviation is recorded in the task report. Three properties, in order of how much they matter:
 *
 *  1. **Destructiveness is decided by the target NAME, not by a mode toggle** (`targetKindFor`). A user
 *     who picks "a new database" and types a name that already exists is overwriting, and is told so.
 *     A database list that could not be read is treated as an overwrite, because being asked to
 *     confirm a restore into an empty database costs a sentence.
 *  2. **The confirmation is a PHASE, not a checkbox in the form.** `restore.start` is reachable from
 *     `confirming` and from a proven-new `options`, and from nowhere else — so there is no expression
 *     in this file of "a destructive restore started from the options screen". The options screen's
 *     primary button is called *Review the restore* and cannot destroy anything.
 *  3. **The confirmation is the database name, typed out, exactly.** Not a checkbox, not "type YES":
 *     the thing being destroyed is named, so the user has to name it. Case-sensitive, because
 *     PostgreSQL identifiers are.
 *
 * ── Everything the user is told, they are told inside this dialog ────────────────────────────
 *
 * J-42, as `backup-dialog.tsx` states it at length: a toast raised while a modal is open is visible
 * and inert, because Radix disables pointer events outside the dialog content. The Angular dialog
 * reported the completion, the failure, the clipboard copy, the probe error and the re-check result
 * that way, and then closed itself on completion — which is the only reason its success toast was ever
 * seen. This dialog raises none, and stays open.
 *
 * ── There is no Cancel-the-restore button, and that is deliberate ────────────────────────────
 *
 * `RESTORE.CANCEL` routes every engine to `BackupRestoreService.cancel`
 * (`backup-restore.ts:363-369`), whose only effect is to stop the progress *poll*; it never reaches
 * the PG/MySQL services' own operation maps. A Cancel button would stop the readout and leave a
 * half-restored database behind — which is strictly worse here than it is for a backup, because the
 * thing left half-written is a database rather than a file. Closing is offered instead, with the
 * truth stated inline.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { CircleCheck, CircleX, FolderOpen, HardDriveDownload, TriangleAlert } from 'lucide-react';
import type {
  BackupHistoryEntry,
  DatabaseEngine,
  RestoreRequest,
  ServerDefaultPaths,
} from '@joinery/shared';

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
import {
  dbOperationKey,
  dbOperationsStore,
  isRunOwnedByAnother,
  selectLiveRun,
  useDbOperationsStore,
  type DbOperationRun,
} from '../../state/db-operations';
import { diagnostics } from '../../state/diagnostics';
import { FormAnswerBand, FormNote, FormSection, useFormValues } from '../forms';
import {
  MissingCliTools,
  ServerFileBrowser,
  cliEngineFor,
  derivePhase,
  formatBytes,
  phaseForToolsResult,
  progressPercent,
} from '../backup';
import {
  applyRestoreProgress,
  bindRestoreRunId,
  confirmationRequired,
  confirmationSatisfied,
  defaultRestoreValues,
  engineRestoreOptions,
  planFor,
  restoreProblem,
  restoreProgressLabel,
  restoreTsql,
  sourceIsServerSide,
  suggestedRelocations,
  suggestedTargetName,
  targetCreatedBy,
  targetKindFor,
  type Relocation,
  type RestoreFormValues,
  type TargetKind,
  type RestorePhase,
  type RestorePlan,
} from './restore-model';

/**
 * The value the target picker carries for "not one of the databases that already exist".
 *
 * A sentinel rather than an empty string, because Radix's `Select` reserves `''` for its own
 * placeholder state. A real database named this would collapse the two rows, which is harmless:
 * what the restore actually does is decided by `targetKindFor` reading the NAME, never by this.
 */
const NEW_TARGET = '__joinery:new-database__';

export interface RestoreDialogProps {
  readonly connectionId: string;
  /** The profile's engine. Every option decision in this dialog reads it. */
  readonly engine: DatabaseEngine;
  /**
   * The database the command named, or `null` when it came from the server node — a restore *creates*
   * its target, which is why the sidebar offers it at the server level too and why this is nullable.
   */
  readonly databaseName: string | null;
  /**
   * The databases the server reports, or `null` when they could not be read. **`null` is not the same
   * as `[]`** — it is what makes `targetKindFor` answer `'unknown'` and demand a confirmation.
   */
  readonly databases: readonly string[] | null;
  /** `EngineCapabilities.supportsDatabaseManagement`. Gates the "a new database" option. */
  readonly canCreateDatabases: boolean;
  /** A restore finished; the host reloads the database list so the new one reaches the sidebar. */
  readonly onRestored: (databaseName: string) => void;
  /** Escape, the close button, or Close/Cancel. */
  readonly onDismiss: () => void;
}

export function RestoreDialog({
  connectionId,
  engine,
  databaseName,
  databases,
  canCreateDatabases,
  onRestored,
  onDismiss,
}: RestoreDialogProps) {
  const options = engineRestoreOptions(engine);
  const cliEngine = cliEngineFor(engine);
  const serverSide = sourceIsServerSide(engine);

  const form = useForm<RestoreFormValues>({
    defaultValues: { ...defaultRestoreValues(), targetDatabase: databaseName ?? '' },
  });
  const values = useFormValues(form);

  /** The phase a *user action* has put the dialog in, or `null` for "whatever the probe implies". */
  const [actionPhase, setActionPhase] = useState<RestorePhase | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [actionHint, setActionHint] = useState<string | undefined>(undefined);
  const [copiedCommand, setCopiedCommand] = useState<string | undefined>(undefined);
  /**
   * Whether the target is being typed rather than picked from the list.
   *
   * Component state and NOT a form field, because nothing downstream reads it: `targetKindFor` decides
   * what will happen from the name alone, so a mode that disagreed with the name would be a second
   * source of truth for the one question this dialog exists to answer correctly.
   */
  const [namingNewTarget, setNamingNewTarget] = useState(databaseName === null);
  /**
   * The archive whose header has been read, for MSSQL. Separate from the path field so a `RESTORE
   * HEADERONLY` is not issued per keystroke; set by the browser, the history and the Read button.
   */
  const [inspectedPath, setInspectedPath] = useState('');
  /** Relocation paths the user has edited, by logical name. The rest are derived — see `relocations`. */
  const [relocationEdits, setRelocationEdits] = useState<Readonly<Record<string, string>>>({});

  // ── The host-tool probe (PG / MySQL only) ────────────────────────────────────────────────
  //
  // The same `backup.checkTools` channel, and not by coincidence: `cli-deps.ts:32-35` probes
  // `pg_dump`+`pg_restore` and `mysqldump`+`mysql` together, so one probe answers for both directions.
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
  const phase: RestorePhase =
    actionPhase ?? derivePhase(engine, { result: toolsProbe.data, failed: probeFailed });

  const probeHint = probeFailed
    ? `Joinery could not check for the ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} command-line tools. The restore may fail if they are missing.`
    : undefined;
  const hint = actionHint ?? probeHint;

  useEffect(() => {
    if (toolsProbe.error === null) return;
    diagnostics.warn('the restore CLI-tools probe failed', toolsProbe.error);
  }, [toolsProbe.error]);

  // ── The MSSQL-only reads ─────────────────────────────────────────────────────────────────
  const defaultPaths = useIpcQuery({
    namespace: 'serverFs',
    operation: 'getDefaultPaths',
    args: [connectionId],
    keyArgs: [connectionId],
    enabled: serverSide,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Unfiltered on purpose. The Angular dialog defaulted to "just this database" with a Show all
  // checkbox, but a restore is a server-level action that is very often pointed at *another*
  // database's backup — which is exactly the case the filter hid.
  const history = useIpcQuery({
    namespace: 'backup',
    operation: 'getHistory',
    args: [connectionId, undefined],
    keyArgs: [connectionId],
    enabled: options.showHistory,
    retry: false,
  });

  // `RESTORE HEADERONLY` + `RESTORE FILELISTONLY`, which is the only source of the logical file names
  // a MOVE needs. MSSQL only: `backup.ipc.ts:137-154` answers PG and MySQL with a stub whose only real
  // field is a database name guessed from the file name, so asking would render a panel of `undefined`.
  const backupInfo = useIpcQuery({
    namespace: 'restore',
    operation: 'getBackupInfo',
    args: [connectionId, inspectedPath],
    keyArgs: [connectionId, inspectedPath],
    enabled: serverSide && inspectedPath !== '',
    retry: false,
  });

  // ── Derived state ────────────────────────────────────────────────────────────────────────

  const targetKind = targetKindFor(values.targetDatabase, databases);
  const problem = restoreProblem(values, engine, targetKind, canCreateDatabases);

  /**
   * The MOVE list, derived every render from the backup's file list and overlaid with the edits.
   *
   * Derived rather than held in state so a change of target database re-aims every path the user has
   * not touched — and because folding a resolving query into `useState` inside a `useEffect` does not
   * compile here (`react-hooks/set-state-in-effect` is an error, see `derivePhase`).
   */
  const relocations: readonly Relocation[] = options.showRelocations
    ? suggestedRelocations(
        backupInfo.data?.files ?? [],
        values.targetDatabase.trim() === '' ? 'restored' : values.targetDatabase.trim(),
        defaultPaths.data as ServerDefaultPaths | undefined
      ).map(relocation => {
        const edited = relocationEdits[relocation.logicalName];
        return edited === undefined ? relocation : { ...relocation, newPath: edited };
      })
    : [];

  /** An operation already running against the target the form currently names. */
  const inFlight: DbOperationRun | null = useDbOperationsStore(
    selectLiveRun(
      values.targetDatabase.trim() === ''
        ? null
        : dbOperationKey(connectionId, values.targetDatabase.trim())
    )
  );

  // The suggested target, written once and only into an untouched field, exactly as the backup
  // wizard's destination suggestion is: `isDirty` is the guard, so a name the user has typed is never
  // overwritten by a late-arriving header read.
  const suggestedFromArchive = backupInfo.data?.databaseName;
  useEffect(() => {
    if (suggestedFromArchive === undefined || suggestedFromArchive === '') return;
    if (form.getFieldState('targetDatabase').isDirty) return;
    form.setValue('targetDatabase', suggestedFromArchive);
  }, [suggestedFromArchive, form]);

  // ── The run ──────────────────────────────────────────────────────────────────────────────
  const start = useIpcMutation({ namespace: 'restore', operation: 'start' });
  const createDatabase = useIpcMutation({ namespace: 'database', operation: 'create' });
  const openDialog = useIpcMutation({ namespace: 'app', operation: 'showOpenDialog' });
  const openExternal = useIpcMutation({ namespace: 'app', operation: 'openExternal' });

  useIpcEvent('restore', 'onProgress', progress => {
    setActionPhase(previous => {
      if (previous === null) return null;
      // The key is read off the phase rather than off a render closure, because the phase the updater
      // is handed is the *latest* one — `runPlan` registers the run and schedules the phase in the
      // same tick, so a closure captured at render time can still say `options` and answer "no key",
      // which would make a genuinely foreign id look adoptable. The store read is idempotent, so a
      // double-invoked updater (StrictMode) cannot make it lie.
      const key =
        'plan' in previous ? dbOperationKey(connectionId, previous.plan.targetDatabase) : null;
      return applyRestoreProgress(previous, progress, operationId =>
        isRunOwnedByAnother(dbOperationsStore.getState(), key, operationId)
      );
    });
  });

  /**
   * Tell the host a restore landed, so it can re-read the database list.
   *
   * An effect keyed on the finished target, and it has to be — the first attempt collected the
   * transition inside the `setActionPhase` updater and called `onRestored` after it, which **never
   * fired**: React does not invoke an updater synchronously, so the variable it assigned was still
   * `null` by the time the line after read it. The e2e caught it as a sidebar that never learned about
   * the database it had just created. Derived from the phase instead, which cannot be out of step with
   * it, and it fires once because the value only changes on the transition. `onRestored` is
   * `useCallback`-stable in the host for the same reason.
   */
  const restoredTarget = phase.kind === 'done' ? phase.plan.targetDatabase : null;
  useEffect(() => {
    if (restoredTarget === null) return;
    onRestored(restoredTarget);
  }, [restoredTarget, onRestored]);

  /**
   * Ask the main process to run the plan, having already earned the right to.
   *
   * Every caller has passed the confirmation gate; the guard at the top is the belt-and-braces half of
   * property 2 in this file's header — the button being unreachable is the braces.
   */
  const runPlan = async (plan: RestorePlan): Promise<void> => {
    if (inFlight !== null) return;
    if (!confirmationSatisfied(values.confirmation, plan.targetDatabase, plan.kind)) return;

    const key = dbOperationKey(connectionId, plan.targetDatabase);
    setActionHint(undefined);
    dbOperationsStore.getState().begin(key, 'restore', plan.backupPath);

    if (plan.createsTarget) {
      setActionPhase({ kind: 'preparing', plan });
      const created = await createTargetDatabase(plan);
      if (!created) {
        // Nothing is running, so the record must not keep saying one is — otherwise a target that
        // could not be created would be locked out of the feature for the rest of the session.
        dbOperationsStore.getState().retire(key);
        return;
      }
    }

    setActionPhase({ kind: 'running', plan, restoreId: null, progress: null });

    const request: RestoreRequest = {
      connectionId,
      backupPath: plan.backupPath,
      targetDatabase: plan.targetDatabase,
      withReplace: plan.overwrite,
      ...(options.showRecoveryState ? { withNoRecovery: plan.noRecovery } : {}),
      ...(plan.relocations.length > 0
        ? {
            fileRelocations: plan.relocations.map(relocation => ({
              logicalName: relocation.logicalName,
              physicalName: relocation.newPath,
            })),
          }
        : {}),
    };

    start.mutate([request], {
      onSuccess: started => {
        // `restore.start` is declared `Promise<void>` in preload, but `backup.ipc.ts:105-113` returns
        // the operation id for every engine — so it is recovered by inspection rather than by type,
        // and the dialog carries on binding from the first event when it is absent (J-48 item h).
        const id: unknown = started;
        if (typeof id !== 'string' || id === '') return;
        setActionPhase(previous => (previous === null ? null : bindRestoreRunId(previous, id)));
        dbOperationsStore.getState().bind(key, id);
      },
      onError: error => {
        diagnostics.error('the restore could not be started', error);
        // The target was created before this call, so a start that never happened still leaves it
        // behind — the failure has to name it. See `RestorePhase`'s `leftoverDatabase`.
        setActionPhase({
          kind: 'failed',
          message: error.message,
          ...(plan.createsTarget ? { leftoverDatabase: plan.targetDatabase } : {}),
        });
        dbOperationsStore.getState().retire(key);
      },
    });
  };

  /**
   * `CREATE DATABASE`, for the one engine whose restore tool will not.
   *
   * A visible DDL side effect on the way to another one, so it gets its own phase rather than being
   * hidden inside the progress spinner. `database.create` **resolves with `{ success: false }`** rather
   * than rejecting (`database.ipc.ts:43-50`), so both halves are handled.
   */
  const createTargetDatabase = async (plan: RestorePlan): Promise<boolean> => {
    try {
      const result = await createDatabase.mutateAsync([
        connectionId,
        { name: plan.targetDatabase },
      ]);
      if (result.success) return true;
      setActionPhase({
        kind: 'failed',
        message:
          `${plan.targetDatabase} could not be created, so there is nothing for the restore to write into. ${result.error ?? ''}`.trim(),
      });
      return false;
    } catch (error) {
      diagnostics.error('the restore target could not be created', error);
      setActionPhase({
        kind: 'failed',
        message: `${plan.targetDatabase} could not be created, so there is nothing for the restore to write into. ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  };

  /** The options screen's primary: validate, freeze the plan, and either confirm it or run it. */
  const reviewOrRun = form.handleSubmit(current => {
    if (inFlight !== null) return;
    if (problem !== null) {
      setActionHint(problem);
      form.setFocus(current.backupPath.trim() === '' ? 'backupPath' : 'targetDatabase');
      return;
    }

    const plan = planFor(current, engine, targetKind, relocations);
    setActionHint(undefined);
    form.setValue('confirmation', '');
    if (confirmationRequired(plan.kind)) {
      setActionPhase({ kind: 'confirming', plan });
      return;
    }
    void runPlan(plan);
  });

  /** The native open dialog, for the engines whose archive is on this machine. */
  const chooseLocalPath = async (): Promise<void> => {
    try {
      const result = await openDialog.mutateAsync([
        {
          title: 'Choose the backup to restore',
          filters: [
            {
              name: engine === 'mysql' ? 'SQL dump' : 'pg_dump archive',
              extensions: [options.extension],
            },
            { name: 'All files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        },
      ]);
      const picked = result.filePaths[0];
      if (result.canceled || picked === undefined) return;
      applySource(picked);
    } catch (error) {
      diagnostics.error('the open dialog could not be opened', error);
      setActionHint('Joinery could not open the file dialog. Type the path instead.');
    }
  };

  /**
   * Adopt a newly picked archive: the path, the header read, and a target name when none was chosen.
   *
   * The suggestion is only ever written into an untouched field, and it is deliberately the archive's
   * *stem* rather than its source database — restoring onto the same name is the destructive case, and
   * a wizard should not pre-select it.
   */
  const applySource = (path: string): void => {
    form.setValue('backupPath', path, { shouldDirty: true });
    setInspectedPath(path);
    setActionHint(undefined);
    setRelocationEdits({});
    if (form.getFieldState('targetDatabase').isDirty) return;
    const suggestion = suggestedTargetName(path);
    if (suggestion === '') return;
    form.setValue('targetDatabase', suggestion);
    setNamingNewTarget(true);
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

  const busy = phase.kind === 'running' || phase.kind === 'preparing';
  /** Read-only while it runs and after it has finished; editable in `failed`, which is the retry. */
  const controlsDisabled = busy || phase.kind === 'done';

  // ── The browser step replaces the body and the actions, per `ServerFileBrowser`'s header ──
  if (browsing) {
    return (
      <RestoreShell
        title="Choose a backup file"
        description="Folders on the database server, as the server sees them."
        onDismiss={onDismiss}
      >
        <ServerFileBrowser
          connectionId={connectionId}
          mode="open"
          initialPath={values.backupPath === '' ? undefined : values.backupPath}
          extension={options.extension}
          onCancel={() => setBrowsing(false)}
          onPick={pick => {
            applySource(pick.path);
            setBrowsing(false);
          }}
        />
      </RestoreShell>
    );
  }

  if (phase.kind === 'checking') {
    return (
      <RestoreShell
        title="Restore a database"
        description="Checking this machine for the command-line tools the restore needs."
        onDismiss={onDismiss}
      >
        <DialogBody data-testid="restore-tools-checking">
          <div className="flex h-24 items-center justify-center">
            <Spinner label="Checking for the required CLI tools…" />
          </div>
        </DialogBody>
        <DialogActions>
          <Button variant="outline" data-testid="restore-close" onClick={onDismiss}>
            Close
          </Button>
        </DialogActions>
      </RestoreShell>
    );
  }

  if (phase.kind === 'tools-missing') {
    const instructions = phase.result.installInstructions;
    return (
      <RestoreShell
        title="Restore a database"
        description="One more step before Joinery can restore this archive."
        onDismiss={onDismiss}
      >
        <DialogBody>
          {instructions === undefined ? (
            <FormNote data-testid="restore-tools-unknown">
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
        <FormAnswerBand hint={hint} hintTestId="restore-hint" />
        <DialogActions>
          <Button variant="outline" data-testid="restore-close" onClick={onDismiss}>
            Close
          </Button>
        </DialogActions>
      </RestoreShell>
    );
  }

  // ── The point of no return ───────────────────────────────────────────────────────────────
  if (phase.kind === 'confirming') {
    return (
      <RestoreShell
        title={`Overwrite ${phase.plan.targetDatabase}?`}
        description="This cannot be undone, and it cannot be stopped once it starts."
        onDismiss={onDismiss}
      >
        <ConfirmBody
          plan={phase.plan}
          engine={engine}
          unknownList={phase.plan.kind === 'unknown'}
          typed={values.confirmation}
          // An operation can begin against this target *while the confirmation is open* — a dump
          // started from the sidebar, or a restore left running in a dialog opened before this one —
          // and `runPlan`'s first line then refuses. Refused silently, the primary button would do
          // nothing on a screen whose whole job is telling the user what pressing it does, so the
          // refusal is stated here and the button is disabled by the same value.
          blocked={inFlight !== null}
          onType={next => form.setValue('confirmation', next)}
          onSubmit={() => void runPlan(phase.plan)}
        />
        <FormAnswerBand hint={hint} hintTestId="restore-hint">
          {inFlight === null ? null : <InFlightPanel run={inFlight} />}
        </FormAnswerBand>
        <DialogActions>
          <Button
            variant="ghost"
            data-testid="restore-confirm-back"
            onClick={() => {
              form.setValue('confirmation', '');
              setActionPhase({ kind: 'options' });
            }}
          >
            Back
          </Button>
          <Button
            // HOUSE-RULES puts destructive confirmation among the jobs of the dialog's single
            // filled affordance, and `danger` is deliberately the muted outline variant.
            variant="primary"
            leadingIcon={HardDriveDownload}
            // The gate. `runPlan` re-checks it as well — see property 2 in this file's header.
            // `inFlight` is the second reason it can refuse, and it is disabled for that too so the
            // button and `runPlan` agree about when pressing it will do something.
            disabled={
              inFlight !== null ||
              !confirmationSatisfied(
                values.confirmation,
                phase.plan.targetDatabase,
                phase.plan.kind
              )
            }
            data-testid="restore-confirm-start"
            onClick={() => void runPlan(phase.plan)}
          >
            Restore over {phase.plan.targetDatabase}
          </Button>
        </DialogActions>
      </RestoreShell>
    );
  }

  return (
    <RestoreShell
      title="Restore a database"
      description={
        serverSide
          ? 'SQL Server reads the file itself, so the path is a path on the server.'
          : 'The archive is read on this machine by the command-line tools.'
      }
      onDismiss={onDismiss}
      // While Joinery is creating the target or the restore is streaming, the only way out is the
      // action row's Close — see `RestoreShell`'s header for why Escape is not one of them.
      dismissable={!busy}
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={event => {
          void reviewOrRun(event);
        }}
      >
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <Input
              label={options.pathLabel}
              fieldClassName="flex-1"
              className="font-mono"
              placeholder={options.pathPlaceholder}
              disabled={controlsDisabled}
              data-testid="restore-path"
              {...form.register('backupPath')}
            />
            <Button
              variant="outline"
              leadingIcon={FolderOpen}
              disabled={controlsDisabled}
              data-testid="restore-browse"
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
            {serverSide ? (
              <Button
                variant="outline"
                disabled={controlsDisabled || values.backupPath.trim() === ''}
                data-testid="restore-read-header"
                onClick={() => setInspectedPath(values.backupPath.trim())}
              >
                Read
              </Button>
            ) : null}
          </div>

          {options.formatNote === null ? null : (
            <FormNote data-testid="restore-format-note">{options.formatNote}</FormNote>
          )}

          {serverSide ? (
            <BackupHeader
              info={backupInfo.data ?? null}
              loading={backupInfo.isFetching}
              error={backupInfo.error}
            />
          ) : null}

          <FormSection title="Restore into">
            <Select
              label="Database"
              name="restoreTargetChoice"
              value={namingNewTarget ? NEW_TARGET : values.targetDatabase}
              disabled={controlsDisabled}
              onValueChange={next => {
                if (next === NEW_TARGET) {
                  setNamingNewTarget(true);
                  return;
                }
                setNamingNewTarget(false);
                form.setValue('targetDatabase', next, { shouldDirty: true });
              }}
              data-testid="restore-target"
            >
              {(databases ?? []).map(name => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
              <SelectItem value={NEW_TARGET} disabled={!canCreateDatabases}>
                A database that does not exist yet…
              </SelectItem>
            </Select>

            {namingNewTarget ? (
              <Input
                label="Name"
                className="font-mono"
                disabled={controlsDisabled}
                data-testid="restore-target-name"
                {...form.register('targetDatabase')}
              />
            ) : null}

            {/* Only while the form can still be acted on. The note is about what pressing the button
                WOULD do, and after a restore has landed "…you will be asked to confirm" describes a
                step that is already behind the user — the gate's success shot caught it saying so. */}
            {controlsDisabled ? null : (
              <TargetNote
                engine={engine}
                kind={targetKind}
                name={values.targetDatabase.trim()}
                canCreateDatabases={canCreateDatabases}
              />
            )}
          </FormSection>

          <FormSection title="Options">
            <Checkbox
              label="Overwrite what is already there"
              hint={options.overwriteHint}
              disabled={controlsDisabled}
              data-testid="restore-overwrite"
              {...form.register('overwrite')}
            />
            {options.showRecoveryState ? (
              <Checkbox
                label="Leave the database recovering (NORECOVERY)"
                hint="For restoring further differential or log backups afterwards. The database is unusable until one is restored WITH RECOVERY."
                disabled={controlsDisabled}
                data-testid="restore-norecovery"
                {...form.register('noRecovery')}
              />
            ) : null}
          </FormSection>

          {options.showRelocations && relocations.length > 0 ? (
            <FormSection title="Where the files go">
              <FormNote>
                SQL Server writes the database files at the paths inside the backup unless it is
                told otherwise, and those paths belong to the database the backup came from.
              </FormNote>
              <ul className="flex flex-col gap-2" data-testid="restore-relocations">
                {relocations.map(relocation => (
                  <li key={relocation.logicalName}>
                    <Input
                      label={`${relocation.logicalName} · ${relocation.fileType === 'L' ? 'log' : 'data'}`}
                      name={`relocation-${relocation.logicalName}`}
                      className="font-mono"
                      disabled={controlsDisabled}
                      value={relocation.newPath}
                      data-testid="restore-relocation"
                      onChange={event =>
                        setRelocationEdits(previous => ({
                          ...previous,
                          [relocation.logicalName]: event.target.value,
                        }))
                      }
                    />
                  </li>
                ))}
              </ul>
            </FormSection>
          ) : null}

          {options.showTsqlPreview ? (
            <FormSection title="Statement">
              {/* CLAUDE.md's SQL-transparency rule: the statement shown IS the statement
                  `TsqlBuilder.restore` will run, STATS and the implicit RECOVERY included. */}
              <pre
                data-testid="restore-tsql"
                className="overflow-x-auto rounded-sm border border-rule bg-canvas p-2 font-mono text-sm whitespace-pre-wrap text-fg"
              >
                {restoreTsql(values, relocations)}
              </pre>
            </FormSection>
          ) : null}

          {options.showHistory ? (
            <FormSection title="Recent backups on this server">
              <RestoreHistory
                entries={history.data ?? []}
                loading={history.isPending}
                failed={history.error !== null}
                disabled={controlsDisabled}
                onPick={entry => applySource(entry.physicalDeviceName)}
              />
            </FormSection>
          ) : null}
        </DialogBody>

        {/* One band, four phases, and one child expression — three sibling ternaries would make
            `children` an ARRAY of nulls, which is not `null`, and the band would render its rule and
            its padding around nothing. Task 12's gate photographed that strip. */}
        <FormAnswerBand hint={hint} hintTestId="restore-hint" data-testid="restore-answer-band">
          {answerPanel(phase, inFlight)}
        </FormAnswerBand>

        <DialogActions>
          <Button
            variant="ghost"
            data-testid={phase.kind === 'options' ? 'restore-cancel' : 'restore-close'}
            onClick={onDismiss}
          >
            {phase.kind === 'options' ? 'Cancel' : 'Close'}
          </Button>
          {phase.kind === 'failed' ? (
            <Button
              variant="primary"
              data-testid="restore-retry"
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
              leadingIcon={HardDriveDownload}
              disabled={inFlight !== null}
              // One testid whatever the label says, because it names the control rather than the
              // state: an id that flipped would make "the safe path skips the confirmation" a test
              // about a selector instead of about the flow. The LABEL is the signal, and both specs
              // assert on it.
              data-testid="restore-submit"
            >
              {confirmationRequired(targetKind) ? 'Review the restore' : 'Start restore'}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </RestoreShell>
  );
}

/**
 * Whatever the last action had to say, as **one** node or `null`. See `FormAnswerBand`'s header for
 * why a function rather than sibling ternaries.
 */
function answerPanel(phase: RestorePhase, inFlight: DbOperationRun | null): ReactNode {
  if (phase.kind === 'preparing') return <PreparingPanel plan={phase.plan} />;
  if (phase.kind === 'running') return <ProgressPanel phase={phase} />;
  if (phase.kind === 'done') return <DonePanel plan={phase.plan} elapsedMs={phase.elapsedMs} />;
  if (phase.kind === 'failed') {
    return <FailedPanel message={phase.message} leftoverDatabase={phase.leftoverDatabase} />;
  }
  if (inFlight !== null) return <InFlightPanel run={inFlight} />;
  return null;
}

/**
 * The dialog frame every phase shares, so there is exactly one `Dialog` root for the whole flow —
 * including the browser step, which is why that step is a body swap rather than a nested modal.
 *
 * `dismissable` is **one** flag for every way out of the frame, and that is the point: it used to
 * only hide the header's close button, while Radix's own `onOpenChange` still fired for Escape and for
 * a click on the overlay. So a phase that had deliberately taken the close button away could still be
 * dismissed by pressing Escape — a headless exit past the affordance that was hidden to say "not from
 * here". The chrome and the keyboard now answer to the same value; a phase that wants to be left
 * deliberately offers a button in the action row instead (`running` does).
 */
function RestoreShell({
  title,
  description,
  onDismiss,
  dismissable = true,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly onDismiss: () => void;
  readonly dismissable?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (open) return;
        if (!dismissable) return;
        onDismiss();
      }}
    >
      <DialogContent size="md" data-testid="restore-dialog">
        <DialogHeader showClose={dismissable}>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <Icon icon={HardDriveDownload} size="sm" className="stroke-fg-muted" />
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
 * The confirmation body: what is about to happen, in the plainest words available, and a box that
 * only accepts the name of the thing being destroyed.
 *
 * `Enter` in the box submits, but only through the same predicate the button is disabled by — so the
 * keyboard path and the pointer path cannot disagree, which is the failure mode a separate `onKeyDown`
 * handler invites.
 */
function ConfirmBody({
  plan,
  engine,
  unknownList,
  typed,
  blocked,
  onType,
  onSubmit,
}: {
  readonly plan: RestorePlan;
  readonly engine: DatabaseEngine;
  readonly unknownList: boolean;
  readonly typed: string;
  /** Something else is already running against this target, so `runPlan` will refuse. */
  readonly blocked: boolean;
  readonly onType: (next: string) => void;
  readonly onSubmit: () => void;
}) {
  const options = engineRestoreOptions(engine);
  // The same predicate the button is disabled by, so the keyboard path cannot diverge from the pointer
  // path — which is the failure mode a bespoke comparison here invites. `blocked` is the button's
  // other disabled reason, and it is read here for the same reason.
  const matches = !blocked && confirmationSatisfied(typed, plan.targetDatabase, plan.kind);

  // Focus lands in the box the moment this phase appears. An effect rather than `autoFocus`, which
  // `jsx-a11y/no-autofocus` bans and which would also re-fire nothing useful on a re-render: the body
  // is swapped in place, so without this the focus would be left on a button that no longer exists.
  const box = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <DialogBody className="flex flex-col gap-3" data-testid="restore-confirm">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-sm border-l-2 border-danger bg-surface p-3"
      >
        <Icon icon={TriangleAlert} size="md" className="mt-0.5 shrink-0 stroke-danger" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-md text-fg">
            {unknownList
              ? `Joinery could not read this server’s database list, so it cannot tell whether ${plan.targetDatabase} already exists.`
              : `${plan.targetDatabase} already exists on this server.`}
          </p>
          <p className="text-sm break-words text-fg-muted text-pretty">
            {plan.overwrite
              ? options.overwriteHint
              : 'Restoring into it writes the archive’s contents over what is there now.'}{' '}
            Anything in it that is not in the backup is gone, and there is no undo — the restore
            cannot be cancelled once it starts.
          </p>
        </div>
      </div>

      <dl className="flex flex-col gap-1 rounded-sm border border-rule bg-surface p-3">
        <ConfirmRow label="From" value={plan.backupPath} />
        <ConfirmRow label="Into" value={plan.targetDatabase} />
        <ConfirmRow label="Overwrite" value={plan.overwrite ? 'yes' : 'no'} />
      </dl>

      <Input
        label={`Type ${plan.targetDatabase} to confirm`}
        ref={box}
        name="restoreConfirmation"
        hint="Exactly, including capitals — database names can be case-sensitive."
        className="font-mono"
        value={typed}
        data-testid="restore-confirm-input"
        onChange={event => onType(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (matches) onSubmit();
        }}
      />
    </DialogBody>
  );
}

function ConfirmRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-20 shrink-0 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
        {label}
      </dt>
      <dd className="min-w-0 font-mono text-sm break-all text-fg">{value}</dd>
    </div>
  );
}

/** What the chosen target means, said once, under the picker. */
function TargetNote({
  engine,
  kind,
  name,
  canCreateDatabases,
}: {
  readonly engine: DatabaseEngine;
  readonly kind: TargetKind;
  readonly name: string;
  readonly canCreateDatabases: boolean;
}) {
  if (name === '') return null;
  if (kind === 'overwrite') {
    return (
      <FormNote data-testid="restore-target-note">
        {name} already exists — you will be asked to confirm before anything is written.
      </FormNote>
    );
  }
  if (kind === 'unknown') {
    return (
      <FormNote data-testid="restore-target-note">
        Joinery could not read the database list, so it cannot tell whether {name} exists. You will
        be asked to confirm before anything is written.
      </FormNote>
    );
  }
  if (targetCreatedBy(engine) === 'joinery') {
    return (
      <FormNote data-testid="restore-target-note">
        {canCreateDatabases
          ? `Joinery will create ${name} first — pg_restore cannot create a database itself.`
          : `pg_restore cannot create a database, and this connection is not allowed to either.`}
      </FormNote>
    );
  }
  return (
    <FormNote data-testid="restore-target-note">
      {name} does not exist yet; the restore creates it.
    </FormNote>
  );
}

/** `RESTORE HEADERONLY`, once it has been read. MSSQL only — see the query's comment. */
function BackupHeader({
  info,
  loading,
  error,
}: {
  readonly info: {
    readonly databaseName: string;
    readonly backupType?: string;
    readonly backupFinishDate?: string;
    readonly backupSizeBytes?: number;
  } | null;
  readonly loading: boolean;
  readonly error: Error | null;
}) {
  if (loading) return <Spinner size="sm" label="Reading the backup header…" />;
  if (error !== null) {
    return (
      <FormNote data-testid="restore-header-error">
        That backup file could not be read: {error.message}
      </FormNote>
    );
  }
  if (info === null) return null;

  return (
    <dl
      className="flex flex-col gap-1 rounded-sm border border-rule bg-surface p-3"
      data-testid="restore-backup-info"
    >
      <ConfirmRow label="Database" value={info.databaseName} />
      {info.backupType === undefined ? null : <ConfirmRow label="Type" value={info.backupType} />}
      {info.backupFinishDate === undefined ? null : (
        <ConfirmRow label="Taken" value={formatTimestamp(info.backupFinishDate)} />
      )}
      {info.backupSizeBytes === undefined ? null : (
        <ConfirmRow label="Size" value={formatBytes(info.backupSizeBytes)} />
      )}
    </dl>
  );
}

/** Joinery creating the target, before the restore that needs it. */
function PreparingPanel({ plan }: { readonly plan: RestorePlan }) {
  return (
    <div
      className="flex items-center gap-2 rounded-sm border border-rule bg-surface p-3"
      data-testid="restore-preparing"
    >
      <Spinner size="sm" label={`Creating ${plan.targetDatabase}…`} />
    </div>
  );
}

/** The live stream, in the same slot the success and the failure will use. */
function ProgressPanel({ phase }: { readonly phase: Extract<RestorePhase, { kind: 'running' }> }) {
  const percent = progressPercent(phase.progress);
  const label = restoreProgressLabel(phase.progress);

  return (
    <div
      className="flex flex-col gap-2 rounded-sm border border-rule bg-surface p-3"
      data-testid="restore-progress"
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
        aria-label="Restore progress"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted entirely when indeterminate, which is what tells assistive technology "unknown"
        // rather than "zero". pg_restore and the mysql client report no percentage at all.
        aria-valuenow={percent ?? undefined}
        data-testid="restore-progress-bar"
        className="h-1.5 overflow-hidden rounded-full bg-active"
      >
        <div
          className={cn(
            'h-full rounded-full bg-accent',
            percent === null ? 'w-full animate-pulse' : 'w-(--restore-percent)'
          )}
          style={
            percent === null
              ? undefined
              : ({ '--restore-percent': `${percent}%` } as unknown as CSSProperties)
          }
        />
      </div>
      <p className="text-sm text-fg-muted text-pretty">
        Closing this dialog won’t stop the restore — it will finish in the background.
      </p>
    </div>
  );
}

/** Success, naming the database that now holds the archive's contents. */
function DonePanel({
  plan,
  elapsedMs,
}: {
  readonly plan: RestorePlan;
  readonly elapsedMs: number | undefined;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-sm border-l-2 border-success bg-surface p-3"
      data-testid="restore-success"
    >
      <Icon icon={CircleCheck} size="md" className="mt-0.5 shrink-0 stroke-success" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md text-fg">
          Restore complete
          {elapsedMs === undefined ? null : (
            <span className="text-fg-muted tabular-nums"> · {Math.round(elapsedMs / 1000)}s</span>
          )}
        </p>
        <p
          data-testid="restore-success-target"
          className="font-mono text-sm break-all text-fg-muted"
        >
          {plan.targetDatabase}
        </p>
      </div>
    </div>
  );
}

/**
 * The failure, in the same slot the progress was in — plus the database Joinery left behind.
 *
 * The second paragraph is the disclosure `RestorePhase`'s `leftoverDatabase` exists for: on
 * PostgreSQL the target is created *before* `pg_restore` runs, so a failure leaves an empty database
 * on the server that the user never asked for by name. Saying so is also what makes the retry
 * comprehensible — the target exists now, so `Try again` will ask for the typed-name confirmation,
 * and a confirmation nobody can explain is a confirmation people learn to type through.
 */
function FailedPanel({
  message,
  leftoverDatabase,
}: {
  readonly message: string;
  readonly leftoverDatabase: string | undefined;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-sm border-l-2 border-danger bg-surface p-3"
      data-testid="restore-error"
    >
      <Icon icon={CircleX} size="md" className="mt-0.5 shrink-0 stroke-danger" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md text-fg">The restore failed</p>
        <p className="text-sm break-words text-fg-muted text-pretty">{message}</p>
        {leftoverDatabase === undefined ? null : (
          <p
            data-testid="restore-error-leftover"
            className="text-sm break-words text-fg-muted text-pretty"
          >
            <span className="font-mono break-all">{leftoverDatabase}</span> was created before the
            restore failed and is still there, empty. Drop it yourself if you do not want it —
            trying again restores into it, which is why the confirmation asks for its name.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The form, opened onto a database this window is already dumping or restoring.
 *
 * Blocking rather than warning, for the reason `state/db-operations.ts` sets out: nothing in
 * `packages/main` refuses a second operation on one database, there is no working cancel to recover
 * with, and the two failure modes — a corrupt archive and a half-restored database — are both silent.
 */
function InFlightPanel({ run }: { readonly run: DbOperationRun }) {
  const dumping = run.kind === 'backup';
  return (
    <div
      className="flex items-start gap-2 rounded-sm border-l-2 border-warning bg-surface p-3"
      data-testid="restore-in-flight"
    >
      <Icon icon={TriangleAlert} size="md" className="mt-0.5 shrink-0 stroke-warning" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md text-fg">
          {dumping
            ? 'A backup of this database is still running'
            : 'A restore into this database is still running'}
        </p>
        <p className="text-sm break-words text-fg-muted text-pretty">
          Started from this window, {dumping ? 'writing to ' : 'restoring from '}
          <span className="font-mono break-all">{run.path}</span>. Wait for it to finish — neither
          can be cancelled, and restoring over a database that something else is mid-way through
          leaves both jobs holding half of it.
        </p>
      </div>
    </div>
  );
}

/**
 * `msdb`'s record of what has been backed up, offered as a source picker.
 *
 * MSSQL-only — `backup.ipc.ts:125-128` answers `[]` for PG and MySQL — which is why the panel is gated
 * on the engine rather than on the list being empty.
 */
function RestoreHistory({
  entries,
  loading,
  failed,
  disabled,
  onPick,
}: {
  readonly entries: readonly BackupHistoryEntry[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly disabled: boolean;
  readonly onPick: (entry: BackupHistoryEntry) => void;
}) {
  if (loading) return <Spinner size="sm" label="Reading the backup history…" />;
  if (failed) {
    return (
      <FormNote data-testid="restore-history-error">The backup history could not be read.</FormNote>
    );
  }
  if (entries.length === 0) {
    return (
      <FormNote data-testid="restore-history-empty">No backups recorded on this server.</FormNote>
    );
  }

  return (
    <ul className="flex max-h-40 flex-col overflow-y-auto" data-testid="restore-history">
      {entries.map(entry => (
        <li key={`${entry.backupStartDate}-${entry.physicalDeviceName}`}>
          <button
            type="button"
            disabled={disabled}
            data-testid="restore-history-entry"
            className={cn(
              'flex w-full flex-col gap-0.5 border-b border-rule py-1.5 text-left last:border-b-0',
              'hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus'
            )}
            onClick={() => onPick(entry)}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-base text-fg">
                {entry.databaseName} · {entry.backupType}
              </span>
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
          </button>
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
