/**
 * The cheatsheet, and the proof that its content is **derived** rather than authored.
 *
 * The Angular dialog held 29 hand-written `{ keys, description }` literals and six of them were wrong
 * (`shortcuts-dialog.tsx`'s header lists them). The tests below make that class of error impossible in
 * two steps: every row's keystroke must be one the catalogue declares (so nothing can be invented), and
 * every accelerator the catalogue declares must appear as a row (so nothing can be forgotten). The
 * catalogue itself is checked against `packages/main/src/menu.ts` in `commands/catalogue.spec.ts`, so
 * the chain from a menu binding to a printed key has no hand-copied link in it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import { dispatchCommand, handlerCount } from '../../commands';
import {
  COMMAND_CATALOGUE,
  formatAcceleratorList,
  type AcceleratorSource,
} from '../../commands/catalogue';
import { COMMAND_IDS, type CommandId } from '../../commands/registry';
import { SURFACE_SHORTCUTS } from '../command-palette/palette-actions';
import { ShortcutsDialog, shortcutRows } from './shortcuts-dialog';

const teardowns: (() => void)[] = [];

beforeEach(() => {
  const rendered = render(<ShortcutsDialog />);
  teardowns.push(rendered.unmount);
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  for (const id of COMMAND_IDS) expect(handlerCount(id)).toBe(0);
});

/** Every keystroke the catalogue and the surface list declare, formatted. */
function declaredKeystrokes(): Set<string> {
  const keys = new Set<string>();
  for (const id of COMMAND_IDS) {
    for (const formatted of formatAcceleratorList(COMMAND_CATALOGUE[id].accelerator)) {
      keys.add(formatted);
    }
  }
  for (const shortcut of SURFACE_SHORTCUTS) {
    for (const entry of shortcut.keys) {
      for (const formatted of formatAcceleratorList({ source: shortcut.source, keys: entry })) {
        keys.add(formatted);
      }
    }
  }
  return keys;
}

describe('shortcutRows', () => {
  it('lists a row for every accelerator the catalogue declares', () => {
    const rows = shortcutRows();
    const rowLabels = new Set(rows.map(row => row.label));

    const missing = COMMAND_IDS.filter(id => {
      if (COMMAND_CATALOGUE[id].accelerator === null) return false;
      return !rowLabels.has(COMMAND_CATALOGUE[id].label);
    });

    expect(missing).toEqual([]);
    // And the surface shortcuts, which belong to no command.
    for (const shortcut of SURFACE_SHORTCUTS) expect(rowLabels).toContain(shortcut.label);
  });

  it('invents no keystroke of its own', () => {
    const declared = declaredKeystrokes();
    for (const row of shortcutRows()) {
      for (const keys of row.keys) {
        expect(declared, `${row.label} shows ${keys}, which nothing declares`).toContain(keys);
      }
    }
  });

  it('lists no row for a command with no binding', () => {
    const rows = shortcutRows();
    const unbound = COMMAND_IDS.filter(id => COMMAND_CATALOGUE[id].accelerator === null);
    // At least one command has no keystroke, or this test is vacuous.
    expect(unbound.length).toBeGreaterThan(5);

    for (const id of unbound) {
      // A label may coincide with a bound command's label; the check is that no row was ADDED for it,
      // which shows up as a row count equal to the number of bound commands plus the surface shortcuts.
      expect(COMMAND_CATALOGUE[id].accelerator).toBeNull();
    }
    const bound = COMMAND_IDS.filter(id => COMMAND_CATALOGUE[id].accelerator !== null).length;
    expect(rows).toHaveLength(bound + SURFACE_SHORTCUTS.length);
  });

  it('says where each keystroke is bound', () => {
    const sources = new Set<AcceleratorSource>(shortcutRows().map(row => row.source));
    // All three, because the distinction is the point: a menu accelerator, a renderer keydown and a
    // Monaco binding behave differently when a text field has focus.
    expect(sources).toEqual(new Set(['menu', 'renderer', 'editor']));
  });

  it('lists the editor’s way out of the Tab trap (J-133)', () => {
    // WCAG 2.1.2 does not stop at "an escape exists": it requires the user be ADVISED of it. ⌃M was
    // bound in `editor/sql-editor.tsx` and named in no in-app surface at all, so the only way to
    // learn it was to read the source or the docs site. It is a surface shortcut rather than a
    // command because nothing dispatches it — Monaco owns the keystroke and the behaviour.
    const escape = shortcutRows().find(row => row.keys.includes('Ctrl+M'));
    expect(escape, 'no row advertises the tab-focus escape').toBeDefined();
    // Bound by Monaco, so it reads Editor and not App — a user who presses it in the results grid
    // needs the column to tell them why nothing happened.
    expect(escape?.source).toBe('editor');
    expect(escape?.group).toBe('editor');
  });

  it('carries both bindings of a command that has two', () => {
    const newConnection = shortcutRows().find(
      row => row.label === COMMAND_CATALOGUE['open-connection-dialog'].label
    );
    expect(newConnection?.keys).toHaveLength(2);
    // jsdom is not a Mac, so `CmdOrCtrl` resolves to the key this platform actually presses (J-114).
    expect(newConnection?.keys).toEqual(['Ctrl+Shift+N', 'Ctrl+Shift+C']);
  });

  it('does not advertise the six shortcuts the Angular sheet got wrong', () => {
    const rows = shortcutRows();
    const printed = new Set(rows.flatMap(row => row.keys));
    // ⌘G "Go to Line", ⌘D "Select Word", ⌘L "Select Line", F5 "Execute (Alt)" and ⌘Return "Execute
    // (Alt)" were bindings this app has never had.
    for (const invented of ['Ctrl+G', 'Ctrl+D', 'Ctrl+L', 'F5', 'Ctrl+Return']) {
      expect(printed, `the sheet advertises ${invented}`).not.toContain(invented);
    }
    // The sixth, ⌘H "Query History", was wrong rather than invented — it is ⇧⌘H. `Ctrl+H` IS printed
    // off macOS, but for Find and replace (`catalogue.ts`'s `{ mac: 'Cmd+Option+F', other: 'Ctrl+H' }`),
    // so this one has to be asserted against the row and not the flat key list.
    const history = rows.find(row => row.label === COMMAND_CATALOGUE['open-query-history'].label);
    expect(history?.keys).toEqual(['Ctrl+Shift+H']);
    const replace = rows.find(row => row.label === COMMAND_CATALOGUE['editor-replace'].label);
    expect(replace?.keys).toEqual(['Ctrl+H']);
    // And the one it advertised for the snippet library, which was Save Query As.
    expect(printed).toContain('Ctrl+Shift+S');
    const saveAs = shortcutRows().find(row => row.keys.includes('Ctrl+Shift+S'));
    expect(saveAs?.label).toBe(COMMAND_CATALOGUE['save-query-as'].label);
  });
});

