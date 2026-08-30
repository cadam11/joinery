/**
 * Aurora DSQL Dialect (PostgreSQL 16-compatible variant)
 *
 * DSQL hosts a single database named `postgres` and omits many system
 * catalogs (pg_database, pg_proc, pg_trigger, all pg_stat_* views) and
 * size functions. This dialect overrides exactly the queries that touch
 * unsupported surfaces; everything else inherits from PgDialect.
 * Reference: AWS "System tables and commands in Aurora DSQL".
 */

import type {
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
  EngineVariant,
} from '@joinery/shared';
import { PgDialect } from './pg-dialect';

export class PgDsqlDialect extends PgDialect {
  override readonly label: string = 'Aurora DSQL';

  override get variant(): EngineVariant {
    return 'dsql';
  }

  override get supportsMultipleDatabases(): boolean {
    return false;
  }

  override get supportsDatabaseManagement(): boolean {
    return false;
  }

  override get supportsStoredProcedures(): boolean {
    return false;
  }

  override get supportsTriggers(): boolean {
    return false;
  }

  override get supportsBackupTooling(): boolean {
    return false;
  }

  // ── Database DDL: a DSQL cluster hosts exactly one database ──

  override createDatabaseSQL(_options: CreateDatabaseOptions): string {
    throw new Error(
      'Aurora DSQL clusters host a single database; CREATE DATABASE is not supported.'
    );
  }

  override renameDatabaseSQL(_options: RenameDatabaseOptions): string {
    throw new Error('Aurora DSQL clusters host a single database; renaming is not supported.');
  }

  override dropDatabaseSQL(_options: DeleteDatabaseOptions): string {
    throw new Error('Aurora DSQL clusters host a single database; DROP DATABASE is not supported.');
  }

  // ── Metadata queries ─────────────────────────────────────────

  /** pg_database is unsupported; the only database is the current one. */
  override listDatabasesSQL(_isAzure?: boolean): string {
    return `
SELECT
  current_database() AS name,
  NULL AS "databaseId",
  NULL AS "sizeBytes",
  'online' AS state,
  'C' AS collation,
  false AS "isSystemDb",
  NULL AS "createdAt";`;
  }

  /** pg_stat_user_tables and pg_relation_size are unsupported; use reltuples. */
  override listTablesSQL(_database: string, schema?: string): string {
    const schemaFilter = schema
      ? `AND t.schemaname = ${this.quoteLiteral(schema)}`
      : `AND t.schemaname NOT IN ('pg_catalog', 'information_schema')`;
    return `
SELECT
  t.schemaname AS schema,
  t.tablename AS name,
  COALESCE(c.reltuples, 0)::bigint AS "rowCount",
  NULL AS "sizeKb",
  NULL AS "createdAt"
FROM pg_tables t
LEFT JOIN pg_class c ON c.relname = t.tablename
  AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.schemaname)
WHERE true
  ${schemaFilter}
ORDER BY t.schemaname, t.tablename;`;
  }

  /** pg_proc is unsupported — return an empty, correctly-shaped result. */
  override listProceduresSQL(_database: string, _schema?: string): string {
    return `
SELECT NULL::text AS schema, NULL::text AS name,
  NULL::text AS "createdAt", NULL::text AS "modifiedAt"
WHERE false;`;
  }

  override listFunctionsSQL(_database: string, _schema?: string): string {
    return `
SELECT NULL::text AS schema, NULL::text AS name, NULL::text AS type,
  NULL::text AS "createdAt", NULL::text AS "modifiedAt"
WHERE false;`;
  }

  /** pg_trigger is unsupported and DSQL has no triggers. */
  override listTriggersSQL(_database: string, _schema: string, _table: string): string {
    return `
SELECT NULL::text AS name, NULL::boolean AS "isDisabled",
  NULL::text AS "triggerType", NULL::text AS "createdAt"
WHERE false;`;
  }

  /** pg_get_functiondef/pg_proc are unsupported — resolve views only. */
  override getObjectDefinitionSQL(_database: string, schema: string, name: string): string {
    return `
SELECT (
  SELECT definition FROM pg_views
  WHERE schemaname = ${this.quoteLiteral(schema)}
    AND viewname = ${this.quoteLiteral(name)}
) AS definition;`;
  }
}
