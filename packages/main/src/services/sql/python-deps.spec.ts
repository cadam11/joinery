/**
 * J-29: three different failures all surfaced as "Python 3 is required for SQL conversion".
 *
 * The probe exists to tell them apart — no interpreter at all, an interpreter missing packages,
 * and (on Windows) an interpreter that is there under a name nobody looked for. These tests run a
 * REAL interpreter through `JOINERY_PYTHON`, because the thing being tested is whether spawning
 * and parsing works, which a mock cannot answer.
 */

import { execFileSync } from 'node:child_process';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { onLogEntry } from '../../utils/logger';
import * as runtimeMode from '../../utils/runtime-mode';

import { PYTHON_ENV_VAR, PythonDepsService, resolvePythonOverride } from './python-deps';

const ORIGINAL = process.env.JOINERY_PYTHON;

/** A real python3 on this machine, or null — the modules it has are not this suite's business. */
function hostPython(): string | null {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return 'python3';
  } catch {
    return null;
  }
}

const python = hostPython();
const describeIfPython = python ? describe : describe.skip;

beforeEach(() => {
  PythonDepsService.resetInstance();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JOINERY_PYTHON;
  else process.env.JOINERY_PYTHON = ORIGINAL;
});

describe('when nothing can be run', () => {
  it('reports no interpreter rather than blaming the packages', async () => {
    process.env.JOINERY_PYTHON = '/nonexistent/python-that-is-not-there';
    PythonDepsService.resetInstance();

    const result = await PythonDepsService.getInstance().check();

    // The configured candidate fails, then python3/python are tried. On a machine with neither,
    // `command` is null; on one with python3, the fallback found it. Both are correct — what must
    // never happen is a crash or a claim that packages are missing when nothing ran.
    if (result.command === null) {
      expect(result.ready).toBe(false);
      expect(result.modules).toEqual([]);
      expect(result.installInstructions).toBeDefined();
    } else {
      expect(result.command).toBe('python3');
    }
  });

  it('always carries install instructions when it is not ready', async () => {
    process.env.JOINERY_PYTHON = '/nonexistent/python-that-is-not-there';
    PythonDepsService.resetInstance();

    const result = await PythonDepsService.getInstance().check();
    if (result.ready) return; // this machine has a working converter; nothing to assert

    expect(result.installInstructions?.steps.some(step => step.command)).toBe(true);
  });
});

describeIfPython('against a real interpreter', () => {
  beforeEach(() => {
    process.env.JOINERY_PYTHON = python as string;
    PythonDepsService.resetInstance();
  });

  it('names the interpreter it found and reports every module', async () => {
    const result = await PythonDepsService.getInstance().check();

    expect(result.command).toBe(python);
    expect(result.modules.map(status => status.module)).toEqual([
      'sqlglot',
      'fastapi',
      'uvicorn',
      'pydantic',
    ]);
  });

  it('reads a version string from the interpreter', async () => {
    const result = await PythonDepsService.getInstance().check();
    expect(result.version).toMatch(/Python 3/);
  });

  it('ties `ready` to every module being present, not to the interpreter existing', async () => {
    const result = await PythonDepsService.getInstance().check();
    expect(result.ready).toBe(result.modules.every(status => status.available));
  });

  it('caches, then probes again on recheck', async () => {
    const service = PythonDepsService.getInstance();
    const first = await service.check();
    expect(await service.check()).toBe(first); // same object: cached, not re-probed

    const rechecked = await service.recheck();
    expect(rechecked).not.toBe(first);
    expect(rechecked.command).toBe(first.command);
  });
});

/**
 * J-171: the interpreter path is the executable a signed Joinery spawns, so a PACKAGED bundle
 * refuses to take it from the environment. Stricter than every other hatch, which the J-167 test
 * marker reopens: this one is `isPackaged` alone, so a stamped bundle refuses it too. Pinned from
 * all four build combinations in `utils/env-hatch-gating.spec.ts`; here only the refusal's ONE side
 * effect is checked.
 *
 * The latch is module scope, so this must be the FIRST place in this file that drives the release
 * branch: a release-build call anywhere above would consume the single warning and leave this test
 * asserting nothing. The wiring suite below drives it too, which is why it comes after.
 */
describe('when a release bundle is told which interpreter to use', () => {
  function warningsWhile(run: () => void): string[] {
    const seen: string[] = [];
    const stop = onLogEntry(entry => {
      if (entry.level === 'warn' && entry.tag === 'PythonDeps') seen.push(entry.message);
    });
    try {
      run();
    } finally {
      stop();
    }
    return seen;
  }

  it('ignores it and says so exactly once, however often it is asked', () => {
    const release = { isPackaged: true, isTestBuild: false, env: { [PYTHON_ENV_VAR]: '/evil/py' } };

    const warnings = warningsWhile(() => {
      expect(resolvePythonOverride(release)).toBeNull();
      expect(resolvePythonOverride(release)).toBeNull();
      expect(resolvePythonOverride(release)).toBeNull();
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(PYTHON_ENV_VAR);
  });
});

/**
 * The gate is only worth having if the SERVICE reaches it (J-171 review, N6).
 *
 * Every other case here drives the pure `resolvePythonOverride`. Nothing pinned that `probe()`
 * hands it the REAL `runtimeSignals()` — a refactor to a hard-coded `{ isPackaged: false, env:
 * process.env }` would leave the whole suite green and reopen the hole. So this drives the real
 * `PythonDepsService.check()` and only replaces the signals gatherer, at the seam
 * `python-deps.ts` actually imports.
 *
 * The interpreter is a real one, named by ABSOLUTE path, so that honoured and refused give
 * different answers: honoured means `command` is that path, refused means the probe fell through
 * to the bare `python3` name.
 */
describeIfPython('the packaged gate, through the real service', () => {
  /**
   * `python3`'s own absolute path — a name the fall-through candidates can never produce.
   *
   * Resolved in `beforeAll`, not in this factory: `describe.skip` still RUNS the factory to collect
   * the cases it then skips, so spawning here would fail collection of the whole file on a host
   * with no `python3` — the exact host this suite is skipped for.
   */
  let absolute = '';

  beforeAll(() => {
    absolute = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'])
      .toString()
      .trim();
    expect(absolute.startsWith('/')).toBe(true);
  });

  beforeEach(() => {
    process.env.JOINERY_PYTHON = absolute;
    PythonDepsService.resetInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withBuild(isPackaged: boolean, isTestBuild: boolean): void {
    vi.spyOn(runtimeMode, 'runtimeSignals').mockReturnValue({
      isPackaged,
      isTestBuild,
      env: process.env,
    });
  }

  it('honours the override in a development build', async () => {
    withBuild(false, false);

    const result = await PythonDepsService.getInstance().check();

    expect(result.command).toBe(absolute);
    expect(result.tried[0]).toBe(absolute);
  });

  it('refuses it in a packaged bundle, stamped as a test build or not', async () => {
    for (const isTestBuild of [false, true]) {
      PythonDepsService.resetInstance();
      withBuild(true, isTestBuild);

      const result = await PythonDepsService.getInstance().check();

      expect(result.command).not.toBe(absolute);
      expect(result.tried).not.toContain(absolute);
    }
  });
});
