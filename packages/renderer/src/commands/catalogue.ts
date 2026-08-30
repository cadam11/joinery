/**
 * How every command **presents itself**: its label, its one-line description, its group, its icon,
 * the keystroke that reaches it, and whether the command palette lists it.
 *
 * ── Why this is a per-key mapped type over the whole id union ────────────────────────────────
 *
 * PLAN.md 0.4's finding was ten palette entries that dispatched into silence, and `registry.ts`'s
 * answer was that a command cannot exist without a NAMED consumer. The palette is the other half of
 * that bargain, and it fails in three directions:
 *
 *  - a command that exists but is **missing from the palette** is a feature the user cannot find;
 *  - a palette entry that names **no command** is the dead dispatch coming back as UI copy;
 *  - a palette entry that names a command **carrying a payload** dispatches `undefined` into a
 *    handler that requires data — a dead dispatch with a live handler, which is worse.
 *
 * A `Record<CommandId, CommandDisplay>` closed the first two only: `palette: { show: true }` was
 * legal for every key, so a payload command marked visible compiled, rendered `ready`, and handed its
 * handler nothing. The shape below is a **mapped type evaluated per key** instead
 * (`{ [Id in CommandId]: CatalogueEntry<Id> }`), and `CatalogueEntry` narrows the `palette` field to
 * the hidden arm alone when `Id` carries a payload. So all three are compile errors now, and
 * `paletteCommandIds()` can return `PayloadlessCommandId[]` as a consequence of the data rather than
 * as a claim a test has to keep making.
 *
 * There is no second list anywhere: `features/command-palette` reads this file, and so does
 * `features/shortcuts-dialog`, which is why the cheatsheet cannot drift from the palette either.
 *
 * The palette additionally offers a handful of **local actions** (theme, close-all-tabs) that are not
 * commands at all — see `features/command-palette/palette-actions.ts` for why inventing registry
 * commands for them would make `COMMAND_CONSUMERS` lie.
 *
 * ── Accelerators are data now, and they are checked against `menu.ts` ────────────────────────
 *
 * `registry.ts` carries the accelerator of each menu channel in a **comment**, with a note that
 * `packages/main/src/menu.ts` is the source of truth and that the mechanical check is a re-read.
 * Task 7's review found three of those comments wrong, which is what a comment nobody can execute
 * does. Phase B needs the values as data (a palette row and a cheatsheet line both render them), so
 * they are here — and `catalogue.spec.ts` parses `packages/main/src/menu.ts` and
 * `packages/preload/src/index.ts` as text and asserts every `source: 'menu'` accelerator below
 * equals what the main process actually registers. A drifted label is now a failing test rather than
 * a wrong hint in the UI.
 *
 * The renderer may not import from `packages/main` at runtime, which is why the values are restated
 * here at all; the spec's `?raw` read is test-only, the same mechanism `markdown/sanitize-parity.spec.ts`
 * uses.
 */

