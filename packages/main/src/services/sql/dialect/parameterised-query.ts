/**
 * A SQL statement and the values to bind to it (J-135).
 *
 * Every metadata query in the dialect layer returns one of these instead of a bare string. The
 * shape is the point: a bound value reaches the server out of band and is never lexed as SQL, so
 * it cannot close a literal or start a statement — on any engine, under any server setting. That
 * removes the escaping question from the whole metadata surface rather than answering it per
 * engine, which is what J-134 had to do while the names still travelled inside the SQL text.
 *
 * `SQLDialect.quoteLiteral` survives for the paths that cannot bind: identifiers, and the DDL
 * builders where a name is part of the statement rather than a value in it.
 */

/** A SQL statement with the values to bind to it, in positional order. */
export interface ParameterisedQuery {
  readonly sql: string;
  readonly params: readonly string[];
}

/**
 * How an engine spells its bind placeholders.
 *
 *  - `dollar`   — PostgreSQL: `$1`, `$2`, … numbered, and one may be repeated.
 *  - `question` — MySQL: `?`, positional; each occurrence consumes the next value.
 *  - `at`       — SQL Server: `@p0`, `@p1`, … the names
 *                 `ConnectionPoolManager.queryWithParams` binds its inputs to.
 */
export type PlaceholderStyle = 'dollar' | 'question' | 'at';

/** The placeholder for the `ordinal`-th bound value, counting from one. */
export function placeholderFor(style: PlaceholderStyle, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`placeholderFor: ordinal must be a 1-based integer, got ${ordinal}`);
  }

  if (style === 'dollar') return `$${ordinal}`;
  if (style === 'question') return '?';
  return `@p${ordinal - 1}`;
}

/**
 * The values a query builder is binding, and the placeholders that stand for them.
 *
 * Usage is one `bind()` call per placeholder occurrence, never one per distinct value:
 *
 * ```ts
 * const values = this.bindings();
 * return values.query(`WHERE s = ${values.bind(schema)} AND t = ${values.bind(table)}`);
 * ```
 *
 * PostgreSQL would let a builder reuse `$1` for a name it names twice, but MySQL's `?` is
 * positional — reusing it there consumes the next value and shifts every later one along by
 * one. Binding per occurrence is the rule that is correct on both, so it is the only rule.
 * Template-literal expressions evaluate left to right, so the order the placeholders appear in
 * the SQL is the order they were bound.
 */
export class BoundValues {
  private readonly values: string[] = [];

  constructor(private readonly style: PlaceholderStyle) {}

  /** Bind `value` and return the placeholder that stands for it. */
  bind(value: string): string {
    if (typeof value !== 'string') {
      throw new Error(`BoundValues.bind: value must be a string, got ${typeof value}`);
    }

    this.values.push(value);
    return placeholderFor(this.style, this.values.length);
  }

  /** Pair `sql` with the values bound so far. The values are copied, not shared. */
  query(sql: string): ParameterisedQuery {
    return { sql, params: [...this.values] };
  }
}

/** SQL that carries no bound values — the engines and paths where nothing is interpolated. */
export function unboundQuery(sql: string): ParameterisedQuery {
  return { sql, params: [] };
}

/**
 * A value every driver here can bind directly.
 *
 * `Date` is in the list on purpose: node-pg, mysql2 and tedious each serialise one into their own
 * engine's datetime form, and an ISO string would not survive that trip on MySQL, which does not
 * parse the `T`/`Z` shape.
 */
export type BindableValue = string | number | boolean | Date | null;

/**
 * A statement whose values are BOUND rather than written into it (J-145).
 *
 * Distinct from `ParameterisedQuery`, whose params are `string[]` because the metadata surface
 * only ever binds names. This one carries a result-set cell, which is any JavaScript value a
 * driver handed back, so its params are typed as what a driver will take.
 */
export interface ValueBoundQuery {
  readonly sql: string;
  readonly params: readonly BindableValue[];
}

/**
 * A result-set cell as something a driver will bind.
 *
 * The type rules are `SQLDialect.formatLiteral`'s, which this replaces — minus the escaping, which
 * is the point: nothing here produces SQL text. What is left is the handful of JavaScript values no
 * driver can bind as itself:
 *
 *  - `null`/`undefined` and non-finite numbers have no literal on any engine, so they go as NULL
 *    (a predicate against NULL matches nothing, which is the honest answer for a cell that holds
 *    no value — and `fkTargetFor` in the renderer refuses to offer a link on one anyway);
 *  - a `bigint` is outside every driver's number binding, so it goes as its digits. All three
 *    engines coerce a string to the column's numeric type for a comparison;
 *  - an object — a JSON or JSONB column's value — goes as its JSON text, which is what
 *    `formatLiteral` wrote into the SQL before.
 */
export function bindableValue(value: unknown): BindableValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
