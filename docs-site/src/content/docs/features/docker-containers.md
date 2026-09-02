---
title: Docker containers
description: The status-bar pip and its panel — what Joinery detects, starting and stopping containers, connecting to one, and creating a SQL Server container.
sidebar:
  order: 14
---

Joinery watches Docker for containers running one of the three engines it speaks, and gives you a
panel to start, stop, connect to and create them. Docker is entirely optional — nothing else in the
app depends on it.

## The pip

The status bar carries a container glyph. Its colour is the whole state, and its tooltip is the
sentence:

| State                        | Tooltip                                         |
| ---------------------------- | ----------------------------------------------- |
| Still asking                 | _Checking Docker…_                              |
| Docker cannot be reached     | _Docker is not available_                       |
| Docker is installed but down | Docker's own reason, or _Docker is not running_ |
| Running, no containers       | _Docker is running — no database containers_    |
| Running, with containers     | _Docker: 1 of 2 database containers running_    |

A count sits beside the glyph **only when at least one container is up** — a grey glyph with a `0`
next to it says nothing the glyph did not.

Clicking the pip opens the panel; so does ⌘K ▸ **Docker containers**, which opens it rather than
toggling it. Escape closes it.

Joinery re-reads Docker every **30 seconds**, and the pip, the panel and the welcome tab's Docker
line all read the same answer — they cannot disagree with each other.

## What counts as a database container

The engine is decided from the **image name**, not from anything Docker says about the container:

| Engine     | Image contains                         | Port inside the container |
| ---------- | -------------------------------------- | ------------------------- |
| SQL Server | `mssql`, `sqlserver`, `azure-sql-edge` | 1433                      |
| PostgreSQL | `postgres`, `postgis`                  | 5432                      |
| MySQL      | `mysql`, `mariadb`                     | 3306                      |

Anything else is not listed. All three engines count equally — the panel is not SQL Server-only.

## The panel

**Database containers**, with a **Refresh** button that re-reads Docker immediately.

Each row carries the container's name, its engine, `:<host port> → <container port>` (or _no
published port_), and **Docker's own status line** verbatim — _Up 3 hours_, _Exited (0) 2 days ago_.
A filled pip marks a running container. Running containers are listed first, then alphabetically.

Any **bind mounts** the container has are listed under it as `host path → container path`, with
`(read-only)` where that applies.

Under the list, a **Volumes** section names the **named Docker volumes** those database containers
mount — the ones `docker volume ls` shows. Only those: a volume mounted by some other container, or
by nothing at all, is not listed, and the section is absent entirely when the database containers
only bind-mount.

### Starting, stopping, connecting

A stopped container gets a **Start** button. A running one gets **Stop** and **Connect**.

**Connect** opens the connection editor with `localhost` and the container's published port already
filled in — you still choose the engine, the credentials and the name. It is disabled on a container
that publishes no port, and says so: _This container publishes no port, so nothing can connect to
it._

If Docker refuses either action, Joinery reports **Docker's own reason** — _Could not stop
joinery-postgres: cannot stop container: permission denied_, for example — rather than a generic
failure. A container that had already stopped by the time you pressed **Stop** is not a failure and
is not reported as one. Either way the container list is re-read afterwards, so the row shows what
actually happened.

### Creating one

**New container** opens a short form, and it is **SQL Server only**. The panel says so above the
button. Joinery's create path sets `ACCEPT_EULA=Y` and `MSSQL_SA_PASSWORD` and publishes container port 1433
whatever image it is handed, so there is no image picker — one would produce containers that do not
work.

Three fields:

| Field              | Rule                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container name** | Letters, numbers, dots, dashes and underscores, starting with a letter or number, and not a name already in use. Defaults to `joinery-mssql`. |
| **SA password**    | At least 8 characters, and three of: an upper-case letter, a lower-case letter, a digit, a symbol.                                            |
| **Host port**      | 1024–65535, and not a port another container already publishes. Defaults to 1433.                                                             |

The password rule is SQL Server's own, and it is checked **before** the round trip on purpose:
`docker create` succeeds on a password SQL Server rejects, and the container then exits immediately —
so the honest place to catch it is the form.

Above the button, in words: creating the container **accepts the Microsoft SQL Server EULA** and pulls
`mcr.microsoft.com/mssql/server:2022-latest` if it is not already present.

The password is cleared from the form as soon as it has been sent — on success and on failure alike.
A refused create leaves the form open so you can fix the name, but not the secret you typed into it.

## When Docker is not there

| The panel shows           | Meaning                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| _Docker is not available_ | Joinery could not reach the Docker socket. Install Docker Desktop, or start it. |
| _Docker is not running_   | Docker's own reason, or _Start Docker Desktop and press Refresh._               |
| _No database containers_  | Docker is running, but nothing it holds looks like one of the three engines.    |

