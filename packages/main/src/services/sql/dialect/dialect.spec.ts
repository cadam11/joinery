/**
 * Tests for SQL Dialect implementations
 */

import { describe, it, expect } from 'vitest';
import { MSSQLDialect } from './mssql-dialect';
import { PgDialect } from './pg-dialect';
import { MySQLDialect } from './mysql-dialect';
import { getDialect, capabilitiesForDialect } from './index';
import { PgDsqlDialect } from './pg-dsql-dialect';

describe('getDialect factory', () => {
  it('returns MSSQLDialect for mssql engine', () => {
    const dialect = getDialect('mssql');
    expect(dialect).toBeInstanceOf(MSSQLDialect);
    expect(dialect.engine).toBe('mssql');
  });

  it('returns PgDialect for postgresql engine', () => {
    const dialect = getDialect('postgresql');
    expect(dialect).toBeInstanceOf(PgDialect);
    expect(dialect.engine).toBe('postgresql');
  });

  it('returns MySQLDialect for mysql engine', () => {
    const dialect = getDialect('mysql');
    expect(dialect).toBeInstanceOf(MySQLDialect);
    expect(dialect.engine).toBe('mysql');
  });
});

describe('MSSQLDialect', () => {
  const dialect = new MSSQLDialect();

  describe('properties', () => {
    it('has correct engine', () => expect(dialect.engine).toBe('mssql'));
    it('has correct label', () => expect(dialect.label).toBe('SQL Server'));
    it('has correct default port', () => expect(dialect.defaultPort).toBe(1433));
    it('has correct Monaco language', () => expect(dialect.monacoLanguage).toBe('sql'));
    it('has GO batch separator', () => expect(dialect.batchSeparator).toBe('GO'));
    it('supports batch separator', () => expect(dialect.supportsBatchSeparator).toBe(true));
    it('supports Windows auth', () => expect(dialect.supportsWindowsAuth).toBe(true));
    it('supports backup/restore', () => expect(dialect.supportsBackupRestore).toBe(true));
    it('supports extended properties', () => expect(dialect.supportsExtendedProperties).toBe(true));
    it('supports server file browsing', () =>
      expect(dialect.supportsServerFileBrowsing).toBe(true));
  });

  describe('quoteIdentifier', () => {
    it('wraps name in brackets', () => {
      expect(dialect.quoteIdentifier('Users')).toBe('[Users]');
    });

    it('escapes closing brackets', () => {
      expect(dialect.quoteIdentifier('Table]Name')).toBe('[Table]]Name]');
    });

    it('handles empty string', () => {
      expect(dialect.quoteIdentifier('')).toBe('[]');
    });
  });

  describe('quoteSchemaObject', () => {
    it('quotes schema and object separately', () => {
      expect(dialect.quoteSchemaObject('dbo', 'Users')).toBe('[dbo].[Users]');
    });
  });

  describe('escapeString', () => {
    it('escapes single quotes', () => {
      expect(dialect.escapeString("O'Brien")).toBe("O''Brien");
    });

    it('handles strings without quotes', () => {
      expect(dialect.escapeString('hello')).toBe('hello');
    });
  });

  describe('useDatabaseSQL', () => {
    it('generates USE statement with brackets', () => {
      expect(dialect.useDatabaseSQL('mydb')).toBe('USE [mydb];');
    });

    it('escapes brackets in database name', () => {
      expect(dialect.useDatabaseSQL('my]db')).toBe('USE [my]]db];');
    });
  });

  describe('DDL', () => {
    it('generates CREATE DATABASE', () => {
      const sql = dialect.createDatabaseSQL({ name: 'TestDB' });
      expect(sql).toContain('CREATE DATABASE');
      expect(sql).toContain('[TestDB]');
    });

    it('generates CREATE DATABASE with collation', () => {
      const sql = dialect.createDatabaseSQL({ name: 'TestDB', collation: 'Latin1_General_CI_AS' });
      expect(sql).toContain('COLLATE Latin1_General_CI_AS');
    });

    it('generates DROP DATABASE', () => {
      const sql = dialect.dropDatabaseSQL({ name: 'TestDB' });
      expect(sql).toContain('DROP DATABASE');
      expect(sql).toContain('[TestDB]');
    });

    it('generates DROP DATABASE with close connections', () => {
      const sql = dialect.dropDatabaseSQL({ name: 'TestDB', closeConnections: true });
      expect(sql).toContain('SET SINGLE_USER');
      expect(sql).toContain('DROP DATABASE');
    });

    it('generates RENAME DATABASE', () => {
      const sql = dialect.renameDatabaseSQL({ currentName: 'OldDB', newName: 'NewDB' });
      expect(sql).toContain('MODIFY NAME');
      expect(sql).toContain('[OldDB]');
      expect(sql).toContain('[NewDB]');
    });
  });

  describe('metadata queries', () => {
    it('generates listDatabases SQL for on-prem (with msdb backup history)', () => {
      const sql = dialect.listDatabasesSQL(false);
      expect(sql).toContain('sys.databases');
      expect(sql).toContain('msdb.dbo.backupset');
    });

    it('generates listDatabases SQL for Azure SQL (no msdb references)', () => {
      const sql = dialect.listDatabasesSQL(true);
      expect(sql).toContain('sys.databases');
      expect(sql).not.toContain('msdb.dbo.backupset');
    });

    it('generates listSchemas SQL', () => {
      const sql = dialect.listSchemasSQL('mydb');
      expect(sql).toContain('sys.schemas');
      expect(sql).toContain('USE [mydb]');
    });

    it('generates listTables SQL', () => {
      const sql = dialect.listTablesSQL('mydb');
      expect(sql).toContain('sys.tables');
      expect(sql).toContain('USE [mydb]');
    });

    it('generates listViews SQL', () => {
      const sql = dialect.listViewsSQL('mydb');
      expect(sql).toContain('sys.views');
    });

    it('generates listProcedures SQL', () => {
      const sql = dialect.listProceduresSQL('mydb');
      expect(sql).toContain('sys.procedures');
    });

    it('generates listFunctions SQL', () => {
      const sql = dialect.listFunctionsSQL('mydb');
      expect(sql).toContain('sys.objects');
    });

    it('generates listColumns SQL', () => {
      const sql = dialect.listColumnsSQL('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.columns');
      expect(sql).toContain("'dbo'");
      expect(sql).toContain("'Users'");
    });

    it('generates listIndexes SQL', () => {
      const sql = dialect.listIndexesSQL('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.indexes');
    });

    it('generates listForeignKeys SQL', () => {
      const sql = dialect.listForeignKeysSQL('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.foreign_keys');
    });

    it('generates listConstraints SQL', () => {
      const sql = dialect.listConstraintsSQL('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.key_constraints');
    });

    it('generates listTriggers SQL', () => {
      const sql = dialect.listTriggersSQL('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.triggers');
    });

    it('generates getObjectDefinition SQL', () => {
      const sql = dialect.getObjectDefinitionSQL('mydb', 'dbo', 'myView');
      expect(sql).toContain('OBJECT_DEFINITION');
    });

    it('generates listObjectComments SQL (extended properties)', () => {
      const sql = dialect.listObjectCommentsSQL('mydb', 'dbo', 'Users');
      expect(sql).toBeDefined();
      expect(sql.length).toBeGreaterThan(0);
    });
  });

  describe('feature flags', () => {
    it('supports object comments', () => expect(dialect.supportsObjectComments).toBe(true));
  });
});

