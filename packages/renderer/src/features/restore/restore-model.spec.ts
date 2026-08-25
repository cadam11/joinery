/**
 * The restore rules, tested where they are decided rather than through the screen.
 *
 * Four of these blocks exist because getting them wrong loses a database rather than looking wrong:
 * `targetKindFor` (is this destructive), `confirmationSatisfied` (has the user said so), `restoreTsql`
 * (is the preview the statement), and `restoreOperationId` (does the dialog recognise its own run on
 * an engine that spells the id differently).
 */

import { describe, expect, it } from 'vitest';
import type { BackupLogicalFile, RestoreProgress, ServerDefaultPaths } from '@joinery/shared';

import {
  applyRestoreProgress,
  bindRestoreRunId,
  changedRelocations,
  confirmationRequired,
  confirmationSatisfied,
  defaultRestoreValues,
  engineRestoreOptions,
  planFor,
  restoreOperationId,
  restoreProblem,
  restoreProgressLabel,
  restoreTsql,
  sourceIsServerSide,
  suggestedRelocations,
  suggestedTargetName,
  targetCreatedBy,
  targetKindFor,
  targetNameProblem,
  type Relocation,
  type RestoreFormValues,
  type RestorePhase,
  type RestorePlan,
} from './restore-model';

function values(overrides: Partial<RestoreFormValues> = {}): RestoreFormValues {
  return { ...defaultRestoreValues(), ...overrides };
}

const DEFAULT_PATHS: ServerDefaultPaths = {
  dataPath: 'C:\\Data',
  logPath: 'C:\\Logs',
  backupPath: 'C:\\Backups',
};

const FILES: BackupLogicalFile[] = [
  { logicalName: 'sales', physicalName: 'C:\\Data\\sales.mdf', type: 'D', fileType: 'D' },
  { logicalName: 'sales_log', physicalName: 'C:\\Logs\\sales_log.ldf', type: 'L', fileType: 'L' },
];

describe('the engine matrix', () => {
  it('puts the archive on the server for MSSQL and on this machine otherwise', () => {
    expect(sourceIsServerSide('mssql')).toBe(true);
    expect(sourceIsServerSide('postgresql')).toBe(false);
    expect(sourceIsServerSide('mysql')).toBe(false);
  });

  it('makes Joinery create the target for PostgreSQL, and nobody else', () => {
    // `buildPgRestoreArgs` never passes --create, so pg_restore can only write into a database that
    // is already there. MSSQL's RESTORE and MySQL's piped prelude both create their own.
    expect(targetCreatedBy('postgresql')).toBe('joinery');
    expect(targetCreatedBy('mssql')).toBe('restore');
    expect(targetCreatedBy('mysql')).toBe('restore');
  });

  it('gives the MSSQL-only controls to MSSQL alone', () => {
    const mssql = engineRestoreOptions('mssql');
    expect(mssql.showRecoveryState).toBe(true);
    expect(mssql.showRelocations).toBe(true);
    expect(mssql.showTsqlPreview).toBe(true);
    expect(mssql.showHistory).toBe(true);

    for (const engine of ['postgresql', 'mysql'] as const) {
      const options = engineRestoreOptions(engine);
      expect(options.showRecoveryState).toBe(false);
      expect(options.showRelocations).toBe(false);
      expect(options.showTsqlPreview).toBe(false);
      expect(options.showHistory).toBe(false);
      expect(options.formatNote).not.toBeNull();
    }
  });

  it('states what overwriting actually does on each engine', () => {
    // Three different destructive mechanisms; the checkbox is one word, so the hint carries the rest.
    expect(engineRestoreOptions('mssql').overwriteHint).toContain('REPLACE');
    expect(engineRestoreOptions('postgresql').overwriteHint).toContain('--clean');
    expect(engineRestoreOptions('mysql').overwriteHint).toContain('DROP DATABASE');
  });
});

