# Joinery release distribution

How a tag becomes something a person can install. One page; the workflow is the implementation of
this page and nothing else describes it.

## The pipeline

```
git tag v1.0.0 && git push origin v1.0.0
        │
        ├─ build (macos-latest)  ── DMG + zip, arm64 and x64
        │     └─ sign + notarize IF the five Apple secrets exist, else a loud skip
        ├─ build (windows-latest) ── NSIS + zip, x64 and arm64   (never signed today)
        │
        ├─ release (ubuntu) ── collect artifacts → SHA256SUMS.txt → GitHub Release
        │
        └─ homebrew (ubuntu) ── rewrite Casks/joinery.rb → push to cadam11/homebrew-joinery
                                    │
                                    └─ brew install --cask cadam11/joinery/joinery
```

Nothing here runs on a branch, a PR, or a manual dispatch of `main`. The trigger is `push: tags: v*`
and there is no other way in — a release is a tag, and a tag is a release.

## The signing gate

Apple Developer credentials do not exist yet. The workflow is written so that the day they do,
adding five repository secrets is the entire change; no YAML edit, no config edit.

| Secret                        | What it is                                                   |
| ----------------------------- | ------------------------------------------------------------ |
| `CSC_LINK`                    | base64 of the Developer ID Application `.p12`                |
| `CSC_KEY_PASSWORD`            | that `.p12`'s export password                                |
| `APPLE_ID`                    | the Apple ID that owns the Developer Program membership      |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for that Apple ID, for `notarytool` |
| `APPLE_TEAM_ID`               | the 10-character team identifier                             |

All five, or none. The `Resolve signing mode` step counts them and sets one output:

- **All five present** → the build step gets them as environment variables. electron-builder imports
  the `.p12` into a temporary keychain, finds the Developer ID identity, signs with the hardened
  runtime already configured in `electron-builder.yml`, then notarizes and staples — its
  `notarizeIfProvided` reads `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` straight
  off `process.env` (`app-builder-lib/out/mac/MacTargetHelper.js:219-270`), so no `notarize` block
  is needed and none is added.
- **Any missing** → `CSC_IDENTITY_AUTO_DISCOVERY=false` goes into the build environment, which is
  electron-builder's documented "do not look for an identity" switch. It skips signing, and because
  `MacPackager.sign` returns before `notarizeIfProvided` when there is no identity
  (`macPackager.js:295-320`), notarization is never attempted either. The workflow emits a
  `::warning::` annotation, the job summary says **UNSIGNED**, and the release notes carry the
  Gatekeeper instructions.

There is no third state. Nothing ad-hoc signs, nothing sets `identity: "-"`, nothing strips a
quarantine attribute on the user's behalf. An unsigned build is labelled unsigned everywhere it is
mentioned: the annotation, the job summary, the release body, and the install page.

Windows is deliberately outside the gate. It has never been signed, `electron-builder.yml` has no
`win.certificateFile`, and the v1 checklist proposes Windows signing as optional. The Windows leg
builds and uploads exactly as it does today, and the release notes say SmartScreen will warn.

## Checksums

The `release` job is the only job that touches the GitHub Release. It downloads every artifact from
both build legs into one directory, runs `sha256sum` over them into `SHA256SUMS.txt`, and creates
the release with the artifacts and that file together.

This is a change from the old workflow, where each matrix leg uploaded to the release itself. Two
legs racing to create the same release is a real failure mode, and neither leg could ever see the
other's files, so a checksum manifest covering the whole release was not expressible. One publisher,
one manifest.

## The tap

The tap is `github.com/cadam11/homebrew-joinery`, public, holding `Casks/joinery.rb` and a README.
`cadam11/joinery/joinery` is how Homebrew spells "the `joinery` cask in the `joinery` tap owned by
`cadam11`".

**It does not exist yet.** Creating it is one command —
`./scripts/release/bootstrap-tap.sh`, which copies `Casks/joinery.rb`, `Casks/TAP_README.md` and
`LICENSE` into a fresh repository and pushes it. The script is idempotent: run against an existing
tap it says so and touches nothing, so it is safe to leave in the tree. `--dry-run` stages the
commit in a temp directory and stops. The bootstrap has to run before the first tag is pushed, or
the `homebrew` job fails on a checkout of a repository that is not there.

