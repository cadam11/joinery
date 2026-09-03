/**
 * Find a Python that can run `sqlglot-server.py`, and say precisely what is missing when none can
 * (J-29).
 *
 * Three separate failures used to look identical — a bare "Python 3 is required for SQL
 * conversion":
 *
 *  1. **Windows.** `spawn('python3')` fails there whatever is installed; the interpreter is
 *     `python`, or the `py` launcher. Nothing probed for a working name.
 *  2. **Python present, modules absent.** The common case on a developer machine, where the advice
 *     "install Python 3" does nothing at all.
 *  3. **Neither.**
 *
 * The probe answers which. It mirrors `cli-deps.ts` — same caching, same `recheck`, same
 * instructions shape — so the setup-instructions view the backup dialogs already have can be given
 * the same treatment here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  getPythonInstallInstructions,
  PYTHON_MODULES,
  type PythonDepsResult,
  type PythonModule,
  type PythonModuleStatus,
} from '@joinery/shared';

import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { runtimeSignals, type RuntimeSignals } from '../../utils/runtime-mode';

const log = createLogger('PythonDeps');

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

/** One interpreter to try: a command and the arguments it needs before ours. */
interface Candidate {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Prints one JSON object saying which modules import, in one interpreter start.
 *
 * `find_spec` rather than `import`: importing `uvicorn` costs real time, and the question here is
 * whether it is installed, not whether it initialises.
 */
const MODULE_PROBE = [
  'import json, importlib.util as u',
  `print(json.dumps({m: u.find_spec(m) is not None for m in ${JSON.stringify([...PYTHON_MODULES])}}))`,
].join('; ');

/**
 * Environment variable naming the interpreter to try first.
 *
 * Read here and nowhere else, which `utils/env-hatch-gating.spec.ts` enforces — and, since J-171,
 * honoured only while the app is UNPACKAGED.
 */
export const PYTHON_ENV_VAR = 'JOINERY_PYTHON';

/**
 * Warned already? Module scope on purpose: the probe re-runs on every `recheck()` — the setup
 * dialog's "Check again" button — and a user whose shell exports this variable should get one line
 * in the Output panel, not one per press. The precedent is `services/docker/docker-fixture.ts`,
 * which also logs its refusal inline; `service-name.ts` is deliberately pure and hands its warning
 * back for the caller to log, which is not available here because `candidates()` has no caller
 * placed to say it.
 */
let warnedAboutRefusal = false;

/**
 * The interpreter path this build takes from the environment, or `null`.
 *
 * Gated (J-171), and STRICTER than every other hatch: refused by any packaged bundle, including one
 * stamped with the J-167 test marker. This variable is not a redirected read — it names the
 * EXECUTABLE that gets spawned inside the signed app's process tree, and on macOS a child is
 * generally attributed to its responsible process, so it inherits Joinery's TCC grants. A launcher
 * that can set the environment of a shipped Joinery could therefore run its own binary with
 * Joinery's permissions. Nothing in `scripts/release/`, `tests/smoke-packaged/` or any Playwright
 * config sets it for a packaged run, so reopening it for a stamped bundle would buy uniformity and
 * nothing else. `utils/env-hatch-gating.spec.ts` pins the difference from all four sides.
 *
 * Refused and warned rather than fatal, matching `services/docker/docker-fixture.ts`: a user whose
 * shell exports this must still get a working converter, which the `python3` / `python` / `py -3`
 * candidates below still give them.
 *
 * The cost is real and is why this stayed ungated until now: a release user whose packages live in
 * a virtualenv has lost the documented way to point Joinery at that interpreter, and must install
 * them into the interpreter Joinery finds instead. Persisting the path through Settings (J-171's
 * remainder) is the replacement.
 */
export function resolvePythonOverride(signals: RuntimeSignals): string | null {
  const configured = signals.env[PYTHON_ENV_VAR];
  if (!configured) return null;

  if (signals.isPackaged) {
    if (!warnedAboutRefusal) {
      warnedAboutRefusal = true;
      log.warn(
        `${PYTHON_ENV_VAR} is set, but this Joinery ignores it and finds its own Python. It is ` +
          `honoured only by a development build. Install the packages into the interpreter ` +
          `Joinery finds, and unset it to silence this warning.`
      );
    }
    return null;
  }

  return configured;
}

/**
 * Candidates in order. `JOINERY_PYTHON` wins — the integration suite already honours it to point at
 * a virtualenv, and a user who set it means it.
 */
function candidates(platform: string, signals: RuntimeSignals): Candidate[] {
  const configured = resolvePythonOverride(signals);
  const found: Candidate[] = configured ? [{ command: configured, args: [] }] : [];

  found.push({ command: 'python3', args: [] }, { command: 'python', args: [] });
  // The Windows launcher, which is present when `python3` is not.
  if (platform === 'win32') found.push({ command: 'py', args: ['-3'] });

  return found;
}

export class PythonDepsService extends BaseSingleton {
  private cached: PythonDepsResult | null = null;

