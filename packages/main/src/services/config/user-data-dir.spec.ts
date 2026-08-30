/**
 * The one-shot user-data case guard (J-117).
 *
 * These specs run against the REAL filesystem — no `node:fs` double — because the behaviour under
 * test *is* filesystem behaviour, and a hand-rolled fs double would be free to encode whichever
 * answer makes the guard look right.
 *
 * The trick that makes that possible: case sensitivity is simulated by the *names*, not by a fake.
 * Two directory names that differ only in case are one directory on a case-INSENSITIVE volume and
 * two directories on a case-SENSITIVE one — so passing two genuinely different names ("legacy" and
 * "Current") reproduces the case-sensitive volume exactly, on any host. The one spec that needs a
 * real case-insensitive volume detects it and skips elsewhere.
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LEGACY_USER_DATA_DIR_NAME,
  USER_DATA_DIR_NAME,
  migrateLegacyUserDataDir,
} from './user-data-dir';

let sandbox = '';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'joinery-userdata-case-'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** True when `sandbox` lives on a volume that treats `x` and `X` as one name. */
function sandboxIsCaseInsensitive(): boolean {
  const probe = path.join(sandbox, 'CaseProbe');
  fs.mkdirSync(probe);
  const insensitive = fs.existsSync(path.join(sandbox, 'caseprobe'));
  fs.rmSync(probe, { recursive: true, force: true });
  return insensitive;
}

function writeDir(name: string, files: Record<string, string>): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), contents);
  }
  return dir;
}

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

describe('migrateLegacyUserDataDir', () => {
  test('moves the legacy directory into place when the two names are distinct directories', () => {
    writeDir('legacy', {
      'app-state.json': '{"appState":{"kept":true}}',
      'connections.json': '{"profiles":[]}',
    });
    const target = path.join(sandbox, 'Current');

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('migrated');
    expect(read(target, 'app-state.json')).toBe('{"appState":{"kept":true}}');
    expect(read(target, 'connections.json')).toBe('{"profiles":[]}');
    expect(fs.existsSync(path.join(sandbox, 'legacy'))).toBe(false);
  });

  test('merges into a target Electron already created, without overwriting what is there', () => {
    // Electron creates userData, and writes `Local State` into it, before the main script runs — so
    // the target is rarely empty by the time the guard gets to look at it, and "empty" is the wrong
    // condition to gate on.
    writeDir('legacy', {
      'app-state.json': '{"appState":{"kept":true}}',
      'window-state.json': '{"windowState":{"width":800}}',
    });
    const target = writeDir('Current', {
      'Local State': '{}',
      'window-state.json': '{"windowState":{"width":1400}}',
    });

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('migrated');
    expect(read(target, 'app-state.json')).toBe('{"appState":{"kept":true}}');
    expect(read(target, 'window-state.json')).toBe('{"windowState":{"width":1400}}');
    // The collision stayed behind rather than being silently dropped.
    expect(read(path.join(sandbox, 'legacy'), 'window-state.json')).toBe(
      '{"windowState":{"width":800}}'
    );
  });

  test('moves nested state directories, not just top-level files', () => {
    const legacy = writeDir('legacy', { 'app-state.json': '{}' });
    fs.mkdirSync(path.join(legacy, 'chat-history'));
    fs.writeFileSync(path.join(legacy, 'chat-history', 'c1.json'), '{"id":"c1"}');
    const target = path.join(sandbox, 'Current');

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('migrated');
    expect(fs.readFileSync(path.join(target, 'chat-history', 'c1.json'), 'utf8')).toBe(
      '{"id":"c1"}'
    );
  });

  test('does nothing when the expected directory already holds app state', () => {
    writeDir('legacy', { 'app-state.json': '{"appState":{"stale":true}}' });
    const target = writeDir('Current', { 'app-state.json': '{"appState":{"current":true}}' });

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('noop-target-has-state');
    expect(read(target, 'app-state.json')).toBe('{"appState":{"current":true}}');
  });

  test('does nothing when there is no legacy directory', () => {
    const target = writeDir('Current', { 'Local State': '{}' });

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('noop-no-legacy-state');
  });

  test('does nothing when a legacy directory exists but holds no app state', () => {
    writeDir('legacy', { 'Local State': '{}' });
    const target = path.join(sandbox, 'Current');

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('noop-no-legacy-state');
    expect(fs.existsSync(target)).toBe(false);
  });

  test('does nothing when userData was overridden to an unrelated path', () => {
    // `--user-data-dir=<tmp>/joinery-test-userdata-xxxx`, as every e2e launch does.
    const target = writeDir('joinery-test-userdata-abc', { 'app-state.json': '{}' });
    writeDir('legacy', { 'app-state.json': '{"appState":{"stale":true}}' });

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: 'Current',
      legacyDirName: 'legacy',
    });

    expect(outcome).toBe('skipped-unexpected-path');
    expect(read(target, 'app-state.json')).toBe('{}');
  });

  test('rejects a relative userData path rather than guessing a parent', () => {
    expect(() =>
      migrateLegacyUserDataDir({
        userDataPath: 'Current',
        expectedDirName: 'Current',
        legacyDirName: 'legacy',
      })
    ).toThrow(/absolute/i);
  });
});

