/**
 * MySQL Dialect Implementation
 *
 * Uses information_schema for metadata queries.
 * Identifier quoting uses backticks per MySQL convention.
 */

import type {
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
} from '@joinery/shared';
import { SQLDialect } from './sql-dialect';

export class MySQLDialect extends SQLDialect {
  readonly engine = 'mysql' as const;
  readonly label = 'MySQL';
  readonly defaultPort = 3306;
  readonly monacoLanguage = 'mysql';
  readonly batchSeparator = null; // MySQL doesn't use GO
  readonly supportsWindowsAuth = false;
  readonly supportsBackupRestore = false; // mysqldump/mysql are CLI tools, not SQL
  readonly supportsExtendedProperties = false;
  readonly supportsObjectComments = true; // MySQL supports COMMENT in DDL
  readonly supportsServerFileBrowsing = false;

  /**
   * `'…'` with backslashes doubled as well as quotes (J-134).
   *
   * MySQL treats `\` as an escape character inside a string literal unless `NO_BACKSLASH_ESCAPES`
   * is in `sql_mode`, and it is not there by default — the harness server (MySQL 8.4) reports
   * `IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,
   * ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`. So a value ending in a backslash escapes
   * the quote that should close the literal, the next quote opens a new one, and a `;` lands
   * outside it. Both MySQL pools are opened `multipleStatements: true` (`connection-pool.ts`,
   * `provider/mysql-provider.ts`), so that second statement runs.
   *
   * Doubling BOTH is deliberate. mysql2's own escaper (`sql-escaper`, its `escapeString`) writes
   * `\'` and `\\`; that is correct in the default mode and unsafe under `NO_BACKSLASH_ESCAPES`,
   * where `\'` is a literal backslash followed by a quote that CLOSES the literal. Quote-doubling
   * is an escape in both modes, so `''` + `\\` is the only pair that cannot be talked out of the
   * literal either way. The cost is that under `NO_BACKSLASH_ESCAPES` — not the default, and not
   * something Joinery sets — one backslash in the data reads back as two. Safe in both modes and
   * lossy in the rare one beats correct in one mode and injectable in the other.
   */
  override quoteLiteral(value: string): string {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''");
    return `'${escaped}'`;
  }