  /** The cached probe, running one if this is the first ask. */
  async check(): Promise<PythonDepsResult> {
    if (this.cached) return this.cached;
    this.cached = await this.probe();
    return this.cached;
  }

  /** Probe again, ignoring the cache — for after the user has installed something. */
  async recheck(): Promise<PythonDepsResult> {
    this.cached = null;
    return this.check();
  }

  private async probe(): Promise<PythonDepsResult> {
    const platform = process.platform;
    const tried = candidates(platform, runtimeSignals());
    const triedNames = tried.map(candidate => [candidate.command, ...candidate.args].join(' '));

    for (const candidate of tried) {
      const modules = await this.probeModules(candidate);
      if (modules === null) continue; // this interpreter did not run at all

      const ready = modules.every(status => status.available);
      const version = await this.probeVersion(candidate);

      log.info(
        ready
          ? `SQL conversion will use ${candidate.command}${version ? ` (${version})` : ''}`
          : `${candidate.command} is missing: ${modules
              .filter(status => !status.available)
              .map(status => status.module)
              .join(', ')}`
      );

      return {
        platform,
        command: candidate.command,
        commandArgs: [...candidate.args],
        tried: triedNames,
        version,
        modules,
        ready,
        ...(ready ? {} : { installInstructions: getPythonInstallInstructions(platform) }),
      };
    }

    log.warn('No Python interpreter could be run for SQL conversion.');
    return {
      platform,
      command: null,
      commandArgs: [],
      tried: triedNames,
      modules: [],
      ready: false,
      installInstructions: getPythonInstallInstructions(platform),
    };
  }

  /** `null` when the interpreter itself could not be run; otherwise one status per module. */
  private async probeModules(candidate: Candidate): Promise<PythonModuleStatus[] | null> {
    try {
      const { stdout } = await run(candidate.command, [...candidate.args, '-c', MODULE_PROBE], {
        timeout: PROBE_TIMEOUT_MS,
      });
      const parsed = JSON.parse(stdout) as Record<PythonModule, boolean>;
      return PYTHON_MODULES.map(module => ({ module, available: parsed[module] === true }));
    } catch (error) {
      // ENOENT is the expected answer for a name this host does not have; anything else is worth
      // a line, because it is the difference between "not installed" and "installed and broken".
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.debug(`Probing ${candidate.command} failed (${code ?? 'no code'})`);
      }
      return null;
    }
  }

  private async probeVersion(candidate: Candidate): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await run(candidate.command, [...candidate.args, '--version'], {
        timeout: PROBE_TIMEOUT_MS,
      });
      // Python 3.4 and earlier print the version on stderr; harmless to prefer stdout.
      return stdout.trim() || stderr.trim() || undefined;
    } catch {
      // A version string is decoration. The modules probe above already answered the real question.
      return undefined;
    }
  }
}