import {
  Ban,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Code,
  Compass,
  Container,
  Copy,
  Database,
  DatabaseBackup,
  DatabasePlus,
  Download,
  FileCode,
  GitCompare,
  HardDriveDownload,
  House,
  Info,
  Keyboard,
  Languages,
  Layers,
  Locate,
  MessageSquare,
  MousePointer,
  Network,
  PanelBottom,
  PanelLeft,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Replace,
  Save,
  SaveAll,
  Search,
  Settings,
  Slash,
  Sparkles,
  SquareTerminal,
  Table2,
  Terminal,
  Trash2,
  Unplug,
  WandSparkles,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';

import { IS_MAC } from '../utils/platform';
import type { PayloadlessCommandId } from './bus';
import type { CommandId } from './registry';

/**
 * The groups a command belongs to, in the order the palette and the cheatsheet show them.
 *
 * The Angular palette's seven categories (`command-palette.component.ts:28`) minus `edit` merged
 * into `query` — every "edit" entry it had was a SQL editing action — plus `database`, which it did
 * not have even though it offered backup and restore.
 */
export const COMMAND_GROUPS = [
  'file',
  'query',
  'editor',
  'view',
  'connection',
  'database',
  'settings',
  'help',
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** The heading each group gets. Sentence case, per `copywriting.md`. */
export const COMMAND_GROUP_LABELS: Record<CommandGroup, string> = {
  file: 'File and tabs',
  query: 'Query',
  editor: 'Editor',
  view: 'View',
  connection: 'Connections',
  database: 'Databases',
  settings: 'Settings',
  help: 'Help',
};

/**
 * An Electron accelerator string, or one per platform when `menu.ts` branches on `isMac`.
 *
 * Kept in Electron's own spelling (`'CmdOrCtrl+Shift+N'`) rather than pre-rendered glyphs, so the
 * spec can compare it to `menu.ts` character for character. `formatAccelerator` turns it into what
 * the user sees.
 */
export type AcceleratorKeys = string | { readonly mac: string; readonly other: string };

/**
 * Who owns the keystroke. The distinction is load-bearing rather than documentation:
 *
 * - `menu` — `packages/main/src/menu.ts` registers it on a `MenuItem`, so the keystroke never
 *   reaches the renderer as a `keydown` at all; Electron fires the menu item, which sends the
 *   channel. `catalogue.spec.ts` checks these against that file.
 * - `renderer` — no menu item has it, so a `keydown` listener in the renderer owns it (the shell's
 *   ⌘J, the palette's ⌘K, the object search's ⌘P, the snippet library's ⌥⌘S). These must avoid every
 *   registered accelerator, or the menu wins and the listener never runs — which is exactly what
 *   happened to the Angular snippet library's ⇧⌘S, sitting on top of File ▸ Save Query As.
 * - `editor` — Monaco binds the key itself and nothing registers it: either `menu.ts` shows it with
 *   `registerAccelerator: false` (⌘E, ⌘A), or no menu item carries it at all (the editor's ⌃M).
 */
export type AcceleratorSource = 'menu' | 'renderer' | 'editor';

export interface Accelerator {
  readonly source: AcceleratorSource;
  /** The binding to show as the hint when there is only room for one. */
  readonly keys: AcceleratorKeys;
  /**
   * Further bindings that reach the same command. Two menu items really do send one channel: File ▸
   * New Connection (⇧⌘N) and Server ▸ Connect… (⇧⌘C) both send `menu:new-connection`, and the
   * cheatsheet has to list both or it is lying about one of them. `catalogue.spec.ts` compares the
   * whole set against `menu.ts`, so an alternate that disappears from the menu fails there.
   */
  readonly alternates?: readonly AcceleratorKeys[];
}

/**
 * The palette does NOT list this command, and why not in words.
 *
 * Its own type rather than an arm of a union, because it is the only shape a payload-carrying
 * command's `palette` field may have — see `CatalogueEntry`.
 */
export interface HiddenFromPalette {
  readonly show: false;
  readonly because: string;
}

/** The palette lists this command. Only a payload-free command may say so. */
export interface ShownInPalette {
  readonly show: true;
  /**
   * What must be true for the entry to be actionable. Absent means "always". A requirement that is
   * not met renders the row **disabled with the reason**, never hidden — a palette that silently
   * omits half its entries is the reason people stop trusting it.
   */
  readonly requires?: PaletteRequirement;
}

/** How the palette treats a command. */
export type PaletteVisibility = ShownInPalette | HiddenFromPalette;

/**
 * The preconditions a palette entry can state. Deliberately a tiny closed set: each one is evaluated
 * in `features/command-palette/palette-model.ts` against live state, and an open-ended predicate per
 * entry is how the Angular palette ended up with `isEnabled` closures that disagreed with each other
 * (`hasAnyConnection` on Backup, nothing at all on Cancel Query).
 */
export type PaletteRequirement =
  /** At least one live connection. */
  | 'connection'
  /** A query tab is the active tab — the commands the query surface only handles when it is. */
  | 'query-tab'
  /** The active query tab has finished results on screen. */
  | 'results';

export interface CommandDisplay {
  /** Sentence case, no trailing punctuation, no "…" — the palette is not a menu. */
  readonly label: string;
  /** One line, and it must say something the label does not. */
  readonly hint: string;
  readonly group: CommandGroup;
  readonly icon: LucideIcon;
  readonly accelerator: Accelerator | null;
  readonly palette: PaletteVisibility;
  /** Extra words that should match this entry. The label and hint are already searched. */
  readonly keywords?: readonly string[];
}

/**
 * One catalogue entry, **narrowed by the id it is filed under**.
 *
 * The whole point is the conditional on `palette`: a command whose payload is not `void` can only be
 * `HiddenFromPalette`, so `palette: { show: true }` on `insert-snippet` or `backup-database` is a
 * compile error rather than a row that dispatches `undefined` into a handler expecting data.
 * `dispatchCommand` refuses a bare `CommandId` (`bus.ts`'s overloads), so the palette must hold
 * `PayloadlessCommandId` — this is what makes that provable from the catalogue instead of asserted by
 * a spec.
 */
export type CatalogueEntry<Id extends CommandId> = Omit<CommandDisplay, 'palette'> & {
  readonly palette: Id extends PayloadlessCommandId ? PaletteVisibility : HiddenFromPalette;
};

/** Shorthand for the accelerators `menu.ts` registers. */
const menuKey = (keys: AcceleratorKeys, ...alternates: AcceleratorKeys[]): Accelerator =>
  alternates.length === 0 ? { source: 'menu', keys } : { source: 'menu', keys, alternates };
/** Shorthand for the ones a renderer `keydown` owns. */
const rendererKey = (keys: AcceleratorKeys): Accelerator => ({ source: 'renderer', keys });

/** In the palette, with no precondition. */
const IN_PALETTE: ShownInPalette = { show: true };
/** In the palette, greyed with a reason until something is connected. */
const NEEDS_CONNECTION: ShownInPalette = { show: true, requires: 'connection' };
/** In the palette, greyed until a query tab is in front. */
const NEEDS_QUERY_TAB: ShownInPalette = { show: true, requires: 'query-tab' };

/**
 * The reason every *payload-carrying* command is absent, stated once.
 *
 * A palette entry has no target: the user typed a phrase, not a node. `backup-database` and its
 * siblings exist precisely to carry a target the sidebar knows and the menu does not
 * (`registry.ts`'s sidebar section), and most of them have a payload-free twin the palette uses
 * instead — `open-backup-dialog` resolves the target from `mostRecentConnectionId()`.
 *
 * Two do not, and the `because` text below is worded to stay true of them: J-104 removed the
 * sidebar items that produced `delete-database` and `show-object-properties`, so those two have
 * neither a producer nor a twin until their surfaces ship. The reason the palette skips them is
 * unchanged and is the one stated here — a phrase cannot name a node — which is why the entries
 * stay put rather than being reworded per id.
 *
 * This is a *reason*, not the enforcement: `CatalogueEntry` is what makes any other answer for these
 * ids fail to compile.
 */
const NEEDS_A_TARGET: HiddenFromPalette = {
  show: false,
  because:
    'carries a target the palette cannot supply — a palette entry is a phrase the user typed, ' +
    'not a node',
};

/** Not a user action at all: a notification between two surfaces. */
const NOT_A_USER_ACTION = (what: string): HiddenFromPalette => ({ show: false, because: what });

export const COMMAND_CATALOGUE: { [Id in CommandId]: CatalogueEntry<Id> } = {
  // ── File and tabs ─────────────────────────────────────────────────────────────────────────
  'open-connection-dialog': {
    label: 'New connection',
    hint: 'Set up a new server connection',
    group: 'connection',
    icon: Plus,
    // Two menu items, one channel: File ▸ New Connection and Server ▸ Connect… (menu.ts:46,233).
    accelerator: menuKey('CmdOrCtrl+Shift+N', 'CmdOrCtrl+Shift+C'),
    palette: IN_PALETTE,
    keywords: ['add', 'server', 'profile'],
  },
  'new-query': {
    label: 'New query tab',
    hint: 'Open an empty SQL editor on the current database',
    group: 'file',
    icon: Code,
    accelerator: menuKey('CmdOrCtrl+N'),
    palette: IN_PALETTE,
  },
  'open-query-file': {
    label: 'Open query file',
    hint: 'Load a .sql file from disk',
    group: 'file',
    icon: FileCode,
    accelerator: menuKey('CmdOrCtrl+O'),
    palette: IN_PALETTE,
    keywords: ['sql', 'file', 'import'],
  },
  'close-active-tab': {
    label: 'Close tab',
    hint: 'Close the tab in front',
    group: 'file',
    icon: X,
    accelerator: menuKey('CmdOrCtrl+W'),
    palette: IN_PALETTE,
  },
  'save-query': {
    label: 'Save query',
    hint: 'Write the active editor back to its file',
    group: 'file',
    icon: Save,
    accelerator: menuKey('CmdOrCtrl+S'),
    palette: NEEDS_QUERY_TAB,
  },
  'save-query-as': {
    label: 'Save query as',
    hint: 'Write the active editor to a new file',
    group: 'file',
    icon: SaveAll,
    accelerator: menuKey('CmdOrCtrl+Shift+S'),
    palette: NEEDS_QUERY_TAB,
  },
  'export-results': {
    label: 'Export results',
    hint: 'Write the rows on screen to a file',
    group: 'query',
    icon: Download,
    accelerator: menuKey('CmdOrCtrl+Shift+X'),
    palette: { show: true, requires: 'results' },
    keywords: ['csv', 'json', 'download'],
  },

  // ── Editor ────────────────────────────────────────────────────────────────────────────────
  'editor-find': {
    label: 'Find in editor',
    hint: "Open Monaco's find widget",
    group: 'editor',
    icon: Search,
    accelerator: menuKey('CmdOrCtrl+F'),
    palette: NEEDS_QUERY_TAB,
  },
  'editor-replace': {
    label: 'Find and replace',
    hint: "Open Monaco's replace widget",
    group: 'editor',
    icon: Replace,
    accelerator: menuKey({ mac: 'Cmd+Option+F', other: 'Ctrl+H' }),
    palette: NEEDS_QUERY_TAB,
  },
  'format-sql': {
    label: 'Format SQL',
    hint: 'Re-indent the active editor for its engine',
    group: 'editor',
    icon: WandSparkles,
    accelerator: menuKey('CmdOrCtrl+Shift+F'),
    palette: NEEDS_QUERY_TAB,
    keywords: ['pretty', 'beautify', 'indent'],
  },
  'convert-sql-to-mssql': {
    label: 'Convert SQL to SQL Server',
    hint: 'Rewrite the editor’s SQL in T-SQL',
    group: 'editor',
    icon: Languages,
    accelerator: null,
    palette: NEEDS_QUERY_TAB,
    keywords: ['translate', 'dialect', 'tsql', 'mssql'],
  },
  'convert-sql-to-postgresql': {
    label: 'Convert SQL to PostgreSQL',
    hint: 'Rewrite the editor’s SQL for Postgres',
    group: 'editor',
    icon: Languages,
    accelerator: null,
    palette: NEEDS_QUERY_TAB,
    keywords: ['translate', 'dialect', 'postgres', 'pg'],
  },
  'convert-sql-to-mysql': {
    label: 'Convert SQL to MySQL',
    hint: 'Rewrite the editor’s SQL for MySQL',
    group: 'editor',
    icon: Languages,
    accelerator: null,
    palette: NEEDS_QUERY_TAB,
    keywords: ['translate', 'dialect', 'mysql', 'maria'],
  },
  'toggle-comment': {
    label: 'Toggle comment',
    hint: 'Comment or uncomment the selected lines',
    group: 'editor',
    icon: Slash,
    accelerator: menuKey('CmdOrCtrl+/'),
    palette: NEEDS_QUERY_TAB,
  },

  // ── Query ─────────────────────────────────────────────────────────────────────────────────
  'execute-query': {
    label: 'Execute query',
    hint: 'Run everything in the active editor',
    group: 'query',
    icon: Play,
    // Shown in the menu, bound by Monaco: `registerAccelerator: false` at menu.ts:192.
    accelerator: { source: 'editor', keys: 'CmdOrCtrl+E' },
    palette: NEEDS_QUERY_TAB,
    keywords: ['run', 'go'],
  },
  'execute-selection': {
    label: 'Execute selection',
    hint: 'Run only the highlighted SQL',
    group: 'query',
    icon: SquareTerminal,
    accelerator: menuKey({ mac: 'Cmd+Shift+Return', other: 'Ctrl+Shift+E' }),
    palette: NEEDS_QUERY_TAB,
  },
  'cancel-query': {
    label: 'Cancel query',
    hint: 'Stop the run in progress',
    group: 'query',
    icon: Ban,
    accelerator: menuKey({ mac: 'Cmd+.', other: 'Alt+Break' }),
    palette: NEEDS_QUERY_TAB,
    keywords: ['stop', 'abort', 'kill'],
  },
  'open-query-history': {
    label: 'Query history',
    hint: 'Search everything this app has executed',
    group: 'query',
    icon: Clock,
    accelerator: menuKey('CmdOrCtrl+Shift+H'),
    palette: IN_PALETTE,
    keywords: ['recent', 'past', 'log'],
  },
  'results-row-open': {
    label: 'Inspect row',
    hint: 'Open the row-detail rail on the focused row',
    group: 'query',
    icon: MousePointer,
    accelerator: null,
    palette: { show: true, requires: 'results' },
    keywords: ['detail', 'record', 'inspector'],
  },

  // ── Connections ───────────────────────────────────────────────────────────────────────────
  'disconnect-connection': {
    label: 'Disconnect',
    hint: 'Close the focused server connection',
    group: 'connection',
    icon: Unplug,
    accelerator: null,
    palette: NEEDS_CONNECTION,
  },
  'refresh-explorer': {
    label: 'Refresh explorer',
    hint: 'Re-read databases and the selected node',
    group: 'connection',
    icon: RefreshCw,
    accelerator: menuKey('CmdOrCtrl+R'),
    palette: NEEDS_CONNECTION,
    keywords: ['reload'],
  },
  'show-server-properties': {
    label: 'Server properties',
    hint: 'Version, edition and collation of the focused server',
    group: 'connection',
    icon: Info,
    accelerator: null,
    palette: NEEDS_CONNECTION,
  },
  'open-connection-manager': {
    label: 'Manage connections',
    hint: 'Edit, connect and delete saved profiles',
    group: 'connection',
    icon: Plug,
    accelerator: null,
    palette: IN_PALETTE,
    keywords: ['profiles', 'servers'],
  },

  // ── Databases ─────────────────────────────────────────────────────────────────────────────
  'create-database': {
    label: 'New database',
    hint: 'Create a database on the focused server',
    group: 'database',
    icon: DatabasePlus,
    accelerator: null,
    palette: NEEDS_CONNECTION,
  },
  'open-backup-dialog': {
    label: 'Back up database',
    hint: 'Write a backup of the current database',
    group: 'database',
    icon: DatabaseBackup,
    accelerator: null,
    palette: NEEDS_CONNECTION,
    keywords: ['dump', 'export'],
  },
  'open-restore-dialog': {
    label: 'Restore database',
    hint: 'Restore a backup file into a database',
    group: 'database',
    icon: HardDriveDownload,
    accelerator: null,
    palette: NEEDS_CONNECTION,
    keywords: ['import', 'recover'],
  },
  'show-database-properties': {
    label: 'Database properties',
    hint: 'Size, collation and file layout of the current database',
    group: 'database',
    icon: Database,
    accelerator: null,
    palette: NEEDS_CONNECTION,
  },

  // ── View ──────────────────────────────────────────────────────────────────────────────────
  'show-welcome': {
    label: 'Show welcome tab',
    hint: 'Open the start page',
    group: 'view',
    icon: House,
    accelerator: null,
    palette: IN_PALETTE,
  },
  'toggle-sidebar': {
    label: 'Toggle sidebar',
    hint: 'Show or hide the object explorer',
    group: 'view',
    icon: PanelLeft,
    accelerator: menuKey('CmdOrCtrl+\\'),
    palette: IN_PALETTE,
  },
  'toggle-chat-panel': {
    label: 'Toggle assistant',
    hint: 'Show or hide the AI side panel',
    group: 'view',
    icon: Sparkles,
    accelerator: menuKey('CmdOrCtrl+Shift+I'),
    palette: IN_PALETTE,
    keywords: ['ai', 'chat'],
  },
  'open-chat-tab': {
    label: 'Open assistant as a tab',
    hint: 'A full-width chat in the dock, with its own conversation',
    group: 'view',
    icon: MessageSquare,
    accelerator: null,
    palette: IN_PALETTE,
    keywords: ['ai', 'chat', 'assistant', 'tab'],
  },
  'toggle-results-panel': {
    label: 'Toggle results panel',
    hint: 'Collapse or restore the rows below the editor',
    group: 'view',
    icon: PanelBottom,
    accelerator: menuKey('CmdOrCtrl+Shift+\\'),
    palette: NEEDS_QUERY_TAB,
  },
  'toggle-output-panel': {
    label: 'Toggle output panel',
    hint: "Show or hide the app's own log",
    group: 'view',
    icon: Terminal,
    // No menu item — the shell binds this one itself (`app-shell.tsx`).
    accelerator: rendererKey('CmdOrCtrl+J'),
    palette: IN_PALETTE,
    keywords: ['console', 'logs', 'diagnostics'],
  },
  'next-tab': {
    label: 'Next tab',
    hint: 'Move one tab to the right',
    group: 'view',
    icon: ChevronRight,
    accelerator: menuKey({ mac: 'Cmd+Shift+]', other: 'Ctrl+Tab' }),
    palette: IN_PALETTE,
  },
  'previous-tab': {
    label: 'Previous tab',
    hint: 'Move one tab to the left',
    group: 'view',
    icon: ChevronLeft,
    accelerator: menuKey({ mac: 'Cmd+Shift+[', other: 'Ctrl+Shift+Tab' }),
    palette: IN_PALETTE,
  },

  // ── Settings and help ─────────────────────────────────────────────────────────────────────
  'open-settings': {
    label: 'Settings',
    hint: 'Appearance, editor, query and grid preferences',
    group: 'settings',
    icon: Settings,
    accelerator: menuKey('CmdOrCtrl+,'),
    palette: IN_PALETTE,
    keywords: ['preferences', 'options', 'theme'],
  },
  'start-tour': {
    label: 'Start the guided tour',
    hint: 'A walk through the workbench, one surface at a time',
    group: 'help',
    icon: Compass,
    accelerator: null,
    palette: IN_PALETTE,
    keywords: ['tour', 'onboarding', 'walkthrough', 'help'],
  },
  'open-ai-setup': {
    label: 'Set up AI',
    hint: 'Choose a provider, save its API key, pick the model',
    group: 'settings',
    icon: Sparkles,
    accelerator: null,
    palette: IN_PALETTE,
    keywords: ['ai', 'api key', 'provider', 'model', 'gemini', 'openai', 'anthropic'],
  },
  'show-shortcuts': {
    label: 'Keyboard shortcuts',
    hint: 'Every binding this app has, in one sheet',
    group: 'help',
    icon: Keyboard,
    accelerator: menuKey('CmdOrCtrl+Shift+/'),
    palette: IN_PALETTE,
    keywords: ['keys', 'cheatsheet', 'bindings'],
  },
  'open-object-search': {
    label: 'Find database object',
    hint: 'Fuzzy-search tables, views, procedures and functions',
    group: 'view',
    icon: Locate,
    accelerator: rendererKey('CmdOrCtrl+P'),
    palette: NEEDS_CONNECTION,
    keywords: ['table', 'view', 'goto', 'jump'],
  },
  'open-snippets': {
    label: 'Snippet library',
    hint: 'Save, search and insert reusable SQL',
    group: 'query',
    icon: Bookmark,
    // NOT ⇧⌘S, which the Angular library claimed: File ▸ Save Query As registers that accelerator,
    // so Electron fired the menu item and the library's own listener never ran.
    accelerator: rendererKey({ mac: 'Cmd+Option+S', other: 'Ctrl+Alt+S' }),
    palette: IN_PALETTE,
    keywords: ['snippets', 'templates', 'saved'],
  },

  'show-execution-plan': {
    label: 'Show execution plan',
    // "would run" was a lie on one of the three engines: SQL Server reports a plan only for a statement
    // it has RUN (`features/query/execution-plan.ts`), so the palette promised a free look at something
    // that executes. The hint covers both cases the way the toolbar's tooltip does, and names the
    // confirmation so the honest version does not read as a warning with no way out.
    hint: 'Ask the engine how it runs this statement — on SQL Server that runs it, and you are asked first',
    group: 'query',
    icon: Workflow,
    accelerator: null,
    palette: NEEDS_QUERY_TAB,
    keywords: ['explain', 'plan', 'analyze', 'cost', 'index'],
  },
  'open-docker-panel': {
    label: 'Docker containers',
    hint: 'Start, stop and create local database containers',
    group: 'view',
    icon: Container,
    accelerator: null,
    palette: IN_PALETTE,
    keywords: ['docker', 'container', 'local', 'sql server', 'postgres', 'mysql'],
  },
  'open-erd': {
    label: 'Open ERD diagram',
    hint: 'Entity-relationship diagram for the current database',
    group: 'view',
    icon: Network,
    accelerator: null,
    palette: NEEDS_CONNECTION,
    keywords: ['diagram', 'relationships', 'schema', 'graph'],
  },
  'open-schema-diff': {
    label: 'Compare database schemas',
    // What it DOES, which is not what its name suggests: it writes a comparison query into a new query
    // tab and the user runs it. The audit's note about keeping this naming honest is the reason the hint
    // says "query" — an entry promising a diff and delivering SQL is the same class of lie as a dead
    // palette row, just harder to notice.
    hint: 'Generate a query that compares two databases’ tables, views, routines and indexes',
    group: 'database',
    icon: GitCompare,
    accelerator: null,
    palette: NEEDS_CONNECTION,
    keywords: ['diff', 'compare', 'schema', 'query'],
  },

  // ── Not palette entries ───────────────────────────────────────────────────────────────────
  'menu-copy': {
    label: 'Copy',
    hint: 'Copy the selection, or the selected grid cells',
    group: 'editor',
    icon: Copy,
    accelerator: menuKey('CmdOrCtrl+C'),
    palette: NOT_A_USER_ACTION(
      'a claim protocol for the ⌘C keystroke, not an action — the palette cannot be the thing with ' +
        'the selection, because opening it took the focus'
    ),
  },
  'cursor-position': {
    label: 'Cursor moved',
    hint: 'The editor telling the status bar where the caret is',
    group: 'editor',
    icon: MousePointer,
    accelerator: null,
    palette: NOT_A_USER_ACTION('a notification from the editor to the status bar'),
  },
  'insert-snippet': {
    label: 'Insert snippet',
    hint: 'Paste a saved snippet into the active editor',
    group: 'query',
    icon: ClipboardPaste,
    accelerator: null,
    palette: NOT_A_USER_ACTION(
      'carries the SQL to insert — the snippet library is the surface that chooses which, and the ' +
        'palette opens THAT (`open-snippets`)'
    ),
  },

  // The sidebar's eight targeted commands. One reason, stated once (`NEEDS_A_TARGET`).
  'edit-connection': {
    label: 'Edit connection',
    hint: 'Open the editor on a saved profile',
    group: 'connection',
    icon: Pencil,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'create-database-on-server': {
    label: 'New database on this server',
    hint: 'Create a database on a named server',
    group: 'database',
    icon: DatabasePlus,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'backup-database': {
    label: 'Back up this database',
    hint: 'Back up a named database',
    group: 'database',
    icon: DatabaseBackup,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'restore-database': {
    label: 'Restore into this server',
    hint: 'Restore a backup into a named server',
    group: 'database',
    icon: HardDriveDownload,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'rename-database': {
    label: 'Rename this database',
    hint: 'Rename a named database',
    group: 'database',
    icon: Pencil,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'delete-database': {
    label: 'Delete this database',
    hint: 'Drop a named database',
    group: 'database',
    icon: Trash2,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'compare-database-schemas': {
    label: 'Compare schemas from here',
    hint: 'Generate a comparison query with this database as the source',
    group: 'database',
    icon: GitCompare,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'connect-to-container': {
    label: 'Connect to this container',
    hint: 'Open the connection editor with the container’s host and port filled in',
    group: 'connection',
    icon: Container,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'show-object-properties': {
    label: 'Object properties',
    hint: 'Columns, keys and indexes of a named object',
    group: 'database',
    icon: Table2,
    // No keystroke, because nothing binds one. All four Angular Properties… items advertised ⌥↩
    // (`sidebar.component.ts:1364,1492,1573,1675`) and neither a menu item nor a renderer keydown
    // handler ever claimed it; J-104 then removed the items themselves. Plain ↩ is not a
    // substitute either: on an object row the tree activates the node into its object DETAIL tab
    // (`shell/sidebar/explorer-tree.tsx:216-225`), a different surface reached by a different path.
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
  'reveal-explorer-node': {
    label: 'Reveal in explorer',
    hint: 'Expand the tree down to a named object and scroll to it',
    group: 'view',
    icon: Layers,
    accelerator: null,
    palette: NEEDS_A_TARGET,
  },
};

/**
 * Every command the palette lists, in catalogue order. Derived — never hand-maintained.
 *
 * `PayloadlessCommandId`, not `CommandId`, and the narrowing is sound rather than hopeful: the only
 * ids whose entry can say `show: true` are the payload-free ones (`CatalogueEntry`), so the predicate
 * below cannot answer true for an id that needs a payload. It is the one place in the package that
 * needs to know this, which is why callers — `palette-model.ts` above all — hold no cast of their own.
 */
export function paletteCommandIds(): readonly PayloadlessCommandId[] {
  return (Object.keys(COMMAND_CATALOGUE) as CommandId[]).filter(isPaletteVisible);
}

function isPaletteVisible(id: CommandId): id is PayloadlessCommandId {
  return COMMAND_CATALOGUE[id].palette.show;
}

// ── Rendering an accelerator ─────────────────────────────────────────────────────────────────

/**
 * Electron's modifier and key names → what a Mac keyboard prints on its keys. Non-Mac keeps the
 * words and joins them with `+`, which is the platform convention there (`utils/platform.ts` makes
 * the same choice for its one-key hints).
 */
const MAC_GLYPHS: Record<string, string> = {
  CmdOrCtrl: '⌘',
  Cmd: '⌘',
  Command: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Shift: '⇧',
  Alt: '⌥',
  Option: '⌥',
  Return: '↩',
  Enter: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
};

/** The macOS modifier order, so ⇧⌘K never renders as ⌘⇧K. */
const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘'];

/**
 * The Electron modifiers that really are Ctrl off macOS. Accelerators are written in Electron's
 * vocabulary, but a cheat-sheet row must print the key the user presses, not the spelling the
 * binding happens to use — `CmdOrCtrl+Shift+N` is a Windows keystroke nobody can type.
 *
 * Bare `Cmd` and `Command` are deliberately absent. They are macOS-only: off macOS Electron does not
 * register them at all, so printing `Ctrl` for one would advertise a key that does nothing — the
 * same class of lie this mapping exists to remove. A binding that needs a real non-macOS key says so
 * with a `{ mac, other }` split, and `docs-site/scripts/lib/command-model.mjs` throws if one reaches
 * the Windows column without it.
 */
const NON_MAC_CTRL_ALIASES = new Set(['CmdOrCtrl', 'CommandOrControl', 'Control', 'Ctrl']);

/** The keys for this platform, out of a spec that may branch. */
export function acceleratorKeysForPlatform(keys: AcceleratorKeys): string {
  if (typeof keys === 'string') return keys;
  return IS_MAC ? keys.mac : keys.other;
}

/**
 * One accelerator as the user sees it: `'CmdOrCtrl+Shift+N'` → `⇧⌘N` on macOS, `Ctrl+Shift+N`
 * elsewhere.
 *
 * Modifiers are re-ordered on macOS because the platform prints them in a fixed order regardless of
 * how the accelerator was written; the final key keeps its position at the end. A single-character
 * key is upper-cased (`'k'` → `K`), which is how every Mac menu renders it.
 */
export function formatAccelerator(accelerator: Accelerator | null): string | null {
  if (accelerator === null) return null;
  const parts = acceleratorKeysForPlatform(accelerator.keys).split('+');
  if (parts.length === 0) return null;

  if (!IS_MAC) {
    return parts
      .map(part => {
        if (NON_MAC_CTRL_ALIASES.has(part)) return 'Ctrl';
        return part.length === 1 ? part.toUpperCase() : part;
      })
      .join('+');
  }

  const glyphs = parts.map(
    part => MAC_GLYPHS[part] ?? (part.length === 1 ? part.toUpperCase() : part)
  );
  const modifiers = glyphs.filter(glyph => MAC_MODIFIER_ORDER.includes(glyph));
  const rest = glyphs.filter(glyph => !MAC_MODIFIER_ORDER.includes(glyph));
  modifiers.sort(
    (left, right) => MAC_MODIFIER_ORDER.indexOf(left) - MAC_MODIFIER_ORDER.indexOf(right)
  );
  return [...modifiers, ...rest].join('');
}

/**
 * Every binding of one accelerator, formatted — the primary first, then any alternates. Empty when
 * there is no binding at all.
 */
export function formatAcceleratorList(accelerator: Accelerator | null): readonly string[] {
  if (accelerator === null) return [];
  const all = [accelerator.keys, ...(accelerator.alternates ?? [])];
  return all
    .map(keys => formatAccelerator({ source: accelerator.source, keys }))
    .filter((formatted): formatted is string => formatted !== null);
}

/**
 * The accelerator hint for one command, ready to render. `null` when the command has no binding.
 *
 * The PRIMARY binding only: a palette row has room for one keystroke, and showing two would make the
 * row about its shortcut rather than about the command. The cheatsheet shows the full set.
 */
export function commandAccelerator(id: CommandId): string | null {
  return formatAccelerator(COMMAND_CATALOGUE[id].accelerator);
}
