/**
 * FK resolution, which is the part of the row inspector that can be wrong silently.
 *
 * Three properties are asserted, in the order the feature depends on them:
 *
 *  1. `parseSingleTableSelect` names a table only when the answer is certain — every refusal case
 *     here is one where FK metadata attached to the parsed table would offer the user a link that
 *     does not exist in the rows they are looking at;
 *  2. `mergeEnrichedColumns` folds the catalogue's keys onto the driver's columns without touching
 *     the array the grid's `columnDefs` memo is keyed on;
 *  3. the generated SQL is correct **per engine**, which the Angular original and the main
 *     process's own FK handler both got wrong (T-SQL brackets everywhere). Since J-145 that is
 *     `fkOpenSql` alone — the preview's lookup is built and bound in the main process, and its
 *     per-engine form is pinned in `main/services/sql/dialect/dialect.spec.ts` and
 *     `main/services/sql/fk-record.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { ColumnMetadata } from '@joinery/shared';

import {
  fkOpenSql,
  fkTabTitle,
  fkTargetFor,
  mergeEnrichedColumns,
  parseSingleTableSelect,
  sqlLiteral,
  truncate,
  unquoteIdentifier,
  type EnrichedColumn,
} from './fk-lookup';

describe('parseSingleTableSelect', () => {
  it('names a bare table, defaulting the schema per engine', () => {
    expect(parseSingleTableSelect('SELECT * FROM customers', 'postgresql', 'shop')).toEqual({
      schema: 'public',
      table: 'customers',
    });
    expect(parseSingleTableSelect('SELECT * FROM Customers', 'mssql', 'shop')).toEqual({
      schema: 'dbo',
      table: 'Customers',
    });
  });

  it('uses the DATABASE as the schema on MySQL, which has no schema layer', () => {
    expect(parseSingleTableSelect('SELECT * FROM customers', 'mysql', 'shop')).toEqual({
      schema: 'shop',
      table: 'customers',
    });
  });

  it('reads a qualified name, and strips each engine’s quoting', () => {
    expect(parseSingleTableSelect('SELECT * FROM app_meta.entity', 'postgresql', 'db')).toEqual({
      schema: 'app_meta',
      table: 'entity',
    });
    expect(parseSingleTableSelect('SELECT * FROM [dbo].[Order Items]', 'mssql', 'db')).toEqual({
      schema: 'dbo',
      table: 'Order Items',
    });
    expect(parseSingleTableSelect('SELECT * FROM `shop`.`orders`', 'mysql', 'db')).toEqual({
      schema: 'shop',
      table: 'orders',
    });
    expect(
      parseSingleTableSelect('SELECT * FROM "public"."customers"', 'postgresql', 'db')
    ).toEqual({ schema: 'public', table: 'customers' });
  });

  it('survives the shapes a real query has: a column list, TOP/DISTINCT, functions, clauses', () => {
    const cases = [
      'SELECT id, email FROM customers ORDER BY id',
      'SELECT TOP 100 * FROM dbo.Orders WHERE id > 3',
      'SELECT DISTINCT country_code FROM customers',
      'SELECT id, upper(full_name) AS full_name FROM customers WHERE id <= 3',
      'SELECT COUNT(*) OVER () AS n, id FROM customers LIMIT 5',
      '-- a leading comment\nSELECT id\nFROM customers\n',
      'SELECT /* inline */ id FROM customers;',
    ];
    for (const sql of cases) {
      expect(parseSingleTableSelect(sql, 'postgresql', 'db')?.table, sql).toBeTypeOf('string');
    }
  });

  it('refuses everything whose row source is not one table', () => {
    const refused = [
      'UPDATE customers SET email = NULL',
      'INSERT INTO customers (id) VALUES (1)',
      'SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id',
      'SELECT * FROM customers, orders',
      'SELECT * FROM customers c, orders o',
      'SELECT * FROM (SELECT 1 AS id) t',
      'SELECT * FROM customers UNION SELECT * FROM archived_customers',
      'SELECT * FROM shop.public.customers',
      'SELECT * FROM customers; SELECT * FROM orders',
      'WITH recent AS (SELECT 1) SELECT * FROM recent',
    ];
    for (const sql of refused) {
      expect(parseSingleTableSelect(sql, 'postgresql', 'db'), sql).toBeNull();
    }
  });

  it('refuses a derived table even when the subquery has its own FROM', () => {
    // The regression: the select list is matched lazily, so before the fix the engine extended it
    // past `FROM (` to make the identifier alternation fit and this named `secret_t` — whose keys and
    // references would then be attached to the derived table's columns, offering links the displayed
    // rows do not have.
    const refused = [
      'SELECT * FROM (SELECT * FROM secret_t) x',
      'SELECT * FROM (SELECT id FROM audit_log ORDER BY id DESC LIMIT 10) recent WHERE id > 0',
      // A scalar subquery in the SELECT LIST, for the same reason: before the fix the FIRST `FROM` in
      // the statement was the subquery's, and this named `audit_log`.
      'SELECT (SELECT max(id) FROM audit_log) AS newest, id FROM customers',
      // Conservative and deliberate: `FROM` inside a function argument leaves the select list with an
      // unclosed paren, and this parser answers "I do not know" rather than guessing.
      'SELECT EXTRACT(month FROM created_at) AS m, id FROM orders',
    ];
    for (const sql of refused) {
      expect(parseSingleTableSelect(sql, 'postgresql', 'db'), sql).toBeNull();
    }
  });

  it('refuses PostgreSQL’s FROM ONLY, where the table name is not the next word', () => {
    // `ONLY` suppresses inheritance; it is a bare word, so it would be read as the table itself and
    // the catalogue would be asked about a table called `only`. A refusal, not a silent wrong answer.
    expect(parseSingleTableSelect('SELECT * FROM ONLY customers', 'postgresql', 'db')).toBeNull();
  });

  it('is not fooled by the word JOIN inside a trailing clause', () => {
    // A refusal, and deliberately so: this parser is a heuristic, and the safe answer when the
    // word appears at all is "I do not know". Recorded as a test so the behaviour is a decision.
    expect(
      parseSingleTableSelect("SELECT * FROM customers WHERE note = 'join us'", 'mssql', 'db')
    ).toBeNull();
  });
});

