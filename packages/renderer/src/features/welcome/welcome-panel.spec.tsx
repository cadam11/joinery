/**
 * The welcome tab.
 *
 * The first test is the load-bearing one: `welcome-new-connection` is the e2e helper's way into the app
 * (`tests/helpers/joinery-actions-react.ts`), so it is asserted as a CONTRACT — present, and dispatching
 * the command that opens the connection editor — rather than incidentally through some other assertion.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@joinery/shared';
import type { ConnectionProfile, DockerContainer, DockerStatus } from '@joinery/shared';

import { subscribeCommand, type CommandId } from '../../commands';
import { IpcQueryProvider } from '../../ipc';
import { TooltipProvider } from '../../ui';
import { aiStore } from '../../state/ai';
import { chatPanelStore } from '../../state/chat';
import { connectionStore } from '../../state/connection';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { explorerStore } from '../../state/explorer';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { WelcomePanel } from './welcome-panel';

const PROFILE: ConnectionProfile = {
  id: 'conn-1',
  name: 'Test PG',
  engine: 'postgresql',
  server: '127.0.0.1',
  port: 15432,
  authenticationType: 'sql',
  username: 'joinery',
  database: 'joinery_test',
  encrypt: false,
  trustServerCertificate: true,
  connectionTimeout: 15,
} as ConnectionProfile;

const teardowns: (() => void)[] = [];
let toasts: string[] = [];
let opened: string[] = [];
/** Every command the surface dispatched, in order. */
let dispatched: CommandId[] = [];

interface BridgeOptions {
  readonly docker?: DockerStatus;
  readonly containers?: DockerContainer[];
  readonly dockerFails?: boolean;
}

function installBridge(options: BridgeOptions = {}): void {
  opened = [];
  teardowns.push(
    installJoineryMock({
      app: { openExternal: (url: string) => (opened.push(url), Promise.resolve()) },
      ai: {
        getVendors: () => Promise.resolve([]),
        getSettings: () => Promise.resolve({ ...DEFAULT_AI_SETTINGS }),
      },
      docker: {
        detect: () =>
          options.dockerFails === true
            ? Promise.reject(new Error('no socket'))
            : Promise.resolve(options.docker ?? ({ isAvailable: false } as DockerStatus)),
        getContainers: () => Promise.resolve(options.containers ?? []),
      },
    })
  );
}

/** Records dispatches of the ids the surface produces, so the wires are asserted rather than the UI. */
function watchCommands(...ids: CommandId[]): void {
  dispatched = [];
  for (const id of ids) {
    teardowns.push(
      subscribeCommand(id as 'open-connection-dialog', () => {
        dispatched.push(id);
      })
    );
  }
}

function mountWelcome() {
  return render(
    <IpcQueryProvider>
      <TooltipProvider>
        <WelcomePanel />
      </TooltipProvider>
    </IpcQueryProvider>
  );
}

