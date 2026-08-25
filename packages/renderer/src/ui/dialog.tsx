/**
 * Radix `Dialog`, in the one shape PLAN §2.9 fixed for this app: hairline-ruled header,
 * scrollable body, right-aligned action row, and **at most one filled oxide affordance per
 * dialog** — a dialog counts as its own surface for the accent rule in HOUSE-RULES §5.
 *
 * §2.9 is worth restating because it retires a pattern rather than restyling one: backup,
 * restore and connection editing existed as both routed pages and dialogs, and the pages
 * carried the app's only `<mat-card>` and `mat-stepper`. The dialogs won, so those three
 * flows are `size="md"`/`"lg"` dialogs with their progress stream inline in the body — not
 * places you can navigate away from, because the stream is per-invocation and unpersisted.
 *
 * Radix supplies the focus trap, the return of focus to the trigger, Escape-to-close, the
 * scroll lock, and modality — the last by hiding the rest of the document from assistive
 * technology rather than by setting `aria-modal`. Those are asserted in `dialog.spec.tsx`
 * rather than assumed, because they are the reason this is Radix and not a hand-rolled
 * overlay, and because the `aria-modal` detail is exactly the sort of thing a Radix minor
 * version changes underneath us.
 *
 * Composed parts rather than one `<Dialog title=… actions=…>` component: three of the four
 * consumers need a body that is a form, a progress stream and a file browser respectively,
 * and slot props would have forced a `ReactNode` per region anyway. `DialogContent` is the
 * only part with real geometry; the rest are rules and padding.
 *
 * Radix warns in dev if `Content` has no `Title`, and it is right to — a modal with no
 * accessible name is unusable with a screen reader. If a dialog has no visible title, wrap
 * the `DialogTitle` in a visually-hidden span rather than dropping it.
 */

import type { ComponentPropsWithRef } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { Button } from './button';
import { cn } from './cn';

export type DialogSize = 'sm' | 'md' | 'lg';

const DEFAULT_SIZE: DialogSize = 'md';

/**
 * Widths in rem, per `general.md`'s "use rem for arbitrary font/length values". `lg` is
 * 736px so it still fits inside the 800px minimum window width (`window.ts:53`) with the
 * `w-[calc(100%-2rem)]` inset to spare.
 */
const SIZE_CLASSES: Record<string, string> = {
  sm: 'max-w-[22rem]',
  md: 'max-w-[32rem]',
  lg: 'max-w-[46rem]',
};

/** The Radix root. `open`/`onOpenChange` for a controlled dialog, `defaultOpen` otherwise. */
export const Dialog = RadixDialog.Root;

/** Wrap the caller's own button: `<DialogTrigger asChild><Button …/></DialogTrigger>`. */
export const DialogTrigger = RadixDialog.Trigger;

/** Same asChild contract as the trigger. Used for a Cancel button in `DialogActions`. */
export const DialogClose = RadixDialog.Close;

/**
 * Where the dialog sits. `center` is the default and is right for anything with actions to press;
 * `top` is the search-overlay position — a palette anchored near the top of the window so the list
 * grows downward into stable space instead of pushing the input around as results arrive. The two
 * are the only positions this app has (`ui/command-overlay.tsx` is the only `top` caller).
 */
export type DialogAlign = 'center' | 'top';

const ALIGN_CLASSES: Record<string, string> = {
  center: 'top-1/2 -translate-1/2',
  // 12vh rather than a fixed rem: the overlay has to look anchored in an 600px-tall window and in a
  // 1200px one, and a percentage of the viewport is the one measure that does both. `max-h` keeps it
  // inside the window either way.
  top: 'top-[12vh] -translate-x-1/2',
};

export interface DialogContentProps extends ComponentPropsWithRef<typeof RadixDialog.Content> {
  readonly size?: DialogSize;
  readonly align?: DialogAlign;
}

