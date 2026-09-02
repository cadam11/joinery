/**
 * The settings groups, and the rule every control in them obeys.
 *
 * Four of them hold preferences; the fifth, `AiGroup`, holds a door to the AI setup dialog and no
 * preference at all — see its own header for why the keychain-backed settings are not inlined here.
 *
 * ── The rule (J-44, and it is the whole point of this file) ─────────────────────────────────
 *
 * **Every control here changes real behaviour, or it ships disabled with its owner named.** J-44 is
 * what happens otherwise: the Angular query editor hardcoded its Monaco options
 * (`query.component.ts:1271`) while this panel wrote `AppSettings.editor`, so all six editor toggles
 * persisted and changed nothing — for months, invisibly, because a toggle that flips looks like a
 * toggle that works. Three query settings were the same defect.
 *
 * So each row below names its consumer in a comment, and the consumer is a file you can open:
 *
 * | group     | setting                | consumer                                                       |
 * | --------- | ---------------------- | -------------------------------------------------------------- |
 * | Appearance| `theme`                | `state/settings.ts` → `[data-theme]`, Monaco, AG Grid, Toaster  |
 * | Editor    | all six                | `editor/sql-editor.tsx` `optionsFrom` / `modelOptionsFrom`      |
 * | Editor    | ⌃E confirmation        | `state/editor-prefs.ts` → `query-panel.tsx`'s gate              |
 * | Query     | `maxRowsToDisplay`     | `features/query/use-run-query.ts` → the executor's row cap      |
 * | Query     | `executeScope`         | `query-panel.tsx` → `editor/statements.ts`                      |
 * | Query     | `showExecutionTime`    | `features/query/query-results.tsx`'s Messages pane              |
 * | Query     | `confirmBeforeExecute` | `query-panel.tsx`'s execute gate                                |
 * | Query     | `defaultTimeout`       | `features/query/use-run-query.ts` → the executor's deadline     |
 * | Grid      | all six                | `features/query/results-grid.tsx`                               |
 *
 * `QuerySettings.autoExecuteOnOpen` has **no row at all**: auto-execute is a per-tab fact
 * (`tabStore.openQueryTab(…, autoExecute)`), nothing reads the global flag, and there is no agreed
 * meaning for it. A control for it would be decorative by construction, so it is absent rather than
 * disabled, and the decision is a follow-up ticket.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────────────────────
 *
 * Each control is a `ui/` form primitive with its own label and hint, in a hairline-separated stack.
 * That is not a style preference: the primitive's label is a real `<label for>`, which is what makes
 * the e2e tier's `getByLabel` work (`ui/field.tsx`), and it is why there is no `<SettingRow label=…>`
 * component taking the label away from the control that owns it.
 */

import { useEffect, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import type { AppSettings, CopyFormat, ExecuteScope, ThemePreference } from '@joinery/shared';

import { Button, Icon, Select, SelectItem, Switch, cn } from '../../ui';
import { selectHasConfiguredVendors, useAIStore } from '../../state/ai';
import { MAX_ROWS_SETTING_LABEL } from './settings-labels';
import {
  selectConfirmedCtrlEExecute,
  editorPrefsStore,
  useEditorPrefsStore,
} from '../../state/editor-prefs';
import {
  selectEditorSettings,
  selectEffectiveTheme,
  selectGridSettings,
  selectQuerySettings,
  selectTheme,
  settingsStore,
  useSettingsStore,
  type ResolvedTheme,
} from '../../state/settings';
import { keyHint } from '../../utils/platform';
import { NumberSetting, SettingRow, SettingsGroup } from './setting-controls';

/**
 * The three theme states, in the order the control lists them, with the product's own names for the
 * two canvases (HOUSE-RULES §3: the dark theme is *ink*, the light one *ivory*). The status bar's
 * menu uses the same three labels — one name per theme, or a user reading both surfaces learns two.
 */
export const THEME_CHOICES: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'system', label: 'System', description: 'Follow the operating system.' },
  { value: 'dark', label: 'Ink', description: "The dark canvas, and Joinery's default." },
  { value: 'light', label: 'Ivory', description: 'The light canvas.' },
];

/** What `system` currently resolves to, in the same vocabulary the choices use. */
function resolvedThemeName(resolved: ResolvedTheme): string {
  return resolved === 'dark' ? 'ink' : 'ivory';
}

