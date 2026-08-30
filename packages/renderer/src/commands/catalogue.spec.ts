/**
 * The catalogue, checked against the main process rather than against itself.
 *
 * ── The mechanical accelerator check ────────────────────────────────────────────────────────
 *
 * `packages/main/src/menu.ts` is the source of truth for every menu accelerator, and the renderer may
 * not import from it — so `catalogue.ts` restates the values, and a restatement rots. Task 7's review
 * found three of the registry's accelerator COMMENTS already wrong.
 *
 * This spec closes that by reading both files as text and composing the chain the app really uses:
 *
 *   menu.ts        `accelerator: 'CmdOrCtrl+N'` … `send('menu:new-query')`   → channel → keys
 *   preload        `NEW_QUERY: 'menu:new-query'` … `onNewQuery: … NEW_QUERY` → channel → `on*`
 *   menu-bridge    `onNewQuery: 'new-query'`                                 → `on*` → command id
 *
 * so every menu-sourced accelerator in the catalogue is compared with what `menu.ts` registers for
 * the command it belongs to. `?raw` rather than a filesystem read because this package compiles
 * without `@types/node` — the same mechanism `markdown/sanitize-parity.spec.ts` uses, and it means
 * the imports cannot silently stop resolving.
 *
 * The parse is asserted to have found something first: a regex that matched nothing would make every
 * comparison below vacuous, which is the failure mode a source-scanning test has.
 */

import { describe, expect, it } from 'vitest';

import MENU_SOURCE from '../../../main/src/menu.ts?raw';
import PRELOAD_SOURCE from '../../../preload/src/index.ts?raw';
import { SURFACE_SHORTCUTS } from '../features/command-palette/palette-actions';
import { MENU_COMMANDS } from '../shell/menu-bridge';
import type { PayloadlessCommandId } from './bus';
import {
  COMMAND_CATALOGUE,
  COMMAND_GROUPS,
  COMMAND_GROUP_LABELS,
  acceleratorKeysForPlatform,
  commandAccelerator,
  formatAccelerator,
  paletteCommandIds,
  type AcceleratorKeys,
  type CatalogueEntry,
} from './catalogue';
import { COMMAND_IDS, type CommandId } from './registry';

// ── Parsing `menu.ts` ────────────────────────────────────────────────────────────────────────

/** One accelerator as `menu.ts` spells it: a literal, or the two halves of an `isMac` ternary. */
type ParsedKeys = AcceleratorKeys;

/**
 * Channel → accelerator, for every `webContents.send('menu:…')` in the menu definition.
 *
 * The scan walks three token kinds in source order — `label:`, `accelerator:`, `send('menu:…')` — and
 * pairs a send with the accelerator of the item it is inside. `label:` resets the pending
 * accelerator, which is what stops an item WITHOUT one (Server ▸ Disconnect, Database ▸ Backup)
 * inheriting the previous item's keys.
 */
function parseMenuAccelerators(source: string): Map<string, ParsedKeys[]> {
  const TOKENS =
    /label:|accelerator:\s*(?:isMac\s*\?\s*'([^']+)'\s*:\s*'([^']+)'|'([^']+)')|send\('(menu:[a-z-]+)'\)/g;
  // A LIST per channel, not one value: two menu items send `menu:new-connection` (File ▸ New
  // Connection at ⇧⌘N, Server ▸ Connect… at ⇧⌘C) and two send `menu:open-settings`. Overwriting would
  // have silently checked only whichever came last in the file.
  const found = new Map<string, ParsedKeys[]>();
  let pending: ParsedKeys | null = null;

  for (const match of source.matchAll(TOKENS)) {
    const [token, macBranch, otherBranch, literal, channel] = match;

    if (channel !== undefined) {
      const existing = found.get(channel) ?? [];
      if (pending !== null) existing.push(pending);
      found.set(channel, existing);
      pending = null;
      continue;
    }
    if (token.startsWith('label:')) {
      pending = null;
      continue;
    }
    pending =
      literal !== undefined
        ? unescapeSource(literal)
        : { mac: unescapeSource(macBranch ?? ''), other: unescapeSource(otherBranch ?? '') };
  }

  return found;
}