In either of the first two states the **New container** footer is hidden — there is nothing to create
it with.

If Docker is running for you and Joinery says otherwise,
[Docker is not detected](../../troubleshooting/docker-not-detected/) explains what the app asks
Docker and why the answer can differ from your terminal's.

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                  | Source                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The pip lives in the status bar and anchors the panel                  | `packages/renderer/src/shell/status-bar.tsx:410-414`, `features/docker/docker-pip.tsx:57-102`                         |
| The five pip states and their exact tooltips                           | `packages/renderer/src/features/docker/docker-model.ts:112-173`                                                       |
| The colour per state, with no brand colours                            | `packages/renderer/src/features/docker/docker-pip.tsx:34-41`                                                          |
| The count renders only above zero                                      | `packages/renderer/src/features/docker/docker-pip.tsx:67-73`                                                          |
| ⌘K ▸ "Docker containers" opens rather than toggles                     | `packages/renderer/src/commands/catalogue.ts:657-665`, `docker-pip.tsx:53-55`                                         |
| Escape closes the popover                                              | `packages/renderer/src/ui/popover.tsx:12-50, 127-134`                                                                 |
| Docker is polled every 30 seconds                                      | `packages/renderer/src/features/docker/use-docker.ts:26, 51-71`                                                       |
| The pip, panel and welcome tab share one query                         | `packages/renderer/src/features/docker/use-docker.ts:1-16`, `features/welcome/welcome-panel.tsx:282-295`              |
| The engine is derived from the image name, per engine                  | `packages/renderer/src/features/docker/docker-model.ts:57-66`                                                         |
| The port inside the container is derived from the engine, not believed | `packages/renderer/src/features/docker/docker-model.ts:16-20, 38-44`                                                  |
| All three engines are listed, not SQL Server only                      | `packages/renderer/src/features/docker/docker-panel.tsx:6-9, 151-161`                                                 |
| The panel's heading and its Refresh                                    | `packages/renderer/src/features/docker/docker-panel.tsx:50-66`                                                        |
| A row's name, engine, port pair and Docker status line                 | `packages/renderer/src/features/docker/docker-panel.tsx:215-227`                                                      |
| The status string is shown verbatim and never matched on               | `packages/renderer/src/features/docker/docker-model.ts:75-77, 93-96`                                                  |
| Running containers sort first, then alphabetically                     | `packages/renderer/src/features/docker/docker-model.ts:103-110`                                                       |
| Bind mounts are listed, with a read-only marker                        | `packages/renderer/src/features/docker/docker-panel.tsx:228-244`                                                      |
| Named volumes are listed, filtered to the database containers' mounts  | `packages/main/src/services/docker/detector.ts` (`listVolumes`), `docker-panel.tsx:177-190`                           |
| Start, Stop and Connect, and which appears when                        | `packages/renderer/src/features/docker/docker-panel.tsx:246-305`                                                      |
| Connect pre-fills the connection editor with localhost and the port    | `packages/renderer/src/features/docker/docker-panel.tsx:259-289`, `features/connections/connection-dialogs.tsx:94-96` |
| It is disabled with a stated reason when no port is published          | `packages/renderer/src/features/docker/docker-panel.tsx:265-284`                                                      |
| A refused start or stop carries Docker's own reason                    | `packages/main/src/ipc/docker.ipc.ts:41-61`, `packages/renderer/src/features/docker/use-docker.ts:124-152`            |
| A container that had already stopped is not reported as a failure      | `packages/main/src/services/docker/detector.ts:155-182, 294-302`                                                      |
| The container list is re-read after either action                      | `packages/renderer/src/features/docker/use-docker.ts:132-134, 147-149`                                                |
| The create call sets ACCEPT_EULA, MSSQL_SA_PASSWORD and binds 1433     | `packages/main/src/services/docker/detector.ts:213-227`                                                               |
| The create form is SQL Server only, and the panel says so              | `packages/renderer/src/features/docker/docker-panel.tsx:90-99, 311-318`                                               |
| The three fields, their defaults and their rules                       | `packages/renderer/src/features/docker/docker-panel.tsx:41, 335-337`, `docker-model.ts:185-218`                       |
| Why the password is checked before the round trip                      | `packages/renderer/src/features/docker/docker-model.ts:175-184`                                                       |
| The EULA sentence and the image it pulls                               | `packages/renderer/src/features/docker/docker-panel.tsx:413-417`                                                      |
| The password is cleared on success and on failure alike                | `packages/renderer/src/features/docker/docker-panel.tsx:356-361`                                                      |
| The three empty states and their copy                                  | `packages/renderer/src/features/docker/docker-panel.tsx:117-160`                                                      |
| The New container footer is hidden when Docker is absent or stopped    | `packages/renderer/src/features/docker/docker-panel.tsx:74-103`                                                       |

</details>
