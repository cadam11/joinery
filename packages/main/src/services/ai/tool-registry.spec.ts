/**
 * J-136 — the first spec `tool-registry.ts` has ever had.
 *
 * The registry is what turns an LLM tool call into SQL on a live pool, so it is
 * the boundary where model-controlled strings meet the database. Before this
 * ticket `get_table_row_count` interpolated `args.schema` / `args.table` into
 * its SQL after a local `.replace(/'/g, "''")` — see `row-count-query.spec.ts`
 * for why that is an injection on MySQL and on PostgreSQL with
 * `standard_conforming_strings` off.
 *
 * These tests assert the *wiring*: that the handler reaches the parameterised
 * path with the model's strings in the parameter list and nowhere in the SQL.
 *
 * On the double: `ConnectionPoolManager` is replaced with a **recorder**. It
 * implements no escaping, no quoting and no SQL of any kind — it only captures
 * what it was handed — so it cannot pass by agreeing with a broken escaper,
 * which is the failure mode `test-double-fiction-pattern` warns about. Its
 * surface is copied from the real class:
 *   - `getEngineForProfile(profileId): DatabaseEngine`  (connection-pool.ts)
 *   - `getPgPool(profileId, database?): Promise<PgPool>` → `.query(sql, values)`
 *   - `getMySQLPool(profileId, database?): Promise<MySQLPool>` → `.execute(sql, values)`
 *   - `queryWithParams<T>(profileId, sql, params, database?): Promise<IResult<T>>`
 * The behaviour against real servers is proved in
 * `tests/integration/ai/row-count-injection.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseEngine } from '@joinery/shared';

/** `vi.hoisted` because the `vi.mock` factory below runs before this module body. */
const recorder = vi.hoisted(() => ({
  engine: 'mssql' as DatabaseEngine,
  /** Every statement the registry sent, with whatever it bound alongside it. */
  sent: [] as { sql: string; params: readonly unknown[] }[],
}));

vi.mock('../sql/connection-pool', () => ({
  ConnectionPoolManager: {
    getInstance: () => ({
      getEngineForProfile: () => recorder.engine,
      getPgPool: async () => ({
        query: async (sql: string, values?: readonly unknown[]) => {
          recorder.sent.push({ sql, params: values ?? [] });
          return { rows: [{ row_count: 7 }] };
        },
      }),
      getMySQLPool: async () => ({
        execute: async (sql: string, values?: readonly unknown[]) => {
          recorder.sent.push({ sql, params: values ?? [] });
          return [[{ row_count: 7 }]];
        },
        query: async (sql: string) => {
          // Recorded with no params so a test can catch the unparameterised path
          // being used for the row count.
          recorder.sent.push({ sql, params: [] });
          return [[{ row_count: 7 }]];
        },
      }),
      queryWithParams: async (_profileId: string, sql: string, params: readonly unknown[]) => {
        recorder.sent.push({ sql, params });
        return { recordset: [{ row_count: 7 }] };
      },
      query: async (_profileId: string, sql: string) => {
        recorder.sent.push({ sql, params: [] });
        return { recordset: [{ row_count: 7 }] };
      },
    }),
  },
}));

import { ToolRegistry } from './tool-registry';

/** Legal as a table name on all three engines; `-- x` because MySQL forbids a trailing space. */
const PAYLOAD = String.raw`probe\'; DROP TABLE probe_victim; -- x`;

const ENGINES: DatabaseEngine[] = ['mssql', 'postgresql', 'mysql'];

describe('ToolRegistry get_table_row_count', () => {
  beforeEach(() => {
    recorder.sent = [];
    ToolRegistry.resetInstance();
  });

  describe.each(ENGINES)('%s', engine => {
    beforeEach(() => {
      recorder.engine = engine;
    });

    it('sends the model-supplied table and schema as bound parameters', async () => {
      const registry = ToolRegistry.getInstance();
      await registry.executeTool(
        'get_table_row_count',
        { table: PAYLOAD, schema: PAYLOAD },
        'profile-1',
        'appdb'
      );

      expect(recorder.sent).toHaveLength(1);
      const [sent] = recorder.sent;
      expect(sent.params).toEqual([PAYLOAD, PAYLOAD]);
    });

    it('puts no part of the model-supplied strings into the SQL text', async () => {
      const registry = ToolRegistry.getInstance();
      await registry.executeTool(
        'get_table_row_count',
        { table: PAYLOAD, schema: PAYLOAD },
        'profile-1',
        'appdb'
      );

      const [sent] = recorder.sent;
      expect(sent.sql).not.toContain('probe');
      expect(sent.sql).not.toContain('DROP TABLE');
      expect(sent.sql).not.toContain('\\');
    });

    it('still reports the row count and the qualified name it was asked about', async () => {
      const registry = ToolRegistry.getInstance();
      const result = (await registry.executeTool(
        'get_table_row_count',
        { table: 'orders', schema: 'sales' },
        'profile-1',
        'appdb'
      )) as { table: string; rowCount: number };

      expect(result.table).toBe('sales.orders');
      expect(result.rowCount).toBe(7);
    });
  });

  it('defaults the schema per engine when the model omits it', async () => {
    const defaults: [DatabaseEngine, string][] = [
      ['mssql', 'dbo'],
      ['postgresql', 'public'],
      // MySQL conflates schema and database, so the active database is the default.
      ['mysql', 'appdb'],
    ];

    for (const [engine, expected] of defaults) {
      recorder.engine = engine;
      recorder.sent = [];
      ToolRegistry.resetInstance();
      await ToolRegistry.getInstance().executeTool(
        'get_table_row_count',
        { table: 'orders' },
        'profile-1',
        'appdb'
      );
      expect(recorder.sent[0].params, `default schema for ${engine}`).toEqual([expected, 'orders']);
    }
  });
});

describe('tool-registry source', () => {
  it('hand-rolls no SQL string escape', () => {
    // The regression guard for J-136: the fix is only durable if the next
    // template does not quietly reintroduce `.replace(/'/g, "''")`.
    const source = readFileSync(join(__dirname, 'tool-registry.ts'), 'utf8');
    expect(source).not.toMatch(/replace\(\s*\/'\/g/);
  });
});
