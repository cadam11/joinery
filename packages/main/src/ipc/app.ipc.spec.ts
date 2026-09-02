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
import { AppStateStore } from '../services/config/app-state';

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

/**
 * The main-process half of J-74's quit chain, pinned end to end.
 *
 * This is a PREMISE, not a fix: `app:set-state` → `AppStateStore` cache → `flush()` → disk already
 * worked. It is asserted here because `shutdown.ts`'s ordering now depends on it being exactly this
 * shape, and on one property of it in particular — `electron-store` writes SYNCHRONOUSLY (`conf`
 * ends in `fs.writeFileSync`), so `flush()` has nothing to await and the values are on disk by the
 * time it returns. If that ever became asynchronous, `runShutdown` would have to await it and the
 * `exit()` immediately after would start losing writes again. This test is what would fail.
 *
 * The renderer's own half — replying only after its `setState` calls have landed — is asserted in
 * `packages/renderer/src/persistence/flush-on-exit.spec.ts`.
 */
describe('the quit chain: app:set-state, flushed, on disk', () => {
  beforeEach(() => {
    registerAppHandlers();
  });

  it('has the geometry the renderer sent on disk once the store is flushed', async () => {
    const setState = electron.handlers.get(IPC_CHANNELS.APP.SET_STATE);
    expect(setState).toBeDefined();

    // Exactly what `state/workbench.ts`'s flush sends, and what the renderer awaits before it
    // answers main's flush request.
    await setState?.({}, { sidebarWidth: 420, sidebarCollapsed: true });

    // `runShutdown` calls this — after the renderer has answered — and then exits.
    AppStateStore.getInstance().flush();

    // A fresh instance reads from disk, which is what the next launch does.
    AppStateStore.resetInstance();
    const afterRestart = AppStateStore.getInstance().getState();
    expect(afterRestart.sidebarWidth).toBe(420);
    expect(afterRestart.sidebarCollapsed).toBe(true);
  });

  it('would have lost the same geometry without the flush', async () => {
    const setState = electron.handlers.get(IPC_CHANNELS.APP.SET_STATE);
    await setState?.({}, { sidebarWidth: 420 });
    AppStateStore.getInstance().flush();
    await setState?.({}, { sidebarWidth: 315 });

    // No flush this time: `app.exit(0)` here loses the 315 and the next launch reads 420. That is
    // the shape of the whole bug, one layer up from where the renderer's debounce sat.
    AppStateStore.resetInstance();
    expect(AppStateStore.getInstance().getState().sidebarWidth).toBe(420);
  });
});
