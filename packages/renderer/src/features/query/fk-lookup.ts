/**
 * Foreign-key resolution: everything the row inspector needs to get from "this cell holds 42"
 * to "here is the row it points at", with no React and no IPC in it.
 *
 * Ported from the FK half of `row-detail-panel.component.ts:1170-1307` — and it is a port with
 * three corrections, each of which was a real defect rather than a style difference:
 *
 *  1. **The SQL is dialect-correct.** Angular built `SELECT * FROM [schema].[table] WHERE [col] =
 *     N'…'` for every engine (`:1284`), and so does the main process's own `query.fetchFkRecord`
 *     handler (`main/src/ipc/query.ipc.ts:182`). Brackets and the `N''` prefix are T-SQL: against
 *     PostgreSQL or MySQL both are syntax errors, so FK navigation was MSSQL-only and silently
 *     broken on two of the three supported engines. Quoting goes through the same
 *     `quoteIdentifier`/`qualifiedTable` the explorer's context menus use, which is why this module
 *     imports from `shell/sidebar/sql-text` rather than growing a second escaping implementation —
 *     two of those is how one of them ends up wrong.
 *  2. **The metadata is fetched, not assumed.** A result set only carries `foreignKey` on its
 *     columns when the main process enriched it, and that enrichment lives in the MSSQL branch of
 *     the executor (`query-executor.ts:94-125`); `executePg` and `executeMySQL` build their columns
 *     from the driver's field list alone, with no PK and no FK. So on PostgreSQL every FK badge in
 *     the Angular inspector was missing — not wrong, absent. `parseSingleTableSelect` +
 *     `mergeEnrichedColumns` reproduce main's enrichment renderer-side, from
 *     `explorer.getEnrichedColumns`, which IS engine-aware (`metadata.ts:1085-1194`).
 *  3. **Values are quoted by type.** `formatFkValueForSql` stringified everything that was not a
 *     number or a boolean, so a `Date` reached SQL as `N'Mon Aug 11 2025 …'`. Dates go out as ISO,
 *     and MySQL's backslash escape — on by default, unlike PostgreSQL and SQL Server — is handled.
 *
 * The remaining wart is inherent to the seam: `query.execute` takes a SQL string, so the lookup is
 * a literal in generated SQL rather than a bound parameter. Every value that reaches it is escaped
 * here, by type, in one function, and `sqlLiteral` is the only thing in this renderer that
 * interpolates a value into SQL. Until `QueryRequest` grows a parameter slot (filed as a follow-up),
 * `sqlLiteral` is the security boundary for this feature and is written to be correct under any
 * server setting rather than under the default one — see its own comment.
 */

import type { ColumnMetadata, DatabaseEngine } from '@joinery/shared';
import type { JoineryAPI } from '@joinery/preload';

import { defaultSchema, qualifiedTable, quoteIdentifier } from '../../shell/sidebar/sql-text';

/**
 * One row of `explorer.getEnrichedColumns`.
 *
 * Derived from the preload declaration rather than re-typed: that member returns an 11-field
 * anonymous inline type no consumer can import by name (PLAN.md §7.2 — flagged, not redesigned),
 * and `Awaited<ReturnType<…>>[number]` is how a caller consumes it without copying its shape and
 * without the copy drifting.
 */
export type EnrichedColumn = Awaited<
  ReturnType<JoineryAPI['explorer']['getEnrichedColumns']>
>[number];

/** A schema-qualified table. `schema` is the engine's own notion of one — see `parseSingleTableSelect`. */
export interface TableRef {
  readonly schema: string;
  readonly table: string;
}

/** Where one FK value points, and the value itself. */
export interface FkTarget {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly value: unknown;
}

/**
 * The table a result set came from, or `null` when that cannot be answered honestly.
 *
 * Mirrors `query-executor.ts:674-722` (`parseSimpleSelect`) including its refusals, because FK
 * metadata attached to the wrong table is worse than no FK metadata: it would offer to follow a
 * link that does not exist. A JOIN, a UNION, an old-style comma join, a subquery in the `FROM`, a
 * three-part name and a multi-statement batch all yield `null`.
 *
 * Two refusals are load-bearing enough to be spelled out separately from the identifier alternation,
 * because the alternation alone did NOT enforce them: the select list is matched lazily, so
 * `SELECT * FROM (SELECT * FROM secret_t) x` slid past the derived table and named `secret_t` — the
 * columns of a derived table would then carry the *inner* table's keys and references. So a `FROM (`
 * anywhere is a refusal, and the `FROM` this function reads must be the FIRST one in the statement
 * (a `FROM` in the select list means a scalar subquery, i.e. a lazy match that ran past the real
 * one). PostgreSQL's inheritance-suppressing `FROM ONLY t` is refused for a different reason: `ONLY`
 * is a bare word and would be read as the table name.
 *
 * `database` decides the unqualified case for MySQL, which has no schema layer between database and
 * table — its `TABLE_SCHEMA` *is* the database, which is what `metadata.ts:1128-1131` queries and
 * what `query-executor.ts:710`'s comment records. PostgreSQL falls back to `public` and SQL Server
 * to `dbo`, i.e. `defaultSchema(engine)`.
 */
