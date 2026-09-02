---
title: Docker is not detected
description: What Joinery's container detection actually asks Docker, why it can answer "not running" on a machine where Docker is running, and what to check.
sidebar:
  order: 1
---

Docker is optional in Joinery — it is a convenience for local databases, and nothing else in the
app depends on it. When it does not work, the symptom is always one of five states on the
status-bar pip, and each one means something different.

## Read the pip first

The container glyph in the status bar carries the whole answer in its tooltip. Click it to open
the panel, which says the same thing in a sentence.

| Pip / panel says                             | What it means                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| _Checking Docker…_                           | The first probe has not come back yet                                     |
| _Docker is not available_                    | The call to Docker **failed outright**                                    |
| _Docker is not running_ (or Docker's reason) | Joinery asked, and the daemon did not answer its ping                     |
| _Docker is running — no database containers_ | The daemon answered; nothing it holds looks like one of the three engines |
| _Docker: 1 of 2 database containers running_ | Working normally                                                          |

The two failure states are not interchangeable. **Docker is not available** means the request
itself rejected. **Docker is not running** means Joinery got an answer and the answer was no —
and in that case the panel shows Docker's own sentence, usually _Docker is not running. Please
start Docker Desktop._

## Joinery talks to one fixed socket

Detection connects to the Unix socket `/var/run/docker.sock` and pings the daemon there. That
path is **fixed in the source**: Joinery does not read `DOCKER_HOST`, and there is no setting for
it. If your engine is not reachable at that exact path, detection cannot succeed no matter what
`docker ps` does in your terminal.

That is the single most common cause, and it has three shapes:

- **Docker Desktop on macOS with the default socket turned off.** Docker Desktop's
  _Advanced_ settings have an option to allow the default Docker socket; with it off, the socket
  lives under your home directory instead and `/var/run/docker.sock` does not exist.
- **A different runtime.** Colima, OrbStack, Rancher Desktop and podman each publish their own
  socket path. Symlinking yours to `/var/run/docker.sock` is what makes Joinery see them.
- **Windows.** Docker Desktop for Windows exposes the engine as a named pipe, not as a Unix
  socket at that path, so the probe cannot succeed. The pip stays on _Docker is not running_.
  Everything else in Joinery is unaffected — this is the containers panel only.

> **Note** — a terminal that can run `docker ps` proves the CLI found the engine, not that
> Joinery can. The CLI reads `DOCKER_HOST` and your Docker context; Joinery does not.

## Docker is running, but the list is empty

Joinery decides what counts as a database container from the **image name** alone, and only three
sets of names qualify:

| Engine     | Image name contains                    |
| ---------- | -------------------------------------- |
| SQL Server | `mssql`, `sqlserver`, `azure-sql-edge` |
| PostgreSQL | `postgres`, `postgresql`, `postgis`    |
| MySQL      | `mysql`, `mariadb`                     |

A container built from a renamed or private image — `mycompany/db:latest` — is not listed, even
though it is running Postgres inside. Nothing about the container other than its image name is
inspected. Stopped containers **are** listed, so an empty list is not about state.

## The list is stale

Joinery re-reads Docker every 30 seconds, and the pip, the panel and the welcome tab all read the
same answer, so they cannot disagree with each other. The panel's **Refresh** button re-reads
immediately — use it after starting something outside the app rather than waiting out the
interval.

## Specific things that look like bugs

**Connect is disabled on a running container.** The container publishes no host port, and the row
says so: _This container publishes no port, so nothing can connect to it._ Nothing can reach it
from your machine, so there is nothing for Joinery to fill the form in with.

**A stop appears to do nothing, then reports a failure.** Docker's stop reports success whether
or not the container actually stopped, so Joinery re-reads the container afterwards and tells you
_… is still running — Docker refused to stop it_ when it did not. That message is a real result,
not a display glitch — the container is still up. This is tracked as J-71.

**There is no Volumes section.** It is drawn only when at least one of the listed database
containers mounts a **named** Docker volume, so it is absent when they all use **bind mounts**
only — those are listed per container instead, as `host path → container path`. A named volume
that some other container mounts, or that nothing mounts at all, is not listed either: the section
is scoped to the database containers the panel is already showing.

**New container only offers SQL Server.** That is deliberate, and the panel says so above the
button. The create path sets `ACCEPT_EULA` and `MSSQL_SA_PASSWORD` and publishes container port
1433 whatever image it is given, so an image picker would produce containers that cannot start.
Create PostgreSQL and MySQL containers with `docker run`; Joinery will list them the moment they
exist.

## If none of that helps

Open the output panel with **⌘J**. Detection failures are logged there with the underlying error,
and the panel's toolbar can reveal the log file on disk to attach to a
[bug report](https://github.com/cadam11/joinery/issues).

The containers panel is documented in full under
[Docker containers](../../features/docker-containers/).

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                                | Source                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Docker is reached at the hard-coded socket path `/var/run/docker.sock`               | `packages/main/src/services/docker/detector.ts:22`                                                   |
| Nothing reads `DOCKER_HOST` or configures the socket path                            | `packages/main/src/services/docker/detector.ts:20-23` (the only `Dockerode` construction in the app) |
| "Running" is decided by `docker.ping()`                                              | `packages/main/src/services/docker/detector.ts:28-35, 42-50`                                         |
| Docker's own sentence when the daemon is down                                        | `packages/main/src/services/docker/detector.ts:45-49`                                                |
| The five pip states and their exact tooltips                                         | `packages/renderer/src/features/docker/docker-model.ts:132-172`                                      |
| `absent` is a rejected call; `stopped` is a successful "no"                          | `packages/renderer/src/features/docker/docker-model.ts:123-154`, `use-docker.ts:81-92`               |
| The panel's four states and their copy                                               | `packages/renderer/src/features/docker/docker-panel.tsx:119-165`                                     |
| The engine is decided from the image name, per engine                                | `packages/main/src/services/docker/detector.ts:56-67`, `docker-model.ts:57-65`                       |
| Stopped containers are listed too (`listContainers({ all: true })`)                  | `packages/main/src/services/docker/detector.ts:52`                                                   |
| Docker is re-read every 30 seconds, from one shared query                            | `packages/renderer/src/features/docker/use-docker.ts:26, 51-78`                                      |
| Refresh re-reads immediately                                                         | `packages/renderer/src/features/docker/docker-panel.tsx:53-63`, `use-docker.ts:76-78`                |
| Connect is disabled with that sentence when no port is published                     | `packages/renderer/src/features/docker/docker-panel.tsx:265-284`                                     |
| The stop handler discards its failure result, so the renderer confirms by re-reading | `packages/main/src/ipc/docker.ipc.ts:52-58`, `docker-model.ts:174-188`, `use-docker.ts:150-166`      |
| J-71 — the stop-reports-success finding                                              | `packages/renderer/src/features/docker/docker-model.ts:26-29`                                        |
| Named volumes come from `listVolumes`, filtered to the database containers' mounts   | `packages/main/src/services/docker/detector.ts`, `docker.ipc.ts` (`GET_VOLUMES`)                     |
| Create is SQL Server only, and why an image picker would be wrong                    | `packages/main/src/services/docker/detector.ts:198-213`, `docker-panel.tsx:90-99`                    |
| ⌘J toggles the output panel, which can reveal its log file                           | `packages/renderer/src/commands/catalogue.ts:559-566`, `shell/workspace/output-panel.tsx:207-217`    |

</details>
