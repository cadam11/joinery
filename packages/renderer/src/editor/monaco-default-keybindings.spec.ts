/**
 * Every keystroke this app advertises, checked against the keybindings **Monaco actually registers**.
 *
 * ── The bug this exists because of (J-73) ──────────────────────────────────────────────────────
 *
 * The command palette advertises ⌘K and owns it as a `document` keydown (`command-palette.tsx`).
 * Monaco registers ⌘K as the first chord of thirty-one two-chord bindings (fold, unfold, comment,
 * format selection, peek…). When the caret is in a SQL editor — the most common state the app is in
 * — Monaco's standalone keybinding service resolves ⌘K to `MoreChordsNeeded`
 * (`keybindingResolver.js:271-277`), `_doDispatch` sets `shouldPreventDefault`
 * (`abstractKeybindingService.js:206-212`), and the listener on the editor's container calls BOTH
 * `preventDefault()` and `stopPropagation()` (`standaloneServices.js:260-269`). The keydown never
 * reaches `document`, so the palette's listener never runs and the shortcut the palette tells users
 * to press does nothing.
 *
 * Nothing could have caught that: the palette's own unit tests dispatch on `document` directly, and
 * the collision guard in `commands/catalogue.spec.ts` compares the app's keys against the **Electron
 * menu** only. Monaco was a third claimant nobody was checking.
 *
 * ── Why this reads the real registry instead of a table ────────────────────────────────────────
 *
 * A hand-written list of "keys Monaco binds" is the failure mode this repo has been bitten by three
 * times: a double that encodes the bug under test. So this spec imports `editor.main.js` — the same
 * entry point `editor/monaco.ts` loads in the app — and reads
 * `KeybindingsRegistry.getDefaultKeybindings()`, then resolves each entry through Monaco's own
 * `USLayoutResolvedKeybinding` to the dispatch strings the resolver keys its map on. Both sides of
 * every comparison below are therefore produced by Monaco's code, not by this file's opinion of it.
 *
 * It is also what validates the *other* spec: `sql-editor.spec.tsx` seeds its double with a handful
 * of Monaco defaults, and the facts it seeds (⌘K is a chord prefix, ⇧⌘K and ⌘D are not) are asserted
 * here against the real thing.
 *
 * **Platform.** Monaco reduces `mac`/`win`/`linux` keybinding branches to one set at import time,
 * against `OS` — which in vitest comes from `process.platform`, because `platform.js` takes its
 * native branch whenever `process.versions.node` exists (`platform.js:26-53`). So the platform is
 * PINNED to macOS here rather than inherited: Joinery's primary target, deterministic on a Linux CI
 * runner, and the alternative — three loads for the three platforms — was measured at three times the
 * runtime for a set of collisions that turned out to be identical on all three (J-73's report
 * carries the full cross-platform table).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import SQL_EDITOR_SOURCE from './sql-editor.tsx?raw';
import {
  COMMAND_CATALOGUE,
  type AcceleratorKeys,
  type AcceleratorSource,
} from '../commands/catalogue';
import { COMMAND_IDS } from '../commands/registry';
import { SURFACE_SHORTCUTS } from '../features/command-palette/palette-actions';

/** `OperatingSystem.Macintosh`, the value `platform.js` exports as `OS` on a Mac. */
const MACINTOSH = 2;

// ── Reading the real registry ────────────────────────────────────────────────────────────────