export function parseSingleTableSelect(
  sql: string,
  engine: DatabaseEngine,
  database: string
): TableRef | null {
  const normalized = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // More than one statement: which one produced the result set is not knowable from here.
  if (/;\s*\S/.test(normalized)) return null;
  if (/\bJOIN\b/i.test(normalized)) return null;
  if (/\bUNION\b/i.test(normalized)) return null;
  // A derived table (`FROM (SELECT …)`) — its columns are the subquery's, not any table's.
  if (/\bFROM\s*\(/i.test(normalized)) return null;
  // `FROM ONLY t`: `ONLY` parses as a bare identifier and would be named as the table.
  if (/\bFROM\s+ONLY\b/i.test(normalized)) return null;

  const match = FROM_TABLE.exec(normalized);
  if (match === null) return null;

  // The `FROM` that matched must be the statement's own, and there are two ways it may not be. The
  // list swallowed one (a lazy match that ran past the real `FROM`), or the list is left with an
  // unclosed `(` — which means the matched `FROM` is inside a parenthesis: a scalar subquery
  // (`SELECT (SELECT max(id) FROM audit_log) AS n, id FROM customers` named `audit_log`) or a
  // function that spells an argument with the keyword (`EXTRACT(month FROM created_at)`). Both are
  // refusals; the second is conservative — a `(` inside a string literal in the select list refuses
  // too — and a refusal is the safe direction.
  const selectList = match[1] ?? '';
  if (/\bFROM\b/i.test(selectList)) return null;
  if (countOf(selectList, '(') !== countOf(selectList, ')')) return null;

  const reference = match[2] ?? '';
  const rest = normalized.slice(match.index + match[0].length);
  // `FROM a, b` — the old-style join, with or without an alias on the first table.
  if (/^\s*(?:(?:AS\s+)?[\w$"`[\]]+\s*)?,/i.test(rest)) return null;

  const parts = splitIdentifierPath(reference);
  if (parts.length === 1) {
    const table = parts[0];
    if (table === undefined) return null;
    return { schema: engine === 'mysql' ? database : defaultSchema(engine), table };
  }
  if (parts.length === 2) {
    const [schema, table] = parts;
    if (schema === undefined || table === undefined) return null;
    return { schema, table };
  }
  // Three parts (`database.schema.table`) — refused, as main refuses it: the database in the name
  // may not be the one the connection is pointed at, and this seam cannot check.
  return null;
}

/**
 * One quoted-or-bare identifier. Every engine's quoting is accepted regardless of the engine,
 * because a mis-quoted identifier would not have executed in the first place — this parses SQL
 * that already ran.
 */
const IDENTIFIER = String.raw`(?:\[[^\]]+\]|` + '`[^`]+`' + String.raw`|"[^"]+"|[\w$]+)`;

/**
 * `SELECT <list> FROM <ident>[.<ident>[.<ident>]]`.
 *
 * The select list is matched lazily and may contain anything — `upper(name)`, a CASE expression, a
 * window function — because none of that changes which table the rows came from. It is CAPTURED
 * (group 1) precisely because "lazily" is not "minimally over the whole statement": the engine will
 * happily extend the list past the first `FROM` to make the rest of the pattern fit, so the caller
 * checks the captured list for a `FROM` and refuses when it finds one. Group 2 is the table.
 */
const FROM_TABLE = new RegExp(
  String.raw`^SELECT\s+(?:TOP\s+\d+\s+)?(?:DISTINCT\s+)?([\s\S]+?)\sFROM\s+(${IDENTIFIER}(?:\.${IDENTIFIER}){0,2})`,
  'i'
);

/** How many times `character` occurs in `text`. */
function countOf(text: string, character: string): number {
  let count = 0;
  for (const found of text) if (found === character) count += 1;
  return count;
}

/** Splits `a.b` into its parts and removes one layer of quoting from each. */
function splitIdentifierPath(reference: string): string[] {
  const parts = reference.match(new RegExp(IDENTIFIER, 'g')) ?? [];
  return parts.map(unquoteIdentifier);
}

/** `[a]` / `` `a` `` / `"a"` → `a`, with the delimiter's own doubling undone. */
export function unquoteIdentifier(identifier: string): string {
  if (identifier.startsWith('[') && identifier.endsWith(']')) {
    return identifier.slice(1, -1).replace(/]]/g, ']');
  }
  if (identifier.startsWith('`') && identifier.endsWith('`')) {
    return identifier.slice(1, -1).replace(/``/g, '`');
  }
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"');
  }
  return identifier;
}

/**
 * The result's columns, with the table's declared metadata folded in.
 *
 * The result set's own `type` WINS: it is what the driver said this column actually returned, and
 * the inspector's type line has to agree with the grid's formatting — which is built from the same
 * field. Everything the driver cannot know (keys, nullability, defaults, identity, length and
 * precision) comes from the enriched row. This is the same merge the MSSQL executor performs at
 * `query-executor.ts:178-189`, extended to the fields it drops on the floor.
 *
 * Matching is case-insensitive because that is how `query-executor.ts:107` keys its map, and
 * because PostgreSQL folds unquoted identifiers to lower case while the catalogue does not.
 *
 * Returns a NEW array and never mutates its input: `resultSet.columns` is the identity the grid's
 * `columnDefs` memo is keyed on, so writing through it would rebuild every column definition.
 */
export function mergeEnrichedColumns(
  columns: readonly ColumnMetadata[],
  enriched: readonly EnrichedColumn[]
): ColumnMetadata[] {
  const byName = new Map<string, EnrichedColumn>();
  for (const column of enriched) byName.set(column.name.toLowerCase(), column);

  return columns.map(column => {
    const match = byName.get(column.name.toLowerCase());
    if (match === undefined) return column;
    return {
      ...column,
      nullable: match.nullable,
      maxLength: match.maxLength ?? undefined,
      precision: match.precision ?? undefined,
      scale: match.scale ?? undefined,
      isPrimaryKey: match.isPrimaryKey,
      isIdentity: match.isIdentity,
      defaultValue: match.defaultValue ?? undefined,
      foreignKey: match.foreignKey ?? undefined,
    };
  });
}

/**
 * A value as a SQL literal for `engine`.
 *
 * The one place in this renderer that interpolates a value into SQL, so every rule is here:
 *
 *  - `NULL` for absent values and for non-finite numbers (`NaN`/`Infinity` have no literal);
 *  - numbers and bigints verbatim;
 *  - booleans as `TRUE`/`FALSE` on PostgreSQL, `1`/`0` elsewhere — MySQL accepts both and SQL
 *    Server has no boolean literal at all;
 *  - `Date` as its ISO string, quoted. Angular's `String(value)` produced `Mon Aug 11 2025 …`,
 *    which no engine parses;
 *  - everything else stringified (objects as JSON) and quoted, with the closing quote doubled —
 *    plus **backslash doubling on MySQL and PostgreSQL**, the two engines where a backslash can be
 *    an escape character;
 *  - `N''` on SQL Server only, where it is what makes the literal Unicode.
 *
 * **Why PostgreSQL gets `E''` rather than a plain quoted string.** Whether `\` escapes inside an
 * ordinary literal is a *server setting*: `standard_conforming_strings` defaults to `on` (so `\` is
 * data), but it is settable per database and per role, so a hostile — or merely legacy — database
 * owner can turn it off underneath us. With it off, quote-doubling alone is not an escape: the value
 * `\'; DROP TABLE t; --` becomes `'\''; DROP TABLE t; --'`, where `\'` is an escaped quote, the
 * following `'` OPENS a new literal, and the statement terminator lands outside it. node-postgres
 * sends this through the simple query protocol, which executes multiple statements per message, so
 * the injected statement runs. `E'…'` is escape-string syntax in every configuration, which makes
 * the escaping setting-independent: double the backslashes AND the quotes and the value is data
 * whatever the server is set to. (Refusing values containing backslashes would also be safe, but it
 * would break the preview for ordinary data — a Windows path in a text column.)
 *
 * MySQL's mirror-image setting, `NO_BACKSLASH_ESCAPES`, is NOT a security hole here: with it on, the
 * doubled backslash is two literal backslashes, so a lookup finds no row (or the wrong one) — data
 * wrong, never a second statement, because quote-doubling is an escape in both modes and so the
 * value cannot get out of the literal. Asserted in the spec so the trade-off is recorded rather
 * than assumed.
 *
 * The old wording here added "and mysql2 does not multiplex statements". That was false when it was
 * written (both of Joinery's MySQL pools were opened `multipleStatements: true`) and it is the wrong
 * thing to lean on now: mysql2 multiplexes whenever the connection negotiated
 * `CLIENT_MULTI_STATEMENTS`, which is a per-pool decision. J-137 made that decision explicit —
 * `main/services/sql/mysql-pool-options.ts` opens a `'restricted'` pool without the flag for
 * metadata, the AI tools and this FK lookup, and a `'script'` pool with it for the query editor.
 * This preview text is executed through the FETCH_FK_RECORD handler, which runs on the restricted
 * pool, so a second statement here is not merely un-writable but unparseable. The escaping above is
 * still what has to hold: the same `sqlLiteral` output is also shown to the user and can be pasted
 * into the editor, which does run on the multi-statement pool.
 */
export function sqlLiteral(value: unknown, engine: DatabaseEngine): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') {
    if (engine === 'postgresql') return value ? 'TRUE' : 'FALSE';
    return value ? '1' : '0';
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "''");
  switch (engine) {
    case 'postgresql':
      return `E'${escaped}'`;
    case 'mysql':
      return `'${escaped}'`;
    case 'mssql':
      // T-SQL has no backslash escape in any configuration, so the doubling above would turn one
      // backslash in the data into two in the predicate.
      return `N'${text.replace(/'/g, "''")}'`;
  }
}