/**
 * The three-state theme control: native radios in a `<fieldset>`.
 *
 * Native inputs rather than a hand-built segmented control, for the reason `ui/checkbox.tsx` gives
 * about checkboxes and `form-controls.md` states outright — the platform supplies the group
 * semantics, the arrow-key model and the announced state, and none of it can be forgotten. The
 * `<legend>` is the group's accessible name, so there is no `aria-labelledby` to keep in sync.
 *
 * It is the *full* version of the status bar's dropdown: the same three states through the same store
 * action, plus what `system` currently resolves to — which the dropdown has no room to say and which
 * is the one thing about `system` a user cannot see from the label.
 */
function ThemeSetting() {
  const preference = useSettingsStore(selectTheme);
  const resolved = useSettingsStore(selectEffectiveTheme);

  return (
    <SettingRow>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm text-fg">Theme</legend>
        {THEME_CHOICES.map(choice => (
          <label
            key={choice.value}
            className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5 text-base"
          >
            <input
              type="radio"
              name="settings-theme"
              value={choice.value}
              data-testid={`settings-theme-${choice.value}`}
              checked={choice.value === preference}
              onChange={() => settingsStore.getState().updateTheme(choice.value)}
              className={cn(
                'col-start-1 row-start-1 mt-0.5 size-4 shrink-0',
                'appearance-none rounded-full border border-rule-strong bg-surface',
                // The one accent fill this surface spends on a form control, which is the job
                // `ui/checkbox.tsx` and `ui/switch.tsx` already spend it on — HOUSE-RULES §5 lists
                // the selected state of a control among oxide's jobs, not among its budget.
                'checked:border-accent-strong checked:bg-accent-strong',
                'checked:inset-ring-2 checked:inset-ring-elevated',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                // Windows high-contrast: hand the control back to the OS rather than painting an
                // invisible circle. Same reasoning as the checkbox primitive.
                'forced-colors:appearance-auto'
              )}
            />
            {/* Both spans are direct children of the `<label>`, laid out by its grid rather than
                wrapped in a column div: `jsx-a11y/label-has-associated-control` measures how deeply the
                label's text is nested, and a wrapper puts it out of reach. */}
            <span className="col-start-2 row-start-1 min-w-0 text-fg">{choice.label}</span>
            <span className="col-start-2 row-start-2 min-w-0 text-sm text-fg-muted text-pretty">
              {choice.description}
            </span>
          </label>
        ))}
        <p data-testid="settings-theme-resolved" className="text-sm text-fg-muted">
          {preference === 'system'
            ? `Following the system, which is currently ${resolvedThemeName(resolved)}.`
            : `Painting ${resolvedThemeName(resolved)} regardless of the system.`}
        </p>
      </fieldset>
    </SettingRow>
  );
}

export function AppearanceGroup() {
  return (
    <SettingsGroup testId="settings-group-appearance">
      <ThemeSetting />
    </SettingsGroup>
  );
}

/**
 * A boolean setting. A `Switch` rather than a `Checkbox`, per that primitive's own rule: a switch
 * applies immediately, a checkbox applies on save, and every one of these is live the moment it moves.
 */
function ToggleSetting({
  testId,
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <SettingRow>
      <Switch
        name={testId}
        data-testid={testId}
        label={label}
        hint={hint}
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
    </SettingRow>
  );
}

/**
 * The ⌃E confirmation, which is the one editor preference that is not in `AppSettings`.
 *
 * It lives in `state/editor-prefs.ts` because it is a one-way tick on a dialog ("Don't ask me again"),
 * migrated from the `joinery-ctrl-e-execute-confirmed` localStorage key. The dialog can only ever set
 * it, so without this row there is no way back — and "I turned that off by accident" is precisely the
 * case a settings panel exists for.
 *
 * Disabled when there is nothing to reset, and the hint says which state it is in. That is not the
 * J-44 pattern in disguise: the control's consumer exists and works, the button is simply inapplicable
 * right now, which the copy states rather than leaving the user to press an inert button.
 */
