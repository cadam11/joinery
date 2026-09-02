/**
 * The drift guard for the two statement previews the backup and restore dialogs show (J-112).
 *
 * Both dialogs promise the user "the SQL that will run" — CLAUDE.md calls it *SQL Transparency* —
 * and neither can produce it: the statement is built in `packages/main`, which the renderer may not
 * import from, so `backupTsql` and `restoreTsql` are second implementations of it. They were
 * written by reading `tsql-builder.ts` and their own specs pinned only the transcription, which
 * means a change on the main-process side falsified the preview and left the whole suite green.
 * That is the hole this file closes.
 *
 * `tests/fixtures/tsql-preview/mssql-statements.sql` is **generated** from the production builders
 * by `packages/main/src/services/sql/mssql-preview-fixture.spec.ts`. Each case there is a request
 * exactly as the dialogs send one; each case here is the form the user filled in to produce that
 * request. So:
 *
 *  - a change to the emitted SQL fails the main spec until it is regenerated, and
 *  - regenerating fails *this* spec until the preview is updated to match.
 *
 * The fixture is read rather than imported as a module so the SQL stays readable in a diff, and
 * `?raw` rather than `node:fs` because this package deliberately has no `@types/node`
 * (`packages/renderer/tsconfig.json`).
 *
 * Adding a case to the fixture without adding it here is caught: `covers every case in the
 * fixture` compares the two id sets.
 */

import { describe, expect, it } from 'vitest';

import fixtureText from '../../../../tests/fixtures/tsql-preview/mssql-statements.sql?raw';

import { backupTsql, type BackupFormValues } from './backup';
import { restoreTsql, type Relocation, type RestoreFormValues } from './restore';

const SERVER_PATH = 'C:\\Backups\\sales.bak';
const AWKWARD_PATH = "C:\\Backups\\it's here.bak";

/** The form behind one generated `backup/*` case. `databaseName` is a dialog prop, not a field. */
interface BackupPreviewCase {
  readonly id: string;
  readonly databaseName: string;
  readonly values: BackupFormValues;
}

/** The form and file list behind one generated `restore/*` case. */
interface RestorePreviewCase {
  readonly id: string;
  readonly values: RestoreFormValues;
  readonly relocations: readonly Relocation[];
}

/**
 * `backup-dialog.tsx:255-266` sends `{ database, backupPath, backupType, compression, description }`
 * for MSSQL — every field here, and nothing else. An empty description is omitted from the request,
 * which is the same thing the preview does with it.
 */
const BACKUP_CASES: readonly BackupPreviewCase[] = [
  {
    id: 'backup/full-compressed',
    databaseName: 'sales',
    values: { backupType: 'full', backupPath: SERVER_PATH, description: '', compression: true },
  },
  {
    id: 'backup/full-uncompressed',
    databaseName: 'sales',
    values: { backupType: 'full', backupPath: SERVER_PATH, description: '', compression: false },
  },
  {
    id: 'backup/differential',
    databaseName: 'sales',
    values: {
      backupType: 'differential',
      backupPath: SERVER_PATH,
      description: '',
      compression: true,
    },
  },
  {
    id: 'backup/log',
    databaseName: 'sales',
    values: { backupType: 'log', backupPath: SERVER_PATH, description: '', compression: true },
  },
  {
    id: 'backup/described',
    databaseName: 'sales',
    values: {
      backupType: 'full',
      backupPath: SERVER_PATH,
      description: "Nightly — Craig's run",
      compression: true,
    },
  },
  {
    id: 'backup/awkward-names',
    databaseName: 'sales]prod',
    values: { backupType: 'full', backupPath: AWKWARD_PATH, description: '', compression: false },
  },
];

/**
 * `restore-dialog.tsx:364-378` sends the frozen plan, and `planFor` trims both paths and filters
 * the relocations through `changedRelocations` before it gets there — so the request behind
 * `restore/relocated` carries two moves even though the form below has three files on it.
 */