/**
 * The referenced table as it must be written for `engine`, given the database the query runs
 * against.
 *
 * `qualifiedTable` drops the schema on MySQL, which is right for the explorer (its `schema` slot is
 * the database the tree is already inside) and wrong for a foreign key: an FK's
 * `referencedSchema` **is the referenced database** (`metadata.ts` reads MySQL FKs out of
 * `REFERENTIAL_CONSTRAINTS`, whose `UNIQUE_CONSTRAINT_SCHEMA` is a database name), and MySQL permits
 * a constraint across databases. Dropping it sent the lookup to a same-named table in the connected
 * database, or to no table at all. So on MySQL the reference is qualified whenever the referenced
 * database differs from the connected one, and left bare when it does not — a bare name is what
 * every same-database lookup, i.e. nearly all of them, keeps reading as.
 */
function fkTableRef(target: FkTarget, engine: DatabaseEngine, database: string): string {
  if (engine === 'mysql' && target.schema !== '' && target.schema !== database) {
    return `${quoteIdentifier(target.schema, engine)}.${quoteIdentifier(target.table, engine)}`;
  }
  return qualifiedTable(target.schema, target.table, engine);
}

/**
 * The single-row lookup for one FK value.
 *
 * `TOP 1` before the select list on SQL Server, `LIMIT 1` after the predicate elsewhere — the same
 * split `selectWithLimit` makes, spelled out here because that helper has no room for a `WHERE`.
 *
 * `database` is the database the query will execute against; it only changes the SQL on MySQL — see
 * `fkTableRef` — but it is required rather than optional so no caller can forget it on the one engine
 * where forgetting it reads the wrong table.
 */
