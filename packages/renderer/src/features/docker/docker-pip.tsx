/**
 * The status bar's Docker pip, and the popover it anchors.
 *
 * Task 7 left this slot empty on purpose rather than faking it (`shell/status-bar.tsx`'s header says so);
 * this is the slot filled, and the pip's numbers come from the same `useDocker()` the panel reads, so the
 * two cannot disagree.
 *
 * ── Why the `open-docker-panel` handler lives HERE ──────────────────────────────────────────
 *
 * Every other command whose job is to OPEN a surface is handled by an always-mounted shell component,
 * because a handler inside a closed surface could only ever close it. This one is different: the status
 * bar is never unmounted, and Radix needs the trigger and the content in one tree to anchor the popover
 * at all. So the component that renders the trigger is also the one that is always there, and a separate
 * shell mount would have to reach into this one's state to do the same job.
 *
 * ── The four states, and the one colour each ────────────────────────────────────────────────
 *
 * `DockerPipState` is a closed set (`docker-model.ts`), so the glyph and the tooltip are lookups rather
 * than a chain of `&&`s in a template — which is what the Angular version had, with three `[class.…]`
 * bindings whose first condition (`!dockerStatus()?.isRunning`) also matched "still checking".
 *
 * No brand colours: the Angular pip was `<i class="devicon-docker-plain colored">`, a third-party icon
 * font painting Docker's own blue into a bar HOUSE-RULES §5 says has no blue in it.
 */

import { Container } from 'lucide-react';

import { useCommand } from '../../commands';
import { Icon, Popover, PopoverContent, PopoverTrigger, Tooltip, cn } from '../../ui';
import type { DockerPipState } from './docker-model';
import { DockerPanel } from './docker-panel';
import { useDocker } from './use-docker';

/** The glyph's tone per state. Layer 2 tokens only, and no blue anywhere. */
const PIP_TONE: Record<DockerPipState, string> = {
  checking: 'stroke-fg-subtle',
  absent: 'stroke-fg-subtle',
  stopped: 'stroke-warning',
  idle: 'stroke-fg-muted',
  running: 'stroke-success',
};

export interface DockerPipProps {
  /** The status bar's one control shape, passed in so this button matches its four siblings exactly. */
  readonly controlClassName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function DockerPip({ controlClassName, open, onOpenChange }: DockerPipProps) {
  const { pip } = useDocker();

  // The palette's entry. Open rather than toggle: a user who typed "Docker containers" wants it open,
  // and a toggle would close it for anyone who pressed ⌘K with it already up.
  useCommand('open-docker-panel', () => onOpenChange(true));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip content={pip.tooltip}>
        <PopoverTrigger
          aria-label={pip.tooltip}
          data-testid="status-docker-toggle"
          data-docker-state={pip.state}
          className={cn(controlClassName)}
        >
          <Icon icon={Container} size="sm" className={PIP_TONE[pip.state]} />
          {/* The count only above zero, as the Angular pip had it — a bare "0" beside a grey glyph
              says nothing the glyph does not. */}
          {pip.runningCount > 0 ? (
            <span data-testid="status-docker-count" className="tabular-nums">
              {pip.runningCount}
            </span>
          ) : null}
        </PopoverTrigger>
      </Tooltip>
      {/* `side="top"` because the bar is at the bottom of a fixed window; Radix's collision handling
          takes it from there. `w-96` overrides the primitive's default 288px: this panel holds a row per
          container with a path pair under it, and 288px truncates every one of them. */}
      <PopoverContent
        align="end"
        side="top"
        className="w-96 p-0"
        data-testid="docker-popover"
        // No Escape handler here any more. It used to be local, because Radix's own dismissal
        // measurably did not fire for this panel; `ui/popover.tsx`'s header now carries the root cause
        // (a Radix tooltip's content is a dismissable layer of its own, and every control in this panel
        // is tooltipped, so the tip was taking the key) and the primitive handles it — J-72.
      >
        <DockerPanel />
      </PopoverContent>
    </Popover>
  );
}