describe('deciding whether a restore is destructive', () => {
  const databases = ['postgres', 'joinery_test', 'sales'];

  it('is an overwrite when the name is one the server reports', () => {
    expect(targetKindFor('sales', databases)).toBe('overwrite');
  });

  it('is a create when it is not', () => {
    expect(targetKindFor('sales_copy', databases)).toBe('create');
  });

  it('reads the NAME, not a mode toggle — a "new" database that already exists is an overwrite', () => {
    // The hole this function exists to close: someone restoring yesterday's backup picks "create a
    // new database" and types the name of the live one. Nothing about the radio button changes what
    // the server will do.
    expect(targetKindFor('  sales  ', databases)).toBe('overwrite');
  });

  it('is unknown, and therefore treated as destructive, when the list could not be read', () => {
    expect(targetKindFor('sales_copy', null)).toBe('unknown');
    expect(confirmationRequired('unknown')).toBe(true);
  });

  it('is unknown for an empty name', () => {
    expect(targetKindFor('', databases)).toBe('unknown');
  });

  it('asks for a confirmation for everything except a proven-new database', () => {
    expect(confirmationRequired('overwrite')).toBe(true);
    expect(confirmationRequired('unknown')).toBe(true);
    expect(confirmationRequired('create')).toBe(false);
  });
});

describe('the confirmation', () => {
  it('is satisfied by nothing at all when the target is new', () => {
    expect(confirmationSatisfied('', 'fresh', 'create')).toBe(true);
  });

  it('needs the exact name when the target exists', () => {
    expect(confirmationSatisfied('', 'sales', 'overwrite')).toBe(false);
    expect(confirmationSatisfied('sales', 'sales', 'overwrite')).toBe(true);
  });

  it('is case-sensitive, because database names can be', () => {
    // PostgreSQL identifiers are case-sensitive; MySQL's depend on the filesystem; SQL Server's on the
    // collation. Accepting SALES for sales would teach the user they are the same name.
    expect(confirmationSatisfied('SALES', 'sales', 'overwrite')).toBe(false);
  });

  it('does not accept whitespace padding as a match', () => {
    expect(confirmationSatisfied(' sales ', 'sales', 'overwrite')).toBe(false);
  });

  it('is never satisfied by an empty target', () => {
    expect(confirmationSatisfied('', '', 'overwrite')).toBe(false);
    expect(confirmationSatisfied('   ', '   ', 'overwrite')).toBe(false);
  });

  it('takes the target as an argument, so a caller cannot check the wrong name', () => {
    // The seam this signature closes: the button, the Enter handler and `runPlan` all confirm against
    // the FROZEN plan's target. A predicate that read the live form field could be satisfied by a name
    // the user has since edited.
    expect(confirmationSatisfied('sales', 'sales_copy', 'overwrite')).toBe(false);
  });
});

