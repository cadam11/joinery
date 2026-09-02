# Joinery release distribution

How a tag becomes something a person can install. One page; the workflow is the implementation of
this page and nothing else describes it.

## The pipeline

```
git tag v1.0.0 && git push origin v1.0.0
        │
        ├─ build (macos-latest)  ── DMG + zip, arm64 and x64      (unsigned)
        ├─ build (windows-latest) ── NSIS + zip, x64 and arm64    (unsigned)
        │
        ├─ release (ubuntu) ── collect artifacts → SHA256SUMS.txt → GitHub Release
        │
        └─ homebrew (ubuntu) ── rewrite Casks/joinery.rb → push to cadam11/homebrew-joinery
                                    │
                                    └─ brew install --cask cadam11/joinery/joinery
```

Nothing here runs on a branch, a PR, or a manual dispatch of `main`. The trigger is `push: tags: v*`
and there is no other way in — a release is a tag, and a tag is a release.

## Signing: there isn't any

**Craig's ruling, 2026-08-30: no Apple Developer Program membership.** That is a decision about
money and administrative overhead, not an oversight, and this design takes it at face value rather
than leaving a dormant signing path in the workflow pretending otherwise.

What that means concretely:

- `electron-builder.yml` sets `mac.identity: null`. app-builder-lib's own schema documents the
  three states: unset means "search the keychain", `null` means "skip signing entirely", `"-"`
  means "ad-hoc". `null` is the only one whose behaviour does not depend on which certificates
  happen to be installed on the machine running the build, so a developer's local
  `pnpm run package:dmg` produces the same unsigned artifact CI does.
- `MacPackager.sign()` returns at `handleNullIdentity()` before it would reach
  `notarizeIfProvided()`, so notarization is not merely unconfigured — it is unreachable.
- The workflow carries **no** `CSC_*` or `APPLE_*` secret, no signing gate, no `spctl --assess`
  step, and no conditional release notes. `scripts/release/unsigned-release.spec.ts` fails if any
  of that comes back by accident.

### Why not ad-hoc signing

