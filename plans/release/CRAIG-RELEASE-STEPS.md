# Cutting a Joinery release — Craig's steps

Everything a human has to do. One action per step. No Apple developer account is involved, and
none is needed.

Design and rationale: [`DISTRIBUTION.md`](DISTRIBUTION.md). What the loop does: `/publish-build`.

---

## Part A — once, ever

Six steps, about five minutes. Step A1 is already done.

### A1. The tap repository ✅ done

`github.com/cadam11/homebrew-joinery` exists and is public. Nothing to do.

_(If it ever has to be rebuilt: `./scripts/release/bootstrap-tap.sh` from the repo root. It is
idempotent and `--dry-run` shows what it would push.)_

### A2. Open GitHub's fine-grained token page

<https://github.com/settings/personal-access-tokens/new>

### A3. Fill in the token form

| Field                  | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Token name             | `joinery-homebrew-tap`                                    |
| Expiration             | whatever you want — put the date in your calendar         |
| Resource owner         | `cadam11`                                                 |
| Repository access      | **Only select repositories** → `cadam11/homebrew-joinery` |
| Repository permissions | **Contents** → **Read and write**. Nothing else.          |

Leave every other permission alone. "Metadata: Read-only" turns itself on — that is expected and
required.

### A4. Click "Generate token" and copy it

It is shown once. Copy it now.

### A5. Store it as a repository secret

Paste the token when this prompts you:

```bash
gh secret set HOMEBREW_TAP_TOKEN --repo cadam11/joinery
```

### A6. Check it landed

```bash
gh secret list --repo cadam11/joinery
```

You want one line: `HOMEBREW_TAP_TOKEN`. There should be no others — Joinery uses exactly one
secret.

**Part A is done.** You never do it again unless the token expires.

---

## Part B — every release

Ask the loop for `/publish-build`. It does steps B1–B4 and stops in front of you at B5.

### B1. The loop runs the full test harness

`pnpm run test:full` — unit, integration, e2e, visual. It needs Docker Desktop running, so it will
ask you to start it. **If anything is red, the release stops here.** That is the point of the step.

### B2. The loop proposes a version number

It reads `package.json` and suggests the next one. You say yes, or you say a different number.

### B3. The loop bumps the version through a PR

Branch, one-line commit, PR, merge. Nothing is pushed to `main` directly, ever.

### B4. The loop asks: "tag `vX.Y.Z`?"

**This is the decision point.** Say yes and the release is public a few minutes later. There is no
undo that un-downloads a DMG.

### B5. You say go

The loop runs:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

That push _is_ the release. There is no other trigger, no button, no manual upload.

### B6. Watch it, or let the loop watch it

About 40 minutes. Four jobs in order:

| Job        | Takes   | Does                                                            |
| ---------- | ------- | --------------------------------------------------------------- |
| `guard`    | ~1 min  | tag matches `package.json`; the tap token still reaches the tap |
| `build`    | ~35 min | macOS DMGs + Windows installers, both architectures             |
| `release`  | ~2 min  | `SHA256SUMS.txt`, then the GitHub Release                       |
| `homebrew` | ~1 min  | stamps the cask and pushes it to the tap                        |

**Expect one yellow warning on the `build` job**, every time: `Unsigned build`. That is not a
problem — it is the workflow saying out loud what it shipped. The run is still green.

If `guard` fails, nothing was published and nothing is broken; fix and re-tag.
If `homebrew` fails, the release _is_ public — fix the token and re-run just that job. The cask
rewrite is idempotent.

### B7. Install it the way a user would

```bash
brew update && brew install --cask cadam11/joinery/joinery
```

Then open Joinery and **confirm the first-launch instructions actually work**, because that text
is the only help a user gets:

1. Double-click it. macOS refuses.
2. **System Settings → Privacy & Security**, scroll to **Security**, **Open Anyway**.
3. Authenticate. It opens.

If that does not match what happens on your Mac, the cask `caveats`, the release notes, the
install page and the README all say the same wrong thing and all four need fixing.

---

## What Joinery does not do, on purpose

- **No Apple Developer Program membership**, so no Developer ID signature and no notarization. The
  cost is one extra click for a user, once, on the first launch.
- **No auto-update.** Users get new versions with `brew upgrade --cask joinery`, or by downloading
  the next DMG.
- **The cask does not strip the quarantine flag for you.** Homebrew quarantines what it installs
  and no longer offers a way to opt out. Undoing that from inside the cask would be Joinery
  deciding, on someone else's machine, that Joinery is trustworthy.

---

## If something goes wrong

| What you see                                         | What it means                                     | Fix                                                                      |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `guard`: "Tag does not match package.json"           | you tagged a version the manifest does not claim  | delete the tag, bump `package.json` through a PR, tag again              |
| `guard`: "HOMEBREW_TAP_TOKEN is not set"             | Part A was skipped                                | do Part A                                                                |
| `guard`: "The tap is not reachable"                  | the token expired, or is scoped to the wrong repo | make a new token (A2–A5)                                                 |
| `build` fails on `cpu-features`                      | the `beforeBuild` hook did not run                | see the Troubleshooting section of `/publish-build`                      |
| `release`: "Missing installer"                       | electron-builder renamed an artifact              | the cask URLs would 404; fix the naming before re-tagging                |
| A user says "Joinery is damaged and can't be opened" | quarantine, plus an incomplete removal attempt    | `xattr -dr com.apple.quarantine "/Applications/Joinery.app"` — with `-r` |
