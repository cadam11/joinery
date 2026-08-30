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

## Joinery is not code-signed

There is no Apple Developer Program membership behind Joinery, so its macOS builds are not
signed and not notarized. Homebrew quarantines what it installs, so the first launch is refused.

Allow it, and macOS remembers until the app is replaced:

1. Double-click Joinery. macOS refuses.
2. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open
   Anyway** next to the message about Joinery.
3. Confirm and authenticate.

`brew upgrade` replaces the bundle, and Homebrew can only carry your approval forward when it can
verify the new app has the same signer as the old one. An unsigned app has none, so expect the
same three steps after each upgrade.

On macOS Sonoma and earlier, Control-click the app in Finder and choose **Open** instead;
[Apple removed that shortcut in macOS Sequoia](https://developer.apple.com/news/?id=saqachfa).

Or drop the flag yourself before the first launch:

```bash
xattr -dr com.apple.quarantine "/Applications/Joinery.app"
```

`-r` is not optional — Homebrew propagates the quarantine flag onto every file inside the
bundle, not just the bundle itself.

The cask says the same thing in its `caveats`. It carries no `postflight` that strips the flag
for you: that would be Joinery deciding on your machine that Joinery is safe to run.

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
