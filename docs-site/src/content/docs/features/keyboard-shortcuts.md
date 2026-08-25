---
title: Keyboard shortcuts
description: The in-app cheat sheet (⇧⌘/), what its Menu / App / Editor column means, and which keys differ on Windows.
sidebar:
  order: 7
---

**⇧⌘/** — or **Help ▸ Keyboard Shortcuts** — opens a sheet listing every binding Joinery has. The
[command palette](../command-palette/) has an entry for it too.

The sheet is not written by hand. Every row comes from the same table the palette and the
application menus are built from, and a test compares the keystrokes in that table against what the
Electron menus actually register — so a binding that changes in the app changes here, and one that
disagrees fails the build.

## What it shows

![The keyboard shortcuts sheet: bindings laid out in two columns under group headings such as File and tabs, Query, Editor and View, each row giving a command name, its source — Menu, App or Editor — and its keystroke.](../../../assets/screenshots/keyboard-shortcuts-dark.png)

**28 rows** — the 27 commands that carry a keystroke, plus the palette's own opener, which belongs
to no command. They are grouped the same eight ways the palette groups its entries, and empty groups
are not drawn.

Each row is the command's name, a **source** column, and every binding that reaches it — not just
the primary one, which is all a palette row has room for. _New connection_ has two: **⇧⌘N** (File ▸
New Connection) and **⇧⌘C** (Server ▸ Connect…).

## The source column

It answers "why does this key work here but not there?".

| Source     | Bound by                                                                 | Consequence                                                                                        |
| ---------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Menu**   | An Electron menu item (23 commands)                                      | The keystroke never reaches the page at all — the menu fires and sends the command                 |
| **App**    | A key listener in the window (3 commands, plus the palette's own opener) | ⌘J, ⌘P and ⌥⌘S, and ⌘K / ⇧⌘P. These must avoid every registered menu accelerator, or the menu wins |
| **Editor** | Monaco itself (1 command)                                                | ⌘E. The menu shows it but deliberately does not bind it, so the editor can                         |

Those are command counts, not keystroke counts: the 23 menu commands carry **24** bindings, because
_New connection_ has two. The palette's opener is a fourth **App** row even though it belongs to no
command.

The Menu-beats-App rule is why the [snippet library](../snippets/) is on ⌥⌘S and not ⇧⌘S: ⇧⌘S is
File ▸ Save Query As, so a window-level listener on it would never have run.

**Editor keys need the editor.** The four keystrokes Monaco carries for this app — ⌘E, ⌘↩ and F5 to
execute, and ⌃M below — reach it only while the caret is in a SQL editor, and with several query
tabs open they act on the editor you are typing in. From the results grid or the sidebar, use
Query ▸ Execute or the command palette instead; both run the active tab.

## Getting out of the SQL editor

Tab inserts a tab character in the SQL editor. That is the right thing for writing SQL and the wrong
thing for a keyboard-only user, who would otherwise have no way to leave the control at all.

**⌃M** is the way out — the same physical keys on both platforms, written `Ctrl+M` on Windows.
Press it and Tab moves focus to the next element instead of indenting; press it again and Tab
indents again. The editor announces which mode it is in each time, so a screen reader says what
changed.

> **⌃M is not listed in the ⇧⌘/ sheet yet.** Being bound by Monaco is not what keeps it out — ⌘E is
> bound by Monaco too, and it is listed, because it has an entry in the command table. ⌃M has no
> entry in the command table and none in the surface-shortcut list either, and those two lists are
> what the sheet is built from. That is a known gap, and giving it an entry is planned.

## On Windows

Most bindings swap ⌘ for Ctrl and are otherwise the same. **Five are genuinely different keys:**

| Command           | macOS | Elsewhere      |
| ----------------- | ----- | -------------- |
| Find and replace  | ⌥⌘F   | Ctrl+H         |
| Execute selection | ⇧⌘↩   | Ctrl+Shift+E   |
| Cancel query      | ⌘.    | Alt+Break      |
| Next tab          | ⇧⌘]   | Ctrl+Tab       |
| Previous tab      | ⇧⌘[   | Ctrl+Shift+Tab |

A sixth binding is written per platform without being a different key: the snippet library is ⌥⌘S on
macOS and `Ctrl+Alt+S` elsewhere — the same S, with each platform's own name for the two modifiers.

The sheet always shows the bindings for the platform you are running on. On macOS it renders them as
glyphs, in the macOS modifier order — ⌃ ⌥ ⇧ ⌘ — no matter how the binding was written. Elsewhere it
prints them as words, and resolves the cross-platform `CmdOrCtrl` spelling to the key you actually
press: a binding written `CmdOrCtrl+N` reads as `Ctrl+N`. The
[reference table](../../reference/keyboard-shortcuts/) prints the same thing.

> **Note** — the [keyboard shortcuts reference](../../reference/keyboard-shortcuts/) is the same
> list on this site, generated from the same table, with the macOS and Windows bindings side by
> side rather than one platform at a time.

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                                           | Source                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ⌃M toggles tab-focus mode, through the command path rather than `getAction`                     | `packages/renderer/src/editor/sql-editor.tsx:436-478`                                                                                |
| The editor's four keys are scoped to the editor holding focus, and released when its tab closes | `packages/renderer/src/editor/sql-editor.tsx:104-123, 379-421, 490-493`, `editor/sql-editor.spec.tsx` — 'keybinding lifetime'        |
| Pressing it frees Tab from the editor, verified by driving the real app                         | `tests/e2e-react/a11y.spec.ts` — 'the SQL editor has a keyboard way out'                                                             |
| The sheet is built from the command table PLUS the surface-shortcut list, and ⌃M is in neither  | `packages/renderer/src/features/shortcuts-dialog/shortcuts-dialog.tsx:79, 95`, `features/command-palette/palette-actions.ts:112-121` |
| ⌘E is Monaco-bound and IS listed, so being editor-bound is not the exclusion                    | `packages/renderer/src/commands/catalogue.ts:410`                                                                                    |
| ⇧⌘/ opens the sheet, from the menu and from the palette                                         | `packages/renderer/src/commands/catalogue.ts:614-622`, `features/shortcuts-dialog/shortcuts-dialog.tsx:117-125`                      |
| Every row is derived from the command table plus the surface-shortcut list                      | `packages/renderer/src/features/shortcuts-dialog/shortcuts-dialog.tsx:69-108`                                                        |
| A test compares those accelerators with what `menu.ts` registers                                | `packages/renderer/src/commands/catalogue.ts:31-45`, `commands/catalogue.spec.ts`                                                    |
| 27 commands carry a binding, and the palette opener adds one row                                | `packages/renderer/src/commands/catalogue.ts:272-803`, `features/command-palette/palette-actions.ts:112-121`                         |
| Rows are grouped the same eight ways, and empty groups are not drawn                            | `packages/renderer/src/features/shortcuts-dialog/shortcuts-dialog.tsx:110-115`                                                       |
| Every binding is shown, not just the primary                                                    | `packages/renderer/src/features/shortcuts-dialog/shortcuts-dialog.tsx:79-93`, `commands/catalogue.ts:904-914`                        |
| New connection is ⇧⌘N and ⇧⌘C                                                                   | `packages/renderer/src/commands/catalogue.ts:274-283`, `packages/main/src/menu.ts:58, 254`                                           |
| The three sources and their meanings                                                            | `packages/renderer/src/commands/catalogue.ts:144-157`                                                                                |
| 23 menu-sourced commands, 3 renderer-sourced, 1 editor-sourced                                  | `packages/renderer/src/commands/catalogue.ts:239-242, 272-803`                                                                       |
| Those 23 commands carry 24 bindings, because New connection has an alternate                    | `packages/renderer/src/commands/catalogue.ts:274-283`, `features/shortcuts-dialog/shortcuts-dialog.tsx:79-93`                        |
| The renderer-sourced three are ⌘J, ⌘P and ⌥⌘S                                                   | `packages/renderer/src/commands/catalogue.ts:559-568, 623-631, 632-642`                                                              |
| The palette's opener is rendered under App as well, as a fourth row                             | `packages/renderer/src/features/shortcuts-dialog/shortcuts-dialog.tsx:95-105`, `features/command-palette/palette-actions.ts:112-121` |
| ⌘E is declared in the menu with `registerAccelerator: false` and bound by Monaco                | `packages/main/src/menu.ts:210-213`, `packages/renderer/src/editor/sql-editor.tsx:423-427`                                           |
| ⌥⌘S rather than ⇧⌘S, because ⇧⌘S is Save Query As                                               | `packages/renderer/src/commands/catalogue.ts:637-639`, `packages/main/src/menu.ts:101`                                               |
| The five commands with a genuinely different non-macOS binding                                  | `packages/renderer/src/commands/catalogue.ts:349, 413, 421, 574, 582`                                                                |
| The sixth per-platform binding is the same key: `Cmd+Option+S` / `Ctrl+Alt+S`                   | `packages/renderer/src/commands/catalogue.ts:639`                                                                                    |
| Accelerators are formatted for the running platform, with macOS modifier order                  | `packages/renderer/src/commands/catalogue.ts:849-902`                                                                                |
| Off macOS the formatter prints `Ctrl` for the cross-platform spellings                          | `packages/renderer/src/commands/catalogue.ts:852-863, 884-891`                                                                       |
| Electron maps `CmdOrCtrl` to Command on macOS and Control elsewhere                             | [Electron accelerator reference](https://www.electronjs.org/docs/latest/api/accelerator)                                             |

</details>
