/**
 * The keyboard cheatsheet. Replaces `shared/components/shortcuts-dialog/shortcuts-dialog.component.ts`
 * (264) — and it does not contain a single hand-written keystroke.
 *
 * ── Why that matters ────────────────────────────────────────────────────────────────────────
 *
 * The Angular version held five categories of `{ keys, description }` literals. Comparing them to
 * `packages/main/src/menu.ts` finds them **wrong in six places**: it advertised ⌘H for Query History
 * (the menu registers ⇧⌘H), ⌘⇧S for the Snippet Library (that is Save Query As, and the collision is
 * why the library's own shortcut never fired), ⌘⇧N for New Connection under "Files & Tabs" while its
 * General group listed ⌘P for object search that no menu item had, and it listed ⌘G "Go to Line",
 * ⌘D "Select Word" and F5 "Execute (Alt)" — three bindings this app does not have at all. A user who
 * trusted this dialog was misinformed, and nothing could tell.
 *
 * So the content is derived: every row comes from `COMMAND_CATALOGUE`'s accelerator field or from
 * `SURFACE_SHORTCUTS` (the palette's own ⌘K / ⇧⌘P and the editor's ⌃M, which belong to no
 * command). `catalogue.spec.ts`
 * parses `menu.ts` and `preload/src/index.ts` as text and asserts every menu-sourced accelerator here
 * equals what the main process actually registers — which is the check that could not exist while the
 * data was prose.
 *
 * The dialog also says **who owns each keystroke**, which is not decoration: a menu accelerator and a
 * renderer `keydown` behave differently when a text field has focus, and "why does ⌘K work here but
 * ⌘S not?" is answered by that column.
 */

import { useState } from 'react';

import {
  COMMAND_CATALOGUE,
  COMMAND_GROUPS,
  COMMAND_GROUP_LABELS,
  formatAcceleratorList,
  useCommand,
  type AcceleratorSource,
  type CommandGroup,
  type CommandId,
} from '../../commands';
import { SURFACE_SHORTCUTS } from '../command-palette/palette-actions';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui';

/** One line of the sheet. */
export interface ShortcutRow {
  readonly keys: readonly string[];
  readonly label: string;
  readonly hint: string;
  readonly group: CommandGroup;
  /**
   * Where the keystroke is bound: `menu`, `renderer` or `editor`. Never null — a surface shortcut has
   * no command behind it, but something still binds it, and it says which (`SurfaceShortcut.source`).
   */
  readonly source: AcceleratorSource;
}

/** Where a keystroke is bound, in words the "why does this not work here?" question needs. */
const SOURCE_LABELS: Record<AcceleratorSource, string> = {
  menu: 'Menu',
  renderer: 'App',
  editor: 'Editor',
};

/**
 * Every keystroke the app has, grouped.
 *
 * Exported for the spec, which asserts it is derived rather than authored: every row's keys have to be
 * findable in the catalogue or the surface list, and every accelerator in the catalogue has to appear
 * here. A pure function of two module constants, so it is called at render with no memo.
 */
export function shortcutRows(): readonly ShortcutRow[] {
  const rows: ShortcutRow[] = [];

  for (const id of Object.keys(COMMAND_CATALOGUE) as CommandId[]) {
    const display = COMMAND_CATALOGUE[id];
    // Every binding, not just the primary: File ▸ New Connection and Server ▸ Connect… are both real
    // keystrokes for the same command, and a sheet that showed one of them would be wrong about the
    // other (`commands/catalogue.ts`'s `alternates`).
    const formatted = formatAcceleratorList(display.accelerator);
    if (display.accelerator === null || formatted.length === 0) continue;
    rows.push({
      keys: formatted,
      label: display.label,
      hint: display.hint,
      group: display.group,
      source: display.accelerator.source,
    });
  }

  for (const shortcut of SURFACE_SHORTCUTS) {
    rows.push({
      // One accelerator at a time through the same formatter the commands use, so a surface shortcut
      // cannot render its keys by a different rule than a command's.
      keys: shortcut.keys.flatMap(keys => formatAcceleratorList({ source: shortcut.source, keys })),
      label: shortcut.label,
      hint: shortcut.hint,
      group: shortcut.group,
      // The list's own answer, not a constant: the palette's opener is a window `keydown` and the
      // editor's ⌃M is a Monaco keybinding, and a sheet that called both "App" would be telling a
      // user the escape works outside the editor (J-133).
      source: shortcut.source,
    });
  }

  return rows;
}

/** The rows of one group, in catalogue order. Empty groups are not rendered. */
function rowsByGroup(rows: readonly ShortcutRow[]): readonly [CommandGroup, ShortcutRow[]][] {
  return COMMAND_GROUPS.map(
    group => [group, rows.filter(row => row.group === group)] as [CommandGroup, ShortcutRow[]]
  ).filter(([, groupRows]) => groupRows.length > 0);
}

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  // Help ▸ Keyboard Shortcuts (⇧⌘/) through the menu bridge, and the palette's own entry.
  useCommand('show-shortcuts', () => setOpen(true));

  if (!open) return null;

  const groups = rowsByGroup(shortcutRows());

  return (
    <Dialog open onOpenChange={next => setOpen(next)}>
      <DialogContent size="lg" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every binding in Joinery, read from the same table the menus and the command palette
            use.
          </DialogDescription>
        </DialogHeader>

        {/* Two columns in a wide window, one in a narrow one — `@container` per HOUSE-RULES §1, on the
            wrapper around the responsive content rather than on the shell. */}
        <DialogBody className="@container">
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 @2xl:grid-cols-2">
            {groups.map(([group, rows]) => (
              <section key={group} data-testid={`shortcuts-group-${group}`}>
                <h3 className="border-b border-rule pb-1 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
                  {COMMAND_GROUP_LABELS[group]}
                </h3>
                <ul className="flex flex-col">
                  {rows.map(row => (
                    <li
                      key={`${group}:${row.label}`}
                      data-testid="shortcuts-row"
                      className="flex min-w-0 items-baseline gap-3 border-b border-rule py-1.5 last:border-b-0"
                    >
                      <span className="min-w-0 grow truncate text-base text-fg" title={row.hint}>
                        {row.label}
                      </span>
                      <span
                        data-testid="shortcuts-row-source"
                        // `text-fg-muted`, not subtle: HOUSE-RULES §5 reserves subtle for metadata
                        // nobody has to read, and this column is the answer to "why does this key not
                        // work here?". The both-theme gate measured subtle at 3.57:1 under ink.
                        className="shrink-0 font-mono text-2xs tracking-eyebrow text-fg-muted uppercase"
                      >
                        {SOURCE_LABELS[row.source]}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {row.keys.map(keys => (
                          <kbd
                            key={keys}
                            data-testid="shortcuts-row-keys"
                            className="rounded-xs border border-rule bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg"
                          >
                            {keys}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