beforeEach(() => {
  toasts = [];
  dispatched = [];
  teardowns.push(
    setDiagnosticsSink({ error: () => undefined, warn: () => undefined }),
    setNotifier({
      success: text => toasts.push(text),
      error: text => toasts.push(text),
      info: text => toasts.push(text),
      warning: text => toasts.push(text),
    })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
  aiStore.setState(aiStore.getInitialState());
  connectionStore.setState({ profiles: [], connectedProfileIds: new Set() });
  explorerStore.getState().clear();
  chatPanelStore.setState({ panelOpen: false });
});

describe('the welcome tab', () => {
  it('keeps the welcome-new-connection contract, and it opens the connection editor', async () => {
    // `tests/helpers/joinery-actions-react.ts` depends on this testid. It survives every restyle.
    installBridge();
    watchCommands('open-connection-dialog');
    mountWelcome();

    const cta = screen.getByTestId('welcome-new-connection');
    expect(cta.textContent).toContain('Fit a connection');

    await userEvent.click(cta);
    expect(dispatched).toEqual(['open-connection-dialog']);
  });

  it('offers the AI setup entry while no provider is configured', async () => {
    installBridge();
    watchCommands('open-ai-setup');
    mountWelcome();

    expect(screen.getByTestId('welcome-ai-setup')).toBeTruthy();
    await userEvent.click(screen.getByTestId('welcome-ai-setup-open'));
    expect(dispatched).toEqual(['open-ai-setup']);
  });

  it('swaps to the configured state and opens the assistant instead', async () => {
    installBridge();
    aiStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        vendorSettings: [
          { vendorId: 'google', enabled: true, apiKeyConfigured: true, priority: 1 },
        ],
      },
    });
    mountWelcome();

    expect(screen.queryByTestId('welcome-ai-setup')).toBeNull();
    await userEvent.click(screen.getByTestId('welcome-open-chat'));
    expect(chatPanelStore.getState().panelOpen).toBe(true);
  });

  it('says the tour is not in this build rather than dispatching into silence', async () => {
    // This surface is rendered here WITHOUT the shell's non-visual mounts, so nothing handles
    // `start-tour` — which is also the dev pages' arrangement. The button is present either way, because
    // hiding it would be the "silently omits half its entries" failure the palette refuses, and it
    // reports the truth. The live half is the test below, and `tests/e2e-react/welcome-screen.spec.ts`
    // asserts it against the real shell, where `TourHost` is mounted.
    installBridge();
    mountWelcome();

    await userEvent.click(screen.getByTestId('welcome-start-tour'));
    // Naming the owner is the load-bearing half, exactly as it is on a disabled palette row.
    expect(toasts).toContain('The guided tour is not in this build yet — Task 19b.');
  });

  it('is live wherever something handles start-tour, with no edit here', async () => {
    installBridge();
    watchCommands('start-tour');
    mountWelcome();

    await userEvent.click(screen.getByTestId('welcome-start-tour'));
    expect(dispatched).toEqual(['start-tour']);
    expect(toasts).toEqual([]);
  });

  describe('saved connections', () => {
    it('is absent with no saved profiles', () => {
      installBridge();
      mountWelcome();
      expect(screen.queryAllByTestId('welcome-recent-connection')).toHaveLength(0);
    });

    it('connects and adds the server node on a click', async () => {
      installBridge();
      // `connect` reaches the bridge; what matters here is that a successful connect does the two store
      // writes the sidebar's own connect path does, rather than leaving the tree empty.
      teardowns.push(
        installJoineryMock({
          app: { openExternal: () => Promise.resolve() },
          ai: {
            getVendors: () => Promise.resolve([]),
            getSettings: () => Promise.resolve({ ...DEFAULT_AI_SETTINGS }),
          },
          docker: {
            detect: () => Promise.resolve({ isAvailable: false } as DockerStatus),
            getContainers: () => Promise.resolve([]),
          },
          connection: {
            connect: () =>
              Promise.resolve({
                success: true,
                connectionId: PROFILE.id,
                profileId: PROFILE.id,
              } as never),
          },
          database: { list: () => Promise.resolve([]) },
          explorer: { getChildren: () => Promise.resolve([]) },
        })
      );
      connectionStore.setState({ profiles: [PROFILE] });
      mountWelcome();

      const row = screen.getByTestId('welcome-recent-connection');
      expect(row.textContent).toContain('Test PG');
      expect(row.textContent).toContain('127.0.0.1:15432');

      await userEvent.click(row);
      await waitFor(() =>
        expect(
          explorerStore.getState().rootNodes.some(node => node.connectionId === PROFILE.id)
        ).toBe(true)
      );
    });
  });

  describe('the Docker line', () => {
    it('reports that Docker is not running', async () => {
      installBridge({ docker: { isAvailable: false } as DockerStatus });
      mountWelcome();
      await waitFor(() =>
        expect(screen.getByTestId('welcome-action-docker').textContent).toContain(
          'Docker is not running'
        )
      );
    });

    it('counts running database containers, through the shared Docker query', async () => {
      // Task 19b deleted this card's own `docker.detect` effect: the line is now `DockerPip.tooltip`, so
      // the welcome tab, the status-bar pip and the Docker panel cannot disagree about the count.
      //
      // No `isSqlServer` in the fixture, because that flag is a main-process no-op — `docker.ipc.ts:30`
      // sets it to `true` for every container it returns, and the detector has already dropped everything
      // that is not a database image. The engine comes from the IMAGE now, as the detector's own does.
      installBridge({
        docker: { isAvailable: true, isRunning: true } as DockerStatus,
        containers: [
          { id: 'a', name: 'pg', image: 'postgres:16', state: 'running' } as DockerContainer,
          { id: 'b', name: 'my', image: 'mysql:8', state: 'exited' } as DockerContainer,
        ],
      });
      mountWelcome();

      await waitFor(() =>
        expect(screen.getByTestId('welcome-action-docker').textContent).toContain(
          'Docker: 1 of 2 database containers running'
        )
      );
    });

    it('is silent to the user when Docker cannot be reached', async () => {
      // Docker not being installed is the ordinary case, not an error worth a toast.
      installBridge({ dockerFails: true });
      mountWelcome();

      await waitFor(() =>
        expect(screen.getByTestId('welcome-action-docker').textContent).toContain(
          'Docker is not available'
        )
      );
      expect(toasts).toEqual([]);
    });
  });

  it('opens the two footer links through the shell, not as navigations', async () => {
    // `<a href>` in this window is a navigation waiting to happen: main has no `will-navigate` guard and
    // no `setWindowOpenHandler` (PLAN.md §7's closing note).
    installBridge();
    mountWelcome();

    await userEvent.click(screen.getByTestId('welcome-docs'));
    await userEvent.click(screen.getByTestId('welcome-github'));

    expect(opened).toEqual(['https://usejoinery.com/', 'https://github.com/cadam11/joinery']);
    expect(document.querySelectorAll('a[href]')).toHaveLength(0);
  });
});
