/**
 * One statement, its values bound, on whichever engine the connection speaks.
 *
 * Extracted from `MetadataService.queryAny` (J-135) when a second caller appeared: J-145's
 * foreign-key lookup, whose bound value is a result-set cell rather than a catalogue name. The
 * engine dispatch is the part worth having exactly once — each arm has to reach the call that
 * genuinely BINDS, and each of those is spelled differently:
 *
 *  - **PostgreSQL** — `query(sql, values)`, node-pg's extended query protocol. A statement carrying
 *    a value is prepared server-side, and PostgreSQL refuses to prepare more than one command, so a
 *    bound statement is structurally single-statement whatever the values contain. Note the empty
 *    case: `query(sql, [])` is sent over the SIMPLE protocol (node-pg's `requiresPreparation()` is
 *    `values.length > 0`), which does execute multiple commands — which is why the branch below is
 *    on `params.length` rather than on the array's presence.
 *  - **MySQL** — `execute(sql, values)`, a server-side prepared statement, which rejects a stacked
 *    statement with `ER_PARSE_ERROR` even on a connection that negotiated `CLIENT_MULTI_STATEMENTS`.
 *    The pool asked for is the **restricted** one either way (J-137): a second statement is not
 *    expressible on it, which is defence in depth behind the binding rather than the fix itself.
 *  - **SQL Server** — `ConnectionPoolManager.queryWithParams`, which is `request.query()` with real
 *    `sp_executesql` bind values. `request.batch()` with parameters would INLINE them instead; see
 *    that method's comment.
 *
 * A query carrying no values stays on the call it used before this existed, so nothing about the
 * unbound metadata statements changed when they moved here.
 */

import type { ConnectionPoolManager } from './connection-pool';
import type { BindableValue } from './dialect/parameterised-query';

/** The pool-routing surface a bound query needs. Named so a test double states what it must have. */
export type BoundQueryPools = Pick<
  ConnectionPoolManager,
  'getEngineForProfile' | 'getPgPool' | 'getMySQLPool' | 'query' | 'queryWithParams'
>;

/**
 * A statement and the values to bind to it.
 *
 * `BindableValue` is the intersection of what all three drivers accept — mysql2's `ExecuteValues`
 * is the narrowest of them — so a caller that has not converted its values cannot reach the pool.
 * `ParameterisedQuery`'s `readonly string[]` satisfies it, which is why the metadata surface passes
 * straight through.
 */
export interface BoundStatement {
  readonly sql: string;
  readonly params: readonly BindableValue[];
}

/**
 * Run `statement` on `connectionId`, binding its values, and return the rows.
 *
 * The caller owns the SQL: this makes no routing decision beyond the engine and binds nothing it
 * was not given.
 */
export async function runBoundQuery<T>(
  pools: BoundQueryPools,
  connectionId: string,
  statement: BoundStatement,
  database?: string
): Promise<T[]> {
  const engine = pools.getEngineForProfile(connectionId);
  const params = [...statement.params];

  if (engine === 'postgresql') {
    const pool = await pools.getPgPool(connectionId, database);
    const result = params.length
      ? await pool.query(statement.sql, params)
      : await pool.query(statement.sql);
    return result.rows as T[];
  }

  if (engine === 'mysql') {
    const pool = await pools.getMySQLPool(connectionId, database, 'restricted');
    const [rows] = params.length
      ? await pool.execute(statement.sql, params)
      : await pool.query(statement.sql);
    return rows as T[];
  }

  // Default: SQL Server
  const result = params.length
    ? await pools.queryWithParams<T>(connectionId, statement.sql, params, database)
    : await pools.query<T>(connectionId, statement.sql, database);
  return result.recordset;
}
