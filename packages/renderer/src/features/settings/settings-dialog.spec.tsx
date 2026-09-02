/**
 * The settings panel, driven the way a user drives it.
 *
 * ── The one thing this file exists for ─────────────────────────────────────────────────────
 *
 * J-44: the Angular panel shipped **nine controls that persisted and changed nothing** — all six editor
 * preferences (the query editor hardcoded its Monaco options past them) plus `defaultTimeout`,
 * `showExecutionTime` and `confirmBeforeExecute` (nothing read them at all). Every one of them looked
 * like it worked. So the headline test below is not about any single control: it walks every interactive
 * control in every group and requires each to be **either enabled, or disabled with its owner named
 * in the hint the user can read**. A new decorative toggle fails it without anyone remembering to add an
 * assertion for that toggle. J-92's AI group is in that walk too, and its one control is a button whose
 * effect — the hop to the AI setup dialog — is asserted in its own block at the foot of this file.
 *
 * ── Where each control's consumer is asserted ──────────────────────────────────────────────
 *
 * This file owns *control → store*, exhaustively, and the two consumers reachable with no other surface
 * mounted (the theme's `[data-theme]`, and `executeScope` through the pure `textToExecute`). The rest of
 * each chain is asserted where the consumer lives, because that is where a regression would be:
 *
 * | setting                | store → consumer, asserted in                                        |
 * | ---------------------- | -------------------------------------------------------------------- |
 * | `editor.*`             | `query-panel.spec.tsx` (open editor gets the new prop, no remount)    |
 * |                        | + `sql-editor.spec.tsx` (the prop reaches `updateOptions`)            |
 * | `grid.*`               | `results-grid.spec.tsx` (AG Grid props, column set, striping, copy)   |
 * | `query.maxRowsToDisplay`| `use-run-query.spec.tsx` (`QueryRequest.maxRows`)                    |
 * | `query.defaultTimeout` | `use-run-query.spec.tsx` (`QueryRequest.timeout`)                     |
 * | `query.showExecutionTime`| `query-results.spec.tsx` (the Messages duration line)               |
 * | `query.confirmBeforeExecute`| `query-panel.spec.tsx` (every execute entry point is gated)      |
 * | `editor-prefs` ⌃E flag | `query-panel.spec.tsx` (the gate reappears)                           |
 *
 * ── No bridge, mostly ──────────────────────────────────────────────────────────────────────
 *
 * The panel touches no IPC. The settings store's `AppState` write is fire-and-forget and tolerates the
 * absence of a bridge (`state/settings.ts`), so only the round-trip test installs one — and it installs
 * the real `AppStateDouble`, so what it proves is that a click in this panel lands in main-process state.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@joinery/shared';

import { dispatchCommand, subscribeCommand } from '../../commands';
import { textToExecute } from '../../editor/statements';
import { createAppStateDouble } from '../../test/app-state-double';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { editorPrefsStore } from '../../state/editor-prefs';
import { setDiagnosticsSink } from '../../state/diagnostics';
import { settingsStore } from '../../state/settings';
import { THEME_OPTIONS } from '../../shell/status-bar';
import { SettingsDialog } from './settings-dialog';
import { THEME_CHOICES } from './settings-groups';

const GROUPS = ['appearance', 'editor', 'query', 'grid', 'ai'] as const;
type GroupId = (typeof GROUPS)[number];

const teardowns: (() => void)[] = [];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // A full hydrate rather than `setState`: it is the store's own reset path, it unlocks the write gate,
  // and it stamps the theme back to the default instead of leaving the previous test's on `<html>`.
  settingsStore.getState().hydrate({ settings: DEFAULT_SETTINGS, persistWrites: true });
  settingsStore.setState({ nativeTheme: 'dark', isOpen: false });
  editorPrefsStore
    .getState()
    .hydrate({ confirmedCtrlEExecute: false, flywayPlaceholderValues: {} });
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  settingsStore.setState({ isOpen: false });
});

/** Mounts the panel closed, which is how the shell mounts it. */
function mount(): void {
  const { unmount } = render(<SettingsDialog />);
  teardowns.push(unmount);
}

