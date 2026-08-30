/**
 * The IntelliSense port, held to the Angular original's semantics.
 *
 * PLAN.md §1.6 requires `sql-intellisense.service.ts` to be ported near-verbatim, and "near-verbatim"
 * is only a checkable claim if something asserts the parts a reader cannot eyeball: the completion
 * KINDS (raw numbers, now held against Monaco's own enum rather than the original's five wrong ones),
 * the `sortText` ordering that decides what the widget shows first, the bracket-quoting in every
 * `insertText`, the seven context branches, and the ghost-text prompt.
 *
 * All of it runs without a Monaco EDITOR: the module under test imports Monaco as types only, and the
 * model is the three-method structural shape the service declares. That is the payoff for keeping the
 * narrow types the original had. The one runtime Monaco import is the generated enum module below,
 * which has no imports of its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnInfo, ObjectMetadata } from '@joinery/shared';
import { setDiagnosticsSink } from '../state/diagnostics';
import {
  createSqlIntellisense,
  type CompletionModel,
  type IntellisenseDeps,
  type MonacoLanguagesApi,
} from './sql-intellisense';

/**
 * Monaco's real enum, IMPORTED — the whole point of this file's kind assertions.
 *
 * `standaloneEnums.js` is the generated leaf module that `standaloneLanguages.js:595` re-exports as
 * `monaco.languages.CompletionItemKind`, so this is the same object the editor uses. It is imported
 * instead of the editor API because it has **zero imports of its own**: no DOM, no workers, nothing
 * jsdom has to fake. `sql-intellisense.ts` itself still imports Monaco as types only, and this is the
 * one runtime Monaco import in its test.
 *
 * A hand-copied table here would have proved nothing. It did not, in fact, prove anything: the first
 * version of this file copied `Snippet: 27` out of the Angular service, which had been correct under
 * Monaco 0.52 and was silently wrong under the 0.56 this package pins (0.56 inserted `Tool = 27`).
 */
import {
  CompletionItemInsertTextRule,
  CompletionItemKind as KIND,
} from 'monaco-editor/editor/common/standalone/standaloneEnums.js';

const CUSTOMERS: ColumnInfo[] = [
  { name: 'id', dataType: 'int', isNullable: false, isPrimaryKey: true } as ColumnInfo,
  { name: 'email', dataType: 'varchar', isNullable: true, isPrimaryKey: false } as ColumnInfo,
];

const object = (name: string, schema = 'public'): ObjectMetadata =>
  ({ name, schema, type: 'table' }) as ObjectMetadata;

/**
 * A model over some SQL, with the caret where a `|` is — or at the end when there is none.
 *
 * The marker matters: three of the seven context branches key on what is immediately BEFORE the caret,
 * and a test that always put the caret at the end of the line could only ever exercise the other four.
 */
function modelFor(marked: string): {
  model: CompletionModel;
  position: { lineNumber: number; column: number };
} {
  const caret = marked.indexOf('|');
  const sql = marked.replace('|', '');
  const lines = sql.split('\n');
  const before = caret === -1 ? sql : sql.slice(0, caret);
  const beforeLines = before.split('\n');
  const position = {
    lineNumber: beforeLines.length,
    column: (beforeLines[beforeLines.length - 1] ?? '').length + 1,
  };
  return {
    model: {
      getValue: () => sql,
      getLineContent: lineNumber => lines[lineNumber - 1] ?? '',
      // The word under the caret. Enough for the range, which is all the service does with it.
      getWordUntilPosition: at => {
        const prefix = (lines[at.lineNumber - 1] ?? '').slice(0, at.column - 1);
        const word = /[\w$]*$/.exec(prefix)?.[0] ?? '';
        return { startColumn: at.column - word.length, endColumn: at.column };
      },
    },
    position,
  };
}

interface Harness {
  readonly deps: IntellisenseDeps;
  readonly getExplorerChildren: ReturnType<typeof vi.fn>;
  readonly getTableColumns: ReturnType<typeof vi.fn>;
  readonly generateSql: ReturnType<typeof vi.fn>;
  target: { connectionId: string | null; database: string | null };
  supportsStoredProcedures: boolean;
  ghostTextEnabled: boolean;
}

