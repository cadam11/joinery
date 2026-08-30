/**
 * The app's command data, reshaped into the rows the two generated reference pages render.
 *
 * `app-source.mjs` hands back the renderer's own modules, twice — once with a macOS
 * `navigator.userAgent` and once with a Windows one. This file merges those two passes into one
 * row per command and asserts, on every row, that the only thing the platform changed is the
 * keystroke. If a label or a group ever differed by platform, the pages would be quietly telling
 * half the readers something false, so it is checked rather than assumed.
 */

/**
 * Modifiers that cannot appear in a Windows binding. Electron resolves `CmdOrCtrl` to Command on
 * macOS and Control everywhere else (https://www.electronjs.org/docs/latest/api/accelerator), and
 * since J-114 the app's own `formatAccelerator` makes that substitution too on its non-Mac branch
 * (`catalogue.ts:852-863`) — so the `CmdOrCtrl` family reaching this file is already spelled the way
 * a Windows reader presses it, and this file no longer has to rewrite it.
 *
 * What the app deliberately does NOT rewrite is bare `Cmd` / `Command`, because those are macOS-only:
 * Electron never registers them off macOS, so printing `Ctrl` for one would advertise a dead key.
 * That is what makes this set a tripwire rather than a formatter — anything in a Windows keystroke
 * that only exists on a Mac keyboard means a catalogue entry gained a macOS accelerator without the
 * `{ mac, other }` split it needs, and the build should stop rather than publish it.
 */
const MAC_ONLY_MODIFIERS = new Set(['Cmd', 'Command', 'Super', 'Meta', 'Option']);

/**
 * The modifiers each platform spells differently for the same physical key. Used to decide whether
 * a `{ mac, other }` accelerator is really a DIFFERENT key or the same one under local names —
 * ⌥⌘S and `Ctrl+Alt+S` are one binding written twice; ⌘. and `Alt+Break` are two bindings.
 */
const EQUIVALENT_MODIFIERS = {
  Cmd: 'Ctrl',
  Command: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  CommandOrControl: 'Ctrl',
  Control: 'Ctrl',
  Option: 'Alt',
};

/** One accelerator spec as a set of parts, with platform-specific modifier names folded together. */
function normalizedParts(spec) {
  return spec
    .split('+')
    .map(part => EQUIVALENT_MODIFIERS[part] ?? part)
    .sort()
    .join('+');
}

/** Whether a spec asks for a different key on the two platforms, rather than a renamed modifier. */
function isDifferentKeyOffMac(keys) {
  if (typeof keys === 'string') return false;
  return normalizedParts(keys.mac) !== normalizedParts(keys.other);
}

/** Every binding of one accelerator — the primary and its alternates — as raw specs. */
function acceleratorSpecs(accelerator) {
  if (accelerator === null) return [];
  return [accelerator.keys, ...(accelerator.alternates ?? [])];
}

/** The catalogue's palette preconditions, in the words a reference table wants. */
const REQUIREMENT_LABELS = {
  connection: 'a live connection',
  'query-tab': 'a query tab in front',
  results: 'results on screen',
};

/** One accelerator as pressed on Windows, from the accelerator as the app prints it there. */
function windowsKeystroke(printed) {
  const parts = printed.split('+');
  const macOnly = parts.find(part => MAC_ONLY_MODIFIERS.has(part));
  if (macOnly !== undefined) {
    throw new Error(
      `The non-macOS binding \`${printed}\` carries the macOS-only modifier \`${macOnly}\`. ` +
        `Either the catalogue gained a platform-specific accelerator that needs a { mac, other } ` +
        `split, or MAC_ONLY_MODIFIERS in docs-site/scripts/lib/command-model.mjs is out of date.`
    );
  }
  return printed;
}

/**
 * The first clause of a catalogue reason — everything up to the em dash that introduces its
 * elaboration. The full sentence is worth reading once; repeated down a table column it crowds out
 * the commands. `palette-model.ts`'s `ownerSummary` shortens the consumer strings the same way.
 */
function firstClause(reason) {
  const [clause] = reason.split(' — ');
  return clause;
}

/** How the palette treats a command, as one phrase. */
function paletteAvailability(palette) {
  if (!palette.show) {
    return { inPalette: false, note: firstClause(palette.because), reason: palette.because };
  }
  if (palette.requires === undefined) return { inPalette: true, note: null };
  const label = REQUIREMENT_LABELS[palette.requires];
  if (label === undefined) {
    throw new Error(
      `The catalogue has a palette requirement this generator does not know: ` +
        `\`${palette.requires}\`. Add it to REQUIREMENT_LABELS in ` +
        `docs-site/scripts/lib/command-model.mjs.`
    );
  }
  return { inPalette: true, note: `needs ${label}` };
}

