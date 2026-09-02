/**
 * The command registry: every inter-feature message in the renderer, and its payload type.
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────
 *
 * The Angular renderer's real inter-feature bus was `window.dispatchEvent(new
 * CustomEvent('joinery:…'))` — untyped, unregistered, and unenforced. PLAN.md 0.4 counted the
 * damage: sixteen distinct event names dispatched, only six of them with a listener anywhere in
 * the app, so ten command-palette entries did nothing at all when clicked and no compiler, test or
 * review step could tell. A `CustomEvent`'s `detail` is `any`; the palette dispatched
 * `joinery:open-backup` for months against a listener that never existed.
 *
 * ── Why the dead ones are not here ──────────────────────────────────────────────────────────
 *
 * Porting the ten dead dispatches as registry entries would reproduce exactly the property that
 * made them dead: an id nothing handles, indistinguishable from an id something handles. So this
 * file lists the six channels that had a live producer AND a live consumer in the Angular app, and
 * `COMMAND_CONSUMERS` below is a `Record` over the id union — adding a command without naming who
 * handles it does not compile. Task 16 adds the palette's commands as it wires their handlers, one
 * entry per handler, which is the point: the dead-command class of bug cannot recur, because the
 * only way to add a command is to name its consumer.
 *
 * Ids keep the DOM event names (minus the `joinery:` prefix) so the mapping back to the audit is
 * one-to-one and greppable.
 *
 * ── Adding a command ───────────────────────────────────────────────────────────────────────
 *
 * 1. add the id and its payload type to `CommandPayloads`;
 * 2. add its consumer to `COMMAND_CONSUMERS` (the compiler will insist);
 * 3. subscribe with `useCommand` in the component that handles it.
 */

export interface CommandPayloads {
  // ── The native menu (Task 7) ───────────────────────────────────────────────────────────────
  //
  // `packages/preload/src/index.ts` exposes 30 `menu.on*` channels (31 at Task 7, counted in the
  // file and cross-checked against the 31 subscriptions in the Angular `menu.service.ts` — the
  // task brief's "34" is a miscount, recorded in the Task 7 report; J-92 added one and J-104
  // removed the two dead Properties channels). Every one of them is subscribed by
  // `shell/menu-bridge.tsx` and routed to exactly one command below, so the bridge is a
  // translation table and the question "what does this menu item do?" is answered by grepping one
  // id. `menu-copy` is the only channel with logic in the bridge, because it is the only one with
  // a claim-and-fall-back protocol.
  //
  // The accelerator in each comment below is the one `packages/main/src/menu.ts` actually
  // registers, and that file is the source of truth — Phase B reads these annotations when it
  // renders a shortcut hint, so a drifted one becomes a wrong label in the UI. They are comments
  // rather than data because the renderer may not import from `packages/main`; the mechanical
  // check is a re-read of `menu.ts` whenever a binding moves.
  //
  // Several of these consumers land in a later task, which is the same shape the six original
  // entries already had (`insert-snippet` → Task 10). What the registry enforces is that a
  // consumer is NAMED, not that it exists yet: the alternative — leaving the channel unsubscribed
  // until its surface arrives — is exactly the untracked-dead-menu-item state the audit found.

  /** File ▸ New Connection. The first of 0.1's three broken items. */
  'open-connection-dialog': void;
  /** File ▸ New Query (⌘N). Always a fresh tab, per `menu.service.ts:308-327`. */
  'new-query': void;
  /** File ▸ Open Query. Loads a .sql file into the active query tab, or into a new one. */
  'open-query-file': void;
  /** File ▸ Close Tab (⌘W). */
  'close-active-tab': void;
  /** File ▸ Save Query (⌘S). */
  'save-query': void;
  /** File ▸ Save Query As (⇧⌘S). */
  'save-query-as': void;
  /** File ▸ Export Results. */
  'export-results': void;

  /** Edit ▸ Find (⌘F). */
  'editor-find': void;
  /** Edit ▸ Replace (⌥⌘F). */
  'editor-replace': void;
  /** Edit ▸ Format SQL (⇧⌘F). */
  'format-sql': void;
  /** Edit ▸ Toggle Comment (⌘/). */
  'toggle-comment': void;

