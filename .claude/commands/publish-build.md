Cut a Joinery release: pick the version, prove the tree is releasable, bump it through a PR, and push the tag. `.github/workflows/release.yml` does everything after the tag — building, signing, checksums, the GitHub Release, and the Homebrew tap. This command owns only the judgement the workflow cannot make.

Design and rationale for the pipeline: `plans/release/DISTRIBUTION.md`. The same sequence written
for Craig, one action per step: `plans/release/CRAIG-RELEASE-STEPS.md` — point him at it rather
than narrating GitHub's UI.

## What this command does and does not do

**Does:** choose the version, run the release gate, bump through a PR, tag, watch, and check the result.

**Does not:** build, upload assets, write checksums, or edit the cask. If you find yourself about to do any of those by hand, the workflow is broken and that is the thing to fix. Never upload an asset to a release manually — the release's `SHA256SUMS.txt` would then be a lie.

**Does not, and will not:** sign or notarize anything. Joinery has no Apple Developer Program membership (Craig's ruling, 2026-08-30). `electron-builder.yml` sets `mac.identity: null`, so signing is skipped and notarization is unreachable. Never work around that — no ad-hoc identity, no `identity: "-"`, no stripping quarantine on a user's behalf, no `postflight` in the cask. If Craig buys a membership, that is a planned change with its own checklist in `plans/release/DISTRIBUTION.md`, not something to improvise mid-release.

## Inputs

Ask the user:

1. **Version number** (e.g. `0.6.0`) — or suggest the next patch/minor from the `version` in `package.json`.
2. **Anything to say in the release notes beyond the generated changelog.** The workflow writes the install instructions, the signing status and the checksum section itself; this is for the human sentence at the top, if there is one.

## 1. Pre-flight

- Working tree clean (`git status`), on `main`, up to date with `origin/main`.
- `pnpm run build` succeeds.
- Read the current `version` in `package.json` and `git tag --list` — confirm the new version is actually ahead of both.

### The one secret

```bash
gh secret list --repo cadam11/joinery
```

You want exactly one line, `HOMEBREW_TAP_TOKEN`. If it is missing, stop and send Craig to Part A of `plans/release/CRAIG-RELEASE-STEPS.md` — creating the token is his action, not yours, and you cannot do it for him.

The `guard` job re-checks the token before anything is built, so a bad one fails in the first minute rather than after the release is public. Be precise about what that proves: the tap is a **public** repository and every fine-grained token carries read-only access to all public repositories, so reaching the tap proves only that the credential is live. `guard` therefore also reads `.permissions.push` and fails on `false`. A token GitHub reports no permissions object for gets a warning and the release proceeds — if `homebrew` then fails at the end, that warning was the reason.

### Say the unsigned part out loud

Every macOS release is unsigned and unnotarized. Tell Craig, in these words, before he agrees to the tag: _"every user's first launch needs System Settings → Privacy & Security → Open Anyway, and so does every `brew upgrade` after it."_ It is in the release notes, the cask caveats and the install page — but it should be a thing he chose, not a thing he found out.

## 2. The release gate — the full harness

**Mandatory for every release. No release proceeds on a red or skipped harness.** Invoke the **joinery-regression-harness** skill and run the complete pipeline:

- It needs the Docker daemon for the integration and e2e tiers. If Docker is down, ask the user to start it — do not skip the tiers.
- `pnpm run test:full` brings the harness up, runs unit / integration / e2e / visual, writes structured JSON to `tests/reports/.cache/`, and **exits non-zero on any failure**.
- **Gate:** it must exit 0. If anything fails, STOP. Do not bump, do not tag. Read `tests/reports/.cache/{tier}.summary.md`, fix it or get the user's call, and re-run until green.

Also run `pnpm run package:dmg` and then `pnpm run verify:package` once locally. The workflow runs `verify:package` too, but finding a packaging break here costs a minute instead of forty.

## 3. Bump the version through a PR

The project hard rule is **never push directly to `main`**. The release convention is a dedicated bump branch merged via PR; the tag then points at the merge commit.

- Branch `chore/bump-v{VERSION}`.
- Stage `package.json` **only** — do not sweep in unrelated working-tree changes.
- Commit `chore: bump version to v{VERSION}`.
- Push, open a PR with `gh pr create`, and say in the body that the harness gate is green.
- Merge with `gh pr merge --merge --delete-branch` — a real merge commit, so the tag has something to point at.
- `git checkout main && git pull origin main`.

The tag and `package.json` must agree exactly. The workflow's `guard` job checks this first and refuses the release if they do not, because every artifact filename — and therefore every Homebrew cask URL — is built from the manifest version.

## 4. Tag

```bash
git tag -a v{VERSION} -m "Release v{VERSION}"
git push origin v{VERSION}
```

That is the release. There is no other trigger.

## 5. Watch it

```bash
gh run list --repo cadam11/joinery --limit 1
gh run watch {RUN_ID} --repo cadam11/joinery --exit-status
```

Four jobs, in order: **guard**, **build** (mac and win), **release**, **homebrew**.

Read the run's annotations, not just its colour. The `build` job emits an `Unsigned build` **warning** on every release — the run is still green, and that annotation is expected, not a problem to investigate. Say so rather than letting a yellow triangle look like a fault.

If a job fails after the release is published, fix the cause and re-run the failed job rather than re-tagging. `homebrew` in particular is safely re-runnable: the cask rewrite is idempotent and pushes nothing when the tap is already current.

## 6. Verify what shipped

```bash
gh release view v{VERSION} --repo cadam11/joinery
```

Check:

- Both DMGs, both `.exe` installers, the zips, and **`SHA256SUMS.txt`**.
- The notes carry the "First launch on macOS" section.
- The tap moved: `gh api repos/cadam11/homebrew-joinery/contents/Casks/joinery.rb --jq '.content' | base64 -d | head -20` shows the new version and real checksums.

Then install it the way a user would, on macOS:

```bash
brew update && brew install --cask cadam11/joinery/joinery
```

This is where the quarantine refusal appears. **Ask Craig to walk the three steps in the release notes and confirm they match what his Mac actually does** — that text is the only help a user gets, and it is the one claim in the release nothing automated can check. If macOS says something different, four files say the same wrong thing: `Casks/joinery.rb` `caveats`, `Casks/TAP_README.md`, `docs-site/…/install.md` and `README.md`.

## 7. Documentation

`docs-site/` must track what shipped; the root `CLAUDE.md` makes this a hard rule for user-facing change.

- **`getting-started/install.md`** is the page that moves on every release. Its "What installing will look like" section is written in the future tense until the first tag exists — **on the first release, rewrite it in the present tense and delete the "None of this works yet" line.** Its "Joinery is not code-signed" section is permanent; leave it alone.
- **Walk the changes since the last tag** and update any page whose feature surface moved: new commands or shortcuts, new settings, new connection options, new AI providers or tools, changed error surfaces. `pnpm run check:reference` in `docs-site/` fails the build if the generated reference pages have drifted from the app, so that half is enforced; the prose half is not.
- Gates: `cd docs-site && pnpm install && pnpm run check && pnpm run build`. The build fails on a broken internal link.
- Docs changes go in through a PR like anything else.

There is no wiki. Help ▸ Joinery Documentation opens <https://usejoinery.com/> (`DOCS_SITE_URL` in `packages/shared/src/constants/index.ts`); do not resurrect the wiki flow the previous version of this command described.

## Troubleshooting

- **`cpu-features` build failure** — `scripts/before-build.js` removes this incompatible optional module before `@electron/rebuild` runs. If it still fails, check the hook exists and that `electron-builder.yml` still names it under `beforeBuild`.
- **Missing dependencies in the packaged app** — the `beforeBuild` hook MUST return `true`. Returning `false` tells electron-builder that `node_modules` are handled externally, which excludes every dependency from the asar. `pnpm run verify:package` is what catches this.
- **`verify:package` reports a build-time or dead package in the archive** — `pnpm run verify:package` now also runs `scripts/release/asar-inventory.ts --check`, which fails when a package listed in that file's `NEVER_SHIP` is inside `app.asar`. Usually it means an exclusion line was dropped from `electron-builder.yml`'s `files`, or that a positive pattern was added after the exclusions and re-included everything (which is exactly what `node_modules/**/*` used to do — see `plans/release/ASAR-INVENTORY.md`). `pnpm run inventory:asar` prints what is actually in there.
- **Workspace symlink issues** — `scripts/package.js` replaces the `@joinery/shared` symlink with a real copy and restores it in a `finally`, so a failed build cannot leave `node_modules` swapped. Never call `electron-builder` directly; go through that script.
- **The `guard` job fails on the tap** — `HOMEBREW_TAP_TOKEN` is missing, expired, or scoped to the wrong repository. Nothing was published; Craig makes a new token (Part A of `plans/release/CRAIG-RELEASE-STEPS.md`) and the tag is re-pushed.
- **The `homebrew` job fails on checkout or push** — the token was revoked between `guard` and this job, or `guard` could not confirm its write access and warned instead of failing. The release is already public. Replace the token and re-run this job alone; the cask rewrite is idempotent and pushes nothing if the tap is already current.
- **The `guard` job fails on the cask template** — someone edited `Casks/joinery.rb` into a shape `scripts/release/update-cask.ts` no longer matches. Its spec reads the real template, so `pnpm exec vitest run --project scripts` reproduces it locally.