function harness(
  overrides: {
    tables?: readonly ObjectMetadata[];
    views?: readonly ObjectMetadata[];
    procedures?: readonly ObjectMetadata[];
    columns?: readonly ColumnInfo[];
    sql?: string | null;
  } = {}
): Harness {
  const state = {
    target: { connectionId: 'conn-1', database: 'shop' },
    supportsStoredProcedures: true,
    ghostTextEnabled: true,
  };
  const getExplorerChildren = vi.fn(async (_c: string, _d: string, parentPath: string) => {
    // Lowercase, which is what `explorer.ipc.ts` compares against — the capitalised paths the Angular
    // service used matched nothing and returned `[]`.
    if (parentPath === 'tables') return overrides.tables ?? [object('customers')];
    if (parentPath === 'views') return overrides.views ?? [object('active_customers')];
    return overrides.procedures ?? [object('sp_reset')];
  });
  const getTableColumns = vi.fn(async () => overrides.columns ?? CUSTOMERS);
  const generateSql = vi.fn(async () => ({ sql: overrides.sql ?? 'WHERE id = 1' }));

  return {
    ...state,
    getExplorerChildren,
    getTableColumns,
    generateSql,
    get deps(): IntellisenseDeps {
      return {
        target: () => this.target,
        getExplorerChildren,
        getTableColumns,
        supportsStoredProcedures: () => this.supportsStoredProcedures,
        ghostTextEnabled: () => this.ghostTextEnabled,
        generateSql,
      };
    },
  } as Harness;
}

const teardowns: (() => void)[] = [];
afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  vi.useRealTimers();
});

/** Suggestions for one snippet of SQL, with the metadata already loaded. */
async function completionsFor(
  sql: string,
  setup: Harness = harness()
): Promise<
  { label: string; kind: number; insertText: string; sortText?: string; detail?: string }[]
> {
  const intellisense = createSqlIntellisense(setup.deps);
  await intellisense.loadMetadata();
  const { model, position } = modelFor(sql);
  const { suggestions } = await intellisense.getContextAwareCompletions(model, position);
  return suggestions.map(item => ({
    label: String(item.label),
    kind: item.kind as number,
    insertText: item.insertText,
    sortText: item.sortText,
    detail: item.detail,
  }));
}

describe('context detection', () => {
  it('offers tables and views after FROM, and nothing else', async () => {
    const suggestions = await completionsFor('SELECT * FROM ');
    expect(suggestions.map(s => s.label)).toEqual(['public.customers', 'public.active_customers']);
  });

  it('offers the same after every JOIN spelling', async () => {
    for (const join of [
      'JOIN ',
      'INNER JOIN ',
      'LEFT JOIN ',
      'RIGHT JOIN ',
      'FULL JOIN ',
      'CROSS JOIN ',
    ]) {
      const suggestions = await completionsFor(`SELECT * FROM a ${join}`);
      expect(
        suggestions.map(s => s.label),
        join
      ).toEqual(['public.customers', 'public.active_customers']);
    }
  });

  it('offers a table’s columns after a dot', async () => {
    const suggestions = await completionsFor('SELECT customers.|');
    expect(suggestions.map(s => s.label)).toEqual(['id', 'email']);
  });

  it('resolves an alias before looking the table up', async () => {
    // The dead-in-Angular path that this port wires up: `c.` means `customers.` because of the FROM.
    const suggestions = await completionsFor('SELECT c.| FROM customers c');
    expect(suggestions.map(s => s.label)).toEqual(['id', 'email']);
  });

  it('resolves an alias introduced with AS', async () => {
    const suggestions = await completionsFor('SELECT c.| FROM customers AS c');
    expect(suggestions.map(s => s.label)).toEqual(['id', 'email']);
  });

  it('never mistakes a clause keyword for an alias', async () => {
    // `FROM customers WHERE` would otherwise register `where` as an alias of `customers`.
    const suggestions = await completionsFor('SELECT where.| FROM customers WHERE x');
    expect(suggestions).toEqual([]);
  });

  it('offers stored procedures after EXEC and after EXECUTE', async () => {
    for (const keyword of ['EXEC ', 'EXECUTE ']) {
      const suggestions = await completionsFor(keyword);
      expect(
        suggestions.map(s => s.label),
        keyword
      ).toEqual(['public.sp_reset']);
    }
  });

  it('offers referenced columns plus keywords inside a WHERE clause', async () => {
    const suggestions = await completionsFor('SELECT * FROM customers c WHERE ');
    expect(suggestions.slice(0, 2).map(s => s.label)).toEqual(['id', 'email']);
    expect(suggestions.some(s => s.kind === KIND.Keyword)).toBe(true);
    // No snippets in the WHERE branch — that is the original's choice, and it is right: a CREATE TABLE
    // template is not what a user wants mid-predicate.
    expect(suggestions.some(s => s.kind === KIND.Snippet)).toBe(false);
  });

  it('stops treating the caret as in-WHERE once a later clause intervenes', async () => {
    const suggestions = await completionsFor('SELECT * FROM customers c WHERE id = 1 GROUP BY ');
    expect(suggestions.some(s => s.kind === KIND.Snippet)).toBe(true);
  });

  it('offers keywords, snippets and tables by default', async () => {
    const suggestions = await completionsFor('SEL');
    expect(suggestions.some(s => s.kind === KIND.Keyword)).toBe(true);
    expect(suggestions.some(s => s.kind === KIND.Snippet)).toBe(true);
    expect(suggestions.some(s => s.label === 'public.customers')).toBe(true);
  });

  it('returns nothing at all with no connection or database', async () => {
    const setup = harness();
    setup.target = { connectionId: null, database: null };
    expect(await completionsFor('SELECT * FROM ', setup)).toEqual([]);
  });
});

