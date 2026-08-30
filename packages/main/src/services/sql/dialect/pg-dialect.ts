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
import { SQLDialect, textOf } from './sql-dialect';

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
   * result-set path alone — down to `quoteLiteral`, which every metadata query now goes
   * through as well.
   */
  override quoteLiteral(value: string): string {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''");
    return `E'${escaped}'`;
  }

  override formatLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

    return this.quoteLiteral(textOf(value));
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

  listDatabasesSQL(_isAzure?: boolean): string {
    return `
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
ORDER BY d.datname;`;
  }

  listSchemasSQL(_database: string): string {
    return `
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
  n.nspname;`;
  }

  listTablesSQL(_database: string, schema?: string): string {
    const schemaFilter = schema
      ? `AND t.schemaname = ${this.quoteLiteral(schema)}`
      : `AND t.schemaname NOT IN ('pg_catalog', 'information_schema')`;
    return `
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
ORDER BY t.schemaname, t.tablename;`;
  }

  listViewsSQL(_database: string, schema?: string): string {
    const schemaFilter = schema
      ? `AND v.schemaname = ${this.quoteLiteral(schema)}`
      : `AND v.schemaname NOT IN ('pg_catalog', 'information_schema')`;
    return `
SELECT
  v.schemaname AS schema,
  v.viewname AS name
FROM pg_views v
WHERE true ${schemaFilter}
ORDER BY v.schemaname, v.viewname;`;
  }

  listProceduresSQL(_database: string, schema?: string): string {
    const schemaFilter = schema
      ? `AND n.nspname = ${this.quoteLiteral(schema)}`
      : `AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;
    return `
SELECT
  n.nspname AS schema,
  p.proname AS name,
  NULL AS "createdAt",
  NULL AS "modifiedAt"
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.prokind = 'p'
  ${schemaFilter}
ORDER BY n.nspname, p.proname;`;
  }

  listFunctionsSQL(_database: string, schema?: string): string {
    const schemaFilter = schema
      ? `AND n.nspname = ${this.quoteLiteral(schema)}`
      : `AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;
    return `
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
ORDER BY n.nspname, p.proname;`;
  }

  listColumnsSQL(_database: string, schema: string, table: string): string {
    return `
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
  WHERE tc.table_schema = ${this.quoteLiteral(schema)}
    AND tc.table_name = ${this.quoteLiteral(table)}
    AND tc.constraint_type = 'PRIMARY KEY'
) tc ON c.column_name = tc.column_name
LEFT JOIN (
  SELECT DISTINCT kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = ${this.quoteLiteral(schema)}
    AND tc.table_name = ${this.quoteLiteral(table)}
    AND tc.constraint_type = 'FOREIGN KEY'
) fk ON c.column_name = fk.column_name
WHERE c.table_schema = ${this.quoteLiteral(schema)}
  AND c.table_name = ${this.quoteLiteral(table)}
ORDER BY c.ordinal_position;`;
  }

  listIndexesSQL(_database: string, schema: string, table: string): string {
    return `
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
WHERE n.nspname = ${this.quoteLiteral(schema)}
  AND t.relname = ${this.quoteLiteral(table)}
GROUP BY i.relname, ix.indisclustered, ix.indisunique, ix.indisprimary
ORDER BY ix.indisprimary DESC, i.relname;`;
  }

  listForeignKeysSQL(_database: string, schema: string, table: string): string {
    return `
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
  AND tc.table_schema = ${this.quoteLiteral(schema)}
  AND tc.table_name = ${this.quoteLiteral(table)}
GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name, rc.delete_rule, rc.update_rule
ORDER BY tc.constraint_name;`;
  }

  listConstraintsSQL(_database: string, schema: string, table: string): string {
    return `
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
WHERE tc.table_schema = ${this.quoteLiteral(schema)}
  AND tc.table_name = ${this.quoteLiteral(table)}
GROUP BY tc.constraint_name, tc.constraint_type, cc.check_clause
ORDER BY tc.constraint_type, tc.constraint_name;`;
  }

  listTriggersSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  t.tgname AS name,
  NOT t.tgenabled::boolean AS "isDisabled",
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
  AND n.nspname = ${this.quoteLiteral(schema)}
  AND c.relname = ${this.quoteLiteral(table)}
ORDER BY t.tgname;`;
  }

  getObjectDefinitionSQL(_database: string, schema: string, name: string): string {
    // Try view first, then function/procedure
    return `
SELECT
  COALESCE(
    (SELECT definition FROM pg_views WHERE schemaname = ${this.quoteLiteral(schema)} AND viewname = ${this.quoteLiteral(name)}),
    (SELECT pg_get_functiondef(p.oid)
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = ${this.quoteLiteral(schema)} AND p.proname = ${this.quoteLiteral(name)}
     LIMIT 1)
  ) AS definition;`;
  }

  /**
   * List COMMENT ON descriptions for a table and its columns.
   * Returns data shaped like ExtendedProperty for UI consistency.
   */
  listObjectCommentsSQL(_database: string, schema: string, table: string): string {
    return `
-- Table comment
SELECT
  'MS_Description' AS name,
  obj_description(c.oid) AS value,
  'SCHEMA' AS "level0Type",
  ${this.quoteLiteral(schema)} AS "level0Name",
  'TABLE' AS "level1Type",
  ${this.quoteLiteral(table)} AS "level1Name",
  NULL AS "level2Type",
  NULL AS "level2Name"
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = ${this.quoteLiteral(schema)}
  AND c.relname = ${this.quoteLiteral(table)}
  AND obj_description(c.oid) IS NOT NULL

UNION ALL

-- Column comments
SELECT
  'MS_Description' AS name,
  col_description(c.oid, a.attnum) AS value,
  'SCHEMA' AS "level0Type",
  ${this.quoteLiteral(schema)} AS "level0Name",
  'TABLE' AS "level1Type",
  ${this.quoteLiteral(table)} AS "level1Name",
  'COLUMN' AS "level2Type",
  a.attname AS "level2Name"
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = ${this.quoteLiteral(schema)}
  AND c.relname = ${this.quoteLiteral(table)}
  AND col_description(c.oid, a.attnum) IS NOT NULL
ORDER BY "level2Type" NULLS FIRST, "level2Name";`;
  }
}
