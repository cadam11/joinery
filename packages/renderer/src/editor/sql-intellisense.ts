/**
 * SQL IntelliSense: the completion provider, the AI ghost-text provider, and the metadata cache
 * behind both.
 *
 * **Ported near-verbatim from `packages/renderer/src/app/core/services/sql-intellisense.service.ts`
 * (768 LOC), as PLAN.md §1.6 requires.** Every keyword, every snippet, every `sortText`, every
 * context-detection regex and the whole ghost-text prompt were byte-identical to the Angular original
 * — until J-138 split the T-SQL half of that out per engine; see the section at the end of this
 * comment for exactly what moved and why.
 * The completion-KIND numbers are the exception and are corrected — see `COMPLETION_ITEM_KIND` below,
 * which explains all five and the spec that pins them. What else changed is only the seams that cannot
 * survive the move:
 *
 *  - Angular DI (`inject(ConnectionStateService)`, `inject(AIStateService)`, `inject(IpcService)`)
 *    becomes an explicit `IntellisenseDeps` object, passed in by the one caller. That is the "narrow
 *    your state" rule from CLAUDE.md applied to a class that reached for three global services;
 *  - `firstValueFrom(this.ipc.getExplorerChildren(…))` becomes `deps.getExplorerChildren(…)`, i.e. a
 *    promise instead of an Observable — the store layer already exposes the bridge that way;
 *  - the class becomes a factory returning a closed-over object, because there is no DI container to
 *    make a singleton of it and a per-editor instance is what the caller wants anyway;
 *  - `console.error` becomes `diagnostics.error`, so a failed metadata load lands in the Output panel
 *    instead of a devtools console nobody has open.
 *
 * ── Three things the port deliberately CHANGES, all recorded in the task report ──────────────
 *
 * **1. The rich completion provider is now wired.** In the Angular app the only entry point anything
 * ever called was `registerGhostTextProvider` (`query.component.ts:1490` — the single call site in
 * the whole renderer). `registerCompletionProvider`, `getContextAwareCompletions`,
 * `getColumnCompletionsWithAlias` and `loadMetadata` had **no callers at all**, and the query
 * component instead registered its own 40-line inline provider (`query.component.ts:1390-1485`) that
 * offered keywords and table names with no context awareness. So the better provider existed, fully
 * written, and was dead. This port registers the real one and drops the inline duplicate; the keyword
 * list the inline provider carried is a strict subset of `SHARED_KEYWORDS` below.
 *
 * **2. `getContextAwareCompletions` is the provider body.** The dead `registerCompletionProvider`
 * called the weaker `isAfterDot` → `getColumnCompletions` path, which cannot resolve an alias, while
 * `getContextAwareCompletions` — also dead — handles aliases AND the WHERE-clause case. Registering
 * the weaker one to be "verbatim" would have been faithful to the letter and useless: two dead
 * functions, one of which is a superset of the other, means the author's intent is the superset. The
 * regexes, ranges and sort orders are unchanged either way.
 *
 * **3. The completion-kind numbers are Monaco's, not the original's.** Five of the eight were wrong;
 * two of those five decide a glyph a user sees on every completion list. `COMPLETION_ITEM_KIND` below
 * has the table, the reason for each, and the spec that pins each number to the enum member it names.
 *
 * **What is NOT fixed here:** the Angular original populates `tablesCache` only — `viewsCache`,
 * `proceduresCache` and `functionsCache` are declared, read by three completion producers, and never
 * written, so view and procedure completions were always empty. `loadMetadata` now fills views and
 * procedures too (capability-gated, exactly as the query component's own prefetch was), because a
 * provider that is now LIVE and returns nothing for `FROM ` is a defect a user sees. `functionsCache`
 * has no reader and is dropped rather than carried forward as a fourth empty map.
 *
 * ── J-138: the provider is engine-aware ─────────────────────────────────────────────────────
 *
 * Everything above was T-SQL, because the Angular original was written against SQL Server and
 * `IntellisenseTarget` carried no engine for anything downstream to branch on. A PostgreSQL user was
 * handed `[public].[customers]`, `SELECT TOP`, `BEGIN TRY`, `GETDATE` and `CHARINDEX`; a MySQL user
 * got the same, plus a two-part `schema.table` naming something MySQL has no concept of. Four things
 * changed, and nothing else:
 *
 *  - `IntellisenseTarget` carries `engine`, resolved per request from the active tab's connection
 *    profile (`intellisense.ts:activeTabTarget`). `null` — no connection, or a profile not yet
 *    loaded — falls back to `mssql`, the same fallback `sql-dialect.ts:21-25` makes for the tokenizer;
 *  - every `insertText` is quoted by `quoteIdentifier`/`qualifiedTable`
 *    (`shell/sidebar/sql-text.ts:28-48`) — the same functions the explorer's context menus use, so
 *    the two surfaces cannot drift and MySQL's missing schema layer is handled in one place;
 *  - `SQL_KEYWORDS` and `SQL_SNIPPETS` are a shared set plus a per-engine set, and the procedure
 *    branch fires on `CALL` for PostgreSQL and MySQL rather than only on T-SQL's `EXEC`;
 *  - the two identifier regexes accept `"` and `` ` `` alongside `[`/`]`, so a quoted name resolves
 *    to a table on every engine instead of only on SQL Server.
 *
 * The ghost-text prompt still says nothing about the dialect. That is J-139, deliberately not here.
 */

import type * as monaco from 'monaco-editor/editor/editor.api.js';
import type { ColumnInfo, DatabaseEngine, ObjectMetadata } from '@joinery/shared';
import { qualifiedTable, quoteIdentifier } from '../shell/sidebar/sql-text';
import { diagnostics } from '../state/diagnostics';

