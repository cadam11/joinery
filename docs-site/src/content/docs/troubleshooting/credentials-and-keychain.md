---
title: Credential and keychain problems
description: Passwords that do not stick, "password not found in Keychain", and what Joinery does when the credential store refuses it.
sidebar:
  order: 2
---

Every secret Joinery holds — database passwords, SSH passwords and key passphrases, AI provider
API keys, and the Microsoft Entra ID token cache — goes to the operating system's credential
store: the macOS Keychain, or the Windows Credential Store. Nothing secret is written to a file.
[Where Joinery stores things](../../reference/storage-locations/) is the full map; this page is
what to do when that machinery misbehaves.

## One entry, read once

Joinery does not keep a keychain item per connection. It keeps **one** item — service
`ca.adam11.joinery`, account `credentials-vault` — holding a JSON object of every secret, read
once at startup and cached in the main process for the session. Saving a profile writes the whole
object back.

That shape explains two things you might otherwise read as faults:

- **The keychain is read once per launch, not once per connection.** Opening a second connection
  costs no keychain access at all; the answer is already in memory.
- **Deleting that one keychain item deletes every saved secret at once** — every database
  password, every SSH credential, every AI key. There is no per-connection item to remove.

If you are coming from an early build that stored one item per credential, the first launch after
upgrading migrates them into the vault and deletes the old items. That runs once, and only when
no vault exists yet.

An installed Joinery always uses that one service name, and nothing in its environment can move
it. A development build can repoint the vault at a throwaway service with the
`JOINERY_KEYCHAIN_SERVICE` variable — that is how Joinery's own test suite stays out of a
developer's real credentials — but a packaged app refuses the variable. If it happens to be set
when you launch Joinery, the app uses its own service anyway and writes a `CredentialStore`
warning to the log saying the variable was ignored.