/** Mounts the panel, opens it through the command the native menu sends, and selects a group. */
async function openPanel(
  group: GroupId = 'appearance'
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  mount();
  dispatchCommand('open-settings');
  await screen.findByTestId('settings-dialog');
  if (group !== 'appearance') {
    await user.click(screen.getByTestId(`settings-tab-${group}`));
    await screen.findByTestId(`settings-group-${group}`);
  }
  return user;
}

/** Opens a Radix `Select` by testid and picks the option whose visible text starts with `label`. */
async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerTestId: string,
  label: string | RegExp
): Promise<void> {
  await user.click(screen.getByTestId(triggerTestId));
  const option = await screen.findByRole('option', { name: label });
  await user.click(option);
  await waitFor(() => expect(screen.queryByRole('option', { name: label })).toBeNull());
}

/**
 * `disabled` and `value` as plain reads: this package has no `@testing-library/jest-dom`, deliberately
 * (`test/setup.ts` installs only the browser APIs jsdom lacks), so there is no `toBeDisabled`.
 */
function isDisabled(testId: string): boolean {
  const element = screen.getByTestId(testId);
  return (
    (element as HTMLInputElement | HTMLButtonElement).disabled ||
    element.getAttribute('aria-disabled') === 'true'
  );
}

function fieldValue(testId: string): string {
  return (screen.getByTestId(testId) as HTMLInputElement).value;
}

/** Types a number into a `NumberSetting` and commits it the way blurring does. */
async function fillNumber(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  value: string
): Promise<void> {
  const field = screen.getByTestId(testId);
  await user.clear(field);
  await user.type(field, value);
  await user.tab();
}

// ── The panel itself ───────────────────────────────────────────────────────────────────────

describe('the settings panel', () => {
  it('renders nothing until the open-settings command arrives', async () => {
    mount();
    expect(screen.queryByTestId('settings-dialog')).toBeNull();

    dispatchCommand('open-settings');

    expect(await screen.findByTestId('settings-dialog')).toBeTruthy();
    expect(settingsStore.getState().isOpen).toBe(true);
  });

  it('closes on Escape, through the store rather than round the side of it', async () => {
    const user = await openPanel();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
    // The Angular panel had its own `document:keydown.escape` listener AND its own ⌘, listener; here
    // Escape is Radix's and it closes by writing the one flag the shell reads.
    expect(settingsStore.getState().isOpen).toBe(false);
  });

  it('reaches all five groups', async () => {
    const user = await openPanel();

    for (const group of GROUPS) {
      await user.click(screen.getByTestId(`settings-tab-${group}`));
      expect(await screen.findByTestId(`settings-group-${group}`)).toBeTruthy();
    }
  });

  it('focuses the group switcher rather than the close button', async () => {
    await openPanel();
    // Radix's default is the first tabbable node in the content — the header's ✕. A keyboard user who
    // just pressed ⌘, wants the group strip.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('settings-tab-appearance'))
    );
  });
});

// ── The AI door (J-92) ─────────────────────────────────────────────────────────────────────

/**
 * ⌘, is where a user looks for "where do I put my API key", and until J-92 the answer was "nowhere
 * here" — the AI setup dialog's only unconditional entry point was the command palette. The group
 * holds no preference of its own, so what these assert is the hop and the ordering it needs.
 */
describe('the AI group', () => {
  it('offers a door to AI setup, and takes it without leaving two dialogs open', async () => {
    const dispatched: string[] = [];
    teardowns.push(
      subscribeCommand('open-ai-setup', () => {
        dispatched.push('open-ai-setup');
      })
    );
    const user = await openPanel('ai');

    await user.click(screen.getByTestId('settings-open-ai-setup'));

    // Closed FIRST, then the command: two Radix modals stacked would fight over the focus trap, and
    // the user asked to go to AI setup rather than to put it on top of the settings they were done
    // with. The store flag is the shell's own read, so this is the real dismissal, not a hidden one.
    expect(dispatched).toEqual(['open-ai-setup']);
    await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
    expect(settingsStore.getState().isOpen).toBe(false);
  });

  it('states whether a provider is configured, without claiming to be the place to fix it', async () => {
    await openPanel('ai');

    // `aiStore` is at its initial state here: no vendor has a key.
    const state = screen.getByTestId('settings-ai-state');
    expect(state.getAttribute('data-state')).toBe('none');
    expect(state.textContent).toContain('No provider is configured yet');
  });
});