/**
 * Monaco completion-item kinds, as NUMBERS — **corrected against Monaco's own enum, which is this
 * port's one deliberate divergence from the Angular original's numbers.**
 *
 * The Angular table (`sql-intellisense.service.ts:84-93`) is wrong in five of its eight entries: four
 * uniformly one too high, and one — `Snippet` — one too low against the version this package pins. It
 * shipped that way, so the wrong glyph is what a user of the Angular app sees. The first pass of this
 * port carried the numbers forward to keep the diff readable and recorded a follow-up; this is that
 * follow-up, applied. What each name selects, against `monaco.languages.CompletionItemKind`:
 *
 *   | name      | Angular | here | why                                                       |
 *   | Keyword   |      17 |   17 | already right                                             |
 *   | Class     |       5 |    5 | already right (tables)                                    |
 *   | Interface |       7 |    7 | already right (views)                                     |
 *   | Function  |       2 |    1 | 2 is `Constructor` — stored procedures wore its glyph      |
 *   | Field     |       4 |    3 | 4 is `Variable` — columns wore its glyph                   |
 *   | Method    |       1 |    0 | 1 is `Function`; unused here, but wrong is wrong          |
 *   | Variable  |       5 |    4 | 5 is `Class`; unused, and was a silent duplicate of it     |
 *   | Snippet   |      27 |   28 | **0.56 inserted `Tool = 27`** — see below                  |
 *
 * The two that a user sees on every completion list are the procedure and the column glyphs.
 *
 * `Snippet` is the interesting one, and it is not an off-by-one of the same kind: `27` was correct when
 * the Angular renderer pinned Monaco 0.52, and 0.56 inserted `User = 25, Issue = 26, Tool = 27` ahead
 * of it, pushing `Snippet` to 28. So the ten SQL snippets were rendering with the `Tool` glyph purely
 * because the dependency moved underneath a hardcoded number. That is exactly the failure mode
 * `sql-intellisense.spec.ts` now pins: every number in this table is asserted equal to the enum member
 * it names, imported from Monaco, so the next bump that shifts the enum fails a test rather than
 * quietly changing an icon.
 *
 * Numbers rather than the enum **in this module** is still deliberate: it is what lets the whole file
 * import Monaco as types only, which is what lets its tests run it with no Monaco at all. The spec is
 * the one place that pays for a runtime import, and it imports the generated leaf enum module rather
 * than the editor API.
 */
const COMPLETION_ITEM_KIND = {
  Keyword: 17,
  Snippet: 28,
  Class: 5, // Table
  Interface: 7, // View
  Function: 1, // Stored Procedure
  Method: 0, // Function (unused — nothing reads `Method`)
  Field: 3, // Column
  Variable: 4,
} as const;

/** `InsertAsSnippet`. The original spelled it `insertTextRules: 4` with the same comment. */
const INSERT_AS_SNIPPET = 4;

/**
 * The keywords every engine understands.
 *
 * Derived from the Angular original's single 107-entry list by removing the T-SQL-only entries (now
 * in `MSSQL_KEYWORDS`) and the three labels it carried twice — `ELSE`, `END` and `NOT NULL`, all
 * from the CASE block repeating the IF block's. The port kept those duplicates because removing them
 * would have renumbered every subsequent `sortText`; splitting the list renumbers it anyway, so the
 * reason to keep them is gone. `SELECT` and `FROM` stay first and second, which is the only part of
 * the numbering anything asserts.
 *
 * `EXCEPT`/`INTERSECT` are here rather than in the two dialect lists: MySQL has had both since
 * 8.0.31, and Joinery's MySQL support targets 8.
 */
const SHARED_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'BETWEEN',
  'LIKE',
  'ORDER BY',
  'GROUP BY',
  'HAVING',
  'DISTINCT',
  'AS',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'CROSS JOIN',
  'ON',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TABLE',
  'VIEW',
  'INDEX',
  'PROCEDURE',
  'FUNCTION',
  'IF',
  'ELSE',
  'BEGIN',
  'END',
  'WHILE',
  'RETURN',
  'DECLARE',
  'NULL',
  'IS NULL',
  'IS NOT NULL',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'UNION',
  'UNION ALL',
  'EXCEPT',
  'INTERSECT',
  'ASC',
  'DESC',
  'WITH',
  'COALESCE',
  'NULLIF',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CAST',
  'SUBSTRING',
  'REPLACE',
  'ROW_NUMBER',
  'OVER',
  'PARTITION BY',
  'RANK',
  'DENSE_RANK',
  'TRANSACTION',
  'COMMIT',
  'ROLLBACK',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'CONSTRAINT',
  'NOT NULL',
] as const;

/**
 * T-SQL. Every entry here was in the Angular original's single list and was being offered to
 * PostgreSQL and MySQL users, which is the defect J-138 exists to fix.
 *
 * `SAVE TRANSACTION` replaces the original's `SAVEPOINT`, which is the ANSI spelling SQL Server does
 * not accept — so the one entry in this file that was wrong for SQL Server too is fixed by the split.
 */
const MSSQL_KEYWORDS = [
  'TOP',
  'FULL JOIN',
  'CROSS APPLY',
  'OUTER APPLY',
  'NOLOCK',
  'OFFSET',
  'FETCH NEXT',
  'MERGE',
  'CONVERT',
  'GETDATE',
  'DATEADD',
  'DATEDIFF',
  'YEAR',
  'MONTH',
  'DAY',
  'LEN',
  'CHARINDEX',
  'ISNULL',
  'EXEC',
  'EXECUTE',
  'PRINT',
  'RAISERROR',
  'TRY',
  'CATCH',
  'THROW',
  'SAVE TRANSACTION',
  'IDENTITY',
  'CLUSTERED',
  'NONCLUSTERED',
] as const;