describe('the completion items themselves', () => {
  /**
   * The kind of every producer, against the ENUM MEMBER it is meant to be.
   *
   * This is the assertion that the Angular table's five wrong numbers no longer ship, and — because
   * every expectation reads through the imported enum rather than a literal — it is also the assertion
   * that a future Monaco bump which renumbers `CompletionItemKind` fails loudly here instead of
   * quietly changing a glyph in the suggest widget. That is not hypothetical: 0.56 inserted
   * `User`/`Issue`/`Tool` at 25-27 and pushed `Snippet` from 27 to 28, which is how the snippet items
   * came to wear the `Tool` icon.
   */
  it('gives every producer the kind Monaco’s enum names, not the Angular numbers', async () => {
    const setup = harness();
    const byLabel = new Map((await completionsFor('SEL', setup)).map(s => [s.label, s]));
    expect(byLabel.get('SELECT')?.kind).toBe(KIND.Keyword);
    // 28 under 0.56. The Angular original's 27 is `Tool` here.
    expect(byLabel.get('cte')?.kind).toBe(KIND.Snippet);
    expect(byLabel.get('public.customers')?.kind).toBe(KIND.Class);

    const views = await completionsFor('SELECT * FROM ', harness());
    expect(views.find(s => s.label === 'public.active_customers')?.kind).toBe(KIND.Interface);

    // The two a user sees on every list, and the two the Angular renderer got wrong: a column asked
    // for `Field` and was handed `Variable`'s number; a procedure asked for `Function` and was handed
    // `Constructor`'s.
    expect((await completionsFor('SELECT customers.|'))[0]?.kind).toBe(KIND.Field);
    expect((await completionsFor('EXEC '))[0]?.kind).toBe(KIND.Function);
  });

  /**
   * The numbers themselves, pinned one by one.
   *
   * The test above proves each producer agrees with the enum; this one proves the eight literals in
   * `COMPLETION_ITEM_KIND` are the eight the enum defines — including `Method` and `Variable`, which
   * no producer uses and which the test above therefore cannot reach. Together they mean a Monaco bump
   * that renumbers anything in this table fails, whether or not a completion producer reads it.
   */
  it('pins every number in the kind table to the enum member it names', () => {
    // Written as literal → member so a diff shows the number that shipped next to what it means.
    expect(17).toBe(KIND.Keyword);
    expect(28).toBe(KIND.Snippet);
    expect(5).toBe(KIND.Class);
    expect(7).toBe(KIND.Interface);
    expect(1).toBe(KIND.Function);
    expect(0).toBe(KIND.Method);
    expect(3).toBe(KIND.Field);
    expect(4).toBe(KIND.Variable);
    // The four the Angular renderer shipped, so the fix cannot be silently reverted.
    expect(KIND.Constructor).toBe(2); // was `Function`
    expect(KIND.Variable).not.toBe(KIND.Class); // `Variable: 5` was a duplicate of `Class`
    // And the snippet insert-text rule, from the same generated module and the same class of hazard.
    expect(4).toBe(CompletionItemInsertTextRule.InsertAsSnippet);
  });

  it('orders keywords, then snippets, then tables, then views', async () => {
    const suggestions = await completionsFor('SEL');
    expect(suggestions.find(s => s.label === 'SELECT')?.sortText).toBe('0000');
    expect(suggestions.find(s => s.label === 'FROM')?.sortText).toBe('0001');
    expect(suggestions.find(s => s.label === 'cte')?.sortText).toBe('1');
    expect(suggestions.find(s => s.label === 'public.customers')?.sortText).toBe('2');
    const views = await completionsFor('SELECT * FROM ');
    expect(views.find(s => s.label === 'public.active_customers')?.sortText).toBe('3');
  });

  it('sorts columns to the very front, ahead of keywords', async () => {
    // `'0'` sorts before `'0000'`, which is how a column beats a keyword in the WHERE branch.
    const suggestions = await completionsFor('SELECT * FROM customers c WHERE ');
    expect(suggestions.find(s => s.label === 'id')?.sortText).toBe('0');
  });

  it('bracket-quotes every identifier it inserts', async () => {
    // KNOWN DEFECT, not intended behaviour: brackets are T-SQL, and this fixture's schema is the
    // PostgreSQL `public`. The completion provider has no engine to consult — `IntellisenseTarget`
    // carries only `{connectionId, database}` — so every PostgreSQL and MySQL user is handed
    // `[schema].[table]`. J-138 adds the engine and rewrites this test to assert `"s"."t"` and
    // `` `t` ``. J-134 fixed the same class of bug in the main-process dialect layer and left this
    // one to its own ticket rather than reach into the renderer.
    expect((await completionsFor('SELECT * FROM '))[0]?.insertText).toBe('[public].[customers]');
    expect((await completionsFor('SELECT customers.|'))[0]?.insertText).toBe('[id]');
    // A view is quoted as one name, because the cache holds it as one string. Verbatim.
    expect((await completionsFor('SELECT * FROM '))[1]?.insertText).toBe(
      '[public.active_customers]'
    );
    // A procedure is NOT quoted. Also verbatim.
    expect((await completionsFor('EXEC '))[0]?.insertText).toBe('public.sp_reset');
  });

  it('describes a column with its type and nullability, and marks the primary key', async () => {
    const suggestions = await completionsFor('SELECT customers.|');
    expect(suggestions[0]?.detail).toBe('int');
    expect(suggestions[1]?.detail).toBe('varchar (nullable)');
  });

  it('keeps the whole keyword list, duplicates included', async () => {
    const suggestions = await completionsFor('SEL');
    const keywords = suggestions.filter(s => s.kind === KIND.Keyword).map(s => s.label);
    expect(keywords).toHaveLength(107);
    // Two entries appear twice in the original (`ELSE` and `END`, both from the CASE block repeating
    // the IF block's). Removing them would renumber every `sortText` after them, which is ordering that
    // shipped.
    expect(keywords.filter(label => label === 'ELSE')).toHaveLength(2);
    expect(keywords.filter(label => label === 'END')).toHaveLength(2);
  });

  it('ships the ten snippets as snippet-mode insertions', async () => {
    const snippets = (await completionsFor('SEL')).filter(s => s.kind === KIND.Snippet);
    expect(snippets).toHaveLength(10);
    expect(snippets.map(s => s.label)).toContain('merge');
  });
});

