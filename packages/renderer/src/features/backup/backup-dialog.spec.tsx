/**
 * The wizard, mounted for real against a partial bridge.
 *
 * What is worth asserting here, and why each one is a live risk rather than a restatement of the code:
 *
 *  - **The CLI-missing branch is reachable.** It is the branch that only exists because the tools are
 *    deliberately not bundled, and the only Angular spec that covered it needed a restricted `PATH` and
 *    a real Electron launch. Here the probe is a mock, so the branch — and its recovery — is asserted
 *    in milliseconds and cannot rot unnoticed between e2e runs.
 *  - **No toast, ever, while the dialog is open.** J-42: sonner sits above Radix's scrim but Radix
 *    disables pointer events on everything outside the dialog, so a toast raised here is visible and
 *    inert. The Angular dialog reported five different outcomes that way. A recording notifier is
 *    installed in every `beforeEach` — so a stray `notify` is capturable anywhere — and asserted empty
 *    at each of the outcomes Angular toasted: the completion, the failure, the probe error, the
 *    re-check failure, the clipboard copy, and now the refusal to start a second dump.
 *  - **The progress stream reaches a terminal state.** `backup.onProgress` is the only signal a dump
 *    has finished; a subscription that is torn down or bound to the wrong operation shows up as a
 *    dialog that spins forever, which is exactly what a screenshot cannot catch.
 *  - **The option matrix is what the engine actually honours.** Asserted through the rendered controls,
 *    not just through `backup-model.spec.ts`'s matrix, because the two can disagree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `act` from Testing Library, not from `react`: TL's wrapper sets `IS_REACT_ACT_ENVIRONMENT` around the
// call. React's bare export warns "the current testing environment is not configured to support act".
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  BackupHistoryEntry,
  BackupProgress,
  CliDepsResult,
  ConnectionProfile,
  DatabaseEngine,
  ServerDefaultPaths,
} from '@joinery/shared';

import {
  installJoineryMock,
  recordSubscription,
  removeJoineryMock,
  type RecordedSubscription,
} from '../../test/joinery-mock';
import { dispatchCommand } from '../../commands';
import { IpcQueryProvider } from '../../ipc';
import { TooltipProvider } from '../../ui';
import { connectionStore } from '../../state/connection';
import { resetDbOperationsForTests } from '../../state/db-operations';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { BackupDialog, type BackupRunCoordination } from './backup-dialog';
import { BackupDialogs } from './backup-dialogs';

const CONNECTION_ID = 'conn-1';
const DATABASE = 'joinery_test';

const TOOLS_PRESENT: CliDepsResult = {
  engine: 'postgresql',
  platform: 'darwin',
  tools: [
    { tool: 'pg_dump', available: true, version: 'pg_dump (PostgreSQL) 16.1' },
    { tool: 'pg_restore', available: true, version: 'pg_restore (PostgreSQL) 16.1' },
  ],
  allAvailable: true,
};

const TOOLS_MISSING: CliDepsResult = {
  engine: 'postgresql',
  platform: 'darwin',
  tools: [
    { tool: 'pg_dump', available: false },
    { tool: 'pg_restore', available: false },
  ],
  allAvailable: false,
  installInstructions: {
    engine: 'postgresql',
    platform: 'darwin',
    title: 'Install PostgreSQL client tools',
    steps: [
      { description: 'Install them with Homebrew.', command: 'brew install postgresql@16' },
      {
        description: 'Or download the installer.',
        link: { url: 'https://www.postgresql.org/download/', label: 'postgresql.org downloads' },
      },
    ],
    notes: ['postgresql@16 is keg-only, so its bin directory has to be on your PATH.'],
  },
};

const DEFAULT_PATHS: ServerDefaultPaths = {
  dataPath: 'C:\\Data\\',
  logPath: 'C:\\Logs\\',
  backupPath: 'C:\\Backups\\',
};

const HISTORY: BackupHistoryEntry[] = [
  {
    databaseName: DATABASE,
    backupType: 'Full',
    backupStartDate: '2026-08-15T02:00:00.000Z',
    backupFinishDate: '2026-08-15T02:04:00.000Z',
    backupSizeBytes: 5 * 1024 * 1024,
    physicalDeviceName: 'C:\\Backups\\joinery_test_full.bak',
    serverName: 'SQL01',
    recoveryModel: 'FULL',
    userName: 'sa',
  },
];

interface Bridge {
  readonly checkTools: ReturnType<typeof vi.fn>;
  readonly recheckTools: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly getHistory: ReturnType<typeof vi.fn>;
  readonly getDefaultPaths: ReturnType<typeof vi.fn>;
  readonly showSaveDialog: ReturnType<typeof vi.fn>;
  readonly openExternal: ReturnType<typeof vi.fn>;
  readonly progress: RecordedSubscription<BackupProgress>;
}

const teardowns: (() => void)[] = [];
let bridge: Bridge;
/** Every notification raised during a test. Asserted empty — see the header. */
let notifications: string[] = [];

