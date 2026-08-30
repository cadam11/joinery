#!/usr/bin/env bash
#
# Create cadam11/homebrew-joinery and seed it, once. Everything after this is done by
# .github/workflows/release.yml, which only ever pushes an updated Casks/joinery.rb.
#
#   ./scripts/release/bootstrap-tap.sh            # create and push
#   ./scripts/release/bootstrap-tap.sh --dry-run  # stage it in a temp dir and stop
#
# Idempotent: if the repository already exists it says so and exits 0 without touching it.
#
# Needs `gh` authenticated as someone who can create a public repository under cadam11.
set -euo pipefail

readonly TAP_REPO="cadam11/homebrew-joinery"
readonly TAP_DESC="Homebrew tap for Joinery - brew install --cask cadam11/joinery/joinery"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT_DIR

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

for required in "$ROOT_DIR/Casks/joinery.rb" "$ROOT_DIR/Casks/TAP_README.md" "$ROOT_DIR/LICENSE"; do
  if [ ! -f "$required" ]; then
    echo "missing $required — run this from a full checkout." >&2
    exit 1
  fi
done

if gh repo view "$TAP_REPO" >/dev/null 2>&1; then
  echo "$TAP_REPO already exists; nothing to bootstrap."
  echo "The release workflow keeps its cask current. Leaving it alone."
  exit 0
fi

staging="$(mktemp -d)"
# Owned from here on: removed on every exit path, including an interrupted run.
trap 'rm -rf "$staging"' EXIT INT TERM

mkdir -p "$staging/Casks"
cp "$ROOT_DIR/Casks/joinery.rb" "$staging/Casks/joinery.rb"
cp "$ROOT_DIR/Casks/TAP_README.md" "$staging/README.md"
cp "$ROOT_DIR/LICENSE" "$staging/LICENSE"

git -C "$staging" init -q -b main
git -C "$staging" add -A
git -C "$staging" -c user.email="craig@adam11.ca" -c user.name="Craig Adam" \
  commit -q -m "chore: the Joinery tap, generated from cadam11/joinery

Casks/joinery.rb is the template as committed in the application repo,
placeholder version and all: 0.0.0 with all-zero checksums, so nothing
here is installable until the first v* tag rewrites it."

if [ "$DRY_RUN" = true ]; then
  echo "Dry run. Staged in $staging:"
  git -C "$staging" --no-pager show --stat HEAD
  echo "(the staging directory is removed on exit)"
  exit 0
fi

gh repo create "$TAP_REPO" --public --source="$staging" --remote=origin --push --description "$TAP_DESC"

echo
echo "Created $TAP_REPO."
echo "Next: add HOMEBREW_TAP_TOKEN to cadam11/joinery — a token with contents:write on"
echo "$TAP_REPO — or the homebrew job of the release workflow will fail."
