/**
 * `<SqlEditor>` — the one owned Monaco wrapper. Everything the app does to an editor goes through
 * this component or the handle it exposes; nothing else in the package may import Monaco (the
 * `no-restricted-imports` fence in `eslint.config.js`, asserted by `ban-rules.spec.ts`).
 *
 * It replaces `query.component.ts:1195-1491` — the AMD `loader.js` script tag, the
 * `declare const monaco` global, the `win._monacoLoading` singleton promise, and the 130-line
 * `createEditor` that also owned tab content, auto-execute, autocomplete prefetch and theming.
 *
 * ── Why an imperative handle and not props ──────────────────────────────────────────────────
 *
 * Monaco owns its own document, its own undo stack and its own DOM. A controlled `value` prop would
 * mean `setValue` on every keystroke, which resets the undo stack and moves the caret — the exact
 * `if (currentValue !== activeTab.content && …)` dance the Angular component grew at `:1036-1044` to
 * work around it. So the text is uncontrolled: `defaultValue` seeds it once, `onChange` reports, and
 * everything else (format, find, insert a snippet, read what to execute) is a method on
 * `SqlEditorHandle`. React state stays out of the hot path entirely, which is also what keeps a
 * per-keystroke re-render off the tab list (`state/tab.ts` header).
 *
 * ── What is global to Monaco, and therefore registered exactly once ─────────────────────────
 *
 * Themes, the SQL completion provider and the AI ghost-text provider are all registered against the
 * Monaco *module*, not against an editor. Doing that per instance is a duplicate-suggestions bug that
 * scales with open tabs — and it is what the Angular renderer did (`:1390` and `:1490` run per query
 * tab). `useMonacoGlobals` below does it once per page, idempotently.
 *
 * ── The Dockview interaction (PLAN.md R5 finding 4, re-measured in Task 10's spike) ─────────
 *
 * An inactive Dockview panel keeps its React tree mounted while DETACHING its DOM from the document.
 * The spike measured what that does to Monaco: an editor created while its panel is detached comes up
 * at Monaco's 5×5 minimum, and stays there until something re-measures it. `automaticLayout: true`
 * eventually does (its ResizeObserver fires on re-attach), which is why `layout()` is on the handle
 * rather than hidden inside: the panel calls it *synchronously* on activation, so the first painted
 * frame after a tab switch is already the right size instead of a collapsed one a frame later.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import type { AppSettings } from '@joinery/shared';

import { IS_MAC } from '../utils/platform';
import { monaco } from './monaco';
import { EDITOR_THEMES } from './monaco-themes';
import { sqlIntellisense } from './intellisense';
import type { SqlLanguageId } from './sql-dialect';
import { textToExecute, type ExecutionSource } from './statements';
import type { ExecuteScope } from '@joinery/shared';

/** What the query panel can do to its editor. Nothing here reaches Monaco's own API surface. */
export interface SqlEditorHandle {
  readonly getValue: () => string;
  /** Replaces the whole document as ONE undoable edit — never `setValue`, see `replaceAll`. */
  readonly setValue: (value: string) => void;
  readonly focus: () => void;
  /** Re-measures. Called on Dockview panel activation; see the header. */
  readonly layout: () => void;
  /** The SQL an execute should send, resolved against the caret, the selection and the setting. */
  readonly textToExecute: (scope: ExecuteScope) => string;
  /**
   * Is there a real selection right now?
   *
   * Monaco's own answer — `getSelection().isEmpty()`, a zero-WIDTH check — and the only correct one.
   * Execute Selection used to infer this by comparing the selected text with the whole buffer, which
   * makes a deliberate ⌘A indistinguishable from no selection at all: the user selects everything,
   * asks to run the selection, and is told to select something. It is also wrong the other way for a
   * one-line document, where any full-line selection equals the buffer.
   */
  readonly hasSelection: () => boolean;
  /** Appends a snippet, matching the Angular blank-line separator rule. */
  readonly insertSnippet: (sql: string) => void;
  /** Runs one of Monaco's own actions: find, replace, go-to-line, toggle comment. */
  readonly runAction: (actionId: EditorActionId) => void;
}

/**
 * The four Monaco actions this app drives, named once. A union rather than a `string` so a typo is a
 * compile error instead of a silently missing action — `getAction` returns null for an unknown id and
 * the Angular version's `trigger('keyboard', id)` swallowed that entirely.
 */
export type EditorActionId =
  | 'actions.find'
  | 'editor.action.startFindReplaceAction'
  | 'editor.action.gotoLine'
  | 'editor.action.commentLine';