describe('unquoteIdentifier', () => {
  it('undoes each delimiter’s own doubling', () => {
    expect(unquoteIdentifier('[weird]]name]')).toBe('weird]name');
    expect(unquoteIdentifier('`back``tick`')).toBe('back`tick');
    expect(unquoteIdentifier('"quo""ted"')).toBe('quo"ted');
    expect(unquoteIdentifier('plain')).toBe('plain');
  });
});

describe('mergeEnrichedColumns', () => {
  const driverColumns: readonly ColumnMetadata[] = [
    { name: 'id', type: 'int4' },
    { name: 'CUSTOMER_ID', type: 'int4' },
    { name: 'computed', type: 'text' },
  ];

  const enriched: readonly EnrichedColumn[] = [
    {
      name: 'id',
      type: 'integer',
      nullable: false,
      maxLength: null,
      precision: 32,
      scale: 0,
      isPrimaryKey: true,
      isIdentity: true,
      defaultValue: "nextval('orders_id_seq')",
      foreignKey: null,
    },
    {
      name: 'customer_id',
      type: 'integer',
      nullable: false,
      maxLength: null,
      precision: 32,
      scale: 0,
      isPrimaryKey: false,
      isIdentity: false,
      defaultValue: null,
      foreignKey: {
        referencedSchema: 'public',
        referencedTable: 'customers',
        referencedColumn: 'id',
        constraintName: 'orders_customer_id_fkey',
      },
    },
  ];

  it('matches case-insensitively and folds the catalogue’s keys in', () => {
    const merged = mergeEnrichedColumns(driverColumns, enriched);

    expect(merged[0]).toMatchObject({ isPrimaryKey: true, isIdentity: true, nullable: false });
    expect(merged[1]?.foreignKey).toEqual({
      referencedSchema: 'public',
      referencedTable: 'customers',
      referencedColumn: 'id',
      constraintName: 'orders_customer_id_fkey',
    });
  });

  it('keeps the DRIVER’s type, which is what the grid formats from', () => {
    const merged = mergeEnrichedColumns(driverColumns, enriched);
    expect(merged[0]?.type).toBe('int4');
  });

  it('leaves a column the catalogue does not know untouched', () => {
    const merged = mergeEnrichedColumns(driverColumns, enriched);
    expect(merged[2]).toEqual({ name: 'computed', type: 'text' });
  });

  it('never mutates the array the grid’s memo is keyed on', () => {
    const input: ColumnMetadata[] = [{ name: 'id', type: 'int4' }];
    const merged = mergeEnrichedColumns(input, enriched);
    expect(merged).not.toBe(input);
    expect(input[0]).toEqual({ name: 'id', type: 'int4' });
  });

  it('returns the columns unchanged when the catalogue answered with nothing', () => {
    expect(mergeEnrichedColumns(driverColumns, [])).toEqual(driverColumns);
  });
});

