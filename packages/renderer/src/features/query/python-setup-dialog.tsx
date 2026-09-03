/**
 * The setup-instructions view for SQL dialect conversion (J-29 item 2).
 *
 * Conversion is not a JavaScript library: it spawns a Python microservice wrapping `sqlglot`, and
 * the interpreter and its four packages belong to the host — exactly like the `pg_dump` and
 * `mysqldump` binaries the backup services shell out to. That surface has had a guided,
 * platform-specific fix since Task 12; this one had a sentence in a toast, which is what made
 * "Python 3 is required" the most misleading string in the app.
 *
 * A dialog rather than an inline panel because conversion has no form of its own to replace: it is
 * a command, dispatched from the palette, the toolbar or the menu, and the refusal has to find the
 * user wherever they triggered it from.
 *
 * The probed well is the part worth having. It names the interpreter that was actually found and
 * which of the four packages it is missing, so a user who has "installed Python" can see that the
 * interpreter was never the problem.
 */

import type { PythonDepsResult } from '@joinery/shared';
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Icon,
  cn,
} from '../../ui';
import { SetupInstructions } from '../setup/setup-instructions';

export interface PythonSetupDialogProps {
  /** The probe behind the refusal. `null` closes the dialog. */
  readonly deps: PythonDepsResult | null;
  readonly rechecking: boolean;
  readonly onRecheck: () => void;
  readonly onCopyCommand: (command: string) => void;
  readonly onOpenLink: (url: string) => void;
  readonly onClose: () => void;
  readonly copiedCommand?: string;
}

export function PythonSetupDialog({
  deps,
  rechecking,
  onRecheck,
  onCopyCommand,
  onOpenLink,
  onClose,
  copiedCommand,
}: PythonSetupDialogProps) {
  // `installInstructions` is optional on the type and documented as present whenever `ready` is
  // false — which is the only way this dialog opens. Rendering nothing beats asserting.
  const instructions = deps?.installInstructions;
  if (deps === null || instructions === undefined) return null;

  return (
    <Dialog open onOpenChange={next => (next ? undefined : onClose())}>
      <DialogContent data-testid="python-setup-dialog">
        <DialogHeader>
          <DialogTitle>{instructions.title}</DialogTitle>
          <DialogDescription>
            Converting between SQL dialects runs a small local Python service. Joinery does not
            bundle it — the interpreter and its packages come from this machine.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <header className="flex items-start gap-3">
            <Icon icon={TriangleAlert} size="lg" className="mt-0.5 shrink-0 stroke-warning" />
            <p className="text-md text-fg-muted text-pretty">
              {deps.command === null
                ? 'No Python interpreter could be run under any of the names Joinery tries.'
                : `Joinery found ${deps.command}${
                    deps.version === undefined ? '' : ` (${deps.version})`
                  }, but it is missing packages the converter imports.`}
            </p>
          </header>

          <div className="flex flex-col gap-1.5 rounded-sm border border-rule bg-surface p-3">
            <p className="font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">Probed</p>
            {deps.command === null ? (
              <p className="text-sm text-fg-muted" data-testid="python-setup-no-interpreter">
                {/* The names the probe actually ran, sent up by `PythonDepsService` — not a list
                    repeated here, which is how this line came to claim JOINERY_PYTHON was tried on
                    a build that refuses it (J-171). */}
                Tried {deps.tried.join(', ')}.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {deps.modules.map(status => (
                  <li
                    key={status.module}
                    data-testid={`python-module-${status.module}`}
                    className="flex items-center gap-2 text-base"
                  >
                    <Icon
                      icon={status.available ? CircleCheck : CircleX}
                      size="sm"
                      label={status.available ? 'installed' : 'missing'}
                      className={cn(
                        'shrink-0',
                        status.available ? 'stroke-success' : 'stroke-danger'
                      )}
                    />
                    <code className="font-mono text-sm text-fg">{status.module}</code>
                    {status.available ? null : (
                      <span className="font-mono text-2xs tracking-eyebrow text-danger uppercase">
                        missing
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <SetupInstructions
            steps={instructions.steps}
            notes={instructions.notes}
            testIdPrefix="python-setup"
            recheckTestId="python-setup-recheck"
            rechecking={rechecking}
            onRecheck={onRecheck}
            recheckLabel="Check again"
            recheckingLabel="Checking…"
            onCopyCommand={onCopyCommand}
            onOpenLink={onOpenLink}
            copiedCommand={copiedCommand}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