const POSTGRESQL_KEYWORDS = [
  'LIMIT',
  'OFFSET',
  'FULL JOIN',
  'LATERAL',
  'RETURNING',
  'ON CONFLICT',
  'DO NOTHING',
  'DO UPDATE',
  'ILIKE',
  'SIMILAR TO',
  'CALL',
  'SAVEPOINT',
  'LENGTH',
  'POSITION',
  'NOW',
  'CURRENT_DATE',
  'CURRENT_TIMESTAMP',
  'EXTRACT',
  'DATE_TRUNC',
  'AGE',
  'STRING_AGG',
  'ARRAY_AGG',
  'JSONB',
  'SERIAL',
  'BIGSERIAL',
  'GENERATED ALWAYS AS IDENTITY',
  'TRUE',
  'FALSE',
] as const;

const MYSQL_KEYWORDS = [
  'LIMIT',
  'OFFSET',
  'STRAIGHT_JOIN',
  'ON DUPLICATE KEY UPDATE',
  'CALL',
  'SAVEPOINT',
  'IFNULL',
  'LENGTH',
  'CONCAT',
  'GROUP_CONCAT',
  'NOW',
  'CURDATE',
  'DATE_ADD',
  'DATE_SUB',
  'DATEDIFF',
  'YEAR',
  'MONTH',
  'DAY',
  'AUTO_INCREMENT',
  'UNSIGNED',
  'ENGINE',
  'CHARACTER SET',
  'REGEXP',
  'RLIKE',
  'SHOW',
  'DESCRIBE',
  'TRUE',
  'FALSE',
] as const;

const ENGINE_KEYWORDS: Record<DatabaseEngine, readonly string[]> = {
  mssql: MSSQL_KEYWORDS,
  postgresql: POSTGRESQL_KEYWORDS,
  mysql: MYSQL_KEYWORDS,
};

/** Shared first, then the engine's own — so `SELECT` and `FROM` keep `sortText` `0000`/`0001`. */
const keywordsFor = (engine: DatabaseEngine): readonly string[] => [
  ...SHARED_KEYWORDS,
  ...ENGINE_KEYWORDS[engine],
];

interface SqlSnippet {
  readonly label: string;
  readonly detail: string;
  readonly insertText: string;
}

/** The six snippets whose bodies are already engine-neutral. Verbatim from the original. */
const SHARED_SNIPPETS: readonly SqlSnippet[] = [
  {
    label: 'select_all',
    detail: 'SELECT * FROM table',
    insertText: 'SELECT *\nFROM ${1:table_name}\nWHERE ${2:condition}',
  },
  {
    label: 'insert_values',
    detail: 'INSERT INTO table VALUES',
    insertText: 'INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values})',
  },
  {
    label: 'update_set',
    detail: 'UPDATE table SET',
    insertText: 'UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}',
  },
  {
    label: 'delete_where',
    detail: 'DELETE FROM table WHERE',
    insertText: 'DELETE FROM ${1:table_name}\nWHERE ${2:condition}',
  },
  {
    label: 'create_table',
    detail: 'CREATE TABLE template',
    insertText:
      'CREATE TABLE ${1:table_name} (\n\t${2:column_name} ${3:datatype} ${4:constraints}\n)',
  },
  {
    label: 'cte',
    detail: 'Common Table Expression',
    insertText: 'WITH ${1:cte_name} AS (\n\t${2:-- query}\n)\nSELECT *\nFROM ${1:cte_name}',
  },
];

/**
 * The four whose bodies only parse on one engine. The MSSQL column is the original's text,
 * unchanged; the other two are the same idea written in a grammar that engine accepts.
 *
 * `merge` is SQL Server's; PostgreSQL and MySQL get `upsert` instead — `ON CONFLICT DO UPDATE` and
 * `ON DUPLICATE KEY UPDATE` — which is what a user reaches for there. (PostgreSQL 15 did add MERGE,
 * but offering it would put a statement in the editor that fails on 14 and earlier.)
 */
const ENGINE_SNIPPETS: Record<DatabaseEngine, readonly SqlSnippet[]> = {
  mssql: [
    {
      label: 'select_top',
      detail: 'SELECT TOP N FROM table',
      insertText: 'SELECT TOP ${1:100} *\nFROM ${2:table_name}',
    },
    {
      label: 'create_procedure',
      detail: 'CREATE PROCEDURE template',
      insertText:
        'CREATE PROCEDURE ${1:procedure_name}\n\t@${2:param} ${3:datatype}\nAS\nBEGIN\n\t${4:-- body}\nEND',
    },
    {
      label: 'try_catch',
      detail: 'TRY CATCH block',
      insertText:
        'BEGIN TRY\n\t${1:-- statements}\nEND TRY\nBEGIN CATCH\n\tSELECT ERROR_MESSAGE() AS ErrorMessage\nEND CATCH',
    },
    {
      label: 'merge',
      detail: 'MERGE statement',
      insertText:
        'MERGE INTO ${1:target_table} AS target\nUSING ${2:source_table} AS source\nON ${3:condition}\nWHEN MATCHED THEN\n\tUPDATE SET ${4:updates}\nWHEN NOT MATCHED THEN\n\tINSERT (${5:columns}) VALUES (${6:values});',
    },
  ],
  postgresql: [
    {
      label: 'select_limit',
      detail: 'SELECT … LIMIT N',
      insertText: 'SELECT *\nFROM ${1:table_name}\nLIMIT ${2:100}',
    },
    {
      label: 'create_procedure',
      detail: 'CREATE PROCEDURE template',
      insertText:
        'CREATE OR REPLACE PROCEDURE ${1:procedure_name}(${2:param} ${3:datatype})\nLANGUAGE plpgsql\nAS $$\nBEGIN\n\t${4:-- body}\nEND;\n$$;',
    },
    {
      label: 'upsert',
      detail: 'INSERT … ON CONFLICT DO UPDATE',
      insertText:
        'INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values})\nON CONFLICT (${4:key_column}) DO UPDATE\nSET ${5:column} = EXCLUDED.${5:column}',
    },
  ],
  mysql: [
    {
      label: 'select_limit',
      detail: 'SELECT … LIMIT N',
      insertText: 'SELECT *\nFROM ${1:table_name}\nLIMIT ${2:100}',
    },
    {
      label: 'create_procedure',
      detail: 'CREATE PROCEDURE template',
      insertText:
        'CREATE PROCEDURE ${1:procedure_name}(IN ${2:param} ${3:datatype})\nBEGIN\n\t${4:-- body}\nEND',
    },
    {
      label: 'upsert',
      detail: 'INSERT … ON DUPLICATE KEY UPDATE',
      insertText:
        'INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values})\nON DUPLICATE KEY UPDATE ${4:column} = VALUES(${4:column})',
    },
  ],
};

