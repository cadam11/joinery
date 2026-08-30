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
import { SQLDialect, textOf } from './sql-dialect';
import {
  unboundQuery,
  type ParameterisedQuery,
  type PlaceholderStyle,
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
   * `N'…'` — the national-character prefix, so a value with non-ASCII text compares as itself.
   *
   * Quote-doubling only: T-SQL has no backslash escape in any configuration, so doubling
   * backslashes the way PostgreSQL needs would turn one backslash in the data into two in the
   * predicate, and the lookup would miss the row (J-52).
   */
  override formatLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';

    return `N${this.quoteLiteral(textOf(value))}`;
  }

  /** `TOP` goes before the select list here, not `LIMIT` after the predicate. */
  override selectOneByColumnSQL(ref: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly value: unknown;
  }): string {
    const where = `${this.quoteIdentifier(ref.column)} = ${this.formatLiteral(ref.value)}`;
    return `SELECT TOP 1 * FROM ${this.quoteSchemaObject(ref.schema, ref.table)} WHERE ${where}`;
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