describe('sqlLiteral', () => {
  it('quotes strings per engine, doubling the closing quote', () => {
    expect(sqlLiteral("O'Brien", 'mssql')).toBe("N'O''Brien'");
    expect(sqlLiteral("O'Brien", 'postgresql')).toBe("E'O''Brien'");
    expect(sqlLiteral("O'Brien", 'mysql')).toBe("'O''Brien'");
  });

  it('doubles backslashes on both engines that can escape with them, not on SQL Server', () => {
    expect(sqlLiteral(String.raw`a\b`, 'mysql')).toBe(String.raw`'a\\b'`);
    // An E-string always reads `\` as an escape, so the doubling is what keeps it data.
    expect(sqlLiteral(String.raw`a\b`, 'postgresql')).toBe(String.raw`E'a\\b'`);
    // T-SQL has no backslash escape in any configuration: doubling here would corrupt the predicate.
    expect(sqlLiteral(String.raw`a\b`, 'mssql')).toBe(String.raw`N'a\b'`);
  });

  it('closes the injection route a quoted terminator would open', () => {
    expect(sqlLiteral("1'; DROP TABLE customers; --", 'postgresql')).toBe(
      "E'1''; DROP TABLE customers; --'"
    );
  });

  it('closes the BACKSLASH breakout that standard_conforming_strings=off would open on PostgreSQL', () => {
    // The payload, and why it mattered: `standard_conforming_strings` is settable per database and per
    // role, so a hostile or legacy DB owner can turn it off. With it off and only the quote doubled,
    // `'1\''; DROP …'` reads `\'` as an escaped quote, the next `'` OPENS a literal, and `;` lands
    // outside it — and node-postgres' simple query protocol runs both statements.
    const payload = String.raw`1\'; DROP TABLE customers; -- `;

    const literal = sqlLiteral(payload, 'postgresql');

    // `E''` is escape-string syntax under EVERY setting, so the escaping no longer depends on one.
    expect(literal).toBe(String.raw`E'1\\''; DROP TABLE customers; -- '`);
    expect(literal.startsWith("E'")).toBe(true);
    // Every backslash in the literal is part of a `\\` pair, so none of them can escape the quote
    // that follows — which is what made the old output breakable.
    expect(literal.slice(2, -1).replace(/\\\\/g, '')).not.toContain('\\');
  });

  it('documents MySQL under NO_BACKSLASH_ESCAPES: wrong row, never a second statement', () => {
    // With the mode ON, `\\` is two literal backslashes, so this predicate matches a value that has
    // two where the data has one: the preview finds no row. That is the accepted cost of one escaping
    // rule for both modes — the quote doubling holds either way, so the literal cannot be escaped out
    // of. (The old comment here also claimed mysql2 does not multiplex statements. It does, whenever
    // the connection negotiated CLIENT_MULTI_STATEMENTS; J-137 is what keeps this path off such a
    // connection. See the module doc.)
    expect(sqlLiteral(String.raw`a\b`, 'mysql')).toBe(String.raw`'a\\b'`);
    expect(sqlLiteral(String.raw`1\'; DROP TABLE t; -- `, 'mysql')).toBe(
      String.raw`'1\\''; DROP TABLE t; -- '`
    );
  });

  it('writes numbers and bigints bare, and non-finite ones as NULL', () => {
    expect(sqlLiteral(42, 'postgresql')).toBe('42');
    expect(sqlLiteral(-1.5, 'mssql')).toBe('-1.5');
    expect(sqlLiteral(10n, 'mysql')).toBe('10');
    expect(sqlLiteral(Number.NaN, 'postgresql')).toBe('NULL');
    expect(sqlLiteral(Number.POSITIVE_INFINITY, 'postgresql')).toBe('NULL');
  });

  it('spells booleans the way each engine understands them', () => {
    expect(sqlLiteral(true, 'postgresql')).toBe('TRUE');
    expect(sqlLiteral(false, 'postgresql')).toBe('FALSE');
    expect(sqlLiteral(true, 'mssql')).toBe('1');
    expect(sqlLiteral(false, 'mysql')).toBe('0');
  });

  it('sends a Date as ISO, not as its locale string', () => {
    expect(sqlLiteral(new Date('2026-08-15T12:34:56.000Z'), 'postgresql')).toBe(
      "E'2026-08-15T12:34:56.000Z'"
    );
  });

  it('is NULL for absent values', () => {
    expect(sqlLiteral(null, 'postgresql')).toBe('NULL');
    expect(sqlLiteral(undefined, 'mssql')).toBe('NULL');
  });

  it('sends an object as JSON', () => {
    expect(sqlLiteral({ a: 1 }, 'postgresql')).toBe(`E'{"a":1}'`);
  });
});

