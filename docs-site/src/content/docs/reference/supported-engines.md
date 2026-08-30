---
title: Supported engines and versions
description: The three engines and two variants Joinery connects to, what is continuously tested, and what each engine can and cannot do inside the app.
sidebar:
  order: 4
---

Joinery speaks to three engines through one abstraction: a **dialect** per engine generates the SQL,
and a **pool** per engine owns the connection. Everything above that — the explorer, the grid, the
diagram, the assistant — is written once.

## Versions

| Engine         | Supported             | Also                                                                       |
| -------------- | --------------------- | -------------------------------------------------------------------------- |
| **SQL Server** | 2017 and later        | Azure SQL Database                                                         |
| **PostgreSQL** | 12 and later          | Aurora DSQL, a PostgreSQL 16-compatible variant with its own rules (below) |
| **MySQL**      | 5.7 and 8.0 and later | MariaDB images are detected as MySQL containers                            |

[Prerequisites](../../getting-started/prerequisites/) is where the host-side setup lives — the
operating systems, and the command-line tools PostgreSQL and MySQL backups shell out to.

## What is continuously tested

The automated harness runs against `mcr.microsoft.com/mssql/server:2022-latest`, `postgres:16-alpine`
and `mysql:8`, plus a second PostgreSQL on a private network reached through an OpenSSH bastion for
the tunnel tests. Those are the versions Joinery is exercised on every run; the ranges above are what
the SQL it generates targets.

## Connection defaults

| Engine     | Default port | Editor language | Batch separator | Authentication modes                                                  |
| ---------- | ------------ | --------------- | --------------- | --------------------------------------------------------------------- |
| SQL Server | 1433         | `sql`           | `GO`            | SQL Server Authentication, Windows Authentication, Microsoft Entra ID |
| PostgreSQL | 5432         | `pgsql`         | none            | Password Authentication, AWS IAM (Aurora DSQL)                        |
| MySQL      | 3306         | `mysql`         | none            | Password Authentication                                               |

An **SSH tunnel** is a property of the connection profile rather than of the engine: any of the three
can be reached through one, and the pool is opened against the tunnel's local endpoint. See
[Connect over an SSH tunnel](../../getting-started/connect-ssh/).

## What each engine can do

| Capability                        | SQL Server                                           | PostgreSQL              | MySQL                 |
| --------------------------------- | ---------------------------------------------------- | ----------------------- | --------------------- |
| Backup and restore                | T-SQL `BACKUP` / `RESTORE`                           | `pg_dump`/`pg_restore`  | `mysqldump`/`mysql`   |
| Browse the server's filesystem    | Yes — on Windows and Linux hosts alike               | No                      | No                    |
| Execution plans                   | `SET STATISTICS PROFILE ON` — **runs the statement** | `EXPLAIN (FORMAT JSON)` | `EXPLAIN FORMAT=JSON` |
| Object comments                   | Extended properties                                  | `COMMENT ON`            | DDL comments          |
| Windows authentication            | Yes                                                  | No                      | No                    |
| Create, rename and drop databases | Yes                                                  | Yes                     | Yes                   |

[SQL dialect conversion](../../features/sql-dialect-conversion/) is the one feature that does not
belong to this table: it rewrites the text in the editor and takes all three engines as targets, no
matter what you are connected to.

Two rows above are worth reading twice.

**Backup and restore is not the same feature three times.** SQL Server's runs as a statement on the
server, so nothing needs installing and the backup lands on the server's disk — which is why browsing
the server's filesystem exists at all, and why it exists only there. PostgreSQL and MySQL shell out
to their own client tools on **your** machine; if those are not installed, the dialogs say so and
show the install commands rather than failing at spawn time.

**An execution plan on SQL Server runs your statement.** `SET SHOWPLAN` cannot share a batch with the
query it explains, so Joinery asks for an actual plan — real row counts, at the cost of executing —
and confirms with you before it does. PostgreSQL and MySQL are asked with `EXPLAIN`, which estimates
without running. An estimate-only SQL Server plan is tracked as J-68.

## Connection pooling

| Engine     | Pools                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| SQL Server | One pool per profile, with `USE [database]` prepended per query. On Azure SQL, one pool per database — Azure rejects `USE` outright |
| PostgreSQL | One pool per database, because PostgreSQL fixes the database at connection time                                                     |
| MySQL      | Two pools per database, each opened on first use — see below                                                                        |

All pools for a profile share that profile's SSH tunnel, and are invalidated together if the tunnel
goes away.

**MySQL has two pools per database because a MySQL connection decides once, when it opens, whether
it will accept more than one statement at a time.** The query editor needs a connection that does —
running `SELECT …; UPDATE …;` as one script is the point of the editor. Schema browsing and
everything the AI assistant runs never send two statements, so they go on a second connection that
never asked for the capability: if a table name ever smuggled a `;` into one of those queries, the
MySQL server rejects it as a syntax error instead of running whatever followed. You do not configure
this and it is not visible in the app; the only trace is that a MySQL database you both browse and
query holds two sets of connections.

## Aurora DSQL

Aurora DSQL is PostgreSQL-compatible, and Joinery treats it as a PostgreSQL variant rather than a
fourth engine: the same dialect, with the queries that touch surfaces DSQL does not have overridden.
What it changes:

