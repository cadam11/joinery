/**
 * SQL Dialect Converter Service
 *
 * Spawns a Python FastAPI microservice wrapping the real Python sqlglot
 * library. Much more reliable than pure TS ports.
 *
 * Lifecycle:
 * - The Python microservice is started lazily on first conversion request
 * - It runs on 127.0.0.1 with an ephemeral port
 * - It is stopped during app shutdown
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { SqlGlotClient } from './sqlglot/sqlglot-client';
import type {
  TranspileOptions,
  TranspileResult,
  SQLDialect as SqlGlotDialect,
} from './sqlglot/types';
import type { PythonDepsResult } from '@joinery/shared';

import { BaseSingleton } from '../../utils/singleton';
import { PythonDepsService } from './python-deps';
import { createLogger } from '../../utils/logger';

const log = createLogger('SQLConverter');

const SERVER_SCRIPT = path.join('resources', 'python', 'sqlglot-server.py');

/**
 * Locate sqlglot-server.py.
 *
 * The script MUST live outside app.asar. Electron's asar shim virtualizes paths
 * for Node's own fs, so an in-asar path passes existsSync() — but a spawned
 * python3 is an external process and cannot read inside the archive. Serving it
 * from `resources/` means electron-builder's extraResources block copies it out.
 *
 * Exported for testing.
 */
export function resolveServerPath(): string {
  // Packaged: extraResources copies resources/ under process.resourcesPath.
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, SERVER_SCRIPT) : null;
  if (packaged && existsSync(packaged)) return packaged;

  // Dev / test: the repo copy. This file compiles to
  // packages/main/dist/services/sql/, so the repo root is five levels up —
  // the same depth as its TypeScript source, which keeps vitest working.
  const dev = path.resolve(__dirname, '..', '..', '..', '..', '..', SERVER_SCRIPT);
  if (existsSync(dev)) return dev;

  throw new Error(
    `sqlglot server script not found. Looked in: ${packaged ?? '(not packaged)'}, ${dev}`
  );
}

export interface ConversionResult {
  success: boolean;
  sql: string;
  sourceDialect: string;
  targetDialect: string;
  statements?: string[];
  warnings?: string[];
  error?: string;
  /**
   * Present only when the refusal was "this host cannot run the converter" (J-29). Carries the
   * probe so the renderer can offer the same guided fix the backup dialogs give a missing
   * `pg_dump`, instead of restating `error` and leaving the user to find the Prerequisites page.
   */
  pythonDeps?: PythonDepsResult;
}

// Map our engine names to sqlglot dialect names
const DIALECT_MAP: Record<string, SqlGlotDialect> = {
  mssql: 'tsql',
  postgresql: 'postgres',
  mysql: 'mysql',
};

/** The slice of SqlGlotClient this service uses, so tests can inject a fake. */
export interface SqlGlotClientLike {
  readonly IsRunning: boolean;
  readonly Port: number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  transpile(sql: string, options: TranspileOptions): Promise<TranspileResult>;
}

/**
 * Thrown when no host Python can run the converter. Carries the probe so a caller can render the
 * platform-specific fix rather than restating a one-line complaint (J-29).
 */
export class PythonUnavailableError extends Error {
  constructor(readonly deps: PythonDepsResult) {
    super(describeMissingPython(deps));
    this.name = 'PythonUnavailableError';
  }
}

/**
 * The module named by a Python `ModuleNotFoundError`, if the failure is one (J-119).
 *
 * The probe answers "is it installed?" with `find_spec`, which a half-installed package satisfies
 * and then fails to import. Reading the module out of the traceback is what keeps that case from
 * falling through to the interpreter branch, which is where it landed before — and where the
 * advice was to install an interpreter that was never missing.
 */
