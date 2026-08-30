/**
 * The two top-level table-properties queries for PostgreSQL.
 *
 * They live here rather than on `MetadataService` because they are pure builders with no
 * dependence on a pool or a connection, and because the escaping was the interesting part: on the
 * class they escaped with `escId`, which doubles `]` — a T-SQL *identifier* escape — inside a
 * PostgreSQL *string literal*, so a quote in a schema or table name passed straight through and
 * closed the literal. Both names arrive from the renderer over `explorer.ipc.ts`.
 *
 * J-134 moved them onto the dialect's engine-correct escape. J-135 takes the names out of the SQL
 * text altogether: they are bound, so `MetadataService.queryAny` sends them over node-pg's
 * extended query protocol, which cannot carry a second statement at all.
 */

import { BoundValues, type ParameterisedQuery } from './dialect/parameterised-query';

/** Both queries are PostgreSQL, so both number their placeholders. */
function bindings(): BoundValues {
  return new BoundValues('dollar');
}

/**
 * Standard PostgreSQL top-level table properties query (pg_class/pg_namespace
 * joined with pg_stat_user_tables for live row counts and the pg_*_size
 * functions for storage sizes).
 */
export function tablePropertiesPgStandardQuery(schema: string, table: string): ParameterisedQuery {
  const values = bindings();
  return values.query(`
SELECT
  n.nspname AS schema,
  c.relname AS name,
  c.oid AS "objectId",
  NULL AS "createdAt",
  NULL AS "modifiedAt",
  COALESCE(s.n_live_tup, 0) AS "rowCount",
  pg_relation_size(c.oid) / 1024 AS "dataSpaceKb",
  pg_indexes_size(c.oid) / 1024 AS "indexSpaceKb",
  0 AS "unusedSpaceKb",
  pg_total_relation_size(c.oid) / 1024 AS "totalSpaceKb",
  EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attidentity != '') AS "hasIdentity",
  (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attidentity != '' LIMIT 1) AS "identityColumn",
  false AS "isReplicated",
  false AS "hasTextImage",
  ts.spcname AS filegroup
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
LEFT JOIN pg_tablespace ts ON c.reltablespace = ts.oid
WHERE n.nspname = ${values.bind(schema)}
  AND c.relname = ${values.bind(table)};`);
}

/**
 * Aurora DSQL variant of the top-level table properties query. DSQL doesn't
 * support the pg_*_size functions or pg_stat_user_tables, so size fields
 * come back NULL and the row count is the pg_class.reltuples estimate
 * instead of the live-tuple stat. Column aliases match the standard query
 * so the caller's mapping works unchanged for both engines.
 */
export function tablePropertiesPgDsqlQuery(schema: string, table: string): ParameterisedQuery {
  const values = bindings();
  return values.query(`
SELECT
  n.nspname AS schema,
  c.relname AS name,
  c.oid AS "objectId",
  NULL AS "createdAt",
  NULL AS "modifiedAt",
  COALESCE(c.reltuples, 0) AS "rowCount",
  NULL AS "dataSpaceKb",
  NULL AS "indexSpaceKb",
  NULL AS "unusedSpaceKb",
  NULL AS "totalSpaceKb",
  EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attidentity != '') AS "hasIdentity",
  (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attidentity != '' LIMIT 1) AS "identityColumn",
  false AS "isReplicated",
  false AS "hasTextImage",
  ts.spcname AS filegroup
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
LEFT JOIN pg_tablespace ts ON c.reltablespace = ts.oid
WHERE n.nspname = ${values.bind(schema)}
  AND c.relname = ${values.bind(table)};`);
}