export interface SqlEditorProps {
  /** Seeds the document once, on mount. Later changes are ignored — the editor owns the text. */
  readonly defaultValue: string;
  readonly language: SqlLanguageId;
  readonly editorSettings: AppSettings['editor'];
  readonly theme: 'dark' | 'light';
  /** Every content change, debounced by nothing: the consumer writes to a Map, not to React state. */
  readonly onChange: (value: string) => void;
  readonly onCursorPositionChange: (position: { line: number; column: number }) => void;
  /** ⌘E / ⌃E from inside the editor. The confirm gate lives in the consumer, not here. */
  readonly onExecuteShortcut: () => void;
  /** ⌘↩ and F5 — execute with no gate, matching the Angular bindings. */
  readonly onExecute: () => void;
  readonly handleRef: RefObject<SqlEditorHandle | null>;
  readonly 'data-testid'?: string;
}

/**
 * Registers everything Monaco holds module-globally: the two themes and the two SQL providers.
 *
 * Idempotent and once per page. A ref would not be enough — StrictMode mounts twice and a second
 * `<SqlEditor>` in a split view mounts again — so the latch is module state, which is the same scope
 * the thing being registered lives in.
 */
let globalsInstalled = false;

function installMonacoGlobals(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;

  for (const { name, data } of Object.values(EDITOR_THEMES)) {
    monaco.editor.defineTheme(name, data);
  }

  // One registration for all editors, for all three dialects. The provider resolves which
  // connection and database to complete against from the active tab (`intellisense.ts`), so a
  // second query tab does not mean a second provider and duplicated suggestions.
  sqlIntellisense.registerCompletionProvider(monaco.languages);
  sqlIntellisense.registerGhostTextProvider(monaco.languages);
}

/**
 * Monaco options derived from `EditorSettings`.
 *
 * The Angular version hardcoded all six of these (`:1270-1279`: `fontSize: 14`, `minimap: false`,
 * `tabSize: 2`, …) while `EditorSettings` sat in `AppSettings` with a settings panel writing to it —
 * so every editor preference in the app was inert. They are wired here, and `updateOptions` below
 * keeps them live without recreating the editor.
 *
 * `fontFamily` is the brand technical face rather than the Angular `'JetBrains Mono, Consolas,
 * monospace'`; the variable is what `theme.css` registers, so it follows the same fallback chain as
 * every other mono surface in the app.
 */
function optionsFrom(settings: AppSettings['editor']): monaco.editor.IEditorOptions {
  return {
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap ? 'on' : 'off',
    minimap: { enabled: settings.minimap },
    lineNumbers: settings.lineNumbers ? 'on' : 'off',
    // `autoComplete` off means no suggest widget at all — the provider stays registered, it is just
    // never asked. Both flags, because Monaco splits "as you type" from "on demand" and the setting
    // is one switch: ⌃Space still works, which is the behaviour the label promises.
    quickSuggestions: settings.autoComplete,
    suggestOnTriggerCharacters: settings.autoComplete,
  };
}

/**
 * Indentation, which Monaco keeps on the MODEL rather than the editor (`tabSize` and `insertSpaces`
 * are `ITextModelUpdateOptions`, not `IEditorOptions` — the compiler says so, which is how this got
 * split out). Applied after `create` and again whenever the setting changes.
 *
 * `insertSpaces` is fixed rather than a preference: `EditorSettings` has no tabs-vs-spaces switch, and
 * the Angular editor hardcoded spaces.
 */
function modelOptionsFrom(settings: AppSettings['editor']): monaco.editor.ITextModelUpdateOptions {
  return {
    tabSize: settings.tabSize,
    insertSpaces: true,
    // Rainbow brackets: **asked to be off here, and THEMED in `monaco-themes.ts` because off does not
    // stick.** The theming is what makes the outcome right; this option is belt, not braces.
    //
    // What two browser-gate runs established. The editor option `bracketPairColorization` alone changes
    // nothing — `colorizedBracketPairsDecorationProvider.js:17` reads
    // `textModel.getOptions().bracketPairColorizationOptions`, so the model is what decides — and with
    // the editor option alone the gate photographed gold parentheses under ink and blue ones under
    // ivory. Setting it HERE, on the model, does not reliably win either: `modelService`'s
    // `_updateModelOptions` can push the service-wide default back over a model-level write. The gate's
    // final run proves it: the brackets still render on spans classed `bracket-highlighting-0`
    // (`task-10-gate.json`), i.e. the feature is still on — they are simply painted the delimiter
    // colour, which is the theme's six `editorBracketHighlight.foreground*` entries doing the work.
    //
    // So: never rely on this line for the colour. Bracket MATCHING is a different feature, deliberately
    // still on, and themed through `editorBracketMatch.*`.
    bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
  };
}

