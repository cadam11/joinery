/**
 * The shell, mounted for real: the boot gate, the two splits, the panels, and the shortcut.
 *
 * jsdom has no layout engine, so this is not where the dock's geometry is verified — the browser gate
 * (`.superpowers/sdd/PLAN/task-7-gate.mjs`, run against the packaged-style Electron app) does that.
 * What it does verify is everything that is *wiring* rather than pixels, and wiring is where a shell
 * breaks silently: whether the startup screen yields, whether the panels appear where the stores say
 * they should, and whether ⌘J reaches the log store through the command bus rather than through a
 * direct call that happens to work today.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_AI_SETTINGS } from '@joinery/shared';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { createAppStateDouble, type AppStateDouble } from '../test/app-state-double';
import { setDiagnosticsSink, setNotifier } from '../state/diagnostics';
import { chatPanelStore } from '../state/chat';
import { logStore } from '../state/logs';
import { tabStore } from '../state/tab';
import { workbenchStore } from '../state/workbench';
import { IpcQueryProvider } from '../ipc';
import { registeredExitFlushNames } from '../persistence/flush-on-exit';
import { AppShell } from './app-shell';
import { bootStore, resetBootLatch, runBoot } from './boot';
import { MENU_CHANNELS } from './menu-bridge';

let bridge: AppStateDouble;
const teardowns: (() => void)[] = [];

/** A subscription that records nothing: the shell only has to be able to install it. */
const inertSubscription = () => () => undefined;

/**
 * The bridge members the shell touches on mount. Deliberately not the whole `JoineryAPI` — see the
 * header of `test/joinery-mock.ts` — but it does have to include every `on*` member the shell
 * subscribes to, because `useIpcEvent` calls them for real: the 31 `menu.on*` channels the bridge
 * routes, plus `logs.onEntry`, `theme.onChanged`, `backup.onProgress` and `restore.onProgress` —
 * `BackupDialogs` and `RestoreDialogs` hold those last two for the app's lifetime rather than only
 * while their dialogs are open, because both operations outlive the dialog that started them and the
 * shared in-flight record has to be retired when they finish (see `state/db-operations.ts`).
 *
 * `ai.getVendors` / `ai.getSettings` are here because `AiSetupHost` is the one caller of
 * `aiStore.initialize()` (J-55) and it fires on mount. Omitting them is not neutral: the store would
 * report the failure through `diagnostics.error`, which the Output panel counts, and the error-badge
 * test below would see two errors instead of one.
 */
function installShellBridge(double: AppStateDouble): void {
  const menu = Object.fromEntries(MENU_CHANNELS.map(channel => [channel, inertSubscription]));

  teardowns.push(
    installJoineryMock({
      app: { ...double.app, getVersion: () => Promise.resolve('1.2.3') },
      connection: { list: () => Promise.resolve([]) },
      ai: {
        getVendors: () => Promise.resolve([]),
        getSettings: () => Promise.resolve({ ...DEFAULT_AI_SETTINGS }),
      },
      backup: { onProgress: inertSubscription },
      restore: { onProgress: inertSubscription },
      logs: {
        getRecent: () => Promise.resolve([]),
        append: () => Promise.resolve(),
        onEntry: inertSubscription,
      },
      theme: { getNative: () => Promise.resolve('dark'), onChanged: inertSubscription },
      // The status bar asks once and then listens (J-118). `available: true` is the quiet
      // case: the keychain indicator renders nothing, which is what the tests here expect.
      credentials: {
        getKeychainStatus: () => Promise.resolve({ available: true }),
        onKeychainStatusChanged: inertSubscription,
      },
      menu: menu as never,
    })
  );
}

async function mountShell(): Promise<void> {
  render(
    <IpcQueryProvider>
      <AppShell />
    </IpcQueryProvider>
  );
  await waitFor(() => expect(bootStore.getState().phase).not.toBe('starting'));
  await screen.findByTestId('app-shell');
}

beforeEach(() => {
  resetBootLatch();
  bootStore.getState().reset();
  // The log store is a module singleton and the diagnostics sink writes into it, so an error
  // reported by one test's boot would otherwise be counted by the next test's badge.
  logStore.getState().clear();
  logStore.getState().close();
  bridge = createAppStateDouble();
  installShellBridge(bridge);
  teardowns.push(setDiagnosticsSink({ error: () => undefined, warn: () => undefined }));
});

