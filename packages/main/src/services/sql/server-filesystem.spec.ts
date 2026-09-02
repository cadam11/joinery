/**
 * Unit coverage for the xp_dirtree row mapper.
 *
 * Regression guard for the server file browser bug where every entry — folders
 * included — rendered as a file, so no directory could ever be opened. The
 * temp table declares `isfile BIT`, and node-mssql/tedious maps BIT to a
 * JavaScript boolean; the old `row.isfile === 0` test is therefore always
 * false. These cases pin both the boolean form the real driver returns and the
 * numeric form a different driver or a hand-rolled mock might produce.
 */

import { describe, expect, it } from 'vitest';

import {
  ServerFilesystemService,
  mapDirTreeRow,
  sanitizeServerPathForTest as sanitizeServerPath,
  serverPathStyle,
} from './server-filesystem';

describe('mapDirTreeRow', () => {
  describe('boolean BIT (what node-mssql/tedious actually returns)', () => {
    it('treats isfile=false as a directory', () => {
      const entry = mapDirTreeRow({ name: 'Backups', depth: 1, isfile: false }, 'C:\\');
      expect(entry.isDirectory).toBe(true);
    });

    it('treats isfile=true as a file', () => {
      const entry = mapDirTreeRow({ name: 'db.bak', depth: 1, isfile: true }, 'C:\\');
      expect(entry.isDirectory).toBe(false);
    });
  });

  describe('numeric BIT', () => {
    it('treats isfile=0 as a directory', () => {
      const entry = mapDirTreeRow({ name: 'Backups', depth: 1, isfile: 0 }, 'C:\\');
      expect(entry.isDirectory).toBe(true);
    });

    it('treats isfile=1 as a file', () => {
      const entry = mapDirTreeRow({ name: 'db.bak', depth: 1, isfile: 1 }, 'C:\\');
      expect(entry.isDirectory).toBe(false);
    });
  });

  it('joins the entry name onto the already-normalized parent path', () => {
    const entry = mapDirTreeRow({ name: 'nightly.bak', depth: 2, isfile: true }, 'C:\\Backups\\');
    expect(entry).toEqual({
      name: 'nightly.bak',
      path: 'C:\\Backups\\nightly.bak',
      isDirectory: false,
      depth: 2,
    });
  });
});

describe('sanitizeServerPath — the injection guard (J-50)', () => {
  /**
   * The value is interpolated into an `xp_dirtree` call, so what this REFUSES is the point. It
   * accepted Windows paths only, which meant SQL Server on Linux — `/var/opt/mssql/data`, the
   * container this repo's own harness runs — could not be browsed at all.
   */

  describe('paths it now accepts', () => {
    it.each([
      ['C:\\', 'a drive root'],
      ['C:\\Program Files\\Microsoft SQL Server\\', 'a Windows path with spaces'],
      ['\\\\fileserver\\backups\\', 'UNC'],
      ['/var/opt/mssql/data/', 'the Linux default data directory'],
      ['/', 'the POSIX root'],
      ['/var/opt/mssql/My Backups/', 'a POSIX path with spaces'],
    ])('accepts %s — %s', path => {
      expect(() => sanitizeServerPath(path)).not.toThrow();
    });

    it('escapes a single quote rather than refusing it — it is legal in a filename', () => {
      expect(sanitizeServerPath("/var/opt/o'brien/")).toBe("/var/opt/o''brien/");
      expect(sanitizeServerPath("C:\\o'brien\\")).toBe("C:\\o''brien\\");
    });
  });

  describe('paths it refuses', () => {
    it.each([
      ['relative/path', 'not rooted — nothing this app produces'],
      ['var/opt/mssql', 'POSIX without its leading slash'],
      ['C:relative', 'a drive letter with no separator'],
      ['', 'empty'],
      ['   ', 'blank'],
    ])('refuses %s — %s', path => {
      expect(() => sanitizeServerPath(path)).toThrow(/Invalid server path/);
    });

    it.each([
      ['/var/opt/../../etc/', 'POSIX traversal'],
      ['C:\\data\\..\\..\\Windows\\', 'Windows traversal'],
      ['/var/..', 'a trailing traversal segment'],
    ])('refuses %s — %s', path => {
      // New with J-50. The renderer computes a parent by slicing, so nothing legitimate emits a
      // `..` — which makes one arriving here a sign the caller is not the app.
      expect(() => sanitizeServerPath(path)).toThrow(/Invalid server path/);
    });

    it('refuses a POSIX path carrying a backslash', () => {
      // Legal in a Linux filename, never produced by this app, and exactly the shape a caller
      // confusing the two styles would send.
      expect(() => sanitizeServerPath('/var/opt\\mssql/')).toThrow(/Invalid server path/);
    });

    it.each([
      ["/var/opt/'; DROP TABLE users; --", 'a statement terminator and a comment'],
      ['/var/opt/data--x/', 'a SQL comment marker'],
      ['C:\\data; EXEC xp_cmdshell', 'EXEC'],
      ['/var/SELECT/', 'SELECT'],
      ['C:\\INSERT\\', 'INSERT'],
    ])('refuses %s — %s', path => {
      expect(() => sanitizeServerPath(path)).toThrow(/invalid characters/i);
    });

    it('refuses the injection patterns in POSIX paths too, not only Windows ones', () => {
      // The widening must not have opened a second door: every refusal that applied to a Windows
      // path applies to a POSIX one.
      for (const payload of [';', '--', 'DROP', 'DELETE', 'UPDATE']) {
        expect(() => sanitizeServerPath(`/var/opt/${payload}/`)).toThrow();
      }
    });
  });

  describe('serverPathStyle', () => {
    it.each([
      ['C:\\data\\', 'windows'],
      ['\\\\server\\share\\', 'windows'],
      ['/var/opt/', 'posix'],
    ])('reads %s as %s', (path, style) => {
      expect(serverPathStyle(path)).toBe(style);
    });

    it('answers null for anything unrooted, so one place refuses it', () => {
      expect(serverPathStyle('data')).toBeNull();
    });
  });
});

describe('ServerFilesystemService surface (J-49)', () => {
  /**
   * `pathExists` was removed, not repaired. It ran
   * `SELECT @exists as exists;` — `EXISTS` is a T-SQL reserved keyword, so an unbracketed alias
   * is a syntax error and the statement failed on every call. A bare `catch { return false; }`
   * turned that into a permanent, silent `false`, which is precisely the answer a caller would
   * read as "the path is not there". Nothing ever called it, so there is no behaviour to keep;
   * this pins that a broken, error-swallowing probe does not come back untested.
   */
  it('exposes no pathExists', () => {
    expect(Object.getOwnPropertyNames(ServerFilesystemService.prototype)).not.toContain(
      'pathExists'
    );
  });
});
