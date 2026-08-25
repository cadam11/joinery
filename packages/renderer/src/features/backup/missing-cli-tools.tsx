/**
 * The setup-instructions view, shown **in place of the backup form** when this machine is missing
 * one of the binaries Joinery shells out to (`pg_dump`, `pg_restore`, `mysqldump`, `mysql`).
 *
 * Replaces `shared/components/missing-cli-tools/missing-cli-tools.component.ts` (352 LOC). This is a
 * first-class UX path, not an error state: CLAUDE.md's own reasoning is that the tools are
 * deliberately not bundled, so a host without them is an ordinary configuration rather than a fault,
 * and the fix is a two-command install the user can do in another window and then re-check without
 * closing the dialog.
 *
 * ── The three legacy testids ────────────────────────────────────────────────────────────────
 *
 * `missing-cli-tools`, `tool-status-<tool>` and `missing-cli-tools-recheck` are three of the seven
 * `data-testid`s that existed anywhere in the Angular renderer, and `tests/e2e/backup-cli-deps.spec.ts`
 * asserts on all three. They are kept **verbatim** — the ids are the one part of that component worth
 * inheriting, and renaming them would break the only spec that proves this branch is reachable at
 * all. Everything new here is `backup-tools-*`.
 *
 * ── Amber, and only amber ───────────────────────────────────────────────────────────────────
 *
 * HOUSE-RULES §5 names missing CLI tools as amber's job by name: non-destructive caution, nothing has
 * failed and nothing is lost. The per-tool "missing" flag is `text-danger` because it states a fact
 * about one probe rather than the mood of the panel, and the panel carries the app's one filled oxide
 * affordance for this surface (Re-check), which is legal because a dialog is its own surface.
 */

import type { CliInstallInstructions, CliToolStatus } from '@joinery/shared';
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';

import { Icon, cn } from '../../ui';
import { SetupInstructions } from '../setup/setup-instructions';

/** How an engine is written when it is being talked about rather than switched on. */
const ENGINE_LABELS: Record<CliInstallInstructions['engine'], string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
};

export interface MissingCliToolsProps {
  readonly instructions: CliInstallInstructions;
  /** Every tool that was probed, available or not. Renders the "Probed" well. */
  readonly tools: readonly CliToolStatus[];
  /** A re-check is in flight. */
  readonly rechecking: boolean;
  readonly onRecheck: () => void;
  /** Copy a shell command. The caller owns the clipboard and the inline confirmation. */
  readonly onCopyCommand: (command: string) => void;
  /** Open a download page in the host browser, through `app.openExternal`. */
  readonly onOpenLink: (url: string) => void;
  /** Which command the caller most recently copied, so the button can say so. */
  readonly copiedCommand?: string;
}

export function MissingCliTools({
  instructions,
  tools,
  rechecking,
  onRecheck,
  onCopyCommand,
  onOpenLink,
  copiedCommand,
}: MissingCliToolsProps) {
  const engineLabel = ENGINE_LABELS[instructions.engine];

  return (
    <section className="flex flex-col gap-4" data-testid="missing-cli-tools">
      <header className="flex items-start gap-3">
        <Icon icon={TriangleAlert} size="lg" className="mt-0.5 shrink-0 stroke-warning" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-lg text-fg text-balance">{instructions.title}</h3>
          <p className="text-md text-fg-muted text-pretty">
            Joinery needs the {engineLabel} command-line tools on this machine to back up and
            restore databases. They are not bundled with the app.
          </p>
        </div>
      </header>

      {tools.length === 0 ? null : (
        <div className="flex flex-col gap-1.5 rounded-sm border border-rule bg-surface p-3">
          <p className="font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">Probed</p>
          <ul className="flex flex-col gap-1">
            {tools.map(tool => (
              <li
                key={tool.tool}
                data-testid={`tool-status-${tool.tool}`}
                className="flex items-center gap-2 text-base"
              >
                <Icon
                  icon={tool.available ? CircleCheck : CircleX}
                  size="sm"
                  label={tool.available ? 'found' : 'missing'}
                  className={cn('shrink-0', tool.available ? 'stroke-success' : 'stroke-danger')}
                />
                <code className="font-mono text-sm text-fg">{tool.tool}</code>
                {tool.version === undefined ? null : (
                  <span className="min-w-0 truncate font-mono text-sm text-fg-muted">
                    {tool.version}
                  </span>
                )}
                {tool.available ? null : (
                  <span className="font-mono text-2xs tracking-eyebrow text-danger uppercase">
                    missing
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <SetupInstructions
        steps={instructions.steps}
        notes={instructions.notes}
        testIdPrefix="backup-tools"
        recheckTestId="missing-cli-tools-recheck"
        rechecking={rechecking}
        onRecheck={onRecheck}
        recheckLabel="Re-check"
        recheckingLabel="Re-checking…"
        onCopyCommand={onCopyCommand}
        onOpenLink={onOpenLink}
        copiedCommand={copiedCommand}
      />
    </section>
  );
}
