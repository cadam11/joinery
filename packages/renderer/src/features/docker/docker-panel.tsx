/**
 * The Docker container panel, anchored under the status bar's pip.
 *
 * Replaces `shared/components/docker-panel/docker-panel.component.ts` (497). What changes, beyond the
 * four `docker-model.ts` findings it consumes:
 *
 *  - **it shows every database engine**, because the Angular `filter(c => c.isSqlServer)` was a no-op
 *    over a flag main sets to `true` for everything, and its empty state read "No SQL Server containers
 *    found" on a machine full of PostgreSQL ones;
 *  - **the bind mounts are on screen**, alongside the named volumes the bridge now answers with
 *    (J-70 replaced the `docker.getVolumes()` stub — see finding 3);
 *  - **Connect goes through `connect-to-container`**, so it opens the connection editor pre-filled
 *    instead of a router navigation this renderer has no router for. That prefill prop has existed since
 *    Task 9 with a comment naming this entry point, and nothing passed it until now;
 *  - **the create form validates before the round trip.** `docker create` succeeds and SQL Server then
 *    exits on a password its own policy rejects, so the Angular panel reported "created and started" for
 *    a container that was already dead.
 *
 * ── One overlay, and why the panel does not own it ──────────────────────────────────────────
 *
 * The Angular version was a `cdkConnectedOverlay` in the status bar with `(click)="$event.stopPropagation()"`
 * on the panel root — a manual outside-click protocol. This is `PopoverContent`, so Radix owns the
 * anchor, the collision handling, Escape, the focus trap and the return of focus, and `DockerPip` owns
 * the trigger. This component is only the contents.
 */

import { useState, type FormEvent } from 'react';
import { CircleStop, Container, HardDrive, Play, Plus, RefreshCw } from 'lucide-react';

import { dispatchCommand } from '../../commands';
import { Button, EmptyState, Icon, Input, Spinner, Tooltip, cn } from '../../ui';
import {
  validateContainerName,
  validateContainerPassword,
  validateContainerPort,
  type ContainerRow,
} from './docker-model';
import { useDocker, useDockerActions } from './use-docker';

/** The port the create form starts on. SQL Server's default, which is the only engine main can create. */
const DEFAULT_HOST_PORT = 1433;

