# Joinery v1 — release checklist and go/no-go

**Status: mostly satisfied.** Every quality gate passes today, the app packages and verifies, and
the docs site is live. What v1 lacks is not engineering — it is a signed, notarized, distributable
artifact and four user-facing gaps that would each generate a support question on day one.

Drafted 2026-08-25 against `be05719` (main). Version in `package.json` is `0.5.0`; there are no
tagged releases and no published installers yet.

Every claim below carries the command or file that proves it. Re-run the commands before calling
go — an item is only green while its evidence is.

## How to use this document

1. Work the **blockers** to zero. Nothing else gates the release.
2. Re-run the gates in §1 on the release commit.
3. Walk the go/no-go table in §6. Any red line is a no-go; there is no partial ship.
4. Tag `vX.Y.Z`. `.github/workflows/build-release.yml` builds macOS and Windows and attaches the
   artifacts to the GitHub release.

---

## 1. Quality gates — all green

| Gate                    | Command                     | Result (2026-08-25, `be05719`)                                                         |
| ----------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Type-check              | `pnpm run typecheck`        | 6/6 packages clean, incl. `tsconfig.tests.json`                                        |
| Unit                    | `pnpm run test`             | **2866 passed**, 172 files                                                             |
| Integration             | `pnpm run test:integration` | **52 passed, 42 skipped** — see the skip note below                                    |
| E2E                     | `pnpm run test:e2e:react`   | **192 passed** in 6.7m, incl. `security.spec.ts`                                       |
| Lint                    | `pnpm run lint`             | clean at `--max-warnings 0` — **renderer only**, see J-128                             |
| Packaged-app acceptance | `pnpm run verify:package`   | asar, external resources and renderer bundle assertions in `scripts/verify-package.js` |

Two caveats that are real, not bookkeeping:

- **The 42 integration skips are one file.** `tests/integration/sqlglot/transpile.spec.ts` skips
  wholesale when Python and `sqlglot` are absent (`const describeIfPython = python ? describe :
describe.skip`). That is J-29 wearing a different hat: dialect conversion is unverified on any
  machine without the Python toolchain, including CI.
- **`pnpm run lint` only lints `packages/renderer`.** `main`, `shared` and `preload` have never
  been linted (J-128). CI reflects the same gap — it runs `pnpm --filter @joinery/renderer run
lint`, and type-checks the other three but does not lint them.

## 2. Blockers — must be closed before tagging

| #   | Ticket          | Why it blocks v1                                                                                                                                                                                                                                                                                             |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | **J-127**       | No distribution. There is no signing, no notarization, and no Homebrew tap; `electron-builder.yml` sets `hardenedRuntime: true` with entitlements but no identity, so every macOS download is quarantined and every Windows one hits SmartScreen. The docs already promise "packaged builds arrive with v1". |
| B2  | **J-29**        | SQL dialect conversion spawns a Python microservice (`resources/python/sqlglot-server.py`) that needs `python3` + `sqlglot` + FastAPI on the user's machine. Nothing is bundled and nothing says so — the feature just fails. Title already calls it a v1 release blocker.                                   |
| B3  | **J-48 / J-51** | The two remaining P1s. Backup silently overwrites a `log` backup as `FULL`; restore never sends `RestoreProgress.restoreId` for PG/MySQL. Data-destructive and data-loss-shaped respectively — neither is acceptable in a shipped database tool.                                                             |
| B4  | **J-117**       | The app name is lowercase `joinery`, so the user-data folder disagrees with the branding. Fixing it after release means migrating a live user-data directory; fixing it before costs nothing.                                                                                                                |
| B5  | **J-100**       | Help ▸ Joinery Documentation opens a wiki that does not exist. Repoint it at <https://usejoinery.com/> — a dead link in the Help menu of a first release is the worst possible first impression.                                                                                                             |

B4 and B5 are small. B1 is the real work, and it is mine per Craig's 2026-08-25 ruling.

## 3. Distribution — the gap

Present:

- `.github/workflows/build-release.yml` triggers on `v*` tags, builds macOS (dmg + zip, x64 +
  arm64) and Windows (nsis + zip, x64 + arm64), uploads to the GitHub release.
- `scripts/package.js` handles the workspace symlink swap and always restores it, so a failed
  build cannot leave `node_modules` swapped.
- `electron-builder.yml` is complete for identity-free builds: appId `ca.adam11.joinery`, icons,
  DMG layout, entitlements, `asarUnpack` for `keytar` and native `.node` files.

Missing, all inside J-127:

