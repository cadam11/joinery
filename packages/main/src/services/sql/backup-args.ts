/**
 * Pure helpers for building backup/restore CLI invocations.
 *
 * Kept free of any `electron` / Node-runtime imports so they can be unit
 * tested in isolation. The PG and MySQL backup services consume these.
 */

import type { BackupRequest, RestoreRequest } from '@joinery/shared';

import { TsqlBuilder } from '../../utils/tsql-builder';

/**
 * How the host CLI tool is reached. The subset of a connection profile these builders need — a
 * whole profile would carry a password, and nothing here belongs on a command line.
 */
export interface CliHost {
  readonly server: string;
  readonly port: number;
  readonly username?: string;
}

/**
 * The one format `pg_dump` is ever asked for: `c`, the compressed custom-format archive.
 *
 * Not a default and not a fallback — there is no other value, and no caller can supply one
 * (J-48d). `pg_restore` reads it, the restore wizard restores it, and the backup dialog states it
 * ("pg_dump writes a compressed custom-format archive").
 */
export const PG_DUMP_FORMAT = 'c';

/**
 * Build the argument vector for `pg_dump`.
 *
 * `-v` is not cosmetic: the CLI reports no percentage, so its stderr phase lines are the only
 * progress the dialog has to show.
 */
export function buildPgDumpArgs(host: CliHost, database: string, backupPath: string): string[] {
  return [
    '-h',
    host.server,
    '-p',
    String(host.port),
    '-U',
    host.username || 'postgres',
    '-d',
    database,
    '-F',
    PG_DUMP_FORMAT,
    '-v',
    '-f',
    backupPath,
  ];
}

/**
 * Build the argument vector for `mysqldump`.
 *
 * No format flag appears here, and that is the whole point: mysqldump's default output is the
 * plain SQL script Joinery names, restores through the `mysql` client, and documents. Its only
 * alternative shapes — `--tab`, `--xml` — are not a script, so nothing downstream could read them
 * (J-48d).
 *
 * The privilege-related flags are load-bearing. `--single-transaction` takes a
 * `FLUSH TABLES WITH READ LOCK` on some versions, which needs RELOAD; `--skip-opt`
 * plus `--create-options` gets a clean dump without RELOAD, PROCESS or SUPER, which
 * managed instances routinely withhold.
 */
export function buildMysqlDumpArgs(host: CliHost, database: string, backupPath: string): string[] {
  return [
    '-h',
    host.server,
    '-P',
    String(host.port),
    '-u',
    host.username || 'root',
    '--skip-opt',
    '--create-options',
    '--add-drop-table',
    '--set-charset',
    '--extended-insert',
    '--quick',
    '--triggers',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    '--column-statistics=0',
    '--result-file',
    backupPath,
    database,
  ];
}

/**
 * Resolve whether the user asked to overwrite an existing database.
 *
 * The renderer restore dialog populates `withReplace`, while the legacy
 * service/IPC contract used `replaceExisting`. Both spellings mean the same
 * thing — honor either so the "Overwrite" checkbox can't be silently dropped.
 */
export function resolveReplaceExisting(request: RestoreRequest): boolean {
  // Either flag being truthy means "overwrite requested" — they are aliases,
  // never used to express conflicting intent.
  return Boolean(request.replaceExisting || request.withReplace);
}

/**
 * The database a restore will actually write into.
 *
 * `targetDatabase` is optional on the wire, and the operation claim and the statement have to name
 * the same database or the claim guards nothing. It was written out twice in `startRestore` with a
 * comment tying the copies together; this is that comment made mechanical (J-112).
 */
export function resolveRestoreTarget(request: RestoreRequest): string {
  return request.targetDatabase || 'RestoredDatabase';
}

