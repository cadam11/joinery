import { describe, expect, it } from 'vitest';
import type { CliBackupRequest, RestoreRequest } from '@joinery/shared';
import {
  resolveReplaceExisting,
  buildPgRestoreArgs,
  buildMysqlRestorePrelude,
  buildPgDumpArgs,
  buildMysqlDumpArgs,
  PG_DUMP_FORMAT,
} from './backup-args';

const baseRequest = (over: Partial<RestoreRequest> = {}): RestoreRequest => ({
  connectionId: 'c1',
  backupPath: '/tmp/dump.sql',
  ...over,
});

describe('resolveReplaceExisting', () => {
  it('is false when neither flag is set', () => {
    expect(resolveReplaceExisting(baseRequest())).toBe(false);
  });

  it('honors replaceExisting', () => {
    expect(resolveReplaceExisting(baseRequest({ replaceExisting: true }))).toBe(true);
  });

  // The renderer restore dialog only ever populates `withReplace` — the bug
  // was that the PG/MySQL services checked `replaceExisting`, so the user's
  // "Overwrite" checkbox was silently dropped. Pin both spellings.
  it('honors withReplace (the alias the dialog actually sends)', () => {
    expect(resolveReplaceExisting(baseRequest({ withReplace: true }))).toBe(true);
  });

  it('treats either flag being true as true', () => {
    expect(resolveReplaceExisting(baseRequest({ replaceExisting: false, withReplace: true }))).toBe(
      true
    );
  });
});

describe('buildPgRestoreArgs', () => {
  const profile = { server: 'db.example.com', port: 5432, username: 'pguser' };

  it('builds base args with verbose and the backup path last', () => {
    const args = buildPgRestoreArgs(profile, baseRequest(), 'targetdb');
    expect(args).toEqual([
      '-h',
      'db.example.com',
      '-p',
      '5432',
      '-U',
      'pguser',
      '-d',
      'targetdb',
      '-v',
      '/tmp/dump.sql',
    ]);
  });

  it('adds --clean --if-exists when withReplace is set, before the positional path', () => {
    const args = buildPgRestoreArgs(profile, baseRequest({ withReplace: true }), 'targetdb');
    const cleanIdx = args.indexOf('--clean');
    expect(cleanIdx).toBeGreaterThan(-1);
    expect(args[cleanIdx + 1]).toBe('--if-exists');
    // pg_restore options must precede the positional archive path.
    expect(cleanIdx).toBeLessThan(args.indexOf('/tmp/dump.sql'));
  });

  it('defaults the username to postgres', () => {
    const args = buildPgRestoreArgs({ server: 'h', port: 5432 }, baseRequest(), 'd');
    expect(args[args.indexOf('-U') + 1]).toBe('postgres');
  });
});

describe('buildMysqlRestorePrelude', () => {
  it('creates the target database if missing and uses it (no replace)', () => {
    expect(buildMysqlRestorePrelude('mydb', false)).toBe(
      'CREATE DATABASE IF NOT EXISTS `mydb`;\nUSE `mydb`;\n'
    );
  });

  // With replace, the existing database must be dropped first so the dump
  // restores into a clean schema rather than colliding with existing objects.
  it('drops and recreates the target database when replace is set', () => {
    expect(buildMysqlRestorePrelude('mydb', true)).toBe(
      'DROP DATABASE IF EXISTS `mydb`;\nCREATE DATABASE `mydb`;\nUSE `mydb`;\n'
    );
  });
});

/**
 * J-48(d): the dump format is a fact per engine, not a choice.
 *
 * The Angular dialog offered a four-option "Dump Format" picker for PostgreSQL and MySQL, and
 * every option produced a byte-identical dump — `pg-backup.ts` hard-coded `-F c` and
 * `mysql-backup.ts` never read the field. Craig's ruling was to type the choice out of existence
 * rather than implement it, so these builders take no format argument at all and these tests pin
 * the single format each one emits.
 */
