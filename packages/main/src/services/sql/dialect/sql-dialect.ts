/**
 * SQL Dialect Abstraction
 *
 * Encapsulates all database-specific SQL syntax differences.
 * Each database engine (SQL Server, PostgreSQL, MySQL) provides
 * a concrete implementation.
 */

import type {
  DatabaseEngine,
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
  EngineVariant,
} from '@joinery/shared';
import {
  BoundValues,
  bindableValue,
  placeholderFor,
  type ParameterisedQuery,
  type PlaceholderStyle,
  type ValueBoundQuery,
} from './parameterised-query';

export type { ParameterisedQuery, PlaceholderStyle, ValueBoundQuery } from './parameterised-query';

// Re-export engine type for convenience
export type { DatabaseEngine };

/** Result of quoting a schema-qualified identifier */
export interface QualifiedName {
  sql: string; // e.g. [dbo].[Users] or "public"."users"
}

/**
 * Abstract SQL dialect — subclassed per database engine.
 */
export abstract class SQLDialect {
  abstract readonly engine: DatabaseEngine;

  /** Display name for the engine (e.g. "SQL Server", "PostgreSQL") */
  abstract readonly label: string;

  /** Default port for the engine */
  abstract readonly defaultPort: number;

  /** Monaco editor language ID for syntax highlighting */
  abstract readonly monacoLanguage: string;

  // ── Identifier quoting ──────────────────────────────────────

  /** Quote a single identifier (table, column, schema name) */
  abstract quoteIdentifier(name: string): string;

  /** Quote a schema-qualified object: schema.object */
  quoteSchemaObject(schema: string, object: string): string {
    return `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(object)}`;
  }