function installBridge(tools: CliDepsResult): Bridge {
  const progress = recordSubscription<BackupProgress>();
  const installed: Bridge = {
    checkTools: vi.fn(() => Promise.resolve(tools)),
    recheckTools: vi.fn(() => Promise.resolve(TOOLS_PRESENT)),
    // Resolves with an operation id, because every engine's `backup.start` handler does
    // (`backup.ipc.ts:49`). This double used to resolve with `undefined`, faithfully modelling
    // the preload declaration that was wrong (J-48h) rather than the handler that was right.
    start: vi.fn(() => Promise.resolve('op-1')),
    getHistory: vi.fn(() => Promise.resolve(HISTORY)),
    getDefaultPaths: vi.fn(() => Promise.resolve(DEFAULT_PATHS)),
    showSaveDialog: vi.fn(() => Promise.resolve({ canceled: false, filePath: '/tmp/chosen.dump' })),
    openExternal: vi.fn(() => Promise.resolve()),
    progress,
  };

  teardowns.push(
    installJoineryMock({
      backup: {
        checkTools: installed.checkTools,
        recheckTools: installed.recheckTools,
        start: installed.start,
        getHistory: installed.getHistory,
        onProgress: progress.subscribe,
      },
      serverFs: {
        getDefaultPaths: installed.getDefaultPaths,
        getDrives: () => Promise.resolve([{ drive: 'C:', freeSpaceMB: 51_200 }]),
        listDirectory: () => Promise.resolve([]),
      },
      app: {
        showSaveDialog: installed.showSaveDialog,
        openExternal: installed.openExternal,
      },
      connection: { list: () => Promise.resolve([]) },
    })
  );
  return installed;
}

/**
 * An in-flight record that knows about nothing.
 *
 * The real one lives in `backup-dialogs.tsx` and outlives the dialog, so the tests that exercise it
 * mount `BackupDialogs` (see "one run at a time, across close and re-open"). Everything else in this
 * file is about the dialog on its own, and an inert record keeps that separation honest: the dialog's
 * `isForeignRun` answering `false` is exactly the state it is in before any other run exists.
 */
function inertRun(): BackupRunCoordination {
  return {
    inFlight: null,
    onStarted: () => undefined,
    onBound: () => undefined,
    onFailedToStart: () => undefined,
    isForeignRun: () => false,
  };
}

function mountDialog(
  engine: DatabaseEngine,
  onDismiss = () => undefined,
  run: BackupRunCoordination = inertRun()
) {
  return render(
    <IpcQueryProvider>
      <TooltipProvider>
        <BackupDialog
          connectionId={CONNECTION_ID}
          databaseName={DATABASE}
          engine={engine}
          run={run}
          onDismiss={onDismiss}
        />
      </TooltipProvider>
    </IpcQueryProvider>
  );
}

/**
 * Mounts the dialog and waits for the form.
 *
 * For MSSQL it also waits for the **suggested destination to have landed**, and that wait is
 * load-bearing rather than defensive: `serverFs.getDefaultPaths` resolves after mount and writes the
 * path, so a test that started typing first would have its keystrokes appended to a value that arrived
 * mid-word. (Which is exactly the race the "never overwrites a path the user has already typed" test
 * asserts the guard against — that one installs a deliberately pending query instead.)
 */
async function mountOnForm(engine: DatabaseEngine) {
  const rendered = mountDialog(engine);
  const field = (await screen.findByTestId('backup-path')) as HTMLInputElement;
  if (engine === 'mssql') await waitFor(() => expect(field.value).not.toBe(''));
  return rendered;
}

/** Replace whatever is in the path field. Separate from `type` so the clear is never skipped. */
async function setPath(user: ReturnType<typeof userEvent.setup>, value: string): Promise<void> {
  const field = screen.getByTestId('backup-path');
  await user.clear(field);
  await user.type(field, value);
}

function profile(engine: DatabaseEngine): ConnectionProfile {
  return {
    id: CONNECTION_ID,
    name: 'Test PG',
    engine,
    server: '127.0.0.1',
    port: 15432,
    authenticationType: 'sql',
    username: 'joinery',
    database: DATABASE,
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15,
  } as ConnectionProfile;
}