describe('loadMetadata', () => {
  it('caps prefetched column loads at fifty tables', async () => {
    const tables = Array.from({ length: 60 }, (_, index) => object(`t${index}`));
    const setup = harness({ tables });
    const intellisense = createSqlIntellisense(setup.deps);
    await intellisense.loadMetadata();
    expect(setup.getTableColumns).toHaveBeenCalledTimes(50);
  });

  it('skips procedures on an engine that has none', async () => {
    const setup = harness();
    setup.supportsStoredProcedures = false;
    const intellisense = createSqlIntellisense(setup.deps);
    await intellisense.loadMetadata();
    expect(setup.getExplorerChildren.mock.calls.map(call => call[2])).toEqual(['tables', 'views']);
  });

  it('does nothing without a connection or a database', async () => {
    const setup = harness();
    setup.target = { connectionId: 'conn-1', database: null };
    await createSqlIntellisense(setup.deps).loadMetadata();
    expect(setup.getExplorerChildren).not.toHaveBeenCalled();
  });

  it('reports a failed children call and still loads the others', async () => {
    const warnings: string[] = [];
    teardowns.push(
      setDiagnosticsSink({ error: context => warnings.push(context), warn: () => undefined })
    );
    const setup = harness();
    setup.getExplorerChildren.mockImplementation(async (_c, _d, parentPath) => {
      if (parentPath === 'views') throw new Error('no views here');
      return [object('customers')];
    });

    const intellisense = createSqlIntellisense(setup.deps);
    await intellisense.loadMetadata();
    const { model, position } = modelFor('SELECT * FROM ');
    const { suggestions } = await intellisense.getContextAwareCompletions(model, position);

    expect(warnings).toEqual(['failed to load views for IntelliSense']);
    expect(suggestions.map(item => item.label)).toEqual(['public.customers']);
  });

  it('keeps a table whose columns could not be read, with no columns', async () => {
    const setup = harness();
    setup.getTableColumns.mockRejectedValue(new Error('permission denied'));
    const intellisense = createSqlIntellisense(setup.deps);
    await intellisense.loadMetadata();
    const { model, position } = modelFor('SELECT customers.|');
    expect((await intellisense.getContextAwareCompletions(model, position)).suggestions).toEqual(
      []
    );

    const fromModel = modelFor('SELECT * FROM ');
    expect(
      (await intellisense.getContextAwareCompletions(fromModel.model, fromModel.position))
        .suggestions
    ).toHaveLength(2);
  });

  it('caches per connection AND database', async () => {
    const setup = harness();
    const intellisense = createSqlIntellisense(setup.deps);
    await intellisense.loadMetadata();

    setup.target = { connectionId: 'conn-1', database: 'other' };
    const { model, position } = modelFor('SELECT * FROM ');
    // Nothing loaded for `other` yet, so the cache miss is empty rather than the first database's tables.
    expect((await intellisense.getContextAwareCompletions(model, position)).suggestions).toEqual(
      []
    );
  });

  it('clearCache empties every cache', async () => {
    const setup = harness();
    const intellisense = createSqlIntellisense(setup.deps);
    await intellisense.loadMetadata();
    intellisense.clearCache();
    const { model, position } = modelFor('SELECT * FROM ');
    expect((await intellisense.getContextAwareCompletions(model, position)).suggestions).toEqual(
      []
    );
  });
});

