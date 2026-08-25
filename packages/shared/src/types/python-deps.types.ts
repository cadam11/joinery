/**
 * Types for the SQL-conversion Python dependency check (J-29).
 *
 * Dialect conversion is not a JavaScript library — it spawns
 * `resources/python/sqlglot-server.py`, a Python microservice wrapping the real `sqlglot`. The
 * interpreter and its modules are NOT bundled: they belong to the host, like the `pg_dump` and
 * `mysqldump` binaries the backup services shell out to. This mirrors `cli-deps.types.ts` on
 * purpose, so the same setup-instructions treatment fits both.
 *
 * The old failure was a bare "Python 3 is required for SQL conversion", on a machine where Python 3
 * might well be installed and only `sqlglot` missing — and on Windows, where the interpreter is
 * `python` or `py` and `spawn('python3')` fails regardless of what is installed.
 */

import type { CliInstallStep, CliInstructionsPlatform } from './cli-deps.types';

/** Every module `sqlglot-server.py` imports at startup. */
export const PYTHON_MODULES = ['sqlglot', 'fastapi', 'uvicorn', 'pydantic'] as const;

export type PythonModule = (typeof PYTHON_MODULES)[number];

/** One module's presence in the interpreter that was found. */
export interface PythonModuleStatus {
  module: PythonModule;
  available: boolean;
}

export interface PythonInstallInstructions {
  platform: CliInstructionsPlatform | 'generic';
  title: string;
  steps: CliInstallStep[];
  notes?: string[];
}

export interface PythonDepsResult {
  /** Raw `process.platform` string from the main process. */
  platform: string;
  /**
   * The command a working interpreter was found under — `python3`, `python`, `py`, or whatever
   * `JOINERY_PYTHON` names. `null` when no candidate ran at all.
   */
  command: string | null;
  /** Extra arguments the command needs, e.g. `['-3']` for the Windows `py` launcher. */
  commandArgs: string[];
  /** `<command> --version`, when one ran. */
  version?: string;
  /** Empty when no interpreter ran — nothing could be imported to find out. */
  modules: PythonModuleStatus[];
  /** An interpreter ran and every module imported. */
  ready: boolean;
  /** Populated when `ready` is false. */
  installInstructions?: PythonInstallInstructions;
}