beforeEach(() => {
  notifications = [];
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
  teardowns.push(
    setNotifier({
      success: message => notifications.push(`success: ${message}`),
      info: message => notifications.push(`info: ${message}`),
      warning: message => notifications.push(`warning: ${message}`),
      error: message => notifications.push(`error: ${message}`),
    })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  // The in-flight record outlives the dialog by design (`state/db-operations.ts`), so it has to be
  // cleared or a test that starts a dump blocks the next one.
  resetDbOperationsForTests();
  connectionStore.setState({
    profiles: [],
    connectedProfileIds: new Set(),
    databasesByConnection: new Map(),
    selectedDatabaseByConnection: new Map(),
  });
  vi.clearAllMocks();
});

// ── the host-tool probe ──────────────────────────────────────────────────────────────────────

describe('the host-tool probe', () => {
  it('shows a spinner for PG until the probe answers, and probes exactly once', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    mountDialog('postgresql');

    expect(screen.getByTestId('backup-tools-checking')).toBeTruthy();
    await screen.findByTestId('backup-path');
    expect(bridge.checkTools).toHaveBeenCalledExactlyOnceWith('postgresql');
  });

  it('never probes for MSSQL, whose server does the work', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    await mountOnForm('mssql');
    expect(bridge.checkTools).not.toHaveBeenCalled();
    // And the spinner state was never on screen at all.
    expect(screen.queryByTestId('backup-tools-checking')).toBeNull();
  });

  it('opens the form with an inline warning when the probe itself fails', async () => {
    const progress = recordSubscription<BackupProgress>();
    teardowns.push(
      installJoineryMock({
        backup: {
          checkTools: () => Promise.reject(new Error('spawn ENOENT')),
          onProgress: progress.subscribe,
        },
      })
    );

    mountDialog('postgresql');

    // Failing to ASK is not being told no — the attempt is still the user's to make.
    await screen.findByTestId('backup-path');
    expect(screen.getByTestId('backup-hint').textContent).toMatch(/could not check/i);
    expect(screen.getByTestId('backup-start')).toBeTruthy();
    // …and it is a hint inside the dialog, not a toast above it.
    expect(notifications).toEqual([]);
  });
});

// ── the missing-tools remediation view ───────────────────────────────────────────────────────

describe('the missing-CLI-tools view', () => {
  beforeEach(() => {
    bridge = installBridge(TOOLS_MISSING);
  });

  it('replaces the form, and says which tools are missing', async () => {
    mountDialog('postgresql');

    const card = await screen.findByTestId('missing-cli-tools');
    expect(card.textContent).toContain('Install PostgreSQL client tools');
    // The three legacy testids the Angular e2e spec asserts on, kept verbatim.
    expect(screen.getByTestId('tool-status-pg_dump').textContent).toMatch(/missing/i);
    expect(screen.getByTestId('tool-status-pg_restore').textContent).toMatch(/missing/i);
    expect(screen.getByTestId('missing-cli-tools-recheck')).toBeTruthy();

    // The form must NOT be behind it — the path field is the one control only the form has.
    expect(screen.queryByTestId('backup-path')).toBeNull();
    expect(screen.queryByTestId('backup-start')).toBeNull();
  });

  it('renders the platform’s own install command and its notes', async () => {
    mountDialog('postgresql');
    const card = await screen.findByTestId('missing-cli-tools');

    expect(card.textContent).toContain('brew install postgresql@16');
    expect(screen.getByTestId('backup-tools-notes').textContent).toContain('keg-only');
  });

  it('copies a command and confirms it in place rather than in a toast', async () => {
    // `userEvent.setup()` installs its OWN `navigator.clipboard` stub, so the spy has to go in after
    // it or it is the thing that gets replaced. This is also the assertion that the confirmation is
    // INSIDE the dialog: the Angular version raised a snackbar here, which a modal makes inert (J-42).
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    teardowns.push(() => Reflect.deleteProperty(navigator, 'clipboard'));

    mountDialog('postgresql');
    await screen.findByTestId('missing-cli-tools');

    await user.click(screen.getByTestId('backup-tools-copy-0'));

    expect(writeText).toHaveBeenCalledWith('brew install postgresql@16');
    // `data-copied`, not `aria-label`: the accessible name says what the button does and must not
    // change, so asserting on it would pass before the click as well as after it.
    await waitFor(() =>
      expect(screen.getByTestId('backup-tools-copy-0').getAttribute('data-copied')).toBe('true')
    );
    expect(notifications).toEqual([]);
  });

  it('hands a download link to the host browser', async () => {
    const user = userEvent.setup();
    mountDialog('postgresql');
    await screen.findByTestId('missing-cli-tools');

    await user.click(screen.getByTestId('backup-tools-link-1'));

    expect(bridge.openExternal).toHaveBeenCalledWith('https://www.postgresql.org/download/');
  });

  it('re-checks and reveals the form once the tools are there', async () => {
    const user = userEvent.setup();
    mountDialog('postgresql');
    await screen.findByTestId('missing-cli-tools');

    await user.click(screen.getByTestId('missing-cli-tools-recheck'));

    // The whole point of the Re-check button: install in another window, come back, carry on — without
    // closing the dialog and losing the form.
    await screen.findByTestId('backup-path');
    expect(bridge.recheckTools).toHaveBeenCalledExactlyOnceWith('postgresql');
    expect(screen.queryByTestId('missing-cli-tools')).toBeNull();
    expect(notifications).toEqual([]);
  });

  it('stays on the card and states why when the re-check itself fails', async () => {
    bridge.recheckTools.mockRejectedValueOnce(new Error('probe crashed'));
    const user = userEvent.setup();
    mountDialog('postgresql');
    await screen.findByTestId('missing-cli-tools');

    await user.click(screen.getByTestId('missing-cli-tools-recheck'));

    await waitFor(() =>
      expect(screen.getByTestId('backup-hint').textContent).toContain('probe crashed')
    );
    expect(screen.getByTestId('missing-cli-tools')).toBeTruthy();
    expect(notifications).toEqual([]);
  });
});

