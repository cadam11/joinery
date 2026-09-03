/**
 * The converter adapter: the four refusals, the one success, and the argument order.
 *
 * The last is the whole reason this module exists. `query.convertSql`'s two engine parameters are
 * adjacent and now both `DatabaseEngine` (J-66, PLAN.md §7.3), so a transposition still compiles and
 * converts backwards. The named-object signature makes that unrepresentable here, and this file pins
 * the mapping so nobody "tidies" the two arguments into the wrong order later.
 */

import type { JoineryAPI } from '@joinery/preload';
import type { PythonDepsResult } from '@joinery/shared';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { setDiagnosticsSink } from '../../state/diagnostics';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { CONVERTIBLE_ENGINES, ENGINE_LABELS, convertSql } from './sql-convert';

interface Recorded {
  readonly sql: string;
  readonly from: string;
  readonly to: string;
}

let calls: Recorded[] = [];
let logged: string[] = [];
const teardowns: (() => void)[] = [];

function installBridge(
  answer:
    { success: boolean; sql?: string; error?: string; pythonDeps?: PythonDepsResult } | 'throws' = {
    success: true,
    sql: 'SELECT 1 LIMIT 1',
  }
): void {
  calls = [];
  teardowns.push(
    installJoineryMock({
      query: {
        convertSql: (sql: string, fromEngine: string, toEngine: string) => {
          calls.push({ sql, from: fromEngine, to: toEngine });
          if (answer === 'throws') return Promise.reject(new Error('sqlglot is not installed'));
          return Promise.resolve({
            success: answer.success,
            sql: answer.sql ?? '',
            ...(answer.error === undefined ? {} : { error: answer.error }),
            ...(answer.pythonDeps === undefined ? {} : { pythonDeps: answer.pythonDeps }),
          });
        },
      },
    })
  );
}

beforeEach(() => {
  logged = [];
  teardowns.push(
    setDiagnosticsSink({
      error: (context, cause) => logged.push(`${context} :: ${String(cause)}`),
      warn: () => undefined,
    })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
});

describe('convertSql', () => {
  it('passes from and to in that order, and only widens to string here', async () => {
    installBridge();
    const outcome = await convertSql({
      sql: 'SELECT TOP 1 * FROM t',
      from: 'mssql',
      to: 'postgresql',
    });

    expect(outcome).toEqual({ ok: true, sql: 'SELECT 1 LIMIT 1' });
    expect(calls).toEqual([{ sql: 'SELECT TOP 1 * FROM t', from: 'mssql', to: 'postgresql' }]);
  });

  it('refuses an empty document without calling the bridge', async () => {
    installBridge();
    const outcome = await convertSql({ sql: '   \n  ', from: 'mssql', to: 'mysql' });

    expect(outcome).toEqual({ ok: false, reason: 'There is no SQL to convert.' });
    expect(calls).toEqual([]);
  });

  it('refuses the tab’s own engine with a sentence, because the palette cannot hide it', async () => {
    installBridge();
    const outcome = await convertSql({ sql: 'select 1', from: 'mysql', to: 'mysql' });

    expect(outcome).toEqual({ ok: false, reason: 'This tab is already MySQL.' });
    expect(calls).toEqual([]);
  });

  it('reports the main process’s own reason when it refuses', async () => {
    installBridge({ success: false, error: "ParseError: line 1, 'FROOM'" });
    const outcome = await convertSql({ sql: 'FROOM t', from: 'mssql', to: 'mysql' });

    expect(outcome).toEqual({ ok: false, reason: "ParseError: line 1, 'FROOM'" });
  });

  it('names the target when the refusal carried no reason', async () => {
    installBridge({ success: false });
    const outcome = await convertSql({ sql: 'select 1', from: 'mssql', to: 'postgresql' });

    expect(outcome).toEqual({
      ok: false,
      reason: 'Could not convert this SQL to PostgreSQL.',
    });
  });

  it('logs the cause of a thrown call and still answers a sentence', async () => {
    // The Angular version discarded the cause (`catch { notification.error(…) }`), which is what makes a
    // broken sqlglot undebuggable.
    installBridge('throws');
    const outcome = await convertSql({ sql: 'select 1', from: 'mssql', to: 'mysql' });

    expect(outcome).toEqual({ ok: false, reason: 'Could not convert this SQL to MySQL.' });
    expect(logged.join('\n')).toContain('sqlglot is not installed');
  });
});

describe('a refusal this host cannot fix by retrying', () => {
  it('carries the probe through, so the caller can show the setup view (J-29)', async () => {
    // The distinction the sentence could not make: "this machine cannot run the converter" is a
    // setup problem with a guided fix, not a conversion that failed. Without a field to key on,
    // the caller can only match on prose.
    const pythonDeps: PythonDepsResult = {
      platform: 'darwin',
      command: 'python3',
      commandArgs: [],
      tried: ['python3', 'python'],
      modules: [
        { module: 'sqlglot', available: false },
        { module: 'fastapi', available: true },
        { module: 'uvicorn', available: true },
        { module: 'pydantic', available: true },
      ],
      ready: false,
      installInstructions: {
        platform: 'darwin',
        title: 'SQL conversion needs Python 3 and the sqlglot package',
        steps: [{ description: 'Install them.', command: 'python3 -m pip install sqlglot' }],
      },
    };

    installBridge({
      success: false,
      error: 'SQL conversion needs the sqlglot package',
      pythonDeps,
    });
    const outcome = await convertSql({ sql: 'select 1', from: 'mssql', to: 'mysql' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.pythonSetup).toEqual(pythonDeps);
    expect(outcome.reason).toContain('sqlglot');
  });

  it('leaves pythonSetup absent for an ordinary transpile failure', async () => {
    installBridge({ success: false, error: 'sqlglot could not parse this' });
    const outcome = await convertSql({ sql: 'select 1', from: 'mssql', to: 'mysql' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.pythonSetup).toBeUndefined();
  });
});

describe('the engine table', () => {
  it('labels all three engines and offers all three as targets', () => {
    expect(CONVERTIBLE_ENGINES).toEqual(['mssql', 'postgresql', 'mysql']);
    for (const engine of CONVERTIBLE_ENGINES) {
      expect(ENGINE_LABELS[engine].length).toBeGreaterThan(0);
    }
  });
});

describe('the bridge signature (J-66)', () => {
  it('types both engine parameters as DatabaseEngine, so a bare string is refused', () => {
    type ConvertSql = JoineryAPI['query']['convertSql'];

    // @ts-expect-error — `fromEngine` is `DatabaseEngine`; an arbitrary string no longer compiles.
    const from: Parameters<ConvertSql>[1] = 'postgres' as string;
    // @ts-expect-error — and `toEngine` with it, so a typo cannot reach the transpiler.
    const to: Parameters<ConvertSql>[2] = 'postgres' as string;

    // The runtime assertion is not the point of this test — the two directives above are, and an
    // unused `@ts-expect-error` is itself a compile error. `sql` stays a string.
    expectTypeOf<Parameters<ConvertSql>[0]>().toEqualTypeOf<string>();
    expect([from, to]).toEqual(['postgres', 'postgres']);
  });
});
