---
title: Install
description: Build Joinery from source today. Homebrew and packaged installers arrive with v1, and this page already describes what they will do.
sidebar:
  order: 1
---

Joinery is open source under the **MIT license**, and its source is on
[GitHub](https://github.com/cadam11/joinery).

It has no tagged releases today, so there is nothing to download yet and
`brew install --cask cadam11/joinery/joinery` does not resolve. Building from source is four
commands, and it is how everyone runs Joinery right now.

The release machinery for v1 is built and sitting behind the first tag. [What installing will look
like](#what-installing-will-look-like) describes it, so the promise is specific and you can hold
this page to it when the tag lands.

## Build from source

Check [Prerequisites](../prerequisites/) first: you need Node.js 20 or later, pnpm 11 or later,
and on macOS the Xcode Command Line Tools for the native modules.

```bash
git clone https://github.com/cadam11/joinery.git
cd joinery
pnpm install
pnpm run dev
```

`pnpm run dev` builds every package, then starts the Vite renderer and the Electron main process
together with hot reload. The window opens on the welcome tab — see [First run](../first-run/).

> **Note** — `pnpm install` fetches an Electron binary and compiles native modules (`keytar` for
> the keychain, `ssh2` for tunnelling). The first install is therefore slower than the ones after
> it.

## Build a packaged app locally

You can produce the same artifacts the v1 release will ship, unsigned:

```bash
pnpm run package:dmg   # macOS DMG, arm64 and x64 — what the release publishes
pnpm run package:mac   # the same, plus the zips
pnpm run package       # the current platform
```

None of them is code-signed or notarized, so macOS Gatekeeper and Windows SmartScreen will warn
about a locally built app.

## Keeping a source install current

```bash
git pull
pnpm install
pnpm run dev
```

Run `pnpm install` after every pull: dependencies move with the code, and a stale
`node_modules` is the usual cause of a build that worked yesterday.

## What installing will look like

None of this works yet. It starts working when the first `v*` tag is pushed, which is what runs the
release workflow.

### Homebrew, on macOS

```bash
brew install --cask cadam11/joinery/joinery
```

The cask installs `Joinery.app` into `/Applications` and follows releases from then on, so
`brew upgrade --cask joinery` is how you move to the next version.

### Direct download, on macOS and Windows

Each release carries four installers:

| Platform             | File                                |
| -------------------- | ----------------------------------- |
| macOS, Apple Silicon | `Joinery-<version>-arm64.dmg`       |
| macOS, Intel         | `Joinery-<version>-x64.dmg`         |
| Windows, x64         | `Joinery-<version>-x64-setup.exe`   |
| Windows, ARM64       | `Joinery-<version>-arm64-setup.exe` |

A `SHA256SUMS.txt` covering every file in the release is published beside them, so a download can
be checked before it is opened:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

### The unsigned-build warning

Joinery is not yet signed with an Apple Developer ID and not yet notarized, and its Windows builds
are not code-signed either. That is a missing certificate, not a missing intention: the release
workflow signs and notarizes automatically once the credentials exist, and until then it labels
every build unsigned in its own release notes rather than quietly shipping one.

What that means for you, on the first launch only:

- **macOS** — the app is quarantined. Open it once from Finder with right-click → **Open**, or run
  `xattr -d com.apple.quarantine "/Applications/Joinery.app"`. This applies to the Homebrew install
  too: Homebrew quarantines what it downloads.
- **Windows** — SmartScreen warns. Click **More info**, then **Run anyway**.

This section goes away on the release where signing first happens.

## What is not here yet

- **Downloads.** No release has been tagged. Pushing a `v*` tag runs the release workflow, which
  builds both platforms, publishes them with checksums, and updates the Homebrew tap.
- **Auto-update.** Not implemented, and deliberately out of scope for v1.
- **Linux.** The packaging config targets macOS and Windows only.

<details>
<summary>Where this page's facts come from</summary>

Every claim above was checked against the repository at the commit this page was written from.

| Claim                                                                           | Source                                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Joinery is MIT licensed                                                         | `LICENSE:1`, `package.json:6` (`"license": "MIT"`)                                                          |
| No tagged releases and nothing to download                                      | `git tag` is empty; `.github/workflows/release.yml` triggers only on `push: tags: v*`                       |
| `git clone` → `cd` → `pnpm install` → `pnpm run dev`                            | `README.md:259-262`, `CONTRIBUTING.md:31-36`                                                                |
| `pnpm run dev` builds first, then runs renderer and main concurrently           | `package.json`, the `dev` script                                                                            |
| Node 20+, pnpm 11+, Xcode Command Line Tools                                    | `package.json` `engines`, `CONTRIBUTING.md:26-28`                                                           |
| `package:dmg`, `package:mac`, `package`                                         | `package.json` scripts; `package:dmg` is `node scripts/package.js --mac dmg:arm64 dmg:x64`                  |
| The DMG file names                                                              | `electron-builder.yml` `dmg.artifactName` (`${productName}-${version}-${arch}.dmg`)                         |
| The Windows installer file names                                                | `electron-builder.yml` `nsis.artifactName` (`${productName}-${version}-${arch}-setup.exe`)                  |
| Both macOS architectures, both Windows architectures                            | `electron-builder.yml` `mac.target` and `win.target`                                                        |
| The Homebrew command, and that the cask installs `Joinery.app` to /Applications | `Casks/joinery.rb` (`cask "joinery"`, `app "Joinery.app"`), pushed to `cadam11/homebrew-joinery`            |
| `SHA256SUMS.txt` covers every asset                                             | `.github/workflows/release.yml`, the "Checksum everything that is about to be published" step               |
| Signing and notarization run only when all five Apple secrets exist, and say so | `.github/workflows/release.yml`, the "Resolve the macOS signing mode" step; `plans/release/DISTRIBUTION.md` |
| Windows builds are not code-signed                                              | `electron-builder.yml` has no `win.certificateFile` or `win.certificateSubjectName`                         |
| Homebrew quarantines its downloads, hence the same first-launch step            | `Casks/joinery.rb` `caveats`                                                                                |
| Auto-update is not implemented                                                  | `electron-builder.yml` `publish: null`; no `electron-updater` dependency                                    |
| macOS and Windows only                                                          | `electron-builder.yml` defines `mac` and `win`, no `linux`                                                  |

</details>