const snippetsFor = (engine: DatabaseEngine): readonly SqlSnippet[] => [
  ...SHARED_SNIPPETS,
  ...ENGINE_SNIPPETS[engine],
];

/** The words that may never be mistaken for a table alias. Verbatim (`:519-553`). */
const ALIAS_STOP_WORDS: readonly string[] = [
  'WHERE',
  'ON',
  'SET',
  'AND',
  'OR',
  'NOT',
  'IN',
  'AS',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'ORDER',
  'GROUP',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'INTO',
  'VALUES',
  'BEGIN',
  'END',
  'THEN',
  'ELSE',
  'WHEN',
  'CASE',
  'WITH',
  'SELECT',
];

/**
 * Every engine's identifier delimiters: `[…]` (SQL Server), `"…"` (PostgreSQL), `` `…` `` (MySQL).
 *
 * Before J-138 both patterns below accepted brackets only, so a PostgreSQL user who typed
 * `"customers".` — or who accepted the provider's own `"public"."customers"` and then typed a dot —
 * matched nothing and was offered no columns. One class for the opening and closing delimiter alike:
 * the patterns are recognisers for "an identifier a user might have quoted", not validators.
 */
const IDENTIFIER_DELIMITERS = /["`[\]]/g;

/** `schema.table.` or `alias.` immediately before the caret. */
const IDENTIFIER_BEFORE_DOT = /(["`[\]]?\w+["`[\]]?(?:\.["`[\]]?\w+["`[\]]?)?)\s*\.$/;

/** How many tables' columns are prefetched. Verbatim: `tables.slice(0, 50)` "Limit for performance". */
const MAX_TABLES_WITH_COLUMNS = 50;

/** Ghost text: 500ms debounce, ≥3 characters, ≤5 alias-resolved tables in the prompt. Verbatim. */
const GHOST_TEXT_DEBOUNCE_MS = 500;
const GHOST_TEXT_MIN_PREFIX = 3;
const GHOST_TEXT_MAX_TABLES = 5;

/** A schema-qualified object name, kept in two parts so it can be quoted as two identifiers. */
interface ObjectRef {
  readonly schema: string;
  readonly name: string;
}

interface TableInfo extends ObjectRef {
  readonly columns: readonly ColumnInfo[];
}

/**
 * Which connection and database the caches are keyed on, and which engine the SQL is written for.
 * Resolved per call, never cached.
 *
 * The engine is not part of the cache key: it is a property of the connection, so `connectionId`
 * already determines it.
 */
export interface IntellisenseTarget {
  readonly connectionId: string | null;
  readonly database: string | null;
  readonly engine: DatabaseEngine | null;
}

/**
 * The engine to generate SQL for. A null engine — no connection, or a profile the connection store
 * has not loaded yet — falls back to `mssql`, which is the same fallback `sql-dialect.ts:21-25`
 * makes for the tokenizer and the formatter, so all three agree about an unknown engine.
 */
const engineOf = (target: IntellisenseTarget): DatabaseEngine => target.engine ?? 'mssql';

/**
 * The schema an object belongs to when the explorer did not report one.
 *
 * Not `sql-text.ts:defaultSchema`, which answers `''` for MySQL: that value is then handed to
 * `deps.getTableColumns`, and MySQL's column query binds it to `TABLE_SCHEMA`
 * (`mysql-dialect.ts:195-214`), where an empty string matches nothing. MySQL conflates database and
 * schema (`mysql-dialect.ts:127`), so the database is the right answer there.
 */
const schemaFallbackFor = (target: IntellisenseTarget): string => {
  switch (engineOf(target)) {
    case 'mysql':
      return target.database ?? '';
    case 'postgresql':
      return 'public';
    case 'mssql':
      return 'dbo';
  }
};

/**
 * The unquoted form shown in the completion list. MySQL has no schema layer between database and
 * table, so a two-part label there would name something that does not exist — the same reason
 * `sql-text.ts:qualifiedTable` drops the schema for MySQL.
 */
const displayName = (ref: ObjectRef, engine: DatabaseEngine): string =>
  engine === 'mysql' ? ref.name : `${ref.schema}.${ref.name}`;

/**
 * Everything the service used to reach for through Angular DI, stated.
 *
 * Functions rather than store references, so the caller decides whether "the current connection" is
 * the focused one (Angular's answer) or the one this editor's TAB is bound to (the right answer, and
 * what the query panel passes). That distinction is exactly the bug class PLAN.md 0.4 describes for
 * the sidebar's `overrideConnectionId` parameter.
 */
export interface IntellisenseDeps {
  /** The connection/database the completions are for. Called per completion request. */
  readonly target: () => IntellisenseTarget;
  readonly getExplorerChildren: (
    connectionId: string,
    database: string,
    parentPath: string
  ) => Promise<readonly ObjectMetadata[]>;
  readonly getTableColumns: (
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ) => Promise<readonly ColumnInfo[]>;
  /** Whether the target engine has stored procedures at all. `capabilities.ts` answers this. */
  readonly supportsStoredProcedures: () => boolean;
  /** AI ghost text is offered only when both are true (`ai.ts` selectors). */
  readonly ghostTextEnabled: () => boolean;
  readonly generateSql: (request: {
    prompt: string;
    database?: string;
  }) => Promise<{ sql?: string } | null>;
}

export interface SqlIntellisense {
  /** Registers the completion provider for all three dialects. Returns one combined disposable. */
  readonly registerCompletionProvider: (languages: MonacoLanguagesApi) => monaco.IDisposable;
  readonly registerGhostTextProvider: (languages: MonacoLanguagesApi) => monaco.IDisposable;
  /**
   * Prefetches the target's tables (with columns), views and procedures into the cache.
   *
   * The target is explicit here where the original read it from the focused connection: the caller is a
   * query TAB, and its connection is not necessarily the focused one — the same distinction PLAN.md 0.4
   * describes for the sidebar's `overrideConnectionId`. Omitting it falls back to the active tab.
   */
  readonly loadMetadata: (target?: IntellisenseTarget) => Promise<void>;
  readonly clearCache: () => void;
  /** The completion body, exported so it can be unit-tested without Monaco. */
  readonly getContextAwareCompletions: (
    model: CompletionModel,
    position: CompletionPosition
  ) => Promise<{ suggestions: monaco.languages.CompletionItem[] }>;
}

/**
 * The structural Monaco shapes this module needs.
 *
 * The original declared its own (`sql-intellisense.service.ts:11-59`) with the comment "Avoids
 * depending on the monaco-editor type package directly". That reason no longer holds — the package IS
 * a dependency now — but the *shape* does, for a better reason: a provider whose model parameter is
 * the three methods it calls can be unit-tested with a three-line fake, and `monaco.editor.ITextModel`
 * cannot be. So the narrow types stay, and the real Monaco types are satisfied structurally at the
 * registration call (a real `ITextModel` is assignable to `CompletionModel`).
 */
export interface CompletionModel {
  getLineContent: (lineNumber: number) => string;
  getWordUntilPosition: (position: CompletionPosition) => {
    startColumn: number;
    endColumn: number;
  };
  getValue: () => string;
}

export interface CompletionPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** The two `monaco.languages` registrars this module uses, and nothing else. */
export interface MonacoLanguagesApi {
  registerCompletionItemProvider: (
    languageId: string,
    provider: monaco.languages.CompletionItemProvider
  ) => monaco.IDisposable;
  registerInlineCompletionsProvider: (
    languageId: string,
    provider: monaco.languages.InlineCompletionsProvider
  ) => monaco.IDisposable;
}

/** The language ids the provider is registered for. All three SQL dialects, one provider each. */
export const SQL_LANGUAGE_IDS = ['sql', 'pgsql', 'mysql'] as const;

export function createSqlIntellisense(deps: IntellisenseDeps): SqlIntellisense {
  // Cache of loaded metadata, keyed `${connectionId}:${database}`.
  const tablesCache = new Map<string, readonly TableInfo[]>();
  const viewsCache = new Map<string, readonly ObjectRef[]>();
  const proceduresCache = new Map<string, readonly ObjectRef[]>();

  // Ghost text state. One in-flight request and one timer, both replaced by the next keystroke.
  let ghostTextTimer: ReturnType<typeof setTimeout> | null = null;

  const cacheKeyFor = ({ connectionId, database }: IntellisenseTarget): string | null =>
    connectionId && database ? `${connectionId}:${database}` : null;

  const rangeFor = (model: CompletionModel, position: CompletionPosition): monaco.IRange => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
  };

  // ── Context detection. Every regex verbatim (`:474-497`, `:622-632`); see the `.trim()` note. ──
  //
  // THE ONE FIXED BUG IN THIS PORT, and it is the reason to test a "near-verbatim" port at all.
  //
  // The original wrote `pattern.test(text.trim())` for these three, against patterns that require
  // trailing whitespace (`\bFROM\s+$`). `trim()` removes exactly the character the pattern needs, so
  // `isAfterFrom`, `isAfterJoin` and `isAfterExec` could NEVER return true — three of the seven context
  // branches were unreachable, and the headline behaviour ("type `FROM ` and see your tables") was
  // impossible. Nobody noticed because the whole service was dead code: its only live entry point was
  // `registerGhostTextProvider` (see this module's header).
  //
  // Porting that verbatim would have shipped a provider whose interesting half cannot run, so the
  // `.trim()` is dropped and `sql-intellisense.spec.ts` covers all seven branches. `isAfterDot` is
  // untouched — it uses `trimEnd()` and always worked.
  const isAfterFrom = (text: string): boolean => /\bFROM\s+$/i.test(text);

  const isAfterJoin = (text: string): boolean =>
    /\b(JOIN|INNER JOIN|LEFT JOIN|RIGHT JOIN|FULL JOIN|CROSS JOIN)\s+$/i.test(text);

  const isAfterDot = (text: string): boolean => text.trimEnd().endsWith('.');

  /**
   * "The caret is about to name a stored procedure." T-SQL spells that `EXEC`/`EXECUTE`; PostgreSQL
   * and MySQL spell it `CALL`, and before J-138 this branch tested for the T-SQL spelling on all
   * three, so it could never fire for the two engines whose users would type `CALL`. Same decision,
   * and same wording, as `sql-text.ts:executeProcedure`.
   */
  const isAfterExec = (text: string, engine: DatabaseEngine): boolean =>
    engine === 'mssql' ? /\b(EXEC|EXECUTE)\s+$/i.test(text) : /\bCALL\s+$/i.test(text);

  const extractTableName = (text: string): string | null =>
    IDENTIFIER_BEFORE_DOT.exec(text)?.[1] ?? null;

  const isKeyword = (word: string): boolean => ALIAS_STOP_WORDS.includes(word.toUpperCase());

  /** alias → table name, from the whole query text. Verbatim (`:503-517`). */
  const extractAliases = (fullText: string): Map<string, string> => {
    const aliases = new Map<string, string>();
    // Built per call rather than hoisted: it carries `g`, so a shared instance would carry
    // `lastIndex` from the previous completion request into this one.
    const pattern =
      /\b(?:FROM|JOIN)\s+(["`[\]]?\w+["`[\]]?(?:\.["`[\]]?\w+["`[\]]?)?)\s+(?:AS\s+)?(\w+)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fullText)) !== null) {
      const tableName = match[1]?.replace(IDENTIFIER_DELIMITERS, '');
      const alias = match[2]?.toLowerCase();
      if (tableName === undefined || alias === undefined) continue;
      if (!isKeyword(alias)) aliases.set(alias, tableName);
    }
    return aliases;
  };

  /**
   * Whether the caret is inside a WHERE clause. Verbatim (`:622-632`), including the
   * `fullText.indexOf(textBeforeCursor)` offset calculation — which finds the FIRST occurrence of the
   * line prefix rather than the caret's actual offset, so on a repeated line it can measure the wrong
   * clause. Left as-is: it is a heuristic whose only effect is which suggestions are offered first,
   * and "port near-verbatim" is the instruction.
   */
  const isInWhereClause = (textBeforeCursor: string, fullText: string): boolean => {
    const textUpper = fullText.toUpperCase();
    const cursorOffset = fullText.indexOf(textBeforeCursor) + textBeforeCursor.length;
    const whereIndex = textUpper.lastIndexOf('WHERE', cursorOffset);
    if (whereIndex === -1) return false;
    const textBetween = textUpper.substring(whereIndex, cursorOffset);
    return !/(GROUP BY|ORDER BY|HAVING|UNION|EXCEPT|INTERSECT)/i.test(textBetween);
  };

  // ── Completion producers. Kinds, sortText and insertText verbatim (`:368-471`). ────────────

  // Each producer takes the resolved target rather than calling `deps.target()` itself: one
  // completion request must not straddle two engines if the active tab changes mid-flight, and it
  // makes the engine an argument a reader can follow rather than an ambient read.

  const cachedFor = <T>(
    cache: Map<string, readonly T[]>,
    target: IntellisenseTarget
  ): readonly T[] => {
    const key = cacheKeyFor(target);
    return key === null ? [] : (cache.get(key) ?? []);
  };

  const keywordCompletions = (
    target: IntellisenseTarget,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] =>
    keywordsFor(engineOf(target)).map((keyword, index) => ({
      label: keyword,
      kind: COMPLETION_ITEM_KIND.Keyword,
      insertText: keyword,
      range,
      sortText: `0${String(index).padStart(3, '0')}`, // Keywords first
    }));

  const snippetCompletions = (
    target: IntellisenseTarget,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] =>
    snippetsFor(engineOf(target)).map(snippet => ({
      label: snippet.label,
      kind: COMPLETION_ITEM_KIND.Snippet,
      detail: snippet.detail,
      insertText: snippet.insertText,
      insertTextRules: INSERT_AS_SNIPPET,
      range,
      sortText: '1', // Snippets after keywords
    }));

  const tableCompletions = (
    target: IntellisenseTarget,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] => {
    const engine = engineOf(target);
    return cachedFor(tablesCache, target).map(table => ({
      label: displayName(table, engine),
      kind: COMPLETION_ITEM_KIND.Class,
      detail: 'Table',
      insertText: qualifiedTable(table.schema, table.name, engine),
      range,
      sortText: '2',
    }));
  };

  const viewCompletions = (
    target: IntellisenseTarget,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] => {
    const engine = engineOf(target);
    // The cache holds schema and name apart, where the port held the joined string and then quoted
    // the whole of it — `[public.active_customers]`, which is not a reference to anything anywhere.
    return cachedFor(viewsCache, target).map(view => ({
      label: displayName(view, engine),
      kind: COMPLETION_ITEM_KIND.Interface,
      detail: 'View',
      insertText: qualifiedTable(view.schema, view.name, engine),
      range,
      sortText: '3',
    }));
  };

  const procedureCompletions = (
    target: IntellisenseTarget,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] => {
    const engine = engineOf(target);
    return cachedFor(proceduresCache, target).map(procedure => ({
      label: displayName(procedure, engine),
      kind: COMPLETION_ITEM_KIND.Function,
      detail: 'Stored Procedure',
      // Quoted, where the port left it bare: a procedure whose name needs quoting is exactly the
      // case a bare insert breaks, and every engine accepts a quoted routine name after EXEC/CALL.
      insertText: qualifiedTable(procedure.schema, procedure.name, engine),
      range,
    }));
  };

  const columnCompletions = (
    target: IntellisenseTarget,
    tableName: string,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] => {
    const engine = engineOf(target);

    // Handle schema.table or just table.
    const parts = tableName.split('.');
    const searchName = (parts[parts.length - 1] ?? '').replace(IDENTIFIER_DELIMITERS, '');
    const table = cachedFor(tablesCache, target).find(
      t => t.name.toLowerCase() === searchName.toLowerCase()
    );
    if (!table) return [];

    return table.columns.map(column => ({
      label: column.name,
      kind: COMPLETION_ITEM_KIND.Field,
      detail: `${column.dataType}${column.isNullable ? ' (nullable)' : ''}`,
      documentation: column.isPrimaryKey ? 'Primary Key' : undefined,
      insertText: quoteIdentifier(column.name, engine),
      range,
      sortText: '0',
    }));
  };

  /** Resolves an alias before falling back to a direct table-name lookup. Verbatim (`:558-574`). */
  const columnCompletionsWithAlias = (
    target: IntellisenseTarget,
    prefix: string,
    fullText: string,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] => {
    const aliases = extractAliases(fullText);
    const cleanPrefix = prefix.replace(IDENTIFIER_DELIMITERS, '').toLowerCase();
    const resolvedTable = aliases.get(cleanPrefix);
    return columnCompletions(target, resolvedTable ?? prefix, range);
  };

  const getContextAwareCompletions = async (
    model: CompletionModel,
    position: CompletionPosition
  ): Promise<{ suggestions: monaco.languages.CompletionItem[] }> => {
    const target = deps.target();
    const range = rangeFor(model, position);
    const lineContent = model.getLineContent(position.lineNumber);
    const textBeforeCursor = lineContent.substring(0, position.column - 1);
    const fullText = model.getValue();
    const suggestions: monaco.languages.CompletionItem[] = [];

    if (isAfterFrom(textBeforeCursor) || isAfterJoin(textBeforeCursor)) {
      suggestions.push(...tableCompletions(target, range), ...viewCompletions(target, range));
    } else if (isAfterDot(textBeforeCursor)) {
      const prefix = extractTableName(textBeforeCursor);
      if (prefix !== null) {
        suggestions.push(...columnCompletionsWithAlias(target, prefix, fullText, range));
      }
    } else if (isAfterExec(textBeforeCursor, engineOf(target))) {
      suggestions.push(...procedureCompletions(target, range));
    } else if (isInWhereClause(textBeforeCursor, fullText)) {
      // In WHERE clause: suggest columns from referenced tables.
      for (const tableName of extractAliases(fullText).values()) {
        suggestions.push(...columnCompletions(target, tableName, range));
      }
      suggestions.push(...keywordCompletions(target, range));
    } else {
      suggestions.push(
        ...keywordCompletions(target, range),
        ...snippetCompletions(target, range),
        ...tableCompletions(target, range)
      );
    }

    return { suggestions };
  };

  // ── Metadata loading ──────────────────────────────────────────────────────────────────────

  const loadTableColumns = async (
    target: IntellisenseTarget & { connectionId: string; database: string },
    schema: string,
    table: ObjectMetadata
  ): Promise<readonly ColumnInfo[]> => {
    try {
      return await deps.getTableColumns(target.connectionId, target.database, schema, table.name);
    } catch {
      // Verbatim: one table's columns failing must not lose the other forty-nine.
      return [];
    }
  };

  /**
   * The `parentPath` values the explorer IPC expects, and they are **lowercase**.
   *
   * The Angular service asked for `'Tables'` / `'Views'` / `'Procedures'` (`:334`) while the query
   * component's own prefetch asked for `'tables'` (`:1507`). Only one can be right, and the main
   * process settles it: `explorer.ipc.ts:41-88` compares `parentPath` against lowercase literals and
   * `return []` for anything else. So the service's capitalised paths silently cached NOTHING — a third
   * reason its completions could never have worked, on top of the two in this module's header.
   *
   * Measured, not reasoned: the first e2e run showed the suggest widget open with Monaco's own
   * word-based suggestions and none of ours. The silent `return []` for an unrecognised path is worth a
   * follow-up of its own — it turns a typo into an empty result rather than an error.
   */
  const loadChildren = async (
    connectionId: string,
    database: string,
    parentPath: string
  ): Promise<readonly ObjectMetadata[]> => {
    try {
      return await deps.getExplorerChildren(connectionId, database, parentPath);
    } catch (error) {
      diagnostics.error(`failed to load ${parentPath} for IntelliSense`, error);
      return [];
    }
  };

  const loadMetadata = async (requested?: IntellisenseTarget): Promise<void> => {
    const target = requested ?? deps.target();
    const key = cacheKeyFor(target);
    if (key === null || target.connectionId === null || target.database === null) return;
    // Already loaded. The original had no such guard and did not need one — nothing called it — but
    // its consumer here is an effect that re-runs whenever a tab's connection or database changes, and
    // the prefetch is up to 51 IPC round trips. `clearCache()` is how a caller asks for a re-read; no
    // surface calls it yet, which is recorded as a follow-up (Server ▸ Refresh is its natural home).
    if (tablesCache.has(key)) return;
    const { connectionId, database } = target;

    const [tables, views, procedures] = await Promise.all([
      loadChildren(connectionId, database, 'tables'),
      loadChildren(connectionId, database, 'views'),
      deps.supportsStoredProcedures()
        ? loadChildren(connectionId, database, 'procedures')
        : Promise.resolve([] as readonly ObjectMetadata[]),
    ]);

    // `|| 'dbo'` was the original's fallback for a schema the explorer did not report, and it was a
    // T-SQL default handed to every engine. `schemaFallbackFor` answers per engine.
    const fallbackSchema = schemaFallbackFor(target);
    const refFor = (metadata: ObjectMetadata): ObjectRef => ({
      schema: metadata.schema || fallbackSchema,
      name: metadata.name,
    });

    // Columns for the first 50 tables only — the original's performance bound, kept, and now an
    // explicit slice bound rather than an implicit one (CLAUDE.md: bound every loop).
    const located = { ...target, connectionId, database };
    const withColumns: TableInfo[] = [];
    for (const table of tables.slice(0, MAX_TABLES_WITH_COLUMNS)) {
      const ref = refFor(table);
      withColumns.push({
        ...ref,
        columns: await loadTableColumns(located, ref.schema, table),
      });
    }
    tablesCache.set(key, withColumns);

    // Schema and name apart, not joined: the producers quote them as two identifiers.
    viewsCache.set(key, views.map(refFor));
    proceduresCache.set(key, procedures.map(refFor));
  };

  // ── Registration ──────────────────────────────────────────────────────────────────────────

  const registerCompletionProvider = (languages: MonacoLanguagesApi): monaco.IDisposable => {
    const disposables = SQL_LANGUAGE_IDS.map(languageId =>
      languages.registerCompletionItemProvider(languageId, {
        // `['.', ' ']` verbatim (`:308`). The space is what makes `FROM ` offer tables without the
        // user having to type a character first.
        triggerCharacters: ['.', ' '],
        provideCompletionItems: (model, position) => getContextAwareCompletions(model, position),
      })
    );
    return { dispose: () => disposables.forEach(disposable => disposable.dispose()) };
  };

  /**
   * AI ghost text (Tier 2). Ported from `:637-757` including the prompt, the 500ms debounce, the
   * ≥3-character floor, the 5-table context cap, the markdown-fence stripping and the `█` caret
   * marker.
   *
   * Two seams differ. The original built an `AbortController` it never passed to anything and never
   * awaited — dead code, dropped. And the debounce timer is cleared on dispose here, which the
   * Angular service never did: an editor closed mid-debounce left a timer that resolved into a
   * disposed provider.
   */
  const registerGhostTextProvider = (languages: MonacoLanguagesApi): monaco.IDisposable => {
    const disposables = SQL_LANGUAGE_IDS.map(languageId =>
      languages.registerInlineCompletionsProvider(languageId, {
        provideInlineCompletions: async (model, position, _context, token) => {
          if (!deps.ghostTextEnabled()) return { items: [] };

          const lineContent = model.getLineContent(position.lineNumber);
          const textBeforeCursor = lineContent.substring(0, position.column - 1);
          if (textBeforeCursor.trim().length < GHOST_TEXT_MIN_PREFIX) return { items: [] };

          if (ghostTextTimer !== null) clearTimeout(ghostTextTimer);

          return new Promise<monaco.languages.InlineCompletions>(resolve => {
            ghostTextTimer = setTimeout(() => {
              ghostTextTimer = null;
              void requestGhostText(model, position, textBeforeCursor, lineContent, token).then(
                resolve
              );
            }, GHOST_TEXT_DEBOUNCE_MS);
          });
        },
        // The original spelled this `freeInlineCompletions` (`:753-755`, an empty body with a
        // `// Cleanup` comment). Monaco 0.56 renamed the member to `disposeInlineCompletions` and
        // made it REQUIRED, so it has to be here — and it is still empty, for the reason it was
        // empty before: an inline completion item in this provider holds nothing to release.
        disposeInlineCompletions: () => undefined,
      })
    );
    return {
      dispose: () => {
        if (ghostTextTimer !== null) clearTimeout(ghostTextTimer);
        ghostTextTimer = null;
        disposables.forEach(disposable => disposable.dispose());
      },
    };
  };

  /** The debounced half of the ghost-text provider. Split out so the provider body stays readable. */
  const requestGhostText = async (
    model: { getValue: () => string },
    position: CompletionPosition,
    textBeforeCursor: string,
    lineContent: string,
    token: { isCancellationRequested: boolean }
  ): Promise<monaco.languages.InlineCompletions> => {
    const empty: monaco.languages.InlineCompletions = { items: [] };
    if (token.isCancellationRequested) return empty;

    try {
      const fullText = model.getValue();
      const textAfterCursor = lineContent.substring(position.column - 1);
      const target = deps.target();
      const database = target.database;

      // Only the schemas of tables the query actually references, capped at five.
      const aliases = extractAliases(fullText);
      const tableNames = [...aliases.values()].slice(0, GHOST_TEXT_MAX_TABLES);
      const key = cacheKeyFor(target);
      const tables = key === null ? [] : (tablesCache.get(key) ?? []);
      const relevantTables = tables.filter(table =>
        tableNames.some(name => {
          const parts = name.split('.');
          return table.name.toLowerCase() === (parts[parts.length - 1] ?? '').toLowerCase();
        })
      );
      const schemaContext = relevantTables
        .map(table => `${table.schema}.${table.name}: ${table.columns.map(c => c.name).join(', ')}`)
        .join('\n');
      const cursorOffset = fullText.indexOf(textBeforeCursor) + textBeforeCursor.length;

      const result = await deps.generateSql({
        prompt: `Complete this SQL query. Return ONLY the completion text (what comes after the cursor), no explanations:\n\nDatabase: ${database || 'unknown'}\nTables:\n${schemaContext}\n\nQuery so far:\n${fullText.substring(0, cursorOffset)}█${textAfterCursor}`,
        database: database || undefined,
      });

      if (token.isCancellationRequested || !result?.sql) return empty;

      const suggestion = result.sql
        .trim()
        .replace(/^```sql\n?/i, '')
        .replace(/\n?```$/i, '')
        .trim();
      if (!suggestion) return empty;

      return {
        items: [
          {
            insertText: suggestion,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
          },
        ],
      };
    } catch (error) {
      // The original swallowed this silently. A failing AI call is not user-facing, but it must not
      // be invisible either.
      diagnostics.error('AI ghost text failed', error);
      return empty;
    }
  };

  return {
    registerCompletionProvider,
    registerGhostTextProvider,
    loadMetadata,
    clearCache: () => {
      tablesCache.clear();
      viewsCache.clear();
      proceduresCache.clear();
    },
    getContextAwareCompletions,
  };
}
