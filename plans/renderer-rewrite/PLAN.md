# Joinery renderer rewrite — Angular → React + Tailwind

Architecture plan, 2026-08-15. **No code changes were made producing this document.**

Settled by Craig (not re-litigated here): React; Tailwind CSS; brand-kit theming, ink-first
with ivory at parity; main process + preload + typed IPC survive **unchanged**; the vitest
integration tier survives unchanged; Playwright e2e + visual are rewritten `data-testid`-first.

Inputs: `plans/ui-overhaul/PROPOSAL.md` (§1 current-state audit and §2 brand mapping are
carried forward; its Angular-retheme phases are dead), `docs/brand/`, the licensed
`design` / `add-dark-mode` / `componentize` / `canonicalize-tailwind` skills, and a full walk
of `packages/renderer/src/app/`, `packages/preload/src/index.ts`, `packages/shared/src/`.

---

## 0. Findings that change the scope before anything is written

**0.1 The router is dead, and that resolves Craig's pages-vs-dialogs question.**
`main.ts:12` calls `provideRouter(routes, …)`, `app.routes.ts` declares 7 lazy routes, and
~30 `router.navigate()` calls exist across `menu.service.ts`, `sidebar.component.ts` and
`tab-bar.component.ts` — but **`router-outlet` appears zero times in the entire renderer**.
`app.component.ts:38` renders `<app-shell />` directly. Every navigation is a silent no-op.

Real rendering path: `AppComponent` → `ShellComponent` → `GoldenLayoutContainerComponent`,
which imperatively mounts one of five components per tab
(`golden-layout-container.component.ts:544-549`: `welcome`/`query`/`object`/`erd`/`chat`).

Consequences:

- **Verdict on the duplicated Backup/Restore/Connections surfaces: keep the dialogs, drop
  the pages.** This is not a taste call. `features/backup` (495), `features/restore` (677),
  `features/connections` (635) — **1,807 LOC** — are structurally unreachable. The dialogs
  are the only shipped visual language and carry all the live call sites
  (`sidebar.component.ts:815,823,963,1000,1139`). One visual language: **modal dialog over
  the workbench**, per §2.9.
- **Tabs are the navigation model.** The React app ships no router at all.
- **Two native menu items are broken today.** `menu.service.ts:211,217` implement
  Database ▸ Backup and Database ▸ Restore purely as `router.navigate()`; ditto
  File ▸ New Connection at `:75`. They must be wired to the dialogs in the rewrite (Task 12/13).

**0.2 ~5,800 LOC (13%) of the 44,922 non-spec LOC is confirmed dead. Do not port it.**
`table-properties-panel` 1,373 (unreferenced near-clone of the wired `…-container`),
`result-diff-viewer` 624, `fk-link` 496, `tree-view` 403, `workspace-panel` 395,
`tab-bar` 344, `sql-error.service` 331, `theme.service` 31, plus the 1,807 routed pages.
`workspace-panel` is the notable one: a complete, unreachable file-explorer feature with a
full main-process IPC surface behind it (`preload/src/index.ts:378-387`).

**0.3 The 1,023-LOC `ipc.service.ts` collapses to near-zero.** It is a 1:1 re-declaration of
the preload API wrapped in RxJS + `NgZone`. React calls `window.joinery.*` directly through
TanStack Query. That plus 0.2 means **~6,800 LOC deletes itself** before a single component
is rewritten.

**0.4 Nine `window.dispatchEvent('joinery:*')` DOM channels are the real inter-feature bus,
and 8 of the command palette's emitted events have no listener** (`command-palette.component.ts:331-599`;
audit §1.8 counted 10 dead dispatches). Replace with one typed command bus (Task 4).

**0.5 Six localStorage keys are the only home for real user data and will be silently lost
if not migrated.** `joinery-settings` (every app setting — `settings.service.ts:129,149`),
`joinery:completed-tours` (`onboarding.service.ts:195,204`), `joinery:welcomeDismissed`
(`tab.state.ts:32`), the **entire snippet library** (`snippet-library.component.ts:686,697`),
and two query-editor keys (`query.component.ts:1546,1647`). Task 5 owns migration.

**0.6 `pnpm-workspace.yaml` pins `typescript: ~5.4.5` "to the version the Angular 18
toolchain supports."** During coexistence the React renderer is stuck on TS 5.4. That is
workable (React 19 types and `moduleResolution: "bundler"` both work on 5.4) but the pin —
and the Angular build accelerators in `allowBuilds` (`lmdb`, `msgpackr-extract`, `nice-napi`,
`protobufjs`) — are removed in the cutover task, not before.

**0.7 The design skill is written for marketing web pages and will fight a desktop workbench
if handed over raw.** `responsive-design.md` mandates mobile-first breakpoints and a 16px body
floor; `dark-mode.md` prefers `prefers-color-scheme` with no manual toggle; `tables.md` assumes
real `<table>` markup. Joinery is a fixed 800×600-minimum window (`window.ts:53-54`) with a
3-state theme control and a virtualized grid. Task 2 therefore produces a short **house-rules
overlay** loaded _alongside_ `design/design-guidelines.md`; its content is fixed here:
viewport breakpoints (`sm:`/`md:`/`lg:`) are **banned** in favour of `@container` (panels resize
independently of the window — which is the case `responsive-design.md` itself reserves container
queries for); the body floor is 12px per PROPOSAL §2.4; dark is a `@custom-variant` on
`[data-theme]` **plus** `prefers-color-scheme` for `system` (the toggle is required —
`settings.types.ts:5`); `tables.md`'s hairline-rows/no-container _look_ applies to the grid but
not its markup rules. Everything else in `design/` applies as written — especially `general.md`
(Tailwind authoring), `surfaces.md`, `buttons.md`, `form-controls.md`, `icons.md`,
`interactivity.md`, `shadows.md`.

---

## 1. Feature inventory — the scope contract

MUST = required for v1 parity. SHOULD = ship if the phase lands cleanly, else defer.
DROP = do not port. LOC are non-spec TS in the Angular source.

### 1.1 Shell & chrome

| Surface                                                                                       | LOC           | Verdict    | Notes                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell frame: resizable+persisted sidebar, window drag region, ⌘J output panel                 | 453           | **MUST**   | Rebuild, don't port. Audit §1.9: broken border ownership, 4px non-keyboard resize handle, four magic `38px`.                                                                                                                                 |
| Sidebar: connection tree, database picker, explorer nav, context menus, 7 dialog entry points | 1,926         | **MUST**   | Largest single surface. Split into ≤6 components (Task 8). Brand mark = inline `docs/brand/assets/mark-on-{dark,light}.svg`, not the 3 skewed `<span>`s at `sidebar.component.ts:397-428`.                                                   |
| Status bar: connection/rows/cursor, Docker pip, running-query indicator, theme toggle         | 608           | **MUST**   | Restructure: audit §1.9 proves the 24px bar cannot fit its own 24px controls.                                                                                                                                                                |
| Golden-Layout tab workspace: dock/split, lazy mount, layout persistence, tab context menu     | 827 + 713 mgr | **MUST**   | Replaced by Dockview (§2). `LayoutConfig` in `app-state.types.ts` must keep serializing — see Decision C.                                                                                                                                    |
| Output/console panel: log timeline, level filters, reveal log file                            | 321           | **MUST**   | Hardcoded non-resizable 220px today; make it a real Dockview panel.                                                                                                                                                                          |
| Custom tab strip                                                                              | 344           | **DROP**   | Dead; Dockview owns tab headers.                                                                                                                                                                                                             |
| Native-menu bridge (**31** channels, `preload/src/index.ts:394-441`)                          | 391           | **MUST**   | All 31 `menu.on*` subscriptions must land somewhere real, including the 3 currently broken ones (0.1). (Counted in Task 7: 31 in preload and 31 `menu.on*` calls in `menu.service.ts`. The "≈20" and "34" this row carried were both wrong.) |
| Global context menu renderer                                                                  | 144 + 67 svc  | **MUST**   |                                                                                                                                                                                                                                              |
| Toasts (`MatSnackBar`, 1 file)                                                                | 88            | **MUST**   | → `sonner`.                                                                                                                                                                                                                                  |
| Startup loading screen                                                                        | 129           | **MUST**   |                                                                                                                                                                                                                                              |
| Onboarding tour overlay + tour definitions                                                    | 312 + 209     | **SHOULD** | Only Welcome-tab entry points; low risk to defer one phase.                                                                                                                                                                                  |

### 1.2 Tab surfaces (the five things Dockview mounts)

| Surface                                                                                                             | LOC                     | Verdict  | Notes                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Query tab** — Monaco SQL editor, execute/cancel, format, ⌃E confirm gate, placeholder prompts, hosts 6 sub-panels | 2,689                   | **MUST** | Decompose hard; ~800 LOC of real logic. The two `document.createElement`+`innerHTML` modals (`:1557-1622`, `:1667-1717`) die with it. |
| **Results grid** — sort/filter/copy/export, row selection, menu-copy handler                                        | 2,055                   | **MUST** | AG Grid surface is shallow (§2.6).                                                                                                    |
| **Explorer object tab** — object detail view                                                                        | 447                     | **MUST** |                                                                                                                                       |
| **ERD tab** + pan/zoom diagram canvas, auto-layout                                                                  | 654 + 1,786 + 363 types | **MUST** | d3 + dagre are framework-agnostic; 26 hardcoded hexes must become tokens (audit §1.6).                                                |
| **Chat panel/tab** — streaming, tool confirmation, conversation list, per-tab instance state, markdown+mermaid      | 1,567                   | **MUST** | Both a side panel (`shell.component.ts:48`) and a tab type.                                                                           |
| **Welcome tab** — new-connection CTA, AI setup, tour launch                                                         | 953                     | **MUST** | The only brand-correct surface today (audit D4); keep it editorial, make it theme-aware.                                              |

### 1.3 Query-pane sub-panels

| Surface                                         | LOC   | Verdict                                                        |
| ----------------------------------------------- | ----- | -------------------------------------------------------------- |
| Row detail inspector + FK preview               | 1,315 | **MUST**                                                       |
| Result snapshot history (pin/label/inline diff) | 1,059 | **MUST**                                                       |
| Execution plan tree (MSSQL/PG/MySQL)            | 791   | **SHOULD**                                                     |
| AI analysis panel (markdown result explanation) | 540   | **SHOULD**                                                     |
| Connection context chip                         | 264   | **MUST**                                                       |
| Standalone result diff viewer                   | 624   | **DROP** — dead; superseded by the history panel's inline diff |
| `fk-link` component                             | 496   | **DROP** — dead; row-detail rolled its own                     |

### 1.4 Dialogs — one visual language, per 0.1

