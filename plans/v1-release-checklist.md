# Joinery v1.0.0 — release checklist and go/no-go

**Status: one blocker and two mechanical steps away from a tag.** Every engineering item the
first draft called a blocker is closed. What remains is one Urgent bug filed tonight, the version
bump, and the tag itself.

Refreshed **2026-09-03** against `9fd9f25` (main, 2026-09-02 18:58 CDT). `package.json` is
`0.5.0` and `git tag -l` is empty, so no release exists yet. **The first tag is `v1.0.0`**
(Craig's ruling, 2026-09-03).

Every claim below carries the command, file, or ticket that proves it. An item is only green
while its evidence is — re-run the gates on the commit you actually tag.

## How to use this document

1. Clear the **blockers** in §2. Nothing else gates the release.
2. Run the manual packaged-smoke ritual in §7, then let `/publish-build` re-run the gates in §1.
3. Walk the go/no-go table in §6. Any red line is a no-go; there is no partial ship.
4. Follow §7 to the tag. `.github/workflows/release.yml` does everything after it.

---

## 1. Quality gates

Run on `9fd9f25` in the `j-130` worktree, 2026-09-03:

| Gate                    | Command                     | Result                                                           |
| ----------------------- | --------------------------- | ---------------------------------------------------------------- |
| Type-check              | `pnpm run typecheck`        | **6/6 packages clean**, plus `tsconfig.tests.json`, exit 0       |
| Lint                    | `pnpm run lint`             | **4/4 packages clean** (main, preload, renderer, shared), exit 0 |
| Unit                    | `pnpm run test`             | **3755 passed**, 220 files                                       |
| Integration             | `pnpm run test:integration` | **not re-run** — see the Docker note below                       |
| E2E                     | `pnpm run test:e2e:react`   | **not re-run** — same Docker dependency                          |
| Packaged-app acceptance | `pnpm run verify:package`   | **not re-run** — needs a fresh package build                     |

The three unrun tiers are `/publish-build` step 2's job (`.claude/commands/publish-build.md` §2,
"No release proceeds on a red or skipped harness"). They are not a standing green here.