describe('migrateLegacyUserDataDir on a case-insensitive volume', () => {
  test('recognises that the two names are one directory and leaves it untouched', ctx => {
    if (!sandboxIsCaseInsensitive()) {
      ctx.skip('needs a case-insensitive volume; this host is case-sensitive');
      return;
    }

    // The real-world default on macOS and Windows: `joinery` and `Joinery` are the same inode, so
    // the rename this ticket makes is a display change and nothing has to move.
    const legacy = writeDir(LEGACY_USER_DATA_DIR_NAME, {
      'app-state.json': '{"appState":{"kept":true}}',
    });
    const target = path.join(sandbox, USER_DATA_DIR_NAME);
    expect(fs.statSync(target).ino).toBe(fs.statSync(legacy).ino);

    const outcome = migrateLegacyUserDataDir({
      userDataPath: target,
      expectedDirName: USER_DATA_DIR_NAME,
      legacyDirName: LEGACY_USER_DATA_DIR_NAME,
    });

    expect(outcome).toBe('noop-same-directory');
    expect(read(target, 'app-state.json')).toBe('{"appState":{"kept":true}}');
  });
});

describe('the shipped directory names', () => {
  test('differ only in the case of the first letter', () => {
    expect(USER_DATA_DIR_NAME).toBe('Joinery');
    expect(LEGACY_USER_DATA_DIR_NAME).toBe('joinery');
    expect(LEGACY_USER_DATA_DIR_NAME.toLowerCase()).toBe(USER_DATA_DIR_NAME.toLowerCase());
  });
});

/**
 * Electron derives `app.name` — and from it `userData`, `logs` and the macOS application menu's
 * first item — from `productName ?? name` in the package.json beside the entry point. Two entry
 * points exist: the repo root's for the packaged app, and `packages/main`'s for `electron .` in
 * development. Both have to say `Joinery`, or `USER_DATA_DIR_NAME` above is a lie.
 */
describe('the package.json Electron reads app.name from', () => {
  /**
   * Resolved from the vitest root (the repo root) rather than from this file, because
   * `packages/main` compiles as CommonJS and `import.meta` is a build error there. The `name`
   * assertion is what makes that safe: a wrong root fails loudly instead of reading some other
   * manifest and passing.
   */
  function readManifest(repoRelativePath: string, expectedName: string): Record<string, unknown> {
    const file = path.resolve(process.cwd(), repoRelativePath);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(manifest.name, `${file} is not the manifest this test means to read`).toBe(expectedName);
    return manifest;
  }

  test('names the packaged app Joinery', () => {
    expect(readManifest('package.json', 'joinery').productName).toBe(USER_DATA_DIR_NAME);
  });

  test('names the development app Joinery too', () => {
    expect(readManifest('packages/main/package.json', '@joinery/main').productName).toBe(
      USER_DATA_DIR_NAME
    );
  });
});
