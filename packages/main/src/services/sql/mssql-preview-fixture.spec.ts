/**
 * Generates `tests/fixtures/tsql-preview/mssql-statements.sql` from the production statement
 * builders, and is one half of the drift guard J-112 asked for.
 *
 * The backup and restore dialogs show the user "the SQL that will run" (CLAUDE.md, *SQL
 * Transparency*). They cannot call these builders — the renderer may not import from
 * `packages/main` — so each dialog carries a second implementation of the same statement, and
 * before this file nothing tied the two together: a change to `TsqlBuilder` or to the request
 * mapping in `backup-args.ts` falsified the preview with the whole suite green.
 *
 * The two halves:
 *
 *  1. **Here.** Every case in `CASES` goes through `buildMssqlBackupTsql` /
 *     `buildMssqlRestoreTsql` — the same functions `BackupRestoreService` calls — and the result
 *     is written to the fixture as a file snapshot. A change to the emitted SQL fails this spec
 *     until someone regenerates, so the change is at least deliberate and shows up as SQL in the
 *     diff rather than as a moved character in a builder.
 *  2. **`packages/renderer/src/features/tsql-preview-drift.spec.ts`.** It reads the same fixture
 *     and asserts each dialog's preview equals the statement stored under the matching case id.
 *     So regenerating step 1 turns step 2 red until the preview is brought back into line.
 *
 * Regenerate with:
 *   pnpm exec vitest run packages/main/src/services/sql/mssql-preview-fixture.spec.ts -u
 *
 * The request objects below are what the dialogs actually send — `backup-dialog.tsx`'s
 * `startBackup` and `restore-dialog.tsx`'s `runPlan` build exactly these fields, and the renderer
 * half of the guard states the form values each one comes from. Adding a case here without adding
 * it there fails the renderer spec, which checks that it covers every case in the fixture.
 */

import { describe, expect, it } from 'vitest';
import type { BackupRequest, RestoreRequest } from '@joinery/shared';

import { buildMssqlBackupTsql, buildMssqlRestoreTsql } from './backup-args';

/** Path is relative to this file; `tests/` is five levels up from `packages/main/src/services/sql`. */
const FIXTURE_PATH = '../../../../../tests/fixtures/tsql-preview/mssql-statements.sql';

/** Only ever this one — the dialogs' preview is MSSQL-only, and so is the statement. */
const CONNECTION_ID = 'fixture-connection';

interface BackupCase {
  readonly id: string;
  readonly request: BackupRequest;
}

interface RestoreCase {
  readonly id: string;
  readonly request: RestoreRequest;
}

const BACKUP_CASES: readonly BackupCase[] = [
  {
    id: 'backup/full-compressed',
    request: {
      connectionId: CONNECTION_ID,
      database: 'sales',
      backupPath: 'C:\\Backups\\sales.bak',
      backupType: 'full',
      compression: true,
    },
  },
  {
    id: 'backup/full-uncompressed',
    request: {
      connectionId: CONNECTION_ID,
      database: 'sales',
      backupPath: 'C:\\Backups\\sales.bak',
      backupType: 'full',
      compression: false,
    },
  },
  {
    id: 'backup/differential',
    request: {
      connectionId: CONNECTION_ID,
      database: 'sales',
      backupPath: 'C:\\Backups\\sales.bak',
      backupType: 'differential',
      compression: true,
    },
  },
  {
    // The J-48a case: a log backup must be `BACKUP LOG` and must append (`NOINIT`), or it
    // overwrites the file holding the full backup it depends on.
    id: 'backup/log',
    request: {
      connectionId: CONNECTION_ID,
      database: 'sales',
      backupPath: 'C:\\Backups\\sales.bak',
      backupType: 'log',
      compression: true,
    },
  },
  {
    id: 'backup/described',
    request: {
      connectionId: CONNECTION_ID,
      database: 'sales',
      backupPath: 'C:\\Backups\\sales.bak',
      backupType: 'full',
      compression: true,
      description: "Nightly — Craig's run",
    },
  },
  {
    // Both escapes at once: `]` inside the identifier, `'` inside the literal.
    id: 'backup/awkward-names',
    request: {
      connectionId: CONNECTION_ID,
      database: 'sales]prod',
      backupPath: "C:\\Backups\\it's here.bak",
      backupType: 'full',
      compression: false,
    },
  },
];

