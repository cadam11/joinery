import { describe, it, expect, beforeEach } from 'vitest';
import { SQLConverterService, resolveServerPath } from './sql-converter';
import type { SqlGlotClientLike } from './sql-converter';
import type { TranspileOptions, TranspileResult } from './sqlglot/types';

/**
 * Unit coverage for the service wrapper — no Python involved. The equivalence of
 * the vendored client against the dependency it replaced is proved separately in
 * tests/integration/sqlglot/transpile.spec.ts.
 */

/** Minimal fake standing in for SqlGlotClient. Records what it was asked to do. */
class FakeClient implements SqlGlotClientLike {
  running = false;
  startCalls = 0;
  stopCalls = 0;
  lastSql: string | null = null;
  lastOptions: TranspileOptions | null = null;

  constructor(
    private readonly behaviour: {
      startError?: Error;
      result?: TranspileResult;
      transpileError?: Error;
      startDelayMs?: number;
    } = {}
  ) {}

  get IsRunning(): boolean {
    return this.running;
  }
  get Port(): number | null {
    return this.running ? 5555 : null;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.behaviour.startDelayMs) {
      await new Promise(r => setTimeout(r, this.behaviour.startDelayMs));
    }
    if (this.behaviour.startError) throw this.behaviour.startError;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.running = false;
  }

  async transpile(sql: string, options: TranspileOptions): Promise<TranspileResult> {
    this.lastSql = sql;
    this.lastOptions = options;
    if (this.behaviour.transpileError) throw this.behaviour.transpileError;
    return (
      this.behaviour.result ?? {
        success: true,
        sql: 'TRANSPILED',
        statements: ['TRANSPILED'],
        errors: [],
        warnings: [],
      }
    );
  }
}

describe('SQLConverterService — dialect mapping', () => {
  it('maps Joinery engine names onto sqlglot dialect names', async () => {
    const fake = new FakeClient();
    await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'postgresql');
    expect(fake.lastOptions).toMatchObject({ fromDialect: 'tsql', toDialect: 'postgres' });
  });

  it('maps mysql to itself', async () => {
    const fake = new FakeClient();
    await new SQLConverterService(fake).convert('SELECT 1', 'mysql', 'mysql');
    expect(fake.lastOptions).toMatchObject({ fromDialect: 'mysql', toDialect: 'mysql' });
  });

  it('passes an unrecognised engine through untranslated', async () => {
    // sqlglot supports far more dialects than Joinery maps; forwarding the raw
    // name lets those work rather than silently mangling them.
    const fake = new FakeClient();
    await new SQLConverterService(fake).convert('SELECT 1', 'duckdb', 'snowflake');
    expect(fake.lastOptions).toMatchObject({ fromDialect: 'duckdb', toDialect: 'snowflake' });
  });

  it('requests pretty output at WARN error level', async () => {
    const fake = new FakeClient();
    await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'mysql');
    expect(fake.lastOptions).toMatchObject({ pretty: true, errorLevel: 'WARN' });
  });
});

describe('SQLConverterService — result mapping', () => {
  it('maps a successful TranspileResult onto ConversionResult', async () => {
    const fake = new FakeClient({
      result: {
        success: true,
        sql: 'SELECT 1 LIMIT 10',
        statements: ['SELECT 1 LIMIT 10'],
        errors: [],
        warnings: ['w1'],
      },
    });
    const out = await new SQLConverterService(fake).convert(
      'SELECT TOP 10 1',
      'mssql',
      'postgresql'
    );

    expect(out).toEqual({
      success: true,
      sql: 'SELECT 1 LIMIT 10',
      sourceDialect: 'tsql',
      targetDialect: 'postgres',
      statements: ['SELECT 1 LIMIT 10'],
      warnings: ['w1'],
      error: undefined,
    });
  });

  it('joins transpiler errors with newlines', async () => {
    const fake = new FakeClient({
      result: {
        success: false,
        sql: '',
        statements: [],
        errors: ['first', 'second'],
        warnings: [],
      },
    });
    const out = await new SQLConverterService(fake).convert('BAD', 'mssql', 'postgresql');
    expect(out.error).toBe('first\nsecond');
    expect(out.success).toBe(false);
  });

  it('leaves error undefined when the transpiler reported none', async () => {
    const fake = new FakeClient();
    const out = await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'postgresql');
    expect(out.error).toBeUndefined();
  });
});

