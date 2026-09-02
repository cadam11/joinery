/**
 * The Docker panel against the bridge double: the states, the two lifecycle actions, the failed-stop
 * report main cannot give, the Connect wire, and the create form's refusals.
 */

import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DockerContainer, DockerStatus, DockerVolume } from '@joinery/shared';

import { subscribeCommand } from '../../commands';
import { setDiagnosticsSink, setNotifier } from '../../state/diagnostics';
import { installJoineryMock, removeJoineryMock } from '../../test/joinery-mock';
import { TooltipProvider } from '../../ui';
import { DockerPanel } from './docker-panel';
import { DockerPip } from './docker-pip';

const teardowns: (() => void)[] = [];
const noop = (): void => undefined;

let toasts: string[] = [];
let containers: DockerContainer[] = [];
let status: DockerStatus = { isAvailable: true, isRunning: true };
let detectRejects = false;
let volumes: DockerVolume[] = [];

let startContainer: ReturnType<typeof vi.fn>;
let stopContainer: ReturnType<typeof vi.fn>;
let createContainer: ReturnType<typeof vi.fn>;

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer => ({
  id: 'c1',
  name: 'joinery-test-postgres',
  image: 'postgres:16',
  state: 'running',
  status: 'Up 3 hours',
  port: 55432,
  ...overrides,
});

function mount() {
  // A fresh client per test, with retries off: a rejected detect must surface as `absent` on the first
  // attempt rather than after TanStack's default three.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <DockerPanel />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  toasts = [];
  containers = [container()];
  status = { isAvailable: true, isRunning: true };
  detectRejects = false;
  volumes = [];

  startContainer = vi.fn(async (id: string) => {
    containers = containers.map(candidate =>
      candidate.id === id ? { ...candidate, state: 'running' } : candidate
    );
  });
  // Stops, and — like main — resolves whether or not the container actually stopped.
  stopContainer = vi.fn(async (id: string) => {
    containers = containers.map(candidate =>
      candidate.id === id ? { ...candidate, state: 'exited' } : candidate
    );
  });
  createContainer = vi.fn(async () => ({ success: true, containerId: 'new' }));

  teardowns.push(
    installJoineryMock({
      docker: {
        detect: () =>
          detectRejects ? Promise.reject(new Error('no socket')) : Promise.resolve(status),
        getContainers: () => Promise.resolve([...containers]),
        getVolumes: () => Promise.resolve([...volumes]),
        startContainer,
        stopContainer,
        createContainer,
      },
    })
  );
  teardowns.push(
    setNotifier({
      success: message => toasts.push(`success:${message}`),
      error: message => toasts.push(`error:${message}`),
      info: noop,
      warning: message => toasts.push(`warning:${message}`),
    })
  );
  teardowns.push(setDiagnosticsSink({ error: noop, warn: noop }));
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  removeJoineryMock();
});

describe('DockerPanel — the states', () => {
  it('reports that Docker is not available when detect rejects', async () => {
    detectRejects = true;
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-absent')).not.toBeNull());
    // No create form on a machine with no Docker: it could not possibly work.
    expect(screen.queryByTestId('docker-new-container')).toBeNull();
  });

  it('carries main’s own reason when the daemon is down', async () => {
    status = { isAvailable: true, isRunning: false, error: 'Please start Docker Desktop.' };
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-stopped')).not.toBeNull());
    expect(screen.getByTestId('docker-stopped').textContent).toContain(
      'Please start Docker Desktop.'
    );
  });

  it('says "no database containers", not "no SQL Server containers"', async () => {
    containers = [];
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-empty')).not.toBeNull());
    const text = screen.getByTestId('docker-empty').textContent ?? '';
    expect(text).toContain('No database containers');
    // The Angular copy was wrong on exactly the machines it mattered on.
    expect(text).not.toContain('SQL Server containers found');
  });

  it('lists a PostgreSQL container with its real ports, its status and its binds', async () => {
    containers = [
      container({
        volumeMappings: [{ hostPath: '/tmp/dumps', containerPath: '/backups', mode: 'ro' }],
        // What main really sends: a hardcoded internal 1433 for every engine.
        ports: [{ internal: 1433, external: 55432 }],
      }),
    ];
    mount();

    await waitFor(() => expect(screen.queryAllByTestId('docker-container')).toHaveLength(1));
    const row = screen.getByTestId('docker-container');
    expect(row.textContent).toContain('joinery-test-postgres');
    expect(row.textContent).toContain('PostgreSQL');
    expect(row.textContent).toContain(':55432 → 5432');
    // Not 1433, which is what main claims and the Angular panel would have shown.
    expect(row.textContent).not.toContain('1433');
    expect(row.textContent).toContain('Up 3 hours');
    expect(screen.getByTestId('docker-container-binds').textContent).toContain(
      '/tmp/dumps → /backups'
    );
  });

  it('renders no Volumes section while main answers with an empty list', async () => {
    // `docker.getVolumes()` is a stub that returns [] (J-70). A permanently empty section would be the
    // decorative control J-44 forbids.
    mount();
    await waitFor(() => expect(screen.queryAllByTestId('docker-container')).toHaveLength(1));
    expect(screen.queryByTestId('docker-volumes')).toBeNull();
  });

  it('renders the Volumes section the moment main can answer', async () => {
    volumes = [
      { name: 'joinery_pgdata', driver: 'local', mountpoint: '/var/lib/docker/volumes/x' },
    ];
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-volumes')).not.toBeNull());
    expect(screen.getByTestId('docker-volumes').textContent).toContain('joinery_pgdata');
  });
});