**`Casks/joinery.rb` in _this_ repo is the template and the single source of truth.** It is committed
with `version "0.0.0"` and all-zero checksums, which is not installable and is not meant to be. On a
tag, the `homebrew` job checks out the tap, copies this repo's template over the tap's copy, runs
`scripts/release/update-cask.ts` to stamp the real version and the two DMG checksums into it, and
pushes. Editing the cask means editing it here; the tap is an output.

The push crosses a repository boundary, so `GITHUB_TOKEN` cannot do it. It needs one more secret:

| Secret               | What it is                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| `HOMEBREW_TAP_TOKEN` | a token with `contents: write` on `cadam11/homebrew-joinery` and nothing else |

Absent, the `homebrew` job fails loudly rather than skipping — a release whose tap was not updated is
a release nobody can `brew upgrade` into, and that should be visible, not quiet.

**The cask installs an unsigned app until notarization exists.** Homebrew quarantines what it
installs; on an unsigned build the first launch is refused. The cask does not carry a
`quarantine: false` stanza to paper over that, because that would be Joinery telling the user's
machine to trust Joinery. The install page documents the one-time right-click → Open instead, and
that paragraph is deleted on the release where the notarization secrets first exist.

## Version, checksums, and the script

`scripts/release/update-cask.ts` is two things kept apart on purpose:

- `updateCaskSource(source, { version, sha256 })` — pure. Takes the cask text and returns new cask
  text. Asserts each stanza it intends to rewrite exists before rewriting it, and that both
  checksums are 64 hex characters. Fully unit-tested.
- a `main()` that reads argv, reads the file, calls the pure function, writes the file. The only I/O.

It runs under `node scripts/release/update-cask.ts` — Node 24's type stripping, no build step, no
`tsx` dependency. That is why the release workflow pins Node 24 where the old one pinned 20.

The version in the cask comes from the tag, with the leading `v` stripped, and the workflow asserts
it matches `package.json`'s `version`. A tag that disagrees with the manifest stops the release
before anything is published — the failure mode it prevents is a `v1.0.1` release whose DMG is named
`Joinery-1.0.0-arm64.dmg`, which would make every cask URL a 404.

## What came from the `publish-build` skill, and what did not

The skill (`.claude/commands/publish-build.md`) came across from the pre-rebrand project. Salvaged:

- **The release gate is the full harness**, not a subset. Kept verbatim in the rewritten skill.
- **Never push to `main`; bump on a branch, merge, tag the merge commit.** Kept — it is the repo's
  hard rule and the skill was the only place it was written down for releases.
- **The `cpu-features` / `beforeBuild` / symlink-swap troubleshooting.** Kept; still accurate, still
  the three ways a package run fails.
- **The `verify:package` acceptance step.** Kept and promoted into the workflow, where it runs on the
  artifact CI just built rather than on a local one.

Rewritten or dropped:

- **Steps 5, 6 and 7 — monitor CI, verify assets, download the DMG by hand** — became one thing the
  workflow does and one thing the human does. The skill no longer describes 16 expected files; the
  release job asserts what it publishes.
- **Step 8, the wiki.** The wiki does not exist; J-100 repointed Help ▸ Documentation at
  <https://usejoinery.com/>. The whole wiki-author section is gone, replaced by the docs-site pass
  the v1 checklist §4 identified. That page is written in the future tense today, because there is
  no release to download; the rewritten command carries the instruction to flip it to the present
  tense on the first tag, and to delete its unsigned-build section on the first signed one.
- **Nothing about signing, notarization, checksums or Homebrew was in the skill**, because none of it
  existed. All of it is new here.

The skill is kept rather than deleted: it holds the parts a workflow cannot: which version to
choose, running the harness before tagging, and the human judgement about release notes.

## Out of scope, on purpose

- **Auto-update.** `publish: null` stays. Shipping an updater is a commitment to an update feed
  forever; the v1 checklist proposes it out of scope and this design does not smuggle it back in.
- **Linux.** `electron-builder.yml` targets mac and win, deliberately.
- **Mac App Store.** Craig's ruling: no MAS distribution. No `mas` target, no provisioning profile.
- **A Windows package manager** (winget, Scoop). Homebrew first because macOS is the primary target.