/**
 * A TypeScript string literal's source text as its VALUE. Only one escape appears in these
 * accelerators — `'CmdOrCtrl+\\'` for ⌘\ — and comparing source text to a value would fail on it,
 * which is exactly the sort of false positive that gets a source-scanning test deleted.
 */
function unescapeSource(literal: string): string {
  return literal.replace(/\\\\/g, '\\');
}

/** `on*` member → channel string, from preload's own two tables. */
function parsePreloadChannels(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*): '(menu:[a-z-]+)',$/gm)) {
    constants.set(match[1] ?? '', match[2] ?? '');
  }

  const members = new Map<string, string>();
  for (const match of source.matchAll(
    /(on[A-Z][A-Za-z]*): callback =>\s*\n?\s*createEventListener\(MENU_CHANNELS\.([A-Z][A-Z0-9_]*),/g
  )) {
    const channel = constants.get(match[2] ?? '');
    if (channel !== undefined) members.set(match[1] ?? '', channel);
  }
  return members;
}

const MENU_ACCELERATORS = parseMenuAccelerators(MENU_SOURCE);
const PRELOAD_CHANNELS = parsePreloadChannels(PRELOAD_SOURCE);

/** Command id → every accelerator `menu.ts` registers for the channel that reaches it. */
const ACCELERATOR_BY_COMMAND = new Map<CommandId, ParsedKeys[]>(
  Object.entries(MENU_COMMANDS).flatMap(([member, commandId]) => {
    const channel = PRELOAD_CHANNELS.get(member);
    if (channel === undefined) return [];
    return [[commandId, MENU_ACCELERATORS.get(channel) ?? []] as [CommandId, ParsedKeys[]]];
  })
);

/** Every binding a catalogue entry declares: the primary plus its alternates. */
function declaredKeys(id: CommandId): ParsedKeys[] {
  const accelerator = COMMAND_CATALOGUE[id].accelerator;
  if (accelerator === null) return [];
  return [accelerator.keys, ...(accelerator.alternates ?? [])];
}

/**
 * Comparable, order-independent, de-duplicated form of a key set.
 *
 * Normalized through `normalizeAccelerator` so `'Cmd+,'` and `'CmdOrCtrl+,'` count as one keystroke:
 * the app menu's Settings and the Edit menu's Preferences both register ⌘, (menu.ts:21,176), spelled
 * differently because the app menu is macOS-only. They are the same key to a user, and the catalogue
 * declares it once.
 */
function keySet(keys: readonly ParsedKeys[]): string[] {
  const forms = keys.map(entry =>
    typeof entry === 'string'
      ? normalizeAccelerator(entry)
      : `${normalizeAccelerator(entry.mac)}|${normalizeAccelerator(entry.other)}`
  );
  return [...new Set(forms)].sort();
}

describe('the source scan found what it is checking', () => {
  it('parsed the menu definition', () => {
    // 30 channels, and most of them carry an accelerator. A parse that degraded to nothing would make
    // every comparison below pass silently.
    //
    // It was 31 until J-92 added `menu:open-ai-setup`. That channel is registered by TWO items — the
    // macOS app menu's and the Edit menu's, exactly as Settings is — and this map is keyed by
    // CHANNEL, so it contributes one entry with an empty accelerator list, asserted below. J-104
    // then took `menu:server-properties` and `menu:database-properties` out of `menu.ts` along with
    // the dead Properties items that sent them, leaving 30.
    expect(MENU_ACCELERATORS.size).toBe(30);
    expect([...MENU_ACCELERATORS.values()].filter(keys => keys.length > 0).length).toBeGreaterThan(
      20
    );
    expect(MENU_ACCELERATORS.get('menu:new-query')).toEqual(['CmdOrCtrl+N']);
    expect(MENU_ACCELERATORS.get('menu:execute-selection')).toEqual([
      { mac: 'Cmd+Shift+Return', other: 'Ctrl+Shift+E' },
    ]);
    // The two-item channel, both bindings found.
    expect(MENU_ACCELERATORS.get('menu:new-connection')).toEqual([
      'CmdOrCtrl+Shift+N',
      'CmdOrCtrl+Shift+C',
    ]);
    // An item with no accelerator must come back empty rather than inheriting its neighbour's.
    expect(MENU_ACCELERATORS.get('menu:backup')).toEqual([]);
    expect(MENU_ACCELERATORS.get('menu:disconnect')).toEqual([]);
    // AI Setup… sits directly under Settings in both menus, and Settings has ⌘,. Two items, still no
    // accelerator — this is the case that would break first if the parse leaked across siblings.
    expect(MENU_ACCELERATORS.get('menu:open-ai-setup')).toEqual([]);
  });

  it('parsed preload and joined the two, one accelerator per routed channel', () => {
    expect(PRELOAD_CHANNELS.get('onNewQuery')).toBe('menu:new-query');
    expect(PRELOAD_CHANNELS.size).toBe(Object.keys(MENU_COMMANDS).length);
    expect(ACCELERATOR_BY_COMMAND.size).toBe(Object.keys(MENU_COMMANDS).length);
  });
});

