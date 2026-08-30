/**
 * Tests for SQL Dialect implementations
 */

import { describe, it, expect } from 'vitest';
import { MSSQLDialect } from './mssql-dialect';
import { PgDialect } from './pg-dialect';
import { MySQLDialect } from './mysql-dialect';
import { getDialect, capabilitiesForDialect } from './index';
import type { ParameterisedQuery, SQLDialect } from './sql-dialect';
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

  describe('quoteLiteral', () => {
    it('doubles single quotes and adds the delimiters', () => {
      expect(dialect.quoteLiteral("O'Brien")).toBe("'O''Brien'");
    });

    it('handles strings without quotes', () => {
      expect(dialect.quoteLiteral('hello')).toBe("'hello'");
    });

    it('leaves a backslash alone — T-SQL has no backslash escape', () => {
      expect(dialect.quoteLiteral('C:\\path')).toBe("'C:\\path'");
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
      const { sql } = dialect.listDatabasesQuery(false);
      expect(sql).toContain('sys.databases');
      expect(sql).toContain('msdb.dbo.backupset');
    });

    it('generates listDatabases SQL for Azure SQL (no msdb references)', () => {
      const { sql } = dialect.listDatabasesQuery(true);
      expect(sql).toContain('sys.databases');
      expect(sql).not.toContain('msdb.dbo.backupset');
    });

    it('generates listSchemas SQL', () => {
      const { sql } = dialect.listSchemasQuery('mydb');
      expect(sql).toContain('sys.schemas');
      expect(sql).toContain('USE [mydb]');
    });

    it('generates listTables SQL', () => {
      const { sql } = dialect.listTablesQuery('mydb');
      expect(sql).toContain('sys.tables');
      expect(sql).toContain('USE [mydb]');
    });

    it('generates listViews SQL', () => {
      const { sql } = dialect.listViewsQuery('mydb');
      expect(sql).toContain('sys.views');
    });

    it('generates listProcedures SQL', () => {
      const { sql } = dialect.listProceduresQuery('mydb');
      expect(sql).toContain('sys.procedures');
    });

    it('generates listFunctions SQL', () => {
      const { sql } = dialect.listFunctionsQuery('mydb');
      expect(sql).toContain('sys.objects');
    });

    it('generates listColumns SQL', () => {
      const { sql } = dialect.listColumnsQuery('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.columns');
      expect(sql).toContain("'dbo'");
      expect(sql).toContain("'Users'");
    });

    it('generates listIndexes SQL', () => {
      const { sql } = dialect.listIndexesQuery('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.indexes');
    });

    it('generates listForeignKeys SQL', () => {
      const { sql } = dialect.listForeignKeysQuery('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.foreign_keys');
    });

    it('generates listConstraints SQL', () => {
      const { sql } = dialect.listConstraintsQuery('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.key_constraints');
    });

    it('generates listTriggers SQL', () => {
      const { sql } = dialect.listTriggersQuery('mydb', 'dbo', 'Users');
      expect(sql).toContain('sys.triggers');
    });

    it('generates getObjectDefinition SQL', () => {
      const { sql } = dialect.getObjectDefinitionQuery('mydb', 'dbo', 'myView');
      expect(sql).toContain('OBJECT_DEFINITION');
    });

    it('generates listObjectComments SQL (extended properties)', () => {
      const { sql } = dialect.listObjectCommentsQuery('mydb', 'dbo', 'Users');
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
      // `E'…'` is a string constant wherever a plain one is accepted; verified against the
      // harness PostgreSQL 16 server, which takes this CREATE DATABASE verbatim (J-134).
      expect(sql).toContain("LC_COLLATE = E'en_US.UTF-8'");
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
      const { sql } = dialect.listDatabasesQuery();
      expect(sql).toContain('pg_database');
      expect(sql).not.toContain('sys.databases');
    });

    it('generates listSchemas SQL using pg_namespace', () => {
      const { sql } = dialect.listSchemasQuery('mydb');
      expect(sql).toContain('pg_namespace');
      expect(sql).not.toContain('sys.schemas');
    });

    it('generates listTables SQL using pg_tables', () => {
      const { sql } = dialect.listTablesQuery('mydb');
      expect(sql).toContain('pg_tables');
      expect(sql).not.toContain('sys.tables');
    });

    it('generates listViews SQL using pg_views', () => {
      const { sql } = dialect.listViewsQuery('mydb');
      expect(sql).toContain('pg_views');
    });

    it('generates listProcedures SQL using pg_proc', () => {
      const { sql } = dialect.listProceduresQuery('mydb');
      expect(sql).toContain('pg_proc');
      expect(sql).toContain("prokind = 'p'");
    });

    it('generates listFunctions SQL using pg_proc', () => {
      const { sql } = dialect.listFunctionsQuery('mydb');
      expect(sql).toContain('pg_proc');
      expect(sql).toContain("prokind = 'f'");
    });

    it('generates listColumns SQL using information_schema, with bound names', () => {
      const { sql, params } = dialect.listColumnsQuery('mydb', 'public', 'users');
      expect(sql).toContain('information_schema.columns');
      // Three predicates each for schema and table, so six placeholders in call order.
      expect(params).toEqual(['public', 'users', 'public', 'users', 'public', 'users']);
      expect(sql).toContain('c.table_schema = $5');
      expect(sql).toContain('c.table_name = $6');
    });

    it('generates listIndexes SQL using pg_index', () => {
      const { sql } = dialect.listIndexesQuery('mydb', 'public', 'users');
      expect(sql).toContain('pg_index');
      expect(sql).toContain('string_agg');
    });

    it('generates listForeignKeys SQL using information_schema', () => {
      const { sql } = dialect.listForeignKeysQuery('mydb', 'public', 'users');
      expect(sql).toContain('information_schema.table_constraints');
      expect(sql).toContain('FOREIGN KEY');
    });

    it('generates listConstraints SQL', () => {
      const { sql } = dialect.listConstraintsQuery('mydb', 'public', 'users');
      expect(sql).toContain('information_schema.table_constraints');
    });

    it('generates listTriggers SQL using pg_trigger', () => {
      const { sql } = dialect.listTriggersQuery('mydb', 'public', 'users');
      expect(sql).toContain('pg_trigger');
    });

    it('does not cast tgenabled to boolean — PostgreSQL refuses it', () => {
      // `NOT t.tgenabled::boolean` raised `cannot cast type "char" to boolean` on every call, so
      // the PostgreSQL trigger list never returned. Found by the J-135 integration tier and
      // confirmed against the harness PostgreSQL 16.15.
      const { sql } = dialect.listTriggersQuery('mydb', 'public', 'users');
      expect(sql).not.toContain('tgenabled::boolean');
      expect(sql).toContain("(t.tgenabled = 'D')");
    });

    it('generates getObjectDefinition SQL', () => {
      const { sql } = dialect.getObjectDefinitionQuery('mydb', 'public', 'my_view');
      expect(sql).toContain('pg_views');
      expect(sql).toContain('pg_get_functiondef');
    });

    it('generates listObjectComments SQL using pg_description, with bound names', () => {
      const { sql, params } = dialect.listObjectCommentsQuery('mydb', 'public', 'users');
      expect(sql).toContain('obj_description');
      expect(sql).toContain('col_description');
      expect(sql).not.toContain("'public'");
      expect(sql).not.toContain("'users'");
      // Both UNION arms name the schema and table twice: once in the select list, once in
      // the predicate. The select-list ones are cast, because PostgreSQL cannot infer the type
      // of a bare parameter in a target list.
      expect(sql).toContain('$1::text AS "level0Name"');
      expect(params).toEqual([
        'public',
        'users',
        'public',
        'users',
        'public',
        'users',
        'public',
        'users',
      ]);
    });
  });

  describe('feature flags', () => {
    it('supports object comments', () => expect(dialect.supportsObjectComments).toBe(true));
    it('does not support extended properties', () =>
      expect(dialect.supportsExtendedProperties).toBe(false));
  });

  describe('SQL injection prevention', () => {
    // These two used to assert that a quote in a name was DOUBLED INTO the SQL text. Since J-135
    // the name never reaches the SQL text at all — it is bound — so escaping it would be a
    // regression, not the fix. The assertion is inverted accordingly.
    it('binds a schema name containing a quote instead of escaping it into the SQL', () => {
      const { sql, params } = dialect.listColumnsQuery('db', "sch'ema", 'table');
      expect(sql).not.toContain("sch''ema");
      expect(sql).not.toContain("sch'ema");
      expect(params).toContain("sch'ema");
    });

    it('binds a table name containing a quote instead of escaping it into the SQL', () => {
      const { sql, params } = dialect.listColumnsQuery('db', 'schema', "tab'le");
      expect(sql).not.toContain("tab''le");
      expect(sql).not.toContain("tab'le");
      expect(params).toContain("tab'le");
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
      const { sql } = dialect.listDatabasesQuery();
      expect(sql).toContain('information_schema.SCHEMATA');
      expect(sql).not.toContain('sys.databases');
      expect(sql).not.toContain('pg_database');
    });

    it('generates listSchemas SQL returning the database as a bound schema name', () => {
      const { sql, params } = dialect.listSchemasQuery('mydb');
      expect(sql).not.toContain("'mydb'");
      expect(sql).toContain('? AS name');
      expect(params).toEqual(['mydb']);
    });

    it('generates listTables SQL using information_schema.TABLES', () => {
      const { sql } = dialect.listTablesQuery('mydb');
      expect(sql).toContain('information_schema.TABLES');
      expect(sql).toContain('BASE TABLE');
    });

    it('generates listViews SQL using information_schema.VIEWS', () => {
      const { sql } = dialect.listViewsQuery('mydb');
      expect(sql).toContain('information_schema.VIEWS');
    });

    it('generates listProcedures SQL using information_schema.ROUTINES', () => {
      const { sql } = dialect.listProceduresQuery('mydb');
      expect(sql).toContain('information_schema.ROUTINES');
      expect(sql).toContain("'PROCEDURE'");
    });

    it('generates listFunctions SQL using information_schema.ROUTINES', () => {
      const { sql } = dialect.listFunctionsQuery('mydb');
      expect(sql).toContain('information_schema.ROUTINES');
      expect(sql).toContain("'FUNCTION'");
    });

    it('generates listColumns SQL using information_schema.COLUMNS, with bound names', () => {
      const { sql, params } = dialect.listColumnsQuery('mydb', 'mydb', 'users');
      expect(sql).toContain('information_schema.COLUMNS');
      expect(sql).toContain('TABLE_SCHEMA = ?');
      expect(sql).toContain('TABLE_NAME = ?');
      expect(params).toEqual(['mydb', 'users']);
    });

    it('generates listIndexes SQL using information_schema.STATISTICS', () => {
      const { sql } = dialect.listIndexesQuery('mydb', 'mydb', 'users');
      expect(sql).toContain('information_schema.STATISTICS');
      expect(sql).toContain('GROUP_CONCAT');
    });

    it('generates listForeignKeys SQL using KEY_COLUMN_USAGE', () => {
      const { sql } = dialect.listForeignKeysQuery('mydb', 'mydb', 'users');
      expect(sql).toContain('KEY_COLUMN_USAGE');
      expect(sql).toContain('REFERENCED_TABLE_NAME');
    });

    it('generates listConstraints SQL using TABLE_CONSTRAINTS', () => {
      const { sql } = dialect.listConstraintsQuery('mydb', 'mydb', 'users');
      expect(sql).toContain('TABLE_CONSTRAINTS');
    });

    it('generates listTriggers SQL using information_schema.TRIGGERS', () => {
      const { sql } = dialect.listTriggersQuery('mydb', 'mydb', 'users');
      expect(sql).toContain('information_schema.TRIGGERS');
    });

    it('generates getObjectDefinition SQL', () => {
      const { sql } = dialect.getObjectDefinitionQuery('mydb', 'mydb', 'my_view');
      expect(sql).toContain('VIEW_DEFINITION');
      expect(sql).toContain('ROUTINE_DEFINITION');
    });

    it('generates listObjectComments SQL using TABLE_COMMENT and COLUMN_COMMENT', () => {
      const { sql } = dialect.listObjectCommentsQuery('mydb', 'mydb', 'users');
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
    // Inverted for J-135, for the same reason as the PostgreSQL pair above: the name is bound,
    // so it must be absent from the SQL text rather than escaped inside it.
    it('binds a schema name containing a quote instead of escaping it into the SQL', () => {
      const { sql, params } = dialect.listColumnsQuery('db', "sch'ema", 'table');
      expect(sql).not.toContain("sch''ema");
      expect(sql).not.toContain("sch'ema");
      expect(params).toContain("sch'ema");
    });

    it('binds a table name containing a quote instead of escaping it into the SQL', () => {
      const { sql, params } = dialect.listColumnsQuery('db', 'schema', "tab'le");
      expect(sql).not.toContain("tab''le");
      expect(sql).not.toContain("tab'le");
      expect(params).toContain("tab'le");
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
    expect(mssql.listDatabasesQuery().sql.trim().length).toBeGreaterThan(0);
    expect(pg.listDatabasesQuery().sql.trim().length).toBeGreaterThan(0);
    expect(mysql.listDatabasesQuery().sql.trim().length).toBeGreaterThan(0);
  });

  it('all generate non-empty listSchemas SQL', () => {
    expect(mssql.listSchemasQuery('db').sql.trim().length).toBeGreaterThan(0);
    expect(pg.listSchemasQuery('db').sql.trim().length).toBeGreaterThan(0);
    expect(mysql.listSchemasQuery('db').sql.trim().length).toBeGreaterThan(0);
  });

  it('all generate non-empty listTables SQL', () => {
    expect(mssql.listTablesQuery('db').sql.trim().length).toBeGreaterThan(0);
    expect(pg.listTablesQuery('db').sql.trim().length).toBeGreaterThan(0);
    expect(mysql.listTablesQuery('db').sql.trim().length).toBeGreaterThan(0);
  });

  it('all generate non-empty listColumns SQL', () => {
    expect(mssql.listColumnsQuery('db', 's', 't').sql.trim().length).toBeGreaterThan(0);
    expect(pg.listColumnsQuery('db', 's', 't').sql.trim().length).toBeGreaterThan(0);
    expect(mysql.listColumnsQuery('db', 's', 't').sql.trim().length).toBeGreaterThan(0);
  });

  it('quoteLiteral does NOT work the same across all dialects (J-134)', () => {
    // This assertion used to require the three engines to escape identically. They must not: MySQL
    // reads a backslash as an escape character in its default `sql_mode`, and so does PostgreSQL
    // whenever `standard_conforming_strings` is off, so quote-doubling alone leaves both open to an
    // injected statement. Only T-SQL, which has no backslash escape in any configuration, is
    // correct with plain doubling.
    const input = "it's a test";
    expect(mssql.quoteLiteral(input)).toBe("'it''s a test'");
    expect(pg.quoteLiteral(input)).toBe("E'it''s a test'");
    expect(mysql.quoteLiteral(input)).toBe("'it''s a test'");
  });

  it('no dialect exposes the old escapeString footgun (J-134)', () => {
    // `escapeString` returned a *bare* escaped body and left the caller to write the quotes, so a
    // dialect could not add the `E` prefix PostgreSQL needs, and every call site read as though
    // quote-doubling were the whole job. `quoteLiteral` returns the complete literal instead.
    for (const dialect of [mssql, pg, mysql]) {
      expect('escapeString' in dialect).toBe(false);
    }
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

  it('listDatabasesQuery avoids pg_database and returns the current database', () => {
    const { sql } = dialect.listDatabasesQuery();
    expect(sql).not.toContain('pg_database');
    expect(sql).toContain('current_database()');
    expect(sql).toContain('"isSystemDb"');
  });

  it('listTablesQuery avoids pg_stat_user_tables and pg_relation_size', () => {
    const { sql, params } = dialect.listTablesQuery('postgres', 'public');
    expect(sql).not.toContain('pg_stat_user_tables');
    expect(sql).not.toContain('pg_relation_size');
    expect(sql).toContain('reltuples');
    // The schema filter is a bound parameter, not a literal (J-135).
    expect(sql).toContain('t.schemaname = $1');
    expect(params).toEqual(['public']);
  });

  it('listProcedures/listFunctions/listTriggers queries return empty sets', () => {
    for (const { sql } of [
      dialect.listProceduresQuery('postgres'),
      dialect.listFunctionsQuery('postgres'),
      dialect.listTriggersQuery('postgres', 'public', 't'),
    ]) {
      expect(sql).toContain('WHERE false');
      expect(sql).not.toContain('pg_proc');
      expect(sql).not.toContain('pg_trigger');
    }
  });

  it('getObjectDefinitionQuery only consults pg_views', () => {
    const { sql } = dialect.getObjectDefinitionQuery('postgres', 'public', 'v');
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
    expect(dialect.listSchemasQuery('postgres').sql).toContain('pg_namespace');
    expect(dialect.listViewsQuery('postgres').sql).toContain('pg_views');
    expect(dialect.listIndexesQuery('postgres', 'public', 't').sql).toContain('pg_index');
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
   * The values here come from result-set cells, not from Joinery's own strings. J-134 moved the
   * escaping itself down to `quoteLiteral`, which every metadata query goes through too; what is
   * left in this block is the type handling `formatLiteral` adds on top of it.
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

  it('keeps a backslash-led injection attempt inside the literal (J-134)', () => {
    // The payload the cycle-4 audit demonstrated against a real MySQL 8.4 server: the leading
    // backslash escapes the quote the escaper doubles, so the NEXT quote closes the literal and
    // `DROP TABLE users` runs as a second statement on any pool that negotiated
    // CLIENT_MULTI_STATEMENTS — which, since J-137, is the query editor's pool only. The
    // earlier version of this test used a payload with no backslash plus a quote-parity heuristic
    // that the exploit string also satisfied, so it asserted the defect was fine.
    const payload = String.raw`\'; DROP TABLE users; --`;
    const ref = { schema: 's', table: 't', column: 'c', value: payload };

    // T-SQL has no backslash escape in any configuration: the backslash stays single, and the
    // doubled quote is the whole defence.
    expect(getDialect('mssql').selectOneByColumnSQL(ref)).toBe(
      String.raw`SELECT TOP 1 * FROM [s].[t] WHERE [c] = N'\''; DROP TABLE users; --'`
    );

    // PostgreSQL: `E'…'` is escape-string syntax whatever `standard_conforming_strings` is set to,
    // so doubling the backslash there closes the escape the payload opened.
    expect(getDialect('postgresql').selectOneByColumnSQL(ref)).toBe(
      String.raw`SELECT * FROM "s"."t" WHERE "c" = E'\\''; DROP TABLE users; --' LIMIT 1`
    );

    // MySQL: backslash is an escape character in the default `sql_mode`, so it must be doubled too.
    expect(getDialect('mysql').selectOneByColumnSQL(ref)).toBe(
      'SELECT * FROM `s`.`t` WHERE `c` = ' + String.raw`'\\''; DROP TABLE users; --'` + ' LIMIT 1'
    );
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

describe('quoteLiteral — engine-correct string literals (J-134)', () => {
  it.each([
    ['mssql' as const, "'plain'"],
    ['postgresql' as const, "E'plain'"],
    ['mysql' as const, "'plain'"],
  ])('wraps an ordinary value for %s', (engine, expected) => {
    expect(getDialect(engine).quoteLiteral('plain')).toBe(expected);
  });

  it.each([
    ['mssql' as const, "'O''Brien'"],
    ['postgresql' as const, "E'O''Brien'"],
    ['mysql' as const, "'O''Brien'"],
  ])('doubles the quote for %s', (engine, expected) => {
    expect(getDialect(engine).quoteLiteral("O'Brien")).toBe(expected);
  });

  it('doubles a backslash on the two engines that read it as an escape', () => {
    // Verified against the harness servers: MySQL 8.4's default `sql_mode` does NOT include
    // `NO_BACKSLASH_ESCAPES`, and PostgreSQL's `standard_conforming_strings` is settable per
    // database and per role (J-52), so neither can be trusted to read a lone backslash as data.
    expect(getDialect('mysql').quoteLiteral('C:\\path')).toBe("'C:\\\\path'");
    expect(getDialect('postgresql').quoteLiteral('C:\\path')).toBe("E'C:\\\\path'");

    // T-SQL has no backslash escape, so doubling would corrupt the value and the predicate
    // would miss the row.
    expect(getDialect('mssql').quoteLiteral('C:\\path')).toBe("'C:\\path'");
  });

  it('binds the metadata predicates rather than escaping into them (J-135)', () => {
    // J-134 asserted here that the schema name was ESCAPED INTO the predicate. J-135 removes the
    // escaping question from this surface entirely: the name is bound, so the predicate carries a
    // placeholder and the name travels beside the SQL. Escaping it back in would be the
    // regression this now catches.
    const hostile = 'x\\'; // a schema name ending in a backslash

    const mysql = getDialect('mysql').listTablesQuery('db', hostile);
    expect(mysql.sql).toContain('TABLE_SCHEMA = ?');
    expect(mysql.sql).not.toContain(hostile);
    expect(mysql.params).toEqual([hostile]);

    const pg = getDialect('postgresql').listTablesQuery('db', hostile);
    expect(pg.sql).toContain('t.schemaname = $1');
    expect(pg.sql).not.toContain(hostile);
    expect(pg.params).toEqual([hostile]);

    const dsql = getDialect('postgresql', 'dsql').listTablesQuery('db', hostile);
    expect(dsql.sql).toContain('t.schemaname = $1');
    expect(dsql.sql).not.toContain(hostile);
    expect(dsql.params).toEqual([hostile]);
  });

  it('binds both halves of a schema-qualified metadata lookup (J-135)', () => {
    const { sql, params } = getDialect('mysql').listColumnsQuery('db', 's\\', 't\\');
    expect(sql).toContain('TABLE_SCHEMA = ?');
    expect(sql).toContain('TABLE_NAME = ?');
    expect(params).toEqual(['s\\', 't\\']);
  });

  it('formatLiteral and quoteLiteral agree on every engine', () => {
    // One escaping implementation per engine, not two: `formatLiteral` adds the type handling
    // (NULL, numbers, booleans) on top of `quoteLiteral` and nothing else.
    const value = String.raw`mixed '\ value`;
    expect(getDialect('mssql').formatLiteral(value)).toBe(
      `N${getDialect('mssql').quoteLiteral(value)}`
    );
    expect(getDialect('postgresql').formatLiteral(value)).toBe(
      getDialect('postgresql').quoteLiteral(value)
    );
    expect(getDialect('mysql').formatLiteral(value)).toBe(getDialect('mysql').quoteLiteral(value));
  });
});

describe('metadata queries bind their arguments (J-135)', () => {
  /**
   * The schema, table and object names below reach the dialect from the explorer, from IPC
   * arguments, and — through `ToolRegistry` — from an LLM tool call. J-134 made the escaping of
   * those names engine-correct; J-135 takes them out of the SQL text altogether.
   *
   * These sweeps are deliberately mechanical: they run every metadata builder on every engine
   * that binds, so a new builder written with `quoteLiteral` in a predicate fails here rather
   * than waiting for someone to notice it.
   */

  /** A name carrying every character that has ever been an escape problem on this surface. */
  const HOSTILE = "p'; DROP TABLE victim; -- \\";

  interface BuilderCase {
    readonly name: string;
    readonly run: (dialect: SQLDialect) => ParameterisedQuery | null;
  }

  const CASES: BuilderCase[] = [
    { name: 'listSchemasQuery', run: d => d.listSchemasQuery(HOSTILE) },
    { name: 'listTablesQuery', run: d => d.listTablesQuery(HOSTILE, HOSTILE) },
    { name: 'listViewsQuery', run: d => d.listViewsQuery(HOSTILE, HOSTILE) },
    { name: 'listProceduresQuery', run: d => d.listProceduresQuery(HOSTILE, HOSTILE) },
    { name: 'listFunctionsQuery', run: d => d.listFunctionsQuery(HOSTILE, HOSTILE) },
    { name: 'listColumnsQuery', run: d => d.listColumnsQuery(HOSTILE, HOSTILE, HOSTILE) },
    { name: 'listIndexesQuery', run: d => d.listIndexesQuery(HOSTILE, HOSTILE, HOSTILE) },
    { name: 'listForeignKeysQuery', run: d => d.listForeignKeysQuery(HOSTILE, HOSTILE, HOSTILE) },
    { name: 'listConstraintsQuery', run: d => d.listConstraintsQuery(HOSTILE, HOSTILE, HOSTILE) },
    { name: 'listTriggersQuery', run: d => d.listTriggersQuery(HOSTILE, HOSTILE, HOSTILE) },
    {
      name: 'getObjectDefinitionQuery',
      run: d => d.getObjectDefinitionQuery(HOSTILE, HOSTILE, HOSTILE),
    },
    {
      name: 'listObjectCommentsQuery',
      run: d => d.listObjectCommentsQuery(HOSTILE, HOSTILE, HOSTILE),
    },
    { name: 'rowCountQuery', run: d => d.rowCountQuery(HOSTILE, HOSTILE) },
  ];

  const BINDING_DIALECTS: ReadonlyArray<readonly [string, SQLDialect]> = [
    ['postgresql', getDialect('postgresql')],
    ['postgresql/dsql', getDialect('postgresql', 'dsql')],
    ['mysql', getDialect('mysql')],
  ];

  describe.each(BINDING_DIALECTS)('%s', (label, dialect) => {
    it.each(CASES.map(c => [c.name, c] as const))(
      '%s keeps the hostile name out of the SQL text',
      (_name, builder) => {
        const query = builder.run(dialect);
        if (query === null) return; // only listObjectCommentsQuery may decline; none do here

        expect(query.sql).not.toContain(HOSTILE);
        // Nor any escaped rendering of it — the point is that no form of the value is present.
        expect(query.sql).not.toContain('DROP TABLE victim');
        // Every value this builder bound is one we passed in; nothing else got bound.
        for (const value of query.params) expect(value).toBe(HOSTILE);
      }
    );

    it.each(CASES.map(c => [c.name, c] as const))(
      '%s emits exactly as many placeholders as it binds',
      (_name, builder) => {
        const query = builder.run(dialect);
        if (query === null) return;
        expect(countPlaceholders(label, query.sql)).toBe(query.params.length);
      }
    );
  });

  it('SQL Server carries no metadata parameters — TsqlBuilder still writes its own literals', () => {
    // MSSQL is deliberately untouched by J-135. T-SQL has no backslash escape in any
    // configuration, so `TsqlBuilder.escapeString` is correct, and rewriting its 65 call sites to
    // bind would be risk without a security gain. The empty `params` array is what keeps these
    // on `ConnectionPoolManager.query` (`request.batch`), byte-identical to before.
    const mssql = getDialect('mssql');
    for (const builder of CASES) {
      if (builder.name === 'rowCountQuery') continue; // binds on every engine, see below
      const query = builder.run(mssql);
      expect(query, `${builder.name} returned null on mssql`).not.toBeNull();
      expect(query?.params, `${builder.name} bound values on mssql`).toEqual([]);
    }
  });

  it('rowCountQuery binds on every engine, SQL Server included (J-136)', () => {
    // The one query whose arguments come from an LLM tool call rather than the explorer.
    expect(getDialect('mssql').rowCountQuery(HOSTILE, HOSTILE)).toEqual({
      sql: expect.stringContaining('@p0'),
      params: [HOSTILE, HOSTILE],
    });
    expect(getDialect('postgresql').rowCountQuery(HOSTILE, HOSTILE).params).toEqual([
      HOSTILE,
      HOSTILE,
    ]);
    expect(getDialect('mysql').rowCountQuery(HOSTILE, HOSTILE).params).toEqual([HOSTILE, HOSTILE]);
  });

  it('rowCountQuery rejects a non-string argument', () => {
    // The arguments arrive as untyped JSON from a tool call; a non-string would otherwise be
    // coerced into the parameter list and surprise the driver.
    const mysql = getDialect('mysql');
    expect(() => mysql.rowCountQuery(7 as unknown as string, 't')).toThrow(/must be a string/);
    expect(() => mysql.rowCountQuery('s', null as unknown as string)).toThrow(/must be a string/);
  });
});

/**
 * Count bind placeholders in `sql`.
 *
 * PostgreSQL numbers its placeholders and may repeat one, so the count is the highest ordinal
 * seen; MySQL's are positional, so the count is the number of `?` characters. Neither engine's
 * metadata SQL contains a `?` or a `$n` inside a quoted literal, and this asserts it stays
 * that way — one that did would make the count silently wrong.
 */
function countPlaceholders(label: string, sql: string): number {
  if (label === 'mysql') return (sql.match(/\?/g) ?? []).length;
  const ordinals = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
  return ordinals.length === 0 ? 0 : Math.max(...ordinals);
}
