# What ships inside app.asar

The measurement behind J-90, and how to reproduce it. One page; `scripts/release/asar-inventory.ts`
is the implementation and `electron-builder.yml`'s `files` list is the thing it measures.

## Reproducing it

```bash
pnpm run build && node scripts/package.js --mac dir:arm64   # ~90s, no DMG
pnpm run inventory:asar                                     # the table
pnpm run inventory:asar -- --json                           # the same numbers, machine-readable
pnpm run verify:package                                     # module probes + the never-ship guard
pnpm run smoke:package                                      # launch the bundle, wait for the shell, quit
```

`inventory:asar` reads the asar **header** — every file's path and size, no extraction — so it runs
in well under a second on a 200 MB archive. Sizes are uncompressed content bytes; the archive file
is a few hundred KB larger than their sum (its own header).

## The measurement, 0.5.0 / darwin-arm64 / electron-builder 26.15.3

|                      | before                   | after                  | delta                       |
| -------------------- | ------------------------ | ---------------------- | --------------------------- |
| `app.asar` on disk   | 201,274,245 B (201.3 MB) | 79,376,875 B (79.4 MB) | **−121,897,370 B (−60.6%)** |
| content bytes        | 199,150,045              | 77,822,923             | −121,327,122                |
| files                | 11,118                   | 9,032                  | −2,086                      |
| dependencies         | 209                      | 206                    | −3                          |
| Joinery's own output | 23,727,848 B             | 23,727,848 B           | 0                           |

The packaged `Joinery.app` is 340.7 MB after the change; the Electron runtime, not the asar, is now
the bulk of it.