interface MonacoDefaults {
  /** `OS` as Monaco computed it — asserted to be macOS, since the pin is the whole point. */
  readonly os: number;
  /**
   * First dispatch chord → the commands whose default keybinding STARTS with it, `[chord]`-tagged
   * when the binding needs a second keystroke. Keyed on the first chord and not on the whole
   * binding because that is what decides whether a keydown is consumed: the resolver looks up
   * `pressedChords[0]` (`keybindingResolver.js:236`) and a rule needing more chords still eats the
   * event.
   */
  readonly claims: ReadonlyMap<string, readonly string[]>;
  /** One `KeyMod | KeyCode` number as the dispatch string the resolver would key it on. */
  dispatchFor(keybinding: number): string | null;
  /** Monaco's own `KeyMod` values, so no modifier bit is spelled twice in this repo. */
  readonly keyMod: Readonly<Record<'CtrlCmd' | 'Shift' | 'Alt' | 'WinCtrl', number>>;
  /** A key label (`'K'`, `'/'`, `'Enter'`) as Monaco's `KeyCode`, or 0 for an unknown label. */
  keyCodeFor(label: string): number;
}

let monaco: MonacoDefaults;

/**
 * Vitest's own `process`, reached through `globalThis` and typed locally.
 *
 * This package compiles without `@types/node` on purpose — the bundle runs with
 * `nodeIntegration: false` and there is no `process` in it — so a bare `process.platform` would not
 * typecheck. It exists in the test worker, which is the only place this spec runs, and it is what
 * Monaco reads to decide which platform's keybindings to register (`platform.js:26-53`).
 */
const nodeProcess = (globalThis as unknown as { process: { platform: string } }).process;
const realNodePlatform = nodeProcess.platform;

async function loadMonacoFor(nodePlatform: string): Promise<MonacoDefaults> {
  Object.defineProperty(nodeProcess, 'platform', { value: nodePlatform, configurable: true });
  vi.resetModules();

  // Two jsdom gaps, both stepped around rather than papered over:
  //
  //  - `document.queryCommandSupported` does not exist in jsdom, and `clipboard.js:20-25` calls it
  //    at module scope. `true` is what Chromium answers, so it is what keeps the cut/copy/paste
  //    keybindings in the set this spec is auditing — `false` would silently drop three of them.
  //  - jsdom cannot parse Monaco's CSS (nesting), and every failure is reported on the jsdom
  //    virtual console as a `jsdomError` with a full stack. Importing Monaco produces ~1,900 lines
  //    of it, which would drown the whole test run. The listeners are lifted for the duration of
  //    the import and put back afterwards, so a later error in this file still surfaces.
  (
    document as unknown as { queryCommandSupported: (command: string) => boolean }
  ).queryCommandSupported = () => true;
  const virtualConsole = (
    globalThis as unknown as {
      jsdom?: {
        virtualConsole?: {
          listeners(event: string): ((...args: unknown[]) => void)[];
          removeAllListeners(event: string): void;
          on(event: string, listener: (...args: unknown[]) => void): void;
        };
      };
    }
  ).jsdom?.virtualConsole;
  const cssErrorListeners = virtualConsole?.listeners('jsdomError') ?? [];
  virtualConsole?.removeAllListeners('jsdomError');
  try {
    await import('monaco-editor/editor/editor.main.js');
  } finally {
    for (const listener of cssErrorListeners) virtualConsole?.on('jsdomError', listener);
  }

  const { KeybindingsRegistry } =
    await import('monaco-editor/platform/keybinding/common/keybindingsRegistry.js');
  const { USLayoutResolvedKeybinding } =
    await import('monaco-editor/platform/keybinding/common/usLayoutResolvedKeybinding.js');
  const { decodeKeybinding } = await import('monaco-editor/base/common/keybindings.js');
  const { KeyCodeUtils } = await import('monaco-editor/base/common/keyCodes.js');
  const { KeyMod } = await import('monaco-editor/editor/editor.api.js');
  const platform = await import('monaco-editor/base/common/platform.js');

  const claims = new Map<string, string[]>();
  for (const item of KeybindingsRegistry.getDefaultKeybindings()) {
    // A rule with no keybinding is a removal entry, not a claim on a keystroke
    // (`standaloneServices.js:365-370`).
    if (!item.keybinding) continue;
    for (const resolved of USLayoutResolvedKeybinding.resolveKeybinding(
      item.keybinding,
      platform.OS
    )) {
      const chords = resolved.getDispatchChords();
      const [first] = chords;
      if (first === null || first === undefined) continue;
      const tag = chords.length > 1 ? `${item.command}[chord]` : item.command;
      claims.set(first, [...(claims.get(first) ?? []), tag ?? '(unnamed)']);
    }
  }

  return {
    os: platform.OS,
    claims,
    dispatchFor(keybinding: number): string | null {
      const decoded = decodeKeybinding(keybinding, platform.OS);
      if (decoded === null) return null;
      const [resolved] = USLayoutResolvedKeybinding.resolveKeybinding(decoded, platform.OS);
      return resolved?.getDispatchChords()[0] ?? null;
    },
    keyMod: {
      CtrlCmd: KeyMod.CtrlCmd,
      Shift: KeyMod.Shift,
      Alt: KeyMod.Alt,
      WinCtrl: KeyMod.WinCtrl,
    },
    keyCodeFor: (label: string) => KeyCodeUtils.fromString(label),
  };
}

