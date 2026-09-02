import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Copy, Play, Trash2 } from 'lucide-react';

import { Button } from './button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Select, SelectItem } from './select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Toolbar, ToolbarButton, ToolbarSeparator, ToolbarSpacer } from './toolbar';
import { Tooltip, TooltipProvider } from './tooltip';

/**
 * The three primitives whose whole value is a keyboard model Task 7 and Task 8 will lean on
 * without checking: a tab strip that arrows, a toolbar that costs one Tab press, and a popover
 * that dismisses. Radix supplies all three; these are the assertions that it still does.
 */

describe('Tabs', () => {
  function TabsHarness() {
    return (
      <Tabs defaultValue="results">
        <TabsList>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="stats" disabled>
            Statistics
          </TabsTrigger>
        </TabsList>
        <TabsContent value="results">2,104,882 rows</TabsContent>
        <TabsContent value="messages">Commands completed</TabsContent>
      </Tabs>
    );
  }

  it('shows only the active panel', () => {
    render(<TabsHarness />);

    expect(screen.getByText('2,104,882 rows')).toBeDefined();
    expect(screen.queryByText('Commands completed')).toBeNull();
  });

  it('moves between tabs with the arrow keys', async () => {
    render(<TabsHarness />);

    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Results');

    await userEvent.keyboard('{ArrowRight}');

    expect(document.activeElement?.textContent).toBe('Messages');
    expect(screen.getByText('Commands completed')).toBeDefined();
  });

  it('skips a disabled tab', async () => {
    render(<TabsHarness />);
    await userEvent.tab();

    await userEvent.keyboard('{ArrowRight}{ArrowRight}');

    expect(document.activeElement?.textContent).not.toBe('Statistics');
  });

  it('marks the active tab with the oxide underline rather than a filled affordance', () => {
    render(<TabsHarness />);

    // HOUSE-RULES §5 lists the active-tab indicator among oxide's jobs, so a tab strip spends
    // none of the surface's one-filled-oxide budget.
    const active = screen.getByRole('tab', { selected: true });
    expect(active.className).toContain('data-[state=active]:after:bg-accent');
    expect(active.className).not.toContain('bg-accent-strong');
  });

  it('gives every trigger a focus ring', () => {
    render(<TabsHarness />);

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('focus-visible:outline-focus');
    }
  });
});

describe('Toolbar', () => {
  function ToolbarHarness() {
    return (
      <Toolbar aria-label="Query actions">
        <ToolbarButton leadingIcon={Play}>Execute</ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton leadingIcon={Copy} iconOnly aria-label="Copy SQL" />
        <ToolbarSpacer />
        <ToolbarButton leadingIcon={Trash2} iconOnly aria-label="Clear" disabled />
      </Toolbar>
    );
  }

  it('is one tabstop with arrow-key navigation inside it', async () => {
    render(
      <>
        <ToolbarHarness />
        <Button data-testid="after">After</Button>
      </>
    );

    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Execute');

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Copy SQL');

    // One more Tab leaves the whole strip rather than stepping to the next button.
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('after'));
  });

  it('spends no oxide on its buttons', () => {
    render(<ToolbarHarness />);

    // Dense chrome: `ghost` is the default, because a toolbar is rarely the right place to
    // spend the surface's one filled affordance.
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).not.toContain('bg-accent-strong');
    }
  });

  it('aligns a trailing group with a spacer, not a margin', () => {
    render(<ToolbarHarness />);

    const toolbar = screen.getByRole('toolbar');
    expect(toolbar.querySelector('.grow')).not.toBeNull();
    expect(toolbar.className).not.toMatch(/(?:^|\s)-?m[trblxy]?-/);
  });
});

describe('Popover', () => {
  function PopoverHarness() {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button data-testid="trigger">Row limit</Button>
        </PopoverTrigger>
        <PopoverContent data-testid="panel">
          <Button data-testid="inside">Apply</Button>
        </PopoverContent>
      </Popover>
    );
  }

  it('opens from its trigger and can hold focusable controls', async () => {
    render(<PopoverHarness />);

    await userEvent.click(screen.getByTestId('trigger'));

    expect(screen.getByTestId('inside')).toBeDefined();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    render(<PopoverHarness />);
    await userEvent.click(screen.getByTestId('trigger'));

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('panel')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('trigger'));
  });

  it('leaves the workbench underneath usable — it is not a dialog', async () => {
    render(
      <>
        <PopoverHarness />
        <Button data-testid="outside">Outside</Button>
      </>
    );

    await userEvent.click(screen.getByTestId('trigger'));

    // A Dialog hides the rest of the document from assistive technology. A popover must not:
    // PLAN §2.9 reserves modality for transactional flows.
    expect(screen.getByTestId('outside').closest('[aria-hidden="true"]')).toBeNull();
  });
});