const RESTORE_CASES: readonly RestorePreviewCase[] = [
  {
    id: 'restore/plain',
    values: {
      backupPath: SERVER_PATH,
      targetDatabase: 'sales_copy',
      overwrite: false,
      noRecovery: false,
      confirmation: 'sales_copy',
    },
    relocations: [],
  },
  {
    id: 'restore/replace-norecovery',
    values: {
      backupPath: SERVER_PATH,
      targetDatabase: 'sales_copy',
      overwrite: true,
      noRecovery: true,
      confirmation: 'sales_copy',
    },
    relocations: [],
  },
  {
    id: 'restore/relocated',
    values: {
      backupPath: SERVER_PATH,
      targetDatabase: 'sales_copy',
      overwrite: false,
      noRecovery: false,
      confirmation: 'sales_copy',
    },
    relocations: [
      {
        logicalName: 'sales',
        fileType: 'D',
        originalPath: 'C:\\Data\\sales.mdf',
        newPath: 'D:\\Data\\sales_copy_sales.mdf',
      },
      {
        logicalName: 'sales_log',
        fileType: 'L',
        originalPath: 'C:\\Data\\sales_log.ldf',
        newPath: 'L:\\Logs\\sales_copy_sales_log.ldf',
      },
      {
        // Left where it was. Neither the preview nor the request carries a MOVE for it, and the
        // fixture proves it: the generated statement has two MOVEs, not three.
        logicalName: 'sales_extra',
        fileType: 'D',
        originalPath: 'C:\\Data\\sales_extra.ndf',
        newPath: 'C:\\Data\\sales_extra.ndf',
      },
    ],
  },
  {
    id: 'restore/awkward-names',
    values: {
      backupPath: AWKWARD_PATH,
      targetDatabase: 'sales]copy',
      overwrite: true,
      noRecovery: false,
      confirmation: 'sales]copy',
    },
    relocations: [
      {
        logicalName: "sales'data",
        fileType: 'D',
        originalPath: 'C:\\Data\\sales.mdf',
        newPath: "D:\\Data\\it's here.mdf",
      },
    ],
  },
];

const CASE_HEADER = /^--- case: (.+)$/;

/**
 * The generated statements, by case id.
 *
 * The format is one `--- case: <id>` line per statement, everything up to the next one being the
 * statement; `mssql-preview-fixture.spec.ts` writes it. A malformed file cannot pass silently —
 * the ids it yields are compared against the ids expected below.
 */
function parseFixture(text: string): Map<string, string> {
  const statements = new Map<string, string>();
  let openId: string | null = null;
  let lines: string[] = [];

  const close = (): void => {
    if (openId !== null) statements.set(openId, lines.join('\n').trim());
  };

  // Bounded by the file: one pass, one line at a time.
  for (const line of text.split('\n')) {
    const header = CASE_HEADER.exec(line);
    if (header === null || header[1] === undefined) {
      if (openId !== null) lines.push(line);
      continue;
    }
    close();
    openId = header[1];
    lines = [];
  }
  close();

  return statements;
}

const STATEMENTS = parseFixture(fixtureText);

/** Fails loudly rather than skipping a case that the fixture does not carry. */
function statementFor(id: string): string {
  const sql = STATEMENTS.get(id);
  expect(sql, `no statement in the fixture for case "${id}"`).toBeDefined();
  return sql ?? '';
}

describe('the backup and restore dialogs’ statement previews', () => {
  it('covers every case in the fixture', () => {
    const expected = [...BACKUP_CASES, ...RESTORE_CASES].map(entry => entry.id);
    expect([...STATEMENTS.keys()].sort()).toEqual([...expected].sort());
  });

  it.each(BACKUP_CASES)(
    'previews $id as the statement main builds',
    ({ id, databaseName, values }) => {
      expect(backupTsql(values, databaseName)).toBe(statementFor(id));
    }
  );

  it.each(RESTORE_CASES)(
    'previews $id as the statement main builds',
    ({ id, values, relocations }) => {
      expect(restoreTsql(values, relocations)).toBe(statementFor(id));
    }
  );
});