beforeAll(async () => {
  monaco = await loadMonacoFor('darwin');
}, 120_000);

afterAll(() => {
  Object.defineProperty(nodeProcess, 'platform', { value: realNodePlatform, configurable: true });
});

// ── Electron accelerator → Monaco keybinding ─────────────────────────────────────────────────

/**
 * Electron's key spellings that differ from the labels in Monaco's own `uiMap`
 * (`keyCodes.js:38-140`). Only these three, and each is checked below rather than assumed: an
 * accelerator this table cannot translate FAILS the audit instead of being skipped, which is what
 * stops a new shortcut from quietly leaving the guard's coverage.
 */
const KEY_LABEL_ALIASES: Record<string, string> = {
  Return: 'Enter',
  Break: 'PauseBreak',
  Esc: 'Escape',
};

/**
 * One Electron accelerator as the number Monaco's own API takes, or the reason it could not be.
 *
 * The modifier mapping is the one place the two vocabularies genuinely differ, so it is spelled out:
 * Electron's `CmdOrCtrl` is ⌘ on macOS and Ctrl elsewhere, which is exactly `KeyMod.CtrlCmd`; but
 * Electron's `Ctrl` is the PHYSICAL control key on every platform, which is `KeyMod.WinCtrl` on
 * macOS and `KeyMod.CtrlCmd` off it. Getting that backwards is how ⌃M would have been compared
 * against ⌘M.
 */
function keybindingFor(accelerator: string): number | string {
  const parts = accelerator.split('+');
  const label = parts.pop() ?? '';
  let modifiers = 0;
  for (const part of parts) {
    if (
      part === 'CmdOrCtrl' ||
      part === 'CommandOrControl' ||
      part === 'Cmd' ||
      part === 'Command'
    ) {
      modifiers |= monaco.keyMod.CtrlCmd;
    } else if (part === 'Ctrl' || part === 'Control') {
      modifiers |= monaco.os === MACINTOSH ? monaco.keyMod.WinCtrl : monaco.keyMod.CtrlCmd;
    } else if (part === 'Alt' || part === 'Option') {
      modifiers |= monaco.keyMod.Alt;
    } else if (part === 'Shift') {
      modifiers |= monaco.keyMod.Shift;
    } else {
      return `unknown modifier "${part}"`;
    }
  }
  const keyCode = monaco.keyCodeFor(KEY_LABEL_ALIASES[label] ?? label);
  if (keyCode === 0) return `unknown key "${label}"`;
  return modifiers | keyCode;
}

/** The branch of a split accelerator that applies on the platform Monaco loaded for. */
function forPlatform(keys: AcceleratorKeys): string {
  if (typeof keys === 'string') return keys;
  return monaco.os === MACINTOSH ? keys.mac : keys.other;
}

interface Advertised {
  /** The command id, or `surface: <label>` for a shortcut that is not a command. */
  readonly owner: string;
  readonly source: AcceleratorSource;
  readonly accelerator: string;
}