  quoteIdentifier(name: string): string {
    const escaped = name.replace(/`/g, '``');
    return `\`${escaped}\``;
  }

  useDatabaseSQL(database: string): string {
    return `USE ${this.quoteIdentifier(database)};`;
  }

  // ── DDL ──────────────────────────────────────────────────────

  createDatabaseSQL(options: CreateDatabaseOptions): string {
    const name = this.quoteIdentifier(options.name);
    let sql = `CREATE DATABASE ${name} CHARACTER SET utf8mb4`;
    if (options.collation) {
      sql += ` COLLATE ${this.quoteLiteral(options.collation)}`;
    } else {
      sql += ' COLLATE utf8mb4_unicode_ci';
    }
    sql += ';';
    return sql;
  }

  renameDatabaseSQL(_options: RenameDatabaseOptions): string {
    // MySQL does not support RENAME DATABASE.
    // The workaround is mysqldump + create new + import + drop old,
    // which cannot be expressed as a single SQL statement.
    return '-- MySQL does not support RENAME DATABASE.\n-- Use mysqldump to export, create a new database, import, then drop the old one.';
  }

  dropDatabaseSQL(options: DeleteDatabaseOptions): string {
    return `DROP DATABASE ${this.quoteIdentifier(options.name)};`;
  }

  // ── Metadata queries ─────────────────────────────────────────

  listDatabasesSQL(_isAzure?: boolean): string {
    return `
SELECT
  s.SCHEMA_NAME AS name,
  NULL AS \`databaseId\`,
  COALESCE(t.sizeBytes, 0) AS \`sizeBytes\`,
  'online' AS state,
  s.DEFAULT_COLLATION_NAME AS collation,
  CASE WHEN s.SCHEMA_NAME IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    THEN true ELSE false END AS \`isSystemDb\`,
  NULL AS \`createdAt\`
FROM information_schema.SCHEMATA s
LEFT JOIN (
  SELECT TABLE_SCHEMA, SUM(DATA_LENGTH + INDEX_LENGTH) AS sizeBytes
  FROM information_schema.TABLES
  GROUP BY TABLE_SCHEMA
) t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY s.SCHEMA_NAME;`;
  }

  listSchemasSQL(database: string): string {
    // MySQL conflates database and schema — return the database as a single schema
    return `
SELECT
  ${this.quoteLiteral(database)} AS name,
  NULL AS owner,
  false AS \`isSystem\`;`;
  }

  listTablesSQL(_database: string, schema?: string): string {
    const db = schema || _database;
    return `
SELECT
  TABLE_NAME AS name,
  TABLE_SCHEMA AS \`schema\`,
  TABLE_ROWS AS \`rowCount\`,
  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024) AS \`sizeKb\`,
  CREATE_TIME AS \`createdAt\`
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${this.quoteLiteral(db)}
  AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME;`;
  }

  listViewsSQL(_database: string, schema?: string): string {
    const db = schema || _database;
    return `
SELECT
  TABLE_NAME AS name,
  TABLE_SCHEMA AS \`schema\`
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = ${this.quoteLiteral(db)}
ORDER BY TABLE_NAME;`;
  }

  listProceduresSQL(_database: string, schema?: string): string {
    const db = schema || _database;
    return `
SELECT
  ROUTINE_NAME AS name,
  ROUTINE_SCHEMA AS \`schema\`,
  CREATED AS \`createdAt\`,
  LAST_ALTERED AS \`modifiedAt\`
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ${this.quoteLiteral(db)}
  AND ROUTINE_TYPE = 'PROCEDURE'
ORDER BY ROUTINE_NAME;`;
  }

  listFunctionsSQL(_database: string, schema?: string): string {
    const db = schema || _database;
    return `
SELECT
  ROUTINE_NAME AS name,
  ROUTINE_SCHEMA AS \`schema\`,
  'Scalar' AS type,
  CREATED AS \`createdAt\`,
  LAST_ALTERED AS \`modifiedAt\`
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ${this.quoteLiteral(db)}
  AND ROUTINE_TYPE = 'FUNCTION'
ORDER BY ROUTINE_NAME;`;
  }

  listColumnsSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  COLUMN_NAME AS name,
  DATA_TYPE AS \`dataType\`,
  CHARACTER_MAXIMUM_LENGTH AS \`maxLength\`,
  NUMERIC_PRECISION AS \`precision\`,
  NUMERIC_SCALE AS \`scale\`,
  IF(IS_NULLABLE = 'YES', true, false) AS \`isNullable\`,
  IF(COLUMN_KEY = 'PRI', true, false) AS \`isPrimaryKey\`,
  IF(COLUMN_KEY = 'MUL', true, false) AS \`isForeignKey\`,
  COLUMN_DEFAULT AS \`defaultValue\`,
  ORDINAL_POSITION AS \`ordinalPosition\`
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${this.quoteLiteral(schema)}
  AND TABLE_NAME = ${this.quoteLiteral(table)}
ORDER BY ORDINAL_POSITION;`;
  }

  listIndexesSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  INDEX_NAME AS name,
  CASE
    WHEN INDEX_NAME = 'PRIMARY' THEN 'primary'
    WHEN NON_UNIQUE = 0 THEN 'unique'
    ELSE 'nonclustered'
  END AS type,
  IF(NON_UNIQUE = 0, true, false) AS \`isUnique\`,
  IF(INDEX_NAME = 'PRIMARY', true, false) AS \`isPrimaryKey\`,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS \`columns\`
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ${this.quoteLiteral(schema)}
  AND TABLE_NAME = ${this.quoteLiteral(table)}
GROUP BY INDEX_NAME, NON_UNIQUE
ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME;`;
  }

  listForeignKeysSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  kcu.CONSTRAINT_NAME AS name,
  GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ', ') AS \`columns\`,
  kcu.REFERENCED_TABLE_SCHEMA AS \`referencedSchema\`,
  kcu.REFERENCED_TABLE_NAME AS \`referencedTable\`,
  GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ', ') AS \`referencedColumns\`,
  LOWER(rc.DELETE_RULE) AS \`onDelete\`,
  LOWER(rc.UPDATE_RULE) AS \`onUpdate\`
FROM information_schema.KEY_COLUMN_USAGE kcu
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
WHERE kcu.TABLE_SCHEMA = ${this.quoteLiteral(schema)}
  AND kcu.TABLE_NAME = ${this.quoteLiteral(table)}
  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
GROUP BY kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
  rc.DELETE_RULE, rc.UPDATE_RULE
ORDER BY kcu.CONSTRAINT_NAME;`;
  }

  listConstraintsSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  tc.CONSTRAINT_NAME AS name,
  CASE tc.CONSTRAINT_TYPE
    WHEN 'PRIMARY KEY' THEN 'primary_key'
    WHEN 'FOREIGN KEY' THEN 'foreign_key'
    WHEN 'UNIQUE' THEN 'unique'
    WHEN 'CHECK' THEN 'check'
    ELSE LOWER(tc.CONSTRAINT_TYPE)
  END AS type,
  GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ', ') AS \`columns\`,
  cc.CHECK_CLAUSE AS definition
FROM information_schema.TABLE_CONSTRAINTS tc
LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME = kcu.TABLE_NAME
LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
  ON cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND cc.CONSTRAINT_SCHEMA = tc.TABLE_SCHEMA
WHERE tc.TABLE_SCHEMA = ${this.quoteLiteral(schema)}
  AND tc.TABLE_NAME = ${this.quoteLiteral(table)}
GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, cc.CHECK_CLAUSE
ORDER BY tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME;`;
  }

  listTriggersSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  TRIGGER_NAME AS name,
  false AS \`isDisabled\`,
  LOWER(EVENT_MANIPULATION) AS \`triggerType\`,
  CREATED AS \`createdAt\`
FROM information_schema.TRIGGERS
WHERE EVENT_OBJECT_SCHEMA = ${this.quoteLiteral(schema)}
  AND EVENT_OBJECT_TABLE = ${this.quoteLiteral(table)}
ORDER BY TRIGGER_NAME;`;
  }

  getObjectDefinitionSQL(_database: string, schema: string, name: string): string {
    // Try views first, then routines
    return `
SELECT
  COALESCE(
    (SELECT VIEW_DEFINITION FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ${this.quoteLiteral(schema)} AND TABLE_NAME = ${this.quoteLiteral(name)}),
    (SELECT ROUTINE_DEFINITION FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = ${this.quoteLiteral(schema)} AND ROUTINE_NAME = ${this.quoteLiteral(name)}
     LIMIT 1)
  ) AS definition;`;
  }

  /**
   * List TABLE_COMMENT and COLUMN_COMMENT values.
   * Returns data shaped like ExtendedProperty for UI consistency.
   */
  listObjectCommentsSQL(_database: string, schema: string, table: string): string {
    return `
SELECT
  'MS_Description' AS name,
  t.TABLE_COMMENT AS value,
  'SCHEMA' AS \`level0Type\`,
  ${this.quoteLiteral(schema)} AS \`level0Name\`,
  'TABLE' AS \`level1Type\`,
  ${this.quoteLiteral(table)} AS \`level1Name\`,
  NULL AS \`level2Type\`,
  NULL AS \`level2Name\`
FROM information_schema.TABLES t
WHERE t.TABLE_SCHEMA = ${this.quoteLiteral(schema)}
  AND t.TABLE_NAME = ${this.quoteLiteral(table)}
  AND t.TABLE_COMMENT IS NOT NULL AND t.TABLE_COMMENT != ''

UNION ALL

SELECT
  'MS_Description' AS name,
  c.COLUMN_COMMENT AS value,
  'SCHEMA' AS \`level0Type\`,
  ${this.quoteLiteral(schema)} AS \`level0Name\`,
  'TABLE' AS \`level1Type\`,
  ${this.quoteLiteral(table)} AS \`level1Name\`,
  'COLUMN' AS \`level2Type\`,
  c.COLUMN_NAME AS \`level2Name\`
FROM information_schema.COLUMNS c
WHERE c.TABLE_SCHEMA = ${this.quoteLiteral(schema)}
  AND c.TABLE_NAME = ${this.quoteLiteral(table)}
  AND c.COLUMN_COMMENT IS NOT NULL AND c.COLUMN_COMMENT != ''
ORDER BY \`level2Type\`, \`level2Name\`;`;
  }
}