const RESTORE_CASES: readonly RestoreCase[] = [
  {
    id: 'restore/plain',
    request: {
      connectionId: CONNECTION_ID,
      backupPath: 'C:\\Backups\\sales.bak',
      targetDatabase: 'sales_copy',
      withReplace: false,
      withNoRecovery: false,
    },
  },
  {
    id: 'restore/replace-norecovery',
    request: {
      connectionId: CONNECTION_ID,
      backupPath: 'C:\\Backups\\sales.bak',
      targetDatabase: 'sales_copy',
      withReplace: true,
      withNoRecovery: true,
    },
  },
  {
    id: 'restore/relocated',
    request: {
      connectionId: CONNECTION_ID,
      backupPath: 'C:\\Backups\\sales.bak',
      targetDatabase: 'sales_copy',
      withReplace: false,
      withNoRecovery: false,
      fileRelocations: [
        { logicalName: 'sales', physicalName: 'D:\\Data\\sales_copy_sales.mdf' },
        { logicalName: 'sales_log', physicalName: 'L:\\Logs\\sales_copy_sales_log.ldf' },
      ],
    },
  },
  {
    id: 'restore/awkward-names',
    request: {
      connectionId: CONNECTION_ID,
      backupPath: "C:\\Backups\\it's here.bak",
      targetDatabase: 'sales]copy',
      withReplace: true,
      withNoRecovery: false,
      fileRelocations: [{ logicalName: "sales'data", physicalName: "D:\\Data\\it's here.mdf" }],
    },
  },
];

const HEADER = [
  '-- GENERATED FILE — do not edit by hand.',
  '--',
  '-- The MSSQL statements `packages/main` actually runs, produced by the same functions',
  '-- `BackupRestoreService` calls: `buildMssqlBackupTsql` / `buildMssqlRestoreTsql` in',
  '-- packages/main/src/services/sql/backup-args.ts.',
  '--',
  '-- Written by: packages/main/src/services/sql/mssql-preview-fixture.spec.ts',
  '-- Read by:    packages/renderer/src/features/tsql-preview-drift.spec.ts',
  '-- Regenerate: pnpm exec vitest run packages/main/src/services/sql/mssql-preview-fixture.spec.ts -u',
  '--',
  '-- Regenerating turns the renderer spec red until the dialogs\u2019 previews are brought back',
  '-- into line with whatever changed here. That is the entire point (J-112).',
].join('\n');

/**
 * One case per `--- case: <id>` line, statement following. The renderer half parses this shape;
 * `mssql-statement-fixture.ts` there is the reader, and the round trip is asserted by the two
 * specs agreeing on every statement rather than by a format test.
 */
function serialize(entries: readonly { readonly id: string; readonly sql: string }[]): string {
  const body = entries.map(entry => `--- case: ${entry.id}\n${entry.sql}\n`).join('\n');
  return `${HEADER}\n\n${body}`;
}

describe('the MSSQL statement fixture', () => {
  it('gives every case a distinct id', () => {
    const ids = [...BACKUP_CASES, ...RESTORE_CASES].map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the statements the backup and restore services build', async () => {
    const entries = [
      ...BACKUP_CASES.map(entry => ({ id: entry.id, sql: buildMssqlBackupTsql(entry.request) })),
      ...RESTORE_CASES.map(entry => ({ id: entry.id, sql: buildMssqlRestoreTsql(entry.request) })),
    ];

    await expect(serialize(entries)).toMatchFileSnapshot(FIXTURE_PATH);
  });
});
