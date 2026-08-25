/**
 * `<SqlEditor>`, with Monaco replaced by a recording double.
 *
 * Monaco cannot run in jsdom — it measures fonts, installs a ResizeObserver on a real box and creates web
 * workers — so the real editor is exercised by the browser gate and the e2e tier. What is testable here is
 * everything the wrapper DECIDES: which options it derives from `EditorSettings`, that indentation goes to
 * the model rather than the editor, that the module-global registrations happen exactly once however many
 * editors mount, which keystrokes it binds, what the imperative handle does, and that it disposes
 * everything it created.
 *
 * The double is a hand-written object rather than `vi.mock` with automock, because the assertions are about
 * the exact arguments Monaco is handed and an automock would erase them.
 */

import { createRef } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@joinery/shared';
import { DEFAULT_SETTINGS } from '@joinery/shared';
import { IS_MAC } from '../utils/platform';

// ── The double ─────────────────────────────────────────────────────────────────────────────

/** Monaco's `KeyMod`/`KeyCode` bit values, so a binding assertion reads as the keystroke it is. */
const KEY_MOD = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
/**
 * The id Monaco registers with `registerAction2`. Named here for the same reason the component
 * names it: it is the one id in this file that `getAction` must never resolve.
 */
const TAB_FOCUS_COMMAND_ID = 'editor.action.toggleTabFocusMode';
/** Control-M, spelled the way the component spells it for this platform. */
const TAB_FOCUS_KEY = (IS_MAC ? KEY_MOD.WinCtrl : KEY_MOD.CtrlCmd) | 43;
// Monaco's real values (`monaco-editor/esm/vs/editor/editor.api.d.ts`). `KeyM` was missing until
// J-83, so the component's new binding resolved to `modifier | undefined` and the guard below read
// a bare modifier — an incomplete double reporting a keystroke nobody bound.
const KEY_CODE = { Enter: 3, F5: 65, KeyE: 35, KeyM: 43 };