describe('SQLConverterService — failure handling', () => {
  it('never throws when the client fails, and preserves the original SQL', async () => {
    const fake = new FakeClient({ startError: new Error('spawn python3 ENOENT') });
    const out = await new SQLConverterService(fake).convert(
      'SELECT TOP 1 *',
      'mssql',
      'postgresql'
    );

    expect(out.success).toBe(false);
    expect(out.sql).toBe('SELECT TOP 1 *');
    expect(out.sourceDialect).toBe('tsql');
    expect(out.targetDialect).toBe('postgres');
  });

  it('explains a spawn failure that got past the probe', async () => {
    // With an injected client the probe is skipped — it describes this host's Python, and an
    // injected client is somebody else's transport. So this is the narrow case the fallback is
    // for: the probe passed and the spawn failed anyway (interpreter moved, or not executable).
    // The old message told the user to install Python 3 and put python3 on PATH, which since
    // J-29 may be exactly what they already did.
    const fake = new FakeClient({ startError: new Error('spawn python3 ENOENT') });
    const out = await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'postgresql');

    expect(out.error).toMatch(/could not start its Python helper/);
    expect(out.error).not.toMatch(/ensure "python3" is on your PATH/);
  });

  it('blames the build, not Python, when the server script is missing', async () => {
    // The script path contains the substring "python", so a naive check order
    // reports a packaging fault as a missing interpreter and sends the user off
    // installing Python they already have.
    const fake = new FakeClient({
      startError: new Error(
        'sqlglot server script not found at /app/resources/python/sqlglot-server.py'
      ),
    });
    const out = await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'postgresql');

    expect(out.error).toMatch(/server script is missing from this build/);
    expect(out.error).not.toMatch(/Python helper/);
  });

  it('explains a startup timeout', async () => {
    const fake = new FakeClient({ startError: new Error('server did not become ready: timeout') });
    const out = await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'postgresql');
    expect(out.error).toMatch(/timed out/);
  });

  it('surfaces an unrecognised failure verbatim rather than guessing', async () => {
    const fake = new FakeClient({ transpileError: new Error('connection reset by peer') });
    const out = await new SQLConverterService(fake).convert('SELECT 1', 'mssql', 'postgresql');
    expect(out.error).toBe('connection reset by peer');
  });
});

describe('SQLConverterService — lifecycle', () => {
  it('starts the client exactly once for concurrent conversions', async () => {
    // Without serialisation each concurrent call spawns its own Python process.
    const fake = new FakeClient({ startDelayMs: 20 });
    const service = new SQLConverterService(fake);

    await Promise.all([
      service.convert('SELECT 1', 'mssql', 'postgresql'),
      service.convert('SELECT 2', 'mssql', 'postgresql'),
      service.convert('SELECT 3', 'mssql', 'postgresql'),
    ]);

    expect(fake.startCalls).toBe(1);
  });

  it('does not restart an already-running client', async () => {
    const fake = new FakeClient();
    const service = new SQLConverterService(fake);
    await service.convert('SELECT 1', 'mssql', 'postgresql');
    await service.convert('SELECT 2', 'mssql', 'postgresql');
    expect(fake.startCalls).toBe(1);
  });

  it('retries the start after a failed attempt instead of latching failed', async () => {
    const fake = new FakeClient({ startError: new Error('boom') });
    const service = new SQLConverterService(fake);

    await service.convert('SELECT 1', 'mssql', 'postgresql');
    await service.convert('SELECT 2', 'mssql', 'postgresql');

    expect(fake.startCalls).toBe(2);
  });

  it('reports not-running before anything has started', () => {
    expect(new SQLConverterService(new FakeClient()).isRunning()).toBe(false);
  });

  it('reports running after a conversion has started the client', async () => {
    const fake = new FakeClient();
    const service = new SQLConverterService(fake);
    await service.convert('SELECT 1', 'mssql', 'postgresql');
    expect(service.isRunning()).toBe(true);
  });

  it('stops a running client', async () => {
    const fake = new FakeClient();
    const service = new SQLConverterService(fake);
    await service.convert('SELECT 1', 'mssql', 'postgresql');
    await service.stop();

    expect(fake.stopCalls).toBe(1);
    expect(service.isRunning()).toBe(false);
  });

  it('is a no-op to stop a service that never ran', async () => {
    const fake = new FakeClient();
    await new SQLConverterService(fake).stop();
    expect(fake.stopCalls).toBe(0);
  });

  it('never constructs a real client during shutdown', async () => {
    // stop() must not resolve the server path: shutdown cannot be allowed to
    // fail because the script is missing from the build.
    const service = new SQLConverterService();
    await expect(service.stop()).resolves.toBeUndefined();
  });
});

describe('resolveServerPath', () => {
  const originalResourcesPath = process.resourcesPath;

  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    });
  });

  it('finds the repo copy when not packaged', () => {
    // The dev path must resolve from the compiled location, which is why the
    // literal "five levels up" matters; this is the regression guard for it.
    Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true });
    const resolved = resolveServerPath();
    expect(resolved.endsWith('resources/python/sqlglot-server.py')).toBe(true);
  });

  it('resolves to a path that actually exists', () => {
    expect(() => resolveServerPath()).not.toThrow();
  });

  it('never returns a path inside app.asar', () => {
    // An in-asar path passes Node's existsSync via Electron's shim but a spawned
    // python3 cannot open it — the exact failure this vendoring exists to fix.
    expect(resolveServerPath()).not.toMatch(/app\.asar/);
  });
});