The one packaged build that does honour it is a locally built _test_ bundle, which carries a
marker file that the release path refuses to publish — so no Joinery you can download or install
has it. [Building one](/getting-started/install/#build-a-packaged-app-locally) is a contributor's job, not
a user's.

## "Connection password not found in Keychain"

The profile is saved but its password is not. Joinery raises this when a connect or a query needs
a password for a profile and the vault has no entry under that profile's id. The same message
exists for SSH: _SSH password not found in Keychain_.

Common causes, in the order worth checking:

1. **The profile was saved with the password field empty.** Joinery skips the credential write
   when there is no password to write. Open the connection, type the password, save again.
2. **The vault was never readable this session.** See the next section — the app carries on
   without saved credentials rather than refusing to start, and says so in the status bar.
3. **The keychain item was deleted or the profile id changed.** Re-enter and save.

Re-entering the password and saving is the fix in all three cases. There is no repair command,
and there does not need to be one: the write is the repair.

## When the keychain refuses

If the read at startup fails — access denied, a locked keychain, keychain unavailable — Joinery
**does not stop**. It marks the store unavailable, continues with no saved credentials, and
writes a `CredentialStore` warning to the log reading _Keychain access unavailable - saved
credentials will not be loaded. Grant keychain access to enable credential storage._

After that, passwords you type are kept in memory for the rest of the session and are **not
persisted**. They work for this run and are gone at quit. A failed write behaves the same way and
logs its own line.

### The status bar tells you

The right-hand group of the status bar — just before the tab count — grows an amber **Keychain
unavailable** button, with a shield glyph, for as long as the store is degraded. Outside the log
it is the app's only warning that the passwords you type today will not be there tomorrow, and it
is worth trusting: it appears **only** when the credential store has actually been refused, never
while Joinery is still asking.

- **When it appears.** As soon as a keychain call fails. That is usually the read at startup, in
  which case the item is there as soon as the window has loaded; it can also be a save or a
  delete failing while the app is open, and then the item appears at that moment, with no
  restart.
- **When it goes away.** At the next launch, if the keychain answers. Joinery does not retry
  within a session, so the item stays for the rest of the run once it is up.
- **What to do.** Click it — it opens this page in your browser. Everything you do in the app
  still works; only persistence is lost, so treat any password you enter as good for this session
  only until the keychain is fixed.

There is no matching "keychain fine" indicator, by design: the bar reports the fault and stays
quiet otherwise.

The log has the detail behind the item. Open the output panel with **⌘J** and read the
`CredentialStore` lines — the sentence above for a failed read, _Failed to persist credential for
&lt;id&gt; - keychain access denied. Cached in memory for this session._ for a failed save, and
_Failed to persist deletion - keychain unavailable_ for a failed delete.

On macOS, the fix is usually in **Keychain Access**: find the `ca.adam11.joinery` entry, and
check that Joinery is allowed to read it. Rebuilding the app from source produces a differently
signed binary, which is the usual reason a previously granted permission stops applying.

## "Login failed" with a password you are sure of

This one is almost never the keychain. Joinery stores what you typed **byte for byte** — it never
trims, and the drivers pass genuine special characters through unharmed. What does break a login
is invisible junk that rides along with a paste: a leading or trailing space, a stray line break,
curly quotes from a document or chat app, a non-breaking space, an en dash where a hyphen was
meant.

Press **Test** in the connection editor. On an authentication failure the panel lists the
guidance the app has, and if any of those artifacts are present it names them — and, in that
case, states the password's character count so you can compare it against what you expected. It
never shows the password itself. A clean password adds no lines, so no news is genuine news: the
credentials really are being rejected as typed.

Retyping the password by hand, rather than pasting it again, is the fastest way to rule this out.

## API keys and Entra ID

An AI provider's key is stored in the same vault under `ai-<vendor-id>`, and removing the key in
the AI settings deletes that entry. If a provider suddenly reports an authentication failure and
the key looks right, it is worth checking the same paste artifacts as above.

The Microsoft Entra ID sign-in keeps its MSAL token cache in the vault too, under
`__entra_msal_cache__`. If Entra sign-in loops or silently re-prompts, the cache is the piece
that failed to persist — and a keychain that is not writable will do exactly that.

## Deleting a connection cleans up after itself

Deleting a connection profile deletes its database password, its SSH password and its key
passphrase along with it. You do not need to visit the keychain afterwards.

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                                                                                                                                                   | Source                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One keychain item: service `ca.adam11.joinery`, account `credentials-vault`, holding JSON                                                                                                               | `packages/main/src/services/keychain/credential-store.ts:21, 31-36, 80-92`                                                                                                          |
| The service name is the app id `ca.adam11.joinery`, unless `JOINERY_KEYCHAIN_SERVICE` repoints it — which only an unpackaged build honours (the test tiers are unpackaged; a shipped app never sets it) | `packages/shared/src/constants/index.ts:12`, `packages/main/src/services/keychain/service-name.ts:34, 90-120`                                                                       |
| A packaged app ignores the variable, uses the app id, and logs a warning that names neither service                                                                                                     | `packages/main/src/services/keychain/service-name.ts:96-107`, `packages/main/src/services/keychain/credential-store.ts:49-62`                                                       |
| A locally built test bundle — stamped `Contents/Resources/joinery-test-build` — is the one packaged build that honours the variable, and the release path refuses to publish one                        | `packages/main/src/services/keychain/service-name.ts:50-65, 96-107`, `packages/main/src/utils/test-build-capability.ts:37, 53-58`, `package.json` `package:test` / `verify:package` |
| It is read once at startup and cached, and concurrent callers share one read                                                                                                                            | `packages/main/src/services/keychain/credential-store.ts:64-78, 171-186`                                                                                                            |
| A save rewrites the whole vault                                                                                                                                                                         | `packages/main/src/services/keychain/credential-store.ts:130-135, 140-157`                                                                                                          |
| Legacy per-credential items are migrated into the vault and deleted, only when none exists                                                                                                              | `packages/main/src/services/keychain/credential-store.ts:93-112`                                                                                                                    |
| A failed read marks the store unavailable, continues, and logs that exact sentence                                                                                                                      | `packages/main/src/services/keychain/credential-store.ts:115-124`                                                                                                                   |
| A failed write keeps the value in memory for the session and logs it                                                                                                                                    | `packages/main/src/services/keychain/credential-store.ts:148-165`                                                                                                                   |
| A failed delete logs its own line and still removes the entry from memory                                                                                                                               | `packages/main/src/services/keychain/credential-store.ts:208-214`                                                                                                                   |
| The degradation is announced once per session, and carries availability only                                                                                                                            | `packages/main/src/services/keychain/credential-store.ts:231-259`                                                                                                                   |
| Availability never returns within a session — there is no retry                                                                                                                                         | `packages/main/src/services/keychain/credential-store.ts:244-246` (the flag is only ever cleared)                                                                                   |
| The state reaches the window over `credentials:*`: one invoke, one push, no secrets                                                                                                                     | `packages/shared/src/constants/ipc-channels.ts:168-173`, `packages/main/src/ipc/credentials.ipc.ts:22-40`                                                                           |
| The bridge exposes availability and no credential read or write                                                                                                                                         | `packages/preload/src/index.ts:396-403, 817-821`                                                                                                                                    |
| The renderer asks on mount and re-reads when main pushes                                                                                                                                                | `packages/renderer/src/state/keychain.ts:27-45`                                                                                                                                     |
| The status-bar item renders only while degraded, in the right-hand group                                                                                                                                | `packages/renderer/src/shell/status-bar.tsx:269-295, 356-359`                                                                                                                       |
| It is amber with a shield glyph, reads "Keychain unavailable", and opens this page                                                                                                                      | `packages/renderer/src/shell/status-bar.tsx:253, 282-292`                                                                                                                           |
| "Connection password not found in Keychain"                                                                                                                                                             | `packages/main/src/services/sql/connection-pool.ts:633, 735, 809`                                                                                                                   |
| "SSH password not found in Keychain"                                                                                                                                                                    | `packages/main/src/services/ssh/ssh-tunnel-manager.ts:96-100`                                                                                                                       |
| A profile saved with no password skips the credential write                                                                                                                                             | `packages/main/src/services/config/connection-profiles.ts:138-148`                                                                                                                  |
| Passwords are stored verbatim, and the paste artifacts that break a login                                                                                                                               | `packages/shared/src/validators/password-hygiene.ts:1-22, 63-77`                                                                                                                    |
| The findings, and the length line, are emitted only when an artifact is found                                                                                                                           | `packages/shared/src/validators/password-hygiene.ts:149-162`                                                                                                                        |
| Auth-failure guidance appends those findings, never the value                                                                                                                                           | `packages/main/src/services/sql/connection-pool.ts:1166-1180`                                                                                                                       |
| Test renders the error and every guidance line inline                                                                                                                                                   | `packages/renderer/src/features/connections/test-result-panel.tsx:29-60`                                                                                                            |
| AI provider keys are `ai-<vendor-id>`, set and deleted with the key                                                                                                                                     | `packages/main/src/services/ai/ai-service.ts:136-138, 154-156`                                                                                                                      |
| The Entra MSAL token cache is a vault entry named `__entra_msal_cache__`                                                                                                                                | `packages/main/src/services/azure/entra-auth.ts:12-13, 56-57`                                                                                                                       |
| Deleting a profile deletes its password and both SSH secrets                                                                                                                                            | `packages/main/src/services/config/connection-profiles.ts:191-193`                                                                                                                  |
| ⌘J toggles the output panel, which has an errors-only filter                                                                                                                                            | `packages/renderer/src/commands/catalogue.ts:559-566`, `shell/workspace/output-panel.tsx:191-202`                                                                                   |

</details>