function CtrlEConfirmationSetting() {
  const confirmed = useEditorPrefsStore(selectConfirmedCtrlEExecute);
  const shortcut = keyHint('E');

  return (
    <SettingRow>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-fg">Confirmation before {shortcut} runs a query</p>
        <p className="text-sm text-fg-muted text-pretty">
          {confirmed
            ? `You chose not to be asked again. Reset it and the next ${shortcut} confirms first.`
            : `${shortcut} already asks for confirmation the first time you press it.`}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="settings-editor-ctrl-e-reset"
          disabled={!confirmed}
          onClick={() => editorPrefsStore.getState().resetCtrlEExecuteConfirmation()}
        >
          Ask me again
        </Button>
      </div>
    </SettingRow>
  );
}

export function EditorGroup() {
  const editor: AppSettings['editor'] = useSettingsStore(selectEditorSettings);
  const update = settingsStore.getState().updateEditorSetting;

  return (
    <SettingsGroup testId="settings-group-editor">
      {/* All six consumed by `editor/sql-editor.tsx`, live on every open editor: its settings effect
          calls `updateOptions` on the instance and on the model, so nothing has to be reopened. */}
      <NumberSetting
        testId="settings-editor-font-size"
        label="Font size"
        hint="Editor text size, in pixels."
        value={editor.fontSize}
        min={10}
        max={24}
        onCommit={value => update('fontSize', value)}
      />
      <NumberSetting
        testId="settings-editor-tab-size"
        label="Tab size"
        hint="Spaces per indent level. Joinery always indents with spaces."
        value={editor.tabSize}
        min={2}
        max={8}
        onCommit={value => update('tabSize', value)}
      />
      <ToggleSetting
        testId="settings-editor-word-wrap"
        label="Wrap long lines"
        hint="Wrap instead of scrolling sideways."
        checked={editor.wordWrap}
        onChange={next => update('wordWrap', next)}
      />
      <ToggleSetting
        testId="settings-editor-minimap"
        label="Minimap"
        hint="The condensed overview down the right-hand edge."
        checked={editor.minimap}
        onChange={next => update('minimap', next)}
      />
      <ToggleSetting
        testId="settings-editor-line-numbers"
        label="Line numbers"
        hint="Show the line-number gutter."
        checked={editor.lineNumbers}
        onChange={next => update('lineNumbers', next)}
      />
      <ToggleSetting
        testId="settings-editor-auto-complete"
        label="Suggest as you type"
        hint="Off still leaves ⌃Space to ask for suggestions."
        checked={editor.autoComplete}
        onChange={next => update('autoComplete', next)}
      />
      <CtrlEConfirmationSetting />
    </SettingsGroup>
  );
}

const EXECUTE_SCOPES: readonly { readonly value: ExecuteScope; readonly label: string }[] = [
  { value: 'all', label: 'The whole editor' },
  { value: 'currentStatement', label: 'The statement at the caret' },
];

/**
 * Radix hands `onValueChange` a `string`, and the two selects below feed it straight into a store action
 * typed to a union. A cast there is a lie the compiler cannot catch: a renamed `ExecuteScope` member, or a
 * `SelectItem` with a typo'd `value`, would write a value nothing downstream handles and the panel would
 * keep showing whatever it wrote. So the precondition is checked at runtime, against the same constant
 * array the options are rendered from — there is no second list to keep in sync.
 */
function asExecuteScope(value: string): ExecuteScope {
  const scope = EXECUTE_SCOPES.find(candidate => candidate.value === value);
  if (scope === undefined) {
    throw new Error(`[settings] not an execute scope: ${JSON.stringify(value)}`);
  }
  return scope.value;
}