describe('every accelerator in the catalogue is the one the main process registers', () => {
  for (const [member, commandId] of Object.entries(MENU_COMMANDS)) {
    it(`${member} → ${commandId}`, () => {
      const registered = ACCELERATOR_BY_COMMAND.get(commandId) ?? [];
      const declared = COMMAND_CATALOGUE[commandId].accelerator;

      if (registered.length === 0) {
        // The menu item has no accelerator. The catalogue may declare nothing, or a renderer-owned or
        // editor-owned key — never a `menu` one, because there is no menu binding to be the source of.
        if (declared !== null) expect(declared.source).not.toBe('menu');
        return;
      }

      expect(declared, `${commandId} has no accelerator, but menu.ts registers one`).not.toBeNull();
      expect(keySet(declaredKeys(commandId))).toEqual(keySet(registered));
      // ⌘E and ⌘A are declared with `registerAccelerator: false`, so the menu SHOWS them and Monaco
      // BINDS them — `source: 'editor'`. Everything else the menu registers is `source: 'menu'`.
      expect(['menu', 'editor']).toContain(declared?.source);
    });
  }

  it('claims no menu source for a command with no menu channel', () => {
    // Widened to the full id union: `MENU_COMMANDS`' values are payload-free by type, and the ids being
    // filtered are not.
    const routed = new Set<CommandId>(Object.values(MENU_COMMANDS));
    const liars = COMMAND_IDS.filter(id => {
      const accelerator = COMMAND_CATALOGUE[id].accelerator;
      return accelerator !== null && accelerator.source === 'menu' && !routed.has(id);
    });
    expect(liars).toEqual([]);
  });

  it('keeps every renderer-owned key off every registered accelerator', () => {
    // The Angular snippet library's ⇧⌘S sat on File ▸ Save Query As, so Electron fired the menu item
    // and the library's own keydown never ran. Any renderer-owned key that collides with a REGISTERED
    // accelerator is dead on arrival, and this is what catches the next one.
    //
    // "Registered" is the union of THREE sources, and the guard was blind to two of them until this
    // round: the accelerators `menu.ts` spells out, the ones its `role:` items imply (Electron binds
    // ⌘R, ⌘M, ⌥⌘I … without the word `accelerator` appearing anywhere), and the surface shortcuts this
    // package owns itself. All five renderer-owned keystrokes in the app are checked against the lot.
    const collisions = RENDERER_OWNED_KEYS.filter(owned =>
      owned.forms.some(form => REGISTERED_KEYS.has(form))
    );

    expect(collisions.map(owned => owned.owner)).toEqual([]);
  });

  it('leaves an editor-bound surface shortcut out of the renderer-owned set', () => {
    // The surface list is no longer renderer-only: ⌃M is a surface shortcut whose keystroke Monaco
    // binds, not a window `keydown` (J-133). Folding it into the guard would assert the wrong rule
    // — a Monaco keybinding is dispatched from the editor's own container element
    // (`standaloneServices.js:259-268`), not from the window listener this guard protects.
    const editorBound = SURFACE_SHORTCUTS.filter(shortcut => shortcut.source === 'editor');
    expect(editorBound.length, 'no editor-bound surface shortcut, so this test is vacuous').toBe(1);

    const owners = RENDERER_OWNED_KEYS.map(owned => owned.owner);
    for (const shortcut of editorBound) {
      expect(owners).not.toContain(`surface: ${shortcut.label}`);
    }
  });

  it('gives each of the five renderer-owned keystrokes to exactly one owner', () => {
    // The other collision that kills a keystroke: two renderer surfaces claiming it. Both listeners
    // run, so the loser is whichever `preventDefault`s second — a bug with no error anywhere.
    expect(RENDERER_OWNED_KEYS.map(owned => owned.owner).sort()).toEqual([
      'open-object-search',
      'open-snippets',
      'surface: Command palette',
      'surface: Command palette',
      'toggle-output-panel',
    ]);

    const byForm = new Map<string, string[]>();
    for (const owned of RENDERER_OWNED_KEYS) {
      for (const form of owned.forms) {
        byForm.set(form, [...(byForm.get(form) ?? []), owned.owner]);
      }
    }
    const shared = [...byForm.entries()].filter(([, owners]) => owners.length > 1);
    expect(shared).toEqual([]);
    // Five keystrokes on macOS — ⌘J, ⌘P, ⌥⌘S, ⌘K, ⇧⌘P — and the count is asserted so a key that
    // silently disappears from the app is a failure rather than a shorter list.
    expect(new Set([...byForm.keys()].filter(form => form.includes('cmdorctrl'))).size).toBe(5);
  });
});