/**
 * Every keystroke the app tells a user about: each catalogue accelerator and its alternates, plus
 * the two surface shortcuts that are not commands. The same union `commands/catalogue.spec.ts`
 * checks against the menu — audited here against the other claimant.
 */
function advertisedShortcuts(): Advertised[] {
  const rows: Advertised[] = [];
  for (const id of COMMAND_IDS) {
    const accelerator = COMMAND_CATALOGUE[id].accelerator;
    if (accelerator === null) continue;
    for (const keys of [accelerator.keys, ...(accelerator.alternates ?? [])]) {
      rows.push({ owner: id, source: accelerator.source, accelerator: forPlatform(keys) });
    }
  }
  for (const shortcut of SURFACE_SHORTCUTS) {
    for (const keys of shortcut.keys) {
      rows.push({
        owner: `surface: ${shortcut.label}`,
        source: shortcut.source,
        accelerator: forPlatform(keys),
      });
    }
  }
  return rows;
}

/** What Monaco's defaults do with one advertised keystroke. */
function monacoClaimsOn(accelerator: string): readonly string[] {
  const keybinding = keybindingFor(accelerator);
  if (typeof keybinding === 'string') {
    throw new Error(`[audit] cannot translate "${accelerator}": ${keybinding}`);
  }
  const dispatch = monaco.dispatchFor(keybinding);
  return dispatch === null ? [] : (monaco.claims.get(dispatch) ?? []);
}

// ── What `sql-editor.tsx` takes back from Monaco ─────────────────────────────────────────────

/**
 * The `releaseKey(…)` calls in the component, read out of its source.
 *
 * A source scan rather than a second list, for the reason `catalogue.spec.ts` scans `menu.ts`: the
 * exemption below has to be the component's real behaviour and not this spec's belief about it. The
 * component is the only declaration; if a release is deleted there, the audit stops exempting the
 * key and the collision comes back as a failure.
 */
function releasedKeysFromSource(): number[] {
  // Only the CALLS, not the helper's own declaration: `releaseKey = (keybinding: number)` carries no
  // `monaco.KeyMod` and so cannot match.
  const CALL = /releaseKey\(\s*monaco\.KeyMod\.(\w+) \| monaco\.KeyCode\.(\w+)\s*\)/g;
  const found: number[] = [];
  for (const match of SQL_EDITOR_SOURCE.matchAll(CALL)) {
    const [, modifier, key] = match;
    const bit = monaco.keyMod[(modifier ?? '') as keyof MonacoDefaults['keyMod']];
    if (bit === undefined) throw new Error(`[audit] unknown KeyMod member "${modifier}"`);
    // `KeyCode.KeyK` → the `'K'` label `uiMap` is keyed on. Every member the component could name
    // for a released key is a printable one, and an unknown label throws rather than resolving to 0.
    const label = (key ?? '').replace(/^Key/, '');
    const keyCode = monaco.keyCodeFor(label);
    if (keyCode === 0) throw new Error(`[audit] unknown KeyCode member "${key}"`);
    found.push(bit | keyCode);
  }
  return found;
}

/** The dispatch chords the component releases, as the audit's exemption set. */
function releasedDispatchChords(): Set<string> {
  const chords = new Set<string>();
  for (const keybinding of releasedKeysFromSource()) {
    const dispatch = monaco.dispatchFor(keybinding);
    if (dispatch !== null) chords.add(dispatch);
  }
  return chords;
}

// ── The audit ────────────────────────────────────────────────────────────────────────────────