describe('what stops a restore before it starts', () => {
  const databases = ['sales'];

  it('asks for a source first', () => {
    expect(restoreProblem(values(), 'postgresql', 'unknown', true)).toMatch(/backup file/i);
  });

  it('then asks for a target', () => {
    const form = values({ backupPath: '/tmp/sales.dump' });
    expect(restoreProblem(form, 'postgresql', 'unknown', true)).toMatch(/name the database/i);
  });

  it('refuses a MySQL name the main process would reject', () => {
    // `mysql-backup.ts:163-167` throws for anything outside [A-Za-z0-9_]; being told here beats being
    // told after working through a confirmation step.
    const form = values({ backupPath: '/tmp/a.sql', targetDatabase: 'sales-copy' });
    expect(restoreProblem(form, 'mysql', 'create', true)).toMatch(
      /letters, digits and underscores/
    );
    expect(
      restoreProblem({ ...form, targetDatabase: 'sales_copy' }, 'mysql', 'create', true)
    ).toBeNull();
  });

  it('leaves the same name alone on the engines that allow it', () => {
    expect(targetNameProblem('sales-copy', 'postgresql')).toBeNull();
    expect(targetNameProblem('sales-copy', 'mssql')).toBeNull();
  });

  it('refuses a new PostgreSQL target on a connection that cannot create databases', () => {
    const form = values({ backupPath: '/tmp/a.dump', targetDatabase: 'fresh' });
    expect(restoreProblem(form, 'postgresql', 'create', false)).toMatch(
      /cannot create a database/i
    );
    expect(restoreProblem(form, 'postgresql', 'create', true)).toBeNull();
  });

  it('lets an EXISTING PostgreSQL target through without the create capability', () => {
    // Nothing has to be created, so the capability is irrelevant.
    const form = values({ backupPath: '/tmp/a.dump', targetDatabase: 'sales', overwrite: true });
    expect(restoreProblem(form, 'postgresql', 'overwrite', false)).toBeNull();
    expect(targetKindFor('sales', databases)).toBe('overwrite');
  });

  it('refuses an MSSQL overwrite that has not turned Overwrite on', () => {
    // SQL Server answers "the database already exists — use WITH REPLACE"; saying so here is the same
    // information without a round trip and a failed restore.
    const form = values({ backupPath: 'C:\\B\\a.bak', targetDatabase: 'sales' });
    expect(restoreProblem(form, 'mssql', 'overwrite', true)).toMatch(/Overwrite/);
    expect(restoreProblem({ ...form, overwrite: true }, 'mssql', 'overwrite', true)).toBeNull();
  });

  it('says nothing about the confirmation — that gates a phase, not the form', () => {
    // The options screen has no button that can destroy anything, so its validation has no reason to
    // mention the confirmation.
    const form = values({ backupPath: '/tmp/a.dump', targetDatabase: 'sales', overwrite: true });
    expect(restoreProblem(form, 'postgresql', 'overwrite', true)).toBeNull();
    expect(confirmationSatisfied(form.confirmation, form.targetDatabase, 'overwrite')).toBe(false);
  });
});

describe('the plan', () => {
  const form = values({
    backupPath: '  /tmp/sales.dump  ',
    targetDatabase: '  sales_copy  ',
    overwrite: true,
    noRecovery: true,
  });

  it('trims what it freezes', () => {
    const plan = planFor(form, 'postgresql', 'create', []);
    expect(plan.backupPath).toBe('/tmp/sales.dump');
    expect(plan.targetDatabase).toBe('sales_copy');
  });

  it('drops the options the engine has no control for', () => {
    // `noRecovery` left over from an MSSQL session must not ride along in a PG request.
    expect(planFor(form, 'postgresql', 'create', []).noRecovery).toBe(false);
    expect(planFor(form, 'mssql', 'create', []).noRecovery).toBe(true);
  });

  it('creates the target only for a PostgreSQL database it can prove is new', () => {
    expect(planFor(form, 'postgresql', 'create', []).createsTarget).toBe(true);
    expect(planFor(form, 'postgresql', 'overwrite', []).createsTarget).toBe(false);
    // Unknown means the list did not load; guessing would CREATE over a name that was always there.
    expect(planFor(form, 'postgresql', 'unknown', []).createsTarget).toBe(false);
    expect(planFor(form, 'mysql', 'create', []).createsTarget).toBe(false);
    expect(planFor(form, 'mssql', 'create', []).createsTarget).toBe(false);
  });
});

