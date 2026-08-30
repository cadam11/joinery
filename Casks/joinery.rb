# The canonical Joinery cask. This file is the template: `.github/workflows/release.yml`
# copies it into cadam11/homebrew-joinery on every tag and stamps the real version and
# checksums into it with `scripts/release/update-cask.ts`.
#
# The committed version and checksums are deliberately unreal — 0.0.0 and all zeros — so
# that this copy can never be installed by accident, and so the rewrite has a fixed shape
# to match. Edit the cask HERE; the tap is an output.
cask "joinery" do
  arch arm: "arm64", intel: "x64"

  version "0.0.0"
  sha256 arm:   "0000000000000000000000000000000000000000000000000000000000000000",
         intel: "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/cadam11/joinery/releases/download/v#{version}/Joinery-#{version}-#{arch}.dmg",
      verified: "github.com/cadam11/joinery/"
  name "Joinery"
  desc "AI-native SQL IDE for SQL Server, PostgreSQL and MySQL"
  homepage "https://usejoinery.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "Joinery.app"

  zap trash: [
    "~/Library/Application Support/Joinery",
    "~/Library/Preferences/ca.adam11.joinery.plist",
    "~/Library/Saved Application State/ca.adam11.joinery.savedState",
  ]

  # No `postflight` that strips com.apple.quarantine, deliberately. Homebrew quarantines what
  # it installs and gives neither a cask stanza nor a user flag to opt out any more
  # (`--no-quarantine` was removed upstream on 2026-07-30). A cask that quietly undid it would
  # be Joinery deciding, on the user's machine, that Joinery is trustworthy. The caveat below
  # tells them what to do instead and lets them decide.
  caveats <<~EOS
    Joinery is not code-signed and not notarized, so macOS quarantines it and refuses
    the first launch. To allow it:

      1. Double-click Joinery. macOS will refuse.
      2. Open System Settings -> Privacy & Security, scroll to Security, and click
         "Open Anyway" next to the message about Joinery.
      3. Confirm and authenticate. Every launch after that is normal.

    Expect to do this again after each `brew upgrade`: Homebrew only carries a
    Gatekeeper approval forward when it can verify the new app has the same signer
    as the old one, and an unsigned app has no signer to verify.

    On macOS Sonoma and earlier, Control-click the app in Finder and choose Open
    instead. Apple removed that shortcut in macOS Sequoia.

    Or drop the quarantine flag yourself, before the first launch:

      xattr -dr com.apple.quarantine "/Applications/Joinery.app"

    The -r matters: Homebrew sets the flag on every file inside the bundle.
  EOS
end