  // ── The SQL dialect converter (Task 19a) ───────────────────────────────────────────────────
  //
  // Three payload-free ids rather than one `convert-sql: { toEngine }`, and the reason is the palette:
  // `CatalogueEntry` narrows a payload-carrying command to "hidden from the palette", so a single
  // parameterised id would have been reachable only from the toolbar menu — which is exactly the Angular
  // state (a `translate` menu and nothing else). The Angular menu had three items too.
  //
  // No menu channel: `main/src/menu.ts` has no Convert entry, so these arrive from the palette or from the
  // query toolbar's own menu. The toolbar menu calls the handler directly, as every other button in that
  // strip does — see `query-toolbar.tsx`.

  /** Convert the active editor's SQL to T-SQL. */
  'convert-sql-to-mssql': void;
  /** Convert the active editor's SQL to PostgreSQL. */
  'convert-sql-to-postgresql': void;
  /** Convert the active editor's SQL to MySQL. */
  'convert-sql-to-mysql': void;

  /** Query ▸ Execute (⌘E — `registerAccelerator: false`, so Task 10's editor owns the keystroke). */
  'execute-query': void;
  /** Query ▸ Execute Selection (⇧⌘↩). */
  'execute-selection': void;
  /** Query ▸ Cancel (⌘.). */
  'cancel-query': void;
  /** Query ▸ History (⇧⌘H). */
  'open-query-history': void;

  /**
   * Ask the engine for the active statement's execution plan (Task 19b).
   *
   * No menu channel: `menu.ts` has no plan entry, so this arrives from the palette or from the query
   * toolbar's own button — the same arrangement as the converter's three above. It is payload-free
   * BECAUSE the palette has to be able to offer it: the engine is read from the tab, not from the
   * command, and the tab is what the active-tab guard already resolves.
   */
  'show-execution-plan': void;

  /** Server ▸ Disconnect. */
  'disconnect-connection': void;
  /** Server ▸ Refresh (⌘R). */
  'refresh-explorer': void;
  /**
   * The server-properties surface. Registered, unowned, and — since J-104 — with no producer
   * either: Server ▸ Properties… was removed from the native menu because nothing subscribes to
   * this id. The palette still offers it as a visibly not-wired row.
   */
  'show-server-properties': void;

  /** Database ▸ New Database. */
  'create-database': void;
  /** Database ▸ Backup. The second of 0.1's three broken items. */
  'open-backup-dialog': void;
  /** Database ▸ Restore. The third of 0.1's three broken items. */
  'open-restore-dialog': void;
  /** The database-properties surface. Registered, unowned and producerless, as its server twin. */
  'show-database-properties': void;

  /** View ▸ Welcome. */
  'show-welcome': void;
  /** View ▸ Toggle Sidebar (⌘\). */
  'toggle-sidebar': void;
  /** View ▸ Toggle AI Chat (⇧⌘I). */
  'toggle-chat-panel': void;
  /**
   * Open the assistant as a dock tab. No menu item and no keystroke: the Angular app could only
   * reach the chat tab from the ⧉ button inside the side panel, so the palette had no way to open
   * one at all. The panel button stays (it carries the CURRENT conversation across, which a palette
   * entry cannot); this is the targetless twin that opens a fresh one.
   */
  'open-chat-tab': void;
  /** View ▸ Toggle Results. */
  'toggle-results-panel': void;
  /** The Output / Console panel (⌘J). Not a menu channel — the shell's own shortcut. */
  'toggle-output-panel': void;

  /**
   * Open the Docker container panel over the status bar's Docker pip (Task 19b).
   *
   * The Angular renderer could only reach that panel by clicking the pip, so a user who did not know the
   * glyph was a button never found it. This is the discoverable twin, and it is the same arrangement
   * `toggle-chat-panel` has: the pip calls the store directly (it carries no intent beyond "toggle"),
   * this opens it.
   */
  'open-docker-panel': void;

  /** Window ▸ Next Tab (⇧⌘] on macOS, Ctrl+Tab elsewhere). */
  'next-tab': void;
  /** Window ▸ Previous Tab (⇧⌘[ on macOS, ⌃⇧⇥ elsewhere). */
  'previous-tab': void;

  /** Joinery ▸ Settings (⌘,). */
  'open-settings': void;