// ── the option matrix, as rendered ───────────────────────────────────────────────────────────

describe('the options, per engine', () => {
  it('gives MSSQL the type picker, compression, a description, the statement and the history', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    await mountOnForm('mssql');

    expect(screen.getByTestId('backup-type')).toBeTruthy();
    expect(screen.getByTestId('backup-compression')).toBeTruthy();
    expect(screen.getByTestId('backup-description')).toBeTruthy();
    expect(screen.getByTestId('backup-tsql')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('backup-history')).toBeTruthy());
    expect(screen.getByTestId('backup-history').textContent).toContain('5 MB');
  });

  it('gives PG none of them, and states the format instead', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    await mountOnForm('postgresql');

    // Every one of these was a control in the Angular dialog that could not change the output — see
    // `backup-model.ts`'s header for the four main-process gaps.
    expect(screen.queryByTestId('backup-type')).toBeNull();
    expect(screen.queryByTestId('backup-compression')).toBeNull();
    expect(screen.queryByTestId('backup-description')).toBeNull();
    expect(screen.queryByTestId('backup-tsql')).toBeNull();
    expect(screen.queryByTestId('backup-history')).toBeNull();
    expect(screen.getByTestId('backup-format-note').textContent).toMatch(/pg_dump/);
    expect(bridge.getHistory).not.toHaveBeenCalled();
  });

  it('renders no answer band at all when there is nothing to say', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    await mountOnForm('postgresql');

    // The band is a rule plus padding above the action row. `FormAnswerBand` returns null only when
    // `children` is `null`, and three sibling ternaries would hand it an ARRAY of three nulls — which
    // is how the first run of the Task 12 gate photographed an empty strip. `answerPanel` is the fix
    // and this is the assertion that keeps it.
    expect(screen.queryByTestId('backup-answer-band')).toBeNull();
    expect(screen.queryByTestId('backup-hint')).toBeNull();
    expect(screen.queryByTestId('backup-progress')).toBeNull();
  });

  it('shows the statement the server will run, INIT and STATS included', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    await mountOnForm('mssql');

    // CLAUDE.md's SQL-transparency rule. The Angular preview omitted both of these and invented two
    // clauses the server never received.
    const sql = screen.getByTestId('backup-tsql').textContent ?? '';
    expect(sql).toContain('BACKUP DATABASE [joinery_test]');
    expect(sql).toContain('WITH INIT, COMPRESSION, STATS = 5;');
  });

  it('suggests a destination from the server’s own backup directory', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    await mountOnForm('mssql');

    await waitFor(() =>
      expect((screen.getByTestId('backup-path') as HTMLInputElement).value).toMatch(
        /^C:\\Backups\\joinery_test_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.bak$/
      )
    );
  });

  it('never overwrites a path the user has already typed', async () => {
    // The Angular version assigned unconditionally, so a slow server raced the user's own typing.
    let resolveDefaults: (paths: ServerDefaultPaths) => void = () => undefined;
    const progress = recordSubscription<BackupProgress>();
    teardowns.push(
      installJoineryMock({
        backup: { getHistory: () => Promise.resolve([]), onProgress: progress.subscribe },
        serverFs: {
          getDefaultPaths: () =>
            new Promise<ServerDefaultPaths>(resolve => {
              resolveDefaults = resolve;
            }),
        },
      })
    );

    const user = userEvent.setup();
    // `mountDialog`, not `mountOnForm`: the suggestion is deliberately still in flight here, which is
    // the whole point, so there is no landed value to wait for.
    mountDialog('mssql');
    await user.type(await screen.findByTestId('backup-path'), 'D:\\mine.bak');

    await act(async () => {
      resolveDefaults(DEFAULT_PATHS);
    });

    expect((screen.getByTestId('backup-path') as HTMLInputElement).value).toBe('D:\\mine.bak');
  });
});

