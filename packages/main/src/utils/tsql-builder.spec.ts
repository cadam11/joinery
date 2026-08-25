import { describe, it, expect } from 'vitest';
import { TsqlBuilder } from './tsql-builder';

describe('TsqlBuilder', () => {
  describe('escapeIdentifier', () => {
    it('should wrap identifiers in brackets', () => {
      expect(TsqlBuilder.escapeIdentifier('MyTable')).toBe('[MyTable]');
    });

    it('should escape brackets within identifiers', () => {
      expect(TsqlBuilder.escapeIdentifier('My[Table]')).toBe('[My[Table]]]');
    });
  });

  describe('escapeString', () => {
    it('should return the string unchanged if no quotes', () => {
      expect(TsqlBuilder.escapeString('hello')).toBe('hello');
    });

    it('should escape single quotes', () => {
      expect(TsqlBuilder.escapeString("it's")).toBe("it''s");
    });
  });

  describe('createDatabase', () => {
    it('should generate basic CREATE DATABASE', () => {
      const sql = TsqlBuilder.createDatabase({ name: 'TestDB' });
      expect(sql).toContain('CREATE DATABASE [TestDB]');
    });

    it('should include collation when specified', () => {
      const sql = TsqlBuilder.createDatabase({
        name: 'TestDB',
        collation: 'SQL_Latin1_General_CP1_CI_AS',
      });
      expect(sql).toContain('COLLATE SQL_Latin1_General_CP1_CI_AS');
    });

    it('should include recovery model when specified', () => {
      const sql = TsqlBuilder.createDatabase({
        name: 'TestDB',
        recoveryModel: 'simple',
      });
      expect(sql).toContain('ALTER DATABASE [TestDB]');
      expect(sql).toContain('SET RECOVERY SIMPLE');
    });
  });

  describe('renameDatabase', () => {
    it('should generate rename statements', () => {
      const sql = TsqlBuilder.renameDatabase({
        currentName: 'OldName',
        newName: 'NewName',
      });
      expect(sql).toContain('ALTER DATABASE [OldName]');
      expect(sql).toContain('MODIFY NAME = [NewName]');
    });

    it('should include connection closing when requested', () => {
      const sql = TsqlBuilder.renameDatabase({
        currentName: 'OldName',
        newName: 'NewName',
        closeConnections: true,
      });
      expect(sql).toContain('SET SINGLE_USER');
      expect(sql).toContain('ROLLBACK IMMEDIATE');
      expect(sql).toContain('SET MULTI_USER');
    });
  });

  describe('deleteDatabase', () => {
    it('should generate DROP DATABASE', () => {
      const sql = TsqlBuilder.deleteDatabase({ name: 'TestDB' });
      expect(sql).toContain('DROP DATABASE [TestDB]');
    });

    it('should include connection closing when requested', () => {
      const sql = TsqlBuilder.deleteDatabase({
        name: 'TestDB',
        closeConnections: true,
      });
      expect(sql).toContain('SET SINGLE_USER');
      expect(sql).toContain('ROLLBACK IMMEDIATE');
    });
  });

  describe('backup', () => {
    it('should generate BACKUP DATABASE', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full',
        compression: false,
        checksum: false,
      });
      expect(sql).toContain('BACKUP DATABASE [TestDB]');
      expect(sql).toContain("TO DISK = N'/backup/test.bak'");
    });

    it('should include compression when specified', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full',
        compression: true,
        checksum: false,
      });
      expect(sql).toContain('COMPRESSION');
    });

    it('should handle copy-only backups', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full_copy_only',
        compression: false,
        checksum: false,
      });
      expect(sql).toContain('COPY_ONLY');
    });

    // ── J-48a: the data-safety half ────────────────────────────────────────────────────────
    //
    // `'log'` matched neither arm of the old type branch and then picked up `INIT` with
    // everything else, so a requested transaction-log backup ran as `BACKUP DATABASE ... WITH
    // INIT` — a FULL backup that overwrote the destination — and reported success. These four
    // are the regression guard on that.

    it('takes a log backup with BACKUP LOG, not BACKUP DATABASE', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.trn',
        backupType: 'log',
        compression: false,
        checksum: false,
      });
      expect(sql).toContain('BACKUP LOG [TestDB]');
      expect(sql).not.toContain('BACKUP DATABASE');
    });

    it('appends a log backup rather than overwriting the file it is written to', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.trn',
        backupType: 'log',
        compression: false,
        checksum: false,
      });
      // The destructive half of the bug: INIT discards every backup already in the file, which
      // for a log chain is the chain itself.
      expect(sql).toContain('NOINIT');
      expect(sql).not.toMatch(/\bINIT\b(?<!NOINIT)/);
    });

    it('never marks a log backup DIFFERENTIAL', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.trn',
        backupType: 'log',
        compression: false,
        checksum: false,
      });
      expect(sql).not.toContain('DIFFERENTIAL');
    });

    it('still overwrites for a database backup, which is the behaviour that was already shipped', () => {
      for (const backupType of ['full', 'differential'] as const) {
        const sql = TsqlBuilder.backup({
          databaseName: 'TestDB',
          destinationPath: '/backup/test.bak',
          backupType,
          compression: false,
          checksum: false,
        });
        expect(sql).toContain('BACKUP DATABASE [TestDB]');
        expect(sql).toContain('INIT');
        expect(sql).not.toContain('NOINIT');
      }
    });

    // ── J-48b and J-48c: the two fields the builder used to ignore ──────────────────────────

    it('emits COPY_ONLY for the copyOnly flag, which nothing used to read', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full',
        compression: false,
        checksum: false,
        copyOnly: true,
      });
      expect(sql).toContain('COPY_ONLY');
    });

    it('emits COPY_ONLY for a log backup too, where it is equally legal', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.trn',
        backupType: 'log',
        compression: false,
        checksum: false,
        copyOnly: true,
      });
      expect(sql).toContain('BACKUP LOG [TestDB]');
      expect(sql).toContain('COPY_ONLY');
    });

    it('emits CHECKSUM, which used to arrive as a `verify` the builder never read', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full',
        compression: false,
        checksum: true,
      });
      expect(sql).toContain('CHECKSUM');
    });

    it('omits both when they are not asked for', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full',
        compression: false,
        checksum: false,
        copyOnly: false,
      });
      expect(sql).not.toContain('COPY_ONLY');
      expect(sql).not.toContain('CHECKSUM');
    });

    it('should include description when specified', () => {
      const sql = TsqlBuilder.backup({
        databaseName: 'TestDB',
        destinationPath: '/backup/test.bak',
        backupType: 'full',
        compression: false,
        checksum: false,
        description: 'Test backup',
      });
      expect(sql).toContain("DESCRIPTION = N'Test backup'");
    });
  });

  describe('restore', () => {
    it('should generate RESTORE DATABASE', () => {
      const sql = TsqlBuilder.restore({
        sourcePath: '/backup/test.bak',
        targetDatabaseName: 'RestoredDB',
        overwriteExisting: false,
        fileMoves: [],
        recoveryState: 'recovery',
      });
      expect(sql).toContain('RESTORE DATABASE [RestoredDB]');
      expect(sql).toContain("FROM DISK = N'/backup/test.bak'");
    });

    it('should include REPLACE when overwriting', () => {
      const sql = TsqlBuilder.restore({
        sourcePath: '/backup/test.bak',
        targetDatabaseName: 'RestoredDB',
        overwriteExisting: true,
        fileMoves: [],
        recoveryState: 'recovery',
      });
      expect(sql).toContain('REPLACE');
    });

    it('should include file moves', () => {
      const sql = TsqlBuilder.restore({
        sourcePath: '/backup/test.bak',
        targetDatabaseName: 'RestoredDB',
        overwriteExisting: false,
        fileMoves: [
          { logicalName: 'TestDB', destinationPath: '/data/test.mdf' },
          { logicalName: 'TestDB_Log', destinationPath: '/data/test.ldf' },
        ],
        recoveryState: 'recovery',
      });
      expect(sql).toContain("MOVE N'TestDB' TO N'/data/test.mdf'");
      expect(sql).toContain("MOVE N'TestDB_Log' TO N'/data/test.ldf'");
    });

    it('should handle NORECOVERY state', () => {
      const sql = TsqlBuilder.restore({
        sourcePath: '/backup/test.bak',
        targetDatabaseName: 'RestoredDB',
        overwriteExisting: false,
        fileMoves: [],
        recoveryState: 'norecovery',
      });
      expect(sql).toContain('NORECOVERY');
    });
  });
});
