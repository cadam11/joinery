/**
 * SQL Server (T-SQL) Dialect Implementation
 *
 * Delegates metadata queries to the existing TsqlBuilder to avoid
 * duplicating its 950+ lines. As other dialects mature, the shared
 * interface ensures callers never see T-SQL specifics.
 */

import type {
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
} from '@joinery/shared';
import { SQLDialect } from './sql-dialect';
import {
  bindableValue,
  placeholderFor,
  unboundQuery,
  type ParameterisedQuery,
  type PlaceholderStyle,
  type ValueBoundQuery,
} from './parameterised-query';
import { TsqlBuilder } from '../../../utils/tsql-builder';

export class MSSQLDialect extends SQLDialect {
  readonly engine = 'mssql' as const;
  readonly label = 'SQL Server';
  readonly defaultPort = 1433;
  readonly monacoLanguage = 'sql'; // Monaco's built-in SQL mode is T-SQL oriented
  readonly batchSeparator = 'GO';
  readonly supportsWindowsAuth = true;
  readonly supportsBackupRestore = true;
  readonly supportsExtendedProperties = true;
  readonly supportsObjectComments = true;
  readonly supportsServerFileBrowsing = true;

  /**
   * `@p0`, `@p1`, … — the names `ConnectionPoolManager.queryWithParams` binds its inputs to.
   * Only `rowCountQuery` uses them: every other builder here delegates to `TsqlBuilder`, whose
   * quote-doubling is correct for T-SQL and stays as it is (J-135).
   */
  protected readonly placeholderStyle: PlaceholderStyle = 'at';

  /**
   * `TOP` goes before the select list here, not `LIMIT` after the predicate.
   *
   * The `N'…'` prefix the J-52 literal carried is gone with the literal: a bound string reaches
   * tedious as NVarChar already, so the Unicode question the prefix answered does not arise.
   */
  override selectOneByColumnQuery(ref: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly value: unknown;
  }): ValueBoundQuery {
    const placeholder = placeholderFor(this.placeholderStyle, 1);
    const where = `${this.quoteIdentifier(ref.column)} = ${placeholder}`;
    return {
      sql: `SELECT TOP 1 * FROM ${this.quoteSchemaObject(ref.schema, ref.table)} WHERE ${where}`,
      params: [bindableValue(ref.value)],
    };
  }

  quoteIdentifier(name: string): string {
    return TsqlBuilder.escapeIdentifier(name);
  }

  useDatabaseSQL(database: string): string {
    return `USE ${this.quoteIdentifier(database)};`;
  }

  // ── DDL ──────────────────────────────────────────────────────

  createDatabaseSQL(options: CreateDatabaseOptions): string {
    return TsqlBuilder.createDatabase(options);
  }

  renameDatabaseSQL(options: RenameDatabaseOptions): string {
    return TsqlBuilder.renameDatabase(options);
  }

  dropDatabaseSQL(options: DeleteDatabaseOptions): string {
    return TsqlBuilder.dropDatabase(options);
  }

  // ── Metadata queries ─────────────────────────────────────────

  listDatabasesQuery(isAzure = false): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listDatabases(isAzure));
  }

  listSchemasQuery(database: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listSchemas(database));
  }

  listTablesQuery(database: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listTables(database));
  }

  listViewsQuery(database: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listViews(database));
  }

  listProceduresQuery(database: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listProcedures(database));
  }

  listFunctionsQuery(database: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listFunctions(database));
  }

  listColumnsQuery(database: string, schema: string, table: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listColumns(database, schema, table));
  }

  listIndexesQuery(database: string, schema: string, table: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listIndexes(database, schema, table));
  }

  listForeignKeysQuery(database: string, schema: string, table: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listForeignKeys(database, schema, table));
  }

  listConstraintsQuery(database: string, schema: string, table: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listConstraints(database, schema, table));
  }

  listTriggersQuery(database: string, schema: string, table: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listTriggers(database, schema, table));
  }

  getObjectDefinitionQuery(database: string, schema: string, name: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.getObjectDefinition(database, schema, name));
  }

  listObjectCommentsQuery(database: string, schema: string, table: string): ParameterisedQuery {
    return unboundQuery(TsqlBuilder.listExtendedProperties(database, schema, table));
  }
}