export function DockerPanel() {
  const docker = useDocker();
  const actions = useDockerActions(docker.refresh);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex max-h-[60dvh] w-full flex-col" data-testid="docker-panel">
      <header className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
        <Icon icon={Container} size="sm" className="stroke-fg-muted" />
        <h2 className="grow text-md text-fg">Database containers</h2>
        <Tooltip content="Re-read Docker">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh"
            data-testid="docker-refresh"
            onClick={docker.refresh}
          >
            <Icon icon={RefreshCw} size="sm" className={cn(docker.loading && 'animate-spin')} />
          </Button>
        </Tooltip>
      </header>

      <div className="min-h-0 grow overflow-auto">
        <DockerBody
          docker={docker}
          busyId={actions.busyId}
          onStart={container => void actions.start(container)}
          onStop={container => void actions.stop(container)}
        />
      </div>

      {docker.pip.state === 'absent' || docker.pip.state === 'stopped' ? null : (
        <footer className="shrink-0 border-t border-rule">
          {creating ? (
            <CreateContainerForm
              taken={docker.rows}
              busy={actions.creating}
              onCancel={() => setCreating(false)}
              onSubmit={async values => {
                const ok = await actions.create(values);
                if (ok) setCreating(false);
                return ok;
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <p className="text-xs text-fg-subtle">SQL Server only — see the form for why.</p>
              <Button
                variant="outline"
                size="sm"
                data-testid="docker-new-container"
                onClick={() => setCreating(true)}
              >
                <Icon icon={Plus} size="sm" />
                New container
              </Button>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

function DockerBody({
  docker,
  busyId,
  onStart,
  onStop,
}: {
  readonly docker: ReturnType<typeof useDocker>;
  readonly busyId: string | null;
  readonly onStart: (container: ContainerRow) => void;
  readonly onStop: (container: ContainerRow) => void;
}) {
  if (docker.pip.state === 'checking') {
    return (
      <div className="flex items-center justify-center p-6" data-testid="docker-checking">
        <Spinner label="Checking Docker…" />
      </div>
    );
  }

  if (docker.pip.state === 'absent') {
    return (
      <EmptyState
        data-testid="docker-absent"
        icon={Container}
        size="sm"
        title="Docker is not available"
        description="Joinery could not reach the Docker socket. Install Docker Desktop, or start it."
      />
    );
  }

  if (docker.pip.state === 'stopped') {
    return (
      <EmptyState
        data-testid="docker-stopped"
        icon={Container}
        size="sm"
        title="Docker is not running"
        // Main's own sentence when it has one, rather than a second guess at what is wrong.
        description={docker.status?.error ?? 'Start Docker Desktop and press Refresh.'}
      />
    );
  }

  if (docker.rows.length === 0) {
    return (
      <EmptyState
        data-testid="docker-empty"
        icon={Container}
        size="sm"
        // Not "No SQL Server containers found": every engine Joinery speaks counts, and the Angular copy
        // was wrong on the machines it was most wrong for.
        title="No database containers"
        description="Docker is running, but none of its containers looks like SQL Server, PostgreSQL or MySQL."
      />
    );
  }

  return (
    <ul className="flex flex-col">
      {docker.rows.map(container => (
        <ContainerItem
          key={container.id}
          container={container}
          busy={busyId === container.id}
          onStart={onStart}
          onStop={onStop}
        />
      ))}
      {docker.volumes.length === 0 ? null : (
        // Rendered only when main answers with something: `docker.getVolumes()` lists the named
        // volumes the database containers mount, and a container that only bind-mounts contributes
        // none. A permanently empty section would be the decorative control J-44 forbids.
        <li className="border-t border-rule px-3 py-2" data-testid="docker-volumes">
          <h3 className="font-mono text-2xs tracking-eyebrow uppercase text-fg-subtle">Volumes</h3>
          <ul className="flex flex-col gap-0.5 pt-1">
            {docker.volumes.map(volume => (
              <li key={volume.name} className="truncate font-mono text-xs text-fg-muted">
                {volume.name}
              </li>
            ))}
          </ul>
        </li>
      )}
    </ul>
  );
}

function ContainerItem({
  container,
  busy,
  onStart,
  onStop,
}: {
  readonly container: ContainerRow;
  readonly busy: boolean;
  readonly onStart: (container: ContainerRow) => void;
  readonly onStop: (container: ContainerRow) => void;
}) {
  return (
    <li
      data-testid="docker-container"
      data-container-name={container.name}
      data-running={container.running}
      className="flex items-center gap-2 border-b border-rule px-3 py-2 last:border-b-0"
    >
      {/* Chartreuse for a running container, and nothing but a rule colour for a stopped one:
          HOUSE-RULES §5 caps chartreuse at two visible at once, and a pip is fill-on-dark-canvas. */}
      <span
        aria-hidden
        data-testid="docker-container-pip"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          container.running ? 'bg-success' : 'bg-rule-strong'
        )}
      />
      <div className="flex min-w-0 grow flex-col">
        <span className="truncate text-base text-fg">{container.name}</span>
        <span className="truncate font-mono text-xs text-fg-subtle">
          {container.label}
          {container.hostPort === null ? ' · no published port' : ` · :${container.hostPort}`}
          {container.containerPort === null ? '' : ` → ${container.containerPort}`}
        </span>
        <span className="truncate text-xs text-fg-subtle">{container.status}</span>
        {container.binds.length === 0 ? null : (
          <ul className="flex flex-col pt-0.5" data-testid="docker-container-binds">
            {container.binds.map(bind => (
              <li
                key={`${bind.hostPath}:${bind.containerPath}`}
                className="flex items-center gap-1 truncate font-mono text-2xs text-fg-subtle"
              >
                <Icon icon={HardDrive} size="sm" className="stroke-fg-subtle" />
                <span className="truncate">
                  {bind.hostPath} → {bind.containerPath}
                  {bind.mode === 'ro' ? ' (read-only)' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {container.running ? (
          <>
            <Tooltip content="Stop">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Stop ${container.name}`}
                data-testid="docker-stop"
                disabled={busy}
                onClick={() => onStop(container)}
              >
                {/* `CircleStop`, not `Square`: lucide's square is an outline, and beside a Connect
                    button it reads as an unchecked checkbox — which is what the first pass of the both-
                    theme gate showed. */}
                {busy ? <Spinner size="sm" /> : <Icon icon={CircleStop} size="sm" />}
              </Button>
            </Tooltip>
            <Tooltip
              content={
                container.hostPort === null
                  ? 'This container publishes no port, so nothing can connect to it'
                  : 'Open the connection editor with this container’s host and port'
              }
            >
              <Button
                variant="outline"
                size="sm"
                data-testid="docker-connect"
                disabled={container.hostPort === null}
                onClick={() =>
                  container.hostPort === null
                    ? undefined
                    : dispatchCommand('connect-to-container', {
                        server: 'localhost',
                        port: container.hostPort,
                      })
                }
              >
                Connect
              </Button>
            </Tooltip>
          </>
        ) : (
          <Tooltip content="Start">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Start ${container.name}`}
              data-testid="docker-start"
              disabled={busy}
              onClick={() => onStart(container)}
            >
              {busy ? <Spinner size="sm" /> : <Icon icon={Play} size="sm" />}
            </Button>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * The create form.
 *
 * SQL Server only, and it says so rather than offering an image field: main's `createContainer` sets
 * `ACCEPT_EULA=Y` and `MSSQL_SA_PASSWORD` and publishes 1433 whatever image it is handed
 * (`services/docker/detector.ts:198-213`), so an image picker would be a control that produces broken
 * containers. The EULA is stated in words above the button that accepts it — the Angular panel sent
 * `acceptEula: true` with nothing on screen saying so.
 */
function CreateContainerForm({
  taken,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly taken: readonly ContainerRow[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (values: {
    readonly name: string;
    readonly password: string;
    readonly port: number;
  }) => Promise<boolean>;
}) {
  const [name, setName] = useState('joinery-mssql');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState(String(DEFAULT_HOST_PORT));
  const [attempted, setAttempted] = useState(false);

  const parsedPort = Number(port);
  const nameProblem = validateContainerName(
    name,
    taken.map(container => container.name)
  );
  const passwordProblem = validateContainerPassword(password);
  const portProblem = validateContainerPort(
    parsedPort,
    taken.map(container => container.hostPort)
  );
  const problem = nameProblem ?? passwordProblem ?? portProblem;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (problem !== null || busy) return;
    void onSubmit({ name: name.trim(), password, port: parsedPort }).then(() => {
      // The password is dropped as soon as it has been sent, whether or not it worked: it is a secret
      // and this component outlives the submit — a refused create leaves the form mounted, so the
      // failure path is the one that matters most here.
      setPassword('');
    });
  };

  /**
   * Whether a field's problem is on screen yet: once the user has typed something into it, or once they
   * have tried to submit. Per field, not one flag for the form — an untouched field must not be scolded,
   * and a field the user has filled in wrongly must not wait for a submit that the disabled button will
   * never allow. The same rule `features/databases/database-name-dialog.tsx` uses.
   */
  const showFor = (value: string): boolean => attempted || value.trim() !== '';

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 p-3" data-testid="docker-create-form">
      <fieldset disabled={busy} className="flex flex-col gap-2">
        <Input
          name="docker-container-name"
          label="Container name"
          data-testid="docker-create-name"
          value={name}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          error={showFor(name) && nameProblem !== null ? nameProblem : undefined}
          onChange={event => setName(event.target.value)}
        />
        <Input
          name="docker-container-password"
          type="password"
          label="SA password"
          data-testid="docker-create-password"
          value={password}
          autoComplete="new-password"
          error={showFor(password) && passwordProblem !== null ? passwordProblem : undefined}
          hint={
            showFor(password) && passwordProblem !== null
              ? undefined
              : 'Eight characters and three of: upper, lower, digit, symbol.'
          }
          onChange={event => setPassword(event.target.value)}
        />
        <Input
          name="docker-container-port"
          label="Host port"
          inputMode="numeric"
          data-testid="docker-create-port"
          value={port}
          className="font-mono tabular-nums"
          error={showFor(port) && portProblem !== null ? portProblem : undefined}
          onChange={event => setPort(event.target.value)}
        />
      </fieldset>

      <p className="text-xs text-fg-subtle text-pretty">
        Creating this container accepts the Microsoft SQL Server EULA and pulls
        <span className="font-mono"> mcr.microsoft.com/mssql/server:2022-latest</span> if it is not
        already present.
      </p>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="docker-create-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
        {/* The one filled oxide affordance in this popover — HOUSE-RULES §5. */}
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={busy || problem !== null}
          data-testid="docker-create-submit"
        >
          {busy ? <Spinner size="sm" /> : null}
          {busy ? 'Creating…' : 'Create and start'}
        </Button>
      </div>
    </form>
  );
}