/**
 * The toaster is outside the dialog in the DOM and must not count as "outside" for dismissal.
 *
 * Restoring the toast's pointer events (J-42, `ui/toaster.tsx`) is only half a fix: with them back,
 * clicking a toast's close button is a pointer-down outside the dialog content, so Radix's
 * `onPointerDownOutside` fires and closes the dialog. Dismissing a toast would throw away a
 * half-filled connection form — worse than the bug.
 *
 * The target has to come out of `detail.originalEvent`. These are CustomEvents dispatched AT the
 * dialog content, so `event.target` is the dialog itself and a check against it would never match.
 */
function isFromToaster(event: CustomEvent<{ originalEvent: Event }>): boolean {
  const target = event.detail.originalEvent.target;
  return target instanceof Element && target.closest('[data-sonner-toaster]') !== null;
}

export function DialogContent({
  size = DEFAULT_SIZE,
  align = 'center',
  className,
  children,
  onPointerDownOutside,
  onInteractOutside,
  ...rest
}: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      {/* Ink in both themes: a scrim's job is to darken, and PROPOSAL's light theme
          dims to the same ink rather than to a grey. Layer 1 is correct here. */}
      {/* Named for the suites: a click on the scrim is one of the three ways a dialog is dismissed,
          and it is the only one with no element of its own to address. */}
      <RadixDialog.Overlay data-testid="dialog-scrim" className="fixed inset-0 z-40 bg-j-ink/70" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 z-50',
          ALIGN_CLASSES[align] ?? ALIGN_CLASSES['center'],
          'flex max-h-[85dvh] w-[calc(100%-2rem)] flex-col overflow-hidden',
          // rounded-md is the ceiling — HOUSE-RULES §6: nothing is rounder than 6px,
          // dialogs included.
          'rounded-md border border-rule-strong bg-elevated text-fg shadow-overlay outline-hidden',
          SIZE_CLASSES[size] ?? SIZE_CLASSES[DEFAULT_SIZE],
          className
        )}
        // The caller's handler runs FIRST and keeps whatever it decided — this composes with it
        // rather than replacing it, so a dialog with its own outside-dismiss rule keeps it.
        onPointerDownOutside={event => {
          onPointerDownOutside?.(event);
          if (isFromToaster(event)) event.preventDefault();
        }}
        onInteractOutside={event => {
          onInteractOutside?.(event);
          if (isFromToaster(event)) event.preventDefault();
        }}
        {...rest}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export interface DialogHeaderProps extends ComponentPropsWithRef<'header'> {
  /** The close affordance. Drop it only for a dialog that must be resolved by its actions. */
  readonly showClose?: boolean;
}

export function DialogHeader({
  showClose = true,
  className,
  children,
  ...rest
}: DialogHeaderProps) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-start justify-between gap-4 border-b border-rule px-4 py-3',
        className
      )}
      {...rest}
    >
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
      {showClose ? (
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            leadingIcon={X}
            aria-label="Close"
            data-testid="dialog-close"
          />
        </DialogClose>
      ) : null}
    </header>
  );
}

/** 16px, per HOUSE-RULES §2's "dialog titles" rung. `text-balance` per `typography.md`. */
export function DialogTitle({
  className,
  ...rest
}: ComponentPropsWithRef<typeof RadixDialog.Title>) {
  return <RadixDialog.Title className={cn('text-lg text-fg text-balance', className)} {...rest} />;
}

export function DialogDescription({
  className,
  ...rest
}: ComponentPropsWithRef<typeof RadixDialog.Description>) {
  return (
    <RadixDialog.Description
      className={cn('text-md text-fg-muted text-pretty', className)}
      {...rest}
    />
  );
}

/**
 * The scrollable region. `min-h-0` is what makes `overflow-y-auto` work inside a flex
 * column — without it the body grows past the dialog instead of scrolling
 * (`flexbox-layout.md`).
 */
export function DialogBody({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto p-4 text-md', className)} {...rest} />;
}

/** Right-aligned action row. Primary action last, which is the platform order on macOS. */
export function DialogActions({ className, ...rest }: ComponentPropsWithRef<'footer'>) {
  return (
    <footer
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 border-t border-rule px-4 py-3',
        className
      )}
      {...rest}
    />
  );
}