export function QueryGroup() {
  const query: AppSettings['query'] = useSettingsStore(selectQuerySettings);
  const update = settingsStore.getState().updateQuerySetting;

  return (
    <SettingsGroup testId="settings-group-query">
      {/* `use-run-query.ts` passes this as `QueryRequest.maxRows`, and the main-process executor
          truncates before the result crosses IPC — so it caps what the grid receives, not what it
          draws, and the grid's "showing N of M" line is where a user sees it bite. */}
      <NumberSetting
        testId="settings-query-max-rows"
        label={MAX_ROWS_SETTING_LABEL}
        hint="Larger result sets are truncated, and the grid says so."
        value={query.maxRowsToDisplay}
        min={100}
        max={100_000}
        onCommit={value => update('maxRowsToDisplay', value)}
      />

      {/* `query-panel.tsx` reads this at execute time and hands it to `editor/statements.ts`. */}
      <SettingRow>
        <Select
          name="settings-query-execute-scope"
          data-testid="settings-query-execute-scope"
          label="Execute runs"
          hint="With text selected, Execute always runs the selection."
          value={query.executeScope}
          onValueChange={value => update('executeScope', asExecuteScope(value))}
          className="max-w-72"
        >
          {EXECUTE_SCOPES.map(scope => (
            <SelectItem key={scope.value} value={scope.value}>
              {scope.label}
            </SelectItem>
          ))}
        </Select>
      </SettingRow>

      <ToggleSetting
        testId="settings-query-show-execution-time"
        label="Show execution time"
        hint="The duration line on the Messages pane."
        checked={query.showExecutionTime}
        onChange={next => update('showExecutionTime', next)}
      />

      <ToggleSetting
        testId="settings-query-confirm-before-execute"
        label="Confirm before every execute"
        hint={`Every Execute asks first — not only the first ${keyHint('E')}.`}
        checked={query.confirmBeforeExecute}
        onChange={next => update('confirmBeforeExecute', next)}
      />

      {/* Live since J-54. `use-run-query.ts` sends it as `QueryRequest.timeout` and
          `main/.../query-timeout.ts` enforces it per engine — an mssql attention packet, a
          destroyed pg client, a destroyed mysql2 connection. The connection profile's own
          `requestTimeout` still bounds the pool, and nothing reconciles the two on purpose: a
          query stops at the first of the two deadlines to fire, which is what the hint says. */}
      <NumberSetting
        testId="settings-query-timeout"
        label="Query timeout (seconds)"
        hint="A query is stopped at this limit, or at the connection's own request timeout — whichever is shorter."
        value={Math.round(query.defaultTimeout / 1000)}
        min={5}
        max={300}
        onCommit={value => update('defaultTimeout', value * 1000)}
      />
    </SettingsGroup>
  );
}

const COPY_FORMATS: readonly { readonly value: CopyFormat; readonly label: string }[] = [
  { value: 'tsv', label: 'Tab-separated — pastes into Excel' },
  { value: 'csv', label: 'Comma-separated' },
  { value: 'json', label: 'JSON' },
];

/** The same precondition as `asExecuteScope`, for the copy format. */
function asCopyFormat(value: string): CopyFormat {
  const format = COPY_FORMATS.find(candidate => candidate.value === value);
  if (format === undefined) {
    throw new Error(`[settings] not a copy format: ${JSON.stringify(value)}`);
  }
  return format.value;
}

export function GridGroup() {
  const grid: AppSettings['grid'] = useSettingsStore(selectGridSettings);
  const update = settingsStore.getState().updateGridSetting;

  return (
    <SettingsGroup testId="settings-group-grid">
      {/* All six consumed by `features/query/results-grid.tsx`, which subscribes through
          `selectGridSettings` — so an open grid re-renders and AG Grid adopts the new row height,
          column set and striping without re-running the query. */}
      <NumberSetting
        testId="settings-grid-row-height"
        label="Row height"
        hint="Pixels per result row."
        value={grid.rowHeight}
        min={20}
        max={48}
        onCommit={value => update('rowHeight', value)}
      />
      <ToggleSetting
        testId="settings-grid-row-numbers"
        label="Row numbers"
        hint="The ordinal gutter down the left of the results."
        checked={grid.showRowNumbers}
        onChange={next => update('showRowNumbers', next)}
      />
      <ToggleSetting
        testId="settings-grid-striped"
        label="Alternating row shading"
        hint="One surface step on every other row."
        checked={grid.alternatingRowColors}
        onChange={next => update('alternatingRowColors', next)}
      />
      <ToggleSetting
        testId="settings-grid-animate-rows"
        label="Animate row changes"
        hint="Slide rows when sorting or filtering. Off is faster on large results."
        checked={grid.animateRows}
        onChange={next => update('animateRows', next)}
      />

      <SettingRow>
        <Select
          name="settings-grid-copy-format"
          data-testid="settings-grid-copy-format"
          label="Copy format"
          hint="Used by the results Copy button. The Export menu always offers all three."
          value={grid.copyFormat}
          onValueChange={value => update('copyFormat', asCopyFormat(value))}
          className="max-w-96"
        >
          {COPY_FORMATS.map(format => (
            <SelectItem key={format.value} value={format.value}>
              {format.label}
            </SelectItem>
          ))}
        </Select>
      </SettingRow>

      {/* Disabled for JSON, where headers are the object keys and a leading header row is meaningless
          — the same condition the Angular panel had, and the one case in this file where `disabled`
          is about the OTHER setting's value rather than a missing consumer. */}
      <ToggleSetting
        testId="settings-grid-copy-headers"
        label="Include column names when copying"
        hint={
          grid.copyFormat === 'json'
            ? 'JSON carries the column names as object keys, so there is no header row.'
            : 'Prepend the column names as the first row.'
        }
        checked={grid.copyIncludeHeaders}
        disabled={grid.copyFormat === 'json'}
        onChange={next => update('copyIncludeHeaders', next)}
      />
    </SettingsGroup>
  );
}

