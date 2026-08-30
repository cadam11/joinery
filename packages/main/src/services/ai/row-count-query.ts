/**
 * The approximate-row-count query behind the AI `get_table_row_count` tool.
 *
 * Split out of `tool-registry.ts` (J-136) so it is a pure function that can be
 * asserted on without a pool: the schema and table it is given come straight
 * out of an LLM tool call, and the model's context includes text it has read
 * out of the user's database, so these are the least trustworthy strings in
 * the main process.
 *
 * Both values are returned as bound parameters, never interpolated. The
 * previous implementation inlined them after a local `.replace(/'/g, "''")`,
 * which is an injection on MySQL (backslash is an escape character unless
 * `NO_BACKSLASH_ESCAPES` is set, and it is off by default) and on PostgreSQL
 * whenever `standard_conforming_strings` is off. Binding removes the question:
 * a bound value is never lexed as SQL, on any engine, under any setting.
 *
 * Placeholder syntax matches how `ToolRegistry.queryAnyWithParams` executes
 * each engine: `?` for mysql2's `execute`, `$n` for node-pg, and `@pN` for
 * `ConnectionPoolManager.queryWithParams`, which names its inputs by index.
 */

import type { DatabaseEngine } from '@joinery/shared';

/** A SQL statement with the values to bind to it, in positional order. */
export interface ParameterisedQuery {
  sql: string;
  params: string[];
}

/**
 * Build the row-count query for one table on one engine.
 *
 * @throws if `schema` or `table` is not a string — the arguments arrive as
 * untyped JSON from a tool call, and a non-string here would otherwise be
 * coerced into the parameter list and surprise the driver.
 */
export function buildRowCountQuery(
  engine: DatabaseEngine,
  schema: string,
  table: string
): ParameterisedQuery {
  if (typeof schema !== 'string') {
    throw new Error(`get_table_row_count: schema must be a string, got ${typeof schema}`);
  }
  if (typeof table !== 'string') {
    throw new Error(`get_table_row_count: table must be a string, got ${typeof table}`);
  }

  return { sql: rowCountSql(engine), params: [schema, table] };
}

function rowCountSql(engine: DatabaseEngine): string {
  if (engine === 'mysql') {
    return `SELECT TABLE_ROWS AS row_count FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`;
  }

  if (engine === 'postgresql') {
    // pg_class.reltuples works on both standard PostgreSQL and Aurora
    // DSQL (which lacks pg_stat_user_tables), and is the AWS-recommended
    // way to approximate row counts without a full scan.
    return `SELECT COALESCE(c.reltuples, 0)::bigint AS row_count
                 FROM pg_class c
                 JOIN pg_namespace n ON c.relnamespace = n.oid
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`;
  }

  return `SELECT SUM(p.rows) AS row_count FROM sys.partitions p
                 JOIN sys.tables t ON p.object_id = t.object_id
                 JOIN sys.schemas s ON t.schema_id = s.schema_id
                 WHERE s.name = @p0 AND t.name = @p1 AND p.index_id IN (0, 1)`;
}