describe('DockerPanel — start and stop', () => {
  it('starts a stopped container and says so', async () => {
    containers = [container({ state: 'exited', status: 'Exited (0) 2 days ago' })];
    mount();

    await waitFor(() => expect(screen.queryByTestId('docker-start')).not.toBeNull());
    await userEvent.click(screen.getByTestId('docker-start'));

    await waitFor(() => expect(startContainer).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(toasts).toContain('success:Started joinery-test-postgres'));
  });

  it('stops a running container and says so', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-stop')).not.toBeNull());
    await userEvent.click(screen.getByTestId('docker-stop'));

    await waitFor(() => expect(stopContainer).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(toasts).toContain('success:Stopped joinery-test-postgres'));
  });

  it('reports a stop that did not stop — the failure main cannot report', async () => {
    // `docker.ipc.ts:53-58` discards the detector's `{ success: false, error }`, so this stop resolves
    // exactly like one that worked. The only honest report is to look afterwards.
    stopContainer.mockImplementation(async () => undefined);
    mount();

    await waitFor(() => expect(screen.queryByTestId('docker-stop')).not.toBeNull());
    await userEvent.click(screen.getByTestId('docker-stop'));

    await waitFor(() =>
      expect(toasts).toContain(
        'error:joinery-test-postgres is still running — Docker refused to stop it'
      )
    );
    expect(toasts).not.toContain('success:Stopped joinery-test-postgres');
  });

  it('passes a failed start’s own message through', async () => {
    containers = [container({ state: 'exited' })];
    startContainer.mockRejectedValueOnce(new Error('port is already allocated'));
    mount();

    await waitFor(() => expect(screen.queryByTestId('docker-start')).not.toBeNull());
    await userEvent.click(screen.getByTestId('docker-start'));

    await waitFor(() =>
      expect(toasts.some(toast => toast.includes('port is already allocated'))).toBe(true)
    );
  });
});