describe('buildPgDumpArgs', () => {
  const profile = { server: 'db.example.com', port: 5432, username: 'pguser' };

  it('always asks pg_dump for the custom format, exactly once', () => {
    const args = buildPgDumpArgs(profile, 'sales', '/tmp/sales.dump');
    const formatFlags = args.filter(arg => arg === '-F' || arg.startsWith('--format'));
    expect(formatFlags).toEqual(['-F']);
    expect(args[args.indexOf('-F') + 1]).toBe(PG_DUMP_FORMAT);
    expect(PG_DUMP_FORMAT).toBe('c');
  });

  it('builds the whole vector the service used to build inline', () => {
    expect(buildPgDumpArgs(profile, 'sales', '/tmp/sales.dump')).toEqual([
      '-h',
      'db.example.com',
      '-p',
      '5432',
      '-U',
      'pguser',
      '-d',
      'sales',
      '-F',
      'c',
      '-v',
      '-f',
      '/tmp/sales.dump',
    ]);
  });

  it('defaults the username to postgres', () => {
    const args = buildPgDumpArgs({ server: 'h', port: 5432 }, 'sales', '/tmp/s.dump');
    expect(args[args.indexOf('-U') + 1]).toBe('postgres');
  });

  // The format cannot vary with anything the caller passes: same database, different destination,
  // same `-F c`. This is the property the picker used to pretend was false.
  it('emits the same format regardless of database or destination', () => {
    const a = buildPgDumpArgs(profile, 'sales', '/tmp/a.dump');
    const b = buildPgDumpArgs(profile, 'other', '/var/backups/b.dump');
    expect(a[a.indexOf('-F') + 1]).toBe(b[b.indexOf('-F') + 1]);
  });
});

describe('buildMysqlDumpArgs', () => {
  const profile = { server: 'db.example.com', port: 3306, username: 'appuser' };

  // mysqldump's only other output shape is `--tab`, which writes a directory of files rather than
  // the single script Joinery names, restores and documents. No format flag at all IS the fact.
  it('carries no format flag of any kind', () => {
    const args = buildMysqlDumpArgs(profile, 'sales', '/tmp/sales.sql');
    for (const flag of ['-F', '--format', '--tab', '-T', '--xml', '-X']) {
      expect(args).not.toContain(flag);
    }
    expect(args.some(arg => arg.startsWith('--tab=') || arg.startsWith('--format'))).toBe(false);
  });

  it('writes a plain SQL script to the destination and names the database last', () => {
    const args = buildMysqlDumpArgs(profile, 'sales', '/tmp/sales.sql');
    expect(args[args.indexOf('--result-file') + 1]).toBe('/tmp/sales.sql');
    expect(args[args.length - 1]).toBe('sales');
  });

  it('builds the whole vector the service used to build inline', () => {
    expect(buildMysqlDumpArgs(profile, 'sales', '/tmp/sales.sql')).toEqual([
      '-h',
      'db.example.com',
      '-P',
      '3306',
      '-u',
      'appuser',
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
      '/tmp/sales.sql',
      'sales',
    ]);
  });

  it('defaults the username to root', () => {
    const args = buildMysqlDumpArgs({ server: 'h', port: 3306 }, 'sales', '/tmp/s.sql');
    expect(args[args.indexOf('-u') + 1]).toBe('root');
  });
});

describe('CliBackupRequest', () => {
  // The type-level half of the ruling: the request the CLI engines receive has no `backupType`, so
  // neither service can grow a format branch again without changing this type first.
  it('has no backup type to read', () => {
    const request: CliBackupRequest = {
      connectionId: 'c1',
      database: 'sales',
      backupPath: '/tmp/sales.dump',
    };
    // @ts-expect-error — there is no dump format to choose on the PG/MySQL path (J-48d).
    expect(request.backupType).toBeUndefined();
  });
});
