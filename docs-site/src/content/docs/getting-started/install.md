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

There is a fourth, and it is not one to hand to anyone:

```bash
pnpm run package:test   # a test-only bundle, for the packaged-app smoke run
```

`package:test` builds the ordinary bundle and then writes one marker file into it,
`Contents/Resources/joinery-test-build`. A bundle carrying that marker identifies itself as a test
build: the app logs a warning at startup saying so, and both packaged-app test runs refuse to launch
a bundle that lacks it — `pnpm run smoke:package`, which asks only whether the bundle comes up, and
`pnpm run test:smoke:packaged`, which packages a bundle and then drives it against local SQL Server,
PostgreSQL and MySQL containers to check it can still run a query. That refusal is the point — a
packaged Joinery must not be booted for a test against the keychain vault your installed Joinery
keeps real passwords in. A test build must never be distributed, and `pnpm run verify:package`
fails on a bundle that carries the marker, so the release path cannot publish one by accident.

The marker is also what earns the bundle its two test-only behaviours, and they are the reason it
exists. A stamped bundle honours `JOINERY_KEYCHAIN_SERVICE`, so the smoke runs point the
credential vault at a throwaway keychain service instead of the one holding your real passwords,
and it honours `JOINERY_TEST=1`, so the run stays headless. `pnpm run test:smoke:packaged` goes one
step further: it uses a fresh throwaway service per run and deletes every item it created when the
run ends, then checks that the keychain service your installed Joinery uses holds exactly as many
items as it did beforehand. A release bundle refuses both — and refuses every other test-only
variable by the same rule, including `JOINERY_DOCKER_FIXTURE`, which pins what the Docker panel
reports for the visual test tier and which a shipped app ignores in favour of the real daemon. It
is a property of the artifact rather than of the environment on purpose: anyone who could set one
environment variable to unlock a shipped app could set two.

