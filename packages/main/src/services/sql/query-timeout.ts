/**
 * The per-query deadline behind `QueryRequest.timeout` — the `Query ▸ Query timeout` setting,
 * which until J-54 was written by the settings panel and read by nobody.
 *
 * ## Why Joinery enforces it rather than each driver
 *
 * Only two of the three drivers take a per-query deadline at all, and neither of those two
 * leaves the connection fit to reuse afterwards:
 *
 * - **mssql cannot.** `mssql/lib/tedious/request.js:444` builds `new tds.Request(command, cb)`
 *   and never sets tedious's per-request `timeout`, which tedious would otherwise prefer over
 *   the connection's (`tedious/lib/connection.js:1191`). So the only deadline mssql honours is
 *   the pool's `config.requestTimeout` (`mssql/lib/tedious/connection-pool.js:42`) — i.e. the
 *   connection profile's, for every query on it.
 * - **pg can** (`config.query_timeout`, `pg/lib/client.js:702`) but only destroys the socket for
 *   an already-sent query while pipelining (`pg/lib/client.js:719-727`); otherwise it errors the
 *   query and hands a client with a response still inbound back to the pool.
 * - **mysql2 can** (`Query.timeout`, `mysql2/lib/commands/query.js:30,342-356`) and raises a
 *   fatal `PROTOCOL_SEQUENCE_TIMEOUT` on a connection whose result is still pending.
 *
 * All three therefore need Joinery to abort the connection itself, so all three use one
 * mechanism: race the driver call against a timer, and let the caller say how its engine aborts.
 * One error message, one place to test it.
 *
 * ## Precedence against the profile's own `requestTimeout`: whichever is shorter
 *
 * Nothing computes that — it falls out of the layering, which is the reason to prefer it. The
 * pool keeps enforcing the profile's timeout (`connection-pool.ts:634,651,821`) and this adds
 * the per-query bound on top, so a query stops at the first of the two to fire. MySQL pools
 * carry no request timeout at all (`mysql-pool-options.ts` sets only `connectTimeout`), so
 * there this setting is the only deadline a query has ever had.
 */

import { createLogger } from '../../utils/logger';

const log = createLogger('QueryTimeout');

/** Node coerces a longer delay to 1ms, which would time every query out instantly. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The effective per-query timeout in milliseconds, or `undefined` to leave the pool's own
 * timeout as the only deadline.
 *
 * `QueryRequest` crosses IPC from the renderer, so this is a trust boundary: anything that is
 * not a positive finite duration is refused rather than handed to `setTimeout`.
 */
export function resolveQueryTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.min(Math.round(timeout), MAX_TIMEOUT_MS);
}

export class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    const seconds = (timeoutMs / 1000).toFixed(timeoutMs % 1000 === 0 ? 0 : 1);
    super(`Query timed out after ${seconds}s (the Query timeout setting, or this connection's).`);
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Run `work` under a deadline, calling `abort` and rejecting with `QueryTimeoutError` if it
 * has not settled in time. An `undefined` timeout runs `work` unguarded.
 *
 * `abort` is how the caller's engine stops the query and disowns the connection — an mssql
 * attention packet, a destroyed mysql2 connection, a pg client marked for destruction on
 * release. It is handed the error so a caller that has to store it need not rebuild it.
 */
export async function withQueryTimeout<T>(
  timeoutMs: number | undefined,
  abort: (error: QueryTimeoutError) => void,
  work: () => Promise<T>
): Promise<T> {
  if (timeoutMs === undefined) return work();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`withQueryTimeout: timeoutMs must be a positive duration, got ${timeoutMs}`);
  }

  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = new QueryTimeoutError(timeoutMs);
      try {
        abort(error);
      } catch (abortFailure) {
        // The deadline stands either way — the caller still learns the query timed out. A
        // connection that could not be aborted is the part only the log can carry.
        log.error(`Failed to abort a query that hit its ${timeoutMs}ms timeout:`, abortFailure);
      }
      reject(error);
    }, timeoutMs);
  });

  try {
    // Promise.race attaches a rejection handler to both inputs, so the loser settling later is
    // not an unhandled rejection.
    return await Promise.race([work(), deadline]);
  } catch (error) {
    // `abort` runs before the reject above, and an abort that rejects the driver's promise
    // synchronously (mssql's `Request.cancel()` calls its batch callback with `Canceled.`)
    // would otherwise win the race and report a user cancellation for what was a timeout.
    if (expired) throw new QueryTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