| Dialog                                                           | LOC       | Verdict                               |
| ---------------------------------------------------------------- | --------- | ------------------------------------- |
| Connection editor (create/edit/test, auth modes, SSH, DSQL/IAM)  | 1,040     | **MUST**                              |
| Restore wizard                                                   | 971       | **MUST**                              |
| Backup wizard                                                    | 674       | **MUST**                              |
| Query history (search, load-or-execute)                          | 608       | **MUST**                              |
| Server file browser (server-side drives/dirs)                    | 505       | **MUST**                              |
| Connection manager (list/organize)                               | 348       | **MUST**                              |
| AI setup (vendor + API key)                                      | 305       | **MUST**                              |
| Confirm dialog / input dialog                                    | 294 + 258 | **MUST** — become primitives          |
| Create / rename database (capability-gated)                      | 193 + 208 | **MUST**                              |
| Schema diff (picks 2 DBs, _generates a comparison query_)        | 391       | **SHOULD** — palette-only entry point |
| Missing-CLI-tools remediation (owns 3 of the 7 existing testids) | 352       | **MUST**                              |
| Test-result panel, password-hygiene warning                      | 90 + 95   | **MUST**                              |
| Full-page backup / restore / connections                         | 1,807     | **DROP** (0.1)                        |

### 1.5 Global overlays

| Surface                                                              | LOC   | Verdict                                                 |
| -------------------------------------------------------------------- | ----- | ------------------------------------------------------- |
| Settings panel (theme/editor/query/grid)                             | 965   | **MUST**                                                |
| Table properties slide-over (the _container_, which owns its own UI) | 1,236 | **MUST**                                                |
| Command palette (⌘K/⌘⇧P, fuse.js)                                    | 703   | **MUST** — and wire the 8 dead commands (0.4)           |
| Snippet library (CRUD, localStorage-only)                            | 710   | **MUST** — plus data migration (0.5)                    |
| Object search (fuzzy DB objects, fuse.js)                            | 488   | **MUST**                                                |
| Docker panel (container start/stop/create, volumes)                  | 497   | **SHOULD**                                              |
| Shortcuts cheatsheet                                                 | 264   | **MUST**                                                |
| Table properties panel (clone)                                       | 1,373 | **DROP** — dead                                         |
| Workspace / folder panel                                             | 395   | **DROP** — dead, plus its whole IPC surface goes unused |

### 1.6 Services & state (must survive semantically, not structurally)

**MUST port as pure TS, essentially unchanged** (no Angular in them): `markdown-renderer.ts`
(150 — the DOMPurify seam CLAUDE.md mandates), `explorer-folders.ts` (44), `utils/platform.ts`,
`sql-intellisense.service.ts` (768 — Monaco providers), `erd-adapter.service.ts` (259).

**MUST rewrite as stores/hooks:** `tab.state` (707), `explorer.state` (690), `connection.state`
(666), `chat.state` (384), `ai.state` (374), `query-results.state` (369), `chat-instance.state`
(354), `query-history.state` (150), `capabilities.state` (45), `settings.service` (232),
`onboarding.service` (209), `menu.service` (391), `log.service` (117),
`notification.service` (88), `table-properties.service` (64), `context-menu.service` (67),
`query-execution.service` (27), `global-error-handler` (20).

**DROP:** `ipc.service` (1,023 — 0.3), `golden-layout-manager.service` (713 — Dockview replaces
it), `sql-error.service` (331 — zero external refs), `theme.service` (31 — zero external refs;
consumers use `SettingsService` directly).

### 1.7 Persistent state that must round-trip identically

Main process, already typed: `AppState` (`sidebarWidth`, `sidebarCollapsed`, `chatPanelWidth`,
`lastConnectedProfileIds`, `lastDatabase`, `editorHeightPercent`, `showQueryHistory`,
`goldenLayoutConfig`, `aiSettings`), `saveTabs`/`getTabs`, `saveLayout`/`getLayout`, query
history, result snapshots, connection profiles + keytar secrets, AI settings/keys, chat
conversations, backup history. Renderer localStorage: the six keys in 0.5.

---

## 2. Stack