/**
 * `Cmd+Shift+S` and `CmdOrCtrl+Shift+S` are the same keystroke on macOS. Compare them as one.
 *
 * The parts are **sorted** as well as spelled one way, because the two sides of these comparisons are
 * written by different hands: Electron's own role accelerators read `Alt+Cmd+I` while this package
 * spells the same shape `Cmd+Option+S`. A modifier set is unordered to the OS, so it is unordered
 * here; the loss is that a differently-ordered spelling of the same keystroke compares equal, which is
 * the correct answer.
 */
function normalizeAccelerator(keys: string): string {
  return keys
    .split('+')
    .map(part => (part === 'Cmd' || part === 'Command' ? 'CmdOrCtrl' : part))
    .map(part => (part === 'Option' ? 'Alt' : part))
    .map(part => part.toLowerCase())
    .sort()
    .join('+');
}

/** Every spelling of one key spec, normalized — a split accelerator contributes both branches. */
function keyForms(keys: readonly AcceleratorKeys[]): string[] {
  return keys
    .flatMap(entry => (typeof entry === 'string' ? [entry] : [entry.mac, entry.other]))
    .map(normalizeAccelerator);
}

// ── What Electron actually binds ─────────────────────────────────────────────────────────────

/**
 * The accelerator each `role:` in `menu.ts` implies, because a role carries one WITHOUT the word
 * `accelerator` appearing in the source — which is exactly how the previous version of the collision
 * guard managed to be blind to ⌘R, ⌘Q, ⌘M and ⌥⌘I.
 *
 * Values are Electron's defaults for the roles this app uses (both platforms where they differ), from
 * the Menu roles documentation. The table is checked for coverage below: every role `menu.ts` mentions
 * must appear here, so adding `role: 'print'` to the menu fails this spec until its keystroke is
 * declared, rather than silently killing a renderer key.
 */
