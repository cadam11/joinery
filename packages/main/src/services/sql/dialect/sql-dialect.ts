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

// Re-export engine type for convenience
export type { DatabaseEngine };

/** Result of quoting a schema-qualified identifier */
export interface QualifiedName {
  sql: string; // e.g. [dbo].[Users] or "public"."users"
}

/**
 * Abstract SQL dialect — subclassed per database engine.
 */
/** A non-primitive value as the text a literal will carry. */
export function textOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

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
   * A JavaScript value as a literal this engine will read as DATA (J-52).
   *
   * The escaping itself is `quoteLiteral`'s job; this adds the type handling on top of it — NULL,
   * numbers, and the boolean spelling each engine reads — because the values reaching this one come
   * from result-set cells rather than from Joinery's own strings.
   *
   * The default is the ANSI shape: quote-doubling, and `1`/`0` for booleans.
   */
  formatLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';

    return this.quoteLiteral(textOf(value));
  }

  /**
   * A single-row lookup by one column's value.
   *
   * The row cap is the engine-specific part — `TOP` before the list, `LIMIT` after the predicate —
   * which is why this is the dialect's job rather than a caller's template.
   */
  selectOneByColumnSQL(ref: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly value: unknown;
  }): string {
    const where = `${this.quoteIdentifier(ref.column)} = ${this.formatLiteral(ref.value)}`;
    return `SELECT * FROM ${this.quoteSchemaObject(ref.schema, ref.table)} WHERE ${where} LIMIT 1`;
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

  // ── Metadata queries ────────────────────────────────────────

  /**
   * `isAzure` is consulted only by MSSQLDialect — Azure SQL Database lacks
   * msdb.dbo.backupset, so the query must be split. PG/MySQL ignore the flag.
   */
  abstract listDatabasesSQL(isAzure?: boolean): string;
  abstract listSchemasSQL(database: string): string;
  abstract listTablesSQL(database: string, schema?: string): string;
  abstract listViewsSQL(database: string, schema?: string): string;
  abstract listProceduresSQL(database: string, schema?: string): string;
  abstract listFunctionsSQL(database: string, schema?: string): string;
  abstract listColumnsSQL(database: string, schema: string, table: string): string;
  abstract listIndexesSQL(database: string, schema: string, table: string): string;
  abstract listForeignKeysSQL(database: string, schema: string, table: string): string;
  abstract listConstraintsSQL(database: string, schema: string, table: string): string;
  abstract listTriggersSQL(database: string, schema: string, table: string): string;
  abstract getObjectDefinitionSQL(database: string, schema: string, name: string): string;

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
  abstract listObjectCommentsSQL(database: string, schema: string, table: string): string | null;

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