afterEach(async () => {
  // Let the in-flight boot settle before the bridge mock is removed. `mountShell` only waits for the
  // shell to appear, which is two steps short of the end of the sequence; without this the tail of
  // the boot runs against a torn-down bridge and reports a failure that belongs to nothing.
  await runBoot().catch(() => undefined);
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  resetBootLatch();
  bootStore.getState().reset();
  logStore.getState().close();
  logStore.getState().clear();
  chatPanelStore.getState().closePanel();
  tabStore.getState().closeAllTabs();
  workbenchStore.getState().setSidebarCollapsed(false);
  workbenchStore.getState().resetSidebarWidth();
});

describe('the app shell', () => {
  it('shows the startup screen until the stores are hydrated, then the frame', async () => {
    render(
      <IpcQueryProvider>
        <AppShell />
      </IpcQueryProvider>
    );

    // The gate the brief calls for: nothing interactive before hydration.
    expect(screen.getByTestId('startup-screen')).toBeDefined();
    expect(screen.queryByTestId('app-shell')).toBeNull();

    await screen.findByTestId('app-shell');
    expect(screen.queryByTestId('startup-screen')).toBeNull();
  });

  it('mounts the frame in its four parts', async () => {
    await mountShell();

    expect(screen.getByTestId('titlebar')).toBeDefined();
    expect(screen.getByTestId('sidebar')).toBeDefined();
    expect(screen.getByTestId('workspace')).toBeDefined();
    expect(screen.getByTestId('status-bar')).toBeDefined();
  });

  it('runs the boot sequence to completion and opens the persistence gates', async () => {
    await mountShell();

    await waitFor(() => expect(bootStore.getState().phase).toBe('ready'));
    expect(tabStore.getState().isPersistenceUnlocked()).toBe(true);
  });

  it('collapses and restores the sidebar from the titlebar, and the divider goes with it', async () => {
    const user = userEvent.setup();
    await mountShell();

    expect(screen.getByTestId('sidebar-resize-handle')).toBeDefined();

    await user.click(screen.getByTestId('titlebar-sidebar-toggle'));
    expect(screen.queryByTestId('sidebar')).toBeNull();
    // The divider owns the hairline between the panes, so it has to leave with the pane it divides.
    expect(screen.queryByTestId('sidebar-resize-handle')).toBeNull();

    await user.click(screen.getByTestId('titlebar-sidebar-toggle'));
    expect(screen.getByTestId('sidebar')).toBeDefined();
  });

  it('opens the assistant panel with its own divider from the status bar', async () => {
    const user = userEvent.setup();
    await mountShell();

    expect(screen.queryByTestId('chat-panel')).toBeNull();

    await user.click(screen.getByTestId('status-chat-toggle'));
    expect(screen.getByTestId('chat-panel')).toBeDefined();
    expect(screen.getByTestId('chat-resize-handle')).toBeDefined();

    await user.click(screen.getByTestId('chat-panel-close'));
    expect(screen.queryByTestId('chat-panel')).toBeNull();
  });

  it('toggles the output panel with ⌘J, through the command bus', async () => {
    const user = userEvent.setup();
    await mountShell();

    expect(logStore.getState().isOpen).toBe(false);
    await user.keyboard('{Meta>}j{/Meta}');
    expect(logStore.getState().isOpen).toBe(true);
    await user.keyboard('{Meta>}j{/Meta}');
    expect(logStore.getState().isOpen).toBe(false);
  });

  it('toggles the output panel from the status bar too', async () => {
    const user = userEvent.setup();
    await mountShell();

    await user.click(screen.getByTestId('status-output-toggle'));
    expect(logStore.getState().isOpen).toBe(true);
  });

  it('shows the app version and the disconnected state in the status bar', async () => {
    await mountShell();

    expect(screen.getByTestId('status-connection').textContent).toContain('Not connected');
    await waitFor(() =>
      expect(screen.getByTestId('status-version').textContent).toContain('v1.2.3')
    );
  });

  it('badges unseen errors inside the button rather than overhanging it', async () => {
    await mountShell();

    logStore.getState().push({
      id: 'e1',
      timestamp: 1,
      level: 'error',
      tag: 'main',
      message: 'boom',
      source: 'main',
    });

    const badge = await screen.findByTestId('status-output-badge');
    // The audit's finding was a badge positioned OUTSIDE a 24px bar at `top: -2px`; the fix is that
    // the count is a child of the button's own flow.
    expect(badge.textContent).toBe('1');
    expect(screen.getByTestId('status-output-toggle').contains(badge)).toBe(true);
  });

  it('reaches Task 12’s backup dialog for the broken Database ▸ Backup menu item', async () => {
    // PLAN.md 0.1: this menu item was `router.navigate(['/backup'])` into a router with no outlet, and
    // then a Task 7 placeholder. What is asserted here is that the shell still routes it — the handler
    // now lives in `features/backup/BackupDialogs`, which `app-shell.tsx` mounts, so a missing mount
    // shows up as a dispatch that reaches nobody.
    //
    // The shell's bridge double has no connections, which is the interesting half: the command carries
    // no payload, so with nothing connected the only honest answer is to say so. It is also the one
    // moment a toast is legal on this path — no modal is open yet (J-42).
    await mountShell();

    // Installed AFTER the mount, not before: the shell's own layout effect calls
    // `installToastNotifier()`, which replaces whatever notifier was active — so a recorder installed
    // first would be the one that got replaced.
    const warnings: string[] = [];
    teardowns.push(
      setNotifier({
        success: () => undefined,
        info: () => undefined,
        error: () => undefined,
        warning: message => warnings.push(message),
      })
    );

    const { dispatchCommand, handlerCount } = await import('../commands');
    expect(handlerCount('open-backup-dialog')).toBe(1);
    dispatchCommand('open-backup-dialog');

    await waitFor(() =>
      expect(warnings).toEqual(['Connect to a server before backing up a database.'])
    );
    expect(screen.queryByTestId('backup-dialog')).toBeNull();
  });

  it('reaches Task 13’s restore dialog for the broken Database ▸ Restore menu item', async () => {
    // The last of PLAN.md 0.1's three, and the one that emptied `ShellCommands` of its final
    // placeholder. Same shape as the backup assertion above: nothing is connected in the shell's
    // double, so the honest answer is the one legal toast on this path (J-42 — no modal is open yet).
    await mountShell();

    const warnings: string[] = [];
    teardowns.push(
      setNotifier({
        success: () => undefined,
        info: () => undefined,
        error: () => undefined,
        warning: message => warnings.push(message),
      })
    );

    const { dispatchCommand, handlerCount } = await import('../commands');
    expect(handlerCount('open-restore-dialog')).toBe(1);
    dispatchCommand('open-restore-dialog');

    await waitFor(() =>
      expect(warnings).toEqual(['Connect to a server before restoring a database.'])
    );
    expect(screen.queryByTestId('restore-dialog')).toBeNull();
    // The placeholder is gone entirely, not merely unreachable.
    expect(screen.queryByTestId('placeholder-dialog-restore')).toBeNull();
  });

  it('registers every debounced writer with the exit flush while it is mounted (J-74)', async () => {
    await mountShell();

    // Wiring, asserted rather than reviewed by eye: a writer that forgets to register loses its
    // pending value on the way out, and nothing else in the app would notice.
    expect([...registeredExitFlushNames()].sort()).toEqual([
      'open tabs',
      'shell geometry',
      'workspace layout',
    ]);
  });

  it('flushes a resize that happened inside the debounce window when the window goes away (J-74)', async () => {
    await mountShell();
    const before = bridge.calls.setState;

    // The reported bug: drag the sidebar, quit inside the 250ms debounce window, and the width is
    // gone — the timer died with the page, so main never even had the value to flush to disk.
    workbenchStore.getState().setSidebarWidth(420);
    expect(bridge.calls.setState).toBe(before);

    window.dispatchEvent(new Event('beforeunload'));

    expect(bridge.calls.setState).toBe(before + 1);
    expect(bridge.snapshot().sidebarWidth).toBe(420);
  });

  it('opens the welcome tab on the View ▸ Welcome command', async () => {
    await mountShell();
    const { dispatchCommand } = await import('../commands');

    dispatchCommand('show-welcome');

    expect(tabStore.getState().tabs.some(tab => tab.type === 'welcome')).toBe(true);
  });
});