function missingModuleFrom(message: string): string | undefined {
  const match = /No module named ['"]([\w.]+)['"]/.exec(message);
  return match?.[1];
}

/** The message a user reads. It names the command to run, because that is the whole fix. */
function describeMissingPython(deps: PythonDepsResult): string {
  const install = deps.installInstructions?.steps.find(step => step.command)?.command;
  const fix = install === undefined ? '' : ` Run: ${install}`;

  if (deps.command === null) {
    return `SQL conversion needs Python 3, and none was found (tried python3, python${
      deps.platform === 'win32' ? ', py' : ''
    }).${fix}`;
  }

  const missing = deps.modules.filter(status => !status.available).map(status => status.module);
  return `SQL conversion needs the ${missing.join(', ')} package${
    missing.length === 1 ? '' : 's'
  } for ${deps.command}, which ${missing.length === 1 ? 'is' : 'are'} not installed.${fix}`;
}

export class SQLConverterService extends BaseSingleton {
  private client: SqlGlotClientLike | null;
  private starting: Promise<void> | null = null;

  /**
   * @param client Optional pre-built client. Omit in production — the real one
   * is constructed lazily so that a missing server script surfaces on first
   * conversion rather than throwing while the singleton is being created.
   */
  /** True when the client came from a caller, so nothing here will ever spawn Python. */
  private readonly clientWasInjected: boolean;

  constructor(client?: SqlGlotClientLike) {
    super();
    this.client = client ?? null;
    this.clientWasInjected = client !== undefined;
  }

  private getClient(pythonPath?: string): SqlGlotClientLike {
    if (!this.client) {
      this.client = new SqlGlotClient({
        serverPath: resolveServerPath(),
        startupTimeoutMs: 15000,
        requestTimeoutMs: 30000,
        // Whatever the probe found. Omitted only when a caller injected a client (tests), where
        // the default `python3` is as good as any (J-29).
        ...(pythonPath === undefined ? {} : { pythonPath }),
      });
    }
    return this.client;
  }

  /**
   * Ensure the Python microservice is running
   */
  private async ensureRunning(): Promise<void> {
    // Probe before spawning, so the failure names what is actually missing: `spawn('python3')` is
    // wrong on Windows whatever is installed, and "Python 3 is required" was useless advice on a
    // machine that has Python 3 and no sqlglot (J-29). Cached after the first call.
    //
    // Only on the path that really spawns an interpreter. An injected client is somebody else's
    // transport — gating it on this host's Python would be a probe of the wrong machine.
    let pythonPath: string | undefined;
    if (!this.clientWasInjected) {
      const deps = await PythonDepsService.getInstance().check();
      if (!deps.ready) throw new PythonUnavailableError(deps);
      pythonPath = deps.command ?? undefined;
    }

    const client = this.getClient(pythonPath);
    if (client.IsRunning) return;

    // Serialize concurrent start requests
    if (!this.starting) {
      this.starting = client
        .start()
        .then(() => {
          log.info(`sqlglot microservice started on port ${client.Port}`);
          this.starting = null;
        })
        .catch(err => {
          this.starting = null;
          throw err;
        });
    }

    return this.starting;
  }

  /**
   * Convert SQL from one dialect to another
   */
  async convert(sql: string, fromEngine: string, toEngine: string): Promise<ConversionResult> {
    const fromDialect = DIALECT_MAP[fromEngine] || fromEngine;
    const toDialect = DIALECT_MAP[toEngine] || toEngine;

    try {
      await this.ensureRunning();

      const result: TranspileResult = await this.getClient().transpile(sql, {
        fromDialect,
        toDialect,
        pretty: true,
        errorLevel: 'WARN',
      });

      log.info(
        `Converted SQL from ${fromDialect} to ${toDialect} (${result.statements.length} statements)`
      );

      return {
        success: result.success,
        sql: result.sql,
        sourceDialect: fromDialect,
        targetDialect: toDialect,
        statements: result.statements,
        warnings: result.warnings,
        error: result.errors.length > 0 ? result.errors.join('\n') : undefined,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`SQL conversion failed: ${errorMsg}`);

      // Check for common issues. Order matters: a missing server script names a
      // path containing "python", so it must be matched before the Python check
      // or a packaging fault gets reported as a missing interpreter.
      let userError = errorMsg;
      let pythonDeps: PythonDepsResult | undefined;
      if (err instanceof PythonUnavailableError) {
        pythonDeps = err.deps;
        // Already the precise message: which interpreter names were tried, or which packages are
        // missing from the one that ran, and the command that fixes it (J-29).
        userError = errorMsg;
      } else if (errorMsg.includes('server script not found')) {
        userError =
          'SQL conversion is unavailable: the sqlglot server script is missing from this build.';
      } else if (missingModuleFrom(errorMsg) !== undefined) {
        // The probe uses `find_spec`, which answers "installed?" and not "imports cleanly?" — a
        // half-installed package passes it and then raises at startup. J-119: this used to be
        // classified by looking for the substring `python`, which the traceback ALWAYS contains
        // (the script lives in a folder called `python`), so a missing `fastapi` was reported as
        // a missing interpreter and the user was told to install Python they already had.
        const missing = missingModuleFrom(errorMsg);
        userError =
          `SQL conversion could not import ${missing}, even though it looked installed. ` +
          `Reinstall it: python3 -m pip install --force-reinstall ${missing}`;
      } else if (errorMsg.includes('ENOENT') || errorMsg.includes('python')) {
        // Reached only when the probe passed and the spawn failed anyway — the interpreter moved,
        // or is not executable. Naming the probe's own answer beats guessing.
        userError =
          'SQL conversion could not start its Python helper, even though a suitable interpreter ' +
          'was found. Check that the interpreter is still installed and executable.';
      } else if (errorMsg.includes('timeout')) {
        userError =
          'SQL conversion service timed out. The microservice may still be starting — try again.';
      }

      return {
        success: false,
        sql,
        sourceDialect: fromDialect,
        targetDialect: toDialect,
        error: userError,
        ...(pythonDeps === undefined ? {} : { pythonDeps }),
      };
    }
  }

  /**
   * Check if the converter service is running
   */
  isRunning(): boolean {
    return this.client?.IsRunning ?? false;
  }

  /**
   * Stop the Python microservice (called during app shutdown).
   *
   * Deliberately does NOT construct a client: if conversion was never used there
   * is nothing to stop, and shutdown must not fail just because the server
   * script is missing from the build.
   */
  async stop(): Promise<void> {
    if (!this.client?.IsRunning) return;
    log.info('Stopping sqlglot microservice...');
    await this.client.stop();
    log.info('sqlglot microservice stopped');
  }
}
