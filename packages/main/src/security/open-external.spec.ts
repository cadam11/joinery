/**
 * The single enforcement point for handing a URL to the OS browser, and the structural guard that
 * keeps it single.
 *
 * Before J-129 the app had two enforcement points: `assertOpenableExternalUrl`, used by the
 * `app:open-external` IPC channel and the navigation guards, and "trust the caller" at five other
 * `shell.openExternal` sites — four hard-coded Help-menu literals and the MSAL-generated Entra
 * sign-in URL. None reached a renderer-controlled string, so this closes an architectural gap
 * rather than a live hole: one place decides, and a new call site cannot quietly opt out.
 *
 * The second describe block is the part that keeps that true tomorrow. A behaviour test can only
 * cover the call sites someone remembered; the source scan covers the ones they did not.
 */

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { UnsafeExternalUrlError } from './external-url';
import { openExternalSafely } from './open-external';

describe('openExternalSafely', () => {
  it.each(['https://usejoinery.com/', 'http://example.com/', 'mailto:hi@example.com'])(
    'hands %s to the opener',
    async url => {
      const open = vi.fn(async () => undefined);
      await openExternalSafely(url, open);
      expect(open).toHaveBeenCalledExactlyOnceWith(url);
    }
  );

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'vscode://an-editor/open',
    'ms-msdt:/id',
    'not a url at all',
  ])('refuses %s without reaching the opener', async url => {
    const open = vi.fn(async () => undefined);
    await expect(openExternalSafely(url, open)).rejects.toBeInstanceOf(UnsafeExternalUrlError);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a non-string, which is what a bad caller actually looks like', async () => {
    const open = vi.fn(async () => undefined);
    await expect(openExternalSafely(undefined as unknown as string, open)).rejects.toBeInstanceOf(
      UnsafeExternalUrlError
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('propagates an opener failure rather than swallowing it', async () => {
    const open = vi.fn(async () => {
      throw new Error('no handler for https:');
    });
    await expect(openExternalSafely('https://usejoinery.com/', open)).rejects.toThrow(
      'no handler for https:'
    );
  });
});

// ── The structural half ──────────────────────────────────────────────────────────────────

const MAIN_SRC = join(__dirname, '..');

/** Calling it directly is the bypass; passing the reference to `openExternalSafely` is the API. */
const DIRECT_CALL = /shell\s*\.\s*openExternal\s*\(/;

/**
 * Code only — prose that *names* the forbidden call (this file's own header, for one) is not a
 * bypass, and a guard that cannot be described in a comment is a guard nobody documents.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function readEntries(dir: string): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every production source file under `packages/main/src`, as `[relativePath, text]`. */
function collectMainSources(dir = MAIN_SRC, prefix = '', depth = 0): Array<[string, string]> {
  if (depth > 12) throw new Error(`open-external scan exceeded depth 12 at ${dir}`);

  const collected: Array<[string, string]> = [];
  for (const entry of readEntries(dir)) {
    const full = join(dir, entry.name);
    const label = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collected.push(...collectMainSources(full, label, depth + 1));
      continue;
    }
    if (!/\.ts$/.test(entry.name) || entry.name.includes('.spec.')) continue;
    collected.push([label, readFileSync(full, 'utf8')]);
  }
  return collected;
}

describe('the main process has one way to open an external URL', () => {
  it('never calls shell.openExternal directly', () => {
    const offenders = collectMainSources()
      .filter(([, text]) => DIRECT_CALL.test(withoutComments(text)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('scanned a plausible number of files, so an empty pass cannot be vacuous', () => {
    expect(collectMainSources().length).toBeGreaterThan(50);
  });
});