describe('PgDialect', () => {
  const dialect = new PgDialect();

  describe('properties', () => {
    it('has correct engine', () => expect(dialect.engine).toBe('postgresql'));
    it('has correct label', () => expect(dialect.label).toBe('PostgreSQL'));
    it('has correct default port', () => expect(dialect.defaultPort).toBe(5432));
    it('has correct Monaco language', () => expect(dialect.monacoLanguage).toBe('pgsql'));
    it('has no batch separator', () => expect(dialect.batchSeparator).toBeNull());
    it('does not support batch separator', () =>
      expect(dialect.supportsBatchSeparator).toBe(false));
    it('does not support Windows auth', () => expect(dialect.supportsWindowsAuth).toBe(false));
    it('does not support backup/restore', () => expect(dialect.supportsBackupRestore).toBe(false));
    it('does not support extended properties', () =>
      expect(dialect.supportsExtendedProperties).toBe(false));
    it('does not support server file browsing', () =>
      expect(dialect.supportsServerFileBrowsing).toBe(false));
  });

  describe('quoteIdentifier', () => {
    it('wraps name in double quotes', () => {
      expect(dialect.quoteIdentifier('users')).toBe('"users"');
    });

    it('escapes double quotes', () => {
      expect(dialect.quoteIdentifier('table"name')).toBe('"table""name"');
    });

    it('handles empty string', () => {
      expect(dialect.quoteIdentifier('')).toBe('""');
    });
  });

  describe('quoteSchemaObject', () => {
    it('quotes schema and object separately', () => {
      expect(dialect.quoteSchemaObject('public', 'users')).toBe('"public"."users"');
    });
  });

  describe('useDatabaseSQL', () => {
    it('returns empty string (PG uses connection-level DB)', () => {
      expect(dialect.useDatabaseSQL('mydb')).toBe('');
    });
  });

  describe('DDL', () => {
    it('generates CREATE DATABASE', () => {
      const sql = dialect.createDatabaseSQL({ name: 'testdb' });
      expect(sql).toContain('CREATE DATABASE');
      expect(sql).toContain('"testdb"');
    });

    it('generates CREATE DATABASE with collation', () => {
      const sql = dialect.createDatabaseSQL({ name: 'testdb', collation: 'en_US.UTF-8' });
      expect(sql).toContain("LC_COLLATE = 'en_US.UTF-8'");
    });

    it('generates DROP DATABASE', () => {
      const sql = dialect.dropDatabaseSQL({ name: 'testdb' });
      expect(sql).toContain('DROP DATABASE');
      expect(sql).toContain('"testdb"');
    });

    it('generates DROP DATABASE with close connections', () => {
      const sql = dialect.dropDatabaseSQL({ name: 'testdb', closeConnections: true });
      expect(sql).toContain('pg_terminate_backend');
      expect(sql).toContain('DROP DATABASE');
    });

    it('generates RENAME DATABASE', () => {
      const sql = dialect.renameDatabaseSQL({ currentName: 'olddb', newName: 'newdb' });
      expect(sql).toContain('ALTER DATABASE');
      expect(sql).toContain('RENAME TO');
      expect(sql).toContain('"olddb"');
      expect(sql).toContain('"newdb"');
    });

    it('generates RENAME with close connections', () => {
      const sql = dialect.renameDatabaseSQL({
        currentName: 'olddb',
        newName: 'newdb',
        closeConnections: true,
      });
      expect(sql).toContain('pg_terminate_backend');
      expect(sql).toContain('RENAME TO');
    });
  });

  describe('metadata queries', () => {
    it('generates listDatabases SQL using pg_database', () => {
      const sql = dialect.listDatabasesSQL();
      expect(sql).toContain('pg_database');
      expect(sql).not.toContain('sys.databases');
    });

    it('generates listSchemas SQL using pg_namespace', () => {
      const sql = dialect.listSchemasSQL('mydb');
      expect(sql).toContain('pg_namespace');
      expect(sql).not.toContain('sys.schemas');
    });

    it('generates listTables SQL using pg_tables', () => {
      const sql = dialect.listTablesSQL('mydb');
      expect(sql).toContain('pg_tables');
      expect(sql).not.toContain('sys.tables');
    });

    it('generates listViews SQL using pg_views', () => {
      const sql = dialect.listViewsSQL('mydb');
      expect(sql).toContain('pg_views');
    });

    it('generates listProcedures SQL using pg_proc', () => {
      const sql = dialect.listProceduresSQL('mydb');
      expect(sql).toContain('pg_proc');
      expect(sql).toContain("prokind = 'p'");
    });

    it('generates listFunctions SQL using pg_proc', () => {
      const sql = dialect.listFunctionsSQL('mydb');
      expect(sql).toContain('pg_proc');
      expect(sql).toContain("prokind = 'f'");
    });

    it('generates listColumns SQL using information_schema', () => {
      const sql = dialect.listColumnsSQL('mydb', 'public', 'users');
      expect(sql).toContain('information_schema.columns');
      expect(sql).toContain("'public'");
      expect(sql).toContain("'users'");
    });

    it('generates listIndexes SQL using pg_index', () => {
      const sql = dialect.listIndexesSQL('mydb', 'public', 'users');
      expect(sql).toContain('pg_index');
      expect(sql).toContain('string_agg');
    });

    it('generates listForeignKeys SQL using information_schema', () => {
      const sql = dialect.listForeignKeysSQL('mydb', 'public', 'users');
      expect(sql).toContain('information_schema.table_constraints');
      expect(sql).toContain('FOREIGN KEY');
    });

    it('generates listConstraints SQL', () => {
      const sql = dialect.listConstraintsSQL('mydb', 'public', 'users');
      expect(sql).toContain('information_schema.table_constraints');
    });

    it('generates listTriggers SQL using pg_trigger', () => {
      const sql = dialect.listTriggersSQL('mydb', 'public', 'users');
      expect(sql).toContain('pg_trigger');
    });

    it('generates getObjectDefinition SQL', () => {
      const sql = dialect.getObjectDefinitionSQL('mydb', 'public', 'my_view');
      expect(sql).toContain('pg_views');
      expect(sql).toContain('pg_get_functiondef');
    });

    it('generates listObjectComments SQL using pg_description', () => {
      const sql = dialect.listObjectCommentsSQL('mydb', 'public', 'users');
      expect(sql).toContain('obj_description');
      expect(sql).toContain('col_description');
      expect(sql).toContain("'public'");
      expect(sql).toContain("'users'");
    });
  });

  describe('feature flags', () => {
    it('supports object comments', () => expect(dialect.supportsObjectComments).toBe(true));
    it('does not support extended properties', () =>
      expect(dialect.supportsExtendedProperties).toBe(false));
  });

  describe('SQL injection prevention', () => {
    it('escapes single quotes in schema names', () => {
      const sql = dialect.listColumnsSQL('db', "sch'ema", 'table');
      expect(sql).toContain("sch''ema");
    });

    it('escapes single quotes in table names', () => {
      const sql = dialect.listColumnsSQL('db', 'schema', "tab'le");
      expect(sql).toContain("tab''le");
    });

    it('escapes double quotes in identifiers', () => {
      const quoted = dialect.quoteIdentifier('name"with"quotes');
      expect(quoted).toBe('"name""with""quotes"');
    });
  });
});