  /**
   * The AI setup dialog — provider, API key, model, feature switches (Task 19a; J-55).
   *
   * No menu channel: `menu.ts` has no AI item, so this is a palette / welcome-tab / chat-empty-state
   * entry point only, in the same class as `open-snippets` and `open-object-search`.
   */
  'open-ai-setup': void;

  /**
   * Start the guided tour (Task 19b's onboarding surface).
   *
   * Registered here with its owner named and NOT yet subscribed, which is the state `bus.spec.tsx`'s
   * ownership rule allows and the welcome tab is built for: its "See how it joins" button dispatches
   * this, checks `handlerCount` first, and says so when nobody answered. The moment 19b mounts a handler
   * the button becomes live with no edit to the welcome tab.
   */
  'start-tour': void;

  // ── The sidebar's dialog entry points (Task 8) ─────────────────────────────────────────────
  //
  // Eight ids, and every one of them is the *targeted* twin of something above. The native menu
  // carries no data, so `open-backup-dialog` and friends have to resolve their target from focus;
  // a right-click on a database node under server A knows exactly which database on which server
  // it means, and the Angular sidebar spent an `overrideConnectionId` parameter on every one of
  // these saying so (`sidebar.component.ts:932,976,1146-1228`) precisely because resolving from
  // focus routed the operation to the wrong server. A payload states it instead of a nullable
  // parameter defaulting to a global, which is the whole difference.
  //
  // An id whose owner has not shipped yet has no handler, and that is legal (see `bus.spec.ts`'s
  // ownership rule): dispatching one warns in DEV with the owner named below, which is the designed
  // feedback for a surface that has not arrived. Tasks 9 and 12 have since added theirs — and changed
  // no sidebar code doing it, which was the point of the payload. Tasks 13/19 own the rest.

  /** Sidebar ▸ Connections ▸ Manage Connections. */
  'open-connection-manager': void;
  /** Sidebar ▸ server node ▸ Edit Connection… — the editor opened on an existing profile. */
  'edit-connection': { connectionId: string };
  /**
   * The connection editor opened on a NEW profile, pre-filled with a Docker container's host and port
   * (Task 19b's Docker panel).
   *
   * `ConnectionEditor` has carried a `prefill` prop since Task 9 with a comment naming this entry point,
   * and nothing passed it — the Angular route was `router.navigate(['/connections'], { queryParams: {
   * server, port } })`, which has no equivalent in a renderer with no router. This is that equivalent.
   */
  'connect-to-container': { server: string; port: number };

  /** Sidebar ▸ server node ▸ New Database… */
  'create-database-on-server': { connectionId: string };
  /** Sidebar ▸ database node ▸ Backup Database… */
  'backup-database': { connectionId: string; databaseName: string };
  /**
   * Sidebar ▸ Restore Database… A restore *creates* its target, so the server node offers it with
   * no database name — which is why this one field is optional and the backup twin's is not.
   */
  'restore-database': { connectionId: string; databaseName?: string };
  /** Sidebar ▸ database node ▸ Rename… */
  'rename-database': { connectionId: string; databaseName: string };
  /**
   * A drop-database confirmation (the confirm step belongs to the handler). Registered, unowned,
   * and — since J-104 — with no producer either: the sidebar's database-node Delete… item was
   * removed because nothing subscribes to this id.
   */
  'delete-database': { connectionId: string; databaseName: string };
  /**
   * Sidebar ▸ database node ▸ Compare schemas… — the targeted twin of `open-schema-diff` (Task 19b).
   *
   * The payload is the SOURCE side. The comparison needs two databases and the node names one, so this
   * pre-selects it and leaves the target to the dialog; `open-schema-diff` resolves the source from the
   * focused connection instead, exactly as the backup pair does.
   */
  'compare-database-schemas': { connectionId: string; databaseName: string };
  /**
   * An object-properties surface for a table, view, procedure or function. Registered, unowned and
   * producerless, as its database twin above: J-104 removed the Properties… item from all four
   * sidebar object menus. The ⌥↩ the Angular menus advertised for it was never bound by anything
   * (`shell/sidebar/node-menu.tsx`), so it is not claimed here either.
   */
  'show-object-properties': {
    connectionId: string;
    databaseName: string;
    schema: string;
    objectName: string;
    objectType: string;
  };

  // ── The six channels that had a live producer AND consumer in Angular ──────────────────────

