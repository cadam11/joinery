/**
 * J-29: three different failures all surfaced as "Python 3 is required for SQL conversion".
 *
 * The probe exists to tell them apart — no interpreter at all, an interpreter missing packages,
 * and (on Windows) an interpreter that is there under a name nobody looked for. These tests run a
 * REAL interpreter through `JOINERY_PYTHON`, because the thing being tested is whether spawning
 * and parsing works, which a mock cannot answer.
 */

import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PythonDepsService } from './python-deps';

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