const ROLE_ACCELERATORS: Record<string, readonly string[]> = {
  about: [],
  services: [],
  hide: ['Cmd+H'],
  hideOthers: ['Cmd+Alt+H'],
  unhide: [],
  quit: ['CmdOrCtrl+Q'],
  undo: ['CmdOrCtrl+Z'],
  redo: ['CmdOrCtrl+Shift+Z', 'Ctrl+Y'],
  cut: ['CmdOrCtrl+X'],
  // `menu.ts` uses a custom Copy item (so the renderer can claim ⌘C for the grid) and only mentions
  // `role: 'copy'` in the comment explaining that. Declared anyway: the coverage scan below reads the
  // source as text, and a role named in a comment today can be a real item tomorrow.
  copy: ['CmdOrCtrl+C'],
  paste: ['CmdOrCtrl+V'],
  // Edit ▸ Delete is the Delete key itself, which Electron does not register as an accelerator.
  delete: [],
  // `menu.ts:134-138` overrides this role with `registerAccelerator: false`, so ⌘A is SHOWN in the menu
  // and bound by Monaco — the one role in this table whose keystroke is deliberately not registered.
  selectAll: [],
  resetZoom: ['CmdOrCtrl+0'],
  zoomIn: ['CmdOrCtrl+Plus', 'CmdOrCtrl+Shift+='],
  zoomOut: ['CmdOrCtrl+-'],
  togglefullscreen: ['Ctrl+Cmd+F', 'F11'],
  reload: ['CmdOrCtrl+R'],
  forceReload: ['CmdOrCtrl+Shift+R'],
  toggleDevTools: ['Alt+Cmd+I', 'Ctrl+Shift+I'],
  minimize: ['CmdOrCtrl+M'],
  zoom: [],
  front: [],
  window: [],
  close: ['CmdOrCtrl+W'],
  help: [],
};

/** Every `role:` the menu definition mentions. */
const MENU_ROLES = new Set(
  [...MENU_SOURCE.matchAll(/role:\s*'([A-Za-z]+)'/g)].map(match => match[1] ?? '')
);

/**
 * Every keystroke Electron binds: the spelled-out accelerators plus the role-implied ones.
 *
 * ⌘E and ⌘A are removed because `menu.ts` declares them `registerAccelerator: false` — shown in the
 * menu, bound by Monaco — and they are therefore legal for the editor to claim.
 */
const REGISTERED_KEYS: ReadonlySet<string> = (() => {
  const registered = new Set([
    ...keyForms([...MENU_ACCELERATORS.values()].flat()),
    ...keyForms(Object.values(ROLE_ACCELERATORS).flat()),
  ]);
  registered.delete(normalizeAccelerator('CmdOrCtrl+E'));
  registered.delete(normalizeAccelerator('CmdOrCtrl+A'));
  return registered;
})();

/**
 * Every keystroke the RENDERER owns — a catalogue command with `source: 'renderer'`, plus the
 * renderer-bound surface shortcuts that belong to no command (the palette's own ⌘K / ⇧⌘P, which the
 * cheatsheet lists from `SURFACE_SHORTCUTS`). Folded together because they are the same risk: a
 * keydown listener that never fires because something above it took the key.
 *
 * `source: 'renderer'` is the filter on both halves, and on the surface list it is load-bearing since
 * J-133 put the editor's ⌃M there: a Monaco keybinding is dispatched from the editor's own container
 * element (`standaloneServices.js:259-268`) rather than from the window listener this guard protects,
 * so folding it in would assert a rule it does not live under.
 */
const RENDERER_OWNED_KEYS: readonly { owner: string; forms: readonly string[] }[] = [
  ...COMMAND_IDS.filter(id => COMMAND_CATALOGUE[id].accelerator?.source === 'renderer').map(id => ({
    owner: id as string,
    forms: keyForms(declaredKeys(id)),
  })),
  ...SURFACE_SHORTCUTS.filter(shortcut => shortcut.source === 'renderer').flatMap(shortcut =>
    shortcut.keys.map(keys => ({
      owner: `surface: ${shortcut.label}`,
      forms: keyForms([keys]),
    }))
  ),
];