interface FakeEditor {
  /**
   * Monaco's own per-editor id, and the value of its `editorId` context key. The format is
   * `getEditorType() + ':' + n` — i.e. **`vs.editor.ICodeEditor:1`**, colon included
   * (`codeEditorWidget.js:290-295`, `editorCommon.js:9`; `StandaloneCodeEditor` does not override
   * `getId`). Spelling it any other way here is not a harmless simplification: this double invented
   * `editor-<n>` once, and a component-side assertion that rejected every REAL id shipped green.
   */
  id: string;
  /** Set by `dispose()`. Monaco keeps the object alive and inert; so does this. */
  disposed: boolean;
  getId: ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  getPosition: ReturnType<typeof vi.fn>;
  executeEdits: ReturnType<typeof vi.fn>;
  pushUndoStop: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  layout: ReturnType<typeof vi.fn>;
  updateOptions: ReturnType<typeof vi.fn>;
  getAction: ReturnType<typeof vi.fn>;
  trigger: ReturnType<typeof vi.fn>;
  getOption: ReturnType<typeof vi.fn>;
  addCommand: ReturnType<typeof vi.fn>;
  onDidChangeModelContent: ReturnType<typeof vi.fn>;
  onDidChangeCursorPosition: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/**
 * One entry of the standalone keybinding service's dynamic rule list
 * (`standaloneServices.js:321-347`). The list is PROCESS-GLOBAL: every editor on the page adds to
 * the same one, which is the whole subject of J-132.
 */
interface KeybindingRule {
  keybinding: number;
  command: string;
  when: string | null;
}

const state = {
  created: [] as { element: HTMLElement; options: Record<string, unknown> }[],
  editors: [] as FakeEditor[],
  model: {
    updateOptions: vi.fn(),
    getValue: vi.fn(() => 'select 1'),
    getValueInRange: vi.fn(() => 'select'),
    getFullModelRange: vi.fn(() => ({ startLineNumber: 1, endLineNumber: 2 })),
    getLineCount: vi.fn(() => 2),
  },
  /** Every `dispose()` any subscription handed back. */
  disposedSubscriptions: 0,
  contentListeners: [] as (() => void)[],
  cursorListeners: [] as ((event: { position: { lineNumber: number; column: number } }) => void)[],
  /** Monaco's `CommandsRegistry` — command ids are global to the page, not to an editor. */
  commandRegistry: new Map<string, () => void>(),
  /** The global dynamic keybinding list, in registration order. */
  rules: [] as KeybindingRule[],
  /**
   * Monaco numbers editors from a module-global `++EDITOR_ID` (`codeEditorWidget.js:194`); so does
   * the double, so ids are unique per mount here as they are there.
   */
  nextEditorId: 1,
  /** Monaco's `LAST_GENERATED_COMMAND_ID`, for the ids `addCommand` invents. */
  nextDynamicCommandId: 1,
  action: { run: vi.fn(async () => undefined) },
  actionExists: true,
  /** Every id handed to `trigger`, in order. */
  triggered: [] as string[],
  /** The mode `getOption(EditorOption.tabFocusMode)` reports. Flipped by the real command. */
  tabFocusMode: false,
  /**
   * Whether this Monaco build carries `editor.action.toggleTabFocusMode` at all. `false` makes
   * `trigger` a no-op, which is exactly how the real API fails for an unknown id — silently.
   */
  tabFocusCommandExists: true,
};

/**
 * `CommandsRegistry.registerCommand` (`standaloneEditor.js:98-103`) — a global id → handler entry,
 * removed by the disposable it hands back.
 */
function registerCommand(id: string, run: () => void): { dispose: () => void } {
  state.commandRegistry.set(id, run);
  return {
    dispose: () => {
      state.commandRegistry.delete(id);
    },
  };
}

/**
 * `StandaloneKeybindingService.addDynamicKeybindings` (`standaloneServices.js:321-347`) — appends to
 * the global rule list and hands back the disposable that removes exactly those entries. Copies each
 * rule for the same reason Monaco does: removal is by identity of the stored entry.
 */
function addRules(rules: KeybindingRule[]): { dispose: () => void } {
  const entries = rules.map(rule => ({ ...rule }));
  state.rules.push(...entries);
  return {
    dispose: () => {
      state.rules = state.rules.filter(entry => !entries.includes(entry));
    },
  };
}

/** The only when-clause shape this double understands: Monaco's own per-editor scope. */
const EDITOR_ID_WHEN = /^editorId == '([\w.:-]+)'$/;

function whenMatches(when: string | null, focused: FakeEditor): boolean {
  // No when-clause means the rule matches EVERY context this service can be dispatched in — which
  // is not a simplification of the double: it is what `addCommand` registers, and it is why one
  // editor's rule can answer a keystroke typed in another.
  if (when === null) return true;
  const scoped = EDITOR_ID_WHEN.exec(when);
  if (scoped === null) throw new Error(`[double] unsupported when clause: ${when}`);
  return focused.id === scoped[1];
}

/**
 * One keystroke typed INSIDE an editor, resolved the way Monaco resolves it: against the GLOBAL rule
 * list, newest rule first, skipping any rule whose when-clause does not match the context of the
 * editor that has focus (`keybindingResolver.js:281-290` — `_findCommand` walks backwards and
 * returns the first match).
 *
 * The focused editor is required rather than optional because the standalone keybinding service
 * listens for keydown on each editor's own container element and nowhere else
 * (`standaloneServices.js:259-268`, per editor at `:293`), so there is no such thing as a dispatch from outside every
 * editor. A rule can therefore only ever be resolved against SOME editor's context — the question
 * this file is about is whether it is the right one.
 *
 * Returns whether a rule claimed the keystroke, because "nothing happened" and "the wrong editor
 * happened" are different failures and the tests distinguish them.
 */
function press(keybinding: number, focused: FakeEditor): boolean {
  for (let i = state.rules.length - 1; i >= 0; i--) {
    const rule = state.rules[i] as KeybindingRule;
    if (rule.keybinding !== keybinding) continue;
    if (!whenMatches(rule.when, focused)) continue;
    const handler = state.commandRegistry.get(rule.command);
    if (handler === undefined) {
      throw new Error(`[double] rule for "${rule.command}", but no such command is registered`);
    }
    handler();
    return true;
  }
  return false;
}

function makeEditor(): FakeEditor {
  const subscription = {
    dispose: () => {
      state.disposedSubscriptions += 1;
    },
  };
  const id = `vs.editor.ICodeEditor:${state.nextEditorId++}`;
  const editor: FakeEditor = {
    id,
    disposed: false,
    getId: vi.fn(() => id),
    getValue: vi.fn(() => 'select 1'),
    getModel: vi.fn(() => state.model),
    // `isEmpty` is Monaco's own zero-WIDTH check and it is what `hasSelection` reads, so the double
    // carries it: a fake selection object without it would make the handle answer `true` for a caret.
    getSelection: vi.fn(() => ({ startLineNumber: 1, isEmpty: () => false })),
    getPosition: vi.fn(() => ({ lineNumber: 2, column: 4 })),
    executeEdits: vi.fn(),
    pushUndoStop: vi.fn(),
    focus: vi.fn(),
    layout: vi.fn(),
    updateOptions: vi.fn(),
    // Null for `editor.action.toggleTabFocusMode`, ALWAYS, and not because a test asked for it.
    // Monaco 0.56 registers that one with `registerAction2` — as a command, not an editor action —
    // so the real `getAction` cannot resolve it under any conditions. A double that handed back a
    // working action for every id is precisely what let the first attempt at this fix go green
    // while ⌃M did nothing in the app; `state.actionExists` must not be able to bring it back.
    getAction: vi.fn((actionId: string) => {
      if (actionId === TAB_FOCUS_COMMAND_ID) return null;
      return state.actionExists ? state.action : null;
    }),
    // Monaco 0.56 registers `toggleTabFocusMode` with `registerAction2`, so it is reachable ONLY
    // through `trigger`'s command path and `getAction` returns null for it. The double mirrors
    // that: `trigger` is what moves the mode, and it moves nothing for an id the build lacks.
    trigger: vi.fn((_source: string | null | undefined, handlerId: string) => {
      state.triggered.push(handlerId);
      // A DISPOSED editor takes the call and does nothing with it: `trigger` returns at
      // `if (!this._modelData) return;` (`codeEditorWidget.js:821`) before it ever reaches the
      // command path. Silent, like every other way this API fails — which is what makes a rule that
      // outlives its editor able to swallow a keystroke and report a healthy build as broken.
      if (editor.disposed) return;
      if (handlerId === 'editor.action.toggleTabFocusMode' && state.tabFocusCommandExists) {
        state.tabFocusMode = !state.tabFocusMode;
      }
    }),
    getOption: vi.fn((option: number) => {
      if (option !== monacoDouble.editor.EditorOption.tabFocusMode) {
        throw new Error(`[double] unexpected getOption(${option})`);
      }
      return state.tabFocusMode;
    }),
    // `StandaloneCodeEditor.addCommand` (`standaloneCodeEditor.js:85-94`) verbatim in behaviour: it
    // registers a generated command id AND an UNSCOPED dynamic keybinding rule against the global
    // service, then returns the id and DROPS the disposable that would remove them. Modelled rather
    // than stubbed because that dropped disposable — and the missing when-clause — are the two
    // halves of the defect J-132 is about; a double that recorded the handler in a per-test map
    // could not express either.
    addCommand: vi.fn((keybinding: number, handler: () => void) => {
      const commandId = `DYNAMIC_${state.nextDynamicCommandId++}`;
      registerCommand(commandId, handler);
      addRules([{ keybinding, command: commandId, when: null }]);
      return commandId;
    }),
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      state.contentListeners.push(listener);
      return subscription;
    }),
    onDidChangeCursorPosition: vi.fn(
      (listener: (event: { position: { lineNumber: number; column: number } }) => void) => {
        state.cursorListeners.push(listener);
        return subscription;
      }
    ),
    dispose: vi.fn(() => {
      editor.disposed = true;
    }),
  };
  state.editors.push(editor);
  return editor;
}