describe('MySQLDialect', () => {
  const dialect = new MySQLDialect();

  describe('properties', () => {
    it('has correct engine', () => expect(dialect.engine).toBe('mysql'));
    it('has correct label', () => expect(dialect.label).toBe('MySQL'));
    it('has correct default port', () => expect(dialect.defaultPort).toBe(3306));
    it('has correct Monaco language', () => expect(dialect.monacoLanguage).toBe('mysql'));
    it('has no batch separator', () => expect(dialect.batchSeparator).toBeNull());
    it('does not support batch separator', () =>
      expect(dialect.supportsBatchSeparator).toBe(false));
    it('does not support Windows auth', () => expect(dialect.supportsWindowsAuth).toBe(false));
    it('does not support backup/restore SQL', () =>
      expect(dialect.supportsBackupRestore).toBe(false));
    it('does not support extended properties', () =>
      expect(dialect.supportsExtendedProperties).toBe(false));
    it('does not support server file browsing', () =>
      expect(dialect.supportsServerFileBrowsing).toBe(false));
  });

  describe('quoteIdentifier', () => {
    it('wraps name in backticks', () => {
      expect(dialect.quoteIdentifier('users')).toBe('`users`');
    });

    it('escapes backticks', () => {
      expect(dialect.quoteIdentifier('table`name')).toBe('`table``name`');
    });

    it('handles empty string', () => {
      expect(dialect.quoteIdentifier('')).toBe('``');
    });
  });

  describe('quoteSchemaObject', () => {
    it('quotes schema and object separately', () => {
      expect(dialect.quoteSchemaObject('mydb', 'users')).toBe('`mydb`.`users`');
    });
  });

  describe('useDatabaseSQL', () => {
    it('generates USE statement with backticks', () => {
      expect(dialect.useDatabaseSQL('mydb')).toBe('USE `mydb`;');
    });

    it('escapes backticks in database name', () => {
      expect(dialect.useDatabaseSQL('my`db')).toBe('USE `my``db`;');
    });
  });

  describe('DDL', () => {
    it('generates CREATE DATABASE with utf8mb4', () => {
      const sql = dialect.createDatabaseSQL({ name: 'testdb' });
      expect(sql).toContain('CREATE DATABASE');
      expect(sql).toContain('`testdb`');
      expect(sql).toContain('utf8mb4');
    });

    it('generates CREATE DATABASE with collation', () => {
      const sql = dialect.createDatabaseSQL({ name: 'testdb', collation: 'utf8mb4_bin' });
      expect(sql).toContain('utf8mb4_bin');
    });

    it('generates DROP DATABASE', () => {
      const sql = dialect.dropDatabaseSQL({ name: 'testdb' });
      expect(sql).toContain('DROP DATABASE');
      expect(sql).toContain('`testdb`');
    });

    it('returns comment for RENAME DATABASE (not supported)', () => {
      const sql = dialect.renameDatabaseSQL({ currentName: 'olddb', newName: 'newdb' });
      expect(sql).toContain('does not support RENAME DATABASE');
    });
  });

  describe('metadata queries', () => {
    it('generates listDatabases SQL using information_schema.SCHEMATA', () => {
      const sql = dialect.listDatabasesSQL();
      expect(sql).toContain('information_schema.SCHEMATA');
      expect(sql).not.toContain('sys.databases');
      expect(sql).not.toContain('pg_database');
    });

    it('generates listSchemas SQL returning database as schema', () => {
      const sql = dialect.listSchemasSQL('mydb');
      expect(sql).toContain("'mydb'");
    });

    it('generates listTables SQL using information_schema.TABLES', () => {
      const sql = dialect.listTablesSQL('mydb');
      expect(sql).toContain('information_schema.TABLES');
      expect(sql).toContain('BASE TABLE');
    });

    it('generates listViews SQL using information_schema.VIEWS', () => {
      const sql = dialect.listViewsSQL('mydb');
      expect(sql).toContain('information_schema.VIEWS');
    });

    it('generates listProcedures SQL using information_schema.ROUTINES', () => {
      const sql = dialect.listProceduresSQL('mydb');
      expect(sql).toContain('information_schema.ROUTINES');
      expect(sql).toContain("'PROCEDURE'");
    });

    it('generates listFunctions SQL using information_schema.ROUTINES', () => {
      const sql = dialect.listFunctionsSQL('mydb');
      expect(sql).toContain('information_schema.ROUTINES');
      expect(sql).toContain("'FUNCTION'");
    });

    it('generates listColumns SQL using information_schema.COLUMNS', () => {
      const sql = dialect.listColumnsSQL('mydb', 'mydb', 'users');
      expect(sql).toContain('information_schema.COLUMNS');
      expect(sql).toContain("'mydb'");
      expect(sql).toContain("'users'");
    });

    it('generates listIndexes SQL using information_schema.STATISTICS', () => {
      const sql = dialect.listIndexesSQL('mydb', 'mydb', 'users');
      expect(sql).toContain('information_schema.STATISTICS');
      expect(sql).toContain('GROUP_CONCAT');
    });

    it('generates listForeignKeys SQL using KEY_COLUMN_USAGE', () => {
      const sql = dialect.listForeignKeysSQL('mydb', 'mydb', 'users');
      expect(sql).toContain('KEY_COLUMN_USAGE');
      expect(sql).toContain('REFERENCED_TABLE_NAME');
    });

    it('generates listConstraints SQL using TABLE_CONSTRAINTS', () => {
      const sql = dialect.listConstraintsSQL('mydb', 'mydb', 'users');
      expect(sql).toContain('TABLE_CONSTRAINTS');
    });

    it('generates listTriggers SQL using information_schema.TRIGGERS', () => {
      const sql = dialect.listTriggersSQL('mydb', 'mydb', 'users');
      expect(sql).toContain('information_schema.TRIGGERS');
    });

    it('generates getObjectDefinition SQL', () => {
      const sql = dialect.getObjectDefinitionSQL('mydb', 'mydb', 'my_view');
      expect(sql).toContain('VIEW_DEFINITION');
      expect(sql).toContain('ROUTINE_DEFINITION');
    });

    it('generates listObjectComments SQL using TABLE_COMMENT and COLUMN_COMMENT', () => {
      const sql = dialect.listObjectCommentsSQL('mydb', 'mydb', 'users');
      expect(sql).toContain('TABLE_COMMENT');
      expect(sql).toContain('COLUMN_COMMENT');
    });
  });

  describe('feature flags', () => {
    it('supports object comments', () => expect(dialect.supportsObjectComments).toBe(true));
    it('does not support extended properties', () =>
      expect(dialect.supportsExtendedProperties).toBe(false));
  });

  describe('SQL injection prevention', () => {
    it('escapes single quotes in schema names', () => {
      const sql = dialect.listColumnsSQL('db', "sch'ema", 'table');
      expect(sql).toContain("sch''ema");
    });

    it('escapes single quotes in table names', () => {
      const sql = dialect.listColumnsSQL('db', 'schema', "tab'le");
      expect(sql).toContain("tab''le");
    });

    it('escapes backticks in identifiers', () => {
      const quoted = dialect.quoteIdentifier('name`with`ticks');
      expect(quoted).toBe('`name``with``ticks`');
    });
  });
});