**The lint caveat from the August draft is gone.** `pnpm run lint` now covers all four packages,
and `turbo.json`'s `lint.inputs` hashes `$TURBO_ROOT$/.eslintrc.json` and
`$TURBO_ROOT$/.prettierrc.json` so a config change cannot produce a cached false green (J-34, PR
#125; J-128 closed). CI runs it over every package (`.github/workflows/ci.yml`, "Lint every
package").

**What CI actually gates:** type-check of all four packages, `pnpm run lint`, `pnpm run
test:coverage`, and a docs reference-drift job (`ci.yml`). Integration, e2e, visual and the
packaged smoke tier run locally only — `pnpm run test:full` and §7's ritual are the only things
that exercise them before a tag.

Two caveats that are real, not bookkeeping:

- **The 42 integration skips are still one file.** `tests/integration/sqlglot/transpile.spec.ts`
  skips wholesale when Python and `sqlglot` are absent (`const describeIfPython = python ?
describe : describe.skip`, line 79). Measured tonight: that file alone is 45 tests, 42 skipped.
  J-29 closed by documenting the requirement (`docs-site/…/prerequisites.md` §"Python and
  sqlglot") rather than by bundling an interpreter, so dialect conversion stays unverified on any
  machine without the Python toolchain, CI included.
- **Docker could not bring the harness up tonight.** `pnpm run test:harness:up` failed twice with
  `Error response from daemon: No such container: …` while starting the MSSQL, bastion and
  private-Postgres containers; only `joinery-test-postgres` and `joinery-test-mysql` came up. Any
  integration or e2e claim on this commit is therefore unproven. Independently,
  `tests/integration/backup/pg-backup-restore.spec.ts` is red on `main` for a code reason — that
  is J-195, §2.

## 2. Blockers — must be closed before tagging

| #   | Ticket    | State            | Why it blocks v1                                                                                                                                                                                                                                                           |
| --- | --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **J-195** | Todo, **Urgent** | `pg-backup.ts` calls `onRestored` inside the `try` whose `catch` reports "post-restore verification failed", so a successful, verified PostgreSQL restore is reported to the user as a failure. It is also why the pg backup round-trip integration file is red on `main`. |
| B2  | —         | mechanical       | Version bump: `package.json` is `0.5.0`; the tag and the manifest must agree or `release.yml`'s `guard` job refuses the release.                                                                                                                                           |
| B3  | —         | mechanical       | The tag itself. No `v*` tag exists, so nothing has ever been built by `release.yml`.                                                                                                                                                                                       |

Everything the 2026-08-25 draft listed as a blocker is closed: **J-127** (distribution), **J-29**
(Python story), **J-48** and **J-51** (the two P1 data bugs), **J-117** (app name), **J-100**
(Help menu), plus **J-129** (the rest of the navigation hardening) and **J-93** (`packages/cli`
deleted, `29c9c43`).

**Not blockers, but decide before the tag:**

- **J-33** (High, Todo) — dev and packaged `userData` directory case are not aligned, and it is
  marked "Craig's call". This is the same argument that made J-117 a pre-release fix: changing a
  user-data path after release means migrating a live directory. Cheap now, expensive later.
- **J-171** (PR #132, In Review) — a packaged build refusing `JOINERY_PYTHON`. Pulled forward as
  a pre-v1 security fix; it should land before the tag rather than after.
- **J-27** (PR #131, In Review) — dependency declarations and the pnpm isolated linker. It
  changes what gets packaged, so it lands before the tag or waits for the release after.

## 3. Distribution — built, never fired

- `.github/workflows/release.yml` triggers on `v*` tags only. Four jobs: `guard` (tag matches
  `package.json`; `HOMEBREW_TAP_TOKEN` reaches the tap and reports `permissions.push`; the cask
  template is still rewritable), `build` (macOS and Windows, both architectures), `release`
  (`SHA256SUMS.txt`, then `gh release create --generate-notes --verify-tag`), `homebrew` (stamps
  `Casks/joinery.rb` and pushes it to `cadam11/homebrew-joinery`).
- `HOMEBREW_TAP_TOKEN` is set (`gh secret list`, 2026-09-02) — J-127's last human step, Part A of
  `plans/release/CRAIG-RELEASE-STEPS.md`. It is the only secret the workflow uses.
- The tap repository `cadam11/homebrew-joinery` exists; `Casks/joinery.rb` in this repo is the
  template and the single source of truth.
- `scripts/package.js` does the workspace symlink swap and always restores it, so a failed build
  cannot leave `node_modules` swapped.

**Unsigned, by ruling (J-143, PR #93).** There is no Apple Developer Program membership, so
`electron-builder.yml` sets `mac.identity: null` (line 117) and notarization is unreachable.
`hardenedRuntime: true` and the entitlements are inert while identity is null and are documented
as such in the file. `scripts/release/unsigned-release.spec.ts` asserts the claim against the real
files. **J-144** records the path back if a membership is ever bought; it is Backlog and not
planned.

**No auto-update.** `publish: null`, no `electron-updater`. Out of scope for v1 by the same
reasoning as the first draft: shipping an updater commits you to an update feed forever.

## 4. Documentation

- The site is live at <https://usejoinery.com/>, deployed by `.github/workflows/docs.yml` with the
  apex domain pinned by `docs-site/public/CNAME`.
- `pnpm run check:reference` runs as its own CI job, so a reference page that drifts from the app
  fails the build.
- Help ▸ Joinery Documentation opens `DOCS_SITE_URL` (`packages/shared/src/constants/index.ts:11`),
  not the dead wiki (J-100).

**One edit belongs in the release PR, not before it.**
`docs-site/src/content/docs/getting-started/install.md` still opens with "It has no tagged
releases today, so there is nothing to download yet". On tag day that page becomes download-first
and the "What installing will look like" section moves to the present tense. Its "Joinery is not
code-signed" section is already correct and permanent — J-143 rewrote the Gatekeeper wording, so
that half needs nothing.

## 5. Security

- **J-22 and J-129 both shipped**: deny-all `setWindowOpenHandler`, `will-navigate` and
  `will-redirect` pinned to the app origin, `web-contents-created` covered, a strict production
  CSP with dev-only carve-outs, and an allowlist before every `shell.openExternal` call site.
- Credentials live in the macOS Keychain via `keytar`; `no-local-storage-writes.spec.ts` enforces
  the persistence boundary structurally.
- **The pre-v1 SQL-safety tickets are closed**: J-134 (engine-correct string escaping), J-135
  (parameterised metadata queries), J-136 (AI tool SQL through the dialect), J-137 (MySQL pools
  split by trust level).
- **`execute_query` ships with no confirmation gate** — Craig's ruling, 2026-09-03. An AI tool
  call can run arbitrary SQL without a human step. Accepted for v1; gating it is post-v1 and has
  no ticket yet.
- **J-30 is cancelled, not fixed**, on Craig's ruling: the leaked `sa` password was a throwaway
  local instance. `mj.config.cjs` remains in git history at `a8aaeb2`. Recorded so nobody
  rediscovers it.

## 6. Go / no-go

Tag only when every line reads yes, or reads a risk Craig has accepted in writing.

| Line                               | Yes when                                                                          | Today (2026-09-03)                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Gates green on the release commit  | `test:full` exits 0 on the head being tagged                                      | **no** — unit/lint/type-check green tonight; integration, e2e and visual not run |
| No open Urgent or High in Todo     | the Todo column holds no P1/P2                                                    | **no** — J-195 (Urgent), J-53 (High), J-33 (High)                                |
| Release-blocking gaps closed       | J-127, J-29, J-48, J-51, J-117, J-100, J-129, J-93 closed                         | **yes** — all eight Done                                                         |
| Packaged smoke run on the artifact | §7's ritual run green on a bundle built from the release commit                   | **not run** — manual until J-187 automates it                                    |
| Downloadable artifact              | unsigned DMGs and Windows installers from the `v1.0.0` tag, plus `SHA256SUMS.txt` | **no** — no tag exists                                                           |
| Install docs match reality         | `install.md` download-first; the Gatekeeper wording matches what shipped          | **no** — pending the tag; Gatekeeper half already correct (J-143)                |
| Fresh-machine install works        | DMG installed on a machine that never built Joinery                               | **skipped for v1 — accepted risk**, Craig's ruling 2026-09-03                    |
| Version bumped                     | `package.json` reads `1.0.0`, the version being tagged                            | **no** — still `0.5.0`                                                           |

Open High tickets sitting in Backlog rather than Todo, for completeness: J-141, J-82, J-126,
J-163. None is release-blocking; none has been ruled on.

**The fresh-machine install is the line nobody can fake, and v1 ships without it.** Craig ruled on
2026-09-03 that it is skipped rather than gated. What that costs: the first person to install
Joinery on hardware that never built it is a real user, and the first proof the DMG works for
someone who is not us is `/publish-build` step 6 — `brew install --cask cadam11/joinery/joinery`
on Craig's own Mac, after the release is already public. That step is not optional.

## 7. The release procedure

The manual ritual first, because it is the one thing no gate enforces:

1. **Packaged smoke run.** `pnpm run package:test` builds a bundle and stamps
   `Contents/Resources/joinery-test-build`; `pnpm run test:smoke:packaged` then drives that bundle
   against local SQL Server, PostgreSQL and MySQL containers in a throwaway keychain namespace
   (J-88). It needs Docker. `pnpm run smoke:package` is the cheaper version — does the bundle come
   up at all.
2. **Repackage before verifying.** `pnpm run verify:package` chains
   `test-build-marker.ts --check`, which exits 1 on a bundle carrying the test marker. A worktree
   that just ran the smoke tier must be repackaged (`pnpm run package:dmg`) before `verify:package`
   can pass. This is expected, not a fault.

Then the release itself:

3. **`/publish-build`** (`.claude/commands/publish-build.md`) — pre-flight, `pnpm run test:full`
   as a hard gate, a local `package:dmg` + `verify:package`.
4. **Version bump PR to `1.0.0`** — branch `chore/bump-v1.0.0`, `package.json` only, merged via
   PR. Never a direct push to `main`.
5. **Craig says go.** This is the decision point; there is no undo that un-downloads a DMG.
6. **Tag** — `git tag -a v1.0.0 -m "Release v1.0.0" && git push origin v1.0.0`. That push is the
   release; there is no other trigger.
7. **`release.yml`** runs `guard` → `build` → `release` → `homebrew`, about 40 minutes. Expect one
   yellow `Unsigned build` warning on `build` every time — the run is still green.
8. **Homebrew tap update** is the last job, not a separate action. If it fails the release is
   already public; fix the token and re-run that job, the cask rewrite is idempotent.
9. **Install it the way a user would** and walk the three first-launch steps in the release notes
   on a real Mac (`CRAIG-RELEASE-STEPS.md` B7).

**Release notes for v1** are `release.yml`'s hand-written block (install commands, the macOS
first-launch instructions, the checksum section) plus `--generate-notes` for the commit log. There
is nothing to write by hand unless Craig wants a sentence at the top.

**J-187** would fold the packaged smoke tier into `release.yml` as an automatic gate. It is
Backlog and unstarted, which is exactly why step 1 above is a written ritual: nothing stops a
release that skipped it.

## 8. Explicitly out of scope for v1

Named so they stop being ambient anxiety, and so nobody treats them as blockers:

- **Code signing and notarization** — J-143 ruling. J-144 holds the path back.
- **Auto-update** — `publish: null`. Users take the next DMG or `brew upgrade --cask joinery`,
  which costs them the Open Anyway click again.
- **Windows code signing** — no certificate; SmartScreen warns and the release notes say so.
- **Linux packaging** — `electron-builder.yml` targets mac and win only, deliberately.
- **Fresh-machine install verification** — skipped, accepted risk (§6).
- **`execute_query` confirmation gating** — post-v1 (§5).
- **The rest of the backlog.** 92 open tickets, 80 of them in Backlog. v1 is not a zero-bug
  release.

---

**Shortest path to the tag:** J-195 → J-171 and J-27 land or are deferred → J-33 ruled on →
packaged smoke ritual (§7.1) → `/publish-build` → bump to `1.0.0` → Craig's go → `v1.0.0`.
