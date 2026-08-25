/**
 * The steps half of a setup-instructions view: numbered steps, copyable commands, external links,
 * notes, and the Re-check button.
 *
 * Extracted from `features/backup/missing-cli-tools.tsx` when SQL conversion needed the same
 * treatment for a missing Python (J-29). Both surfaces state the same kind of thing — a host
 * configuration Joinery deliberately does not bundle, with a fix the user performs in another
 * window and then re-checks without closing anything — so they should not drift apart in wording,
 * spacing or affordance count.
 *
 * **`testIdPrefix` is why this is a prop and not a constant.** `missing-cli-tools`,
 * `tool-status-<tool>` and `missing-cli-tools-recheck` are legacy ids that `tests/e2e-react`
 * asserts on verbatim; they are the backup view's contract and must not move. The Python view gets
 * `python-setup-*` and owes nothing to that history.
 *
 * Presentational only: the clipboard, the external-link call and the re-check all belong to the
 * caller, so the side effects stay visible where they are performed.
 */

import type { CliInstallStep } from '@joinery/shared';
import { CircleCheck, Copy, ExternalLink, RefreshCw } from 'lucide-react';

import { Button, Spinner, Tooltip } from '../../ui';

export interface SetupInstructionsProps {
  readonly steps: readonly CliInstallStep[];
  readonly notes?: readonly string[];
  /** Prefixes the steps, notes, copy and link `data-testid`s. See the note above. */
  readonly testIdPrefix: string;
  /**
   * The Re-check button's id, passed separately because the backup view's is
   * `missing-cli-tools-recheck` — not `backup-tools-recheck` — and `tests/e2e-react` asserts it.
   * Deriving it from the prefix would have quietly renamed a legacy contract.
   */
  readonly recheckTestId: string;
  readonly rechecking: boolean;
  readonly onRecheck: () => void;
  readonly recheckLabel: string;
  /** The spinner's accessible label while a re-check is in flight. */
  readonly recheckingLabel: string;
  /** The caller owns the clipboard and the inline confirmation. */
  readonly onCopyCommand: (command: string) => void;
  /** Opens in the host browser, through `app.openExternal`. */
  readonly onOpenLink: (url: string) => void;
  readonly copiedCommand?: string;
}

export function SetupInstructions({
  steps,
  notes,
  testIdPrefix,
  recheckTestId,
  rechecking,
  onRecheck,
  recheckLabel,
  recheckingLabel,
  onCopyCommand,
  onOpenLink,
  copiedCommand,
}: SetupInstructionsProps) {
  return (
    <>
      {/* An ordered list, because the steps are a sequence and a screen reader should say so. The
          numerals are rendered as a pip per step rather than as a marker, so a step with a command
          block still lines up. */}
      <ol className="flex flex-col gap-3.5" data-testid={`${testIdPrefix}-steps`}>
        {steps.map((step, index) => (
          <li key={step.description} className="flex items-start gap-3">
            {/* A ruled pip, NOT a filled oxide one: HOUSE-RULES §5 allows one filled oxide
                affordance per surface, and the Re-check button spends it. */}
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full border border-rule-strong font-mono text-2xs text-fg-muted tabular-nums"
            >
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-md text-fg text-pretty">{step.description}</p>

              {step.command === undefined ? null : (
                <div className="flex items-center gap-1 rounded-sm border border-rule bg-canvas py-1.5 pr-1 pl-2">
                  <code className="min-w-0 flex-1 font-mono text-sm break-all text-fg">
                    {step.command}
                  </code>
                  <Tooltip content={copiedCommand === step.command ? 'Copied' : 'Copy'}>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      leadingIcon={copiedCommand === step.command ? CircleCheck : Copy}
                      // A stable accessible name — it says what the button DOES, and must not
                      // change when the tick appears. `data-copied` carries the transient state,
                      // which is what the tests assert on: a flipping `aria-label` would be the
                      // wrong contract AND an assertion that passes before the click.
                      aria-label={`Copy ${step.command}`}
                      data-copied={copiedCommand === step.command ? 'true' : undefined}
                      data-testid={`${testIdPrefix}-copy-${index}`}
                      onClick={() => onCopyCommand(step.command ?? '')}
                    />
                  </Tooltip>
                </div>
              )}

              {step.link === undefined ? null : (
                /* A button, not an anchor: there is no navigable href — the URL is handed to the
                   host browser through `app.openExternal`. */
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={ExternalLink}
                  className="self-start px-0"
                  data-testid={`${testIdPrefix}-link-${index}`}
                  onClick={() => onOpenLink(step.link?.url ?? '')}
                >
                  {step.link.label}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {notes === undefined || notes.length === 0 ? null : (
        <ul
          className="flex flex-col gap-1 rounded-sm border-l-2 border-warning bg-surface p-3"
          data-testid={`${testIdPrefix}-notes`}
        >
          {notes.map(note => (
            <li key={note} className="text-sm text-fg-muted text-pretty">
              {note}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          leadingIcon={rechecking ? undefined : RefreshCw}
          disabled={rechecking}
          data-testid={recheckTestId}
          onClick={onRecheck}
        >
          {rechecking ? <Spinner size="sm" label={recheckingLabel} /> : recheckLabel}
        </Button>
      </div>
    </>
  );
}
