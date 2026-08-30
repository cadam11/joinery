/**
 * The palette's **local actions**: entries that are not commands, and the reason they are allowed
 * not to be.
 *
 * ── Why these are not registry commands ─────────────────────────────────────────────────────
 *
 * `commands/registry.ts` earns its keep by refusing a command with no named consumer, and
 * `bus.spec.tsx` refuses a named consumer that does not actually subscribe. Adding `toggle-theme` to
 * that registry would name **the palette itself** as the consumer of a command **the palette
 * produces** — a self-loop, which makes `COMMAND_CONSUMERS` say something true-shaped and useless,
 * and turns the ownership test vacuous for that entry. Task 7's review called out exactly this
 * failure mode ("the rewritten dead-command guard is VACUOUS"), so it is worth not re-introducing.
 *
 * The dead-dispatch risk does not exist here in any case: a local action holds a **function**, called
 * in the same tick, in the same package. There is no id, no lookup, and nothing to be unsubscribed —
 * "the palette dispatched into silence" is not a state these can be in. What they can be is *wrong*,
 * so every one of them is exercised by `palette-actions.spec.ts`, whose expectation table is a
 * `Record` over the id union below: adding an action without proving it does something does not
 * compile.
 *
 * The line, stated plainly: an entry that **opens or affects another surface** goes through the bus
 * (that is what the bus is for, and it is how the palette reaches the snippet library, the object
 * search and the cheatsheet). An entry that writes one store and needs no other surface stays here.
 */

import { Layers, Monitor, Moon, SquareX, Sun, type LucideIcon } from 'lucide-react';
import type { ThemePreference } from '@joinery/shared';

import type { AcceleratorKeys, AcceleratorSource, CommandGroup } from '../../commands';
import { settingsStore } from '../../state/settings';
import { selectActiveTab, tabStore } from '../../state/tab';
import { THEME_OPTIONS } from '../../shell/status-bar';

/** Every local action, so the spec's expectation table can be exhaustive over it. */
export const PALETTE_ACTION_IDS = [
  'theme-system',
  'theme-ivory',
  'theme-ink',
  'close-all-tabs',
  'close-other-tabs',
] as const;

export type PaletteActionId = (typeof PALETTE_ACTION_IDS)[number];

export interface PaletteAction {
  readonly id: PaletteActionId;
  readonly label: string;
  readonly hint: string;
  readonly group: CommandGroup;
  readonly icon: LucideIcon;
  /** Side-effecting, by definition. Runs after the palette has closed. */
  readonly run: () => void;
}

/** One theme entry. The labels come from the status bar's table, so the app has one name per theme. */
function themeAction(
  id: PaletteActionId,
  preference: ThemePreference,
  hint: string,
  icon: LucideIcon
): PaletteAction {
  return {
    id,
    label: `Theme: ${THEME_OPTIONS[preference].label}`,
    hint,
    group: 'settings',
    icon,
    run: () => settingsStore.getState().updateTheme(preference),
  };
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  themeAction('theme-system', 'system', 'Follow the operating system', Monitor),
  themeAction('theme-ivory', 'light', 'The light canvas', Sun),
  themeAction('theme-ink', 'dark', 'The dark canvas', Moon),
  {
    id: 'close-all-tabs',
    label: 'Close all tabs',
    hint: 'Close every open tab',
    group: 'file',
    icon: Layers,
    run: () => tabStore.getState().closeAllTabs(),
  },
  {
    id: 'close-other-tabs',
    label: 'Close other tabs',
    hint: 'Keep the tab in front and close the rest',
    group: 'file',
    icon: SquareX,
    run: () => {
      const active = selectActiveTab(tabStore.getState());
      if (active !== null) tabStore.getState().closeOtherTabs(active.id);
    },
  },
];

/**
 * Keystrokes that belong to a surface rather than to a command, for the cheatsheet to list.
 *
 * Two entries: this palette's own opener, and the SQL editor's tab-focus escape. Neither is a
 * palette entry — an item that opens the thing you are looking at is noise, and an item that toggles
 * the editor you are not in is worse — which is why this is a separate list from `PALETTE_ACTIONS`
 * rather than a flag on it.
 */
export interface SurfaceShortcut {
  readonly label: string;
  readonly hint: string;
  readonly group: CommandGroup;
  /**
   * Who holds the keystroke, in the same vocabulary a command's accelerator uses. Not a constant:
   * the palette's opener is a window `keydown` (`renderer`) and the editor's escape is a Monaco
   * keybinding (`editor`), and the cheatsheet's source column is how a user finds out why a key that
   * works in one place does nothing in another. `catalogue.spec.ts`'s collision guard reads it too —
   * only the `renderer` ones can lose a keystroke to a menu accelerator.
   */
  readonly source: AcceleratorSource;
  /** One or more accelerators, all doing the same thing. Rendered in order. */
  readonly keys: readonly AcceleratorKeys[];
}

export const SURFACE_SHORTCUTS: readonly SurfaceShortcut[] = [
  {
    label: 'Command palette',
    hint: 'Everything this app can do, by name',
    group: 'help',
    source: 'renderer',
    // Two bindings, because both are muscle memory: ⌘K from Linear/Slack, ⇧⌘P from VS Code. Neither
    // is a menu accelerator, so the renderer owns both (`command-palette.tsx`).
    keys: ['CmdOrCtrl+K', 'CmdOrCtrl+Shift+P'],
  },
  {
    label: 'Toggle tab-focus mode',
    hint: 'Switch Tab between indenting and moving focus out of the SQL editor',
    group: 'editor',
    source: 'editor',
    // The keyboard trap's advertised way out (J-133, WCAG 2.1.2). Bound in
    // `editor/sql-editor.tsx`, which picks the modifier per platform — `WinCtrl` on macOS,
    // `CtrlCmd` elsewhere — so that Control-M is the key on both. `'Control+M'` is the Electron
    // spelling of exactly that: `formatAccelerator` renders it ⌃M on macOS and `Ctrl+M` off it.
    //
    // Here rather than in `COMMAND_CATALOGUE` because a catalogue entry is a command the bus
    // dispatches, and this one has no handler to dispatch to: Monaco owns both the keystroke and
    // the behaviour, and there is no window-level path that could reach it.
    keys: ['Control+M'],
  },
];