describe('file relocation (MSSQL)', () => {
  it('aims the default at the server’s own directories, named after the TARGET database', () => {
    // The Angular default was the file's original physical name, which makes the copy case fail:
    // restoring sales.bak into sales_copy would try to write the live sales.mdf.
    const relocations = suggestedRelocations(FILES, 'sales_copy', DEFAULT_PATHS);
    expect(relocations[0]?.newPath).toBe('C:\\Data\\sales_copy_sales.mdf');
    expect(relocations[1]?.newPath).toBe('C:\\Logs\\sales_copy_sales_log.ldf');
    expect(relocations[1]?.fileType).toBe('L');
  });

  it('keeps the original path when the server reported no default directories', () => {
    const relocations = suggestedRelocations(FILES, 'sales_copy', undefined);
    expect(relocations[0]?.newPath).toBe('C:\\Data\\sales.mdf');
  });

  it('replaces anything a filesystem would object to', () => {
    const relocations = suggestedRelocations(FILES, 'sales copy/2', DEFAULT_PATHS);
    expect(relocations[0]?.newPath).toBe('C:\\Data\\sales_copy_2_sales.mdf');
  });

  it('sends only the files that actually move', () => {
    const unchanged: Relocation = {
      logicalName: 'sales',
      fileType: 'D',
      originalPath: 'C:\\Data\\sales.mdf',
      newPath: 'C:\\Data\\sales.mdf',
    };
    const moved: Relocation = { ...unchanged, newPath: 'D:\\Data\\sales.mdf' };
    const blank: Relocation = { ...unchanged, newPath: '   ' };

    expect(changedRelocations([unchanged, moved, blank])).toEqual([moved]);
  });
});

describe('the T-SQL preview', () => {
  const moved: Relocation[] = [
    {
      logicalName: 'sales',
      fileType: 'D',
      originalPath: 'C:\\Data\\sales.mdf',
      newPath: 'C:\\Data\\sales_copy_sales.mdf',
    },
  ];

  it('is the statement TsqlBuilder.restore emits, STATS included', () => {
    const sql = restoreTsql(
      values({ backupPath: 'C:\\B\\sales.bak', targetDatabase: 'sales_copy', overwrite: true }),
      moved
    );
    expect(sql).toBe(
      'RESTORE DATABASE [sales_copy]\n' +
        "FROM DISK = N'C:\\B\\sales.bak'\n" +
        'WITH\n' +
        "    MOVE N'sales' TO N'C:\\Data\\sales_copy_sales.mdf',\n" +
        '    REPLACE,\n' +
        '    RECOVERY,\n' +
        '    STATS = 5;'
    );
  });

  it('says RECOVERY when nothing was ticked, because that is what the builder emits', () => {
    // The Angular preview showed neither clause in this case; the server restores WITH RECOVERY.
    const sql = restoreTsql(values({ backupPath: 'a.bak', targetDatabase: 'db' }), []);
    expect(sql).toContain('RECOVERY');
    expect(sql).not.toContain('NORECOVERY');
    expect(sql).not.toContain('REPLACE');
  });

  it('says NORECOVERY when it was', () => {
    const sql = restoreTsql(
      values({ backupPath: 'a.bak', targetDatabase: 'db', noRecovery: true }),
      []
    );
    expect(sql).toContain('    NORECOVERY,');
  });

  it('never says STATS = 10, which is what the Angular preview claimed', () => {
    expect(restoreTsql(values({ backupPath: 'a.bak', targetDatabase: 'db' }), [])).not.toContain(
      'STATS = 10'
    );
  });

  it('escapes quotes in the path and brackets in the name', () => {
    const sql = restoreTsql(
      values({ backupPath: "C:\\it's\\a.bak", targetDatabase: 'we]ird' }),
      []
    );
    expect(sql).toContain("N'C:\\it''s\\a.bak'");
    expect(sql).toContain('[we]]ird]');
  });

  it('renders placeholders rather than an empty statement', () => {
    const sql = restoreTsql(values(), []);
    expect(sql).toContain('[<database>]');
    expect(sql).toContain("N'<path>'");
  });
});

describe('suggesting a target name from the archive', () => {
  it('drops the extension and Joinery’s own timestamp', () => {
    expect(suggestedTargetName('/tmp/sales_2026-08-16T09-12-04.dump')).toBe('sales');
    expect(suggestedTargetName('C:\\Backups\\sales_2026-08-16T09-12-04.bak')).toBe('sales');
  });

  it('leaves a name that has no stamp alone', () => {
    expect(suggestedTargetName('/tmp/nightly.dump')).toBe('nightly');
  });

  it('answers empty for an empty path', () => {
    expect(suggestedTargetName('   ')).toBe('');
  });
});