- **Code signing** — no `CSC_LINK`/`CSC_KEY_PASSWORD`, no Developer ID certificate.
- **Notarization** — no `notarize` block, no `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`teamId`.
  `hardenedRuntime: true` without notarization is the worst of both: the strict runtime with none
  of the trust.
- **Homebrew tap** — the cask J-127 asks for does not exist.
- **Auto-update** — `publish: null`, no `electron-updater`. **Proposed as explicitly out of scope
  for v1**: shipping an updater means committing to an update-feed forever, and a first release
  can reasonably ask people to download the next DMG. Craig's call.

## 4. Documentation — green, with one release-day edit

- The site is live at <https://usejoinery.com/>, 41 pages, deployed by `.github/workflows/docs.yml`
  with the apex domain pinned by `docs-site/public/CNAME`.
- `pnpm run check:reference` runs in CI as its own job, so a reference page that drifts from the
  app fails the build rather than shipping a lie.
- `README.md` and an MIT `LICENSE` are in place.

**One edit belongs in the release PR**, not before it: `docs-site/src/content/docs/getting-started/
install.md` currently says "It has no tagged releases and no packaged installers today… Packaged
builds arrive with v1" and documents building from source. On the day v1 tags, that page becomes
download-first, and its Gatekeeper/SmartScreen paragraph (accurate today) must be rewritten to
match whatever signing B1 lands.

## 5. Security — closed, with one follow-up

- **J-22 shipped** (`be05719`): deny-all `setWindowOpenHandler`, `will-navigate` pinned to the app
  origin with `file:` URLs carrying a host rejected, a strict production CSP with dev-only
  carve-outs, and an https/http/mailto allowlist before `shell.openExternal`. Confirmed under the
  live CSP by the 192-test e2e tier, so Monaco, AG Grid and mermaid are proven to render with it on.
- Credentials live in the macOS Keychain via `keytar`; `no-local-storage-writes.spec.ts` enforces
  the persistence boundary structurally.
- **J-129 remains open** (P2): `will-redirect`, `web-contents-created`, and the `openExternal` call
  sites in `menu.ts` and `entra-auth.ts` are not yet covered. Recommended for v1 — it is the other
  half of a shipped hardening story, and it is small.
- **J-30 is cancelled**, not fixed, on Craig's ruling: the leaked `sa` password is a throwaway
  local instance. `mj.config.cjs` remains in git history at `a8aaeb2`. Recorded so nobody
  rediscovers it and re-files it.

## 6. Go / no-go

Tag only when every line reads yes.

| Line                              | Yes when                                                                             | Today                         |
| --------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------- |
| Gates green on the release commit | §1 re-run clean, integration skips explained or eliminated                           | **yes**, with the two caveats |
| No open P1                        | J-48, J-51, J-127 closed                                                             | **no** — three open           |
| Release-facing gaps closed        | J-29, J-117, J-100 closed                                                            | **no** — three open           |
| Downloadable artifact             | signed + notarized DMG and a Windows installer from a `v*` tag                       | **no** — B1                   |
| Install docs match reality        | `install.md` is download-first and its warning text matches the signing that shipped | **no** — pending B1           |
| Fresh-machine install works       | DMG installed on a machine that never built Joinery, connects to a real database     | **not attempted**             |
| Version bumped                    | `package.json` is the version being tagged, not `0.5.0`                              | **no**                        |

**The last line of §6 is the one nobody can fake.** Every other item can be satisfied from this
repo; a fresh-machine install proves the packaged app works for someone who is not us, and it has
never been done. It should be the final gate before the tag.

## 7. Explicitly out of scope for v1

Named so they stop being ambient anxiety, and so nobody treats them as blockers:

- Auto-update (see §3 — Craig's call to confirm).
- Windows code signing, if the certificate is not worth buying for a first release. macOS signing
  is not optional; Windows arguably is, at the cost of a SmartScreen warning.
- Linux packaging. `electron-builder.yml` targets mac and win only, deliberately.
- `packages/cli` (J-93) — undocumented, MSSQL-only, ships committed `node_modules`. **Decide
  before tagging**: either exclude it from the release or delete it. Shipping it by accident is
  the bad outcome.
- The 38 P3 and 18 P4 tickets. v1 is not a zero-bug release.

---

**Sequencing, if the loop drives it:** J-100 and J-117 (small, user-facing) → J-129 (finish the
hardening) → J-48 and J-51 (the P1 data bugs) → J-29 (Python story) → J-127 (signing, notarization,
Homebrew) → version bump → fresh-machine install → tag.
