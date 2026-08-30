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

  caveats <<~EOS
    Joinery is not yet signed with an Apple Developer ID or notarized, so macOS
    quarantines it on first launch. Open it once from Finder with right-click -> Open,
    or run:

      xattr -d com.apple.quarantine "/Applications/Joinery.app"

    This caveat is removed from the cask in the first release built with signing.
  EOS
end