describe('the scan read the real Monaco registry', () => {
  it('loaded the macOS binding set, as pinned', () => {
    expect(monaco.os).toBe(MACINTOSH);
  });

  it('found a registry of a plausible size, so nothing below is vacuous', () => {
    // 200 distinct first chords over ~380 default bindings when this was written. The bound is a
    // floor, not a snapshot: a Monaco upgrade may add bindings, but a scan that silently found
    // nothing — the failure mode of every source-reading test — cannot pass this.
    expect(monaco.claims.size).toBeGreaterThan(100);
    expect(monaco.claims.get('meta+F')).toContain('actions.find');
    expect(monaco.claims.get('meta+D')).toContain('editor.action.addSelectionToNextFindMatch');
  });

  it('translates every advertised accelerator, so none is silently skipped', () => {
    const untranslatable = advertisedShortcuts()
      .map(row => ({ row, keybinding: keybindingFor(row.accelerator) }))
      .filter(entry => typeof entry.keybinding === 'string')
      .map(entry => `${entry.row.owner} (${entry.row.accelerator}): ${String(entry.keybinding)}`);

    expect(untranslatable).toEqual([]);
  });
});

describe('⌘K is a chord prefix in Monaco, which is the whole of J-73', () => {
  it('is claimed, and every claim on it needs a second keystroke', () => {
    const claims = monacoClaimsOn('CmdOrCtrl+K');

    // The count is a floor for the same reason as above; what matters is that this is not empty,
    // because a release of a key Monaco never bound would be dead code.
    expect(claims.length).toBeGreaterThan(20);
    expect(claims.filter(command => !command.endsWith('[chord]'))).toEqual([]);
    expect(claims).toContain('editor.action.addCommentLine[chord]');
  });

  it('does not claim the neighbouring keystrokes the release must not touch', () => {
    // ⇧⌘K (delete line) and ⌃K (delete all right, macOS) are DIFFERENT dispatch chords, so a
    // release of ⌘K leaves them alone. These two assertions are what make the neighbour cases in
    // `sql-editor.spec.tsx` — the ones that prove the release is not over-broad — mean something:
    // they seed exactly these bindings into the double.
    expect(monacoClaimsOn('CmdOrCtrl+Shift+K')).toEqual(['editor.action.deleteLines']);
    expect(monacoClaimsOn('Ctrl+K')).toEqual(['deleteAllRight']);
  });
});

