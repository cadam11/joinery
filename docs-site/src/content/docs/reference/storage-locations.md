---
title: Where Joinery stores things
description: The files Joinery writes, the credential store it uses instead of writing secrets, and the one browser key the window is allowed to touch.
sidebar:
  order: 6
---

Joinery keeps two kinds of state in two different places, on purpose.

- **Secrets** — database passwords, SSH passwords and passphrases, AI provider API keys, and the
  Microsoft Entra ID token cache — go to the **operating system's credential store**: the macOS
  Keychain, or the Windows Credential Store.
- **Everything else** — connection profiles without their passwords, window and layout state, query
  history, saved results, chat conversations — goes to **JSON files in the app's user-data folder**,
  written by the main process.

The window itself writes almost nothing. Persistence is an IPC call to the main process, and a test
reads every source file in the renderer to make sure it stays that way.

## The user-data folder

Electron's per-application data directory, named after the app:

| Platform | Folder                                  |
| -------- | --------------------------------------- |
| macOS    | `~/Library/Application Support/Joinery` |
| Windows  | `%APPDATA%\Joinery`                     |

Earlier versions named this folder `joinery`, in lowercase. On macOS and Windows disks as they ship,
upper and lower case are the same name — so that folder and this one are one folder, nothing moved,
and you may still see it listed in lowercase. On a disk formatted case-sensitively they are two
folders, and the first launch after upgrading moves the old one's contents into the new one.

## The files