describe('DockerPanel — Connect', () => {
  it('dispatches connect-to-container with the container’s host and published port', async () => {
    const dispatched: unknown[] = [];
    teardowns.push(
      subscribeCommand('connect-to-container', payload => {
        dispatched.push(payload);
      })
    );
    mount();

    await waitFor(() => expect(screen.queryByTestId('docker-connect')).not.toBeNull());
    await userEvent.click(screen.getByTestId('docker-connect'));

    expect(dispatched).toEqual([{ server: 'localhost', port: 55432 }]);
  });

  it('refuses, with a reason in the tooltip, when nothing is published', async () => {
    containers = [container({ port: null, ports: [] })];
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-connect')).not.toBeNull());
    expect((screen.getByTestId('docker-connect') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DockerPanel — the create form', () => {
  async function openForm() {
    mount();
    await waitFor(() => expect(screen.queryByTestId('docker-new-container')).not.toBeNull());
    await userEvent.click(screen.getByTestId('docker-new-container'));
    await waitFor(() => expect(screen.queryByTestId('docker-create-form')).not.toBeNull());
  }

  /** Fills in a valid password and submits into a Docker that refuses. Returns once the toast lands. */
  async function submitRefusedCreate() {
    createContainer.mockResolvedValueOnce({ success: false, error: 'name already in use' });
    await openForm();
    await userEvent.type(screen.getByTestId('docker-create-password'), 'Strong!Pass123');
    await userEvent.click(screen.getByTestId('docker-create-submit'));
    await waitFor(() => expect(toasts).toContain('error:name already in use'));
  }

  it('refuses a password SQL Server would reject, and says why before a submit', async () => {
    await openForm();
    await userEvent.type(screen.getByTestId('docker-create-password'), 'weak');

    expect((screen.getByTestId('docker-create-submit') as HTMLButtonElement).disabled).toBe(true);
    // The reason is on screen as soon as the field has something wrong in it, not after a submit the
    // disabled button will never allow — otherwise the message would be unreachable.
    expect(screen.getByTestId('docker-create-form').textContent).toContain('at least 8 characters');
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('does not scold an untouched password field', async () => {
    await openForm();
    const form = screen.getByTestId('docker-create-form');
    expect(form.textContent).not.toContain('at least 8 characters');
    // The RULE is visible from the start, which is what explains the disabled button (J-44).
    expect(form.textContent).toContain('Eight characters and three of');
  });

  it('refuses the port an existing container already publishes', async () => {
    containers = [container({ port: 14330, image: 'mssql/server' })];
    await openForm();
    await userEvent.type(screen.getByTestId('docker-create-password'), 'Strong!Pass123');

    const port = screen.getByTestId('docker-create-port');
    await userEvent.clear(port);
    await userEvent.type(port, '14330');

    expect((screen.getByTestId('docker-create-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a container and forgets the password', async () => {
    await openForm();
    await userEvent.type(screen.getByTestId('docker-create-password'), 'Strong!Pass123');
    await userEvent.click(screen.getByTestId('docker-create-submit'));

    await waitFor(() => expect(createContainer).toHaveBeenCalledTimes(1));
    expect(createContainer.mock.calls[0]?.[0]).toEqual({
      name: 'joinery-mssql',
      password: 'Strong!Pass123',
      port: 1433,
      // Stated in words above the button that sends it — the Angular panel sent this silently.
      acceptEula: true,
    });
    // The form closes on success, so the secret is not sitting in a mounted input.
    await waitFor(() => expect(screen.queryByTestId('docker-create-form')).toBeNull());
  });

  it('passes Docker’s refusal through instead of reporting success', async () => {
    // The Angular panel checked `result.success`, but only after having already been able to report
    // "created and started" for a container that exits on a bad password — which is why the rule above
    // exists as well as this arm. The toast is asserted inside `submitRefusedCreate`.
    await submitRefusedCreate();

    // Still open, so the user can fix the name rather than starting over.
    expect(screen.queryByTestId('docker-create-form')).not.toBeNull();
  });

  it('forgets the password even when the create is refused', async () => {
    // The refused form stays mounted (asserted above) so the user can fix the name — which is exactly
    // why the secret must not stay mounted with it: the password is dropped as soon as it has been
    // sent, worked or not (J-110).
    await submitRefusedCreate();

    // Restated here rather than leaned on: if the form ever unmounted on refusal, this test would
    // pass for the wrong reason and stop guarding anything.
    expect(screen.queryByTestId('docker-create-form')).not.toBeNull();
    await waitFor(() =>
      expect((screen.getByTestId('docker-create-password') as HTMLInputElement).value).toBe('')
    );
  });

  it('never offers an image field, because main hardcodes SQL Server’s environment', async () => {
    await openForm();
    // `createContainer` sets ACCEPT_EULA and MSSQL_SA_PASSWORD and publishes 1433 whatever image it is
    // handed, so an image picker would be a control that produces containers that cannot start.
    expect(screen.queryByTestId('docker-create-image')).toBeNull();
    expect(screen.getByTestId('docker-create-form').textContent).toContain(
      'mssql/server:2022-latest'
    );
  });
});

/**
 * The pip and its popover, mounted together, because the Escape path is a property of the PAIR and
 * J-72's regression lived exactly in the seam: `docker-pip.tsx` carried a local `onKeyDown` for it,
 * `ui/popover.tsx` now carries the real fix, and the only coverage was an e2e test that needs a
 * running Docker daemon. This runs against the bridge double instead.
 */
describe('DockerPip — the keyboard path out of the panel (J-72)', () => {
  function PipHarness({ onOpenChange }: { readonly onOpenChange: (open: boolean) => void }) {
    const [open, setOpen] = useState(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <DockerPip
            controlClassName="h-6 px-1.5"
            open={open}
            onOpenChange={next => {
              setOpen(next);
              onOpenChange(next);
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  it('closes on Escape with focus on the panel’s own tooltipped Refresh button', async () => {
    const onOpenChange = vi.fn();
    render(<PipHarness onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.queryByTestId('docker-refresh')).not.toBeNull());

    screen.getByTestId('docker-refresh').focus();
    // The tip is up, which is what used to swallow the key — asserted so this cannot pass without
    // having reproduced the condition.
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeNull());

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByTestId('docker-popover')).toBeNull());
  });
});
