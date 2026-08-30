/**
 * One-shot user-data case guard (J-117).
 *
 * Electron names the per-user data directory after `productName ?? name` in the app's package.json.
 * Before J-117 that was `joinery`; it is now `Joinery`. On the default macOS and Windows volumes,
 * which are case-INSENSITIVE, those two names are the same directory — the rename is cosmetic and
 * nothing moves. On an opt-in case-SENSITIVE APFS volume (or on Linux) they are two directories,
 * and the app would otherwise launch with empty state beside the user's untouched `joinery`.
 *
 * This module closes that gap once: on startup, before anything opens a file under userData, move
 * the legacy directory's contents into the one Electron now resolves. It is one-shot by
 * construction — after a successful move the target holds app state, which is the condition that
 * makes the next run a no-op.
 *
 * Pure `node:fs`: no electron import, so the call site owns the `app.getPath('userData')` lookup and
 * the side effect is visible there.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The directory name Electron resolves today, from `productName` in the app's package.json. */
export const USER_DATA_DIR_NAME = 'Joinery';

/** The directory name every build before J-117 wrote to. */
export const LEGACY_USER_DATA_DIR_NAME = 'joinery';

/**
 * The name Electron will use for `app.name`, given the package.json beside the entry point.
 * `null` means Electron would leave the app unnamed.
 *
 * Transcribed from the Electron 41 source, not from the documentation, and not from memory — two
 * different code paths pick this name and they do not agree:
 *
 * - `electron <dir>`, which is what `pnpm run dev` runs, goes through `default_app.asar`'s
 *   `main.js` (`loadApplicationPackage`):
 *   `if (packageJson.productName) app.name = packageJson.productName; else if (packageJson.name) …`
 *   — a plain truthiness chain, with no trimming.
 * - A packaged app goes through the browser init bundled in the framework binary, which branches on
 *   `!= null` and assigns `` `${value}`.trim() ``.
 *
 * This models the first, because it is the path that produced the orphaned `@joinery/main`
 * directory. `isUsableAsUserDataDirName` below then rejects the inputs the two paths disagree on,
 * so nothing in this repo can depend on which one ran. Both readings were checked against a real
 * Electron launch: a `productName` of `"   Joinery (dev)   "` yields `app.name` with its spaces
 * intact in development.
 */
export function electronAppNameFrom(manifest: {
  readonly name?: unknown;
  readonly productName?: unknown;
}): string | null {
  const { productName, name } = manifest;
  if (productName) return String(productName);
  if (name) return String(name);
  return null;
}

/**
 * Whether `app.name` would give Joinery a user-data directory of its own (J-142).
 *
 * Electron joins `app.name` onto the platform's application-data directory. It does not validate
 * it, so a scoped npm name does not fail — the separator in `@joinery/main` just nests the
 * directory a level deeper, which is how 46 MB of development state ended up in
 * `~/Library/Application Support/@joinery/main` before `productName` was set. A bare scope is
 * rejected too: it is the leftover shape of that same mistake, never a product name.
 */
export function isUsableAsUserDataDirName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.startsWith('@')) return false;
  // Development keeps surrounding whitespace and the packaged app trims it away, so a name with
  // any would put the two builds in two different directories for no visible reason.
  if (name.trim() !== name) return false;
  return path.posix.basename(name) === name && path.win32.basename(name) === name;
}

/**
 * Files whose presence means "a real Joinery installation wrote here". Chromium's own artifacts
 * (`Local State`, `Cache/`, …) deliberately do not count: Electron creates those before the main
 * script runs, so treating them as state would make the guard a permanent no-op.
 */
const APP_STATE_FILES = ['app-state.json', 'connections.json', 'query-history.json'] as const;

/** Refuses to walk a directory larger than this. A userData directory holds tens of entries. */
const MAX_ENTRIES_TO_MOVE = 512;