| File or folder        | What is in it                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-state.json`      | The session: open tabs and the active one, the profiles that were connected at quit, the last database, sidebar width and collapsed state, panel sizes, the workspace layout, and AI preferences |
| `connections.json`    | Saved connection profiles — **without passwords**                                                                                                                                                |
| `query-history.json`  | Executed queries, for the history dialog                                                                                                                                                         |
| `window-state.json`   | Window size, position and whether it was maximised                                                                                                                                               |
| `query-results-data/` | Saved result snapshots: `index.json` holds the metadata, and each snapshot is its own `<id>.json`                                                                                                |
| `query-results.json`  | The previous snapshot format, a single JSON blob. Emptied into the folder above on first launch after the upgrade                                                                                |
| `chat-history/`       | One `<conversation-id>.json` per assistant conversation                                                                                                                                          |

Snapshots are pruned: at most 50 per tab, at most 50,000 rows kept from one result, and a 500 MB
ceiling. A retention pass runs at most once a day and drops snapshots older than 30 days. Two things
survive it: anything you have **pinned**, and each tab's **five most recent** snapshots, however old
they are — so a tab you have not opened in months still has its last few results waiting in it. The
floor is counted per tab over all of that tab's snapshots, pinned ones included.

## Credentials

Everything secret goes through `keytar` to the OS credential store, under the service name
`ca.adam11.joinery`. It is **one entry**, a JSON vault called `credentials-vault`, read once at
startup and cached in the main process for the session — one keychain prompt rather than one per
connection.

| Entry inside the vault          | What it holds                              |
| ------------------------------- | ------------------------------------------ |
| `<profile-id>`                  | The database password for that profile     |
| `<profile-id>:ssh-password`     | The SSH password for that profile's tunnel |
| `<profile-id>:ssh-passphrase`   | The passphrase for its private key         |
| `ai-<vendor-id>`                | That AI provider's API key                 |
| The Entra ID (MSAL) token cache | Refresh state for Microsoft Entra sign-in  |

Deleting a connection profile deletes its password and its SSH credentials with it.

No password reaches the JSON files above: the profile store is explicitly a store of profiles
without passwords, and the password travels straight to the credential store when a profile is
saved.

## The one key Joinery writes

The renderer is allowed to touch `localStorage` in exactly two modules, and a structural test fails
the build if any other file does. Only one key is **kept** there:

- **`joinery:theme-preference`** is written by the theme mirror, and it is the only browser key
  Joinery maintains. A small script in the page head needs the theme **before** the app starts, to
  paint the right canvas rather than flashing the wrong one, and it cannot wait for an asynchronous
  IPC round trip.
- **Six keys from the Angular renderer** are read once, migrated into the main process, and then
  **removed** — each only after the main process has acknowledged the write, and never for a key
  that failed to parse. They are a one-way migration, not storage: after the first launch on this
  renderer, none of them is left.

## AWS profiles

For Aurora DSQL connections, Joinery reads the **names** of the profiles in `~/.aws/config` and
`~/.aws/credentials` to populate a picker. It does not read or store the credentials themselves —
resolving those is the AWS connector's job.

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                                                    | Source                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets go to the OS credential store via `keytar`, as one JSON vault entry read once                    | `packages/main/src/services/keychain/credential-store.ts:1-4, 12-14, 23-64`                                                                         |
| The keychain service name is the app id `ca.adam11.joinery`                                              | `packages/main/src/services/keychain/credential-store.ts:12`, `packages/shared/src/constants/index.ts:5`                                            |
| The folder is `Joinery`, from `productName` in the manifest beside each Electron entry point             | `package.json:3`, `packages/main/package.json:3`, `packages/main/src/services/config/user-data-dir.ts:23`                                           |
| The lowercase folder is migrated once, and is a no-op where the two names are one directory              | `packages/main/src/services/config/user-data-dir.ts:63-90`, `packages/main/src/index.ts:32-53`                                                      |
| Persistence happens in the main process, through `electron-store`                                        | `packages/main/src/services/config/app-state.ts:6, 38-44`, `packages/main/src/ipc/settings.ipc.ts:1-4`                                              |
| `app-state.json`, and what `AppState` holds                                                              | `packages/main/src/services/config/app-state.ts:38-43`, `packages/shared/src/types/app-state.types.ts:19-49`                                        |
| `connections.json` holds profiles without passwords                                                      | `packages/main/src/services/config/connection-profiles.ts:3, 26-32, 138-148`                                                                        |
| `query-history.json`                                                                                     | `packages/main/src/services/config/query-history.ts:32-38`                                                                                          |
| `window-state.json`                                                                                      | `packages/main/src/window.ts:36-56`                                                                                                                 |
| Snapshots live in `query-results-data/` as an index plus one file each                                   | `packages/main/src/services/config/snapshot-file-store.ts:1-18, 43`, `query-results-store.ts:82`                                                    |
| The single-blob format is migrated and emptied on first launch                                           | `packages/main/src/services/config/query-results-store.ts:67-93`                                                                                    |
| Snapshot limits: 50 per tab, 50,000 rows, 500 MB                                                         | `packages/main/src/services/config/query-results-store.ts:39-46, 147-151, 185-190`                                                                  |
| Retention: at most daily, 30 days, pinned skipped                                                        | `packages/main/src/services/config/query-results-store.ts:461-491`                                                                                  |
| The five-per-tab floor is honoured on the daily pass too, counted per tab over pinned and unpinned alike | `packages/main/src/services/config/query-results-store.ts:48-75` (`floorProtectedIds`), `:339-349` (applied in the `olderThan` branch)              |
| Chat conversations are one JSON file each under `chat-history/`                                          | `packages/main/src/services/ai/chat-service.ts:87, 102, 123`                                                                                        |
| Passwords, SSH secrets and AI keys are separate entries inside the vault                                 | `packages/main/src/services/config/connection-profiles.ts:138-148`, `services/ai/ai-service.ts:136-138`, `services/ssh/ssh-tunnel-manager.ts:88-97` |
| The Entra ID token cache is persisted to the same store                                                  | `packages/main/src/services/azure/entra-auth.ts:12-13, 57`                                                                                          |
| Deleting a profile deletes its password and SSH credentials                                              | `packages/main/src/services/config/connection-profiles.ts:191-193`                                                                                  |
| Only two renderer modules may touch `localStorage`, enforced by a source-reading test                    | `packages/renderer/src/persistence/no-local-storage-writes.spec.ts:1-30`                                                                            |
| The theme mirror key, and why a synchronous source is needed before mount                                | `packages/renderer/src/persistence/theme-mirror.ts:44, 64`, `no-local-storage-writes.spec.ts:12-16`                                                 |
| Six legacy keys are migrated then removed, only after main acknowledges the write                        | `packages/renderer/src/persistence/legacy-local-storage.ts:2, 225-228`, `no-local-storage-writes.spec.ts:17-24`                                     |
| AWS profile names only are read from `~/.aws/config` and `~/.aws/credentials`                            | `packages/main/src/services/config/aws-profiles.ts:1-12`                                                                                            |

</details>