/**
 * The exact `BACKUP …` statement `BackupRestoreService.startBackup` sends to the server.
 *
 * Pulled out of that method so the statement can be produced from a request alone — no pool, no
 * connection, no in-flight operation. The backup dialog shows the user a preview of this SQL
 * (`packages/renderer/src/features/backup/backup-model.ts:backupTsql`) and the renderer may not
 * import from `packages/main`, so the preview is a second implementation. Before J-112 nothing
 * tied the two together: `tests/fixtures/tsql-preview/mssql-statements.sql` is now generated from
 * THIS function by `mssql-preview-fixture.spec.ts` and the preview is asserted against that
 * fixture, so a change here fails a test rather than quietly falsifying the preview.
 */
export function buildMssqlBackupTsql(request: BackupRequest): string {
  return TsqlBuilder.backup({
    databaseName: request.database,
    destinationPath: request.backupPath,
    // `backupType` is optional on the wire because PostgreSQL and MySQL have no such choice to
    // express (J-48d). This is the SQL Server path, where the dialog always sends one; `'full'`
    // is what `BACKUP DATABASE` does with no type clause, so an omission runs the same statement
    // it names rather than a different one.
    backupType: request.backupType ?? 'full',
    compression: request.compression ?? false,
    // Both of these reached the builder and were dropped on the floor before J-48: `checksum`
    // arrived as a `verify` the builder never read, and `copyOnly` was read by nothing anywhere.
    checksum: request.checksum ?? false,
    copyOnly: request.copyOnly ?? false,
    description: request.description,
  });
}

/**
 * The exact `RESTORE DATABASE …` statement `BackupRestoreService.startRestore` sends to the server.
 *
 * Same reason as {@link buildMssqlBackupTsql}: the restore dialog previews this statement from its
 * own implementation (`packages/renderer/src/features/restore/restore-model.ts:restoreTsql`), and
 * the fixture generated from here is what keeps the two honest (J-112).
 */
export function buildMssqlRestoreTsql(request: RestoreRequest): string {
  // Convert file relocations to file moves. A relocation with neither path is nothing to move.
  const fileMoves = (request.fileRelocations || [])
    .filter(r => r.physicalName || r.newPath)
    .map(r => ({
      logicalName: r.logicalName,
      destinationPath: r.physicalName || r.newPath || '',
    }));

  return TsqlBuilder.restore({
    sourcePath: request.backupPath,
    targetDatabaseName: resolveRestoreTarget(request),
    overwriteExisting: resolveReplaceExisting(request),
    fileMoves,
    recoveryState: (request.recoveryState?.toLowerCase() ||
      (request.withNoRecovery ? 'norecovery' : 'recovery')) as
      'recovery' | 'norecovery' | 'standby',
  });
}

/**
 * Build the argument vector for `pg_restore`. Options precede the positional
 * archive path, which pg_restore requires.
 */
export function buildPgRestoreArgs(
  profile: CliHost,
  request: RestoreRequest,
  targetDb: string
): string[] {
  const args = [
    '-h',
    profile.server,
    '-p',
    String(profile.port),
    '-U',
    profile.username || 'postgres',
    '-d',
    targetDb,
    '-v', // verbose — drives progress reporting
  ];

  if (resolveReplaceExisting(request)) {
    // --clean drops objects before recreating them; --if-exists keeps the
    // drops from erroring when an object isn't present yet.
    args.push('--clean', '--if-exists');
  }

  args.push(request.backupPath);
  return args;
}

/**
 * Build the SQL prelude piped to the `mysql` CLI ahead of the dump stream.
 *
 * The mysql CLI connects without a default database (so restoring into a new
 * database doesn't error at connect time), then this prelude guarantees the
 * target exists and is selected. When replacing, the existing database is
 * dropped first so the dump lands in a clean schema instead of colliding
 * with existing objects.
 *
 * `targetDb` is validated by the caller to match /^[A-Za-z0-9_]+$/, so
 * backtick-quoting alone is safe here.
 */
export function buildMysqlRestorePrelude(targetDb: string, replace: boolean): string {
  if (replace) {
    return `DROP DATABASE IF EXISTS \`${targetDb}\`;\nCREATE DATABASE \`${targetDb}\`;\nUSE \`${targetDb}\`;\n`;
  }
  return `CREATE DATABASE IF NOT EXISTS \`${targetDb}\`;\nUSE \`${targetDb}\`;\n`;
}
