/**
 * App IPC Handlers
 */

import * as fs from 'fs/promises';
import { app, shell, dialog } from 'electron';
import { IPC_CHANNELS, type AppState, type TabState, type LayoutConfig } from '@joinery/shared';
import { AppStateStore } from '../services/config/app-state';
import { assertOpenableExternalUrl } from '../security/external-url';
import { safeHandle } from './safe-handle';

export function registerAppHandlers(): void {
  const appState = AppStateStore.getInstance();

  // Get app version
  safeHandle(IPC_CHANNELS.APP.GET_VERSION, async (): Promise<string> => {
    return app.getVersion();
  });

  // Open external URL.
  //
  // `shell.openExternal` hands the string to the OS URL handler, so the scheme is checked first
  // (J-22): `url` is whatever the renderer sent, and a link in model-authored markdown is enough
  // to drive this channel. A refusal throws, which `safeHandle` logs and re-throws so the
  // renderer surfaces it — see `security/external-url.ts`.
  safeHandle(IPC_CHANNELS.APP.OPEN_EXTERNAL, async (_event, url: string): Promise<void> => {
    assertOpenableExternalUrl(url);
    await shell.openExternal(url);
  });

  // Show in folder
  safeHandle(IPC_CHANNELS.APP.SHOW_IN_FOLDER, async (_event, path: string): Promise<void> => {
    shell.showItemInFolder(path);
  });

  // Get app state
  safeHandle(IPC_CHANNELS.APP.GET_STATE, async (): Promise<AppState> => {
    return appState.getState();
  });

  // Set app state
  safeHandle(
    IPC_CHANNELS.APP.SET_STATE,
    async (_event, partial: Partial<AppState>): Promise<void> => {
      appState.setState(partial);
    }
  );

  // Save tabs
  safeHandle(
    IPC_CHANNELS.APP.SAVE_TABS,
    async (_event, tabs: TabState[], activeTabId: string | null): Promise<void> => {
      appState.setOpenTabs(tabs);
      appState.setActiveTabId(activeTabId);
    }
  );

  // Get saved tabs
  safeHandle(
    IPC_CHANNELS.APP.GET_TABS,
    async (): Promise<{ tabs: TabState[]; activeTabId: string | null }> => {
      return {
        tabs: appState.getOpenTabs(),
        activeTabId: appState.getActiveTabId(),
      };
    }
  );

  // Show open dialog
  safeHandle(
    IPC_CHANNELS.APP.SHOW_OPEN_DIALOG,
    async (_event, options: Electron.OpenDialogOptions) => {
      return dialog.showOpenDialog(options);
    }
  );

  // Show save dialog
  safeHandle(
    IPC_CHANNELS.APP.SHOW_SAVE_DIALOG,
    async (_event, options: Electron.SaveDialogOptions) => {
      return dialog.showSaveDialog(options);
    }
  );

  // Atomic save-dialog + file write (renderer sends dialog options + content,
  // main process shows the dialog and writes — renderer never controls the path)
  safeHandle(
    IPC_CHANNELS.APP.SAVE_TO_FILE,
    async (
      _event,
      options: Electron.SaveDialogOptions,
      content: string
    ): Promise<{ canceled: boolean; filePath?: string }> => {
      const result = await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { canceled: false, filePath: result.filePath };
    }
  );

  // Save golden layout config
  safeHandle(
    IPC_CHANNELS.APP.SAVE_LAYOUT,
    async (_event, config: LayoutConfig | undefined): Promise<void> => {
      appState.setGoldenLayoutConfig(config);
    }
  );

  // Get golden layout config
  safeHandle(IPC_CHANNELS.APP.GET_LAYOUT, async (): Promise<LayoutConfig | undefined> => {
    return appState.getGoldenLayoutConfig();
  });
}