// ── the destination pickers ──────────────────────────────────────────────────────────────────

describe('choosing a destination', () => {
  it('opens the server file browser for MSSQL, in the same dialog', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    const user = userEvent.setup();
    await mountOnForm('mssql');

    await user.click(screen.getByTestId('backup-browse'));

    // One dialog, one scrim — the browser is a body swap, not a nested modal (PLAN.md §2.9).
    expect(screen.getByTestId('backup-file-browser')).toBeTruthy();
    expect(screen.getAllByTestId('backup-dialog')).toHaveLength(1);
    expect(screen.queryByTestId('backup-path')).toBeNull();
  });

  it('returns to the form with the picked path, and keeps what was typed', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    const user = userEvent.setup();
    await mountOnForm('mssql');
    await user.type(screen.getByTestId('backup-description'), 'nightly');

    await user.click(screen.getByTestId('backup-browse'));
    await user.click(screen.getByTestId('backup-file-browser-cancel'));

    // `shouldUnregister` is false, so the description survives the round trip through the browser.
    expect((screen.getByTestId('backup-description') as HTMLInputElement).value).toBe('nightly');
  });

  it('opens the native save dialog for PG, whose destination is local', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    const user = userEvent.setup();
    await mountOnForm('postgresql');

    await user.click(screen.getByTestId('backup-browse'));

    await waitFor(() =>
      expect((screen.getByTestId('backup-path') as HTMLInputElement).value).toBe('/tmp/chosen.dump')
    );
    expect(screen.queryByTestId('backup-file-browser')).toBeNull();
    expect(bridge.showSaveDialog).toHaveBeenCalledOnce();
  });

  it('leaves the path alone when the save dialog is cancelled', async () => {
    bridge = installBridge(TOOLS_PRESENT);
    bridge.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    const user = userEvent.setup();
    await mountOnForm('postgresql');

    await user.click(screen.getByTestId('backup-browse'));

    await waitFor(() => expect(bridge.showSaveDialog).toHaveBeenCalledOnce());
    expect((screen.getByTestId('backup-path') as HTMLInputElement).value).toBe('');
  });
});

// ── the run ──────────────────────────────────────────────────────────────────────────────────