Those two columns are the same tree with one line of `files` different, measured at `58b204b`. The
**dependency** half of the archive is what this page is about and is stable; the _app-code_ half
moves with every renderer commit, so the absolute totals drift. Re-measured after rebasing onto
`577d8f2` (which brought in J-72's renderer fix): 79,378,286 B, still 9,032 files and 206
dependencies, with the whole 1,411-byte difference in Joinery's own output and **not one dependency
added, removed, or changed in size**. `pnpm run inventory:asar` re-derives the current numbers in
under a second, which is why they are not pinned in a test.

**Exactly three packages left, and nothing else moved.** Diffing the two `--json` runs
package-by-package: 3 removed, 0 added, and **0 packages whose byte count or file count changed**.
That is the property that made this safe to ship — it is not "the archive got smaller", it is "the
archive lost these three things and is otherwise identical".

| package                  | bytes       | files | why it was in there                                                      |
| ------------------------ | ----------- | ----- | ------------------------------------------------------------------------ |
| `devicon`                | 121,323,509 | 2,082 | root `dependencies` entry left by the Angular renderer                   |
| `@types/node`            | 1,832       | 2     | declared as a runtime `dependencies` entry by `tedious` and `protobufjs` |
| `@types/readable-stream` | 1,781       | 2     | declared as a runtime `dependencies` entry by `bl`                       |

electron-builder already strips `.d.ts` from collected modules
(`excludedExts` in `fileMatcher.js`), so what those two actually contributed was a `LICENSE` and a
`package.json` each — 4 files, 3.6 KB. Excluded because nothing loads them, not because of the size.

### The 15 largest dependencies after the change

| MB   | files | package                     |
| ---- | ----- | --------------------------- |
| 11.6 | 889   | `@azure/msal-browser`       |
| 7.6  | 84    | `@js-joda/core`             |
| 2.9  | 74    | `protobufjs`                |
| 2.9  | 943   | `@azure/identity`           |
| 2.7  | 226   | `tedious`                   |
| 2.6  | 539   | `@azure/msal-common`        |
| 2.2  | 262   | `@azure/msal-node`          |
| 2.1  | 512   | `@grpc/grpc-js`             |
| 2.0  | 258   | `@azure/keyvault-keys`      |
| 2.0  | 637   | `@typespec/ts-http-runtime` |
| 1.2  | 147   | `@azure/core-client`        |
| 1.2  | 384   | `@smithy/core`              |
| 1.1  | 36    | `js-md4`                    |
| 0.9  | 359   | `ajv`                       |
| 0.8  | 300   | `@azure/core-rest-pipeline` |

Everything on that list is reached from `mssql`, `pg`, `mysql2`, `@aws-sdk/*` or `@azure/*` — real
runtime weight, and none of it a candidate for exclusion. 23.7 MB is Joinery's own compiled output,
of which 21.4 MB is the renderer bundle.

## What J-90 assumed, and what was actually true

The ticket was filed on this reading: `nodeLinker: hoisted` puts every devDependency in the root
`node_modules`, `electron-builder.yml`'s `files` list included `node_modules/**/*`, so Playwright,
Vitest, esbuild, eslint, rollup and `@types/*` were all shipping. Six exclusion lines in the config
named `typescript`, `vite`, `rolldown`, `@vitejs`, `tailwindcss` and `@tailwindcss` on that basis.

Measured, both halves of that are wrong, and the second one is the interesting half.

### 1. electron-builder never collected a devDependency in the first place

All 209 packages in the "before" archive are production-tree packages. Playwright, Vitest, esbuild,
eslint and rollup were **absent without ever being named** — they are in the root `node_modules` on
disk, and they were never in the archive.

`app-builder-lib` collects node_modules from the _production dependency tree_
(`computeNodeModuleFileSets`, `appFileCopier.js`), separately from the walk over the application's
own files — `getMainFileMatchers` splices `!**/node_modules/**` into that walk precisely so the two
cannot overlap. So an exclusion naming a devDependency filtered a file set it was never in.

### 2. While `node_modules/**/*` was in `files`, no exclusion worked at all

This is what the ticket's "measured, not blind" instruction earned. Adding
`!**/node_modules/devicon/**` to `files` produced an `app.asar` **byte-identical** to the one
without it — 201,274,245 bytes both times. Deleting `node_modules/**/*` from `files`, with the same
exclusion in place, produced the 79,376,875-byte archive above.

Why, in app-builder-lib 26.15.3's own terms:

- `getNodeModuleFileMatcher` (`fileMatcher.js`) builds the pattern list that filters the collected
  dependency tree. `release/builder-debug.yml` prints it as `<arch>.nodeModuleFilePatterns`, and
  `node_modules/**/*` sat **last** in it.
- `createFilter`'s `minimatchAll` (`util/filter.js`) walks that list last-match-wins, consulting a
  negation only while the file is currently included and an inclusion only while it is currently
  excluded. A trailing `node_modules/**/*` therefore re-included every file the negations above it
  had just dropped.

`node_modules/**/*` was redundant from the day it was written — the dependency tree is collected
whether or not `files` mentions it. Its only effect was to disable every exclusion in the file.

That is also why a blind sweep would have looked like it worked: the six devDependency exclusions
could never have shipped a broken app, because they could never have done anything.

## The guard

Two of them, each matching the mechanism it protects.

1. **`node scripts/release/asar-inventory.ts --check`**, chained into `pnpm run verify:package` and
   so run by the release workflow's macOS build job. It reads the archive that was actually built
   and fails on any package matching `NEVER_SHIP` in `scripts/release/asar-inventory.ts` — the
   build-time toolchain J-90 named, the six formerly-excluded packages, and `devicon`. A build-time
   package arriving is only visible in the artifact, so this is the only place it can be caught.

   Proven non-vacuous: run against the pre-change archive it reports 3 failures (`devicon`,
   `@types/node`, `@types/readable-stream`) and exits 1.

2. **`scripts/release/asar-inventory.spec.ts`** (unit tier, every PR). Asserts that every
   `excluded-by-config` rule still has its exclusion line in `electron-builder.yml`, and that no
   rule in the other group has one — so a dead exclusion cannot creep back in looking like it is
   what keeps a package out.

`pnpm run smoke:package` is the third leg and is deliberately not a gate: it needs a real macOS app
bundle and a window server, which `verify:package` does not. It launches the packaged bundle into a
throwaway user-data directory, waits for the renderer to load over `file://` and the shell to mount,
and quits. Run against the trimmed archive: window created, renderer loaded from inside the asar,
shell mounted, clean quit. Also proven non-vacuous — against a bundle whose `app.asar` was replaced
with a stub archive it exits 1.

> **While `JOINERY_KEYCHAIN_SERVICE` is honoured — i.e. before PR #113 (J-161) lands — this smoke
> run uses the hermetic test namespace and is safe. Once a packaged app ignores the override, this
> script must NOT be run against a packaged build until a build-time test-capability flag exists
> (ticket to be filed; relates J-88), because the boot path can MIGRATE — write and delete —
> production Keychain entries.**
>
> That corrects a weaker earlier claim on this page, that the run was read-only as long as nobody
> saved a profile or ran a query. Those are operator actions and the script performs none of them,
> but the boot does its own writing before any assertion runs: `packages/main/src/index.ts:137-139`
> fires `CredentialStore.getInstance().loadAllIntoCache()` on every `whenReady`, unconditionally and
> un-awaited, and `credential-store.ts:73-88` takes a legacy-migration branch when the vault key is
> absent but other accounts exist under the same service — `saveVault()` writes a vault entry, then
> `keytar.deletePassword` removes every legacy item it found. On a machine whose production vault is
> still in that pre-migration shape, one run against a packaged build that ignored the override would
> rewrite and then destroy those items with nobody touching the UI. The bundle is also unsigned
> (`mac.identity: null`), so it is a different Keychain client than the installed app: reading a
> production item raises macOS's "allow access?" prompt, and answering _Always Allow_ grants a
> throwaway binary standing access.
>
> `PACKAGED_APP_HONOURS_KEYCHAIN_OVERRIDE` in the script is the gate. It is `true` today because
> `service-name.ts` reads the override with no reference to `app.isPackaged`; when #113 flips that,
> the constant must be set to `false` in the same change and the script then refuses to launch. That
> is not left to memory — `smoke-packaged-app.spec.ts` asserts the resolver does not consult
> `isPackaged`, so the unit tier goes red on the merged tree until the constant is flipped.
>
> The env pin stays in the script regardless — it is what protects the run today and what J-96's
> structural guard checks for. J-161 refuses it only in a packaged app, on purpose. J-161 also adds
> a rule that a registered launch site must not name a packaged-bundle path, which this launcher
> does by necessity, so the two changes have to be sequenced together. The reviewer recommends
> landing the capability flag first rather than exempting this launcher from that rule; the decision
> is the coordinator's and is not pre-empted here.

## Still on the table

- **Delete `devicon` from root `dependencies`.** The exclusion keeps 121 MB out of the download;
  the dependency is still installed, still in the lockfile and still 121 MB in every developer's and
  CI runner's `node_modules`. Removing it is the real fix and belongs in its own change with its own
  lockfile diff.
- **Test doubles and source maps are still in the archive.** `packages/main/dist/__mocks__/keytar.js`
  and `.../ssh2.js` — the vitest doubles for the Keychain and SSH modules — plus `.js.map` and
  `.d.ts.map` across every package's `dist`. Small in bytes, wrong in principle, and a shipped file
  named `__mocks__/keytar.js` invites the wrong question in a security review. The fix is a
  `tsconfig` `exclude` for `__mocks__` or an `electron-builder.yml` exclusion, plus no source maps
  in the packaged build. Raised in the J-90 review (finding 7) and left for its own change because
  it touches what the TypeScript build emits, not what the packager collects.
- **Only the arm64 archive is ever checked.** `scripts/verify-package.js` and this script both
  default to `release/mac-arm64/…`, while `mac.target` builds x64 as well. Pre-existing; the new
  check inherits it rather than making it worse.
- **`@azure/msal-browser` at 11.6 MB** is a browser-targeted bundle reached from `@azure/identity`
  through `mssql`'s Entra ID support, in a Node main process that never runs it. Unpicking that
  means changing which `@azure` entry points the SQL Server driver pulls, which is a behaviour
  change and needs its own verification.
- **`@js-joda/core` at 7.6 MB** is reached from `tedious`. Same shape of question.
