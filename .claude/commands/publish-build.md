Cut a Joinery release: pick the version, prove the tree is releasable, bump it through a PR, and push the tag. `.github/workflows/release.yml` does everything after the tag — building, signing, checksums, the GitHub Release, and the Homebrew tap. This command owns only the judgement the workflow cannot make.

Design and rationale for the pipeline: `plans/release/DISTRIBUTION.md`.

## What this command does and does not do

**Does:** choose the version, run the release gate, bump through a PR, tag, watch, and check the result.

**Does not:** build, sign, notarize, upload assets, write checksums, or edit the cask. If you find yourself about to do any of those by hand, the workflow is broken and that is the thing to fix. Never upload an asset to a release manually — the release's `SHA256SUMS.txt` would then be a lie.

## Inputs

Ask the user:

1. **Version number** (e.g. `0.6.0`) — or suggest the next patch/minor from the `version` in `package.json`.
2. **Anything to say in the release notes beyond the generated changelog.** The workflow writes the install instructions, the signing status and the checksum section itself; this is for the human sentence at the top, if there is one.

## 1. Pre-flight

- Working tree clean (`git status`), on `main`, up to date with `origin/main`.
- `pnpm run build` succeeds.
- Read the current `version` in `package.json` and `git tag --list` — confirm the new version is actually ahead of both.

### First release only

Two things must exist before the first tag, and both fail the release loudly rather than quietly if they do not:

- **The Homebrew tap.** `gh repo view cadam11/homebrew-joinery`. If it 404s, run `./scripts/release/bootstrap-tap.sh` (it is idempotent, and `--dry-run` shows what it would push).
- **`HOMEBREW_TAP_TOKEN`** in the repository's secrets — a token with `contents: write` on the tap. Check with `gh secret list --repo cadam11/joinery`. Without it the `homebrew` job fails after the release is already public.

### Signing status — say it out loud before tagging

`gh secret list --repo cadam11/joinery` and check for all five of `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Tell the user which case this release is, and do not proceed until they have heard it:

- **All five present** → the macOS build is signed and notarized. The workflow's `spctl --assess` step will prove it, and a failure there is a real failure.
- **Any missing** → the macOS build is **unsigned**, every download is quarantined, and the release notes will say so. That may be fine. It should still be a decision, not a discovery.

Never work around a missing certificate. No ad-hoc signing, no `identity: "-"`, no stripping quarantine on a user's behalf.

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
- Push, open a PR with `gh pr create`, and say in the body that the harness gate is green and whether this build will be signed.
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

Read the run's annotations, not just its colour. An unsigned build is a **warning**, not a failure — the run is green and the release is still unsigned. Report that to the user in words.

If a job fails after the release is published, fix the cause and re-run the failed job rather than re-tagging. `homebrew` in particular is safely re-runnable: the cask rewrite is idempotent and pushes nothing when the tap is already current.

## 6. Verify what shipped

```bash
gh release view v{VERSION} --repo cadam11/joinery
```

Check:

- Both DMGs, both `.exe` installers, the zips, and **`SHA256SUMS.txt`**.
- The notes' Signing section matches what step 1 predicted.
- The tap moved: `gh api repos/cadam11/homebrew-joinery/contents/Casks/joinery.rb --jq '.content' | base64 -d | head -20` shows the new version and real checksums.

Then install it the way a user would, on macOS:

```bash
brew update && brew install --cask cadam11/joinery/joinery
```

On an unsigned release this is where the quarantine prompt appears — confirm the release notes' instructions actually work, because that text is the only help a user gets.

## 7. Documentation

`docs-site/` must track what shipped; the root `CLAUDE.md` makes this a hard rule for user-facing change.

- **`getting-started/install.md`** is the page that moves on every release. Its "What installing will look like" section is written in the future tense until the first tag exists — **on the first release, rewrite it in the present tense and delete the "None of this works yet" line.** Its "unsigned-build warning" section is deleted on the release where signing first happens, and not before.
- **Walk the changes since the last tag** and update any page whose feature surface moved: new commands or shortcuts, new settings, new connection options, new AI providers or tools, changed error surfaces. `pnpm run check:reference` in `docs-site/` fails the build if the generated reference pages have drifted from the app, so that half is enforced; the prose half is not.
- Gates: `cd docs-site && pnpm install && pnpm run check && pnpm run build`. The build fails on a broken internal link.
- Docs changes go in through a PR like anything else.

There is no wiki. Help ▸ Joinery Documentation opens <https://usejoinery.com/> (`DOCS_SITE_URL` in `packages/shared/src/constants/index.ts`); do not resurrect the wiki flow the previous version of this command described.

## Troubleshooting

- **`cpu-features` build failure** — `scripts/before-build.js` removes this incompatible optional module before `@electron/rebuild` runs. If it still fails, check the hook exists and that `electron-builder.yml` still names it under `beforeBuild`.
- **Missing dependencies in the packaged app** — the `beforeBuild` hook MUST return `true`. Returning `false` tells electron-builder that `node_modules` are handled externally, which excludes every dependency from the asar. `pnpm run verify:package` is what catches this.
- **Workspace symlink issues** — `scripts/package.js` replaces the `@joinery/shared` symlink with a real copy and restores it in a `finally`, so a failed build cannot leave `node_modules` swapped. Never call `electron-builder` directly; go through that script.
- **The `homebrew` job fails on checkout** — the tap does not exist, or `HOMEBREW_TAP_TOKEN` is missing or expired. See step 1.
- **The `guard` job fails on the cask template** — someone edited `Casks/joinery.rb` into a shape `scripts/release/update-cask.ts` no longer matches. Its spec reads the real template, so `pnpm exec vitest run --project scripts` reproduces it locally.