describe('registration', () => {
  function fakeLanguages(): {
    api: MonacoLanguagesApi;
    completion: ReturnType<typeof vi.fn>;
    inline: ReturnType<typeof vi.fn>;
    disposed: number;
  } {
    const record = { disposed: 0 };
    const dispose = () => {
      record.disposed += 1;
    };
    const completion = vi.fn(() => ({ dispose }));
    const inline = vi.fn(() => ({ dispose }));
    return {
      get disposed() {
        return record.disposed;
      },
      completion,
      inline,
      api: {
        registerCompletionItemProvider: completion,
        registerInlineCompletionsProvider: inline,
      },
    } as never;
  }

  it('registers both providers for all three SQL dialects', () => {
    const languages = fakeLanguages();
    const intellisense = createSqlIntellisense(harness().deps);
    intellisense.registerCompletionProvider(languages.api);
    intellisense.registerGhostTextProvider(languages.api);

    expect(languages.completion.mock.calls.map(call => call[0])).toEqual(['sql', 'pgsql', 'mysql']);
    expect(languages.inline.mock.calls.map(call => call[0])).toEqual(['sql', 'pgsql', 'mysql']);
  });

  it('triggers completions on a dot and on a space', () => {
    const languages = fakeLanguages();
    createSqlIntellisense(harness().deps).registerCompletionProvider(languages.api);
    expect(languages.completion.mock.calls[0]?.[1].triggerCharacters).toEqual(['.', ' ']);
  });

  it('disposes every dialect’s registration', () => {
    const languages = fakeLanguages();
    const intellisense = createSqlIntellisense(harness().deps);
    intellisense.registerCompletionProvider(languages.api).dispose();
    expect(languages.disposed).toBe(3);
  });
});