// ── The J-44 guard ─────────────────────────────────────────────────────────────────────────

/**
 * The two legal reasons a control in this panel may be disabled. Anything else is the J-44 defect
 * wearing a different hat, and the test below is what makes adding one a failure.
 */
const DISABLED_PENDING_A_CONSUMER: readonly string[] = [
  // Empty since J-54 made the query timeout live, and that is the state to keep it in. An entry
  // here is a control that persists a value nothing reads; the walk below still demands each one
  // name its owner, so a new entry has to admit what it is.
];

const DISABLED_BECAUSE_INAPPLICABLE: readonly string[] = [
  // Nothing to reset until the user has ticked "don't ask me again". Its consumer works; there is
  // simply no state for it to clear, which the copy beside it says. Proved live below.
  'settings-editor-ctrl-e-reset',
];

/**
 * The third legal reason, and the one the first review of this file missed: disabled because ANOTHER
 * setting's value makes this one meaningless. These controls are **enabled at the shipped defaults**, so
 * the walk below would never see them — which is exactly how a value-dependent disable could turn into a
 * decorative one unnoticed. Each entry carries the arrangement that legitimately disables it, and the
 * second test drives it and re-walks, so every legal disable in the panel is enumerated somewhere here.
 */
const DISABLED_BY_ANOTHER_SETTING: readonly {
  readonly testId: string;
  readonly because: string;
  /** Puts the panel into the state that disables `testId`. Leaves the panel open. */
  readonly arrange: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
}[] = [
  {
    testId: 'settings-grid-copy-headers',
    // `results-clipboard.ts` writes object keys for JSON, so a leading header row cannot exist.
    because: 'JSON carries the column names as object keys',
    arrange: async user => {
      await user.click(screen.getByTestId('settings-tab-grid'));
      await screen.findByTestId('settings-group-grid');
      await selectOption(user, 'settings-grid-copy-format', 'JSON');
    },
  },
];

/** Every control in the panel, with its disabled state and the hint a user can read beside it. */
async function collectControls(
  user: ReturnType<typeof userEvent.setup>
): Promise<{ testId: string; disabled: boolean; described: string }[]> {
  const collected: { testId: string; disabled: boolean; described: string }[] = [];

  for (const group of GROUPS) {
    await user.click(screen.getByTestId(`settings-tab-${group}`));
    const groupElement = await screen.findByTestId(`settings-group-${group}`);

    for (const element of groupElement.querySelectorAll('input, button, [role="combobox"]')) {
      const testId = element.getAttribute('data-testid');
      if (testId === null || !testId.startsWith('settings-')) continue;
      // The hint is what the control points `aria-describedby` at, so this reads exactly what a screen
      // reader would — not the nearest paragraph in the DOM.
      const describedIds = (element.getAttribute('aria-describedby') ?? '').split(/\s+/);
      const described = describedIds
        .map(id => (id === '' ? '' : (document.getElementById(id)?.textContent ?? '')))
        .join(' ');
      collected.push({
        testId,
        disabled:
          element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        // A radio's own label carries its reason, so fall back to the row's text when there is no hint.
        described:
          described.trim() === '' ? (element.closest('label')?.textContent ?? '') : described,
      });
    }
  }

  return collected;
}

