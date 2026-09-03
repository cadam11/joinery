# Joinery — follow-up work

> **This backlog now lives in Linear** (team **Joinery**, prefix `J-`, label `follow-ups`).
> This file is **pointers only** — each entry below is a stub linking to its ticket, which holds
> the full detail. Do not add new items here: file them in Linear instead. Item numbers are kept
> so older documents and commit messages that cite "FOLLOW-UPS item N" still resolve.

Deferred items from the Forge rebrand (PR #1), the markdown renderer swap (PR #2), the pnpm
migration (PR #3), and the renderer rewrite's early tasks.

---

## 1. Regenerate the stale visual regression baselines → [J-21](https://linear.app/adam11/issue/J-21)

`tests/__snapshots__/visual/` still shows "MJ Forge" and the old mark; `test:visual` is RED on `main` and the rebrand was never run through `test:e2e`.

## 2. Add a `will-navigate` guard and a CSP to the main process → [J-22](https://linear.app/adam11/issue/J-22)

`window.ts` has neither `setWindowOpenHandler` nor `will-navigate` and `index.html` has no CSP, so any in-app navigation inherits the full `window.joinery` IPC surface.

## 3. Recapture the README screenshots → [J-23](https://linear.app/adam11/issue/J-23)

The eight `docs/screenshots/` PNGs were deleted rather than rebranded (they leaked an internal Azure SQL hostname); the README's `## Screenshots` section needs restoring.

## 4. Restore GitHub `[!NOTE]` callout rendering → [J-24](https://linear.app/adam11/issue/J-24)

`marked-alert` was lost with `@memberjunction/ng-markdown`, so `[!NOTE]` markers render as literal text.

## 5. Contain mermaid diagram CSS → [J-25](https://linear.app/adam11/issue/J-25)

`sanitizeDiagramSvg` allows `<style>`, which joins the document stylesheet set — defence-in-depth only, pinned by a `DOCUMENTS A KNOWN LIMITATION` test.

## 6. Clean up pre-existing repo rot → [J-26](https://linear.app/adam11/issue/J-26)

Broken `ng lint` target, no renderer `typecheck`, stale `tests/regression-suite.md`, wrong README version badge, two `console.*` calls.

## 7. Declare deps in the packages that import them → [J-27](https://linear.app/adam11/issue/J-27)

`packages/main` imports electron/msal/pg/mysql2/AWS without declaring them; the workspace is pinned to `nodeLinker: hoisted` until the root-manifest coupling is untangled.

## 8. Record: dependency versions moved during the pnpm migration → [J-28](https://linear.app/adam11/issue/J-28)

29 direct deps advanced within their existing ranges when the lockfile was regenerated. Craig accepted the drift — a record, not an action.

## 9. SQL dialect conversion needs Python and says so nowhere → [J-29](https://linear.app/adam11/issue/J-29)

`spawn('python3')` fails on Windows, there is no setup-instructions UI, and the `pip install sqlglot fastapi uvicorn pydantic` prerequisite is undocumented. v1 release blocker.

## 10. Rotate the leaked SQL Server `sa` password → [J-30](https://linear.app/adam11/issue/J-30)

The deleted `mj.config.cjs` remains in git history with a plaintext `sa` password. Treat as leaked.

## 11. Wire or remove the ten dead command-palette events → [J-31](https://linear.app/adam11/issue/J-31)

Ten `joinery:*` `CustomEvent`s are dispatched by the palette with no listener anywhere in the renderer.

## 12. Adopt or delete the unreferenced `assets/icons/logo.png` → [J-32](https://linear.app/adam11/issue/J-32)

Nothing imports the updated raster mark; separately, the sidebar stack mark's hardcoded ivory stripe is invisible in light mode.

**Half done (renderer-rewrite Task 8).** The invisible-stripe half is fixed in the React renderer:
`packages/renderer-react/src/shell/sidebar/brand-mark.tsx` inlines `docs/brand/assets/mark-on-*.svg`
as one SVG whose middle bar is `fill-fg`, which resolves to drafting ivory under ink and Joinery ink
under ivory — the exact two hexes the two assets differ by. `task-8-gate.mjs` measures the resolved
fill per theme, so the defect cannot come back silently. Still open: the Angular
`packages/renderer/src/assets/icons/logo.png` is still unreferenced, and disposing of it is a
cutover decision (renderer-rewrite Task 24), not a UI one.

## 13. Align the dev and packaged userData directory case → [J-33](https://linear.app/adam11/issue/J-33)

**Superseded by [J-117](https://linear.app/adam11/issue/J-117) and [J-142](https://linear.app/adam11/issue/J-142), both merged.** The case question is settled: the root manifest carries `"productName": "Joinery"`, and a one-shot guard in `packages/main/src/index.ts` moves a pre-rename lowercase `joinery` directory across on a case-sensitive volume. Development keeps a directory of its own on purpose — `packages/main/package.json` says `"productName": "Joinery (dev)"`, so a dev-time bug cannot reach real connection profiles. Both halves are pinned by `packages/main/src/services/config/user-data-dir.spec.ts`.

## 14. Fix the broken root `lint` target → [J-34](https://linear.app/adam11/issue/J-34)

`turbo run lint` aborts on the Angular package's missing lint target, so the renderer rewrite's per-task gate is red before any task starts. `format:check` is red too.

## 15. Correct PROPOSAL §2.3's contrast table and the `--j-verify-deep` hex → [J-35](https://linear.app/adam11/issue/J-35)

Two ratios are ~3% optimistic and `--j-verify-deep: #4e7a12` measures 4.44:1 on ivory — 0.06 short of AA. The Task 2 theme and its tests are the authority.