describe('the release declared in sql-editor.tsx', () => {
  it('releases ⌘K and nothing else', () => {
    expect(releasedKeysFromSource()).toEqual([keybindingFor('CmdOrCtrl+K')]);
  });

  it('releases a keystroke Monaco really binds', () => {
    // A release rule Monaco has nothing to be released from is a line of code with no effect, and
    // the only way to tell is to ask the registry.
    for (const chord of releasedDispatchChords()) {
      expect(monaco.claims.get(chord)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('no shortcut the app owns is swallowed by Monaco', () => {
  it('leaves every renderer-owned keystroke reachable from inside the editor', () => {
    // The J-73 assertion, generalised. A `renderer`-source accelerator is a `document` keydown, and
    // Monaco's listener sits between the editor and `document` with `stopPropagation()` in hand —
    // so any renderer-owned key that Monaco also claims is dead while the caret is in a SQL editor,
    // which is where a SQL app's users spend their time.
    const exempt = releasedDispatchChords();
    const swallowed = advertisedShortcuts()
      .filter(row => row.source === 'renderer')
      .filter(row => {
        const keybinding = keybindingFor(row.accelerator);
        if (typeof keybinding === 'string') return false;
        const dispatch = monaco.dispatchFor(keybinding);
        return (
          dispatch !== null && !exempt.has(dispatch) && monacoClaimsOn(row.accelerator).length > 0
        );
      })
      .map(row => `${row.owner} (${row.accelerator})`);

    expect(swallowed).toEqual([]);
  });

  it('has a renderer-owned set worth checking', () => {
    // ⌘J, ⌘P, ⌥⌘S and the palette's two openers. Asserted so that this file cannot go green by
    // finding no renderer-owned shortcuts at all.
    const owned = advertisedShortcuts().filter(row => row.source === 'renderer');
    expect(owned.map(row => row.accelerator).sort()).toEqual([
      'Cmd+Option+S',
      'CmdOrCtrl+J',
      'CmdOrCtrl+K',
      'CmdOrCtrl+P',
      'CmdOrCtrl+Shift+P',
    ]);
  });
});

/**
 * The other direction: keystrokes where the APP wins and a Monaco default loses.
 *
 * These are not bugs — they are decisions, and every one of them is either the app deliberately
 * taking the key or the menu routing it straight back to the same Monaco action. They are pinned as
 * a table because the failure they guard against is silent in both directions: adding a menu
 * accelerator kills a Monaco editor binding with no error anywhere, and Monaco adding a default on
 * an existing app key changes what the editor does with no warning either.
 */
const SHADOWED_MONACO_DEFAULTS: Record<string, { keys: string; commands: string[]; why: string }> =
  {
    'editor-find': {
      keys: 'CmdOrCtrl+F',
      commands: ['actions.find'],
      why: 'Edit ▸ Find routes menu:find back to the editor’s own find action, so the key does what Monaco would have done',
    },
    'editor-replace': {
      keys: 'Cmd+Option+F',
      commands: ['editor.action.startFindReplaceAction'],
      why: 'Edit ▸ Find and Replace routes menu:replace back to the same widget',
    },
    'toggle-comment': {
      keys: 'CmdOrCtrl+/',
      commands: ['editor.action.commentLine', 'toggleExplainMode'],
      why: 'Edit ▸ Toggle Comment routes menu:toggle-comment back to commentLine; toggleExplainMode is a VS Code accessibility command with no standalone surface',
    },
    'execute-selection': {
      keys: 'Cmd+Shift+Return',
      commands: ['editor.action.insertLineBefore'],
      why: 'Deliberate: running the highlighted SQL is worth more in a query tool than inserting a line above',
    },
    'cancel-query': {
      keys: 'Cmd+.',
      commands: [
        'editor.action.quickFix',
        'editor.changeDropType',
        'editor.changePasteType',
        'acceptSelectedCodeAction',
      ],
      why: 'Deliberate: ⌘. is the app’s cancel, and none of Monaco’s four has a surface in a SQL editor with no code actions',
    },
    'toggle-results-panel': {
      keys: 'CmdOrCtrl+Shift+\\',
      commands: ['editor.action.jumpToBracket'],
      why: 'Deliberate: showing and hiding the grid is a workbench action; bracket-jumping stays available as ⌘⇧\\ is its only binding',
    },
    'menu-copy': {
      keys: 'CmdOrCtrl+C',
      commands: ['editor.action.clipboardCopyAction', 'suggestWidgetCopy'],
      why: 'Edit ▸ Copy is intercepted so the results grid can honour the Copy Format setting, and falls back to document.execCommand for plain selections (menu.ts:150-163)',
    },
    'execute-query': {
      keys: 'CmdOrCtrl+E',
      commands: ['actions.findWithSelection'],
      why: 'The app binds ⌘E as a dynamic Monaco keybinding, which outranks the default (standaloneServices.js:329); Execute is the key’s job in every SQL tool',
    },
  };

describe('which Monaco defaults the app shadows, and why each is deliberate', () => {
  it('matches the declared table exactly', () => {
    const shadowing = new Map<string, string[]>();
    for (const row of advertisedShortcuts()) {
      if (row.source === 'renderer') continue;
      const claims = monacoClaimsOn(row.accelerator);
      if (claims.length > 0) shadowing.set(row.owner, [...claims]);
    }

    expect(Object.fromEntries([...shadowing].sort())).toEqual(
      Object.fromEntries(
        Object.entries(SHADOWED_MONACO_DEFAULTS)
          .map(([owner, entry]) => [owner, entry.commands])
          .sort()
      )
    );
  });

  it('names the keystroke each shadow is about, and gives a reason', () => {
    for (const [owner, entry] of Object.entries(SHADOWED_MONACO_DEFAULTS)) {
      expect(monacoClaimsOn(entry.keys), owner).toEqual(entry.commands);
      expect(entry.why.length, owner).toBeGreaterThan(20);
    }
  });
});
