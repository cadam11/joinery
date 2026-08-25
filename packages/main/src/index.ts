/**
 * Joinery - Main Process Entry Point
 */

import { app, shell, BrowserWindow } from 'electron';
import { createMainWindow, installRendererSecurityPolicy, resolveAppEntry } from './window';
import { installNavigationGuardsForEveryWindow } from './security/harden';
import { openExternalSafely } from './security/open-external';
import { createMenu } from './menu';
import { registerAllHandlers } from './ipc';
import { createLogger } from './utils/logger';
import { ConnectionPoolManager } from './services/sql/connection-pool';
import { QueryExecutor } from './services/sql/query-executor';
import { BackupRestoreService } from './services/sql/backup-restore';
import { PgBackupService } from './services/sql/pg-backup';
import { SQLConverterService } from './services/sql/sql-converter';
import { ChatService } from './services/ai/chat-service';
import { AIService } from './services/ai/ai-service';
import { CredentialStore } from './services/keychain/credential-store';
import { SshTunnelManager } from './services/ssh/ssh-tunnel-manager';
import { QueryHistoryStore } from './services/config/query-history';
import { AppStateStore } from './services/config/app-state';
import { QueryResultsStore } from './services/config/query-results-store';
import { cleanupWorkspaceWatchers } from './ipc/workspace.ipc';

const log = createLogger('App');

// Handle creating/removing shortcuts on Windows when installing/uninstalling
// This is only needed for Windows Squirrel installers
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (require('electron-squirrel-startup')) {
    app.quit();
  }
} catch {
  // electron-squirrel-startup not installed, ignore
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      if (windows[0].isMinimized()) {
        windows[0].restore();
      }
      windows[0].focus();
    }
  });

  // App ready
  app.whenReady().then(() => {
    // The CSP is the one thing that must precede the window (J-22): it is applied to response
    // headers, so it has to be on the session before the entry HTML is fetched. Pure string
    // building plus one listener registration — nothing here can block.
    installRendererSecurityPolicy();

    // Navigation guards next, and app-wide rather than per window (J-129). `web-contents-created`
    // fires during `new BrowserWindow`, so registering here — above `createMainWindow()` — covers
    // the main window and every window added later, without a call site having to remember.
    installNavigationGuardsForEveryWindow(app, {
      entry: resolveAppEntry(),
      openExternal: url => openExternalSafely(url, shell.openExternal),
    });

    // Window next: Chromium spins up and loads the renderer in its own
    // processes while the rest of this tick runs. Handler registration
    // happens in the same synchronous tick, so no renderer invoke can
    // arrive before it completes.
    createMainWindow();

    // Register IPC handlers
    registerAllHandlers();

    // Create menu
    createMenu();

    // Warm the credentials vault without gating the window on the keychain
    // (which can stall or prompt). Accessors await the same load internally.
    CredentialStore.getInstance()
      .loadAllIntoCache()
      .catch(err => log.error('Credential vault preload failed:', err));

    // macOS: Re-create window when dock icon is clicked
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  // Quit when all windows are closed (except on macOS)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Cleanup before quit — Electron does NOT await async before-quit handlers,
  // so we prevent the default quit, run cleanup ourselves, then force exit.
  let isQuitting = false;
  app.on('before-quit', event => {
    if (isQuitting) return; // Already running shutdown sequence
    isQuitting = true;
    event.preventDefault(); // Hold quit until cleanup finishes (or times out)

    const shutdownStart = Date.now();
    log.info('Shutdown: starting graceful cleanup...');

    // Force-exit safety net — if cleanup hangs, exit anyway
    const SHUTDOWN_TIMEOUT_MS = 3000;
    const forceExitTimer = setTimeout(() => {
      log.warn(`Shutdown: timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    // --- Synchronous cleanup (timers, watchers, in-flight work) ---
    const poolManager = ConnectionPoolManager.getInstance();
    poolManager.stopCleanupTimer();
    log.info('Shutdown: stopped pool cleanup timer');

    cleanupWorkspaceWatchers();
    log.info('Shutdown: closed workspace file watchers');

    try {
      QueryExecutor.getInstance().cancelAll();
    } catch {
      /* singleton may not exist */
    }
    log.info('Shutdown: cancelled active queries');

    try {
      BackupRestoreService.getInstance().stopAllOperations();
    } catch {
      /* singleton may not exist */
    }
    try {
      PgBackupService.getInstance().stopAllOperations();
    } catch {
      /* singleton may not exist */
    }
    log.info('Shutdown: stopped backup/restore operations');

    try {
      ChatService.getInstance().abortAll();
    } catch {
      /* singleton may not exist */
    }
    try {
      AIService.getInstance().abortAll();
    } catch {
      /* singleton may not exist */
    }
    log.info('Shutdown: aborted active AI streams');

    // Fire-and-forget: this handler is synchronous by design (see above), so the
    // stop cannot be awaited. The client also SIGTERMs the child on process
    // 'exit', so a slow stop here cannot orphan the Python process.
    try {
      SQLConverterService.getInstance()
        .stop()
        .catch(err =>
          log.warn(
            `Shutdown: sqlglot microservice stop failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    } catch {
      /* singleton may not exist */
    }
    log.info('Shutdown: requested sqlglot microservice stop');

    // Flush debounced store writes so nothing persisted-in-memory is lost.
    try {
      QueryHistoryStore.getInstance().flush();
    } catch {
      /* singleton may not exist */
    }
    try {
      AppStateStore.getInstance().flush();
    } catch {
      /* singleton may not exist */
    }
    try {
      // hasInstance guard: constructing the lazy store at quit would run
      // its first-use legacy migration inside the shutdown window.
      if (QueryResultsStore.hasInstance()) {
        QueryResultsStore.getInstance().flush();
      }
    } catch (err) {
      log.warn('Shutdown: snapshot index flush failed:', err);
    }
    log.info('Shutdown: flushed pending store writes');

    // --- Async cleanup (close SQL pools + SSH tunnels) ---
    poolManager
      .closeAll()
      .then(() => log.info(`Shutdown: closed all SQL pools in ${Date.now() - shutdownStart}ms`))
      .then(() => SshTunnelManager.getInstance().closeAll())
      .then(() => log.info('Shutdown: closed all SSH tunnels'))
      .catch(err => log.error('Shutdown: error closing SQL pools/SSH tunnels:', err))
      .finally(() => {
        clearTimeout(forceExitTimer);
        log.info(`Shutdown: complete in ${Date.now() - shutdownStart}ms`);
        app.exit(0);
      });
  });
}

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', reason => {
  log.error('Unhandled rejection:', reason);
});