describe('the dialog', () => {
  it('renders nothing until the command asks for it', () => {
    expect(screen.queryByTestId('shortcuts-dialog')).toBeNull();
  });

  it('opens on show-shortcuts and renders every row', async () => {
    dispatchCommand('show-shortcuts');

    const dialog = await screen.findByTestId('shortcuts-dialog');
    const rows = within(dialog).getAllByTestId('shortcuts-row');
    expect(rows).toHaveLength(shortcutRows().length);
    // Grouped, and each group heading is the catalogue's own label.
    expect(within(dialog).getByTestId('shortcuts-group-file')).not.toBeNull();
    expect(within(dialog).getByTestId('shortcuts-group-help')).not.toBeNull();
    // Every row shows at least one key and where it is bound.
    for (const row of rows) {
      expect(within(row).getAllByTestId('shortcuts-row-keys').length).toBeGreaterThan(0);
      expect(within(row).getByTestId('shortcuts-row-source').textContent).toMatch(
        /Menu|App|Editor/
      );
    }
  });

  it('closes again, and can be reopened', async () => {
    dispatchCommand('show-shortcuts');
    await screen.findByTestId('shortcuts-dialog');

    within(screen.getByTestId('shortcuts-dialog')).getByTestId('dialog-close').click();
    await waitFor(() => expect(screen.queryByTestId('shortcuts-dialog')).toBeNull());

    dispatchCommand('show-shortcuts');
    expect(await screen.findByTestId('shortcuts-dialog')).not.toBeNull();
  });

  it('shows a command’s own hint as the row’s title, not as a second line', async () => {
    // A cheatsheet is scanned, not read: 40 rows with two lines each would be a wall. The hint is the
    // `title`, which is what a hover asks for.
    dispatchCommand('show-shortcuts');
    const dialog = await screen.findByTestId('shortcuts-dialog');

    const label = COMMAND_CATALOGUE['toggle-sidebar' as CommandId].label;
    const row = within(dialog)
      .getAllByTestId('shortcuts-row')
      .find(candidate => candidate.textContent?.includes(label));
    expect(row?.querySelector('[title]')?.getAttribute('title')).toBe(
      COMMAND_CATALOGUE['toggle-sidebar'].hint
    );
  });
});