describe('dialect cross-engine consistency', () => {
  const mssql = new MSSQLDialect();
  const pg = new PgDialect();
  const mysql = new MySQLDialect();

  it('all generate non-empty listDatabases SQL', () => {
    expect(mssql.listDatabasesSQL().trim().length).toBeGreaterThan(0);
    expect(pg.listDatabasesSQL().trim().length).toBeGreaterThan(0);
    expect(mysql.listDatabasesSQL().trim().length).toBeGreaterThan(0);
  });

  it('all generate non-empty listSchemas SQL', () => {
    expect(mssql.listSchemasSQL('db').trim().length).toBeGreaterThan(0);
    expect(pg.listSchemasSQL('db').trim().length).toBeGreaterThan(0);
    expect(mysql.listSchemasSQL('db').trim().length).toBeGreaterThan(0);
  });

  it('all generate non-empty listTables SQL', () => {
    expect(mssql.listTablesSQL('db').trim().length).toBeGreaterThan(0);
    expect(pg.listTablesSQL('db').trim().length).toBeGreaterThan(0);
    expect(mysql.listTablesSQL('db').trim().length).toBeGreaterThan(0);
  });

  it('all generate non-empty listColumns SQL', () => {
    expect(mssql.listColumnsSQL('db', 's', 't').trim().length).toBeGreaterThan(0);
    expect(pg.listColumnsSQL('db', 's', 't').trim().length).toBeGreaterThan(0);
    expect(mysql.listColumnsSQL('db', 's', 't').trim().length).toBeGreaterThan(0);
  });

  it('escapeString works the same across all dialects', () => {
    const input = "it's a test";
    expect(mssql.escapeString(input)).toBe(pg.escapeString(input));
    expect(pg.escapeString(input)).toBe(mysql.escapeString(input));
  });
});