describe('running a backup', () => {
  beforeEach(() => {
    bridge = installBridge(TOOLS_PRESENT);
  });

  it('refuses an empty path inline, and does not call the bridge', async () => {
    const user = userEvent.setup();
    await mountOnForm('postgresql');

    await user.click(screen.getByTestId('backup-start'));

    // A click validates and says why, rather than a disabled button that explains nothing —
    // `buttons.md`, and the same decision `connection-editor.tsx` records.
    expect(screen.getByTestId('backup-hint').textContent).toMatch(
      /where the backup should be written/i
    );
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('sends exactly the request the engine can honour', async () => {
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');

    await user.click(screen.getByTestId('backup-start'));

    await waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
    // No `compression`, no `description`, no engine-specific format — PG reads none of them.
    expect(bridge.start.mock.calls[0]?.[0]).toEqual({
      connectionId: CONNECTION_ID,
      database: DATABASE,
      backupPath: '/tmp/sales.dump',
      backupType: 'full',
    });
  });

  it('sends the MSSQL options that do reach the T-SQL', async () => {
    const user = userEvent.setup();
    await mountOnForm('mssql');
    await setPath(user, 'C:\\Backups\\sales.bak');
    await user.type(screen.getByTestId('backup-description'), 'nightly');

    await user.click(screen.getByTestId('backup-start'));

    await waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
    expect(bridge.start.mock.calls[0]?.[0]).toEqual({
      connectionId: CONNECTION_ID,
      database: DATABASE,
      backupPath: 'C:\\Backups\\sales.bak',
      backupType: 'full',
      compression: true,
      description: 'nightly',
    });
  });

  it('streams progress inline and locks the form while it runs', async () => {
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');
    await user.click(screen.getByTestId('backup-start'));

    const panel = await screen.findByTestId('backup-progress');
    expect(panel.textContent).toContain('Starting the backup');
    expect((screen.getByTestId('backup-path') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('backup-start')).toBeNull();

    act(() => {
      bridge.progress.emit({
        backupId: 'op-1',
        status: 'running',
        percentComplete: -1,
        currentPhase: 'Dumping public.products',
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('backup-progress').textContent).toContain('Dumping public.products')
    );
    // -1 means "no percentage available", which is what pg_dump reports. An indeterminate bar states
    // that by omitting `aria-valuenow` rather than by claiming 0%.
    expect(screen.getByTestId('backup-progress-bar').getAttribute('aria-valuenow')).toBeNull();
  });

  it('paints a real percentage when the engine reports one', async () => {
    const user = userEvent.setup();
    await mountOnForm('mssql');
    await setPath(user, 'C:\\Backups\\sales.bak');
    await user.click(screen.getByTestId('backup-start'));
    await screen.findByTestId('backup-progress');

    act(() => {
      bridge.progress.emit({
        backupId: 'op-1',
        status: 'running',
        percentComplete: 45,
        currentPhase: 'Backing up',
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('backup-progress-bar').getAttribute('aria-valuenow')).toBe('45')
    );
    expect(screen.getByTestId('backup-progress').textContent).toContain('45%');
  });

  it('lands on an inline success state, naming the file — and raises no toast', async () => {
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');
    await user.click(screen.getByTestId('backup-start'));
    await screen.findByTestId('backup-progress');

    act(() => {
      bridge.progress.emit({
        backupId: 'op-1',
        status: 'completed',
        percentComplete: 100,
        elapsedMs: 4200,
      });
    });

    const success = await screen.findByTestId('backup-success');
    expect(success.textContent).toContain('Backup complete');
    expect(screen.getByTestId('backup-success-path').textContent).toBe('/tmp/sales.dump');
    expect(screen.queryByTestId('backup-progress')).toBeNull();
    // The run is over and this dialog has no second one in it, so the form stays read-only rather than
    // offering edits that can no longer do anything.
    expect((screen.getByTestId('backup-path') as HTMLInputElement).disabled).toBe(true);
    // The Angular dialog closed itself here and fired a snackbar. This one stays open and says so
    // inline, which is the only thing a user can actually see above a modal (J-42).
    expect(notifications).toEqual([]);
    expect(screen.getByTestId('backup-dialog')).toBeTruthy();
  });

  it('states a failure inline, and offers the form back', async () => {
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');
    await user.click(screen.getByTestId('backup-start'));
    await screen.findByTestId('backup-progress');

    act(() => {
      bridge.progress.emit({
        backupId: 'op-1',
        status: 'failed',
        percentComplete: 0,
        error: 'pg_dump: error: connection to server failed',
      });
    });

    const failure = await screen.findByTestId('backup-error');
    expect(failure.textContent).toContain('connection to server failed');
    expect(failure.getAttribute('role')).toBe('alert');
    expect(notifications).toEqual([]);

    await user.click(screen.getByTestId('backup-retry'));
    expect(screen.getByTestId('backup-start')).toBeTruthy();
    expect(screen.queryByTestId('backup-error')).toBeNull();
    // The path survived, so a retry does not mean retyping it.
    expect((screen.getByTestId('backup-path') as HTMLInputElement).value).toBe('/tmp/sales.dump');
  });

  it('states a failure when the operation never started at all', async () => {
    bridge.start.mockRejectedValueOnce(new Error('Connection profile not found'));
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');

    await user.click(screen.getByTestId('backup-start'));

    const failure = await screen.findByTestId('backup-error');
    expect(failure.textContent).toContain('Connection profile not found');
    expect(notifications).toEqual([]);
  });

  it('ignores a progress event for somebody else’s operation', async () => {
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');
    await user.click(screen.getByTestId('backup-start'));
    await screen.findByTestId('backup-progress');

    // Bind this dialog to op-1…
    act(() => {
      bridge.progress.emit({ backupId: 'op-1', status: 'running', percentComplete: 10 });
    });
    // …then let a sibling operation complete. The channel is per-window, not per-dialog.
    act(() => {
      bridge.progress.emit({ backupId: 'op-other', status: 'completed', percentComplete: 100 });
    });

    await waitFor(() => expect(screen.getByTestId('backup-progress')).toBeTruthy());
    expect(screen.queryByTestId('backup-success')).toBeNull();
  });

  it('binds the operation id the START reply carried, before any event arrives', async () => {
    // Preload declares `backup.start` as `Promise<void>`, but every engine's handler returns the id
    // (`backup.ipc.ts:49`), so the dialog recovers it by inspection — and is then armed against a
    // sibling operation's events from the first tick rather than from its own first event. Correcting
    // the preload declaration is J-48 item h.
    bridge.start.mockResolvedValueOnce('op-mine');
    const user = userEvent.setup();
    await mountOnForm('postgresql');
    await setPath(user, '/tmp/sales.dump');
    await user.click(screen.getByTestId('backup-start'));
    await screen.findByTestId('backup-progress');

    act(() => {
      bridge.progress.emit({ backupId: 'op-other', status: 'completed', percentComplete: 100 });
    });

    expect(screen.queryByTestId('backup-success')).toBeNull();
    expect(screen.getByTestId('backup-progress')).toBeTruthy();
  });

  it('leaves exactly one live progress subscription', async () => {
    const { unmount } = await mountOnForm('postgresql');
    expect(bridge.progress.liveCount()).toBe(1);
    unmount();
    expect(bridge.progress.liveCount()).toBe(0);
  });
});

// ── the command wiring ───────────────────────────────────────────────────────────────────────

function mountConsumer() {
  return render(
    <IpcQueryProvider>
      <TooltipProvider>
        <BackupDialogs />
      </TooltipProvider>
    </IpcQueryProvider>
  );
}

describe('the two backup commands', () => {
  beforeEach(() => {
    bridge = installBridge(TOOLS_PRESENT);
  });

  it('renders nothing until a command arrives', () => {
    mountConsumer();
    expect(screen.queryByTestId('backup-dialog')).toBeNull();
  });

  it('opens on the sidebar’s targeted command, using the payload’s own database', async () => {
    connectionStore.setState({
      profiles: [profile('postgresql')],
      connectedProfileIds: new Set([CONNECTION_ID]),
      selectedDatabaseByConnection: new Map([[CONNECTION_ID, 'something_else']]),
    });
    mountConsumer();

    act(() => {
      dispatchCommand('backup-database', {
        connectionId: CONNECTION_ID,
        databaseName: 'orders_db',
      });
    });

    // The payload wins over the focused selection — the Angular sidebar's recurring bug was the
    // reverse (PLAN.md's registry note on `overrideConnectionId`).
    const dialog = await screen.findByTestId('backup-dialog');
    expect(dialog.textContent).toContain('Back up orders_db');
  });

  // Not "the focused connection": `mostRecentConnectionId()` is what resolves it, and the two differ.
  // Focus derives from the active query tab alone, so this connection — connected, with a database
  // chosen, and no query tab open — has no focus at all and the menu item would refuse for it.
  it('resolves the menu’s payload-free command through mostRecentConnectionId, not focus', async () => {
    connectionStore.setState({
      profiles: [profile('mssql')],
      connectedProfileIds: new Set([CONNECTION_ID]),
      selectedDatabaseByConnection: new Map([[CONNECTION_ID, DATABASE]]),
    });
    mountConsumer();

    act(() => {
      dispatchCommand('open-backup-dialog');
    });

    const dialog = await screen.findByTestId('backup-dialog');
    expect(dialog.textContent).toContain(`Back up ${DATABASE}`);
    // MSSQL, resolved from the profile — which is what makes the option matrix engine-correct.
    expect(screen.getByTestId('backup-type')).toBeTruthy();
  });

  it('says why rather than opening an empty dialog when nothing is connected', () => {
    mountConsumer();

    act(() => {
      dispatchCommand('open-backup-dialog');
    });

    expect(screen.queryByTestId('backup-dialog')).toBeNull();
    // Legal here and only here: no modal is up yet, so this toast is reachable (J-42).
    expect(notifications).toEqual(['warning: Connect to a server before backing up a database.']);
  });

  it('reports a stale context menu instead of opening on a deleted profile', () => {
    mountConsumer();

    act(() => {
      dispatchCommand('backup-database', { connectionId: 'gone', databaseName: DATABASE });
    });

    expect(screen.queryByTestId('backup-dialog')).toBeNull();
    expect(notifications).toEqual(['error: That connection no longer exists.']);
  });
});

// ── one dump at a time ───────────────────────────────────────────────────────────────────────
//
// The dump outlives its dialog — closing does not stop it, because nothing can (J-48 item e). Nothing
// in `packages/main` refuses a second dump of the same database either: `pg-backup.ts` mints a fresh
// operation id per call and never looks at the destination, so two `pg_dump` processes interleave into
// one archive and BOTH report success (J-48 item f). These tests are the renderer-side mitigation, and
// they are written through `BackupDialogs` rather than the dialog because the record surviving the
// close is the whole point.

describe('one run at a time, across close and re-open', () => {
  beforeEach(() => {
    bridge = installBridge(TOOLS_PRESENT);
    connectionStore.setState({
      profiles: [profile('postgresql')],
      connectedProfileIds: new Set([CONNECTION_ID]),
      selectedDatabaseByConnection: new Map([[CONNECTION_ID, DATABASE]]),
    });
  });

  /** Open the wizard on one database and start a dump to `path`. Leaves the dialog open. */
  async function startRun(
    user: ReturnType<typeof userEvent.setup>,
    databaseName: string,
    path: string
  ): Promise<void> {
    act(() => {
      dispatchCommand('backup-database', { connectionId: CONNECTION_ID, databaseName });
    });
    await screen.findByTestId('backup-path');
    await setPath(user, path);
    await user.click(screen.getByTestId('backup-start'));
    await screen.findByTestId('backup-progress');
  }

  it('refuses a second dump of the same database when the dialog is re-opened onto it', async () => {
    const user = userEvent.setup();
    mountConsumer();
    await startRun(user, DATABASE, '/tmp/sales.dump');

    // The bridge double resolves `start` with `undefined`, as its preload declaration promises; the
    // real handler returns the operation id and the dialog binds it immediately. Here the first
    // progress line is what binds it, which is the fallback path.
    act(() => {
      bridge.progress.emit({ backupId: 'op-1', status: 'running', percentComplete: -1 });
    });

    // Close it. The dump keeps going — the dialog says so, and there is no cancel to offer.
    await user.click(screen.getByTestId('backup-close'));
    await waitFor(() => expect(screen.queryByTestId('backup-dialog')).toBeNull());

    // Re-open on the same database, which is the sequence that used to start a second `pg_dump`.
    act(() => {
      dispatchCommand('backup-database', { connectionId: CONNECTION_ID, databaseName: DATABASE });
    });

    const note = await screen.findByTestId('backup-in-flight');
    expect(note.textContent).toContain('A backup of this database is still running');
    expect(note.textContent).toContain('/tmp/sales.dump');

    // Blocked, not warned: the button is refused and pressing it reaches no bridge call.
    const startButton = screen.getByTestId('backup-start') as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    await user.click(startButton);
    expect(bridge.start).toHaveBeenCalledOnce();

    // The other way a form gets submitted. Implicit submission is suppressed by the disabled default
    // button, and `startBackup` refuses as well — belt and braces, asserted at the behaviour.
    await user.click(screen.getByTestId('backup-path'));
    await user.keyboard('{Enter}');
    expect(bridge.start).toHaveBeenCalledOnce();

    // …and it is a statement inside the dialog, not a toast above it (J-42).
    expect(notifications).toEqual([]);
  });

  it('lifts the refusal as soon as the first dump reports it is done', async () => {
    const user = userEvent.setup();
    mountConsumer();
    await startRun(user, DATABASE, '/tmp/sales.dump');
    act(() => {
      bridge.progress.emit({ backupId: 'op-1', status: 'running', percentComplete: -1 });
    });
    await user.click(screen.getByTestId('backup-close'));
    await waitFor(() => expect(screen.queryByTestId('backup-dialog')).toBeNull());

    // The run finishes with no dialog on screen at all, which is why the subscription that retires it
    // is on `BackupDialogs` and not on the wizard.
    act(() => {
      bridge.progress.emit({ backupId: 'op-1', status: 'completed', percentComplete: 100 });
    });

    act(() => {
      dispatchCommand('backup-database', { connectionId: CONNECTION_ID, databaseName: DATABASE });
    });

    await screen.findByTestId('backup-path');
    expect(screen.queryByTestId('backup-in-flight')).toBeNull();
    expect((screen.getByTestId('backup-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('never lets an older run’s completion be adopted by a newer one', async () => {
    const user = userEvent.setup();
    mountConsumer();

    // Each start reports its own operation id, as every engine's handler really does — typed as
    // such since J-48h. Before that the id was recovered by runtime inspection, so a run that
    // began before its first progress event was unbound, and the module-level in-flight record
    // was the only thing standing between run B and run A's completion. It still is; B is now
    // also armed by its own id from the first tick.
    bridge.start.mockResolvedValueOnce('op-a').mockResolvedValueOnce('op-b');

    // Run A, bound to op-a, then closed while it is still going.
    await startRun(user, 'orders_db', '/tmp/orders.dump');
    act(() => {
      bridge.progress.emit({ backupId: 'op-a', status: 'running', percentComplete: -1 });
    });
    await user.click(screen.getByTestId('backup-close'));
    await waitFor(() => expect(screen.queryByTestId('backup-dialog')).toBeNull());

    // Run B, on a different database, so the record does not refuse it.
    await startRun(user, DATABASE, '/tmp/sales.dump');

    // A finishes. Without the record this event would be the first one B ever saw, and B would report
    // a success for a file it never wrote.
    act(() => {
      bridge.progress.emit({ backupId: 'op-a', status: 'completed', percentComplete: 100 });
    });

    expect(screen.queryByTestId('backup-success')).toBeNull();
    expect(screen.getByTestId('backup-progress')).toBeTruthy();

    // B's own completion still lands.
    act(() => {
      bridge.progress.emit({ backupId: 'op-b', status: 'completed', percentComplete: 100 });
    });
    const success = await screen.findByTestId('backup-success');
    expect(success.textContent).toContain('Backup complete');
    expect(screen.getByTestId('backup-success-path').textContent).toBe('/tmp/sales.dump');
  });
});
