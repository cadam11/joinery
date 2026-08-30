/**
 * J-136 — the AI `get_table_row_count` tool used to hand-roll its own escape.
 *
 * `tool-registry.ts` built the row-count predicate with a local
 * `value.replace(/'/g, "''")` and string interpolation, bypassing the dialect
 * layer entirely. On MySQL that is an injection: `\` is an escape character
 * unless `NO_BACKSLASH_ESCAPES` is set (it is off by default), so a leading
 * backslash escapes the quote the replace doubled and the NEXT quote closes the
 * literal — and at the time every MySQL pool was opened `multipleStatements: true`,
 * so what followed ran. (J-137 has since taken that capability away from this
 * path; see `mysql-pool-options.ts`. Binding is still the fix — it is what makes
 * the value un-lexable on every engine.)
 * On PostgreSQL the same payload lands whenever `standard_conforming_strings`
 * is off, which is settable per database and per role.
 *
 * The arguments are model-controlled — `args.table` / `args.schema` come
 * straight out of an LLM tool call, and the model's input includes text it read
 * out of the database — so this was a prompt-injection-reachable SQL injection.
 *
 * The fix binds both values as driver parameters. These tests assert the shape:
 * neither value may appear anywhere in the SQL text. The live proof that the
 * bound form survives a real server is
 * `tests/integration/ai/row-count-injection.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { DatabaseEngine } from '@joinery/shared';

import { buildRowCountQuery } from './row-count-query';

/**
 * The cycle-4 audit's payload, adapted so it is also a legal table name on all
 * three engines (MySQL forbids a trailing space in an identifier, hence the
 * `-- x` comment rather than `-- `).
 */
const PAYLOAD = String.raw`probe\'; DROP TABLE probe_victim; -- x`;

const ENGINES: DatabaseEngine[] = ['mssql', 'postgresql', 'mysql'];

describe('buildRowCountQuery', () => {
  describe.each(ENGINES)('%s', engine => {
    it('binds schema and table as parameters, in that order', () => {
      const query = buildRowCountQuery(engine, 'dbo', 'products');
      expect(query.params).toEqual(['dbo', 'products']);
    });

    it('never interpolates the values into the SQL text', () => {
      const query = buildRowCountQuery(engine, PAYLOAD, PAYLOAD);
      expect(query.sql).not.toContain('probe');
      expect(query.sql).not.toContain('DROP TABLE');
      expect(query.sql).not.toContain('\\');
      expect(query.params).toEqual([PAYLOAD, PAYLOAD]);
    });

    it('emits no single-quoted literal built from its arguments', () => {
      // The old code produced `WHERE TABLE_SCHEMA = '<schema>' AND TABLE_NAME = '<table>'`.
      // The only quoted literal the fixed queries may carry is a constant the
      // caller cannot influence (PostgreSQL's `relkind = 'r'`).
      const query = buildRowCountQuery(engine, 'dbo', 'products');
      const literals = query.sql.match(/'[^']*'/g) ?? [];
      expect(literals.every(l => l === "'r'")).toBe(true);
    });
  });

  it('uses MySQL positional placeholders', () => {
    const query = buildRowCountQuery('mysql', 'app', 'orders');
    expect(query.sql).toContain('TABLE_SCHEMA = ?');
    expect(query.sql).toContain('TABLE_NAME = ?');
  });

  it('uses PostgreSQL numbered placeholders', () => {
    const query = buildRowCountQuery('postgresql', 'public', 'orders');
    expect(query.sql).toContain('n.nspname = $1');
    expect(query.sql).toContain('c.relname = $2');
  });

  it('uses SQL Server named placeholders matching the pool binding convention', () => {
    // `ConnectionPoolManager.queryWithParams` names inputs `p0`, `p1`, … by index.
    const query = buildRowCountQuery('mssql', 'dbo', 'orders');
    expect(query.sql).toContain('s.name = @p0');
    expect(query.sql).toContain('t.name = @p1');
  });

  it('rejects non-string arguments rather than interpolating them', () => {
    // The values arrive from a JSON tool call, where the model can send any type.
    expect(() => buildRowCountQuery('mysql', 'app', 1 as unknown as string)).toThrow(/table/i);
    expect(() => buildRowCountQuery('mysql', undefined as unknown as string, 'orders')).toThrow(
      /schema/i
    );
  });
});
