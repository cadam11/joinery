/**
 * PostgreSQL Dialect Implementation
 *
 * Uses information_schema and pg_catalog for metadata queries.
 * Identifier quoting uses double-quotes per SQL standard.
 */

import type {
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
} from '@joinery/shared';
import { SQLDialect } from './sql-dialect';
import {
  unboundQuery,
  type ParameterisedQuery,
  type PlaceholderStyle,
} from './parameterised-query';

export class PgDialect extends SQLDialect {
  readonly engine = 'postgresql' as const;
  readonly label: string = 'PostgreSQL';
  readonly defaultPort = 5432;
  readonly monacoLanguage = 'pgsql';
  readonly batchSeparator = null; // PostgreSQL doesn't use GO
  readonly supportsWindowsAuth = false;
  readonly supportsBackupRestore = false; // pg_dump/pg_restore are CLI tools, not SQL
  readonly supportsExtendedProperties = false; // PG uses COMMENT ON instead
  readonly supportsObjectComments = true; // PG supports COMMENT ON
  readonly supportsServerFileBrowsing = false;

  /** `$1`, `$2`, … — node-pg's numbered placeholders, bound over the extended query protocol. */
  protected readonly placeholderStyle: PlaceholderStyle = 'dollar';

  /**
   * `E'…'`, with backslashes doubled as well as quotes (J-52).
   *
   * With `standard_conforming_strings` off — the default before PostgreSQL 9.1, and still set that
   * way in the wild — a backslash starts an escape inside an ordinary literal, so a value ending
   * `\\` consumes the closing quote and the following `'` OPENS a new literal: the statement
   * terminator then lands outside it. node-postgres sends this through the simple query protocol,
   * which executes multiple statements per message, so an injected statement would run.
   *
   * `E'…'` is escape-string syntax in every configuration, which makes the escaping
   * setting-independent: double the backslashes AND the quotes and the value is data whatever the
   * server is set to. Refusing values containing backslashes would also be safe and would break
   * ordinary data — a Windows path in a text column.
   *
   * This reasoning is the renderer's, from `features/query/fk-lookup.ts`, which had it first and
   * whose SQL this replaces on the main side. J-134 moved it from `formatLiteral` — the
   * result-set path alone — down to `quoteLiteral`, which every metadata query then went through
   * as well. J-135 bound the metadata names and J-145 bound the result-set cell, so what is left
   * on this escaper is the DDL builders, where a collation and a `pg_stat_activity.datname` are
   * part of the statement rather than values in it.
   */
  override quoteLiteral(value: string): string {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''");
    return `E'${escaped}'`;
  }