`mac.identity: "-"` would ad-hoc sign the bundle, which would give it a stable code-signing
identifier (`ca.adam11.joinery` instead of the Electron binary's inherited `Electron`) and sealed
resources. It was considered and rejected for v1:

- It buys **nothing** from Gatekeeper. An ad-hoc signature is not a Developer ID signature; the
  quarantine refusal on first launch is identical.
- It would apply `hardenedRuntime: true` and `resources/entitlements.mac.plist` to the app for the
  first time. That plist contains `com.apple.security.keychain-access-groups` with an unresolved
  `$(AppIdentifierPrefix)` — an Xcode build-setting variable that `codesign` does not substitute.
  Joinery's entire credential store is keytar over the macOS Keychain, so the failure mode of
  getting that wrong is "v1 cannot save a connection password", discoverable only by launching a
  packaged build and connecting to a database.
- The artifact shipped today is the artifact that has been built, mounted, `verify:package`-ed and
  run. Changing its signing state for zero user-visible benefit is risk without return.

Filed as a follow-up rather than done here.

### What a user actually has to do

An unsigned app that arrives with `com.apple.quarantine` set is refused on first launch. Four
facts govern the advice we give, and each of them was checked rather than assumed:

1. **Homebrew quarantines what it installs, and the flag lands on every file in the bundle.**
   `Cask::Download#fetch` calls `quarantine(downloaded_path)`, and
   `#extract_primary_container` then calls `Quarantine.propagate`, which globs `to/**/*` and
   writes the attribute onto every path it finds (Homebrew 6.0.20,
   `Library/Homebrew/cask/download.rb:75` and `:128`). So the removal command is
   `xattr -dr`, with the `-r`; the non-recursive form leaves the app blocked.
2. **There is no opt-out.** Homebrew removed `--no-quarantine` on 2026-07-30 (commit
   `ba25213c81`, "Remove leftover code for `--no-quarantine`"), and there is no `quarantine:`
   cask stanza. On macOS, `Quarantine.available?` is true whenever `xattr` is present
   (`extend/os/mac/cask/quarantine.rb`), so this is not a thing that quietly stops happening.
3. **Control-click → Open no longer works.** Apple: _"In macOS Sequoia, users will no longer be
   able to Control-click to override Gatekeeper when opening software that isn't signed correctly
   or notarized. They'll need to visit System Settings > Privacy & Security to review security
   information for software before allowing it to run."_
   (<https://developer.apple.com/news/?id=saqachfa>). Every place Joinery documented
   right-click → Open was wrong for macOS 15 and later, which includes the macOS 26 this is
   written on.
4. **It is not a one-time cost — every `brew upgrade` charges it again.** Homebrew carries a
   user's Gatekeeper approval forward across an upgrade only when it can verify the new bundle is
   signed by the same identity as the old one: `Cask::Upgrade.quarantine_release_decision` reads
   `Quarantine.signing_identity(old_app)`, and returns `:signer_unverified` the moment that is
   `nil` (Homebrew 6.0.20, `Library/Homebrew/cask/upgrade.rb:310-334` and `:450`). An unsigned app
   has no signing identity, so the approval is never inherited and Homebrew prints "macOS may
   prompt at next launch". This is the recurring cost of shipping unsigned and the strongest
   argument on the day a certificate is reconsidered.

So the instruction everywhere — cask `caveats`, tap README, release notes, install page, README —
is: **System Settings → Privacy & Security → Open Anyway**, with Control-click → Open named as the
Sonoma-and-earlier alternative and `xattr -dr` as the terminal route, and the upgrade repeat said
out loud rather than left to be discovered.

### Why the cask has no `postflight`

A cask can run arbitrary Ruby in a `postflight` block, and one line there would strip the
quarantine flag on the user's behalf. It is not there. Homebrew quarantines deliberately and no
longer lets the user turn that off; a cask that undoes it is the software asserting its own
trustworthiness on a machine that has not agreed to that. It would also make the caveat a lie, and
the caveat is the only place a user learns what is going on. The user does the one extra step, or
runs `xattr -dr` themselves, and either way it is their decision.

Windows is unsigned for the same reason and always has been: `electron-builder.yml` has no
`win.certificateFile`, and the release notes say SmartScreen will warn.

## Token permissions

The workflow defaults to `permissions: contents: read` and each job re-declares what it needs, so
that adding a job cannot silently inherit write access:

| Job        | `GITHUB_TOKEN`    | Why                                                   |
| ---------- | ----------------- | ----------------------------------------------------- |
| `guard`    | `contents: read`  | checkout; reads the tap through `HOMEBREW_TAP_TOKEN`  |
| `build`    | `contents: read`  | checkout; artifact upload uses the runner's own token |
| `release`  | `contents: write` | `gh release create` — the only writer in the workflow |
| `homebrew` | `contents: read`  | checkout and `gh release download`                    |

The `build` job matters most: it runs third-party install and build scripts (pnpm lifecycle hooks,
`node-gyp`, electron-builder), so it must not hold a token that can write to the repository. It now
holds no secret at all — not even `GITHUB_TOKEN` on the electron-builder step, which was dead
credential-passing under `publish: null`. The tap push is a different repository and is
authenticated by `HOMEBREW_TAP_TOKEN`, never by `GITHUB_TOKEN`.

`HOMEBREW_TAP_TOKEN` is the workflow's only secret, and `guard` spends two API calls on it
**before** anything is published — the failure it prevents is a permanent public GitHub Release
that Homebrew users cannot `brew upgrade` into.

Be exact about what those calls prove, because the obvious reading is wrong. The tap is a **public**
repository, and a fine-grained token "always include[s] read-only access to all public repositories
on GitHub"
([GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
So `gh api repos/…` succeeding proves the secret is set and the credential is live and unexpired —
it proves nothing about scope and nothing about write access. The second call reads
`.permissions.push`, the only write signal in that response: `false` fails the release, and an
absent or null field warns instead of blocking, because GitHub does not document that field's
behaviour for fine-grained tokens and a false alarm here costs a delete-and-re-tag. A wrongly
scoped token that gets past both still fails in `homebrew`, which is re-runnable on its own.

## What is inside the archive

`pnpm run verify:package` — the `build` job's acceptance check — is two things chained. The first,
`scripts/verify-package.js`, extracts `app.asar` and `require()`s every module the main process
depends on, so a missing transitive dependency fails the release rather than the user's first
connection. The second, `scripts/release/asar-inventory.ts --check`, fails if a build-time or
known-dead package is inside the archive.

The measurement behind that second check, and the 121 MB it took out of a release, is
[ASAR-INVENTORY.md](./ASAR-INVENTORY.md).

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

**It exists** (created 2026-08-30 by `./scripts/release/bootstrap-tap.sh`, which copies
`Casks/joinery.rb`, `Casks/TAP_README.md` and `LICENSE` into a fresh repository and pushes it). The
script is idempotent — run against an existing tap it says so and touches nothing — so it stays in
the tree for the day the tap has to be rebuilt. Its cask is still the `0.0.0` template; the first
tag replaces it.

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

The cask's `caveats` and the tap README both carry the first-launch instructions, and
`scripts/release/unsigned-release.spec.ts` asserts every `xattr` line in the repository is
recursive. See "What a user actually has to do" above.

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
  the v1 checklist identified. That page is written in the future tense today, because there is no
  release to download; the rewritten command carries the instruction to flip it to the present
  tense on the first tag. Its unsigned-build section is not temporary and does not get deleted.
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
- **Apple Developer ID signing and notarization.** Craig's ruling, 2026-08-30. If that changes, the
  work is: buy the membership, export the `.p12`, add five secrets, set `mac.identity` back to
  unset (or to the identity name), restore the `spctl --assess` gate, and delete the unsigned
  paragraphs from the cask `caveats`, the tap README, the install page and the README. It is a
  contained change and it is written down here so it does not have to be rediscovered.
