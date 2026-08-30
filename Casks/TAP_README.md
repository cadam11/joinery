# Joinery Homebrew tap

The Homebrew tap for [Joinery](https://usejoinery.com/), an AI-native SQL IDE for SQL Server,
PostgreSQL and MySQL.

```bash
brew install --cask cadam11/joinery/joinery
```

## This repository is generated

`Casks/joinery.rb` is written by CI, not by hand. The template lives in the application
repository at [`cadam11/joinery`](https://github.com/cadam11/joinery) as `Casks/joinery.rb`;
`.github/workflows/release.yml` there copies it here on every `v*` tag and stamps in the version
and the two DMG checksums with `scripts/release/update-cask.ts`.

**Send cask changes to `cadam11/joinery`.** A commit made directly here is overwritten by the
next release.

## Until Joinery is notarized

Joinery's macOS builds are not yet signed with an Apple Developer ID or notarized. Homebrew
quarantines what it installs, so the first launch is refused with "Joinery cannot be opened
because the developer cannot be verified".

Open it once from Finder with right-click → Open, or:

```bash
xattr -d com.apple.quarantine "/Applications/Joinery.app"
```

The cask says the same thing in its `caveats`, and both notes are removed in the first release
built with signing.

## Verifying a download yourself

Every release carries a `SHA256SUMS.txt` covering all of its assets:

```bash
gh release download vX.Y.Z --repo cadam11/joinery --pattern 'SHA256SUMS.txt'
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

## Issues

File them against [`cadam11/joinery`](https://github.com/cadam11/joinery/issues). This repository
has no code of its own.

## Licence

MIT, the same as Joinery.