/** The options that are not user preferences. Split out so `optionsFrom` is exactly the settings. */
const FIXED_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderWhitespace: 'selection',
  // Verbatim from `:1281-1289`: the find widget's configuration and occurrence highlighting.
  find: {
    addExtraSpaceOnTop: true,
    autoFindInSelection: 'multiline',
    seedSearchStringFromSelection: 'selection',
    loop: true,
  },
  occurrencesHighlight: 'singleFile',
  selectionHighlight: true,
  fontFamily: 'var(--font-technical)',
  // The editor half of ASKING for rainbow brackets to be off. Neither this nor the model half in
  // `modelOptionsFrom` makes it stick — the gate photographed the feature still on, still emitting
  // `bracket-highlighting-*` classes — so the colour comes from the theme, which flattens all six
  // levels onto the delimiter token. See the comment on the model option.
  bracketPairColorization: { enabled: false },
  // The gutter is the app's own chrome; Monaco's default 26px reserves room for breakpoints and
  // folding markers this app has neither of.
  lineDecorationsWidth: 8,
  lineNumbersMinChars: 3,
  padding: { top: 8, bottom: 8 },
  // Codicon-based scrollbars are Monaco's; the app's rules are hairlines, so keep the slider thin.
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  // A standalone editor's context menu is Monaco's own (Cut/Copy/Command Palette…) and it collides
  // with the app's `ContextMenu` primitive. Off until a task designs an editor context menu.
  contextmenu: false,
};