describe('the collision guard knows what the main process binds', () => {
  it('declares a keystroke for every role the menu uses', () => {
    expect(MENU_ROLES.size).toBeGreaterThan(15);
    const undeclared = [...MENU_ROLES].filter(
      role => !Object.prototype.hasOwnProperty.call(ROLE_ACCELERATORS, role)
    );
    expect(undeclared, 'a menu role with no declared keystroke hides a collision').toEqual([]);
  });

  it('has the role-implied keystrokes in the registered set', () => {
    // Named spot-checks, so a table that degraded to all-empty arrays cannot pass the coverage test
    // above and call it a day. ⌘R used to be the interesting one: `menu.ts` registered it TWICE —
    // View ▸ Reload Window via `role: 'reload'`, and Server ▸ Refresh Object Explorer — so one of
    // the two was unreachable by keyboard, and which one lost depended on construction order.
    // J-58 dropped the role; ⌘R now belongs to the object explorer alone, and Reload Window is
    // `role: 'forceReload'` at ⇧⌘R.
    expect(REGISTERED_KEYS.has(normalizeAccelerator('CmdOrCtrl+R'))).toBe(true);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('Cmd+Shift+R'))).toBe(true);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('Cmd+Option+I'))).toBe(true);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('Cmd+M'))).toBe(true);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('Cmd+Q'))).toBe(true);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('Cmd+Option+H'))).toBe(true);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('Cmd+Z'))).toBe(true);
    // And the two the menu deliberately does NOT register, so Monaco can have them.
    expect(REGISTERED_KEYS.has(normalizeAccelerator('CmdOrCtrl+E'))).toBe(false);
    expect(REGISTERED_KEYS.has(normalizeAccelerator('CmdOrCtrl+A'))).toBe(false);
  });
});

describe('the palette side of the catalogue', () => {
  /**
   * The payload rule is a COMPILE-TIME property now, so these are type probes rather than runtime
   * walks.
   *
   * It used to be two runtime assertions against a hand-written union of payload ids, and the claim
   * they made about the compiler was false: `COMMAND_CATALOGUE` was a `Record<CommandId,
   * CommandDisplay>`, so `palette: { show: true }` compiled for `insert-snippet` as readily as for
   * `new-query`. A future payload command marked visible would have rendered `ready` and dispatched
   * `undefined` into a handler that needs data, and the hand-written list would not have known.
   *
   * `catalogue.ts`'s per-key mapped type closes it at the definition site: the `palette` field of a
   * payload-carrying id is `HiddenFromPalette`, full stop. `@ts-expect-error` is the assertion — this
   * file does not compile if the error stops happening, which is a stronger statement than any walk
   * over the same data.
   */
  it('cannot mark a payload-carrying command as palette-visible', () => {
    // @ts-expect-error -- `insert-snippet` carries the SQL to insert, so `show: true` is not a shape
    // its catalogue entry can have. The value is nonsense on purpose; the compiler is the assertion.
    const illegal: CatalogueEntry<'insert-snippet'>['palette'] = { show: true };
    // @ts-expect-error -- and the same for a sidebar-targeted command.
    const alsoIllegal: CatalogueEntry<'backup-database'>['palette'] = { show: true };
    // A payload-free id is unaffected — the probes above are about the conditional, not about `show`.
    const legal: CatalogueEntry<'new-query'>['palette'] = { show: true };
    expect([illegal, alsoIllegal, legal].every(entry => entry.show)).toBe(true);

    // And the catalogue itself really does hide those two, with a reason.
    for (const id of ['insert-snippet', 'backup-database'] as const) {
      const visibility = COMMAND_CATALOGUE[id].palette;
      expect(visibility.show, `${id} is in the palette`).toBe(false);
      expect(visibility.because.length).toBeGreaterThan(20);
    }
  });

  it('derives palette ids that are payload-free by type', () => {
    // No cast: `paletteCommandIds()` is declared `readonly PayloadlessCommandId[]`, which compiles only
    // because the catalogue cannot show a payload command. This is the property `palette-model.ts` used
    // to assert with `id as PayloadlessCommandId`.
    const ids: readonly PayloadlessCommandId[] = paletteCommandIds();
    expect(ids.length).toBeGreaterThan(0);
    // @ts-expect-error -- and the union really is narrower than `CommandId`: an id that needs a payload
    // is not one of them.
    const notPayloadless: PayloadlessCommandId = 'insert-snippet';
    expect(notPayloadless).toBe('insert-snippet');
  });

  it('gives every excluded command a stated reason', () => {
    for (const id of COMMAND_IDS) {
      const visibility = COMMAND_CATALOGUE[id].palette;
      if (visibility.show) continue;
      expect(visibility.because.length, `${id} is hidden for no stated reason`).toBeGreaterThan(20);
    }
  });

  it('lists most of the app: at least twenty commands are reachable by name', () => {
    // A palette that derived down to three entries would satisfy every rule above. The Angular one
    // offered 26 rows including its ten dead ones, so a floor of 20 live entries is the honest bar.
    expect(paletteCommandIds().length).toBeGreaterThanOrEqual(20);
  });
});

