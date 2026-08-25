/**
 * How a user gets a Python that can run `sqlglot-server.py` (J-29).
 *
 * The same shape as `cli-install-instructions.ts`, for the same reason: the backup dialogs already
 * turn a missing `pg_dump` into a guided, platform-specific fix, and a missing `sqlglot` deserves
 * the same rather than "Python 3 is required for SQL conversion".
 *
 * The module list is deliberately spelled out in the command. A machine with Python 3 installed and
 * `sqlglot` missing is the common case, and "install Python 3" would be advice that does nothing.
 */

import type { CliInstructionsPlatform } from '../types/cli-deps.types';
import { PYTHON_MODULES, type PythonInstallInstructions } from '../types/python-deps.types';

const MODULES = PYTHON_MODULES.join(' ');

const SUPPORTED: Record<CliInstructionsPlatform, PythonInstallInstructions> = {
  darwin: {
    platform: 'darwin',
    title: 'SQL conversion needs Python 3 and the sqlglot package',
    steps: [
      {
        description:
          'Install Python 3 if you do not have it. macOS ships one, but Homebrew’s is easier to add packages to.',
        command: 'brew install python3',
      },
      {
        description: 'Install the four packages the converter imports.',
        command: `python3 -m pip install --user ${MODULES}`,
      },
      { description: 'Reopen the conversion panel — Joinery probes again each time it starts.' },
    ],
    notes: [
      'Set JOINERY_PYTHON to an interpreter path if you keep these packages in a virtualenv.',
    ],
  },
  win32: {
    platform: 'win32',
    title: 'SQL conversion needs Python 3 and the sqlglot package',
    steps: [
      {
        description: 'Install Python 3, ticking “Add python.exe to PATH” in the installer.',
        link: { url: 'https://www.python.org/downloads/windows/', label: 'python.org downloads' },
      },
      {
        description: 'Install the four packages the converter imports.',
        command: `py -3 -m pip install ${MODULES}`,
      },
      { description: 'Reopen the conversion panel — Joinery probes again each time it starts.' },
    ],
    notes: [
      'Joinery tries python3, python and the py launcher, so either installer layout works.',
      'Set JOINERY_PYTHON to an interpreter path if you keep these packages in a virtualenv.',
    ],
  },
};

const GENERIC: PythonInstallInstructions = {
  platform: 'generic',
  title: 'SQL conversion needs Python 3 and the sqlglot package',
  steps: [
    { description: 'Install Python 3 with your system package manager.' },
    {
      description: 'Install the four packages the converter imports.',
      command: `python3 -m pip install --user ${MODULES}`,
    },
  ],
  notes: ['Set JOINERY_PYTHON to an interpreter path if you keep these packages in a virtualenv.'],
};

export function getPythonInstallInstructions(platform: string): PythonInstallInstructions {
  if (platform === 'darwin' || platform === 'win32') return SUPPORTED[platform];
  return GENERIC;
}