describe('getDialect factory — variants', () => {
  it('returns PgDsqlDialect for postgresql + dsql variant', () => {
    const dialect = getDialect('postgresql', 'dsql');
    expect(dialect).toBeInstanceOf(PgDsqlDialect);
    expect(dialect.engine).toBe('postgresql');
    expect(dialect.variant).toBe('dsql');
  });

  it('returns standard PgDialect when variant is omitted', () => {
    const dialect = getDialect('postgresql');
    expect(dialect).toBeInstanceOf(PgDialect);
    expect(dialect.variant).toBeUndefined();
  });

  it('ignores dsql variant for non-postgresql engines', () => {
    expect(getDialect('mssql', 'dsql')).toBeInstanceOf(MSSQLDialect);
    expect(getDialect('mysql', 'dsql')).toBeInstanceOf(MySQLDialect);
  });
});

describe('capability defaults on existing dialects', () => {
  it.each([
    ['mssql', new MSSQLDialect()],
    ['postgresql', new PgDialect()],
    ['mysql', new MySQLDialect()],
  ])('%s supports everything by default', (_label, dialect) => {
    expect(dialect.supportsMultipleDatabases).toBe(true);
    expect(dialect.supportsDatabaseManagement).toBe(true);
    expect(dialect.supportsStoredProcedures).toBe(true);
    expect(dialect.supportsTriggers).toBe(true);
    expect(dialect.supportsBackupTooling).toBe(true);
    expect(dialect.variant).toBeUndefined();
  });
});