describe('the catalogue is complete and says something', () => {
  it('covers every registered command', () => {
    expect(Object.keys(COMMAND_CATALOGUE).sort()).toEqual([...COMMAND_IDS].sort());
  });

  it('gives every command a label, a hint and a known group', () => {
    for (const id of COMMAND_IDS) {
      const display = COMMAND_CATALOGUE[id];
      expect(display.label.length, `${id} label`).toBeGreaterThan(2);
      expect(display.hint.length, `${id} hint`).toBeGreaterThan(10);
      expect(display.hint, `${id} hint repeats its label`).not.toBe(display.label);
      expect(COMMAND_GROUPS, `${id} group`).toContain(display.group);
    }
  });

  it('labels every group', () => {
    for (const group of COMMAND_GROUPS) {
      expect(COMMAND_GROUP_LABELS[group].length).toBeGreaterThan(2);
    }
  });
});

describe('formatAccelerator', () => {
  // jsdom's user agent contains no "Mac", so `IS_MAC` is false in this suite and only the non-Mac
  // branch runs. `IS_MAC` is a module-load constant read from `navigator.userAgent`, so the Mac glyph
  // branch cannot be reached from here without re-importing the module under a faked user agent —
  // which is exactly what `docs-site/scripts/lib/app-source.mjs` does to build the Mac column of the
  // generated keyboard reference.
  it('renders the platform branch of a split accelerator', () => {
    expect(acceleratorKeysForPlatform({ mac: 'Cmd+Shift+Return', other: 'Ctrl+Shift+E' })).toBe(
      'Ctrl+Shift+E'
    );
    expect(acceleratorKeysForPlatform('CmdOrCtrl+K')).toBe('CmdOrCtrl+K');
  });

  it('joins non-Mac keys with plus signs and upper-cases the final key', () => {
    expect(formatAccelerator({ source: 'menu', keys: 'CmdOrCtrl+Shift+n' })).toBe('Ctrl+Shift+N');
  });

  it('resolves the cross-platform Ctrl spellings off macOS', () => {
    // Electron accepts several spellings of the modifier that IS Ctrl off macOS, and a cheat-sheet
    // row that prints the accelerator's spelling instead of the key is a lie (J-114).
    for (const alias of ['CmdOrCtrl', 'CommandOrControl', 'Control', 'Ctrl']) {
      expect(formatAccelerator({ source: 'menu', keys: `${alias}+k` }), alias).toBe('Ctrl+K');
    }
    // Modifiers that are not that one keep their own names.
    expect(formatAccelerator({ source: 'menu', keys: 'Alt+Shift+k' })).toBe('Alt+Shift+K');
  });

  it('leaves the macOS-only Cmd spellings alone off macOS', () => {
    // Bare `Cmd`/`Command` are macOS-only: off macOS Electron does not register them at all, so
    // printing `Ctrl` for one would advertise a key that does nothing. They stay unmapped on
    // purpose, and the odd-looking output is the point — it is how a binding that forgot its
    // `{ mac, other }` split gets noticed instead of silently reading as a working Windows key.
    expect(formatAccelerator({ source: 'menu', keys: 'Cmd+k' })).toBe('Cmd+K');
    expect(formatAccelerator({ source: 'menu', keys: 'Command+k' })).toBe('Command+K');
  });

  it('returns null when there is no binding', () => {
    expect(formatAccelerator(null)).toBeNull();
    expect(commandAccelerator('show-database-properties')).toBeNull();
  });

  it('formats every declared accelerator without dropping one', () => {
    for (const id of COMMAND_IDS) {
      const hasKeys = COMMAND_CATALOGUE[id].accelerator !== null;
      expect(commandAccelerator(id) !== null, `${id}`).toBe(hasKeys);
    }
  });
});