| Concern                                                    | Pick                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **React**                                                  | 19.2                                                                                                                                                                           | Current stable; the concurrent/transition primitives are what keep chat streaming from thrashing (Risk R3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Build**                                                  | Vite 8.2 + `@vitejs/plugin-react` 6                                                                                                                                            | `base: './'` and `build.outDir: 'dist/browser'` reproduce Angular's exact artifact contract — see §3.1. Vite 8 bundles with Rolldown; verify install under `nodeLinker: hoisted` in Task 1 rather than assuming.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Tailwind**                                               | v4.3 via `@tailwindcss/vite`                                                                                                                                                   | v4 is what the design skills target: they reference `@theme`, `@utility`, `@custom-variant`, `--spacing()`, `inset-ring`, `scheme-only-dark`, and `npx @tailwindcss/cli canonicalize`. A v3 config would make `canonicalize-tailwind` and half of `general.md` inapplicable. CSS-first `@theme` also means the brand tokens are the Tailwind theme, not a parallel system.                                                                                                                                                                                                                                                                                                                                                                                      |
| **TypeScript**                                             | ~5.4.5 during coexistence, bump at cutover                                                                                                                                     | Forced by the workspace override (0.6). `strict`, `moduleResolution: "bundler"`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Local/UI state**                                         | Zustand 5 + `useShallow`                                                                                                                                                       | Closest sane idiom to Angular signals: one store per current `core/state/*` file, selector-subscribed so a chat token doesn't re-render the grid. Redux is ceremony this project doesn't need; Context re-renders the tree; signal libraries add a second reactivity model next to React's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Server/IPC state**                                       | TanStack Query 5                                                                                                                                                               | Every `window.joinery.*` call is an async request with cache/invalidate/retry semantics — exactly what the 1,023-LOC `ipc.service` hand-rolled badly. Event channels (`onProgress`, `onStreamChunk`, `onEntry`, `onFileChanged`, `onChanged`) stay imperative subscriptions that push into Zustand.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Router**                                                 | **None**                                                                                                                                                                       | 0.1: there is no outlet today and tabs are the navigation model. Adding a router would import a dead concept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Docking layout**                                         | **Dockview 8.1** (`dockview-react`)                                                                                                                                            | React-first, actively released, does dock/split/float/tab-groups, serializes to/from JSON, and supports custom tab renderers (needed for dirty/pinned markers and the rename affordance). Alternatives rejected: **golden-layout 2.6** is frozen at the same version the repo already pins, has no React binding, and its 1,540 LOC of manager+container coupling is a top-3 source of the audit's `!important` debt — keeping it means keeping the worst chrome in the app. **rc-dock** is lighter but its floating/serialization story is weaker. **flexlayout-react** can't do the tab-header customization. `react-resizable-panels` is the fallback if Dockview fights Electron (§6 R5) — sidebar/editor/results/output as fixed splits, tabs hand-rolled. |
| **Monaco**                                                 | `monaco-editor` 0.56 as ESM + `?worker` imports, wrapped in one owned `<SqlEditor>`                                                                                            | Drops the AMD `assets/monaco/vs/loader.js` script-tag hack at `query.component.ts:1221-1241` and the `declare const monaco` global at `:110`. `@monaco-editor/react` is **not** used: it defaults to a CDN loader, which is wrong under `file://` and wrong under a CSP. Register `joinery-ink`/`joinery-ivory` themes from the `--syntax-*` tokens (today it's stock `vs`/`vs-dark`, `:1062`).                                                                                                                                                                                                                                                                                                                                                                 |
| **Results grid**                                           | `ag-grid-react` 36 + `ag-grid-community` 36                                                                                                                                    | The old app's choice matters and the API surface is shallow — `ColDef`, `GridApi`, `defaultColDef`, `ModuleRegistry`, `onGridReady`, cell renderers (`results-grid.component.ts:23-53,1192-1429`). AG Grid ships a first-class React build, so this is a port not a rewrite, and it already satisfies CLAUDE.md's >1000-row virtualization rule. TanStack Table+Virtual would mean re-implementing column sizing, sort, range selection and clipboard from scratch — weeks of work to reach parity, for a lighter bundle nobody is paying for in a desktop app. Theme: bind the theme class to the effective theme (today hardcoded `ag-theme-quartz-dark`, `:213`) and derive all 26 `--ag-*` from tokens.                                                     |
| **Trees** (sidebar, explorer, object search, snippet list) | Hand-rolled + `@tanstack/react-virtual`                                                                                                                                        | Both current trees are bespoke and the shared `tree-view` is dead (1.5). `react-arborist` imposes its own row model and drag semantics on a tree that is context-menu-heavy and capability-gated. Virtualize from day one — the audit lists 6 unvirtualized long lists as deferred perf debt; don't re-inherit it.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Markdown + mermaid**                                     | Port `markdown-renderer.ts` verbatim: `marked` + `marked-highlight` + `highlight.js` + **DOMPurify**                                                                           | CLAUDE.md requires the single sanitize seam and forbids unsanitized `[innerHTML]`. In React that means one `<Markdown>` component that is the _only_ place `dangerouslySetInnerHTML` appears, fed exclusively by `renderMarkdown()`. Add an ESLint rule banning `dangerouslySetInnerHTML` everywhere else (Task 3). `mermaid` stays dynamically imported (`markdown-viewer.component.ts:42`); its `<style>`-escape issue is a known FOLLOW-UP, not this plan's.                                                                                                                                                                                                                                                                                                 |
| **Primitives**                                             | **Radix UI** (`dialog`, `dropdown-menu`, `select`, `tooltip`, `tabs`, `popover`, `scroll-area`) styled with the design skills, + `sonner` for toasts, + `cmdk` for the palette | This is the Material replacement and it is unavoidable: 16 `MatDialog` files, 129 `matTooltip`, 127 `mat-form-field`, 76 `mat-tab`, 70 `mat-menu`, 44 `mat-select`. Hand-rolling means hand-rolling focus traps, `aria-*` wiring and portal/collision logic six times — the audit already found 24 overlays across 3 mechanisms and zero `:focus-visible` on the status bar. Radix is unstyled, so `design/` guidelines apply directly with no fight. **Base UI rejected: 1.0.0-rc.0.** Inputs/textareas/checkboxes are plain elements styled by owned components per `componentize`'s one-component-per-HTML-element rule.                                                                                                                                     |
| **Icons**                                                  | `lucide-react`, tree-shaken                                                                                                                                                    | Replaces 1,148 `mat-icon` ligature uses. The two e2e assertions that match on ligature _text_ die with the old suite, which is being rewritten anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Fonts**                                                  | `@fontsource-variable/archivo`, `@fontsource-variable/instrument-sans`, `@fontsource/ibm-plex-mono`, registered as `--font-*` in `@theme`                                      | Audit §1.5: two of the three brand faces are already requested in CSS and silently falling back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Forms**                                                  | `react-hook-form` + `zod` 4, reusing `packages/shared/src/validators/`                                                                                                         | The connection dialog is 1,040 LOC of conditional auth-mode validation; the shared validators already exist and must stay the single source of truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Unit tests**                                             | vitest 4 (existing runner) + `@testing-library/react` + jsdom project                                                                                                          | Root `vitest.config.ts` is `environment: 'node'` with `include: packages/*/src/**/*.{test,spec}.ts`. Task 1 adds a **second vitest project** for the React package with `environment: 'jsdom'`, leaving the node project and `vitest.integration.config.ts` byte-identical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Lint/format**                                            | Existing prettier + `prettier-plugin-tailwindcss`; ESLint flat config with `react-hooks`, `jsx-a11y`                                                                           | `pnpm run lint` has reportedly never worked for the renderer (audit §1.10). The new package ships a working `lint` **and** `typecheck` task on day one — Angular's absent `typecheck` script is why `build` is the only current type gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 2.9 One visual language for the duplicated surfaces — rationale

The dialogs win, and the reasoning is stronger than "they're the wired ones":
**modal-over-workbench is the correct pattern here.** Backup, restore and connection editing are
short, transactional, blocking flows — start one, watch a progress stream
(`backup.onProgress` / `restore.onProgress`), finish. A full page competes with the tab
workspace for the same real estate and implies the task is a _place_ you can navigate away from
and return to, which is false: the progress stream is per-invocation and unpersisted. The pages
also introduced the app's only `<mat-card>` and `mat-stepper` uses (audit §2.1, §2.6) — two
patterns the brand direction explicitly rejects ("avoid soft, bubbly cards",
`docs/brand/README.md:85`). So: **`<Dialog>` for all three**, sized `md`/`lg`, hairline-ruled
header + scrollable body + right-aligned action row, one filled oxide affordance per dialog
(audit §2.5), progress inline in the body. Connection _management_ stays a dialog too — its only
job is to launch the editor.

---

## 3. Coexistence & cutover

**Recommendation: (a) a new `packages/renderer-react` package, built feature-by-feature behind
a dev flag, cut over at parity.** Not a long-lived branch.

Why: this is a 45k-LOC replacement executed by agents one PR at a time. On a big-bang branch
nothing is runnable until the shell, docking, Monaco, the grid _and_ enough of the query tab all
exist — 6+ tasks with no verification gate between them, in a repo whose only renderer type gate
is `pnpm run build`. Agent work needs a green run per task or errors compound invisibly. A
divergent branch also blocks the other two v1 priorities (the MJ/Forge scrub, end-to-end query
verification) for its whole life. Dual maintenance is the cost and it is cheap here: the Angular
renderer is **frozen** for the duration (bug fixes only), and main/preload/shared are shared
unchanged, so there is no contract drift to reconcile.

### 3.1 The switch is one environment variable, because the artifact contract is reproducible

The pipeline's entire coupling to the renderer is **six** hard-coded strings in four files:

| #   | Site                                  | Value                                                |
| --- | ------------------------------------- | ---------------------------------------------------- |
| 1   | `electron-builder.yml:19`             | `packages/renderer/dist/browser/**/*`                |
| 2   | `packages/main/src/window.ts:114`     | `loadFile('../../renderer/dist/browser/index.html')` |
| 3   | `tests/helpers/electron-app.ts:22`    | `RENDERER_INDEX` — asserted before launch            |
| 4   | `tests/reporter/build-report.mjs:218` | the same path, as a tier gate                        |
| 5   | `packages/main/src/window.ts:111`     | `loadURL('http://localhost:4200')`                   |
| 6   | root `package.json:17`                | `wait-on http://localhost:4200`                      |

`scripts/package.js`, `prepare-package.js`, `restore-package.js`, `before-build.js`,
`verify-package.js` and `workspace-links.js` contain **zero** renderer references
(`workspace-links.js:21` only links `@joinery/shared`). `turbo.json`, `playwright.config.ts`
and both vitest configs are already renderer-agnostic. `angular.json:46` already sets
`baseHref: "./"`, which is what makes `file://` loading work.

So `packages/renderer-react` is configured to be indistinguishable and **all six sites need
zero changes**:

```ts
// vite.config.ts
base: './',                                  // matches angular.json:46 — required under file://
build: { outDir: 'dist/browser', emptyOutDir: true },
server: { port: 4200, strictPort: true },    // matches window.ts:111 and the root dev:main wait-on
```

Non-negotiables the bundle must satisfy regardless:

- **`sandbox: true`** (`window.ts:59-64`, with `contextIsolation: true`, `nodeIntegration: false`).
  No `process`, `require` or Node builtins may survive into the bundle; Vite's `define` /
  `import.meta.env` covers app code, but any dep touching `process.env` at runtime needs a shim.
- **Relative asset URLs** — absolute `/assets/...` breaks under `file://`.
- **Monaco's workers must land inside the asar** (`asar: true`, `electron-builder.yml:119`).
  Angular copied `monaco-editor/min` → `assets/monaco` (`angular.json:27-29`); Vite `?worker`
  imports achieve the same, verified by R4's packaging runs.
- **CJS interop** for the mermaid/dagre chain: `angular.json:21` needs
  `allowedCommonJsDependencies: ["@dagrejs/graphlib", "@dagrejs/dagre", "nearley"]`; the Vite
  equivalent is `optimizeDeps.include`, set in Task 1, confirmed in Tasks 17-18.
- **The inset titlebar drag region** — `titleBarStyle: 'hiddenInset'`,
  `trafficLightPosition: {x:15,y:15}` (`window.ts:57`). Task 7 owns it.

**How the switch happens.** `dev:renderer` becomes `pnpm --filter $JOINERY_RENDERER run start`,
defaulting to `@joinery/renderer`; `JOINERY_RENDERER=@joinery/renderer-react pnpm run dev` runs
the new UI. Both bind :4200 so only one runs at a time and `dev:main`'s `wait-on` is unchanged.
Both emit `dist/browser/`, so cutover is a directory rename in one PR after which all six sites
above stay untouched and `pnpm run dev` needs no env var.

**Turbo / vitest / CI.** `turbo.json` is task-name-based and needs no edit (its
`outputs: [".angular/**"]` just goes stale). The new package adds a real `typecheck` task —
Angular has none, which is why `.github/workflows/ci.yml:45-46` carries a hand-written
`tsc --noEmit -p packages/renderer/tsconfig.json`; Task 1 adds the equivalent. Root
`vitest.config.ts` gains a `projects` array so a jsdom React project (`include` widened to
`.{ts,tsx}`, own setup file) sits beside the existing node project — whose
`setupFiles: ['./packages/main/src/__tests__/setup.ts']` currently runs for renderer specs too.
`vitest.integration.config.ts` is **not touched**, per the constraint.

**The cutover PR also (persistence, from Task 5):** deletes the six localStorage keys 0.5
inventories — `joinery-settings`, `joinery:completed-tours`, `joinery:welcomeDismissed`,
`joinery-snippets`, `joinery-ctrl-e-execute-confirmed`, `joinery-flyway-placeholder-values` — which
Task 5 deliberately left in place because the Angular renderer still reads them, and which
`src/persistence/legacy-local-storage.ts` (plus its one-shot migration and the
`migratedFromLocalStorageAt` marker) exists only to read. Deleting them retires that whole module.
It also settles the **`joinery:theme-preference` mirror**: with Angular gone the mirror can drop its
`joinery-settings` fallback, and `no-local-storage-writes.spec.ts` — which today permits exactly one
`setItem` in the package — becomes the place to state whether the mirror stays at all (it must, or
the pre-mount FOUC script in `index.html` has no synchronous source; see `persistence/theme-mirror.ts`
for the rejected alternatives). Finally it drops **`optimizeDeps.include: ['@joinery/shared']`** from
`packages/renderer-react/vite.config.ts`: that entry exists because `packages/shared` emits tsc
CommonJS whose `__exportStar` chain the dev server's ESM interop cannot see through (Task 5 hit it on
the first import of a runtime value), so the real fix — **emitting ESM from `packages/shared`** — lands
here, and the workaround goes with it.

**The cutover PR also:** deletes `packages/renderer`; drops the `typescript: ~5.4.5` override and
the four Angular-CLI accelerators (`lmdb`, `msgpackr-extract`, `nice-napi`, `protobufjs`) from
`pnpm-workspace.yaml` `allowBuilds` (0.6); fixes the `strictPeerDependencies` comment, which
cites Angular; deletes the dead `@angular/*` group in `.syncpackrc.json:18`; swaps the four
Angular asar exclusions (`electron-builder.yml:41,42,44,45`) for
`vite`/`@vitejs`/`rolldown`/`tailwindcss` analogues; drops `.angular` from `.prettierignore` and
`turbo.json` outputs; removes the `JOINERY_RENDERER` indirection. It also closes a pre-existing
gap: `scripts/verify-package.js` probes main-process deps and the out-of-asar sqlglot server but
**never checks that the renderer landed in the asar at all** — without that assertion the
cutover's only proof is a manual launch.

**The cutover PR also (primitives, from Task 6):** deletes
`packages/renderer-react/src/markdown/sanitize-parity.spec.ts`. It is the drift guard that holds
`src/markdown/render-markdown.ts` byte-identical to the Angular
`packages/renderer/src/app/shared/markdown/markdown-renderer.ts`, and it does that by importing
the Angular file as `?raw` — a **static** import, so deleting `packages/renderer` without
deleting this spec fails the vitest run at collection, before a single test executes. That is the
right way round (a drift guard that can silently stop guarding is worse than none), which is why
it is a checklist item rather than a lazy import. It is also the only _import_ of the Angular
package anywhere in `renderer-react` — every other mention is a `Ported from …` docblock
reference, which survives the deletion harmlessly.

---

## 4. Phased SDD task plan

One task = one PR = one branch (`feature/rr-NN-slug`). Never commit to `main`.

**Standard gate, every task:** `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run format:check`,
plus `pnpm --filter @joinery/renderer-react run build`. The Angular package must still build and
its e2e suite must still pass until Task 24 — that is the coexistence invariant.

**Docker gate:** any task whose gate names an e2e spec needs `pnpm run test:harness:up`.
**Ping Craig before running the Docker tiers** (CLAUDE.md).

**Test-hook rule, all tasks:** every interactive element ships `data-testid` at creation time,
named `<surface>-<element>[-<qualifier>]` (`sidebar-connection-button`,
`backup-dialog-start`, `results-grid-cell`). The 7-testid mistake is not repeated. Vendor
internals (`.monaco-editor`, `.ag-*`, Dockview's classes) may be located structurally.

### Phase A — Foundations (Tasks 1-7)

**1. Scaffold `packages/renderer-react`.**
Produces: package with Vite 8 + React 19 + TS + the §3.1 config; `index.html`; a "Joinery
renderer-react" placeholder root; `build`/`start`/`typecheck`/`lint`/`clean` scripts (Angular
has neither `typecheck` nor `clean`); ESLint flat config with `react-hooks` + `jsx-a11y`; the
second vitest jsdom project in root `vitest.config.ts`; a CI type-check step mirroring
`ci.yml:45-46`; `jsx`/`tsx` added to the root `format` globs; `JOINERY_RENDERER` indirection
in root `dev:renderer`.
Consumes: nothing.
Gate: standard. `dist/browser/index.html` exists and Electron loads it via
`JOINERY_RENDERER=… pnpm run dev`. Angular build and e2e untouched. Confirm the install
succeeds under `nodeLinker: hoisted` (Rolldown / Lightning CSS / Tailwind Oxide prebuilt
binaries). **Also run `pnpm run package:dir` + `verify:package` against the placeholder and
launch the packaged `.app`** — this is the R4 baseline and it is cheapest to establish now.

**2. Tailwind v4 theme from the brand tokens + the house-rules overlay.**
Produces: `src/styles/theme.css` with `@import "tailwindcss"`, `@theme` registering the 8
brand colors from `docs/brand/tokens.css` plus the derived contrast-safe values from
PROPOSAL §2.2-2.3 (`--j-oxide-deep/-lift`, `--j-amber-deep`, `--j-verify-deep`), the
type/spacing/radius/icon scales from PROPOSAL §2.4, and `--font-{display,interface,technical}`;
the three fontsource deps; `@custom-variant dark` on `[data-theme="dark"]` **and** `prefers-color-scheme` for
`system`; `color-scheme` per theme; a `theme-color` meta pair; `data-theme` written before
React mounts (kills the audit's 3-stage FOUC); `antialiased` on root and `isolate` on the app
container per `general.md`. Plus `docs/design/HOUSE-RULES.md` — the 0.7 overlay.
Consumes: Task 1.
Gate: standard + a static swatch/type-scale page screenshotted in both themes; every pair in
PROPOSAL §2.3 re-measured and recorded.

**3. IPC client layer.**
Produces: `src/ipc/` — a typed accessor over `window.joinery` (no re-declaration; import
`JoineryAPI` from the preload package), TanStack Query provider + one query-key factory per
preload namespace, a `useIpcEvent` hook wrapping the 6 `on*` unsubscribe-returning
subscriptions, and an availability guard for the `window.joinery === undefined` case that
`ipc.service.ts` handles today. Plus the ESLint rule banning `dangerouslySetInnerHTML` outside
`src/markdown/`.
Consumes: `packages/preload/src/index.ts`, `packages/shared/src/`. **Changes neither.**
Gate: standard + unit tests against a mocked `window.joinery`.

**4. Stores + typed command bus.**
Produces: Zustand stores ported from `core/state/*` (tab, connection, explorer, capabilities,
query-results, query-history, ai, chat, chat-instance) with the pure helpers
(`explorer-folders.ts`, `platform.ts`) moved over as-is; a typed command bus replacing the 9
`joinery:*` DOM events (0.4); the `settings` store owning theme resolution + `nativeTheme` IPC.
Consumes: Task 3.
Gate: standard + ported unit tests for `connection.state.spec`, `capabilities.state.spec`,
`explorer-folders.spec` (3 of the 7 renderer specs; they are logic tests and should port
nearly verbatim).

**5. Persistence + localStorage migration.**
Produces: `AppState`/`saveTabs`/`saveLayout` read-write wiring; a one-shot migration that
lifts the six localStorage keys (0.5) — settings, completed tours, welcome-dismissed, the
snippet library, and the two query-editor keys — into main-process `AppState`, idempotent and
reading the same key names the Angular app writes, so a user who has been running Angular
keeps their snippets.
Consumes: Task 4.
Gate: standard + a unit test proving migration is idempotent and a second proving a
pre-populated localStorage set round-trips into `AppState`.

**6. Primitives.**
Produces: `src/ui/` — `Dialog` (Radix, header/body/actions slots, `sm|md|lg`), `Button`
(`primary|outline|ghost|danger` × `sm|md`, exactly two heights ≥6px apart per `buttons.md`),
`Input`/`Textarea`/`Select`/`Checkbox`/`Switch` (one per HTML element, per `componentize`),
`Tooltip`, `DropdownMenu`, `Tabs`, `Popover`, `EmptyState` (retires 19 divergent
implementations), `Toolbar`, `Spinner`, `Toaster` (sonner), `Icon`, `Markdown` (the sole
`dangerouslySetInnerHTML` site, fed by the ported `renderMarkdown`), `Tree` (virtualized),
`ContextMenu`. Every one takes and merges `className`; no baked margins.
Consumes: Tasks 2, 3. Uses `design` + `componentize` + the house rules.
Gate: standard + a primitives gallery route screenshotted both themes + the ported
`markdown-renderer.spec` / `markdown-viewer.spec` / `loading.component.spec` (the other 4
renderer specs) + an XSS test asserting the sanitize seam.

**7. Shell + docking.**
Produces: app frame; Dockview workspace mounting placeholder panels for the five tab types;
sidebar/output-panel/chat splits; status bar; global context menu; toaster; the full
`menu.on*` bridge (all **31** channels — not 34; counted in Task 7 — including the 3 broken ones from 0.1, routed through the
Task 4 command bus); layout serialize/restore against the existing `LayoutConfig` shape
(Decision C); `--titlebar-height`/`--gl-header-height` as real tokens; keyboard-operable
resize handles with `role="separator"`.
Consumes: Tasks 4, 5, 6.
Gate: standard + both themes: empty shell, sidebar collapsed/expanded, 3 tabs incl. a dirty
one, output panel open, status bar in connected/disconnected/executing states.

### Phase B — Feature surfaces (Tasks 8-19)

Each consumes Phase A and is independently runnable. 8 and 9 go first — nothing else is
reachable without a connection. All gates are _standard plus_ what is listed.

| #   | Task — produces                                                                                                                                                                                                                                                                                                                                                                                                            | Extra gate                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 8   | **Sidebar + explorer tree** — connection list, database picker, lazy virtualized object tree, capability-gated folders, the full context-menu action surface, and the inline brand mark from `docs/brand/assets/mark-on-{dark,light}.svg`. Split into ≤6 components.                                                                                                                                                       | `explorer.spec.ts`, `multi-connection-disconnect.spec.ts` rewritten |
| 9   | **Connection dialogs** — editor (all auth modes incl. SSH and DSQL/IAM), manager, test-result panel, password-hygiene warning; `react-hook-form` + the shared validators                                                                                                                                                                                                                                                   | `connection.spec.ts`, `test-connection-feedback.spec.ts`            |
| 10  | **Query tab shell + Monaco** — `<SqlEditor>` with ESM workers, the two brand editor themes, `sql-formatter`, execute/cancel, the ⌃E confirm gate, cursor reporting to the status bar. **Opens with the R1 spike.** **Read §6 "R5 RESOLVED" findings 3–4 first: an inactive Dockview panel's DOM is detached, so Monaco needs `layout()` on re-activation — or `renderer: 'always'`, which then re-arms Task 20 trap (b).** | `query-editor.spec.ts`, `query-toolbar.spec.ts`                     |
| 11  | **Results grid** — `ag-grid-react`, all 26 `--ag-*` from tokens, theme-bound class, sort/filter, all three `CopyFormat`s, export, row selection                                                                                                                                                                                                                                                                            | `cross-schema-query.spec.ts` + a 100k-row perf assertion (R2)       |
| 12  | **Backup dialog** + missing-CLI-tools view + server file browser + the broken Database ▸ Backup menu wire                                                                                                                                                                                                                                                                                                                  | `backup-cli-deps.spec.ts` + backup half of `backup-restore.spec.ts` |
| 13  | **Restore dialog** + the broken Database ▸ Restore menu wire                                                                                                                                                                                                                                                                                                                                                               | restore half of `backup-restore.spec.ts`                            |
| 14  | **Query sub-panels** — row detail + FK preview, result history with inline diff, connection chip                                                                                                                                                                                                                                                                                                                           | `row-detail.spec.ts`                                                |
| 15  | **Settings panel + theme control** — all four settings groups, 3-state toggle                                                                                                                                                                                                                                                                                                                                              | `settings.spec.ts`, `theme.spec.ts`                                 |
| 16  | **Palette + object search + snippet library + shortcuts dialog** — cmdk; **all** commands wired (0.4); snippets read from the Task 5 migration                                                                                                                                                                                                                                                                             | a spec asserting zero palette commands are no-ops                   |
| 17  | **Chat panel + tab** — streaming, tool confirmation, conversation list, per-tab instance isolation, markdown+mermaid via the Task 6 `Markdown`; chunk coalescer (R3)                                                                                                                                                                                                                                                       | a streaming re-render benchmark                                     |
| 18  | **ERD tab + diagram** — d3 + dagre ported, 26 hardcoded hexes → tokens, first theme-aware ERD                                                                                                                                                                                                                                                                                                                              | both themes                                                         |
| 19  | **Welcome tab + query history dialog + create/rename DB + explorer object tab + output panel + the SHOULD tier** (execution plan, AI analysis, AI setup, Docker panel, schema diff, tours). Split if it exceeds one PR; Docker panel and tours are the natural spill.                                                                                                                                                      | `welcome-screen`, `shell`, `tabs`, `ui-actions` specs               |

### Phase C — Suite rebuild (Tasks 20-23)

**20. e2e harness for the React renderer.** The current suite is **20 spec files / 49 `test()`
blocks**, and `tests/helpers/joinery-actions.ts` is the biggest rewrite surface — Material-coupled
end to end: `fillField` locates `mat-form-field` filtered by `mat-label:text-is(…)` (`:78-88`,
with a comment explaining Material's label association defeats `getByLabel`),
`connectToTestPostgres` waits on `app-root` (`:98`) then drives `mat-dialog-container` /
`mat-select` / `mat-option` / `mat-checkbox` (`:100-119`) and dismisses
`.mat-mdc-snack-bar-container button` (`:127`), `selectDatabase` uses
`.mat-mdc-menu-panel [role="menuitem"]` (`:142-150`).
Produces: `electron-app.ts` temporarily parameterized by renderer package; a
`data-testid`-only `joinery-actions.ts` where `fillField` collapses to `getByLabel` (real
`<label for>` makes it work); a Playwright project per renderer. **Zero structural-class and
zero Material-internal locators** — the old suite's 62 locators included 7 Material internals
and 2 icon-ligature-text matches.
Two traps: (a) `electron-app.ts:88-99` force-loads **7 named font faces** (Inter 400/500/600/700,
JetBrains Mono 400/500, `24px "Material Icons"`) before any assertion — with brand fonts and
Lucide those calls silently resolve against nothing and baselines flip between fallback and real
renders, so update the list here; (b) the `.monaco-editor:visible` filters (`:154-175`) exist
only because Golden Layout keeps inactive tabs' Monaco mounted — if Dockview unmounts inactive
panels, assert the new behaviour rather than inheriting the workaround. **Already measured: §6
"R5 RESOLVED" finding 4 — under the default renderer there is exactly one `.monaco-editor` in the
document per visible group, so drop the filter unless Task 10 chose `renderer: 'always'`.**
Gate: the ported Phase B specs green on both renderers.

**21. e2e coverage completion** — specs for surfaces Phase B didn't gate: palette, snippets,
object search, chat, ERD, table properties, docker panel.

**22. Visual baselines** — today: **11 PNGs** across 4 specs (`connected`, `connection-dialog`,
`dialogs`, `welcome`), mostly single-theme and already stale/RED per FOLLOW-UPS. Produce a
dark **and** light pair per major surface, then **inspect every PNG before committing** —
FOLLOW-UPS is explicit that `--update-snapshots` must not be run reflexively.
**Delivered — see "Phase C appendix — the React visual tier" below for how to run it and what has
to stay pinned.**

**23. Perf + a11y sweep** — grid at 100k rows, chat streaming, ERD at 200 tables,
`:focus-visible` on every interactive element, keyboard-operable resize handles and docking.
**Delivered — see "Phase C appendix — the perf tier and the a11y sweep" below.**

### Phase C appendix — the Angular → React e2e mapping table (Tasks 20+21, delivered)

**This is Task 24's evidence that deleting `tests/e2e/` loses nothing.** Every one of the **38
`test()` blocks in the 16 spec files of `tests/e2e/`** — the frozen Angular functional tier — mapped
to the React test that covers the same BEHAVIOR. Behaviors, not filenames: the React tier reorganised
by surface, so one Angular test sometimes maps to two React tests and vice versa.

**Result: 38 ported / 0 dropped.**

**Two things Task 24 must not assume this table covers:**

1. **`tests/e2e/visual/` is NOT in it, and no longer needs to be** — 4 specs / 11 tests / 11
   committed PNGs, all against the Angular renderer, mostly single-theme and RED per FOLLOW-UPS.
   **Task 22 replaced that tier rather than porting it**: `tests/e2e-react-visual/` (4 specs / 22
   tests / 22 committed PNGs, dark and light for every surface) is a sibling tree with its own
   snapshot directory, so **Task 24 may delete `tests/e2e/` wholesale — the visual subdirectory
   included — and lose nothing.** Delete `tests/__snapshots__/visual/` with it; the React tier's
   baselines live in `tests/__snapshots__/visual-react/`.
   _(This item previously said the opposite — that Task 22's deliverable lived inside `tests/e2e/`
   and Task 24 had to spare it. That was written before Task 22 chose the sibling tree.)_
2. **`tests/helpers/joinery-actions.ts` still owes the React tier two symbols**: `TEST_PG` and
   `ensureJoineryTestSeeded`, re-exported by `tests/helpers/react/app.ts` because they describe the
   seeded _container_ rather than any UI. Move them (to `tests/helpers/react/` or
   `tests/helpers/db-fixtures.ts`) before deleting the file. Everything else in it —
   `connectToTestPostgres`, `fillField`, `selectDatabase`, `openNewQueryTab`, `typeInEditor`,
   `executeQuery` — has Angular specs as its only consumers and dies with them.

| #   | Angular spec › test                                                                                   | React coverage                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `welcome-screen` › app launches and shows the welcome screen                                          | `welcome-screen` › launches showing the welcome tab, and its CTA opens the connection editor                                                                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | `welcome-screen` › clicking the welcome new-connection button opens the connection dialog             | same React test                                                                                                                                                        | asserts both halves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | `connection` › connects to test postgres and shows the explorer tree                                  | `connection` › creates a profile and connects with it, from an app with nothing saved; tree half in `explorer` › lazily reveals schemas, folders and the seeded tables | widened: the React test creates the profile through the dialog, where the Angular helper wrote it through the preload bridge                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | `connection` › database picker selects joinery_test                                                   | `connection` › the database picker selects joinery_test and the status bar follows                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | `connection` › status bar shows the active connection name                                            | same React test                                                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | `explorer` › expanding the joinery_test node reveals child schema/table nodes                         | `explorer` › lazily reveals schemas, folders and the seeded tables                                                                                                     | widened: folder layer + lazy loading, which the Angular tree had no concept of                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | `shell` › connection button opens the connection mat-menu                                             | **`shell`** (new) › the connection menu opens from the sidebar header and offers the connection actions                                                                | gap port. Angular asserted only that a panel appeared and said in a comment it would not check the options                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | `shell` › sidebar resize handle changes the sidebar width on drag                                     | **`shell`** (new) › the sidebar resize handle drags the sidebar wider **+** › is keyboard-operable, and the width survives a reload                                    | gap port + closes the **Task 8 keyboard-path deferral**: the Angular handle was a 4px pointer-only target (audit §1.9), the React one is the full ARIA window-splitter                                                                                                                                                                                                                                                                                                                                   |
| 9   | `tabs` › opens multiple query tabs alongside Welcome                                                  | **`tabs`** (new) › opens a query tab per ⌘N, alongside the welcome tab                                                                                                 | gap port. Simpler than the original: `new-query` passes `reuseEmpty=false`, so no editor has to be dirtied to defeat tab dedupe                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | `tabs` › clicking a tab makes it active                                                               | **`tabs`** (new) › clicking a tab activates it, and the menu next/previous walk the strip                                                                              | gap port + `menu:next-tab` / `menu:previous-tab`, uncovered in either tier                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 11  | `tabs` › closing a tab removes it from the strip                                                      | **`tabs`** (new) › closing a tab removes it, by its own button and by File ▸ Close Tab                                                                                 | gap port + `menu:close-tab`, uncovered in either tier                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 12  | `theme` › selecting Light writes data-theme="light"                                                   | `theme` › writes the resolved theme to `<html>` for each of the three states                                                                                           | widened: three states, plus › there is exactly one writer of `[data-theme]`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 13  | `theme` › selecting Dark writes data-theme="dark"                                                     | same React test                                                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 14  | `settings` › opens via menu:open-settings and shows theme + font controls                             | `settings` › opens from ⌘, and shows all four groups                                                                                                                   | same channel (`openSettings` fires `menu:open-settings`). Widened 1 → 10 tests: J-44's "a toggle that flips and changes nothing"                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | `query-editor` › opens a new query tab via menu:new-query                                             | **`tabs`** (new) › opens a query tab per ⌘N, alongside the welcome tab                                                                                                 | gap port — the channel had no React caller; `openQueryTab` uses the sidebar button                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 16  | `query-editor` › executes a SELECT and renders the result grid                                        | `query-editor` › runs a real query and puts its rows in the results pane                                                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 17  | `query-editor` › displays an error message on invalid SQL                                             | `query-toolbar` › reports a failed query in the pane rather than as a toast                                                                                            | moved surface: the React error lands in Messages, not a snackbar (J-42)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 18  | `query-editor` › Cmd+Shift+F formats SQL                                                              | `query-editor` › formats the SQL in place, undoably                                                                                                                    | widened: also asserts one undo step                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 19  | `query-editor` › execution persists a result snapshot visible in the history tab                      | `result-history` › **a plain execute is snapshotted by the main process, unpinned and unasked**                                                                        | Angular asserted main's AUTO-SAVE on execute (`query.ipc.ts:59-78`), so the React test must too: it captures nothing and polls for an UNPINNED row, pressing Refresh inside the poll because the write is a `setImmediate` after the reply. (Task 20 review fix — the row first cited a test that pins with `Capture`, which asserts the renderer's write instead.) Angular's second half, viewing a snapshot, is `result-history` › replaces the tab's result with a saved one, and says it is not live |
| 20  | `query-toolbar` › toolbar mounts with the expected controls                                           | `query-toolbar` › offers execute, refuses cancel, and reports the tab's target                                                                                         | strengthened: Angular was a soft `hasText: /run\|execute\|.../i` check on one button                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 21  | `query-toolbar` › export menu opens with CSV / JSON / SQL options                                     | **`results-grid`** › offers CSV, JSON and SQL export, and writes the file the menu picked                                                                              | gap port. Angular found the trigger by icon ligature; goes further — the export runs and the bytes are read back off disk, with only `dialog.showSaveDialog` stubbed                                                                                                                                                                                                                                                                                                                                     |
| 22  | `cross-schema-query` › app_meta.application returns the seeded 11 rows                                | `cross-schema-query` › same title                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 23  | `cross-schema-query` › app_meta.entity JOIN … returns the seeded 24 rows                              | `cross-schema-query` › same title                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 24  | `row-detail` › drawer shows the clicked displayed row after sorting, and navigates in displayed order | `row-detail` › shows the clicked DISPLAYED row after a sort, and navigates in displayed order                                                                          | widened 1 → 6 tests: FK follow, NULL, Escape                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 25  | `multi-connection-disconnect` › 1.4                                                                   | `multi-connection-disconnect` › 1.4: disconnecting the focused server keeps the other two in the tree                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 26  | `multi-connection-disconnect` › 1.5                                                                   | `multi-connection-disconnect` › 1.5: disconnecting a non-focused server kills exactly that one                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 27  | `test-connection-feedback` › artifact-bearing password shows the live warning                         | `test-connection-feedback` › appears for a paste artifact and not for a clean or international password                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 28  | `test-connection-feedback` › failed MSSQL test (ELOGIN) renders AUTH_FAILED guidance                  | `test-connection-feedback` › MSSQL (ELOGIN) shows the AUTH_FAILED guidance with the hygiene lines                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 29  | `test-connection-feedback` › failed PostgreSQL test renders auth guidance                             | `test-connection-feedback` › PostgreSQL shows auth guidance with the hygiene lines                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 30  | `backup-cli-deps` › backup dialog renders setup instructions when pg_dump is not on PATH              | `backup-cli-deps` › replaces the backup form with setup instructions when pg_dump is not on PATH                                                                       | widened: re-check and clipboard-copy. Both `test.skip`-gated on the same host condition                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 31  | `backup-restore` › postgres backup of joinery_test restores into a fresh database                     | `restore` › backs up the seeded PostgreSQL database and restores it into a database it creates                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 32  | `backup-restore` › mysql backup of joinery_test restores into a fresh database                        | `restore` › backs up and restores the seeded MySQL database into a fresh one                                                                                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 33  | `ui-actions` › Cmd+Shift+P opens the command palette                                                  | `palette` › opens on ⌘K or ⇧⌘P, filters, and closes on Escape                                                                                                          | the ⇧⌘P half was added by Task 20; it was previously only implied by `openPaletteFromEditor`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 34  | `ui-actions` › Cmd+P opens the object search dialog                                                   | `object-search` › opens on ⌘P and lists the seeded tables                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 35  | `ui-actions` › query history dialog opens via menu IPC                                                | `query-history` › records what was executed, and loads it back into a new tab                                                                                          | via `openQueryHistory`, which fires `menu:query-history`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 36  | `ui-actions` › object search input accepts typed input and shows a result region                      | `object-search` › ranks the exact match first and refuses an unrelated one                                                                                             | strengthened: Angular explicitly did **not** assert results ("indexing may not be populated in test")                                                                                                                                                                                                                                                                                                                                                                                                    |
| 37  | `ui-actions` › shortcuts dialog opens via menu IPC                                                    | `palette` › the same cheatsheet arrives from Help ▸ Keyboard Shortcuts                                                                                                 | via `openShortcuts`, which fires `menu:show-shortcuts`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 38  | `ui-actions` › docker panel opens from the status-bar indicator                                       | `docker-panel` › the pip reports the running containers, and the panel lists the real ones                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Phase C appendix — the React visual tier (Task 22, delivered)

**`tests/e2e-react-visual/` — 4 specs / 22 tests / 22 committed PNGs** in
`tests/__snapshots__/visual-react/`: 11 surfaces × the dark/light pair, which is the gap this task
existed to close (the Angular tier is almost entirely single-theme, so a regression on one canvas had
nothing to fail against). A **sibling** of `tests/e2e-react/`, not a subdirectory of it: that project
discovers by a plain `testDir`, so a nested `visual/` would have been swept into the functional tier
and changed its count.

**How to run it.**

```bash
pnpm run test:harness:up                                              # Docker DBs — the fixtures ARE the containers
pnpm run build                                                        # required, and NOT automatic here
pnpm exec playwright test --project=visual-react                      # verify
pnpm exec playwright test --project=visual-react --update-snapshots   # re-shoot (never reflexively — inspect every PNG)
```

There is **no `test:visual:react` script and no `pre*` build hook, on purpose**: Task 22 was
forbidden from touching the root `package.json`. The missing hook fails loudly rather than
mysteriously — `launchJoinery` throws a named "run `pnpm run build` first" error against a stale
build. Whoever is next allowed to edit `package.json` should give the tier a script.

**The two host variables that must stay pinned.** Both are pinned in the `visual-react` project's
`metadata` and re-asserted on every launch by `tests/e2e-react-visual/fixtures.ts`, so neither can rot
into decoration. Each one's failure signature when it breaks:

| Pin                           | Mechanism                                                                                                                                                         | Failure signature if it ever stops being honoured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceScaleFactor: 1`        | Chromium's `--force-device-scale-factor`, passed through Electron                                                                                                 | Every baseline fails on image **size** before a single pixel is compared (a 2× display produces 2800×1800 for a 1400×900 window) — a red tier that says nothing about the UI. This is J-21 / ledger Ruling 5, the defect that killed the Angular tier. The fixture asserts `window.devicePixelRatio` and names the ratio instead.                                                                                                                                                                                                                    |
| `macScrollBarStyle: 'Always'` | Cocoa NSArgumentDomain pair `-AppleShowScrollBars Always` in the Electron argv — per-process, so **nothing on the host is mutated and nothing needs cleaning up** | macOS resolves its default `Automatic` from the attached pointing device: legacy scrollbars take 15 CSS px of layout width out of every scrolling panel, overlay ones take none, and the React renderer styles no scrollbars of its own. Measured: baselines captured in legacy mode fail **3 of 22** outright in overlay mode, with a 4th passing only inside the pixel tolerance. The fixture measures a scrolling container's gutter (inside a CSS-free iframe, so a future `::-webkit-scrollbar` rule cannot fool it) and fails naming the mode. |

The structural long-term fix for the scrollbar half is to style the app's scrollbars so the platform
mode stops changing layout at all — a `packages/` change, out of scope for Task 22, worth doing
whenever the renderer next touches scroll containers. Until then the pin is the whole answer, and it
is macOS-only, as is this tier generally (its fixture paths are POSIX literals).

**Comparison tolerance.** The `visual-react` project sets its own `expect.toHaveScreenshot`
(`maxDiffPixels: 20`, `threshold: 0.2`) instead of inheriting the root's `maxDiffPixelRatio: 0.01`,
which on a 1115×798 baseline would allow 8,897 differing pixels. Sized from measurement: three
independent full re-captures drifted by at most **8 px**, and a full run at `maxDiffPixels: 0` passed
22/22. 20 is below the smallest real artefact this tier has caught (Monaco's caret, a 2×20 = 40 px
rectangle). Note that a project's `expect` **replaces** the root's rather than merging with it, which
is why `timeout: 10000` is restated there.

**Mask conventions — 3 mask regions, landing on 4 of the 24 baselines; the other 20 are compared
whole.** `status-version` and `status-docker-count` on the two connected-shell shots (a version bump
and the host's container count are not UI regressions), and the `Docker: N of M …` note — not the
card — on the two welcome shots. Everything else is unmasked, and no dialog, workbench or overlay
baseline passes a mask at all. Two guards keep that honest: `shoot` asserts every mask locator
resolves before capturing (Playwright **silently ignores** a mask that matches nothing, which is
exactly how a mask outlives its element and the baseline quietly starts recording volatile pixels
again), and the masked elements are waited for at full width first, because both **grow** when their
IPC lands.

**The Docker panel was not captured at Task 22, and is captured now (J-76).**
`services/docker/detector.ts` filters by image name, not by compose project, so the panel was a
picture of one laptop's container inventory — and its per-row status line ("Up 44 minutes (healthy)")
changes every minute, so masking it would have masked the surface into meaninglessness. That needed a
deterministic source behind `docker.detect`, which is a `packages/` change Task 22 was forbidden from
making; J-76 added it (`packages/main/src/services/docker/docker-fixture.ts`, pinned per launch by
`JOINERY_DOCKER_FIXTURE`), so the two Docker baselines are compared **whole, with no masks** — the
22 above became 24. A streamed chat transcript is still absent for the sibling reason: no test here
calls an LLM, and a fake provider is also a `packages/` change. Flagged, not forgotten.

### Phase C appendix — the perf tier and the a11y sweep (Task 23, delivered)

**A fifth Playwright project, `perf-react` (`tests/e2e-react-perf/` — 3 specs / 5 tests), plus
`tests/e2e-react/a11y.spec.ts` (11 tests) in the functional tier.** The perf tier is separate rather
than tagged because its specs are slow by construction, and it is a sibling directory for the same
reason `e2e-react` and `e2e-react-visual` are: `e2e-react` discovers by a plain `testDir`, so a
nested directory would join it and change its count.

### The a11y claim, scoped

The plan row says "`:focus-visible` on every interactive element". What is delivered is **narrower
than that sentence and stronger than it sounds**, and both halves are worth stating exactly:

- **Runtime-verified**, by walking the real tab order in the shipped bundle and asserting every stop
  matches `:focus-visible` **and** draws a visible indicator: the connected shell, the connection
  editor, **all four** settings groups, the command palette, the backup dialog, the restore dialog,
  the query tab (in two segments — see below), the shell with the chat panel open, and the ERD tab.
  **13 walks, 203 focus stops.** Each walk is attached to its test as a markdown table naming every
  stop, its role, its `--tw-outline-style`, and its full class list, so the inventory is a run
  artifact rather than a claim in a report.
- **Statically verified elsewhere** — schema diff, execution plan, AI analysis, the Docker panel,
  tours, object search, snippet library, query history, the database dialogs, table properties. Two
  facts carry it, both checked: `outline-hidden` appears **only** in `src/ui` across the whole
  renderer, so the Tailwind trap below cannot exist outside the directory the `cn()` guard scans;
  and every raw `<button>`/`<input>` in the unwalked features carries a `focus-visible:outline-*`
  ring, while every other unwalked feature has zero raw interactive elements and goes through the
  `src/ui` primitives.

**Four exemptions, each with its own positive check**, because four kinds of stop cannot be judged
from the focused element's own computed style: Monaco and AG Grid draw their indicator on a
different element; the command overlay's field is its surface's only focus stop, so the caret is the
indicator; and a Radix roving-focus group root (`TabsList`) cannot hold focus at all — `.focus()` on
it leaves `document.activeElement` on the selected tab.

A fifth case is handled in the measurement rather than excused: `has-focus-visible:` puts the ring on
an ancestor (`ui/switch.tsx`, `ui/field.tsx`). **That credit is differential**, and getting it wrong
once is worth recording. The first version asked `ancestor.matches(':has(:focus-visible)') && draws`
— but `:has(:focus-visible)` is true for _every_ ancestor of a focused element, so the only real test
left was "does anything up there paint". `ui/dialog.tsx`'s `DialogContent` carries an unconditional
`shadow-overlay`, and **seven of the thirteen walked surfaces are built on it**, so a genuinely
ringless control in any of them would have been waved through — the exact defect class this sweep
exists to catch. The credit now compares each candidate ancestor's painted outline and box-shadow
**while the stop is focused** against the same ancestor **after focus leaves**, and counts only a
level that both paints and changes. The focused half is captured during the walk itself, under a real
Tab press, because a later programmatic re-focus cannot reproduce `:focus-visible` reliably and a
roving-focus root forwards focus away the instant it gets it.

Measured across the 203 stops: **163 self-indicated, 10 ancestor-credited** (every one a `Switch`
track), **30 uncredited** — 28 AG Grid cells and headers, the palette field, and a `TabsList`, all
four of which are exemption-covered. Under the loose version the palette field and the `TabsList`
read as ancestor-credited, which is what hid them.

```bash
pnpm run test:harness:up      # Docker DBs
pnpm run test:perf:react      # builds first (pretest hook), then runs the 5 perf tests
pnpm run test:visual:react    # the script the Task 22 appendix asked the next person to add
```

**The threshold rule, stated once in `tests/e2e-react-perf/fixtures.ts` and followed everywhere.** A
wall-clock number measured on a laptop is a fact about that laptop, and a suite that goes red when
somebody opens a browser is a suite people learn to ignore. So the real gates are **structural** —
DOM row counts, mutation counts, node counts, all independent of host speed — and every duration is
a **generous outer bound sized from a recorded median**, with the median in the constant's own
doc-comment. Task 17's benchmark is the model.

**What was measured** (development machine; every run writes its own numbers to a JSON attachment
beside the test):

| Gate                       | Measured                                                                                                                                               | Asserted                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Grid, 100,000 rows         | first paint 379/380/392 ms; sort 88/90/103 ms; **31** `.ag-row` elements in the DOM; 0 long tasks on scroll                                            | <200 rows in the DOM, <10s paint, <5s sort, <500 ms blocking on scroll |
| Grid scroll isolation      | **0** sidebar mutations while scrolling row 1 → row 100,000                                                                                            | exactly 0                                                              |
| ERD, 200 tables            | 826/835/838 ms to a drawn diagram (incl. 400 IPC calls for columns+keys); 1 long task of 52–54 ms, TBT 2–4 ms                                          | <20s draw, <5s blocking, not truncated, 100 < nodes < 200              |
| ERD re-activation          | 79 ms, same node count                                                                                                                                 | node count unchanged, exactly one ERD tab                              |
| Chat streaming, 600 chunks | **91 chunks/s**; **108** mutations on the streaming message for 120 coalescer flushes; **0 / 0 / 0** on the 50 prior messages, the grid and the editor | the three zeros, and <3 mutations per flush                            |

The chat spec is Task 17's `.superpowers/sdd/PLAN/task-17-perf.mjs` made durable — that file is
gitignored scratch, so nothing ran it and nothing failed when the property stopped holding. It needed
one addition to the shared launcher: an opt-in **`seedUserData`** hook on `withJoinery`, which writes
into the launch's isolated user-data dir before Electron starts. `ChatService` loads
`<userData>/chat-history/` in its constructor, and a 50-message transcript with one message still
streaming has no IPC channel to arrive through.

**The walk has to tell a cycle from a trap.** Its first version keyed "have I been here?" on
`${data-testid}#${tag}`, which is neither unique nor able to detect "Tab did not move focus" — and
both failure modes fired, silently truncating 2 of 7 walks while reporting clean cycles. It now
stamps an attribute per visited element and reports four distinct outcomes (`cycled`, `stuck`,
`left-document`, `cap`). The tails that recovered were not empty: the ERD walk went 11 → 21 stops,
and the query tab needs **two segments** because Monaco binds Tab to "insert a tab character" and
genuinely cannot be left by keyboard — the second segment resumes at the results pane and runs 47
stops through AG Grid, the status bar and back round to the sidebar. Monaco's trap is asserted, not
worked around; **that a keyboard user cannot Tab out of the SQL editor is a real finding and a
follow-up**, not something this task papers over.

**Three traps this task found, and all three are now guarded.**

1. **`outline-hidden` silently erases a `:focus-visible` ring.** Tailwind v4 compiles `outline-hidden`
   to `--tw-outline-style: none` and every `outline-<width>` utility to
   `outline-style: var(--tw-outline-style)`, so the two on ONE element produce a 2px outline drawn in
   style `none`. The element has a `focus-visible:` rule, passes every source scan, and shows
   nothing. It had eaten the explorer tree's ring (`ui/tree.tsx`), which is the app's single tab stop
   for the whole sidebar. `focus-visible:outline-solid` restores it, and
   `ui/contract.spec.tsx` now walks every `cn(…)` argument list in `src/ui` — per call, because this
   codebase splits a `cn` across lines and because `switch.tsx` legitimately suppresses on one
   element and rings another.
2. **A fixture database that outlives its tier is a fixture every tier shares.** The 200-table ERD
   schema, left on the container, turns the visual tier's two `shell-connected` baselines red: the
   explorer lists every database on the server, and those screenshots include the explorer. It is
   dropped in `afterAll` **and** at the top of `beforeAll`, so a killed worker cannot poison the next
   tier. (Ordering across projects is safe today only because `workers: 1` and `perf-react` precedes
   `visual-react` in `playwright.config.ts` — implicit, and now written down where it matters.)
3. **An exemption pinned to a vendor class silently stops covering its surface.**
   `MONACO_EXEMPTION` matched `textarea.inputarea`; the Monaco build this app ships focuses
   `div.native-edit-context` (the `EditContext` input path), so the exemption had never matched a
   single stop. It now matches both, and the query-tab spec asks the exemption's own predicate rather
   than spelling a class name out a second place.

**Also fixed:** Radix gives `TabsContent` `tabIndex={0}`, so a Tab press from a tab trigger lands on
a panel that had no focus treatment at all. It has one now, `:focus-visible` only, so a pointer-driven
tab change is unchanged.

**And the test tree now typechecks.** `pnpm run typecheck` was `turbo run typecheck`, which runs one
task per package — and no package's tsconfig includes `tests/`, so every Playwright spec and helper
in the repo was checked by nothing. `tsconfig.tests.json` plus a `typecheck:tests` script closes it;
the root `typecheck` runs both.

**Keyboard docking** (`shell/workspace/panel-docking.ts`) closes the other half of the plan line —
the resize handles got their keyboard half in Task 7, docking was drag-only. Option+Arrow splits the
focused tab into a new group on that side; Option+Shift+Arrow moves it into the previous/next
existing group; both are also in the tab context menu, which Radix opens on Shift+F10. The keys are
attached natively to Dockview's `.dv-tab`, not through a React `onKeyDown`, because that element —
not this app's subtree — carries `role="tab"` and the roving `tabIndex`, so it is what has focus when
a key is pressed.

**Open, and deliberately not fixed here:**

- **A 200-table diagram cannot be seen whole at any zoom the toolbar offers.** Dagre lays it out
  around 42,000px wide, `MIN_ZOOM` is 0.1 (`features/erd/erd-viewport.ts:37`), and the cull margin
  gives roughly 33,000px of reach — so fit-on-load is clamped (the readout says 10% the moment the
  diagram appears), 176 of 200 nodes render, and further zoom-out presses are no-ops. Wants a minimap
  or a lower floor. A feature gap, not a performance regression.
- **A keyboard user cannot Tab out of the SQL editor.** Monaco binds Tab to "insert a tab
  character", and its own escape hatch (`⌃M`, `editor.action.toggleTabFocusMode`) does not reach the
  editor through Electron here — tried, and it left the walk still trapped. The a11y walk asserts the
  trap rather than hiding it, and covers the rest of the query tab in a second segment. Fixing it
  means configuring Monaco's `tabFocusMode` or binding an explicit escape, which is a `features/query`
  change rather than a sweep.
- The perf tier's grid spec is **PostgreSQL-only** (`generate_series`). Covering MySQL and SQL Server
  would triple the slowest tier's runtime to measure the same React component.
- Screen-reader behaviour beyond focus/contrast/keyboard remains out of scope per §8.

### Phase D — Cutover (Task 24)

**24. Cutover.** Everything in §3.1's last bullet: rename `renderer-react` → `renderer`, delete
the Angular package and its 7 specs, drop the `typescript` override and the four Angular
accelerators from `allowBuilds`, remove the `JOINERY_RENDERER` indirection, delete the old
e2e helper parameterization.
Gate: standard + full `pnpm run test:full` + `pnpm run package:mac` + `pnpm run verify:package`

- a manual launch of the packaged `.app` connecting to all three engines.

**The two AG Grid de-duplication workarounds must go with the Angular package, and one of them is a
landmine on the rename itself.** Both exist only because `nodeLinker: hoisted` gives the repo root a
single version of each package and that slot belongs to the Angular renderer's
`ag-grid-community@35`, so `ag-grid-community@36` lands twice on disk — once beside
`packages/renderer-react`, once nested under `ag-grid-react` — and `ModuleRegistry` is module state.
Task 11's report §1 has the full failure (AG Grid error #200: sorting, filtering, selection and
auto-size silently absent). Deleting the Angular package frees the root slot and both workarounds
become dead weight:

1. `packages/renderer-react/vite.config.ts` — `resolve.dedupe: ['ag-grid-community']`. Harmless if
   left, but it is a comment claiming a problem that no longer exists.
2. **`vitest.config.ts` — the renderer-react project's `alias` for `ag-grid-community` is an ABSOLUTE
   PATH containing `packages/renderer-react/node_modules/…`, plus
   `server.deps.inline: ['ag-grid-react']`.** This task RENAMES that directory, so the alias points at
   a path that no longer exists and **the whole `renderer-react` vitest project fails to resolve** —
   every React unit test, on the cutover PR, from a config file the rename otherwise never touches.
   Delete both keys (preferred: the root slot is free, so nothing is needed) or repoint the alias to
   the new package path in the same commit as the rename.

### Phase D appendix — the cutover, as delivered (Task 24)

**Delivered.** `packages/renderer` is the React app; the Angular package, its 16 e2e specs and its
11 visual baselines are deleted. Six things the plan above did not predict, recorded because the
next reader will otherwise re-derive them — this list is the single index of where the cutover
departed from §3.1:

1. **`protobufjs` is not an Angular CLI accelerator.** §3.1 lists it with `lmdb`,
   `msgpackr-extract` and `nice-napi` as the four to drop from `allowBuilds`. The other three left
   the lockfile with Angular; this one did not — it arrives through `@grpc/proto-loader` — so it
   stays enabled, with a corrected comment.

2. **The `optimizeDeps.include: ['@joinery/shared']` workaround did NOT go.** §3.1 pencils the real
   fix (emitting ESM from `packages/shared`) in for this PR. It is a dual-emit or an `exports` map
   plus a main-process verification pass, because `packages/main` is CommonJS and consumes the same
   `dist` — real work, unrelated to deleting Angular. Follow-up.

3. **The legacy localStorage module was NOT retired**, though §3.1 says deleting the six keys
   "retires that whole module". It cannot: a profile that has only ever run the Angular app has its
   snippet library in those keys and nothing in `AppState`, so the one-shot lift must still run.
   The change is leave-in-place -> migrate-then-delete, guarded on the write being acknowledged,
   and never for an unparseable key or an `already-migrated` boot. See `persistence/migration.ts`.

4. **`scripts/verify-package.js` now checks the renderer**, which closes the gap §3.1 names: it
   asserts `index.html` is in the asar, every asset URL is relative (the `base: './'`
   non-negotiable), and every file `vite build` emitted is inside the archive (210 at the cutover),
   compared tree-to-tree rather than by naming a few paths.

5. **The test tiers keep their `-react` suffixes** (`tests/e2e-react`, `-visual`, `-perf`, the
   Playwright project names, `withJoineryReact`). `tests/__snapshots__/visual-react/` is keyed by
   them and renaming would rewrite 22 baselines for cosmetics. Reasoning lives in
   `playwright.config.ts`'s header, where the next reader hits it.

6. **The theme mirror kept its key and lost its fallback.** §3.1 asked both questions; the answers
   are "stays" (the pre-mount FOUC script has no other synchronous source) and "goes" (the migration
   now deletes `joinery-settings`, so the fallback would be live for at most one boot). The cost —
   one boot of the default canvas for a profile migrating from Angular — is stated in
   `persistence/theme-mirror.ts` and asserted in `state/settings.spec.tsx`.

The claim §3.1 makes about the six hard-coded renderer paths held exactly: **none of them changed.**

---

## 5. Decisions for Craig

**A. Radix UI as the Material replacement — or hand-rolled primitives?**
_Recommendation: Radix._ The Material surface being replaced is 16 dialog files, 129 tooltips,
127 form fields, 76 tabs, 70 menus, 44 selects. Hand-rolling means owning six focus traps,
six sets of `aria-*` wiring, and portal collision detection — and the audit already shows what
happens when this app hand-rolls overlays (24 implementations, 3 mechanisms, no `:focus-visible`).
Radix ships unstyled, so `design/` applies with no fight and the "one layer of magic" rule in
CLAUDE.md holds. Cost: ~8 small runtime deps. Say no if you'd rather own every line.

**B. AG Grid (port) or TanStack Table + Virtual (rewrite)?**
_Recommendation: AG Grid 36 via `ag-grid-react`._ The current usage is shallow enough to port
in one task, and it already meets CLAUDE.md's >1000-row rule. TanStack means re-implementing
column resize/reorder, multi-sort, range selection and clipboard to reach parity — real weeks,
for a lighter bundle that a desktop app doesn't need. Say TanStack if you want the grid fully
owned and are willing to spend three tasks on it instead of one.

**C. Does the saved Golden Layout config have to survive the swap?**
_Recommendation: no — migrate by reset._ `AppState.goldenLayoutConfig` is Golden Layout's
serialized tree; Dockview's is different. A translator is real work for a single user's window
arrangement. Cheaper: on first React launch, ignore `goldenLayoutConfig`, rebuild the workspace
from the still-valid `saveTabs`/`getTabs` list (which holds everything that matters — type,
title, connection, database, content, dirty, pinned), and write a Dockview config from then on.
The `LayoutConfig` type in `app-state.types.ts` stays, holding a different shape. **This is the
one place the plan touches persisted-data semantics, so it needs your yes.** Say no and Task 7
grows a translator.

**D. Should the SHOULD tier ship in v1?**
_Recommendation: onboarding tours and Docker panel yes; execution plan, AI analysis panel, and
schema diff deferred to v1.1._ The last three are single-entry-point surfaces (two are
palette-only) totalling ~1,700 LOC, and the schema-diff dialog doesn't actually diff — it
generates a comparison query. Deferring them takes ~1.5 tasks off the critical path. Say
otherwise if any of them is something you personally use.

---

### Decisions resolved (Craig, 2026-08-15 — binding)

- **A: Radix.** Unstyled primitives; the licensed design skills style them.
- **B: AG Grid 36 via `ag-grid-react`** — port, not TanStack rewrite.
- **C: Migrate by reset.** `goldenLayoutConfig` is ignored on first React launch; the workspace rebuilds from `saveTabs`/`getTabs` (which must be fully preserved); Dockview config written from then on. No translator.
- **D: OVERRIDDEN — nothing defers.** Execution plan, AI analysis panel, and schema diff all ship in v1 alongside onboarding tours and the Docker panel. The SHOULD tier is v1 scope in its entirety; the task list grows accordingly (the ~1.5 reclaimed tasks return to the critical path).

## 6. Risks

**R1 — Monaco under Vite + Electron `file://`.** The current AMD loader hack
(`query.component.ts:1221-1241`) exists because someone fought this. ESM Monaco needs 5 web
workers resolved relative to `base: './'`, and `@monaco-editor/react`'s CDN default is flatly
wrong here. _Mitigation:_ Task 10 begins with a spike that builds the editor, opens the
**packaged** app (not just `pnpm dev`) and confirms workers load, IntelliSense fires, and no
`will-navigate`/CSP violation appears. If ESM workers fight the file protocol, fall back to
`monaco-editor/esm/vs/editor/editor.main` with `MonacoEnvironment.getWorkerUrl` returning a
blob shim — decided in the spike, not mid-task.

**R2 — Grid performance regression.** CLAUDE.md requires virtualization >1000 rows and
`maxRowsToDisplay` defaults to 10,000 (`settings.types.ts`). A React port can accidentally
re-render 10k rows per keystroke through a badly-scoped store selector. _Mitigation:_ Task 11's
gate includes a 100k-row scroll/sort/filter assertion against `plans/perf-baselines.md`; the
grid subscribes to Zustand with `useShallow` and never to whole-store slices; row data is
passed by reference, never mapped in render.

**R3 — Chat streaming re-render pressure.** `onStreamChunk` fires per token and the panel
re-renders markdown → highlight.js → sanitize on every chunk. Angular's `OnPush` +
`ChangeDetectorRef` masked some of this; React will not. _Mitigation:_ Task 17 coalesces chunks
on a ~50ms rAF boundary, keeps in-flight text in a ref (not state) until the boundary, memoizes
`<Markdown>` per completed message, and re-parses only the streaming tail. Gate is a measured
benchmark, not a vibe.

**R4 — Packaging regression discovered only at Task 24.** The pnpm-hoisted-`node_modules`
comment in `pnpm-workspace.yaml` documents an app that "packaged and signed cleanly but crashed
on the first database connection." _Mitigation:_ Task 1 runs `pnpm run package:dir` +
`verify:package` against the placeholder React renderer and records the result. Every task after
Task 7 that adds a native-ish dep (Monaco workers, AG Grid, fontsource) re-runs
`pnpm run package:dir`. Cutover is then a rename, not a discovery.

**R5 — Dockview doesn't fit.** The tab workspace is load-bearing for five surfaces and the
requirements are specific: custom tab renderers for dirty/pinned/rename, JSON serialization,
and imperative add/focus/close driven by `tab.state`. _Mitigation:_ Task 7 spikes Dockview
against those four requirements _before_ building the shell around it. Documented fallback:
`react-resizable-panels` for the fixed splits plus an owned tab strip — less capable, fully
understood, and it retires the same Golden Layout debt. Decide in the spike; do not discover it
at Task 17.

**R5 RESOLVED (Task 7, Dockview 8.1.0 — spike evidence in `.superpowers/sdd/PLAN/task-7-spike.json`).**
All four requirements pass; **the fallback is not needed** and Dockview is the workspace.
Measured in a real Chromium, not read from docs:

1. _Custom tab renderers_ — `tabComponents` receives full React components. A dirty flag set in
   `tabStore` **after** the panel existed reaches the header with no `panel.update()` call, so tab
   headers subscribe to the store and `params` stay a serialization vehicle. Inline rename works,
   but a tab is a drag source: without `stopPropagation` on pointerdown/mousedown the input cannot
   be focused or selected.
2. _JSON serialize/restore_ — `toJSON()`/`fromJSON()` round-trip panel ids, group count and the
   active panel exactly, and the blob is `structuredClone`-able, i.e. it survives the IPC boundary.
3. _Imperative add/focus/close from `tabStore`_ — works, with one trap: **`addPanel` with no
   `position` creates a NEW GROUP per panel** (four tabs became four side-by-side groups). Tabs must
   be placed `within` an existing tab panel's group.
4. _Inactive panels_ — with the default `onlyWhenVisible` renderer the panel's React component
   **stays mounted** (no remount, local state survives a tab switch) while its **DOM subtree is
   detached from the document**: `document.querySelector` cannot find it and exactly one copy per
   visible group is in the tree. Opting a panel into `renderer: 'always'` keeps the DOM attached
   instead (all N queryable, one visible).

Two consequences for later tasks, and they are the reason this block exists:

- **Task 20's `.monaco-editor:visible` workaround is unnecessary under the default renderer** —
  there is only ever one `.monaco-editor` in the document per visible group, so assert the new
  behaviour as §Task 20 trap (b) instructs. It becomes necessary again _if_ Task 10 opts query tabs
  into `renderer: 'always'`.
- **Task 10 must call Monaco's `layout()` when a query tab is re-activated.** Under the default
  renderer the editor's host node is detached while hidden, so it comes back with stale (zero)
  measurements. `renderer: 'always'` avoids that at the cost of keeping every editor's DOM alive —
  a real trade to make with the R2/R3 perf work, not by default.

---

## 7. IPC contract warts — flagged, not redesigned

The React renderer consumes `window.joinery` exactly as it is. Logged for a later, separate PR
(line numbers are `packages/preload/src/index.ts` unless noted):

1. `connection.test`/`save` take **three consecutive optional `string`s** —
   `(profile, password?, sshPassword?, sshPassphrase?)` (`:83-94`). Any two transpose silently.
2. `explorer.getEnrichedColumns` returns a **15-field anonymous inline type** (`:215-238`) that
   no consumer can import by name. It belongs in `database.types.ts`.
3. `query.convertSql(sql, fromEngine: string, toEngine: string)` (`:249-253`) — bare strings
   where a `DatabaseEngine` union exists.
4. `queryResults.saveSnapshot` takes **5 positional args** (`:257-263`), two adjacent strings.
5. `app.setState(partial)` (`:361`) is an **unvalidated deep merge** — the renderer can write
   any shape into persisted state.
6. `chat.onStreamChunk` is a **single global subscription** (`:310`); per-conversation fan-out
   happens in the renderer, so every chat instance wakes on every token.
7. **Split-brain persistence.** `AppState` lives in main while every `AppSettings` value lives in
   renderer `localStorage` (`settings.service.ts:129,149`) — even though `AppState.aiSettings`
   proves settings _can_ live in main. This is what makes 0.5 necessary.
8. `logs.append` (`:344`) lets the renderer write arbitrary log entries, unthrottled.
9. Two disjoint channel trees, `IPC_CHANNELS` and `CHAT_IPC_CHANNELS`, with no shared naming.
10. **No menu channel for the palette-only surfaces** (snippets, object search, settings) —
    which is why the renderer grew 9 `joinery:*` DOM events, 8 of them dead (0.4).

Also, unrelated to the contract but confirmed while reading it: there is **no CSP, no
`will-navigate` guard and no `setWindowOpenHandler`** anywhere in main or preload, despite
`sandbox: true` — flagged in-code at `markdown-viewer.component.ts:234` and in FOLLOW-UPS.

---

## 8. Out of scope

- Any change to `packages/main`, `packages/preload`, `packages/shared` — including the §7 warts.
- `vitest.integration.config.ts` and the integration tier (constraint).
- New features. `plans/UX-IMPROVEMENTS-ROADMAP.md` stays a roadmap; discoveries go to
  `plans/rebrand/FOLLOW-UPS.md`.
- The FOLLOW-UPS security items (`will-navigate`, CSP, mermaid `<style>` escape, leaked `sa`
  password). The CSP must not ride in a UI PR — but adding one later interacts with Monaco
  workers, so Task 10's spike checks its own CSP compatibility.
- Screen-reader audit beyond the focus/contrast/keyboard work in Task 23.
- Window-size responsiveness — fixed 800×600 minimum; panel adaptation is `@container` (0.7).