export function fkLookupSql(target: FkTarget, engine: DatabaseEngine, database: string): string {
  const table = fkTableRef(target, engine, database);
  const column = quoteIdentifier(target.column, engine);
  const predicate = `${column} = ${sqlLiteral(target.value, engine)}`;
  if (engine === 'mssql') return `SELECT TOP 1 * FROM ${table} WHERE ${predicate}`;
  return `SELECT * FROM ${table} WHERE ${predicate} LIMIT 1`;
}

/**
 * The query a "open the referenced row in a new tab" action runs: the same lookup without the
 * single-row cap, because a tab is where a user goes to explore rather than to peek.
 */
export function fkOpenSql(target: FkTarget, engine: DatabaseEngine, database: string): string {
  const table = fkTableRef(target, engine, database);
  const column = quoteIdentifier(target.column, engine);
  return `SELECT *\nFROM ${table}\nWHERE ${column} = ${sqlLiteral(target.value, engine)}`;
}

/** That tab's title: the table and the value, both short enough for a tab header (`:1285`). */
export function fkTabTitle(target: FkTarget): string {
  return `${target.table} · ${truncate(displayValue(target.value), 24)}`;
}

/** A value as one short line of text. Used by the tab title and the FK field's own label. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** `…`-suffixed truncation. Never returns more than `maxLength` + 1 characters. */
export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** Does this column point somewhere, and does this row have a value to follow? */
export function fkTargetFor(column: ColumnMetadata, value: unknown): FkTarget | null {
  const reference = column.foreignKey;
  if (reference === undefined) return null;
  if (value === null || value === undefined) return null;
  return {
    schema: reference.referencedSchema,
    table: reference.referencedTable,
    column: reference.referencedColumn,
    value,
  };
}
