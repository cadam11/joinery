/**
 * The `app:open-external` channel (J-22).
 *
 * This channel is reachable from any script running in the renderer — including a link in
 * model-authored markdown — and before J-22 it handed its argument straight to
 * `shell.openExternal`, i.e. to the OS URL handler. This spec pins the allowlist at the channel
 * boundary rather than only in the pure validator, because the validator existing is not the
 * same thing as the handler calling it.
 *
 * Harness: electron is replaced with the members this file touches, following
 * `credentials.ipc.spec.ts`. `electron-store` (via `AppStateStore`) reaches `app.getPath`, so
 * that is pointed at a temp directory created below and removed in `afterAll`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@joinery/shared';

import { registerAppHandlers } from './app.ipc';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  opened: [] as string[],
  /** Filled in below, before anything reads it. `vi.hoisted` runs above the imports. */
  userDataDir: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    },
  },
  app: {
    getVersion: () => '0.5.0',
    getName: () => 'joinery-app-ipc-spec',
    getPath: () => electron.userDataDir,
  },
  shell: {
    openExternal: async (url: string) => {
      electron.opened.push(url);
    },
    showItemInFolder: () => undefined,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
}));

electron.userDataDir = mkdtempSync(join(tmpdir(), 'joinery-app-ipc-'));

afterAll(() => {
  rmSync(electron.userDataDir, { recursive: true, force: true });
});

/** Invoke `app:open-external` the way `ipcRenderer.invoke` would. */
async function openExternal(url: unknown): Promise<void> {
  const handler = electron.handlers.get(IPC_CHANNELS.APP.OPEN_EXTERNAL);
  expect(handler, 'app:open-external was never registered').toBeDefined();
  await handler?.({}, url);
}

beforeEach(() => {
  electron.handlers.clear();
  electron.opened.length = 0;
  registerAppHandlers();
});

describe('app:open-external', () => {
  it.each(['https://usejoinery.com/docs', 'http://localhost:4200/', 'mailto:hi@example.com'])(
    'opens %s in the OS handler',
    async url => {
      await openExternal(url);
      expect(electron.opened).toEqual([url]);
    }
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ms-msdt:/id PCWDiagnostic',
    'smb://attacker.example/share',
    'about:blank',
    'not a url',
    '',
  ])('rejects %j without reaching shell.openExternal', async url => {
    await expect(openExternal(url)).rejects.toThrow();
    expect(electron.opened).toEqual([]);
  });

  it('rejects a non-string argument, which the typed bridge cannot prevent', async () => {
    await expect(openExternal(undefined)).rejects.toThrow();
    await expect(openExternal({ toString: () => 'https://usejoinery.com/' })).rejects.toThrow();
    expect(electron.opened).toEqual([]);
  });

  it('surfaces a rejection the renderer can show, naming the scheme it refused', async () => {
    await expect(openExternal('javascript:alert(1)')).rejects.toThrow(/javascript:/);
  });

  it('does not leak the rejected URL beyond its scheme', async () => {
    // The message reaches the log ring buffer, the Output panel and the renderer's error toast.
    let message = '';
    try {
      await openExternal('ftp://user:hunter2@internal.example/dump.sql?token=abc123');
      expect.unreachable('expected a rejection');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ftp:');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('abc123');
  });
});