One variable is **not** on that list and is stricter still: `JOINERY_PYTHON`, which names the Python
interpreter the SQL converter spawns. It is ordinary user configuration rather than a test hatch —
see [Prerequisites](../prerequisites/#python-and-sqlglot-for-sql-dialect-conversion) —
but it is refused by **any** packaged bundle, a stamped test bundle included, because it selects an
executable to run rather than redirecting a read.

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

### Joinery is not code-signed

Joinery is not signed with an Apple Developer ID, not notarized, and its Windows builds are not
code-signed either. There is no Apple Developer Program membership behind the project, and the
release workflow does not pretend otherwise: it has no signing step to skip and no certificate to
look for.

That costs you one extra step the first time you open it, and again each time you upgrade.

#### macOS

macOS quarantines Joinery however you install it — the Homebrew cask included, because Homebrew
quarantines what it downloads — and refuses the first launch.

1. Double-click Joinery. macOS refuses, and says the developer cannot be verified.
2. Open **System Settings → Privacy & Security**, scroll down to **Security**, and click **Open
   Anyway** beside the message about Joinery.
3. Confirm, and authenticate. Every launch after that one is normal.

**An upgrade asks again.** Homebrew can carry your approval forward across a `brew upgrade` only
when it can check that the new app is signed by the same developer as the old one. Joinery is not
signed at all, so there is nothing to check, and the new bundle arrives quarantined like the first
one did. Expect to repeat the three steps above after every upgrade.

On macOS Sonoma and earlier you can instead Control-click the app in Finder and choose **Open**.
[Apple removed that shortcut in macOS Sequoia](https://developer.apple.com/news/?id=saqachfa), so
on Sequoia and later the System Settings route above is the one that works.

If you would rather do it from a terminal, remove the quarantine flag before the first launch:

```bash
xattr -dr com.apple.quarantine "/Applications/Joinery.app"
```

The `-r` is not optional. Homebrew sets the flag on every file inside the app bundle, so removing
it from the bundle alone leaves the app blocked.

Homebrew used to accept `--no-quarantine`; that option was removed upstream, and the cask does not
strip the flag for you either. Deciding that Joinery is safe to run on your machine is your
decision to make, not Joinery's.

#### Windows

SmartScreen warns. Click **More info**, then **Run anyway**.

## What is not here yet

- **Downloads.** No release has been tagged. Pushing a `v*` tag runs the release workflow, which
  builds both platforms, publishes them with checksums, and updates the Homebrew tap.
- **Auto-update.** Not implemented, and deliberately out of scope for v1.
- **Linux.** The packaging config targets macOS and Windows only.

<details>
<summary>Where this page's facts come from</summary>

Every claim above was checked against the repository at the commit this page was written from.

| Claim                                                                                                             | Source                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Joinery is MIT licensed                                                                                           | `LICENSE:1`, `package.json:6` (`"license": "MIT"`)                                                                                                                                                                                      |
| No tagged releases and nothing to download                                                                        | `git tag` is empty; `.github/workflows/release.yml` triggers only on `push: tags: v*`                                                                                                                                                   |
| `git clone` → `cd` → `pnpm install` → `pnpm run dev`                                                              | `README.md:259-262`, `CONTRIBUTING.md:31-36`                                                                                                                                                                                            |
| `pnpm run dev` builds first, then runs renderer and main concurrently                                             | `package.json`, the `dev` script                                                                                                                                                                                                        |
| Node 20+, pnpm 11+, Xcode Command Line Tools                                                                      | `package.json` `engines`, `CONTRIBUTING.md:26-28`                                                                                                                                                                                       |
| `package:dmg`, `package:mac`, `package`                                                                           | `package.json` scripts; `package:dmg` is `node scripts/package.js --mac dmg:arm64 dmg:x64`                                                                                                                                              |
| `package:test` builds the bundle then stamps `Contents/Resources/joinery-test-build`                              | `package.json` `package:test`; `scripts/release/test-build-marker.ts` (`TEST_BUILD_MARKER_FILENAME`, `stampBundle`)                                                                                                                     |
| A stamped bundle honours `JOINERY_KEYCHAIN_SERVICE` and `JOINERY_TEST`; a release bundle refuses both             | `packages/main/src/services/keychain/service-name.ts:51-67, 99-110`; `packages/main/src/utils/runtime-mode.ts:101-105, 121-124` (`areTestHatchesHonoured`, `isTestHatchOpen`); `packages/main/src/utils/test-build-capability.ts:53-58` |
| Every test-only variable is gated on the same predicate, `JOINERY_DOCKER_FIXTURE` included                        | `packages/main/src/utils/runtime-mode.ts:101-105`; `packages/main/src/services/docker/docker-fixture.ts:88-105`; `packages/main/src/utils/env-hatch-gating.spec.ts` (the `HATCH_BEHAVIOUR` table)                                       |
| `JOINERY_PYTHON` is refused by any packaged bundle, stamped or not; the refusal warns once                        | `packages/main/src/services/sql/python-deps.ts` (`resolvePythonOverride`, `warnedAboutRefusal`); `packages/main/src/utils/env-hatch-gating.spec.ts` (`reopenedByTestBuild: false`)                                                      |
| A stamped bundle says so in the log at startup                                                                    | `packages/main/src/utils/test-build-capability.ts` (`isTestCapableBuild`, `TEST_BUILD_WARNING`); `packages/main/src/index.ts`                                                                                                           |
| `smoke:package` refuses a bundle without the marker                                                               | `scripts/release/smoke-packaged-app.ts` (`assertBundleIsTestCapable`)                                                                                                                                                                   |
| `test:smoke:packaged` packages a bundle, refuses an unstamped one, and queries all three engines                  | `package.json` (`pretest:smoke:packaged`, `test:smoke:packaged`); `tests/smoke-packaged/packaged-app.ts` (`launchPackagedJoinery` calls `assertBundleIsTestCapable`); `tests/smoke-packaged/smoke.spec.ts` (`ENGINE_CASES`)             |
| `test:smoke:packaged` uses a fresh throwaway keychain service and clears it, leaving the production one untouched | `tests/smoke-packaged/packaged-app.ts` (`SMOKE_KEYCHAIN_PREFIX`, `sweepSmokeKeychainServices`); `tests/smoke-packaged/smoke.spec.ts` (the `afterAll` assertions)                                                                        |
| `verify:package` fails on a bundle carrying the marker                                                            | `package.json` `verify:package` chains `scripts/release/test-build-marker.ts --check`                                                                                                                                                   |
| The DMG file names                                                                                                | `electron-builder.yml` `dmg.artifactName` (`${productName}-${version}-${arch}.dmg`)                                                                                                                                                     |
| The Windows installer file names                                                                                  | `electron-builder.yml` `nsis.artifactName` (`${productName}-${version}-${arch}-setup.exe`)                                                                                                                                              |
| Both macOS architectures, both Windows architectures                                                              | `electron-builder.yml` `mac.target` and `win.target`                                                                                                                                                                                    |
| The Homebrew command, and that the cask installs `Joinery.app` to /Applications                                   | `Casks/joinery.rb` (`cask "joinery"`, `app "Joinery.app"`), pushed to `cadam11/homebrew-joinery`                                                                                                                                        |
| `SHA256SUMS.txt` covers every asset                                                                               | `.github/workflows/release.yml`, the "Checksum everything that is about to be published" step                                                                                                                                           |
| macOS builds are not signed and not notarized                                                                     | `electron-builder.yml` `mac.identity: null`; `.github/workflows/release.yml` holds no `CSC_*` or `APPLE_*` secret                                                                                                                       |
| Windows builds are not code-signed                                                                                | `electron-builder.yml` has no `win.certificateFile` or `win.certificateSubjectName`                                                                                                                                                     |
| Homebrew quarantines what it installs, and propagates the flag into the bundle                                    | Homebrew 6.0.20, `Library/Homebrew/cask/download.rb:75` and `:128`, `extend/os/mac/cask/quarantine.rb`                                                                                                                                  |
| `--no-quarantine` was removed from Homebrew                                                                       | Homebrew commit `ba25213c81` (2026-07-30), "Remove leftover code for `--no-quarantine`"                                                                                                                                                 |
| A `brew upgrade` re-quarantines an unsigned app                                                                   | Homebrew 6.0.20, `Library/Homebrew/cask/upgrade.rb:310-334` — `quarantine_release_decision` returns `:signer_unverified` when the old app has no signing identity                                                                       |
| Control-click → Open no longer overrides Gatekeeper on macOS Sequoia and later                                    | [Apple Developer News](https://developer.apple.com/news/?id=saqachfa)                                                                                                                                                                   |
| Auto-update is not implemented                                                                                    | `electron-builder.yml` `publish: null`; no `electron-updater` dependency                                                                                                                                                                |
| macOS and Windows only                                                                                            | `electron-builder.yml` defines `mac` and `win`, no `linux`                                                                                                                                                                              |

</details>
