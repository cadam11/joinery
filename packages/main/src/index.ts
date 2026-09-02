/**
 * Joinery - Main Process Entry Point
 */

import { app, ipcMain, shell, BrowserWindow } from 'electron';
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
import { requestRendererFlush } from './services/config/renderer-flush';
import { runShutdown } from './shutdown';
import {
  LEGACY_USER_DATA_DIR_NAME,
  USER_DATA_DIR_NAME,
  isUsableAsUserDataDirName,
  migrateLegacyUserDataDir,
} from './services/config/user-data-dir';

const log = createLogger('App');

/**
 * The invariant the case guard below assumes, stated out loud (J-142). Electron joins `app.name`
 * onto the platform's application-data directory without validating it, so a scoped package name
 * nests instead of failing — that is how 46 MB of development state ended up in
 * `~/Library/Application Support/@joinery/main`. Logged, not thrown: a bad name is a build mistake
 * a developer must see, and refusing to launch over it helps nobody.
 */
if (!isUsableAsUserDataDirName(app.getName())) {
  log.error(
    `app.name is "${app.getName()}", which Electron nests into the user-data path instead of ` +
      `using one directory named "${USER_DATA_DIR_NAME}". Give the package.json beside the entry ` +
      `point a plain "productName".`
  );
}

/**
 * First side effect in the process, deliberately (J-117). `productName: Joinery` moved the user-data
 * directory from `joinery` to `Joinery` — the same directory on a case-insensitive volume, a brand
 * new empty one on a case-sensitive volume. This moves the old one into place before any store opens
 * a file under it (which is why `window.ts` builds its store lazily). Never fatal: launching with a
 * fresh profile beats refusing to start.
 *
 * Development is untouched by design: `packages/main/package.json` says `Joinery (dev)`, so the
 * basename check below returns `skipped-unexpected-path` and `pnpm run dev` keeps its own
 * user-data directory, well away from the packaged app's real connection profiles.
 */
try {
  const outcome = migrateLegacyUserDataDir({
    userDataPath: app.getPath('userData'),
    expectedDirName: USER_DATA_DIR_NAME,
    legacyDirName: LEGACY_USER_DATA_DIR_NAME,
  });
  if (outcome === 'migrated') {
    log.info(`Migrated user data from the pre-rename "${LEGACY_USER_DATA_DIR_NAME}" directory`);
  } else {
    log.debug(`User-data case guard: ${outcome}`);
  }
} catch (err) {
  log.error('User-data case guard failed; continuing with the current user-data directory:', err);
}

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

  // Cleanup before quit. Electron does NOT await async before-quit handlers, so we prevent the
  // default quit, run the sequence ourselves, then exit. The sequence — and above all its ORDERING
  // — lives in `shutdown.ts` so that it can be asserted: the renderer is asked to empty its
  // debounced `AppState` writes BEFORE main writes its own stores to disk, and nothing exits before
  // that write (J-74). Inline, that ordering was unassertable, and getting it backwards persists
  // the state main held a moment before the renderer sent the new values.
  let isQuitting = false;
  app.on('before-quit', event => {
    if (isQuitting) return; // Already running shutdown sequence
    isQuitting = true;
    event.preventDefault(); // Hold quit until cleanup finishes (or times out)

    void runShutdown({
      // Every live window, asked while its window and every IPC handler are still up. Bounded by
      // `RENDERER_FLUSH_TIMEOUT_MS`; resolves rather than rejecting.
      requestRendererFlush: () => requestRendererFlush(BrowserWindow.getAllWindows(), ipcMain),
      cancelInFlightWork,
      flushStoreWrites,
      closeConnections,
      exit: () => app.exit(0),
      forceExitTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
  });
}

/** Force-exit safety net — if cleanup hangs, flush what we have and exit anyway. */
const SHUTDOWN_TIMEOUT_MS = 3000;

/** Timers, watchers and in-flight work. Each singleton may not exist; none of them may throw. */
function cancelInFlightWork(): void {
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

  // Fire-and-forget: this step is synchronous by design, so the stop cannot be
  // awaited. The client also SIGTERMs the child on process 'exit', so a slow
  // stop here cannot orphan the Python process.
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
}

/**
 * Writes every debounced store to disk. Runs AFTER the renderer has flushed, so the values it just
 * sent are in `AppStateStore`'s cache by now. `electron-store` writes synchronously, so there is
 * nothing to await: when this returns, it is on disk. Idempotent — `TrailingDebounce.flush()` is a
 * no-op with nothing pending — which is what makes the force-exit net safe to flush from too.
 */
function flushStoreWrites(): void {
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
}

/** SQL pools, then the SSH tunnels they ride on. */
async function closeConnections(): Promise<void> {
  await ConnectionPoolManager.getInstance().closeAll();
  log.info('Shutdown: closed all SQL pools');
  await SshTunnelManager.getInstance().closeAll();
}

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', reason => {
  log.error('Unhandled rejection:', reason);
});