/**
 * J-72. `PopoverHarness` above holds a bare `Button`, and Radix dismisses that one on Escape by
 * itself. The Docker panel does not: every control in it is tooltipped, and a Radix tooltip's
 * content is a `DismissableLayer` too — so focusing a tooltipped control pushes a second layer
 * onto the global stack, `DismissableLayer` only attaches its Escape listener for the *highest*
 * layer, and the popover's listener is torn down for as long as the tip is up. The evidence is in
 * `react-dismissable-layer@1.1.19/dist/index.mjs`: `isHighestLayer` gates the
 * `addEventListener('keydown', …, { capture: true })`, and `react-tooltip@1.2.16` wraps its
 * content in the same layer with `onDismiss: onClose`.
 *
 * So these harnesses are the real panel's shape — a tooltip on the trigger AND a tooltip on a
 * control inside — and the nested cases below fix the boundary: one Escape must dismiss exactly
 * one surface.
 */
describe('Popover — Escape with another dismissable layer above it (J-72)', () => {
  function TooltippedPanelHarness({
    onOpenChange,
  }: {
    readonly onOpenChange?: (open: boolean) => void;
  }) {
    return (
      <TooltipProvider delayDuration={0}>
        <Popover onOpenChange={onOpenChange}>
          <Tooltip content="Docker">
            <PopoverTrigger data-testid="trigger">Docker</PopoverTrigger>
          </Tooltip>
          <PopoverContent data-testid="panel">
            <Tooltip content="Re-read Docker">
              <Button data-testid="refresh">Refresh</Button>
            </Tooltip>
          </PopoverContent>
        </Popover>
      </TooltipProvider>
    );
  }

  it('dismisses when focus sits on a tooltipped control inside the panel', async () => {
    render(<TooltippedPanelHarness />);
    await userEvent.click(screen.getByTestId('trigger'));

    screen.getByTestId('refresh').focus();
    // The tip is genuinely up — without this the test could pass for the wrong reason, having
    // never reproduced the second layer.
    expect(screen.getByRole('tooltip').textContent).toBe('Re-read Docker');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('reports the dismissal to a controlled consumer, so `open` state cannot desynchronise', async () => {
    const onOpenChange = vi.fn();
    render(<TooltippedPanelHarness onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByTestId('trigger'));
    screen.getByTestId('refresh').focus();
    onOpenChange.mockClear();

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('dismisses once, not twice, when Radix is still able to do it itself', async () => {
    // The plain panel — no tip above it, so Radix's own layer takes the key. The handler this
    // primitive adds must recognise that and stand down: two `false`s for one Escape is the other
    // way to get this wrong.
    const onOpenChange = vi.fn();
    render(
      <Popover onOpenChange={onOpenChange}>
        <PopoverTrigger data-testid="trigger">Row limit</PopoverTrigger>
        <PopoverContent data-testid="panel">
          <Button data-testid="inside">Apply</Button>
        </PopoverContent>
      </Popover>
    );
    await userEvent.click(screen.getByTestId('trigger'));
    screen.getByTestId('inside').focus();
    onOpenChange.mockClear();

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('dismisses only itself, leaving the dialog it sits inside open', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Dialog defaultOpen>
          <DialogContent size="md" data-testid="dialog">
            <DialogHeader>
              <DialogTitle>Restore database</DialogTitle>
            </DialogHeader>
            <Popover>
              <PopoverTrigger data-testid="trigger">Options</PopoverTrigger>
              <PopoverContent data-testid="panel">
                <Tooltip content="Re-read Docker">
                  <Button data-testid="refresh">Refresh</Button>
                </Tooltip>
              </PopoverContent>
            </Popover>
          </DialogContent>
        </Dialog>
      </TooltipProvider>
    );
    await userEvent.click(screen.getByTestId('trigger'));
    screen.getByTestId('refresh').focus();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('panel')).toBeNull();
    expect(screen.getByTestId('dialog')).toBeDefined();
  });

  it('dismisses from inside a text field — the filter-form shape the header advertises', async () => {
    render(
      <Popover>
        <PopoverTrigger data-testid="trigger">Filter</PopoverTrigger>
        <PopoverContent data-testid="panel">
          <Input label="Contains" name="contains" data-testid="contains" />
        </PopoverContent>
      </Popover>
    );
    await userEvent.click(screen.getByTestId('trigger'));
    await userEvent.type(screen.getByTestId('contains'), 'orders');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('leaves Escape to a Select open inside it, rather than closing both', async () => {
    render(
      <Popover>
        <PopoverTrigger data-testid="trigger">Options</PopoverTrigger>
        <PopoverContent data-testid="panel">
          <Select label="Engine" name="engine" data-testid="engine" placeholder="Choose">
            <SelectItem value="postgres">PostgreSQL</SelectItem>
            <SelectItem value="mysql">MySQL</SelectItem>
          </Select>
        </PopoverContent>
      </Popover>
    );
    await userEvent.click(screen.getByTestId('trigger'));
    await userEvent.click(screen.getByTestId('engine'));
    expect(screen.getByRole('listbox')).toBeDefined();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId('panel')).toBeDefined();
  });
});

describe('Tooltip', () => {
  it('opens on keyboard focus, not only on hover', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Re-read the schema from the server.">
          <Button data-testid="trigger">Refresh</Button>
        </Tooltip>
      </TooltipProvider>
    );

    await userEvent.tab();

    expect(screen.getByRole('tooltip').textContent).toBe('Re-read the schema from the server.');
  });
});