describe('PgDsqlDialect', () => {
  const dialect = new PgDsqlDialect();

  it('has DSQL label and postgresql engine', () => {
    expect(dialect.label).toBe('Aurora DSQL');
    expect(dialect.engine).toBe('postgresql');
    expect(dialect.variant).toBe('dsql');
  });

  it('disables unsupported capabilities', () => {
    expect(dialect.supportsMultipleDatabases).toBe(false);
    expect(dialect.supportsDatabaseManagement).toBe(false);
    expect(dialect.supportsStoredProcedures).toBe(false);
    expect(dialect.supportsTriggers).toBe(false);
    expect(dialect.supportsBackupTooling).toBe(false);
  });

  it('listDatabasesSQL avoids pg_database and returns the current database', () => {
    const sql = dialect.listDatabasesSQL();
    expect(sql).not.toContain('pg_database');
    expect(sql).toContain('current_database()');
    expect(sql).toContain('"isSystemDb"');
  });

  it('listTablesSQL avoids pg_stat_user_tables and pg_relation_size', () => {
    const sql = dialect.listTablesSQL('postgres', 'public');
    expect(sql).not.toContain('pg_stat_user_tables');
    expect(sql).not.toContain('pg_relation_size');
    expect(sql).toContain('reltuples');
    expect(sql).toContain("t.schemaname = 'public'");
  });

  it('listProceduresSQL / listFunctionsSQL / listTriggersSQL return empty-set queries', () => {
    for (const sql of [
      dialect.listProceduresSQL('postgres'),
      dialect.listFunctionsSQL('postgres'),
      dialect.listTriggersSQL('postgres', 'public', 't'),
    ]) {
      expect(sql).toContain('WHERE false');
      expect(sql).not.toContain('pg_proc');
      expect(sql).not.toContain('pg_trigger');
    }
  });

  it('getObjectDefinitionSQL only consults pg_views', () => {
    const sql = dialect.getObjectDefinitionSQL('postgres', 'public', 'v');
    expect(sql).toContain('pg_views');
    expect(sql).not.toContain('pg_proc');
  });

  it('database DDL generators throw with a clear message', () => {
    expect(() => dialect.createDatabaseSQL({ name: 'x' })).toThrow(/single database/i);
    expect(() => dialect.renameDatabaseSQL({ currentName: 'a', newName: 'b' })).toThrow(
      /single database/i
    );
    expect(() => dialect.dropDatabaseSQL({ name: 'x' })).toThrow(/single database/i);
  });

  it('inherits working PG SQL for schemas, views, indexes and comments', () => {
    expect(dialect.listSchemasSQL('postgres')).toContain('pg_namespace');
    expect(dialect.listViewsSQL('postgres')).toContain('pg_views');
    expect(dialect.listIndexesSQL('postgres', 'public', 't')).toContain('pg_index');
  });
});