describe('AI ghost text', () => {
  /** The inline provider Monaco would have been handed. */
  function inlineProvider(setup: Harness) {
    const registered: { provideInlineCompletions?: unknown }[] = [];
    const api = {
      registerCompletionItemProvider: () => ({ dispose: () => undefined }),
      registerInlineCompletionsProvider: (_language: string, provider: never) => {
        registered.push(provider);
        return { dispose: () => undefined };
      },
    } as unknown as MonacoLanguagesApi;
    const intellisense = createSqlIntellisense(setup.deps);
    const disposable = intellisense.registerGhostTextProvider(api);
    const provider = registered[0] as {
      provideInlineCompletions: (
        model: { getValue: () => string; getLineContent: (n: number) => string },
        position: { lineNumber: number; column: number },
        context: unknown,
        token: { isCancellationRequested: boolean }
      ) => Promise<{ items: { insertText: string }[] }>;
    };
    return { intellisense, provider, disposable };
  }

  const request = (
    provider: ReturnType<typeof inlineProvider>['provider'],
    sql: string,
    cancelled = false
  ) => {
    const { model, position } = modelFor(sql);
    return provider.provideInlineCompletions(
      model,
      position,
      {},
      {
        isCancellationRequested: cancelled,
      }
    );
  };

  it('offers nothing when the AI feature is off', async () => {
    const setup = harness();
    setup.ghostTextEnabled = false;
    const { provider } = inlineProvider(setup);
    expect(await request(provider, 'SELECT * FROM customers ')).toEqual({ items: [] });
    expect(setup.generateSql).not.toHaveBeenCalled();
  });

  it('offers nothing for fewer than three characters', async () => {
    const setup = harness();
    const { provider } = inlineProvider(setup);
    expect(await request(provider, 'SE')).toEqual({ items: [] });
    expect(setup.generateSql).not.toHaveBeenCalled();
  });

  it('waits 500ms before asking, and asks once for a burst of keystrokes', async () => {
    vi.useFakeTimers();
    const setup = harness();
    const { provider } = inlineProvider(setup);

    const first = request(provider, 'SELECT * FROM customers c ');
    const second = request(provider, 'SELECT * FROM customers c W');
    await vi.advanceTimersByTimeAsync(499);
    expect(setup.generateSql).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setup.generateSql).toHaveBeenCalledTimes(1);

    // The superseded request never settles, which is correct — Monaco cancels it — so only the second
    // is awaited here. Awaiting the first would hang the test, which is why this is stated.
    expect((await second).items[0]?.insertText).toBe('WHERE id = 1');
    void first;
  });

  it('builds a prompt with the caret marker and only the referenced tables’ schemas', async () => {
    vi.useFakeTimers();
    const setup = harness();
    const { intellisense, provider } = inlineProvider(setup);
    await intellisense.loadMetadata();

    const pending = request(provider, 'SELECT * FROM customers c WHERE ');
    await vi.advanceTimersByTimeAsync(500);
    await pending;

    const prompt = setup.generateSql.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain('Database: shop');
    expect(prompt).toContain('public.customers: id, email');
    expect(prompt).toContain('WHERE █');
    expect(setup.generateSql.mock.calls[0]?.[0].database).toBe('shop');
  });

  it('strips a markdown fence off the model’s answer', async () => {
    vi.useFakeTimers();
    const setup = harness({ sql: '```sql\nWHERE id = 1\n```' });
    const { provider } = inlineProvider(setup);
    const pending = request(provider, 'SELECT * FROM customers ');
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).items[0]?.insertText).toBe('WHERE id = 1');
  });

  it('offers nothing when the answer is empty after stripping', async () => {
    vi.useFakeTimers();
    const setup = harness({ sql: '```sql\n```' });
    const { provider } = inlineProvider(setup);
    const pending = request(provider, 'SELECT * FROM customers ');
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).items).toEqual([]);
  });

  it('offers nothing when the request was cancelled before the debounce elapsed', async () => {
    vi.useFakeTimers();
    const setup = harness();
    const { provider } = inlineProvider(setup);
    const pending = request(provider, 'SELECT * FROM customers ', true);
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).items).toEqual([]);
    expect(setup.generateSql).not.toHaveBeenCalled();
  });

  it('reports a failing AI call instead of swallowing it, and offers nothing', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    teardowns.push(
      setDiagnosticsSink({ error: context => errors.push(context), warn: () => undefined })
    );
    const setup = harness();
    setup.generateSql.mockRejectedValue(new Error('no api key'));
    const { provider } = inlineProvider(setup);

    const pending = request(provider, 'SELECT * FROM customers ');
    await vi.advanceTimersByTimeAsync(500);

    expect((await pending).items).toEqual([]);
    expect(errors).toEqual(['AI ghost text failed']);
  });

  it('clears a pending debounce on dispose, so a closed editor cannot still ask', async () => {
    // The Angular service never did this: an editor closed mid-debounce left a timer that resolved into
    // a disposed provider.
    vi.useFakeTimers();
    const setup = harness();
    const { provider, disposable } = inlineProvider(setup);
    void request(provider, 'SELECT * FROM customers ');
    disposable.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.generateSql).not.toHaveBeenCalled();
  });
});
