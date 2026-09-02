/**
 * Window Management
 */

import { BrowserWindow, screen, nativeTheme, session } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { createTrailingDebounce, type TrailingDebounce } from './utils/trailing-debounce';
import { buildContentSecurityPolicy } from './security/content-security-policy';
import { installContentSecurityPolicy } from './security/harden';
import type { AppEntry } from './security/navigation-guard';

/**
 * The renderer's two entry points, pinned.
 *
 * `packages/renderer/vite.config.ts` holds this port and this output directory to a contract and
 * names these two lines as the reason ("window.ts:111 and :114"). They are constants now only so
 * that the CSP and the navigation guard below describe the same document the window actually
 * loads, rather than a second copy of the same two literals.
 */
const DEV_SERVER_URL = 'http://localhost:4200';
const RENDERER_INDEX = path.join(__dirname, '../../renderer/dist/browser/index.html');

function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

/**
 * Built on first use, not at import time. `new Store()` resolves `app.getPath('userData')` and
 * writes the file in its constructor; at module scope that ran during `import './window'`, i.e.
 * before the entry point's first statement — which is where the user-data case guard (J-117) has to
 * run. Lazy construction puts that ordering back in the entry point's hands.
 */
let windowStateStore: Store<{ windowState: WindowState }> | null = null;

function getWindowStateStore(): Store<{ windowState: WindowState }> {
  windowStateStore ??= new Store<{ windowState: WindowState }>({
    name: 'window-state',
    defaults: {
      windowState: {
        width: 1400,
        height: 900,
        isMaximized: false,
      },
    },
  });
  return windowStateStore;
}

let mainWindow: BrowserWindow | null = null;

/**
 * Stamp the renderer's Content-Security-Policy onto the default session (J-22).
 *
 * Call once, after `app.whenReady()` and before the first window loads — the policy applies to
 * responses, so it has to be in place before the entry HTML is fetched. See
 * `security/content-security-policy.ts` for every directive's reason.
 */
export function installRendererSecurityPolicy(): void {
  installContentSecurityPolicy(
    session.defaultSession,
    buildContentSecurityPolicy({ dev: isDevelopment(), devServerUrl: DEV_SERVER_URL })
  );
}

export function createMainWindow(): BrowserWindow {
  const state = getWindowStateStore().get('windowState');

  // Validate window position is on a visible display
  const displays = screen.getAllDisplays();
  let validPosition = false;

  if (state.x !== undefined && state.y !== undefined) {
    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      if (state.x >= x && state.x < x + width && state.y >= y && state.y < y + height) {
        validPosition = true;
        break;
      }
    }
  }

  mainWindow = new BrowserWindow({
    x: validPosition ? state.x : undefined,
    y: validPosition ? state.y : undefined,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../../preload/dist/index.js'),
    },
  });

  // Restore maximized state
  if (state.isMaximized) {
    mainWindow.maximize();
  }

  // Save window state on changes
  const saveState = () => {
    if (!mainWindow) return;

    const bounds = mainWindow.getBounds();
    getWindowStateStore().set('windowState', {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: mainWindow.isMaximized(),
    });
  };

  // electron-store writes synchronously on the main thread; a raw per-event
  // save turns every drag/resize frame into a blocking disk write. Collapse
  // bursts to a single trailing write, and take the final bounds on close.
  const debouncedSave = createTrailingDebounce(saveState, 500);
  // Published so the quit sequence can empty it — see `flushWindowState`.
  pendingBoundsSave = debouncedSave;
  mainWindow.on('resize', () => debouncedSave.call());
  mainWindow.on('move', () => debouncedSave.call());
  mainWindow.on('close', () => {
    debouncedSave.cancel();
    saveState();
  });

  // Show when ready — unless we're under Playwright test, in which case
  // the launcher (tests/helpers/electron-app.ts) sets JOINERY_TEST=1 and we
  // keep the window hidden. The renderer still paints into Chromium's
  // off-screen surface, so Playwright can interact with it and capture
  // screenshots via the devtools protocol; the user just doesn't see a
  // window flashing in/out on every test.
  mainWindow.once('ready-to-show', () => {
    if (process.env.JOINERY_TEST !== '1') {
      mainWindow?.show();
    }
  });

  // No navigation-guard call here on purpose (J-129). The guards are installed app-wide from
  // `index.ts` via `web-contents-created`, which fires while `new BrowserWindow` above is still
  // constructing — so they are already on this window's `webContents`, and on any window added
  // later without anyone remembering to wire it.

  // Load the app
  if (isDevelopment()) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(RENDERER_INDEX);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * The live window's pending bounds write, or `null` before any window exists. Module-scoped for the
 * one reason below; nothing else may read it.
 */
let pendingBoundsSave: TrailingDebounce | null = null;

/**
 * Writes a pending window position/size now; a no-op when nothing is pending (J-74).
 *
 * The bounds debounce above was flushed only from `mainWindow.on('close')`, and that event never
 * fires on a quit: `index.ts` preventDefaults `before-quit` and ends at `app.exit(0)`, which closes
 * windows without emitting `close`. So the "take the final bounds on close" comment described dead
 * code on every quit, and a move or resize inside the 500ms window was dropped — the main-process
 * sibling of the renderer bug this ticket is about. `shutdown.ts` calls this in the same step that
 * writes `AppState`, while the window is still alive to be measured.
 */
export function flushWindowState(): void {
  pendingBoundsSave?.flush();
}

/**
 * Which document this build treats as "the app" — the one origin navigation is allowed to reach.
 *
 * Deterministic from the dev/prod flag, so the app-level guard hook in `index.ts` can resolve it
 * once at startup rather than per window (J-129).
 */
export function resolveAppEntry(): AppEntry {
  return isDevelopment()
    ? { kind: 'dev-server', url: DEV_SERVER_URL }
    : { kind: 'file', path: RENDERER_INDEX };
}
