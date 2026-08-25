import { afterEach, describe, expect, it, vi } from 'vitest';

import { render } from '@testing-library/react';

import { notify } from '../state/diagnostics';
import { Toaster, installToastNotifier } from './toaster';

/**
 * Task 4's nine stores already call `notify.*`, and until something installs a sink those calls
 * land on the console (`state/diagnostics.ts`). This is the sink, and the only thing worth
 * testing about it is that all four levels are actually routed — a missing one would silently
 * downgrade a user-facing message to a console line nobody sees.
 *
 * `sonner` is mocked rather than rendered because the assertion is about the routing, not about
 * sonner's stacking or timers. Rendering the real `<Toaster />` would test the library.
 */

/** What `<Toaster />` handed sonner, so the class it configures can be asserted without CSS. */
const sonnerProps: { current: Record<string, unknown> | null } = { current: null };

vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    sonnerProps.current = props;
    return null;
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

const { toast } = await import('sonner');

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.clearAllMocks();
});

describe('installToastNotifier', () => {
  it('routes every level of the notifier seam', () => {
    uninstall = installToastNotifier();

    notify.success('Backup completed');
    notify.error('Login failed');
    notify.warning('pg_dump not found');
    notify.info('Connected');

    expect(toast.success).toHaveBeenCalledWith('Backup completed');
    expect(toast.error).toHaveBeenCalledWith('Login failed');
    expect(toast.warning).toHaveBeenCalledWith('pg_dump not found');
    expect(toast.info).toHaveBeenCalledWith('Connected');
  });

  it('returns a teardown that puts the previous sink back', () => {
    uninstall = installToastNotifier();
    notify.success('first');
    expect(toast.success).toHaveBeenCalledTimes(1);

    uninstall();
    uninstall = undefined;
    notify.success('second');

    // Back on the console sink, so sonner sees nothing more. Without this, an effect that
    // installs the notifier on mount would leak it on unmount.
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

describe('the toast’s own pointer events (J-42)', () => {
  it('configures pointer-events-auto, without which a toast over a dialog is inert', () => {
    // Sonner ships `[data-sonner-toast] { pointer-events: auto }` for exactly the case where
    // something else has turned pointer events off on `<body>` — which Radix's `DismissableLayer`
    // does for the life of every modal dialog. `unstyled: true` drops that rule along with
    // sonner's colours, so a toast raised over a dialog was visible, legible and unclickable.
    //
    // Asserted on what this component HANDS sonner, because that is what a jsdom test can honestly
    // claim: no Tailwind is loaded here, so the class cannot be observed as a computed style.
    // `dialog.spec.tsx` covers the other half — what the dialog does with a click that reaches a
    // toast, which is the half that would otherwise close a half-filled form.
    render(<Toaster />);

    const options = sonnerProps.current?.['toastOptions'] as
      { classNames?: { toast?: string } } | undefined;
    expect(options?.classNames?.toast, 'no toast class reached sonner').toContain(
      'pointer-events-auto'
    );
  });
});