describe('no decorative controls (J-44)', () => {
  it('disables only the controls whose owner is named, and names it in the hint', async () => {
    const user = await openPanel();

    const controls = await collectControls(user);
    // Sanity: the walk found the panel rather than an empty subtree.
    expect(controls.length).toBeGreaterThan(15);

    const disabled = controls.filter(control => control.disabled).map(control => control.testId);
    expect([...new Set(disabled)].sort()).toEqual(
      [...DISABLED_PENDING_A_CONSUMER, ...DISABLED_BECAUSE_INAPPLICABLE].sort()
    );

    // The half that makes the disabling honest: a control with no consumer must SAY so, with a ticket
    // number, in the text beside it. "Disabled and silent" is indistinguishable from broken.
    for (const testId of DISABLED_PENDING_A_CONSUMER) {
      const control = controls.find(candidate => candidate.testId === testId);
      expect(control, `${testId} is not in the panel`).toBeTruthy();
      expect(control?.described, `${testId} does not name its owner`).toMatch(/J-\d+/);
    }
  });

  it('disables a value-dependent control only while the value that disables it is set', async () => {
    for (const entry of DISABLED_BY_ANOTHER_SETTING) {
      const user = await openPanel();

      // Enabled at the defaults, which is why the walk above cannot see this one.
      const before = await collectControls(user);
      expect(
        before.find(control => control.testId === entry.testId)?.disabled,
        `${entry.testId} is disabled before anything set it`
      ).toBe(false);

      await entry.arrange(user);
      const after = await collectControls(user);

      // Exactly this control joined the disabled set — nothing else went with it.
      const disabled = [...new Set(after.filter(c => c.disabled).map(c => c.testId))].sort();
      expect(disabled).toEqual(
        [...DISABLED_PENDING_A_CONSUMER, ...DISABLED_BECAUSE_INAPPLICABLE, entry.testId].sort()
      );
      // And it says why, in the text beside it: no ticket, because nothing is pending — the consumer
      // exists and this value is the reason.
      expect(
        after.find(control => control.testId === entry.testId)?.described,
        `${entry.testId} does not say why it is disabled`
      ).toContain(entry.because);

      // A fresh panel and fresh defaults for the next entry, which this one left a setting changed for.
      // `openPanel` pushes exactly one teardown — its unmount — so popping one is that panel and only it.
      teardowns.pop()?.();
      settingsStore.getState().hydrate({ settings: DEFAULT_SETTINGS, persistWrites: true });
      settingsStore.setState({ isOpen: false });
    }
  });

  it('offers no control at all for a setting nothing could consume', async () => {
    const user = await openPanel('query');
    await collectControls(user);

    // `QuerySettings.autoExecuteOnOpen` is read by nothing and means nothing: auto-execute is per-tab
    // (`tabStore.openQueryTab(…, autoExecute)`). A disabled control would imply a surface is coming; the
    // honest answer is absence, and a follow-up ticket deciding whether the field survives at all.
    expect(screen.queryByTestId('settings-query-auto-execute')).toBeNull();
  });
});

// ── Appearance ─────────────────────────────────────────────────────────────────────────────

