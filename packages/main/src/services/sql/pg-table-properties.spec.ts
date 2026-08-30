import { describe, expect, it } from 'vitest';

import { tablePropertiesPgDsqlQuery, tablePropertiesPgStandardQuery } from './pg-table-properties';

/**
 * These two queries were the last string-concatenated literals left in `services/sql` after J-134
 * moved the dialect layer onto `quoteLiteral`. They escaped their schema and table names with
 * `MetadataService.escId`, which doubles `]` — a T-SQL *identifier* escape, applied inside a
 * PostgreSQL *string literal*. A quote passed through untouched.
 *
 * The J-134 review fixed that by routing them through `quoteLiteral`. These assertions used to pin
 * the escaped output; J-135 inverts them, because the names are now BOUND and their presence in
 * the SQL text — escaped or not — is what would be the regression. `MetadataService.queryAny`
 * sends a query carrying values over node-pg's extended query protocol, which cannot run a second
 * statement at all, where the simple protocol it used before could.
 *
 * The schema and table arrive from the renderer over `explorer.ipc.ts` (`db:getTableProperties`),
 * and PostgreSQL permits a quote inside a quoted identifier, so a table named `x'; DROP …; --`
 * reaches here as data the moment the user opens its properties.
 */
describe('PostgreSQL table-properties queries (J-135)', () => {
  const builders = [
    ['standard', tablePropertiesPgStandardQuery],
    ['dsql', tablePropertiesPgDsqlQuery],
  ] as const;

  it.each(builders)('%s binds an ordinary schema and table', (_n, build) => {
    const { sql, params } = build('public', 'orders');
    expect(sql).toContain('n.nspname = $1');
    expect(sql).toContain('c.relname = $2');
    expect(params).toEqual(['public', 'orders']);
  });

  it.each(builders)('%s keeps a quote-led injection payload out of the SQL', (_n, build) => {
    const payload = String.raw`x'; DROP TABLE users; --`;
    const { sql, params } = build('public', payload);
    expect(sql).not.toContain('DROP TABLE users');
    expect(sql).not.toContain(payload);
    expect(params).toEqual(['public', payload]);
  });

  it.each(builders)('%s binds a backslash rather than escaping it', (_n, build) => {
    // Under `quoteLiteral` these became `E's\\'`. Bound, the value travels verbatim — which is
    // also the only rendering that survives every server setting.
    const { sql, params } = build('s\\', 't\\');
    expect(sql).not.toContain('\\');
    expect(params).toEqual(['s\\', 't\\']);
  });

  it('dsql keeps the shape that makes it the DSQL variant', () => {
    const { sql } = tablePropertiesPgDsqlQuery('public', 'orders');
    expect(sql).not.toContain('pg_relation_size');
    expect(sql).not.toContain('pg_stat_user_tables');
    expect(sql).toContain('c.reltuples');
  });

  it('standard keeps the size and live-tuple sources DSQL cannot serve', () => {
    const { sql } = tablePropertiesPgStandardQuery('public', 'orders');
    expect(sql).toContain('pg_relation_size');
    expect(sql).toContain('pg_stat_user_tables');
  });
});