export function SqlEditor({
  defaultValue,
  language,
  editorSettings,
  theme,
  onChange,
  onCursorPositionChange,
  onExecuteShortcut,
  onExecute,
  handleRef,
  'data-testid': testId,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  /**
   * The callbacks, read through refs by the Monaco listeners.
   *
   * Monaco subscriptions are set up once, in the mount effect, and must not be torn down when a
   * parent re-renders with a new closure — re-creating the editor to pick up a new `onChange` would
   * discard the document and the undo stack. Same reasoning as `commands/bus.ts`'s handler ref, and
   * the same layout-effect refresh, because a Monaco keybinding can fire between commit and the
   * passive-effect flush.
   */
  const callbacks = useRef({ onChange, onCursorPositionChange, onExecuteShortcut, onExecute });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCursorPositionChange, onExecuteShortcut, onExecute };
  }, [onChange, onCursorPositionChange, onExecuteShortcut, onExecute]);

  /**
   * Replaces the whole document as a single undoable edit.
   *
   * `setValue` is what the Angular version used in six places, and it is wrong for every one of them:
   * it resets the undo stack, so a user who formats their SQL (or loads a snippet, or opens a file)
   * cannot ⌘Z back to what they had. `executeEdits` with the full range is the same visible result and
   * it is undoable — which matters most for `format`, the one destructive-looking action in the
   * toolbar.
   */
  const replaceAll = useCallback((value: string): void => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    instance.executeEdits('joinery', [{ range: model.getFullModelRange(), text: value }]);
    instance.pushUndoStop();
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      getValue: () => editor.current?.getValue() ?? '',
      setValue: replaceAll,
      focus: () => editor.current?.focus(),
      layout: () => editor.current?.layout(),
      textToExecute: scope => {
        const instance = editor.current;
        const model = instance?.getModel();
        if (!instance || !model) return '';
        const selection = instance.getSelection();
        const source: ExecutionSource = {
          value: model.getValue(),
          selection: selection === null ? '' : model.getValueInRange(selection),
          cursorLine: instance.getPosition()?.lineNumber ?? 1,
        };
        return textToExecute(source, scope);
      },
      hasSelection: () => {
        // `?? null` collapses "no editor yet" into "no selection": the caller's refusal path is the
        // right answer for both, and neither is an error worth reporting.
        const selection = editor.current?.getSelection() ?? null;
        return selection !== null && !selection.isEmpty();
      },
      // Verbatim from `handleInsertSnippet` (`:1174-1193`): appended after a blank line when there is
      // already content, otherwise it becomes the content. Not Monaco's snippet insertion — the
      // Angular behaviour is an append, and a snippet library entry is a whole statement.
      insertSnippet: sql => {
        const current = editor.current?.getValue() ?? '';
        replaceAll(current.trim() ? `${current}\n\n${sql}` : sql);
      },
      runAction: actionId => {
        const instance = editor.current;
        if (!instance) return;
        instance.focus();
        // `getAction` returns null for an id Monaco does not have — which happens when an editor is
        // built without the contribution that owns it. Reported rather than swallowed: the Angular
        // `trigger('keyboard', id)` form fails silently, and "⌘F does nothing" is the result.
        const action = instance.getAction(actionId);
        if (action === null) {
          throw new Error(`[SqlEditor] Monaco has no action "${actionId}"`);
        }
        void action.run();
      },
    }),
    // `handleRef` is the target, not an input: `useImperativeHandle` reads it, and including it would
    // rebuild the handle whenever the parent passed a new ref object. `replaceAll` is stable.
    [replaceAll]
  );

  // ── Mount: create the editor, wire its listeners, dispose everything on unmount ────────────
  useEffect(() => {
    const element = host.current;
    if (element === null) return;

    installMonacoGlobals();

    const instance = monaco.editor.create(element, {
      ...FIXED_OPTIONS,
      ...optionsFrom(editorSettings),
      value: defaultValue,
      language,
      theme: EDITOR_THEMES[theme].name,
    });
    editor.current = instance;
    instance.getModel()?.updateOptions(modelOptionsFrom(editorSettings));

    const subscriptions = [
      instance.onDidChangeModelContent(() => callbacks.current.onChange(instance.getValue())),
      instance.onDidChangeCursorPosition(event =>
        callbacks.current.onCursorPositionChange({
          line: event.position.lineNumber,
          column: event.position.column,
        })
      ),
    ];

    // ⌘E / ⌃E. `menu.ts` registers Query ▸ Execute with `registerAccelerator: false` precisely so
    // this keybinding is the renderer's, which is why it is here and not a menu channel.
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () =>
      callbacks.current.onExecuteShortcut()
    );
    // ⌘↩ and F5, both ungated. `addCommand` rather than the Angular `onKeyDown` +
    // `preventDefault` + `stopPropagation` intercept at `:1308-1314`: a Monaco keybinding already
    // consumes the keystroke, so ⌘↩ cannot also insert a newline.
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      callbacks.current.onExecute()
    );
    instance.addCommand(monaco.KeyCode.F5, () => callbacks.current.onExecute());

    // ⌃M — the keyboard trap's escape hatch (J-83, WCAG 2.1.2).
    //
    // Monaco binds Tab to "insert a tab character", which is right for a SQL editor and wrong for
    // a keyboard-only user: without an escape, focus cannot leave this control at all. Monaco ships
    // exactly that escape as `editor.action.toggleTabFocusMode`, and its own ⌃M binding does not
    // reach the editor in this app — the a11y walk tried it first and stayed trapped, which is
    // recorded in `tests/e2e-react/a11y.spec.ts`.
    //
    // The modifier has to be chosen per platform, and the two Monaco constants do NOT mean what
    // their names suggest on both: `WinCtrl` is Control on macOS but the WINDOWS key on Windows,
    // and `CtrlCmd` is ⌘ on macOS but Control on Windows. So Control-M — which is what VS Code
    // teaches and what a screen-reader user will try — is `WinCtrl` on macOS and `CtrlCmd`
    // elsewhere. Binding one of them on both platforms would have given Windows users Win+M.
    //
    // On macOS this deliberately does not use `CtrlCmd`: ⌘M is the menu's `role: 'minimize'`.
    //
    // A toggle, not a one-way move: turning it on makes Tab move focus, turning it off restores
    // tab-as-indent, and Monaco announces the state to assistive technology itself.
    const controlKey = IS_MAC ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
    instance.addCommand(controlKey | monaco.KeyCode.KeyM, () => {
      instance.trigger('joinery:a11y', 'editor.action.toggleTabFocusMode', null);
    });

    // Seed the caret readout so the status bar's Ln/Col is populated before the first keystroke.
    const initial = instance.getPosition();
    if (initial !== null) {
      callbacks.current.onCursorPositionChange({
        line: initial.lineNumber,
        column: initial.column,
      });
    }

    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      // Disposing the editor disposes its model, which is what we want: one model per editor, created
      // implicitly by `create({ value, language })` and owned by nothing else.
      instance.dispose();
      editor.current = null;
    };
    // Mount only. `defaultValue`, `language`, `editorSettings` and `theme` are applied by the three
    // effects below rather than by recreating the editor — an eslint-disable is not needed because
    // none of them is in the dependency list, and that is the point: the editor is created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live settings, without recreating the editor. Both halves, because indentation lives on the model.
  useEffect(() => {
    editor.current?.updateOptions(optionsFrom(editorSettings));
    editor.current?.getModel()?.updateOptions(modelOptionsFrom(editorSettings));
  }, [editorSettings]);

  // The theme is Monaco-global (`setTheme` retints every editor), so this is not per instance in
  // effect — but it must run when the app theme changes, and this is where the app theme is known.
  useEffect(() => {
    if (editor.current === null) return;
    monaco.editor.setTheme(EDITOR_THEMES[theme].name);
  }, [theme]);

  // The engine can change under a tab (the connection chip). `setModelLanguage` retokenizes in place;
  // recreating the model would lose the undo stack and the caret.
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  return <div ref={host} data-testid={testId} className="size-full min-h-0" />;
}