// ── The progress stream ─────────────────────────────────────────────────────────────────────

const PLAN: RestorePlan = {
  backupPath: '/tmp/sales.dump',
  targetDatabase: 'sales_copy',
  kind: 'create',
  overwrite: false,
  noRecovery: false,
  relocations: [],
  createsTarget: true,
};

function running(restoreId: string | null = null): RestorePhase {
  return { kind: 'running', plan: PLAN, restoreId, progress: null };
}

/** The MSSQL shape: `backup-restore.ts` is the only sender that fills `restoreId`. */
function mssqlEvent(overrides: Partial<RestoreProgress> = {}): RestoreProgress {
  return { restoreId: 'op-1', status: 'running', percentComplete: 42, ...overrides };
}

/**
 * The PG/MySQL shape, exactly as `pg-backup.ts:289-303` builds it: `backupId` and `operationId`, and
 * **no `restoreId` at all**. Cast because the declared type says `restoreId` is required — which is
 * the whole reason `restoreOperationId` exists.
 */
function cliEvent(overrides: Record<string, unknown> = {}): RestoreProgress {
  // What pg_restore and the mysql client emit since J-51a: keyed `restoreId`, like MSSQL, with
  // `operationId` alongside as the declared alias. Before that they sent `backupId` on the restore
  // channel and no `restoreId` at all.
  return {
    restoreId: 'op-1',
    operationId: 'op-1',
    status: 'running',
    percentComplete: -1,
    currentPhase: 'pg_restore: creating TABLE "public.products"',
    ...overrides,
  } as unknown as RestoreProgress;
}

describe('recognising an operation id whatever the engine calls it', () => {
  it('reads restoreId from SQL Server', () => {
    expect(restoreOperationId(mssqlEvent())).toBe('op-1');
  });

  it('reads restoreId from pg_restore and the mysql client, which now send it (J-51a)', () => {
    // The bug this is here to stop: `progress.restoreId` was `undefined` on two of three engines,
    // so a bound dialog discarded every event and spun through a finished restore.
    const event = cliEvent();
    expect((event as unknown as Record<string, unknown>)['restoreId']).toBe('op-1');
    expect(restoreOperationId(event)).toBe('op-1');
  });

  it('still reads the operationId alias on its own, since the type declares it', () => {
    expect(restoreOperationId({ operationId: 'op-2' } as unknown as RestoreProgress)).toBe('op-2');
  });

  it('no longer answers a bare backupId — that fallback existed only for the bug', () => {
    expect(restoreOperationId({ backupId: 'op-2' } as unknown as RestoreProgress)).toBeNull();
  });

  it('answers null when the event carries no id at all', () => {
    expect(restoreOperationId({ status: 'running' } as unknown as RestoreProgress)).toBeNull();
  });
});

