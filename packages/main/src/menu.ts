/**
 * Application Menu - macOS-style menu system
 */

import { Menu, app, shell, BrowserWindow } from 'electron';
import { DOCS_SITE_URL } from '@joinery/shared';

import { openExternalSafely } from './security/open-external';
import { createLogger } from './utils/logger';

const log = createLogger('Menu');

/**
 * Open a menu link through the scheme allowlist (J-129).
 *
 * Electron does not await a menu click, so the rejection has to be handled here rather than
 * escaping as an unhandled promise. Every URL below is a hard-coded literal, so a refusal means
 * one of them was edited into something the allowlist rejects — a build-time mistake that should
 * be loud in the Output panel, not silent.
 */
function openMenuLink(url: string): void {
  openExternalSafely(url, shell.openExternal).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Refused to open a menu link: ${message}`);
  });
}

export function createMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings...',
                accelerator: 'Cmd+,',
                click: () => {
                  const win = BrowserWindow.getFocusedWindow();
                  win?.webContents.send('menu:open-settings');
                },
              },
              // Beside Settings, in both menus Settings appears in (J-92). Until this existed the AI
              // setup dialog had exactly one unconditional door — the command palette — because the
              // welcome card and the chat empty state both disappear once a provider is configured.
              // No accelerator: this is a rarely-repeated configuration step, and the palette entry
              // already covers the keyboard.
              {
                label: 'AI Setup...',
                click: () => {
                  const win = BrowserWindow.getFocusedWindow();
                  win?.webContents.send('menu:open-ai-setup');
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Connection...',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:new-connection');
          },
        },
        { type: 'separator' },
        {
          label: 'New Query',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:new-query');
          },
        },
        {
          label: 'Open Query...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:open-query');
          },
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:close-tab');
          },
        },
        { type: 'separator' },
        {
          label: 'Save Query',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:save-query');
          },
        },
        {
          label: 'Save Query As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:save-query-as');
          },
        },
        { type: 'separator' },
        {
          label: 'Export Results...',
          accelerator: 'CmdOrCtrl+Shift+X',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:export-results');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        // Edit > Copy is intercepted in the renderer so context-aware
        // surfaces (the results grid, future copy-from-X handlers) can
        // honor user settings — for the grid, that means the chosen Copy
        // Format (TSV / CSV / JSON, headers on/off). The renderer falls
        // back to document.execCommand('copy') when no surface claims it,
        // matching the role:'copy' default for plain text selections.
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:copy');
          },
        },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        {
          role: 'selectAll',
          accelerator: 'CmdOrCtrl+A',
          registerAccelerator: false,
        },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:find');
          },
        },
        {
          label: 'Find and Replace',
          accelerator: isMac ? 'Cmd+Option+F' : 'Ctrl+H',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:replace');
          },
        },
        { type: 'separator' },
        {
          label: 'Format SQL',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:format-sql');
          },
        },
        {
          label: 'Toggle Comment',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:toggle-comment');
          },
        },
        // Preferences live in the app menu on macOS and in Edit everywhere else — never both.
        // This block was unconditional, so macOS showed Settings… twice, and when J-92 added
        // AI Setup… beside it, faithfully, it doubled that too (J-97).
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Preferences...',
                accelerator: 'CmdOrCtrl+,' as const,
                click: () => {
                  const win = BrowserWindow.getFocusedWindow();
                  win?.webContents.send('menu:open-settings');
                },
              },
              {
                label: 'AI Setup...',
                click: () => {
                  const win = BrowserWindow.getFocusedWindow();
                  win?.webContents.send('menu:open-ai-setup');
                },
              },
            ]),
      ],
    },

    // Query menu
    {
      label: 'Query',
      submenu: [
        {
          label: 'Execute',
          accelerator: 'CmdOrCtrl+E',
          registerAccelerator: false,
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:execute-query');
          },
        },
        {
          label: 'Execute Selection',
          accelerator: isMac ? 'Cmd+Shift+Return' : 'Ctrl+Shift+E',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:execute-selection');
          },
        },
        { type: 'separator' },
        {
          label: 'Cancel Execution',
          accelerator: isMac ? 'Cmd+.' : 'Alt+Break',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:cancel-query');
          },
        },
        { type: 'separator' },
        {
          label: 'Query History...',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:query-history');
          },
        },
      ],
    },

    // Server menu
    {
      label: 'Server',
      submenu: [
        {
          label: 'Connect...',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:new-connection');
          },
        },
        {
          label: 'Disconnect',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:disconnect');
          },
        },
        { type: 'separator' },
        {
          label: 'Refresh Object Explorer',
          // Cmd+R / Ctrl+R is the canonical refresh shortcut on every
          // platform Joinery ships on. Cmd+Shift+R was harder to discover
          // and conflicted with browser intuitions for "hard reload".
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:refresh');
          },
        },
        // No "Server Properties..." item. J-104: it sent `menu:server-properties`, which the
        // renderer routes to `show-server-properties` — a command nothing subscribes to, and the
        // unowned-command warning is DEV-only, so the click did nothing at all in a packaged
        // build. The command stays registered and the palette lists it as visibly not-wired
        // (`features/command-palette`); a native menu item has no such affordance, so it is gone
        // until the properties surface ships.
      ],
    },

    // Database menu
    {
      label: 'Database',
      submenu: [
        {
          label: 'New Database...',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:new-database');
          },
        },
        { type: 'separator' },
        {
          label: 'Backup...',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:backup');
          },
        },
        {
          label: 'Restore...',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:restore');
          },
        },
        // No "Database Properties..." item either, for the reason given under Server above.
      ],
    },

    // View menu
    {
      label: 'View',
      submenu: [
        {
          label: 'Welcome',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:show-welcome');
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+\\',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:toggle-sidebar');
          },
        },
        {
          label: 'Toggle AI Chat',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:toggle-chat');
          },
        },
        {
          label: 'Toggle Results Panel',
          accelerator: 'CmdOrCtrl+Shift+\\',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:toggle-results');
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        // No `role: 'reload'` here. It carries ⌘R implicitly, which Server ▸ Refresh Object
        // Explorer also claims — Electron binds whichever it builds first, so one of the two was
        // unreachable by keyboard, and which one lost depended on menu construction order rather
        // than on a decision (J-58). A database client is not a browser: refreshing the object
        // explorer is the everyday meaning of ⌘R here, and reloading the renderer is a devtools
        // affordance that keeps ⇧⌘R.
        { role: 'forceReload', label: 'Reload Window', visible: true },
        { role: 'toggleDevTools' },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: isMac ? 'Cmd+Shift+]' : 'Ctrl+Tab',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:next-tab');
          },
        },
        {
          label: 'Previous Tab',
          accelerator: isMac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:previous-tab');
          },
        },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },

    // Help menu
    {
      role: 'help',
      submenu: [
        {
          label: 'Joinery Documentation',
          click: () => {
            openMenuLink(DOCS_SITE_URL);
          },
        },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.send('menu:show-shortcuts');
          },
        },
        { type: 'separator' },
        {
          label: 'Report Issue...',
          click: () => {
            openMenuLink('https://github.com/cadam11/joinery/issues');
          },
        },
        { type: 'separator' },
        {
          label: 'T-SQL Reference',
          click: () => {
            openMenuLink('https://docs.microsoft.com/en-us/sql/t-sql/language-reference');
          },
        },
        {
          label: 'SQL Server Documentation',
          click: () => {
            openMenuLink('https://docs.microsoft.com/en-us/sql/sql-server/');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