export type UserDataCaseMigrationOutcome =
  /** `userDataPath` is not the directory this guard knows about (an e2e `--user-data-dir`, say). */
  | 'skipped-unexpected-path'
  /** No legacy directory, or one with nothing worth keeping in it. */
  | 'noop-no-legacy-state'
  /** Case-insensitive volume: the two names are one inode. Nothing to do, ever. */
  | 'noop-same-directory'
  /** The target already holds app state — this guard has run, or the user started fresh here. */
  | 'noop-target-has-state'
  /** Entries were moved out of the legacy directory into the target. */
  | 'migrated';

export interface UserDataCaseMigrationOptions {
  /** Absolute path Electron resolved for `userData`. */
  readonly userDataPath: string;
  /** Directory name the guard expects at the end of `userDataPath`. */
  readonly expectedDirName: string;
  /** Directory name older builds used, as a sibling of `userDataPath`. */
  readonly legacyDirName: string;
}

/**
 * Move a pre-rename user-data directory into the post-rename one, once. Throws on an unusable
 * argument or a filesystem error — the caller decides whether that is fatal.
 */
export function migrateLegacyUserDataDir(
  options: UserDataCaseMigrationOptions
): UserDataCaseMigrationOutcome {
  const { userDataPath, expectedDirName, legacyDirName } = options;

  if (!path.isAbsolute(userDataPath)) {
    throw new Error(`user-data case guard needs an absolute path, got "${userDataPath}"`);
  }
  if (expectedDirName === '' || legacyDirName === '' || expectedDirName === legacyDirName) {
    throw new Error(
      `user-data case guard needs two distinct non-empty names, got "${expectedDirName}" and "${legacyDirName}"`
    );
  }

  if (path.basename(userDataPath) !== expectedDirName) return 'skipped-unexpected-path';

  const legacyPath = path.join(path.dirname(userDataPath), legacyDirName);
  const legacyStat = statDirectory(legacyPath);
  if (!legacyStat || !holdsAppState(legacyPath)) return 'noop-no-legacy-state';

  const targetStat = statDirectory(userDataPath);
  if (targetStat && isSameDirectory(targetStat, legacyStat)) return 'noop-same-directory';
  if (targetStat && holdsAppState(userDataPath)) return 'noop-target-has-state';

  fs.mkdirSync(userDataPath, { recursive: true });
  moveEntriesThatAreMissing(legacyPath, userDataPath);
  removeIfEmpty(legacyPath);
  return 'migrated';
}

function statDirectory(dir: string): fs.Stats | null {
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  return stat?.isDirectory() ? stat : null;
}

function isSameDirectory(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Deliberately not `fs.existsSync`, which answers `false` for a permission error exactly as it does
 * for a missing file — that would turn an unreadable legacy directory into a silent "nothing to
 * migrate" and hand the user an empty profile with no trace of why. `statSync` with
 * `throwIfNoEntry: false` tells the two apart: `undefined` for ENOENT, a throw for EACCES, which
 * the entry point logs. Verified against real `node:fs`, not assumed (see the spec).
 */
function entryExists(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false }) !== undefined;
}

function holdsAppState(dir: string): boolean {
  return APP_STATE_FILES.some(file => entryExists(path.join(dir, file)));
}

/**
 * Move every entry of `from` that `to` does not already have. Same-volume `rename` moves a whole
 * subtree (`chat-history/`, `query-results-data/`) in one call, so this stays one level deep.
 * Collisions are left in `from` rather than overwritten — the target's copy is the newer one.
 */
function moveEntriesThatAreMissing(from: string, to: string): void {
  const entries = fs.readdirSync(from);
  if (entries.length > MAX_ENTRIES_TO_MOVE) {
    throw new Error(
      `user-data case guard refused to migrate ${entries.length} entries from "${from}" (limit ${MAX_ENTRIES_TO_MOVE})`
    );
  }

  for (const entry of entries) {
    const destination = path.join(to, entry);
    if (entryExists(destination)) continue;
    fs.renameSync(path.join(from, entry), destination);
  }
}

/** Drop the legacy directory once it has nothing left. A leftover collision keeps it around. */
function removeIfEmpty(dir: string): void {
  if (fs.readdirSync(dir).length > 0) return;
  fs.rmdirSync(dir);
}
