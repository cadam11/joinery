/**
 * `sonner`, themed, plus the one line of wiring that points Task 4's notifier seam at it.
 *
 * `unstyled: true` and a class per slot, rather than sonner's own look overridden: sonner
 * ships a light/dark palette of its own hexes, and Task 2 closed the colour namespace
 * precisely so nothing paints from outside the token system. Unstyled keeps sonner doing what
 * it is here for — stacking, timers, swipe-to-dismiss, the live region — and leaves every
 * pixel to the tokens.
 *
 * Type is carried by the glyph, not by a coloured surface. HOUSE-RULES §5 caps chartreuse at
 * "fill-or-dark-canvas only" and two visible at once, so a green success *card* is not
 * available; a green tick on the standard elevated surface is. The same reasoning keeps the
 * error toast off a red fill.
 *
 * `installToastNotifier()` is the "Toaster reading the diagnostics seam" the task brief
 * allows. Task 4's stores already call `notify.*`; until something installs a real sink those
 * calls land on the console. This is the sink. Task 7 calls it once from the shell's mount
 * and keeps the returned teardown.
 */

import { toast, Toaster as SonnerToaster } from 'sonner';
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react';

import { cn } from './cn';
import { Icon } from './icon';
import { setNotifier } from '../state/diagnostics';

/** Matches the overlay surface — a toast is one, it just places itself. */
const TOAST_CLASSES = cn(
  'flex w-full items-start gap-2 rounded-md border border-rule-strong bg-elevated p-3',
  'text-base text-fg shadow-overlay',
  // Sonner ships `[data-sonner-toast] { pointer-events: auto }` for the case where something else
  // has turned pointer events off on `<body>` — which Radix's `DismissableLayer` does for the life
  // of any modal dialog. `unstyled: true` drops that rule along with sonner's colours, so a toast
  // raised over a dialog was visible, legible, and completely inert: its close button could not be
  // clicked and it could not be swiped away (J-42). `DialogContent` has the matching half — it
  // refuses to treat a click on a toast as a click outside itself.
  'pointer-events-auto'
);

export interface ToasterProps {
  /**
   * Which palette sonner assumes for the bits it still owns (the swipe affordance). The
   * tokens carry the actual colours, so this only has to stop sonner fighting them. Task 7
   * passes the resolved theme preference.
   */
  readonly theme?: 'light' | 'dark' | 'system';
}

export function Toaster({ theme = 'system' }: ToasterProps) {
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      closeButton
      // Every glyph is a lucide icon on a token stroke, so no toast paints a raw colour.
      icons={{
        success: <Icon icon={CircleCheck} className="stroke-success" />,
        error: <Icon icon={CircleAlert} className="stroke-danger" />,
        warning: <Icon icon={TriangleAlert} className="stroke-warning" />,
        info: <Icon icon={Info} className="stroke-fg-muted" />,
        loading: <Icon icon={LoaderCircle} className="animate-spin stroke-accent" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: TOAST_CLASSES,
          content: 'flex min-w-0 grow flex-col gap-0.5',
          title: 'text-base text-fg text-pretty',
          description: 'text-sm text-fg-muted text-pretty',
          actionButton: cn(
            'inline-flex h-7 shrink-0 items-center rounded-sm border border-rule-strong px-2.5',
            'text-base text-fg hover:bg-hover',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
          ),
          cancelButton: cn(
            'inline-flex h-7 shrink-0 items-center rounded-sm px-2.5 text-base text-fg-muted',
            'hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
          ),
          closeButton: cn(
            'rounded-xs border border-rule-strong bg-elevated text-fg-muted hover:bg-hover',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
          ),
          icon: 'flex shrink-0 items-center',
        },
      }}
    />
  );
}

/**
 * Points `notify.*` at the toaster. Returns the teardown that restores the previous sink,
 * which is what makes it safe to call from an effect and what tests use to unwind.
 */
export function installToastNotifier(): () => void {
  return setNotifier({
    success: message => {
      toast.success(message);
    },
    error: message => {
      toast.error(message);
    },
    info: message => {
      toast.info(message);
    },
    warning: message => {
      toast.warning(message);
    },
  });
}