  quoteIdentifier(name: string): string {
    const escaped = name.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  useDatabaseSQL(_database: string): string {
    // PostgreSQL switches databases at the connection level, not via SQL.
    // Returning empty string; the provider handles this at connect time.
    return '';
  }

  // ── DDL ──────────────────────────────────────────────────────

  createDatabaseSQL(options: CreateDatabaseOptions): string {
    const name = this.quoteIdentifier(options.name);
    let sql = `CREATE DATABASE ${name}`;
    if (options.collation) {
      sql += ` LC_COLLATE = ${this.quoteLiteral(options.collation)}`;
    }
    sql += ';';
    return sql;
  }

  renameDatabaseSQL(options: RenameDatabaseOptions): string {
    const current = this.quoteIdentifier(options.currentName);
    const next = this.quoteIdentifier(options.newName);

    let sql = '';
    if (options.closeConnections) {
      // Terminate active connections to the database
      sql += `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${this.quoteLiteral(options.currentName)} AND pid <> pg_backend_pid();\n\n`;
    }
    sql += `ALTER DATABASE ${current} RENAME TO ${next};`;
    return sql;
  }

  dropDatabaseSQL(options: DeleteDatabaseOptions): string {
    let sql = '';
    if (options.closeConnections) {
      sql += `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${this.quoteLiteral(options.name)} AND pid <> pg_backend_pid();\n\n`;
    }
    sql += `DROP DATABASE ${this.quoteIdentifier(options.name)};`;
    return sql;
  }

  // ── Metadata queries ─────────────────────────────────────────
  //
  // Every schema, table and object name below is BOUND, not written into the SQL (J-135). node-pg
  // takes the extended query protocol as soon as a query carries values, so a bound value reaches
  // the server out of band and is never lexed — which also ends this file's dependence on
  // `standard_conforming_strings` for anything but `quoteLiteral`.

  listDatabasesQuery(_isAzure?: boolean): ParameterisedQuery {
    return unboundQuery(`
SELECT
  d.datname AS name,
  d.oid AS "databaseId",
  pg_database_size(d.datname) AS "sizeBytes",
  CASE WHEN d.datallowconn THEN 'online' ELSE 'offline' END AS state,
  d.datcollate AS collation,
  CASE WHEN d.datistemplate OR d.datname IN ('postgres', 'template0', 'template1')
    THEN true ELSE false END AS "isSystemDb",
  NULL AS "createdAt"
FROM pg_database d
WHERE d.datistemplate = false
ORDER BY d.datname;`);
  }

  listSchemasQuery(_database: string): ParameterisedQuery {
    // The database name is not a predicate here: PostgreSQL reaches a database by connecting to
    // it, so the name is the pool key rather than a value. Nothing to bind.
    return unboundQuery(`
SELECT
  n.nspname AS name,
  r.rolname AS owner,
  CASE WHEN n.nspname LIKE 'pg_%' OR n.nspname = 'information_schema'
    THEN true ELSE false END AS "isSystem"
FROM pg_namespace n
LEFT JOIN pg_roles r ON n.nspowner = r.oid
WHERE n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY
  CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END,
  n.nspname;`);
  }

  listTablesQuery(_database: string, schema?: string): ParameterisedQuery {
    const values = this.bindings();
    const schemaFilter = schema
      ? `AND t.schemaname = ${values.bind(schema)}`
      : `AND t.schemaname NOT IN ('pg_catalog', 'information_schema')`;
    return values.query(`
SELECT
  t.schemaname AS schema,
  t.tablename AS name,
  COALESCE(s.n_live_tup, 0) AS "rowCount",
  pg_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)) / 1024 AS "sizeKb",
  c.reltuples::bigint AS "createdAt"
FROM pg_tables t
LEFT JOIN pg_stat_user_tables s ON t.schemaname = s.schemaname AND t.tablename = s.relname
LEFT JOIN pg_class c ON c.relname = t.tablename
  AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.schemaname)
WHERE t.tableowner IS NOT NULL
  ${schemaFilter}
ORDER BY t.schemaname, t.tablename;`);
  }

  listViewsQuery(_database: string, schema?: string): ParameterisedQuery {
    const values = this.bindings();
    const schemaFilter = schema
      ? `AND v.schemaname = ${values.bind(schema)}`
      : `AND v.schemaname NOT IN ('pg_catalog', 'information_schema')`;
    return values.query(`
SELECT
  v.schemaname AS schema,
  v.viewname AS name
FROM pg_views v
WHERE true ${schemaFilter}
ORDER BY v.schemaname, v.viewname;`);
  }

  listProceduresQuery(_database: string, schema?: string): ParameterisedQuery {
    const values = this.bindings();
    const schemaFilter = schema
      ? `AND n.nspname = ${values.bind(schema)}`
      : `AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;
    return values.query(`
SELECT
  n.nspname AS schema,
  p.proname AS name,
  NULL AS "createdAt",
  NULL AS "modifiedAt"
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.prokind = 'p'
  ${schemaFilter}
ORDER BY n.nspname, p.proname;`);
  }

  listFunctionsQuery(_database: string, schema?: string): ParameterisedQuery {
    const values = this.bindings();
    const schemaFilter = schema
      ? `AND n.nspname = ${values.bind(schema)}`
      : `AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;
    return values.query(`
SELECT
  n.nspname AS schema,
  p.proname AS name,
  CASE
    WHEN p.proretset THEN 'Table-valued'
    ELSE 'Scalar'
  END AS type,
  NULL AS "createdAt",
  NULL AS "modifiedAt"
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.prokind = 'f'
  ${schemaFilter}
ORDER BY n.nspname, p.proname;`);
  }

  listColumnsQuery(_database: string, schema: string, table: string): ParameterisedQuery {
    const values = this.bindings();
    return values.query(`
SELECT
  c.column_name AS name,
  c.data_type AS "dataType",
  c.character_maximum_length AS "maxLength",
  c.numeric_precision AS precision,
  c.numeric_scale AS scale,
  CASE WHEN c.is_nullable = 'YES' THEN true ELSE false END AS "isNullable",
  CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS "isPrimaryKey",
  CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END AS "isForeignKey",
  c.column_default AS "defaultValue",
  c.ordinal_position AS "ordinalPosition"
FROM information_schema.columns c
LEFT JOIN (
  SELECT kcu.column_name, tc.constraint_type
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = ${values.bind(schema)}
    AND tc.table_name = ${values.bind(table)}
    AND tc.constraint_type = 'PRIMARY KEY'
) tc ON c.column_name = tc.column_name
LEFT JOIN (
  SELECT DISTINCT kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = ${values.bind(schema)}
    AND tc.table_name = ${values.bind(table)}
    AND tc.constraint_type = 'FOREIGN KEY'
) fk ON c.column_name = fk.column_name
WHERE c.table_schema = ${values.bind(schema)}
  AND c.table_name = ${values.bind(table)}
ORDER BY c.ordinal_position;`);
  }

  listIndexesQuery(_database: string, schema: string, table: string): ParameterisedQuery {
    const values = this.bindings();
    return values.query(`
SELECT
  i.relname AS name,
  CASE
    WHEN ix.indisclustered THEN 'clustered'
    WHEN ix.indisunique AND ix.indisprimary THEN 'primary'
    WHEN ix.indisunique THEN 'unique'
    ELSE 'nonclustered'
  END AS type,
  ix.indisunique AS "isUnique",
  ix.indisprimary AS "isPrimaryKey",
  string_agg(a.attname, ', ' ORDER BY array_position(ix.indkey, a.attnum)) AS columns
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON t.relnamespace = n.oid
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
WHERE n.nspname = ${values.bind(schema)}
  AND t.relname = ${values.bind(table)}
GROUP BY i.relname, ix.indisclustered, ix.indisunique, ix.indisprimary
ORDER BY ix.indisprimary DESC, i.relname;`);
  }

  listForeignKeysQuery(_database: string, schema: string, table: string): ParameterisedQuery {
    const values = this.bindings();
    return values.query(`
SELECT
  tc.constraint_name AS name,
  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns,
  ccu.table_schema AS "referencedSchema",
  ccu.table_name AS "referencedTable",
  string_agg(ccu.column_name, ', ' ORDER BY kcu.ordinal_position) AS "referencedColumns",
  LOWER(rc.delete_rule) AS "onDelete",
  LOWER(rc.update_rule) AS "onUpdate"
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = ${values.bind(schema)}
  AND tc.table_name = ${values.bind(table)}
GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name, rc.delete_rule, rc.update_rule
ORDER BY tc.constraint_name;`);
  }

  listConstraintsQuery(_database: string, schema: string, table: string): ParameterisedQuery {
    const values = this.bindings();
    return values.query(`
SELECT
  tc.constraint_name AS name,
  CASE tc.constraint_type
    WHEN 'PRIMARY KEY' THEN 'primary_key'
    WHEN 'FOREIGN KEY' THEN 'foreign_key'
    WHEN 'UNIQUE' THEN 'unique'
    WHEN 'CHECK' THEN 'check'
    ELSE LOWER(tc.constraint_type)
  END AS type,
  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns,
  cc.check_clause AS definition
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
LEFT JOIN information_schema.check_constraints cc
  ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
WHERE tc.table_schema = ${values.bind(schema)}
  AND tc.table_name = ${values.bind(table)}
GROUP BY tc.constraint_name, tc.constraint_type, cc.check_clause
ORDER BY tc.constraint_type, tc.constraint_name;`);
  }

  /**
   * `pg_trigger.tgenabled` is the `"char"` type, which PostgreSQL will not cast to boolean: the
   * `NOT t.tgenabled::boolean` this used to select raised `cannot cast type "char" to boolean` on
   * every call, so the PostgreSQL trigger list — and the table-properties dialog that fans out to
   * it — has never worked. Verified against the harness PostgreSQL 16.15. The values are 'O'
   * origin, 'D' disabled, 'R' replica, 'A' always; only 'D' means disabled.
   */
  listTriggersQuery(_database: string, schema: string, table: string): ParameterisedQuery {
    const values = this.bindings();
    return values.query(`
SELECT
  t.tgname AS name,
  (t.tgenabled = 'D') AS "isDisabled",
  CASE
    WHEN t.tgtype & 1 = 1 THEN 'insert'
    WHEN t.tgtype & 4 = 4 THEN 'update'
    WHEN t.tgtype & 8 = 8 THEN 'delete'
    WHEN t.tgtype & 64 = 64 THEN 'instead_of'
    ELSE 'unknown'
  END AS "triggerType",
  NULL AS "createdAt"
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE NOT t.tgisinternal
  AND n.nspname = ${values.bind(schema)}
  AND c.relname = ${values.bind(table)}
ORDER BY t.tgname;`);
  }

  getObjectDefinitionQuery(_database: string, schema: string, name: string): ParameterisedQuery {
    // Try view first, then function/procedure
    const values = this.bindings();
    return values.query(`
SELECT
  COALESCE(
    (SELECT definition FROM pg_views WHERE schemaname = ${values.bind(schema)} AND viewname = ${values.bind(name)}),
    (SELECT pg_get_functiondef(p.oid)
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = ${values.bind(schema)} AND p.proname = ${values.bind(name)}
     LIMIT 1)
  ) AS definition;`);
  }

  /**
   * List COMMENT ON descriptions for a table and its columns.
   * Returns data shaped like ExtendedProperty for UI consistency.
   *
   * The four select-list occurrences are cast to `text`: PostgreSQL cannot infer the type of a
   * bare parameter in a target list, and answers `could not determine data type of parameter $1`.
   */
  listObjectCommentsQuery(_database: string, schema: string, table: string): ParameterisedQuery {
    const values = this.bindings();
    return values.query(`
-- Table comment
SELECT
  'MS_Description' AS name,
  obj_description(c.oid) AS value,
  'SCHEMA' AS "level0Type",
  ${values.bind(schema)}::text AS "level0Name",
  'TABLE' AS "level1Type",
  ${values.bind(table)}::text AS "level1Name",
  NULL AS "level2Type",
  NULL AS "level2Name"
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = ${values.bind(schema)}
  AND c.relname = ${values.bind(table)}
  AND obj_description(c.oid) IS NOT NULL

UNION ALL

-- Column comments
SELECT
  'MS_Description' AS name,
  col_description(c.oid, a.attnum) AS value,
  'SCHEMA' AS "level0Type",
  ${values.bind(schema)}::text AS "level0Name",
  'TABLE' AS "level1Type",
  ${values.bind(table)}::text AS "level1Name",
  'COLUMN' AS "level2Type",
  a.attname AS "level2Name"
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = ${values.bind(schema)}
  AND c.relname = ${values.bind(table)}
  AND col_description(c.oid, a.attnum) IS NOT NULL
ORDER BY "level2Type" NULLS FIRST, "level2Name";`);
  }

  /**
   * `pg_class.reltuples` works on standard PostgreSQL and on Aurora DSQL (which lacks
   * `pg_stat_user_tables`), and is the AWS-recommended way to approximate a row count without a
   * full scan.
   */
  override rowCountQuery(schema: string, table: string): ParameterisedQuery {
    const values = this.assertNameArguments(schema, table);
    return values.query(`SELECT COALESCE(c.reltuples, 0)::bigint AS row_count
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = ${values.bind(schema)} AND c.relname = ${values.bind(table)}
        AND c.relkind = 'r'`);
  }
}