const monacoDouble = {
  editor: {
    create: vi.fn((element: HTMLElement, options: Record<string, unknown>) => {
      state.created.push({ element, options });
      return makeEditor();
    }),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelLanguage: vi.fn(),
    // The two module-level registrations, both of which return an `IDisposable` — unlike the
    // editor-level `addCommand` above, which returns a string and keeps the disposable to itself.
    addCommand: vi.fn(({ id, run }: { id: string; run: () => void }) => registerCommand(id, run)),
    addKeybindingRule: vi.fn((rule: KeybindingRule) => addRules([rule])),
    // Monaco's real index for this computed option (`editor.api.d.ts`). The value is opaque to the
    // component — what matters is that it is the one `getOption` is called with.
    EditorOption: { tabFocusMode: 164 },
  },
  languages: { marker: 'the languages namespace' },
  KeyMod: KEY_MOD,
  KeyCode: KEY_CODE,
};

const intellisenseDouble = {
  registerCompletionProvider: vi.fn(() => ({ dispose: vi.fn() })),
  registerGhostTextProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

vi.mock('./monaco', () => ({ monaco: monacoDouble }));
vi.mock('./intellisense', () => ({ sqlIntellisense: intellisenseDouble }));

// Imported after the mocks are declared. `vi.mock` is hoisted, so this is the mocked module.
const { SqlEditor } = await import('./sql-editor');
const { EDITOR_THEMES } = await import('./monaco-themes');
type SqlEditorHandle = import('./sql-editor').SqlEditorHandle;

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

function mount(
  overrides: {
    editorSettings?: AppSettings['editor'];
    theme?: 'dark' | 'light';
    language?: 'sql' | 'pgsql' | 'mysql';
    defaultValue?: string;
    onChange?: (value: string) => void;
    onCursorPositionChange?: (position: { line: number; column: number }) => void;
    onExecute?: () => void;
    onExecuteShortcut?: () => void;
  } = {}
) {
  const handleRef = createRef<SqlEditorHandle>();
  const view = render(
    <SqlEditor
      handleRef={handleRef}
      data-testid="query-editor"
      defaultValue={overrides.defaultValue ?? 'select 1'}
      language={overrides.language ?? 'sql'}
      editorSettings={overrides.editorSettings ?? DEFAULT_SETTINGS.editor}
      theme={overrides.theme ?? 'dark'}
      onChange={overrides.onChange ?? (() => undefined)}
      onCursorPositionChange={overrides.onCursorPositionChange ?? (() => undefined)}
      onExecuteShortcut={overrides.onExecuteShortcut ?? (() => undefined)}
      onExecute={overrides.onExecute ?? (() => undefined)}
    />
  );
  return { view, handle: () => handleRef.current as SqlEditorHandle, handleRef };
}

const lastCreate = () => state.created[state.created.length - 1];
const lastEditor = () => state.editors[state.editors.length - 1] as FakeEditor;

beforeEach(() => {
  state.created = [];
  state.editors = [];
  state.contentListeners = [];
  state.cursorListeners = [];
  state.commandRegistry = new Map();
  state.rules = [];
  state.disposedSubscriptions = 0;
  state.actionExists = true;
  state.triggered = [];
  state.tabFocusMode = false;
  state.tabFocusCommandExists = true;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── The tests ──────────────────────────────────────────────────────────────────────────────

describe('creation', () => {
  it('mounts the editor into its own host element', () => {
    const { view } = mount();
    const host = view.getByTestId('query-editor');
    expect(lastCreate()?.element).toBe(host);
  });

  it('derives the six editor options from EditorSettings', () => {
    mount({
      editorSettings: {
        fontSize: 18,
        tabSize: 8,
        wordWrap: true,
        minimap: false,
        lineNumbers: false,
        autoComplete: false,
      },
    });

    // The Angular editor hardcoded every one of these while the settings object sat unread.
    expect(lastCreate()?.options).toMatchObject({
      fontSize: 18,
      wordWrap: 'on',
      minimap: { enabled: false },
      lineNumbers: 'off',
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
    });
  });

  it('sends indentation to the MODEL, not the editor', () => {
    // `tabSize` and `insertSpaces` are `ITextModelUpdateOptions`; passing them to `create` is a type
    // error, which is how this split was found.
    mount({ editorSettings: { ...DEFAULT_SETTINGS.editor, tabSize: 8 } });
    expect(state.model.updateOptions).toHaveBeenCalledWith({
      tabSize: 8,
      insertSpaces: true,
      // The model-level request that rainbow brackets be off — which the gate showed Monaco ignoring,
      // so the theme is what makes a bracket on-palette (see the comment on `modelOptionsFrom`). It is
      // asserted because it is a key that must reach the MODEL rather than the editor; asserted exactly
      // rather than with `objectContaining`, because "which keys reach the model" is what this is about.
      bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
    });
    expect(lastCreate()?.options).not.toHaveProperty('tabSize');
  });

  it('opens with the brand theme for the resolved app theme, not vs/vs-dark', () => {
    mount({ theme: 'light' });
    expect(lastCreate()?.options.theme).toBe(EDITOR_THEMES.light.name);
    mount({ theme: 'dark' });
    expect(lastCreate()?.options.theme).toBe(EDITOR_THEMES.dark.name);
  });

  it('carries the fixed options the query editor needs', () => {
    mount();
    expect(lastCreate()?.options).toMatchObject({
      automaticLayout: true,
      scrollBeyondLastLine: false,
      occurrencesHighlight: 'singleFile',
      selectionHighlight: true,
      // Monaco's own context menu collides with the app's ContextMenu primitive.
      contextmenu: false,
    });
    expect(lastCreate()?.options.find).toMatchObject({ loop: true, addExtraSpaceOnTop: true });
  });

  it('seeds the document from defaultValue and the language from the engine', () => {
    mount({ defaultValue: '-- hello', language: 'pgsql' });
    expect(lastCreate()?.options).toMatchObject({ value: '-- hello', language: 'pgsql' });
  });
});

describe('the module-global registrations', () => {
  it('defines both themes and registers both providers', () => {
    // Delta-based rather than absolute: the latch is module state, so the first mount in this FILE is the
    // one that registers, whichever test that turns out to be.
    mount();
    const themesDefined = new Set(
      monacoDouble.editor.defineTheme.mock.calls.map(call => call[0] as string)
    );
    // Either this test mounted first (both names present) or an earlier one did (none, because
    // `clearAllMocks` reset the recorder). Both are consistent with "exactly once per page".
    if (themesDefined.size > 0) {
      expect([...themesDefined].sort()).toEqual(['joinery-ink', 'joinery-ivory']);
      expect(intellisenseDouble.registerCompletionProvider).toHaveBeenCalledWith(
        monacoDouble.languages
      );
      expect(intellisenseDouble.registerGhostTextProvider).toHaveBeenCalledTimes(1);
    }
  });

  it('does not register again for a second editor', () => {
    mount();
    const themes = monacoDouble.editor.defineTheme.mock.calls.length;
    const completions = intellisenseDouble.registerCompletionProvider.mock.calls.length;

    mount();

    // Registering per instance is the Angular bug this replaces: four query tabs meant four providers
    // and four copies of every suggestion in the widget.
    expect(monacoDouble.editor.defineTheme.mock.calls.length).toBe(themes);
    expect(intellisenseDouble.registerCompletionProvider.mock.calls.length).toBe(completions);
    expect(state.created).toHaveLength(2);
  });
});

describe('reporting', () => {
  it('reports every content change with the editor’s current value', () => {
    const onChange = vi.fn();
    mount({ onChange });
    lastEditor().getValue.mockReturnValue('select 2');

    state.contentListeners.forEach(listener => listener());

    expect(onChange).toHaveBeenCalledWith('select 2');
  });

  it('reports the caret on mount, so the status bar is populated before the first keystroke', () => {
    const onCursorPositionChange = vi.fn();
    mount({ onCursorPositionChange });
    expect(onCursorPositionChange).toHaveBeenCalledWith({ line: 2, column: 4 });
  });

  it('reports caret moves', () => {
    const onCursorPositionChange = vi.fn();
    mount({ onCursorPositionChange });
    onCursorPositionChange.mockClear();

    state.cursorListeners.forEach(listener => listener({ position: { lineNumber: 7, column: 3 } }));

    expect(onCursorPositionChange).toHaveBeenCalledWith({ line: 7, column: 3 });
  });

  it('calls the LATEST callback without recreating the editor', () => {
    // The callbacks are read through a ref refreshed in a layout effect. Recreating the editor to pick up
    // a new closure would discard the document and the undo stack.
    const first = vi.fn();
    const second = vi.fn();
    const handleRef = createRef<SqlEditorHandle>();
    const props = {
      handleRef,
      defaultValue: 'select 1',
      language: 'sql' as const,
      editorSettings: DEFAULT_SETTINGS.editor,
      theme: 'dark' as const,
      onCursorPositionChange: () => undefined,
      onExecuteShortcut: () => undefined,
      onExecute: () => undefined,
    };
    const { rerender } = render(<SqlEditor {...props} onChange={first} />);
    rerender(<SqlEditor {...props} onChange={second} />);

    state.contentListeners.forEach(listener => listener());

    expect(state.created).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('keybindings', () => {
  it('binds ⌘E to the gated execute', () => {
    const onExecuteShortcut = vi.fn();
    mount({ onExecuteShortcut });
    expect(press(KEY_MOD.CtrlCmd | KEY_CODE.KeyE, lastEditor())).toBe(true);
    expect(onExecuteShortcut).toHaveBeenCalledOnce();
  });

  it('binds ⌘↩ and F5 to the ungated execute', () => {
    const onExecute = vi.fn();
    mount({ onExecute });

    press(KEY_MOD.CtrlCmd | KEY_CODE.Enter, lastEditor());
    press(KEY_CODE.F5, lastEditor());

    expect(onExecute).toHaveBeenCalledTimes(2);
  });

  it('binds exactly four keystrokes and nothing else', () => {
    // The fourth is J-83's Control-M, `editor.action.toggleTabFocusMode` — the editor's only way
    // out for a keyboard user. Which modifier constant carries Control depends on the platform:
    // `WinCtrl` is Control on macOS and the WINDOWS key on Windows, while `CtrlCmd` is ⌘ on macOS
    // and Control elsewhere. jsdom reports no macOS, so `IS_MAC` is false here and the component
    // binds `CtrlCmd` — the expectation is computed the same way rather than hardcoded, because
    // hardcoding either constant would pass on one platform and lie on the other.
    mount();
    expect(state.rules.map(rule => rule.keybinding).sort((a, b) => a - b)).toEqual(
      [
        KEY_CODE.F5,
        KEY_MOD.CtrlCmd | KEY_CODE.Enter,
        KEY_MOD.CtrlCmd | KEY_CODE.KeyE,
        TAB_FOCUS_KEY,
      ].sort((a, b) => a - b)
    );
  });

  it('the fourth one toggles tab-focus mode, which is the whole point of it', () => {
    // It is a toggle, so pressing it twice must come back.
    mount();

    press(TAB_FOCUS_KEY, lastEditor());
    expect(state.triggered).toEqual([TAB_FOCUS_COMMAND_ID]);
    expect(state.tabFocusMode).toBe(true);

    press(TAB_FOCUS_KEY, lastEditor());
    expect(state.tabFocusMode).toBe(false);
  });

  it('reaches it through trigger, because getAction cannot resolve a command', () => {
    // The regression fence. The first attempt at this fix ran ⌃M through `getAction(...).run()`,
    // which returns null for a `registerAction2` id — so the binding fired on every press and did
    // nothing, and the suite was green because the double resolved every id. This pins the working
    // path from both sides: the command id goes to `trigger`, and `getAction` is never consulted
    // for it — and the double now answers null there no matter what the test asks for.
    mount();
    press(TAB_FOCUS_KEY, lastEditor());

    expect(state.triggered).toEqual([TAB_FOCUS_COMMAND_ID]);
    expect(lastEditor().getAction).not.toHaveBeenCalledWith(TAB_FOCUS_COMMAND_ID);
    expect(state.tabFocusMode).toBe(true);

    // And the double could not have let the old implementation pass: it answers null for this id
    // whatever `state.actionExists` says, exactly as the real `getAction` does.
    const getAction = lastEditor().getAction as unknown as (id: string) => unknown;
    state.actionExists = true;
    expect(getAction(TAB_FOCUS_COMMAND_ID)).toBeNull();
    expect(getAction('actions.find')).not.toBeNull();
  });

  it('says so instead of doing nothing when the command is not in the build', () => {
    // `trigger` returns nothing whether or not the id exists, so the guard the `getAction` path
    // gets for free has to be bought by reading the mode back. Without it a Monaco build missing
    // the contribution would present as "⌃M does nothing" — which is indistinguishable from the
    // keyboard trap this binding exists to remove.
    state.tabFocusCommandExists = false;
    mount();

    expect(() => press(TAB_FOCUS_KEY, lastEditor())).toThrow(/left tab focus mode unchanged/);
  });
});

/**
 * J-132. Every keybinding this component registers goes into ONE process-global list that Monaco
 * never prunes, and `StandaloneCodeEditor.addCommand` — the API the component used to call — both
 * drops the disposable that would remove the rule and registers it with NO when-clause. So the rules
 * of a closed tab keep resolving, and because the resolver walks the list backwards, the newest rule
 * wins whatever has focus: the survivor's own binding never gets a look in.
 *
 * Which half of the fix each case pins, stated because it is easy to get wrong: with the SCOPE in
 * place a stale rule can never match a surviving editor's context, so a test that only presses a key
 * in the survivor stays green with the disposal deleted. Every case below that is named for a closed
 * tab therefore also asserts that nothing of it remains in the global list — the leak is the ticket's
 * actual concern, and structural assertions are the only thing that can see it.
 */
describe('keybinding lifetime', () => {
  const EXECUTE_KEY = KEY_MOD.CtrlCmd | KEY_CODE.KeyE;

  it('takes its rules out of the global list on unmount', () => {
    const { view } = mount();
    expect(state.rules).toHaveLength(4);
    const commandIds = state.rules.map(rule => rule.command);

    view.unmount();

    // Both halves of what a keybinding IS — the rule and the command it names — are the component's
    // to remove, and Monaco removes neither on its own.
    expect(state.rules).toEqual([]);
    for (const id of commandIds) expect(state.commandRegistry.has(id)).toBe(false);
  });

  it('drops a closed tab’s ⌃M rule, and leaves the survivor’s working', () => {
    // The ticket's scenario: two query tabs, close the second, press ⌃M in the first. Before the
    // fix the dead tab's rule was newest and unscoped, so it answered; its `trigger` returned at
    // its null `_modelData`, the mode never moved, and J-83's guard reported a perfectly healthy
    // build as broken — a spurious throw on the one keystroke a trapped keyboard user has left.
    mount();
    const survivorEditor = lastEditor();
    const closed = mount();
    const closedEditor = lastEditor();
    closed.view.unmount();

    // The disposal half. Not implied by the press below: a rule scoped to a dead editor could not
    // have matched the survivor's context anyway, so only looking in the list can see the leak.
    const closedTabRules = state.rules.filter(
      rule => rule.when !== null && rule.when.includes(closedEditor.id)
    );
    expect(closedTabRules).toEqual([]);

    // The scope half, and the symptom the ticket is named for.
    expect(() => press(TAB_FOCUS_KEY, survivorEditor)).not.toThrow();
    expect(state.tabFocusMode).toBe(true);
  });

  it('runs the focused editor’s execute, not the most recently mounted one’s', () => {
    // The live half of the same defect: with two tabs open, an unscoped rule from tab B answers ⌘E
    // pressed in tab A, so the user runs the other tab's SQL. Monaco's own `addAction` scopes every
    // rule it adds with `editorId == '…'` for exactly this reason.
    const first = vi.fn();
    const second = vi.fn();
    mount({ onExecuteShortcut: first });
    const firstEditor = lastEditor();
    mount({ onExecuteShortcut: second });

    expect(press(EXECUTE_KEY, firstEditor)).toBe(true);

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('unregisters a closed tab’s execute commands, and never runs its callbacks', () => {
    // The ⌘E half of the ⌃M case above, and the reason this is worth more than tidiness: a stale
    // rule that still resolves runs a CLOSED tab's callbacks — the gate, the connection, the tab
    // state, all belonging to a panel React has already torn down.
    const onExecuteShortcut = vi.fn();
    mount();
    const survivorEditor = lastEditor();
    const closed = mount({ onExecuteShortcut });
    const closedEditor = lastEditor();
    closed.view.unmount();

    // The disposal half: the command entries go too, not just the rules that name them. Four left,
    // all the survivor's.
    expect([...state.commandRegistry.keys()].filter(id => id.includes(closedEditor.id))).toEqual(
      []
    );
    expect(state.commandRegistry.size).toBe(4);

    // The scope half: whatever the list still held, the closed tab's handler must not run.
    press(EXECUTE_KEY, survivorEditor);
    expect(onExecuteShortcut).not.toHaveBeenCalled();
  });
});

describe('the imperative handle', () => {
  it('reads the value straight off the editor', () => {
    const { handle } = mount();
    lastEditor().getValue.mockReturnValue('select 42');
    expect(handle().getValue()).toBe('select 42');
  });

  it('replaces the document as one UNDOABLE edit, never with setValue', () => {
    // `setValue` resets the undo stack, so a user who formats their SQL could not ⌘Z back to it. This is
    // the reason the handle has `setValue` at all rather than exposing the editor.
    const { handle } = mount();
    handle().setValue('SELECT\n  1');

    expect(lastEditor().executeEdits).toHaveBeenCalledWith('joinery', [
      { range: state.model.getFullModelRange(), text: 'SELECT\n  1' },
    ]);
    expect(lastEditor().pushUndoStop).toHaveBeenCalledOnce();
    expect(lastEditor()).not.toHaveProperty('setValue');
  });

  it('focuses and re-measures on request', () => {
    const { handle } = mount();
    handle().focus();
    handle().layout();
    expect(lastEditor().focus).toHaveBeenCalledOnce();
    expect(lastEditor().layout).toHaveBeenCalledOnce();
  });

  it('resolves what to execute from the selection, the caret and the scope', () => {
    const { handle } = mount();
    state.model.getValue.mockReturnValue('select 1;\nselect 2;');
    lastEditor().getPosition.mockReturnValue({ lineNumber: 2, column: 1 });

    // A live selection wins.
    state.model.getValueInRange.mockReturnValue('select 42');
    expect(handle().textToExecute('all')).toBe('select 42');

    // With none, the scope decides.
    lastEditor().getSelection.mockReturnValue(null);
    expect(handle().textToExecute('all')).toBe('select 1;\nselect 2;');
    expect(handle().textToExecute('currentStatement')).toBe('select 2;');
  });

  /**
   * `hasSelection` exists because Execute Selection cannot be implemented by comparing the selected
   * text with the whole buffer: ⌘A produces a selection whose text IS the buffer, and the comparison
   * reads that as "nothing is selected" and refuses to run. The third case below is that bug.
   */
  it('answers hasSelection from Monaco’s own isEmpty, not from a string comparison', () => {
    const { handle } = mount();
    const editor = lastEditor();

    // A caret: a selection object exists, and it is empty.
    editor.getSelection.mockReturnValue({ startLineNumber: 1, isEmpty: () => true });
    expect(handle().hasSelection()).toBe(false);

    // No selection object at all.
    editor.getSelection.mockReturnValue(null);
    expect(handle().hasSelection()).toBe(false);

    // ⌘A: the selected text equals the whole document, and it is STILL a selection. The old
    // `selection === whole` test refused this one, which is the most obvious way to use the command.
    state.model.getValue.mockReturnValue('select 1');
    state.model.getValueInRange.mockReturnValue('select 1');
    editor.getSelection.mockReturnValue({ startLineNumber: 1, isEmpty: () => false });
    expect(handle().hasSelection()).toBe(true);
    expect(handle().textToExecute('all')).toBe('select 1');
  });

  it('reports no selection before the editor exists', () => {
    const { handle, view } = mount();
    const before = handle();
    view.unmount();
    expect(before.hasSelection()).toBe(false);
  });

  it('appends a snippet after a blank line, or becomes the content when empty', () => {
    const { handle } = mount();
    lastEditor().getValue.mockReturnValue('select 1');
    handle().insertSnippet('select 2');
    expect(lastEditor().executeEdits.mock.calls[0]?.[1][0].text).toBe('select 1\n\nselect 2');

    lastEditor().getValue.mockReturnValue('   ');
    handle().insertSnippet('select 2');
    expect(lastEditor().executeEdits.mock.calls[1]?.[1][0].text).toBe('select 2');
  });

  it('focuses before running one of Monaco’s actions', () => {
    const { handle } = mount();
    handle().runAction('actions.find');
    expect(lastEditor().focus).toHaveBeenCalledOnce();
    expect(lastEditor().getAction).toHaveBeenCalledWith('actions.find');
    expect(state.action.run).toHaveBeenCalledOnce();
  });

  it('throws for an action Monaco does not have, rather than doing nothing', () => {
    // `trigger('keyboard', id)` — the Angular form — fails silently, and "⌘F does nothing" is the result.
    const { handle } = mount();
    state.actionExists = false;
    expect(() => handle().runAction('actions.find')).toThrow(/no action "actions.find"/);
  });

  it('is safe to call before the editor exists and after it is gone', () => {
    const { handle, view } = mount();
    const before = handle();
    view.unmount();
    expect(before.getValue()).toBe('');
    expect(() => before.focus()).not.toThrow();
    expect(() => before.layout()).not.toThrow();
    expect(before.textToExecute('all')).toBe('');
  });
});

describe('live prop changes', () => {
  it('pushes changed settings through updateOptions instead of recreating', () => {
    const handleRef = createRef<SqlEditorHandle>();
    const props = {
      handleRef,
      defaultValue: 'select 1',
      language: 'sql' as const,
      theme: 'dark' as const,
      onChange: () => undefined,
      onCursorPositionChange: () => undefined,
      onExecuteShortcut: () => undefined,
      onExecute: () => undefined,
    };
    const { rerender } = render(<SqlEditor {...props} editorSettings={DEFAULT_SETTINGS.editor} />);
    rerender(
      <SqlEditor
        {...props}
        editorSettings={{ ...DEFAULT_SETTINGS.editor, fontSize: 20, tabSize: 3 }}
      />
    );

    expect(state.created).toHaveLength(1);
    expect(lastEditor().updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ fontSize: 20 })
    );
    expect(state.model.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ tabSize: 3, insertSpaces: true })
    );
  });

  it('retints through setTheme when the app theme changes', () => {
    const handleRef = createRef<SqlEditorHandle>();
    const props = {
      handleRef,
      defaultValue: 'select 1',
      language: 'sql' as const,
      editorSettings: DEFAULT_SETTINGS.editor,
      onChange: () => undefined,
      onCursorPositionChange: () => undefined,
      onExecuteShortcut: () => undefined,
      onExecute: () => undefined,
    };
    const { rerender } = render(<SqlEditor {...props} theme="dark" />);
    monacoDouble.editor.setTheme.mockClear();
    rerender(<SqlEditor {...props} theme="light" />);

    expect(monacoDouble.editor.setTheme).toHaveBeenCalledWith(EDITOR_THEMES.light.name);
    expect(state.created).toHaveLength(1);
  });

  it('retokenizes in place when the engine changes', () => {
    const handleRef = createRef<SqlEditorHandle>();
    const props = {
      handleRef,
      defaultValue: 'select 1',
      editorSettings: DEFAULT_SETTINGS.editor,
      theme: 'dark' as const,
      onChange: () => undefined,
      onCursorPositionChange: () => undefined,
      onExecuteShortcut: () => undefined,
      onExecute: () => undefined,
    };
    const { rerender } = render(<SqlEditor {...props} language="sql" />);
    rerender(<SqlEditor {...props} language="mysql" />);

    // Recreating the model would lose the undo stack and the caret.
    expect(monacoDouble.editor.setModelLanguage).toHaveBeenCalledWith(state.model, 'mysql');
    expect(state.created).toHaveLength(1);
  });
});

describe('teardown', () => {
  it('disposes both subscriptions and the editor', () => {
    const { view } = mount();
    const editor = lastEditor();
    view.unmount();

    expect(state.disposedSubscriptions).toBe(2);
    expect(editor.dispose).toHaveBeenCalledOnce();
  });

  it('creates one editor per mount and disposes each', () => {
    const first = mount();
    const second = mount();
    first.view.unmount();
    second.view.unmount();

    expect(state.editors).toHaveLength(2);
    for (const editor of state.editors) expect(editor.dispose).toHaveBeenCalledOnce();
  });
});