describe('the three-state theme control', () => {
  it('writes the preference and the resolved [data-theme] for each of the three states', async () => {
    const user = await openPanel();

    await user.click(screen.getByTestId('settings-theme-light'));
    expect(settingsStore.getState().settings.theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await user.click(screen.getByTestId('settings-theme-dark'));
    expect(settingsStore.getState().settings.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // `system` resolves through the OS theme and never writes the literal — the store is the single
    // writer of the attribute and `settings.spec.tsx` owns the resolution rules.
    settingsStore.setState({ nativeTheme: 'light' });
    await user.click(screen.getByTestId('settings-theme-system'));
    expect(settingsStore.getState().settings.theme).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('says what `system` currently resolves to, which the label cannot', async () => {
    const user = await openPanel();
    settingsStore.setState({ nativeTheme: 'dark' });

    await user.click(screen.getByTestId('settings-theme-system'));
    expect(screen.getByTestId('settings-theme-resolved').textContent).toContain('currently ink');

    await user.click(screen.getByTestId('settings-theme-light'));
    expect(screen.getByTestId('settings-theme-resolved').textContent).toContain('ivory');
  });

  it('exposes the checked state, so the control is readable without looking at it', async () => {
    const user = await openPanel();
    await user.click(screen.getByTestId('settings-theme-dark'));

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter(radio => (radio as HTMLInputElement).checked)).toHaveLength(1);
    expect((screen.getByTestId('settings-theme-dark') as HTMLInputElement).checked).toBe(true);
  });

  it('calls each theme what the status bar calls it', () => {
    // Two names for one theme in one window is how a user learns the app is inconsistent. The status
    // bar's menu said Light/Dark until Task 15; the brand names are Ivory/Ink.
    for (const choice of THEME_CHOICES) {
      expect(THEME_OPTIONS[choice.value].label).toBe(choice.label);
    }
    expect(THEME_CHOICES.map(choice => choice.value).sort()).toEqual(
      Object.keys(THEME_OPTIONS).sort()
    );
  });
});

// ── Editor ─────────────────────────────────────────────────────────────────────────────────

describe('the editor group', () => {
  it('writes all six editor settings', async () => {
    const user = await openPanel('editor');

    await fillNumber(user, 'settings-editor-font-size', '18');
    await fillNumber(user, 'settings-editor-tab-size', '2');
    await user.click(screen.getByTestId('settings-editor-word-wrap'));
    await user.click(screen.getByTestId('settings-editor-minimap'));
    await user.click(screen.getByTestId('settings-editor-line-numbers'));
    await user.click(screen.getByTestId('settings-editor-auto-complete'));

    expect(settingsStore.getState().settings.editor).toEqual({
      fontSize: 18,
      tabSize: 2,
      // Each toggle is the inverse of the shipped default, which is what proves the click landed on the
      // field it names rather than on a neighbour.
      wordWrap: !DEFAULT_SETTINGS.editor.wordWrap,
      minimap: !DEFAULT_SETTINGS.editor.minimap,
      lineNumbers: !DEFAULT_SETTINGS.editor.lineNumbers,
      autoComplete: !DEFAULT_SETTINGS.editor.autoComplete,
    });
  });

  it('re-arms the ⌃E confirmation, and offers the button only when there is something to reset', async () => {
    const user = await openPanel('editor');
    expect(isDisabled('settings-editor-ctrl-e-reset')).toBe(true);

    // The tick the ⌃E dialog makes. It is one-way from that dialog, which is why this row exists.
    editorPrefsStore.getState().confirmCtrlEExecute();
    await waitFor(() => expect(isDisabled('settings-editor-ctrl-e-reset')).toBe(false));

    await user.click(screen.getByTestId('settings-editor-ctrl-e-reset'));

    expect(editorPrefsStore.getState().confirmedCtrlEExecute).toBe(false);
    expect(isDisabled('settings-editor-ctrl-e-reset')).toBe(true);
  });
});

// ── Query ──────────────────────────────────────────────────────────────────────────────────

describe('the query group', () => {
  it('writes the five live query settings', async () => {
    const user = await openPanel('query');

    await fillNumber(user, 'settings-query-max-rows', '500');
    await selectOption(user, 'settings-query-execute-scope', /statement at the caret/);
    await user.click(screen.getByTestId('settings-query-show-execution-time'));
    await user.click(screen.getByTestId('settings-query-confirm-before-execute'));
    await fillNumber(user, 'settings-query-timeout', '90');

    const query = settingsStore.getState().settings.query;
    expect(query.maxRowsToDisplay).toBe(500);
    expect(query.executeScope).toBe('currentStatement');
    expect(query.showExecutionTime).toBe(false);
    expect(query.confirmBeforeExecute).toBe(true);
    // Shown in seconds, stored in milliseconds — J-54 made this control live, and the unit it
    // writes is what `QueryRequest.timeout` and the executor's timer both expect.
    expect(query.defaultTimeout).toBe(90_000);
    expect(DEFAULT_SETTINGS.query.defaultTimeout).toBe(30_000);
  });

  it('changes what an execute sends — the executeScope consumer, end to end', async () => {
    const user = await openPanel('query');
    const source = { value: 'SELECT 1;\nSELECT 2;', selection: '', cursorLine: 2 };

    // `all` (the default): the whole editor.
    expect(textToExecute(source, settingsStore.getState().settings.query.executeScope)).toBe(
      'SELECT 1;\nSELECT 2;'
    );

    await selectOption(user, 'settings-query-execute-scope', /statement at the caret/);

    // The consumer is `query-panel.tsx` handing this scope to `editor.textToExecute`; the function is
    // pure, so the whole chain from the click to the SQL is assertable with nothing mocked.
    expect(textToExecute(source, settingsStore.getState().settings.query.executeScope)).toBe(
      'SELECT 2;'
    );
  });
});

// ── Results grid ───────────────────────────────────────────────────────────────────────────

describe('the results-grid group', () => {
  it('writes all six grid settings', async () => {
    const user = await openPanel('grid');

    await fillNumber(user, 'settings-grid-row-height', '32');
    await user.click(screen.getByTestId('settings-grid-row-numbers'));
    await user.click(screen.getByTestId('settings-grid-striped'));
    await user.click(screen.getByTestId('settings-grid-animate-rows'));
    await user.click(screen.getByTestId('settings-grid-copy-headers'));
    await selectOption(user, 'settings-grid-copy-format', /Comma-separated/);

    expect(settingsStore.getState().settings.grid).toEqual({
      rowHeight: 32,
      showRowNumbers: !DEFAULT_SETTINGS.grid.showRowNumbers,
      alternatingRowColors: !DEFAULT_SETTINGS.grid.alternatingRowColors,
      animateRows: !DEFAULT_SETTINGS.grid.animateRows,
      copyIncludeHeaders: !DEFAULT_SETTINGS.grid.copyIncludeHeaders,
      copyFormat: 'csv',
    });
  });

  it('disables the header toggle for JSON, where a header row is meaningless', async () => {
    const user = await openPanel('grid');
    expect(isDisabled('settings-grid-copy-headers')).toBe(false);

    await selectOption(user, 'settings-grid-copy-format', 'JSON');

    // Not the J-44 pattern: the consumer exists and ignores the flag for this format, which the hint
    // beside it says. `results-clipboard.ts` is where that is true.
    expect(isDisabled('settings-grid-copy-headers')).toBe(true);
  });
});

// ── Persistence, and reset ─────────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('lands a click in this panel in main-process AppState', async () => {
    const bridge = createAppStateDouble();
    teardowns.push(installJoineryMock({ app: bridge.app }));
    const user = await openPanel('grid');

    await fillNumber(user, 'settings-grid-row-height', '32');

    // The store's write is fire-and-forget, so wait on the double rather than on the click.
    await waitFor(() =>
      expect(bridge.snapshot().reactRendererState?.settings?.grid?.rowHeight).toBe(32)
    );
    // And it is stamped as authored here, which is what `migration.ts` reads to tell a considered
    // choice from a default-derived object.
    expect(bridge.snapshot().reactRendererState?.settingsAuthoredByReactAt).toBeTruthy();
  });

  it('clamps an out-of-range number and shows what was actually stored', async () => {
    const user = await openPanel('editor');

    await fillNumber(user, 'settings-editor-font-size', '400');

    expect(settingsStore.getState().settings.editor.fontSize).toBe(24);
    // No state in which the box shows a number the app is not using.
    expect(fieldValue('settings-editor-font-size')).toBe('24');
  });

  it('leaves the setting alone when the field is cleared to nothing', async () => {
    const user = await openPanel('editor');
    const field = screen.getByTestId('settings-editor-font-size');

    await user.clear(field);
    await user.tab();

    expect(settingsStore.getState().settings.editor.fontSize).toBe(
      DEFAULT_SETTINGS.editor.fontSize
    );
    expect(fieldValue('settings-editor-font-size')).toBe(String(DEFAULT_SETTINGS.editor.fontSize));
  });

  it('commits on Enter as well as on blur', async () => {
    const user = await openPanel('editor');
    const field = screen.getByTestId('settings-editor-font-size');

    await user.clear(field);
    await user.type(field, '20{Enter}');

    expect(settingsStore.getState().settings.editor.fontSize).toBe(20);
  });

  /**
   * The one thing dismissal must not do: throw away what the user typed, silently.
   *
   * **Measured in the real Electron app** (fix round 1, and the reason this block exists): typing 18 into
   * Font size and pressing Escape reopened the panel showing 14, while the scrim and the ✕ both kept 18.
   * The native `blur` fires in all three cases — a detached input still gets one in Chromium — but on
   * Escape the input is removed from the tree first, and React listens at the root container, so the
   * `focusout` of a detached node reaches nothing and `onBlur` never runs. The scrim and the ✕ move focus
   * while the field is still mounted, so their blur arrives normally.
   *
   * `SettingsDialog` therefore sweeps the pending drafts in `onOpenChange(false)`, before the store closes
   * and the fields unmount, which makes the three paths agree by construction rather than by luck about
   * the order Chromium happens to do two things in. All three are tested because the fix is one mechanism
   * for all three, and because "the ✕ works" is what made this survive the first review.
   */
  describe('a pending draft when the panel is dismissed', () => {
    const dismissals: readonly {
      readonly name: string;
      readonly dismiss: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
    }[] = [
      { name: 'Escape', dismiss: async user => user.keyboard('{Escape}') },
      {
        name: 'a click on the scrim',
        dismiss: user => user.click(screen.getByTestId('dialog-scrim')),
      },
      { name: 'the ✕', dismiss: user => user.click(screen.getByTestId('dialog-close')) },
    ];

    for (const { name, dismiss } of dismissals) {
      it(`commits it on ${name}`, async () => {
        const user = await openPanel('editor');
        const field = screen.getByTestId('settings-editor-font-size');
        await user.clear(field);
        await user.type(field, '18');
        // Still a draft: `NumberSetting` commits on blur or Enter, and neither has happened.
        expect(settingsStore.getState().settings.editor.fontSize).toBe(
          DEFAULT_SETTINGS.editor.fontSize
        );

        await dismiss(user);

        await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
        expect(settingsStore.getState().settings.editor.fontSize).toBe(18);
      });
    }

    it('commits a draft in each field, and clamps them as a blur would', async () => {
      const user = await openPanel('editor');
      const fontSize = screen.getByTestId('settings-editor-font-size');
      const tabSize = screen.getByTestId('settings-editor-tab-size');

      await user.clear(fontSize);
      await user.type(fontSize, '400');
      // Typing in the second field blurs the first, so only the second is still a draft on Escape —
      // which is the point of sweeping every registered field rather than the focused one.
      await user.clear(tabSize);
      await user.type(tabSize, '8');
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
      expect(settingsStore.getState().settings.editor.fontSize).toBe(24);
      expect(settingsStore.getState().settings.editor.tabSize).toBe(8);
    });

    it('writes nothing when the draft was never edited', async () => {
      const bridge = createAppStateDouble();
      teardowns.push(installJoineryMock({ app: bridge.app }));
      const user = await openPanel('editor');

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
      // The sweep is idempotent: each field commits only a value that differs from the stored one, so
      // opening and closing the panel does not stamp `settingsAuthoredByReactAt` on an untouched app.
      expect(settingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
      expect(bridge.snapshot().reactRendererState?.settingsAuthoredByReactAt).toBeUndefined();
    });
  });

  it('resets every group, and only on the second press', async () => {
    const user = await openPanel('editor');
    await fillNumber(user, 'settings-editor-font-size', '18');
    // The theme lives on the other tab, and reset has to reach every group rather than the open one.
    await user.click(screen.getByTestId('settings-tab-appearance'));
    await user.click(await screen.findByTestId('settings-theme-light'));
    await user.click(screen.getByTestId('settings-tab-editor'));

    await user.click(screen.getByTestId('settings-reset'));
    // One press arms it. Resetting every preference in the app from a single click next to four groups
    // of controls is too easy to do by accident.
    expect(settingsStore.getState().settings.editor.fontSize).toBe(18);
    expect(screen.getByTestId('settings-reset').textContent).toContain('Reset everything?');

    await user.click(screen.getByTestId('settings-reset'));

    expect(settingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    // The number field re-seeds from the store rather than keeping the draft it was showing.
    expect(fieldValue('settings-editor-font-size')).toBe(String(DEFAULT_SETTINGS.editor.fontSize));
  });
});