/** Two catalogue entries for the same id must agree about everything except the keystroke. */
function assertPlatformAgreement(id, macEntry, windowsEntry) {
  for (const field of ['label', 'hint', 'group']) {
    if (macEntry[field] !== windowsEntry[field]) {
      throw new Error(
        `\`${id}\` has a platform-dependent ${field} (${macEntry[field]} / ${windowsEntry[field]}). ` +
          `The reference pages render one row per command and cannot say two things.`
      );
    }
  }
}

/**
 * Every command, in catalogue order, with both platforms' keystrokes on the same row.
 *
 * `keysMac` / `keysWindows` hold EVERY binding that reaches the command, not just the primary one:
 * _New connection_ answers to two menu items, and a reference that showed one of them would be
 * wrong about the other.
 */
export function commandRows({ mac, windows }) {
  const macCatalogue = mac.catalogue.COMMAND_CATALOGUE;
  const windowsCatalogue = windows.catalogue.COMMAND_CATALOGUE;

  return Object.keys(macCatalogue).map(id => {
    const macEntry = macCatalogue[id];
    const windowsEntry = windowsCatalogue[id];
    assertPlatformAgreement(id, macEntry, windowsEntry);

    return {
      id,
      label: macEntry.label,
      hint: macEntry.hint,
      group: macEntry.group,
      source: macEntry.accelerator === null ? null : macEntry.accelerator.source,
      // Not "does the catalogue branch on platform" — six accelerators do, and one of those six
      // (the snippet library's ⌥⌘S / Ctrl+Alt+S) is the same key written in each platform's own
      // modifier names. This is the set a reader has to relearn off macOS.
      differentKeyOffMac: acceleratorSpecs(macEntry.accelerator).some(isDifferentKeyOffMac),
      keysMac: mac.catalogue.formatAcceleratorList(macEntry.accelerator),
      keysWindows: windows.catalogue
        .formatAcceleratorList(windowsEntry.accelerator)
        .map(windowsKeystroke),
      palette: paletteAvailability(macEntry.palette),
    };
  });
}

/**
 * The keystrokes that belong to a surface rather than to a command: the palette's own opener, and
 * the SQL editor's ⌃M tab-focus escape. The cheatsheet lists them alongside the command rows and so
 * does the reference page, through the same formatter, so neither can render its keys by a
 * different rule.
 *
 * `source` comes from the entry rather than being assumed `renderer` — the two entries do not agree
 * on it, and the Bound by column is the one a reader uses to find out why a key that works in the
 * editor does nothing in the grid (J-133).
 *
 * No `palette` field: the palette lists neither of these, the shortcuts page renders no palette
 * column, and the commands page builds its rows from `commandRows` alone. A literal here would be a
 * claim nothing reads and nothing checks.
 */
export function surfaceShortcutRows({ mac, windows }) {
  return mac.paletteActions.SURFACE_SHORTCUTS.map((shortcut, index) => {
    const windowsShortcut = windows.paletteActions.SURFACE_SHORTCUTS[index];
    const format = (module, keys) =>
      keys.flatMap(key =>
        module.catalogue.formatAcceleratorList({ source: shortcut.source, keys: key })
      );

    return {
      id: null,
      label: shortcut.label,
      hint: shortcut.hint,
      group: shortcut.group,
      source: shortcut.source,
      keysMac: format(mac, shortcut.keys),
      keysWindows: format(windows, windowsShortcut.keys).map(windowsKeystroke),
      differentKeyOffMac: shortcut.keys.some(isDifferentKeyOffMac),
    };
  });
}

/** The palette's local actions: entries that are not commands and carry no keystroke. */
export function paletteActionRows({ mac }) {
  return mac.paletteActions.PALETTE_ACTIONS.map(action => ({
    id: action.id,
    label: action.label,
    hint: action.hint,
    group: action.group,
    groupLabel: mac.catalogue.COMMAND_GROUP_LABELS[action.group],
  }));
}

/** `[group, rows]` in the catalogue's own group order, skipping groups with no rows. */
export function byGroup({ mac }, rows) {
  return mac.catalogue.COMMAND_GROUPS.map(group => [
    mac.catalogue.COMMAND_GROUP_LABELS[group],
    rows.filter(row => row.group === group),
  ]).filter(([, groupRows]) => groupRows.length > 0);
}