  /**
   * Edit ▸ Copy (⌘C), forwarded from the native menu — the renderer never sees the keystroke,
   * because Electron's menu accelerator captures it.
   *
   * The one *claimable* command: `dispatchCommand` returns true when a handler returned true, and
   * the caller falls back to `document.execCommand('copy')` when nobody claimed it. This replaces
   * the `cancelable: true` CustomEvent plus `preventDefault()` protocol at
   * `menu.service.ts:296-306` / `results-grid.component.ts:1207`, which is the only reason
   * handlers may return a boolean at all.
   */
  'menu-copy': void;

  /** Monaco's caret moved. Producer: the query editor. Consumer: the status bar's Ln/Col. */
  'cursor-position': { line: number; column: number };

  /** Producer: the snippet library. Consumer: the active query editor. */
  'insert-snippet': { sql: string };

  /** Producer: the ⌘/ shortcut and the palette. Consumer: the shortcuts cheatsheet. */
  'show-shortcuts': void;

  /** Producer: the palette. Consumer: the object-search overlay. */
  'open-object-search': void;

  /** Producer: the palette. Consumer: the snippet library. */
  'open-snippets': void;

  // ── The two surfaces the Angular palette could reach (Task 16; ERD claimed in Task 18) ─────
  //
  // The Angular palette offered "Open ERD Diagram" and "Compare Database Schemas", and both worked —
  // they were two of its sixteen entries that were NOT dead. Their surfaces landed later, so the honest
  // options were to drop the entries until then or to register the commands now with their owners
  // named. Registered: a palette that silently lost two features a user had is worse than one that says
  // "not wired yet — Task 18". Task 18's `features/erd/ErdCommands` is now that owner for `open-erd`;
  // `open-schema-diff` is still waiting on Task 19's SHOULD tier (PLAN.md §4). Neither was ever wired
  // to a placeholder — Task 7 deleted the last of those on purpose.

  /** Open an entity-relationship diagram for the current database. */
  'open-erd': void;
  /** Compare two databases' schemas. */
  'open-schema-diff': void;

  // ── Reveal in the explorer (Task 16) ───────────────────────────────────────────────────────
  //
  // The object search finds an object by name and has to be able to show the user *where* it is,
  // which means expanding four levels of a lazily-loaded, virtualized tree and scrolling to a row
  // that is not mounted yet. Only the sidebar can do the last part — it owns the `TreeHandle`
  // (`shell/sidebar/sidebar.tsx`, the reveal API Task 6 built) — and the object search is a portalled
  // overlay with no relationship to it in the React tree. So this is exactly the case the bus is for.

  /**
   * Expand the path down to one object and scroll it into view in the sidebar tree.
   *
   * The same five fields `show-object-properties` carries, because they are what names an object
   * unambiguously; `state/explorer-path.ts` turns them into the node ids the tree uses.
   */
  'reveal-explorer-node': {
    connectionId: string;
    databaseName: string;
    schema: string;
    objectName: string;
    objectType: string;
  };

  // ── The query tab's sub-panels (Task 14) ───────────────────────────────────────────────────
  //
  // One command, because one of the three surfaces needs a keyboard path that is not a click on the
  // thing itself: the row inspector opens on a row the user has to be able to name without a mouse.
  // The result-history panel and the connection chip are a result tab and a toolbar control, so
  // their affordance IS their surface and a command for them would be a second producer for a
  // channel whose consumer is the same component.

  /**
   * Open the row-detail rail on the focused (else selected, else first) row of the active tab's
   * grid. Also the double-click handler's own path, so both routes land in one place.
   */
  'results-row-open': void;
}

export type CommandId = keyof CommandPayloads;

export type CommandPayload<Id extends CommandId> = CommandPayloads[Id];

/**
 * Who handles each command, and who sends it. A `Record` over the whole id union on purpose: this
 * is the compile-time gate that keeps the registry free of commands nothing consumes. Update it in
 * the same edit as `CommandPayloads` or the build fails.
 */
