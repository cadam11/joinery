/**
 * Radix `Popover` — a non-modal panel anchored to a trigger, for things a menu cannot hold:
 * a filter form, a connection chip's detail, a colour/limit control.
 *
 * The line between this and `Dialog` is whether the workbench underneath must stay usable.
 * A popover is non-modal (no scrim, click-outside dismisses, the app keeps working); a
 * dialog blocks. If the flow is transactional, it is a dialog — PLAN §2.9.
 *
 * The line between this and `Tooltip` is whether the content is focusable. A popover can
 * contain controls; a tooltip is a sentence.
 *
 * ── Why this file owns Escape, when Radix ships an Escape (J-72) ─────────────────────────────
 *
 * Radix dismisses every overlay from ONE global layer stack. `DismissableLayer` keeps a
 * module-level `Set` of every mounted layer and attaches its `keydown` listener only while its
 * own layer is the last one in that set — `react-dismissable-layer@1.1.19/dist/index.mjs`:
 *
 *     const isHighestLayer = node ? index === layers.length - 1 : false;
 *     …
 *     if (!isHighestLayer) return;
 *     ownerDocument.addEventListener('keydown', handleKeyDown, { capture: true });
 *
 * A Radix **tooltip's content is one of those layers** — `react-tooltip@1.2.16` wraps it in
 * `DismissableLayer` with `onDismiss: onClose`. So focusing a tooltipped control INSIDE an open
 * popover pushes the tip on top of the popover, the popover's Escape listener is torn down for
 * as long as the tip is up, and the tooltip's listener eats the key (it calls
 * `event.preventDefault()` on its way out). One Escape closes the tip; the panel stays.
 *
 * That is the Docker panel exactly: every control in it is tooltipped, so a keyboard user could
 * not leave the panel. `docker-pip.tsx` carried a local `onKeyDown` for it; this is that
 * workaround turned into the primitive's behaviour, and the local one is gone.
 *
 * The rules the handler below follows, and why each matters:
 *
 *  - **Only an Escape that came from inside this panel.** Every nested overlay — a `Select`
 *    list, a menu, a tooltip — portals its content out of the panel's DOM subtree while staying
 *    inside its React tree, so React still bubbles their keydowns through here. Comparing
 *    against the panel's own element is what keeps one Escape to one surface: an Escape aimed at
 *    an open `Select` inside a popover closes the list only.
 *  - **Not gated on `event.defaultPrevented`.** The tooltip layer has already called
 *    `preventDefault()` in the precise case this exists for, so gating on it would restore the
 *    bug.
 *  - **Skipped when Radix's own layer already took this Escape**, matched by event identity
 *    rather than a flag, so there is nothing to reset and no stale state to suppress the next
 *    key. Radix keeps its usual behaviour whenever it works (including Escape from outside the
 *    panel, which never reaches this handler), and a consumer that cancels dismissal in its own
 *    `onEscapeKeyDown` still cancels it.
 *  - **`stopPropagation`.** The query editor's find widget and the command palette listen for
 *    Escape on the document; a panel-local Escape is spent on the panel.
 */

import type { ComponentProps, ComponentPropsWithRef, KeyboardEvent } from 'react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';

import { cn } from './cn';
import { OVERLAY_SURFACE_CLASSES } from './overlay';

/**
 * The one thing `PopoverContent` needs from its root and Radix does not publish: a way to close
 * the popover it is in. Radix's own popover context is internal, so the root wrapper below
 * exposes this single callback and nothing else.
 */
const PopoverDismissContext = createContext<(() => void) | undefined>(undefined);

/**
 * Radix's `Root` plus the dismiss callback the content needs. Controlled and uncontrolled both
 * work, because both are in use: `docker-pip.tsx` drives `open` from the status bar, the
 * primitives gallery and the specs pass nothing.
 */
export function Popover({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...rest
}: ComponentProps<typeof RadixPopover.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange]
  );
  const dismiss = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  return (
    <PopoverDismissContext.Provider value={dismiss}>
      <RadixPopover.Root open={open ?? uncontrolledOpen} onOpenChange={handleOpenChange} {...rest}>
        {children}
      </RadixPopover.Root>
    </PopoverDismissContext.Provider>
  );
}

/** `<PopoverTrigger asChild><Button …/></PopoverTrigger>`. */
export const PopoverTrigger = RadixPopover.Trigger;

/** Anchors the panel to something other than the trigger — a text cursor, a grid cell. */
export const PopoverAnchor = RadixPopover.Anchor;

export const PopoverClose = RadixPopover.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  onEscapeKeyDown,
  onKeyDown,
  ...rest
}: ComponentPropsWithRef<typeof RadixPopover.Content>) {
  // The native Escape Radix's own layer has already accounted for. See the file header.
  const escapeTakenByRadix = useRef<globalThis.KeyboardEvent | null>(null);
  const dismiss = useContext(PopoverDismissContext);

  // An assertion rather than an optional call: a `PopoverContent` outside this file's `Popover`
  // would silently lose the Escape behaviour the header describes.
  if (dismiss === undefined) {
    throw new Error('PopoverContent must be rendered inside a Popover from ui/popover.tsx.');
  }
  // Re-bound with the narrowed type: TypeScript does not carry a guard across a closure boundary,
  // and the handler below is a closure.
  const dismissPopover: () => void = dismiss;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    onKeyDown?.(event);
    if (event.key !== 'Escape') return;
    if (escapeTakenByRadix.current === event.nativeEvent) return;
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.stopPropagation();
    dismissPopover();
  }

  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(OVERLAY_SURFACE_CLASSES, 'w-72 p-3 text-base outline-hidden', className)}
        onEscapeKeyDown={event => {
          onEscapeKeyDown?.(event);
          escapeTakenByRadix.current = event;
        }}
        onKeyDown={handleKeyDown}
        {...rest}
      />
    </RadixPopover.Portal>
  );
}
