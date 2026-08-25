/**
 * J-29 item 2: conversion's refusal was a toast; the backup surface has had a guided fix for a
 * missing `pg_dump` since Task 12. These assert the two shapes the probe can hand this dialog —
 * an interpreter that is missing packages, and no interpreter at all — because they are different
 * problems with different fixes, and the old single sentence conflated exactly those two.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PythonDepsResult } from '@joinery/shared';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../ui';
import { PythonSetupDialog, type PythonSetupDialogProps } from './python-setup-dialog';

const INSTRUCTIONS = {
  platform: 'darwin' as const,
  title: 'SQL conversion needs Python 3 and the sqlglot package',
  steps: [
    { description: 'Install the packages.', command: 'python3 -m pip install --user sqlglot' },
    { description: 'Reopen the conversion panel.' },
  ],
  notes: ['Set JOINERY_PYTHON to point at a virtualenv.'],
};

function depsMissingPackages(): PythonDepsResult {
  return {
    platform: 'darwin',
    command: 'python3',
    commandArgs: [],
    version: 'Python 3.14.6',
    modules: [
      { module: 'sqlglot', available: false },
      { module: 'fastapi', available: true },
      { module: 'uvicorn', available: true },
      { module: 'pydantic', available: true },
    ],
    ready: false,
    installInstructions: INSTRUCTIONS,
  };
}

function depsNoInterpreter(): PythonDepsResult {
  return {
    platform: 'win32',
    command: null,
    commandArgs: [],
    modules: [],
    ready: false,
    installInstructions: { ...INSTRUCTIONS, platform: 'win32' },
  };
}

function mount(deps: PythonDepsResult | null, overrides: Partial<PythonSetupDialogProps> = {}) {
  const props: PythonSetupDialogProps = {
    deps,
    rechecking: false,
    onRecheck: vi.fn(),
    onCopyCommand: vi.fn(),
    onOpenLink: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  // The shell mounts `TooltipProvider` once; the copy button's tooltip needs it here too.
  render(
    <TooltipProvider>
      <PythonSetupDialog {...props} />
    </TooltipProvider>
  );
  return props;
}

describe('the SQL-conversion setup dialog', () => {
  it('stays shut when nothing refused a conversion', () => {
    mount(null);
    expect(screen.queryByTestId('python-setup-dialog')).toBeNull();
  });

  it('names the interpreter it found, so "install Python" is visibly not the fix', () => {
    mount(depsMissingPackages());

    expect(screen.getByTestId('python-setup-dialog')).toBeTruthy();
    expect(document.body.textContent).toContain('python3');
    expect(document.body.textContent).toContain('Python 3.14.6');
  });

  it('marks each package found or missing, one row apiece', () => {
    mount(depsMissingPackages());

    expect(screen.getByTestId('python-module-sqlglot').textContent).toContain('missing');
    expect(screen.getByTestId('python-module-fastapi').textContent).not.toContain('missing');
    expect(screen.getByTestId('python-module-pydantic')).toBeTruthy();
  });

  it('says which names were tried when no interpreter ran at all', () => {
    mount(depsNoInterpreter());

    const probed = screen.getByTestId('python-setup-no-interpreter');
    expect(probed.textContent).toContain('python3');
    // The Windows launcher is only named on Windows, where it is the one that usually works.
    expect(probed.textContent).toContain('py -3');
    // No module rows: nothing ran, so nothing could be imported to find out.
    expect(screen.queryByTestId('python-module-sqlglot')).toBeNull();
  });

  it('renders the steps and the copyable command', async () => {
    const user = userEvent.setup();
    const props = mount(depsMissingPackages());

    expect(screen.getByTestId('python-setup-steps')).toBeTruthy();
    await user.click(screen.getByTestId('python-setup-copy-0'));

    expect(props.onCopyCommand).toHaveBeenCalledExactlyOnceWith(
      'python3 -m pip install --user sqlglot'
    );
  });

  it('offers a re-check, because the probe is cached for the life of the app', async () => {
    const user = userEvent.setup();
    const props = mount(depsMissingPackages());

    await user.click(screen.getByTestId('python-setup-recheck'));
    expect(props.onRecheck).toHaveBeenCalledOnce();
  });

  it('disables the re-check while one is in flight', () => {
    mount(depsMissingPackages(), { rechecking: true });
    expect(screen.getByTestId('python-setup-recheck').hasAttribute('disabled')).toBe(true);
  });
});
