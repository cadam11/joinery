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
  commands: new Map<number, () => void>(),
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

function makeEditor(): FakeEditor {
  const subscription = {
    dispose: () => {
      state.disposedSubscriptions += 1;
    },
  };
  const editor: FakeEditor = {
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
    addCommand: vi.fn((keybinding: number, handler: () => void) => {
      state.commands.set(keybinding, handler);
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
    dispose: vi.fn(),
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
  state.commands = new Map();
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
    state.commands.get(KEY_MOD.CtrlCmd | KEY_CODE.KeyE)?.();
    expect(onExecuteShortcut).toHaveBeenCalledOnce();
  });

  it('binds ⌘↩ and F5 to the ungated execute', () => {
    const onExecute = vi.fn();
    mount({ onExecute });

    state.commands.get(KEY_MOD.CtrlCmd | KEY_CODE.Enter)?.();
    state.commands.get(KEY_CODE.F5)?.();

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
    expect([...state.commands.keys()].sort((a, b) => a - b)).toEqual(
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

    state.commands.get(TAB_FOCUS_KEY)?.();
    expect(state.triggered).toEqual([TAB_FOCUS_COMMAND_ID]);
    expect(state.tabFocusMode).toBe(true);

    state.commands.get(TAB_FOCUS_KEY)?.();
    expect(state.tabFocusMode).toBe(false);
  });

  it('reaches it through trigger, because getAction cannot resolve a command', () => {
    // The regression fence. The first attempt at this fix ran ⌃M through `getAction(...).run()`,
    // which returns null for a `registerAction2` id — so the binding fired on every press and did
    // nothing, and the suite was green because the double resolved every id. This pins the working
    // path from both sides: the command id goes to `trigger`, and `getAction` is never consulted
    // for it — and the double now answers null there no matter what the test asks for.
    mount();
    state.commands.get(TAB_FOCUS_KEY)?.();

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

    expect(() => state.commands.get(TAB_FOCUS_KEY)?.()).toThrow(/left tab focus mode unchanged/);
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