export interface AiGroupProps {
  /**
   * Dismisses this dialog and opens AI setup. Owned by `SettingsDialog` rather than done here,
   * because dismissing correctly means flushing the pending number drafts first — see that file.
   */
  readonly onOpenAiSetup: () => void;
}

/**
 * The fifth group: a door to the AI setup dialog, and nothing else (J-92).
 *
 * ── Why a door rather than the controls ─────────────────────────────────────────────────────
 *
 * Every other row in this file writes a preference through `settingsStore`. AI configuration does
 * not fit that shape: an API key is a **keychain write in the main process** validated against the
 * provider first (`features/ai-setup/ai-setup-dialog.tsx` states the secrets discipline it keeps),
 * and moving that here would either duplicate the discipline or spread it across two surfaces. So
 * the group states where the settings are and takes the user there in one click.
 *
 * ── Why the group exists at all ─────────────────────────────────────────────────────────────
 *
 * Before this, the AI setup dialog's only *unconditional* entry point was the command palette. Its
 * two visible affordances — the welcome tab's AI card and the chat panel's no-provider empty state
 * — are both gated on NOT being configured yet, so a user who had already saved a key had exactly
 * one route left, and it was the one that requires knowing the command's name. ⌘, is where a user
 * looks first, so it is where the door belongs; the native `AI Setup…` item is the other half.
 */
export function AiGroup({ onOpenAiSetup }: AiGroupProps) {
  const configured = useAIStore(selectHasConfiguredVendors);

  return (
    <SettingsGroup testId="settings-group-ai">
      <SettingRow>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-fg-muted text-pretty">
            Providers, API keys, the preferred model and the OpenRouter routing band live in their
            own dialog — a key is a keychain write, not a preference.
          </p>

          <p
            data-testid="settings-ai-state"
            data-state={configured ? 'configured' : 'none'}
            className="flex items-center gap-1.5 text-sm text-fg-muted"
          >
            {configured ? (
              <>
                <Icon icon={Check} size="sm" className="stroke-success" />A provider has a key and
                is switched on.
              </>
            ) : (
              'No provider is configured yet, so chat and the AI features stay off.'
            )}
          </p>

          {/* `outline`, not `primary`: the footer's Reset is this dialog's other affordance and
              HOUSE-RULES §5 allows one filled control per visible surface — which this is not. */}
          <Button
            variant="outline"
            size="sm"
            leadingIcon={Sparkles}
            data-testid="settings-open-ai-setup"
            onClick={onOpenAiSetup}
          >
            Open AI setup
          </Button>
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

/**
 * Reset to defaults, with a two-press confirmation rather than a dialog.
 *
 * A dialog above a dialog is the shape PLAN §2.9 retires, and this is not a destructive action in the
 * data sense — it changes preferences, not databases. But it changes *all* of them at once from a
 * single click next to four groups of controls, so a bare button is too easy to hit. Arming resets
 * itself after a few seconds, so a user who wandered off does not come back to a primed button.
 */
export function ResetToDefaults() {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      variant={armed ? 'danger' : 'outline'}
      size="sm"
      data-testid="settings-reset"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        settingsStore.getState().resetToDefaults();
      }}
    >
      {armed ? 'Reset everything?' : 'Reset to defaults'}
    </Button>
  );
}
