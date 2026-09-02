/**
 * Application settings types
 */

export type ThemePreference = 'system' | 'light' | 'dark';

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  autoComplete: boolean;
}

export type ExecuteScope = 'all' | 'currentStatement';

export interface QuerySettings {
  defaultTimeout: number; // milliseconds
  maxRowsToDisplay: number;
  showExecutionTime: boolean;
  confirmBeforeExecute: boolean;
  executeScope: ExecuteScope;
}

/**
 * Format used by the inline "Copy selected" button on the results grid.
 * - tsv: tab-separated; pastes natively into Excel / Google Sheets.
 * - csv: comma-separated, RFC 4180 quoted; better for sharing as a file.
 * - json: array of objects keyed by column name; best for code consumers.
 */
export type CopyFormat = 'tsv' | 'csv' | 'json';

export interface GridSettings {
  rowHeight: number;
  showRowNumbers: boolean;
  alternatingRowColors: boolean;
  animateRows: boolean;
  copyFormat: CopyFormat;
  copyIncludeHeaders: boolean; // ignored for json
}

export interface AppSettings {
  theme: ThemePreference;
  editor: EditorSettings;
  query: QuerySettings;
  grid: GridSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  /**
   * The six editor preferences, each a DELIBERATE choice rather than an inherited one (J-44).
   *
   * They need saying out loud because for the whole of the Angular renderer's life they meant
   * nothing: `query.component.ts:1270-1279` hardcoded Monaco's options and never read this object,
   * so the Settings panel wrote values no editor consulted and four of the six defaults disagreed
   * with what users were looking at. React's `<SqlEditor>` derives every option from the setting
   * (`editor/sql-editor.tsx:194-237`), which turns each value below into something a user sees.
   *
   * Craig's ruling: keep what ships and what the React build has been showing — font 13, tab 4,
   * word wrap off. The other three follow the same rule: `minimap` off because the Angular editor
   * hardcoded it off (this object said `true`, and honouring that would have handed every existing
   * user a minimap they never asked for), `lineNumbers` on and `autoComplete` on because the
   * hardcoded editor and this object already agreed.
   *
   * Every value here is pinned by `settings.types.spec.ts` and stated in two docs-site pages
   * (`reference/settings.md`, `features/query-editor.md`); changing one means changing all three.
   */
  editor: {
    fontSize: 13,
    tabSize: 4,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
    autoComplete: true,
  },
  query: {
    defaultTimeout: 30000,
    maxRowsToDisplay: 10000,
    showExecutionTime: true,
    confirmBeforeExecute: false,
    executeScope: 'all',
  },
  grid: {
    rowHeight: 24,
    showRowNumbers: true,
    alternatingRowColors: true,
    animateRows: false,
    copyFormat: 'tsv',
    copyIncludeHeaders: true,
  },
};