| In Joinery                      | On Aurora DSQL                                                      |
| ------------------------------- | ------------------------------------------------------------------- |
| Databases in the explorer       | One. A cluster hosts a single database, and it cannot be enumerated |
| Create, rename, drop a database | Not offered — the statements do not exist there                     |
| Stored procedures and triggers  | Not offered                                                         |
| Backup and restore              | Not offered                                                         |
| Authentication                  | AWS IAM, from a named AWS credentials profile                       |

## Docker containers

When Docker Desktop is running, Joinery lists local containers whose image name looks like a
database and offers to start, stop or connect to them. The matching is by image-name substring, and
it covers all three engines — see [Docker containers](../../features/docker-containers/).

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                               | Source                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| One dialect per engine generates the SQL; one pool per engine owns the connection   | `packages/main/src/services/sql/dialect/sql-dialect.ts:28-86`, `services/sql/connection-pool.ts:1-6`                                             |
| SQL Server 2017+ incl. Azure SQL; PostgreSQL 12+; MySQL 5.7+/8.0+                   | `README.md:47-49, 196-198`                                                                                                                       |
| MariaDB images are detected as MySQL containers                                     | `packages/main/src/services/docker/detector.ts:56-67`                                                                                            |
| Harness images, plus the private PG and the OpenSSH bastion                         | `tests/docker-compose.test.yml:13, 32, 48, 66, 83`                                                                                               |
| Default ports 1433 / 5432 / 3306                                                    | `packages/main/src/services/sql/dialect/mssql-dialect.ts:20`, `pg-dialect.ts:18`, `mysql-dialect.ts:18`                                          |
| Editor languages `sql`, `pgsql`, `mysql`                                            | `packages/main/src/services/sql/dialect/mssql-dialect.ts:21`, `pg-dialect.ts:19`, `mysql-dialect.ts:19`                                          |
| `GO` is a batch separator on SQL Server only                                        | `packages/main/src/services/sql/dialect/mssql-dialect.ts:22`, `pg-dialect.ts:20`, `mysql-dialect.ts:20`                                          |
| The authentication modes offered per engine                                         | `packages/renderer/src/features/connections/form-model.ts:82-96`                                                                                 |
| An SSH tunnel belongs to the profile and is opened before any pool                  | `packages/main/src/services/sql/connection-pool.ts:143-158, 202-203`                                                                             |
| Backup by T-SQL on SQL Server; by CLI tooling on PostgreSQL and MySQL               | `packages/main/src/services/sql/dialect/mssql-dialect.ts:24`, `pg-dialect.ts:22`, `mysql-dialect.ts:22`, `services/sql/cli-deps.ts:32-35`        |
| Server-side file browsing is a SQL Server capability flag, and its service is T-SQL | `packages/main/src/services/sql/dialect/mssql-dialect.ts:27`, `pg-dialect.ts:25`, `mysql-dialect.ts:25`, `services/sql/server-filesystem.ts:1-4` |
| The three EXPLAIN strategies, and that only SQL Server's runs the statement         | `packages/renderer/src/features/query/execution-plan.ts:9-33`                                                                                    |
| The SQL Server plan is confirmed with the user first; estimate-only is J-68         | `packages/renderer/src/features/query/execution-plan.ts:26-33`                                                                                   |
| Object comments: extended properties, `COMMENT ON`, DDL comments                    | `packages/main/src/services/sql/dialect/mssql-dialect.ts:25-26`, `pg-dialect.ts:23-24`, `mysql-dialect.ts:23-24`                                 |
| Windows authentication is a SQL Server capability flag                              | `packages/main/src/services/sql/dialect/mssql-dialect.ts:23`, `pg-dialect.ts:21`, `mysql-dialect.ts:21`                                          |
| Conversion targets SQL Server, PostgreSQL and MySQL                                 | `packages/renderer/src/commands/catalogue.ts:361-388`, `packages/main/src/services/sql/sql-converter.ts`                                         |
| MSSQL pools by profile with `USE [db]` prepended, and by database on Azure          | `packages/main/src/services/sql/connection-pool.ts:906-930`                                                                                      |
| PostgreSQL pools per database, sharing one tunnel                                   | `packages/main/src/services/sql/connection-pool.ts:586-600`                                                                                      |
| MySQL pools per database, two per database split by trust level                     | `packages/main/src/services/sql/connection-pool.ts:719-745`, `services/sql/mysql-pool-options.ts:1-67`                                           |
| Aurora DSQL is a PostgreSQL 16-compatible variant, overriding only what it must     | `packages/main/src/services/sql/dialect/pg-dsql-dialect.ts:1-24`                                                                                 |
| DSQL: one database, no database management, no procedures, no triggers, no backup   | `packages/main/src/services/sql/dialect/pg-dsql-dialect.ts:26-50`                                                                                |
| DSQL authenticates with AWS IAM from a named profile                                | `packages/renderer/src/features/connections/form-model.ts:93`, `packages/shared/src/types/connection.types.ts:88`                                |
| Container images are matched by image-name substring                                | `packages/main/src/services/docker/detector.ts:56-67`                                                                                            |

</details>