describe('folding progress into the phase', () => {
  it('ignores every event while nothing of ours is running', () => {
    const options: RestorePhase = { kind: 'options' };
    expect(applyRestoreProgress(options, cliEvent())).toBe(options);

    const confirming: RestorePhase = { kind: 'confirming', plan: PLAN };
    expect(applyRestoreProgress(confirming, cliEvent({ status: 'completed' }))).toBe(confirming);
  });

  it('binds the id from the first event and keeps the plan', () => {
    const next = applyRestoreProgress(running(), cliEvent());
    expect(next.kind).toBe('running');
    if (next.kind !== 'running') throw new Error('unreachable');
    expect(next.restoreId).toBe('op-1');
    expect(next.plan).toBe(PLAN);
  });

  it('lands on done, carrying the plan so the success can name the database', () => {
    const next = applyRestoreProgress(
      running('op-1'),
      cliEvent({ status: 'completed', percentComplete: 100, elapsedMs: 4200 })
    );
    expect(next).toEqual({ kind: 'done', plan: PLAN, elapsedMs: 4200 });
  });

  it('lands on failed, carrying the engine’s own message', () => {
    const next = applyRestoreProgress(
      running('op-1'),
      cliEvent({ status: 'failed', error: 'pg_restore: error: could not open input file' })
    );
    expect(next).toEqual({
      kind: 'failed',
      message: 'pg_restore: error: could not open input file',
      // The plan created its own target, so the failure has a database to disclose.
      leftoverDatabase: 'sales_copy',
    });
  });

  it('names the database Joinery created when the restore into it then failed', () => {
    // Joinery creates the PG target BEFORE pg_restore runs, so a failure leaves an empty database
    // behind. Undisclosed, the retry silently becomes an overwrite of a database Joinery itself made.
    const next = applyRestoreProgress(running('op-1'), cliEvent({ status: 'failed' }));
    expect(next.kind === 'failed' && next.leftoverDatabase).toBe('sales_copy');
  });

  it('discloses nothing when the target was already there — nothing was left behind', () => {
    const intoExisting: RestorePhase = {
      kind: 'running',
      plan: { ...PLAN, targetDatabase: 'sales', kind: 'overwrite', createsTarget: false },
      restoreId: 'op-1',
      progress: null,
    };
    const next = applyRestoreProgress(intoExisting, cliEvent({ status: 'failed' }));
    expect(next.kind === 'failed' && next.leftoverDatabase).toBeUndefined();
  });

  it('reports a cancellation as a failure, because it is not a restored database', () => {
    const next = applyRestoreProgress(running('op-1'), cliEvent({ status: 'cancelled' }));
    expect(next.kind).toBe('failed');
    // A cancelled restore leaves the same empty database a failed one does.
    expect(next.kind === 'failed' && next.leftoverDatabase).toBe('sales_copy');
  });

  it('ignores an event belonging to a different bound operation', () => {
    const phase = running('op-1');
    expect(applyRestoreProgress(phase, cliEvent({ restoreId: 'op-9', operationId: 'op-9' }))).toBe(
      phase
    );
  });

  it('refuses an id the window can PROVE belongs to another run, before binding', () => {
    const phase = running();
    const foreign = applyRestoreProgress(phase, cliEvent({ status: 'completed' }), () => true);
    expect(foreign).toBe(phase);
  });

  it('adopts an unknown id before binding, so a completed-first stream cannot hang it', () => {
    // pg_restore of a tiny archive can finish before its first verbose line is read.
    const next = applyRestoreProgress(running(), cliEvent({ status: 'completed' }), () => false);
    expect(next.kind).toBe('done');
  });

  it('is the same object when nothing changed, so the caller’s setState costs no render', () => {
    const phase = running('op-1');
    expect(applyRestoreProgress(phase, mssqlEvent({ restoreId: 'other' }))).toBe(phase);
  });
});

describe('binding the id from the START reply', () => {
  it('binds a running phase once', () => {
    const bound = bindRestoreRunId(running(), 'op-1');
    expect(bound.kind === 'running' && bound.restoreId).toBe('op-1');
    const again = bindRestoreRunId(bound, 'op-2');
    expect(again.kind === 'running' && again.restoreId).toBe('op-1');
  });

  it('leaves every other phase alone', () => {
    const preparing: RestorePhase = { kind: 'preparing', plan: PLAN };
    expect(bindRestoreRunId(preparing, 'op-1')).toBe(preparing);
  });
});

describe('the progress caption', () => {
  it('never renders empty', () => {
    expect(restoreProgressLabel(null)).toBe('Starting the restore…');
    expect(restoreProgressLabel(mssqlEvent({ currentPhase: '   ' }))).toBe('Restoring…');
    expect(restoreProgressLabel(mssqlEvent({ status: 'starting', currentPhase: undefined }))).toBe(
      'Starting the restore…'
    );
  });

  it('prefers what the engine said it was doing', () => {
    expect(restoreProgressLabel(cliEvent())).toContain('pg_restore: creating TABLE');
  });
});
