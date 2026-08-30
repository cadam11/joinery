import { describe, expect, it } from 'vitest';

import { tablePropertiesPgDsqlSql, tablePropertiesPgStandardSql } from './pg-table-properties';

/**
 * These two queries were the last string-concatenated literals left in `services/sql` after J-134
 * moved the dialect layer onto `quoteLiteral`. They escaped their schema and table names with
 * `MetadataService.escId`, which doubles `]` — a T-SQL *identifier* escape, applied inside a
 * PostgreSQL *string literal*. A quote passed through untouched.
 *
 * `MetadataService.queryAny` sends PostgreSQL SQL as `pool.query(sql)` with no bind values, which
 * is node-pg's simple query protocol, so a closed literal followed by `;` runs as a second
 * statement. The schema and table arrive from the renderer over `explorer.ipc.ts`
 * (`db:getTableProperties`), and PostgreSQL permits a quote inside a quoted identifier, so a table
 * named `x'; DROP …; --` reaches here as data the moment the user opens its properties.
 */
describe('PostgreSQL table-properties SQL (J-134 review)', () => {
  const builders = [
    ['standard', tablePropertiesPgStandardSql],
    ['dsql', tablePropertiesPgDsqlSql],
  ] as const;

  it.each(builders)(
    '%s quotes an ordinary schema and table as PostgreSQL literals',
    (_n, build) => {
      const sql = build('public', 'orders');
      expect(sql).toContain("n.nspname = E'public'");
      expect(sql).toContain("c.relname = E'orders'");
    }
  );

  it.each(builders)('%s keeps a quote-led injection payload inside the literal', (_n, build) => {
    const sql = build('public', String.raw`x'; DROP TABLE users; --`);
    expect(sql).toContain(String.raw`c.relname = E'x''; DROP TABLE users; --'`);
  });

  it.each(builders)('%s doubles a backslash, which PostgreSQL reads as an escape', (_n, build) => {
    const sql = build('s\\', 't\\'); // a schema and a table whose names end in a backslash
    expect(sql).toContain(String.raw`n.nspname = E's\\'`);
    expect(sql).toContain(String.raw`c.relname = E't\\'`);
  });

  it('dsql keeps the shape that makes it the DSQL variant', () => {
    const sql = tablePropertiesPgDsqlSql('public', 'orders');
    expect(sql).not.toContain('pg_relation_size');
    expect(sql).not.toContain('pg_stat_user_tables');
    expect(sql).toContain('c.reltuples');
  });

  it('standard keeps the size and live-tuple sources DSQL cannot serve', () => {
    const sql = tablePropertiesPgStandardSql('public', 'orders');
    expect(sql).toContain('pg_relation_size');
    expect(sql).toContain('pg_stat_user_tables');
  });
});