  /**
   * A string as a complete literal this engine will read as DATA (J-134).
   *
   * This returns the quotes as well as the escaped body. The shape matters: the escaping an engine
   * needs is not always expressible inside the quotes — PostgreSQL's is `E'…'`, which is a prefix —
   * so a helper that escaped only the body and left the caller to write `'…'` could not be made
   * correct for every engine, and read at each call site as though quote-doubling were the whole
   * job. It was not: see the `MySQLDialect` and `PgDialect` overrides.
   *
   * The default is the ANSI shape — quote-doubling — which is exactly right for T-SQL, the one
   * engine here with no backslash escape in any configuration.
   */
  quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  /**
   * A single-row lookup by one column's value, with the value BOUND (J-145).
   *
   * Two parts are engine-specific, which is why this is the dialect's job rather than a caller's
   * template: the row cap (`TOP` before the select list, `LIMIT` after the predicate) and the
   * placeholder spelling. The default is the `LIMIT` shape, which PostgreSQL and MySQL share.
   *
   * The value here is the one input in this application that is neither Joinery's own string nor a
   * catalogue name: it is a cell out of whatever result set the user is looking at, and the lookup
   * runs by itself when a disclosure is expanded. Binding it — rather than escaping it into the
   * predicate, which is what J-52's `formatLiteral` did — takes it off the "is the escaper correct
   * on this engine under this server setting?" footing that J-134 had to answer three times.
   */
  selectOneByColumnQuery(ref: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly value: unknown;
  }): ValueBoundQuery {
    const placeholder = placeholderFor(this.placeholderStyle, 1);
    const where = `${this.quoteIdentifier(ref.column)} = ${placeholder}`;
    return {
      sql: `SELECT * FROM ${this.quoteSchemaObject(ref.schema, ref.table)} WHERE ${where} LIMIT 1`,
      params: [bindableValue(ref.value)],
    };
  }

  // ── SQL generation helpers ──────────────────────────────────

  /** Statement to switch database context */
  abstract useDatabaseSQL(database: string): string;

  /** Batch separator (e.g. GO for T-SQL, none for PG/MySQL) */
  abstract readonly batchSeparator: string | null;

  // ── DDL: Databases ──────────────────────────────────────────

  abstract createDatabaseSQL(options: CreateDatabaseOptions): string;
  abstract renameDatabaseSQL(options: RenameDatabaseOptions): string;
  abstract dropDatabaseSQL(options: DeleteDatabaseOptions): string;

  // ── Bound values ────────────────────────────────────────────

  /** How this engine spells its bind placeholders. */
  protected abstract readonly placeholderStyle: PlaceholderStyle;

  /**
   * Start collecting the values a metadata query binds.
   *
   * `protected` on purpose: the accumulator is mutable, and the only place that may hand out a
   * placeholder is the builder that writes the SQL around it.
   */
  protected bindings(): BoundValues {
    return new BoundValues(this.placeholderStyle);
  }

  // ── Metadata queries ────────────────────────────────────────
  //
  // Each returns the SQL together with the values to bind to it (J-135). The schema, table and
  // object names these take reach the dialect from the explorer, from IPC arguments, and —
  // through `ToolRegistry` — from an LLM tool call, so on the engines whose drivers bind they are
  // bound rather than escaped into the statement. SQL Server's builders bind nothing: `TsqlBuilder`
  // writes its own literals, correctly, because T-SQL has no backslash escape in any
  // configuration.

  /**
   * `isAzure` is consulted only by MSSQLDialect — Azure SQL Database lacks
   * msdb.dbo.backupset, so the query must be split. PG/MySQL ignore the flag.
   */
  abstract listDatabasesQuery(isAzure?: boolean): ParameterisedQuery;
  abstract listSchemasQuery(database: string): ParameterisedQuery;
  abstract listTablesQuery(database: string, schema?: string): ParameterisedQuery;
  abstract listViewsQuery(database: string, schema?: string): ParameterisedQuery;
  abstract listProceduresQuery(database: string, schema?: string): ParameterisedQuery;
  abstract listFunctionsQuery(database: string, schema?: string): ParameterisedQuery;
  abstract listColumnsQuery(database: string, schema: string, table: string): ParameterisedQuery;
  abstract listIndexesQuery(database: string, schema: string, table: string): ParameterisedQuery;
  abstract listForeignKeysQuery(
    database: string,
    schema: string,
    table: string
  ): ParameterisedQuery;
  abstract listConstraintsQuery(
    database: string,
    schema: string,
    table: string
  ): ParameterisedQuery;
  abstract listTriggersQuery(database: string, schema: string, table: string): ParameterisedQuery;
  abstract getObjectDefinitionQuery(
    database: string,
    schema: string,
    name: string
  ): ParameterisedQuery;

  /**
   * The approximate row count for one table, behind the AI `get_table_row_count` tool.
   *
   * Its arguments come straight out of an LLM tool call, and the model's context includes text it
   * has read out of the user's database, so these are the least trustworthy strings in the main
   * process. They are bound on every engine, SQL Server included — this is the one query where
   * T-SQL binds too (J-136, promoted into the dialect layer by J-135).
   *
   * The default is the T-SQL form; PostgreSQL and MySQL override it.
   *
   * @throws if `schema` or `table` is not a string — they arrive as untyped JSON from a tool
   * call, and a non-string would otherwise be coerced into the parameter list.
   */
  rowCountQuery(schema: string, table: string): ParameterisedQuery {
    const values = this.assertNameArguments(schema, table);
    return values.query(`SELECT SUM(p.rows) AS row_count FROM sys.partitions p
      JOIN sys.tables t ON p.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = ${values.bind(schema)} AND t.name = ${values.bind(table)}
        AND p.index_id IN (0, 1)`);
  }

  /** Shared precondition for `rowCountQuery`: both arguments must be strings. */
  protected assertNameArguments(schema: string, table: string): BoundValues {
    if (typeof schema !== 'string') {
      throw new Error(`rowCountQuery: schema must be a string, got ${typeof schema}`);
    }
    if (typeof table !== 'string') {
      throw new Error(`rowCountQuery: table must be a string, got ${typeof table}`);
    }
    return this.bindings();
  }

  // ── Syntax patterns ─────────────────────────────────────────

  /** Whether this dialect uses GO as a client-side batch separator */
  get supportsBatchSeparator(): boolean {
    return this.batchSeparator !== null;
  }

  /** Whether this dialect supports Windows/AD authentication */
  abstract readonly supportsWindowsAuth: boolean;

  /** Whether this dialect supports backup/restore commands */
  abstract readonly supportsBackupRestore: boolean;

  /** Whether this dialect has extended properties (SQL Server) or comments (PostgreSQL) */
  abstract readonly supportsExtendedProperties: boolean;

  /** Whether this dialect supports object comments (COMMENT ON for PG, extended properties for MSSQL) */
  abstract readonly supportsObjectComments: boolean;

  /**
   * Query to list comments/descriptions for a table and its columns.
   * Returns rows with: name, value, level2Type, level2Name (matching ExtendedProperty shape).
   * SQL Server: uses fn_listextendedproperty
   * PostgreSQL: uses pg_description + obj_description
   */
  abstract listObjectCommentsQuery(
    database: string,
    schema: string,
    table: string
  ): ParameterisedQuery | null;

  /** Whether this dialect supports server-side file browsing (xp_dirtree etc.) */
  abstract readonly supportsServerFileBrowsing: boolean;

  // ── App-level capabilities (overridden by engine variants) ──

  /** Engine sub-variant, when this dialect represents one (e.g. Aurora DSQL) */
  get variant(): EngineVariant | undefined {
    return undefined;
  }

  /** Whether the server hosts multiple enumerable/switchable databases */
  get supportsMultipleDatabases(): boolean {
    return true;
  }

  /** Whether CREATE/RENAME/DROP DATABASE are meaningful on this server */
  get supportsDatabaseManagement(): boolean {
    return true;
  }

  get supportsStoredProcedures(): boolean {
    return true;
  }

  get supportsTriggers(): boolean {
    return true;
  }

  /**
   * Whether backup/restore is available at all (via SQL or CLI tooling).
   * Distinct from supportsBackupRestore, which means "backup via SQL" and is
   * false for PG/MySQL even though their CLI-based backup features work.
   */
  get supportsBackupTooling(): boolean {
    return true;
  }
}