describe('fkOpenSql', () => {
  /**
   * The one SQL generator left in this module (J-145). Its sibling `fkLookupSql` — the preview's
   * own single-row lookup — is gone: that statement is built by the dialect layer in the main
   * process now, with its value BOUND rather than escaped (`selectOneByColumnQuery` in
   * `main/services/sql/dialect/sql-dialect.ts`, run by `main/services/sql/fk-record.ts`). What is
   * generated here is generated to be READ — it goes into a query tab as the user's own editable
   * text — which is why it still spells the value out.
   */
  const target = { schema: 'public', table: 'customers', column: 'id', value: 3 };

  it('is a multi-line, uncapped SELECT, per engine, because it is going into a tab', () => {
    expect(fkOpenSql(target, 'postgresql', 'shop')).toBe(
      'SELECT *\nFROM "public"."customers"\nWHERE "id" = 3'
    );
    expect(fkOpenSql({ ...target, schema: 'dbo', table: 'Customers' }, 'mssql', 'shop')).toBe(
      'SELECT *\nFROM [dbo].[Customers]\nWHERE [id] = 3'
    );
  });

  it('writes a bare name on MySQL when the reference is in the connected database', () => {
    expect(fkOpenSql({ ...target, schema: 'shop' }, 'mysql', 'shop')).toBe(
      'SELECT *\nFROM `customers`\nWHERE `id` = 3'
    );
  });

  it('QUALIFIES a MySQL reference into another database, which is what referencedSchema means', () => {
    // A MySQL FK's `referencedSchema` is a DATABASE (`REFERENTIAL_CONSTRAINTS`.
    // `UNIQUE_CONSTRAINT_SCHEMA`), and MySQL allows the constraint across databases. Dropping it —
    // which `qualifiedTable` does, correctly, for the explorer — sent this query to a same-named
    // table in the connected database or to nothing at all.
    expect(fkOpenSql({ ...target, schema: 'crm' }, 'mysql', 'shop')).toBe(
      'SELECT *\nFROM `crm`.`customers`\nWHERE `id` = 3'
    );
  });

  it('quotes an identifier that carries the delimiter itself', () => {
    expect(fkOpenSql({ ...target, table: 'we"ird' }, 'postgresql', 'db')).toContain('"we""ird"');
  });
});

describe('fkTargetFor', () => {
  const column: ColumnMetadata = {
    name: 'customer_id',
    type: 'int4',
    foreignKey: {
      referencedSchema: 'public',
      referencedTable: 'customers',
      referencedColumn: 'id',
    },
  };

  it('resolves a column that references another table', () => {
    expect(fkTargetFor(column, 7)).toEqual({
      schema: 'public',
      table: 'customers',
      column: 'id',
      value: 7,
    });
  });

  it('is null for a NULL value — there is nothing to follow', () => {
    expect(fkTargetFor(column, null)).toBeNull();
    expect(fkTargetFor(column, undefined)).toBeNull();
  });

  it('is null for a column with no reference', () => {
    expect(fkTargetFor({ name: 'id', type: 'int4' }, 1)).toBeNull();
  });
});

describe('titles and truncation', () => {
  it('names the tab after the table and the value', () => {
    expect(fkTabTitle({ schema: 'public', table: 'customers', column: 'id', value: 3 })).toBe(
      'customers · 3'
    );
  });

  it('shortens a long value rather than filling the tab strip with it', () => {
    const title = fkTabTitle({
      schema: 'public',
      table: 'customers',
      column: 'email',
      value: 'a'.repeat(80),
    });
    expect(title).toBe(`customers · ${'a'.repeat(24)}…`);
  });

  it('leaves a short string alone', () => {
    expect(truncate('short', 24)).toBe('short');
  });
});