export const COMMAND_CONSUMERS: Record<CommandId, string> = {
  // The native menu. "Task 7 shell" means `shell/shell-commands.tsx`, which is where every
  // handler this task owns is registered, in one table.
  'open-connection-dialog':
    'Task 9 features/connections/ConnectionDialogs, mounted by the shell. Producers: the native ' +
    'menu bridge (File ▸ New Connection — no longer the silent router no-op of PLAN.md 0.1), the ' +
    'Task 8 sidebar header, its connection menu, the explorer empty state, and ⌘N with nothing ' +
    'connected.',
  'new-query':
    'Task 7 shell (tabStore.openQueryTab, or the connection dialog when nothing is connected).',
  'open-query-file':
    'Task 10 query editor when a query tab is active; Task 7 shell otherwise (it opens the file ' +
    'dialog and creates the tab). Both subscribe and each checks the active tab, which is the ' +
    'Angular branch at menu.service.ts:86-97 split across its two owners.',
  'close-active-tab': 'Task 7 shell (tabStore.closeTab on the active tab).',
  'save-query': 'Task 10 query editor.',
  'save-query-as': 'Task 10 query editor.',
  'export-results': 'Task 11 results grid.',

  'editor-find': 'Task 10 query editor (Monaco find widget).',
  'editor-replace': 'Task 10 query editor (Monaco replace widget).',
  'format-sql': 'Task 10 query editor (sql-formatter).',
  'toggle-comment': 'Task 10 query editor.',

  // The converter's three. One consumer, one handler, three ids — `features/query/sql-convert.ts` is the
  // adapter over `query.convertSql` and the only place its two adjacent engine arguments are passed.
  'convert-sql-to-mssql':
    'Task 19a features/query/QueryCommands (the active query tab converts its own editor). Producers: ' +
    'the Task 16 palette and the query toolbar’s convert menu.',
  'convert-sql-to-postgresql':
    'Task 19a features/query/QueryCommands, as convert-sql-to-mssql. Producers: the Task 16 palette and ' +
    'the query toolbar’s convert menu.',
  'convert-sql-to-mysql':
    'Task 19a features/query/QueryCommands, as convert-sql-to-mssql. Producers: the Task 16 palette and ' +
    'the query toolbar’s convert menu.',

  'execute-query': 'Task 10 query editor.',
  'execute-selection': 'Task 10 query editor.',
  'cancel-query': 'Task 10 query editor.',
  'show-execution-plan':
    'Task 19b features/query/QueryCommands (the active query tab asks its own engine, wraps the ' +
    'statement per `execution-plan.ts` and renders the answer as a tab in its results pane). Producers: ' +
    'the Task 16 palette and the query toolbar’s plan button.',
  'open-query-history':
    'Task 19a features/query-history/QueryHistoryHost, mounted by the shell — NOT by the query tab, ' +
    'because the dialog opens a new query tab and ⇧⌘H has to work with none in front of it. ' +
    'Producers: the native menu bridge (Query ▸ History) and the Task 16 palette.',

  'disconnect-connection': 'Task 7 shell (connectionStore.disconnect on the focused connection).',
  'refresh-explorer':
    'Task 7 shell (the three-step refresh of menu.service.ts:356-386: database list, server ' +
    'node, selected node).',
  'show-server-properties':
    'Task 19 server-properties surface. No producer: J-104 removed Server ▸ Properties… from ' +
    'the native menu (`packages/main/src/menu.ts`) and its `onServerProperties` channel with it, ' +
    'because it dispatched into a handler that never shipped and `bus.ts:warnUnhandled` is ' +
    'DEV-only. The palette still lists this id, disabled, naming this task — which is the ' +
    'affordance a native menu item cannot offer.',

  'create-database':
    'Task 19a features/databases/DatabaseDialogs, mounted by the shell. Like the backup twin it ' +
    'resolves its target through mostRecentConnectionId() — the native menu and the palette carry no ' +
    'payload — and it refuses, with a reason, on an engine whose capabilities say database management ' +
    'is not available.',
  'open-backup-dialog':
    'Task 12 features/backup/BackupDialogs, mounted by the shell. It resolves the target through ' +
    'mostRecentConnectionId() — not focus, which derives from the active query tab alone — and that ' +
    'connection’s default database, because the native menu carries no payload (PLAN.md 0.1 item 2 — ' +
    'no longer the silent router no-op, and no longer the Task 7 placeholder either).',
  'open-restore-dialog':
    'Task 13 features/restore/RestoreDialogs, mounted by the shell. It resolves the target through ' +
    'mostRecentConnectionId() — not focus — because the native menu carries no payload, and it needs ' +
    'no database name at all: a restore creates its target (PLAN.md 0.1 item 3 — the last of the ' +
    'three silent router no-ops, and no longer the Task 7 placeholder either).',
  'show-database-properties':
    'Task 19 database-properties surface. No producer: J-104 removed Database ▸ Properties… and ' +
    'its `onDatabaseProperties` channel, for the reason given under show-server-properties.',

  'show-welcome': 'Task 7 shell (tabStore.showWelcome).',
  'toggle-sidebar': 'Task 7 shell (workbenchStore.toggleSidebar).',
  'toggle-chat-panel':
    'Task 17 features/chat/ChatCommands, mounted by the shell. It calls chatPanelStore.togglePanel() ' +
    'itself — the Task 7 handler that held this wire while no chat surface existed is deleted, so ⇧⌘I ' +
    'is handled exactly once. NOT inside the panel: a closed side panel is unmounted, and a handler ' +
    'there could only ever close the assistant. Producers: the native menu bridge (View ▸ Toggle AI ' +
    'Chat), the status bar toggle and the Task 16 palette.',
  'open-chat-tab':
    'Task 17 features/chat/ChatCommands (tabStore.openChatTab). Producer: the Task 16 palette — the ' +
    'panel’s own ⧉ button calls the store directly, because it carries the active conversation with it.',
  'toggle-results-panel': 'Task 10 query tab (its results pane).',
  'toggle-output-panel': 'Task 7 shell (logStore.toggle). Producer: the shell ⌘J shortcut.',
  'open-docker-panel':
    'Task 19b features/docker/DockerPip, rendered by the status bar — which is never unmounted, so the ' +
    'handler may live with the popover’s anchor rather than in a separate shell mount. Producer: the ' +
    'Task 16 palette; the pip itself calls the panel’s open state directly.',

  'next-tab': 'Task 7 shell (tabStore.nextTab).',
  'previous-tab': 'Task 7 shell (tabStore.previousTab).',

  'open-settings':
    'Task 15 features/settings/SettingsDialog, mounted by the shell. It calls settingsStore.open() ' +
    'itself — the Task 7 placeholder that held this wire while no panel existed is deleted, so ⌘, is ' +
    'handled exactly once.',

  'start-tour':
    'Task 19b features/onboarding/TourHost, mounted by the shell — it starts the workbench tour and ' +
    'owns the spotlight overlay. Producers: the Task 16 palette and the Task 19a welcome tab, whose ' +
    '"See how it joins" button asked `handlerCount` first and said "not in this build yet" until this ' +
    'handler existed.',

  'open-ai-setup':
    'Task 19a features/ai-setup/AiSetupHost, mounted by the shell — which is also the one caller of ' +
    'aiStore.initialize() now (J-55). Producers: the Task 16 palette, the welcome tab’s AI entry, ' +
    'the chat panel’s no-provider empty state, and — added by J-92, because the previous three were ' +
    'either palette-only or gated on NOT being configured yet — the native menu bridge (AI Setup…, ' +
    'beside Settings in both menus that carry it) and the Settings dialog’s AI group.',

  // The sidebar's eight targeted entry points. Producer for all of them: Task 8 sidebar
  // (`shell/sidebar/node-menu.tsx` and `connection-picker.tsx`).
  'open-connection-manager':
    'Task 9 features/connections/ConnectionDialogs, which shows the manager. Producer: Task 8 ' +
    'sidebar connection menu.',
  'edit-connection':
    'Task 9 features/connections/ConnectionDialogs, which resolves the payload id to a profile and ' +
    'opens the editor on it. Producer: Task 8 sidebar server context menu.',
  'connect-to-container':
    'Task 9 features/connections/ConnectionDialogs, which opens the editor on a NEW profile with the ' +
    'payload host and port pre-filled through its `prefill` prop. Producer: Task 19b’s Docker panel.',
  'create-database-on-server':
    'Task 19a features/databases/DatabaseDialogs, targeting the payload connection rather than the ' +
    'focused one. Producer: Task 8 sidebar (server context menu and database picker).',
  'backup-database':
    'Task 12 features/backup/BackupDialogs, targeting the payload database rather than the focused ' +
    'one. Producer: Task 8 sidebar (database context menu and the footer action).',
  'restore-database':
    'Task 13 features/restore/RestoreDialogs, targeting the payload connection — and its optional ' +
    'database, which pre-selects the restore target rather than naming what is read. Producer: ' +
    'Task 8 sidebar (server and database context menus, and the footer action).',
  'rename-database':
    'Task 19a features/databases/DatabaseDialogs. On success it re-points every tab bound to the old ' +
    'name, drops the ERD cache for BOTH names and reloads the explorer — see ' +
    'features/databases/database-invalidation.ts, and J-64 for the main-side signal that would do it ' +
    'better. Producer: Task 8 sidebar database menu.',
  'delete-database':
    'Task 19 delete-database confirmation, which owns the in-use warning and the tab/node ' +
    'teardown. No producer: J-104 removed the sidebar database menu’s Delete… item, because it ' +
    'dispatched into a handler that never shipped and `bus.ts:warnUnhandled` is DEV-only, so the ' +
    'click was silent in a packaged build. Give this id a producer in the same change as its ' +
    'handler, never before.',
  'compare-database-schemas':
    'Task 19b features/schema-diff/SchemaDiffHost, with the payload database pre-selected as the ' +
    'comparison SOURCE rather than resolved from focus. Producer: Task 8 sidebar database menu.',
  'show-object-properties':
    'Task 19 object-properties surface (the wired table-properties container, not the dead ' +
    'panel clone of PLAN.md 0.2). No producer: J-104 removed the Properties… item from all four ' +
    'sidebar object context menus for the same reason it removed Delete… above.',

  'menu-copy':
    'Task 11 results grid (claims it when focus is inside the grid and there is no text selection); ' +
    'Task 7 menu bridge dispatches it and falls back to document.execCommand when unclaimed.',
  'cursor-position': 'Task 7 status bar. Producer: Task 10 Monaco editor.',
  'insert-snippet': 'Task 10 query editor. Producer: Task 16 snippet library.',
  'show-shortcuts':
    'Task 16 features/shortcuts-dialog/ShortcutsDialog, mounted by the shell. Producers: the native ' +
    'menu bridge (Help ▸ Keyboard Shortcuts, ⇧⌘/) and the Task 16 palette.',
  'open-object-search':
    'Task 16 features/object-search/ObjectSearch, mounted by the shell. Producers: Task 16 palette ' +
    'and its own ⌘P shortcut.',
  'open-snippets':
    'Task 16 features/snippet-library/SnippetLibrary, mounted by the shell. Producers: Task 16 ' +
    'palette and its own ⌥⌘S shortcut.',

  'open-erd':
    'Task 18 features/erd/ErdCommands, mounted by the shell — it resolves the focused connection and ' +
    'its default database and opens a DATABASE-level diagram, because a palette entry carries no node ' +
    'to take a schema and a table from. The sidebar\'s "Show Relationships" is the table-focused entry ' +
    'point and calls `openErdTab` directly. Producer: Task 16 palette.',
  'open-schema-diff':
    'Task 19b features/schema-diff/SchemaDiffHost, mounted by the shell — it resolves the source from ' +
    'the focused connection because a palette entry carries no node, and generates a comparison QUERY ' +
    'rather than diffing anything (the honest naming the audit asked for). Producer: Task 16 palette — ' +
    'it was a palette-only entry point in Angular too, which is why the sidebar now has the targeted ' +
    'twin above.',

  'reveal-explorer-node':
    'Task 7 shell (`shell-commands.tsx`): it uncollapses the pane, expands the four levels down to ' +
    'the object and leaves a reveal request in the explorer store. The Task 8 sidebar honours that ' +
    'request with its TreeHandle — the handler is NOT there because a collapsed sidebar is unmounted, ' +
    'and this command has to work from a collapsed state. Producer: Task 16 object search.',

  'results-row-open':
    'Task 11/14 results grid (it owns the displayed order, so it assembles the payload the rail ' +
    'needs and claims the command only for the ACTIVE tab — the same guard export-results uses). ' +
    'Producers: the results toolbar’s Inspect button and a double-click on a row.',
};

/** Every registered id, for tests and for the palette's "is this wired?" assertion in Task 16. */
export const COMMAND_IDS = Object.keys(COMMAND_CONSUMERS) as readonly CommandId[];