describe('capabilitiesForDialect', () => {
  it('maps a fully-capable dialect to FULL capabilities', () => {
    const caps = capabilitiesForDialect(new MSSQLDialect());
    expect(caps).toEqual({
      supportsMultipleDatabases: true,
      supportsDatabaseManagement: true,
      supportsStoredProcedures: true,
      supportsTriggers: true,
      supportsBackupRestore: true,
    });
  });

  it('maps PgDsqlDialect to all-false capabilities', () => {
    const caps = capabilitiesForDialect(new PgDsqlDialect());
    expect(Object.values(caps).every(v => v === false)).toBe(true);
  });
});

describe('formatLiteral and selectOneByColumnSQL (J-52)', () => {
  /**
   * The FK-lookup handler built `SELECT TOP 1 * FROM [s].[t] WHERE [c] = N'v'` for EVERY engine.
   * Bracket delimiters, `TOP` and the `N''` prefix are all T-SQL, so the purpose-built bridge
   * member was a syntax error on two of three engines.
   *
   * The values here come from result-set cells, not from Joinery's own strings, which is why the
   * escaping gets its own tests rather than riding on `escapeString`.
   */

  it('caps the row the way each engine spells it', () => {
    expect(
      getDialect('mssql').selectOneByColumnSQL({
        schema: 'dbo',
        table: 'Users',
        column: 'id',
        value: 7,
      })
    ).toBe('SELECT TOP 1 * FROM [dbo].[Users] WHERE [id] = 7');

    expect(
      getDialect('postgresql').selectOneByColumnSQL({
        schema: 'public',
        table: 'users',
        column: 'id',
        value: 7,
      })
    ).toBe('SELECT * FROM "public"."users" WHERE "id" = 7 LIMIT 1');

    expect(
      getDialect('mysql').selectOneByColumnSQL({
        schema: 'shop',
        table: 'users',
        column: 'id',
        value: 7,
      })
    ).toContain('LIMIT 1');
  });

  it('quotes identifiers with the engine’s own delimiters', () => {
    expect(
      getDialect('mysql').selectOneByColumnSQL({
        schema: 'shop',
        table: 'users',
        column: 'id',
        value: 1,
      })
    ).toContain('`id`');
  });

  it('writes booleans as each engine reads them', () => {
    expect(getDialect('postgresql').formatLiteral(true)).toBe('TRUE');
    expect(getDialect('mssql').formatLiteral(true)).toBe('1');
    expect(getDialect('mysql').formatLiteral(false)).toBe('0');
  });

  it.each([
    ['mssql' as const, "N'O''Brien'"],
    ['postgresql' as const, "E'O''Brien'"],
    ['mysql' as const, "'O''Brien'"],
  ])('doubles a quote for %s', (engine, expected) => {
    expect(getDialect(engine).formatLiteral("O'Brien")).toBe(expected);
  });

  it('doubles backslashes for PostgreSQL, and does not for SQL Server', () => {
    // PostgreSQL: with `standard_conforming_strings` off a backslash starts an escape, so a value
    // ending in one would consume the closing quote and let the next `'` open a NEW literal —
    // putting a statement terminator outside it, on a driver that multiplexes statements.
    expect(getDialect('postgresql').formatLiteral('C:\\path')).toBe("E'C:\\\\path'");

    // T-SQL has no backslash escape in any configuration, so doubling would corrupt the data and
    // the lookup would miss the row.
    expect(getDialect('mssql').formatLiteral('C:\\path')).toBe("N'C:\\path'");
  });

  it('keeps an injection attempt inside the literal', () => {
    const payload = "x'; DROP TABLE users; --";
    for (const engine of ['mssql', 'postgresql', 'mysql'] as const) {
      const sql = getDialect(engine).selectOneByColumnSQL({
        schema: 's',
        table: 't',
        column: 'c',
        value: payload,
      });
      // The semicolons stay — they are DATA now, inside the literal, which is the point. What
      // matters is that the quote that would have closed it is doubled, and that every quote in
      // the statement is therefore paired: an odd count is what an escaped literal looks like.
      expect(sql).toContain("x''; DROP TABLE users; --");
      expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
    }
  });

  it.each(['mssql' as const, 'postgresql' as const, 'mysql' as const])(
    'writes NULL for absent values and non-finite numbers on %s',
    engine => {
      const dialect = getDialect(engine);
      expect(dialect.formatLiteral(null)).toBe('NULL');
      expect(dialect.formatLiteral(undefined)).toBe('NULL');
      expect(dialect.formatLiteral(Number.POSITIVE_INFINITY)).toBe('NULL');
      expect(dialect.formatLiteral(Number.NaN)).toBe('NULL');
    }
  );

  it('serialises a Date as ISO and an object as JSON', () => {
    expect(getDialect('mysql').formatLiteral(new Date('2026-08-25T00:00:00.000Z'))).toBe(
      "'2026-08-25T00:00:00.000Z'"
    );
    expect(getDialect('mysql').formatLiteral({ a: 1 })).toBe('\'{"a":1}\'');
  });
});
