---
title: Connect to MySQL
description: The connection editor's fields for MySQL, the collation picker, TLS, and per-database pooling.
sidebar:
  order: 6
---

Open the connection editor, then set **Database engine** to _MySQL_. Switching the engine moves
the port to 3306 and, if the username is still blank or still another engine's convention, sets
it to `root`.

## The fields

![The connection editor filled in for a MySQL server — the engine set to MySQL, a non-default port (13306, from the docs' test harness), a username, and no authentication-type picker.](../../../assets/screenshots/connect-mysql-dark.png)

| Field                        | Default                      | Notes                                                                         |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Connection name              | —                            | Required to save; not required to test                                        |
| Server                       | —                            | A pasted `host:port` is split across Server and Port when you leave the field |
| Port                         | 3306                         |                                                                               |
| Authentication type          | Password Authentication      | The only mode MySQL offers, so the picker is hidden                           |
| Username                     | `root`                       |                                                                               |
| Password                     | —                            | Goes to the system keychain, never to a file                                  |
| Colour tag                   | none                         |                                                                               |
| Encrypt the connection       | on                           |                                                                               |
| Trust the server certificate | on                           |                                                                               |
| Timeout (seconds)            | 30                           |                                                                               |
| Default database             | blank → no database selected | The greyed `mysql` in the field is a placeholder, not a value — see below     |
| Collation                    | Server default               | MySQL only — see below                                                        |
| SSH tunnel                   | off                          | See [Connect over an SSH tunnel](../connect-ssh/)                             |

Because MySQL offers exactly one authentication mode, the **Authentication type** picker is not
rendered at all — unless a profile saved earlier holds a mode MySQL does not offer, in which
case the picker appears so you have something to correct.

## Collation

MySQL is the one engine with a **Collation** field. It sets the connection's character set, and
the field's own hint explains why you would touch it: _match your server's collation to avoid
"Illegal mix of collations" errors_.

| Option               |                                  |
| -------------------- | -------------------------------- |
| Server default       | Send nothing; the server decides |
| `utf8mb4_0900_ai_ci` | MySQL 8.0 and later              |
| `utf8mb4_unicode_ci` |                                  |
| `utf8mb4_general_ci` |                                  |
| `utf8mb4_bin`        |                                  |
| `utf8_general_ci`    | Legacy                           |

## TLS

The two checkboxes map onto `mysql2`'s `ssl` option:

| Encrypt | Trust the server certificate | Result                                                   |
| ------- | ---------------------------- | -------------------------------------------------------- |
| off     | —                            | No `ssl` option is sent                                  |
| on      | on                           | TLS, certificate **not** verified                        |
| on      | off                          | TLS, certificate verified against the system trust store |

## Default database, and what blank actually means

The greyed `mysql` in the **Default database** field is placeholder text, not a value. Leaving
the field blank sends **no database at all** to the driver, so the connection opens with no
database selected and an unqualified `SELECT … FROM users` fails with "No database selected"
until you pick one in the explorer or write `USE`.

This is where MySQL differs from the other two engines. PostgreSQL falls back to the `postgres`
database when the field is blank; MySQL has no such fallback, and its pool is keyed as
`<profile>:__default__` to record exactly that — "this pool has no database", not "this pool is
on `mysql`".

If you want a database selected from the moment you connect, type it into the field.

## One pool per database

Like PostgreSQL, MySQL connections are pooled per database rather than per server: the pool key
is the profile plus the database name, so the explorer's database switcher opens a second pool
rather than repointing the first. Every pool belonging to one profile shares that profile's SSH
tunnel, if it has one, and all of them are discarded together if the tunnel dies.

## MariaDB

Joinery has no separate MariaDB engine. A MariaDB container is detected as a MySQL container,
and MariaDB servers are reached with the MySQL engine and the `mysql2` driver.

<details>
<summary>Where this page's facts come from</summary>

| Claim                                                                                            | Source                                                                                              |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Default port 3306                                                                                | `packages/shared/src/types/connection.types.ts:10-14`                                               |
| Switching engine sets the port and the conventional username `root`                              | `packages/renderer/src/features/connections/form-model.ts:108-113, 289-310`                         |
| MySQL offers only Password Authentication                                                        | `packages/renderer/src/features/connections/form-model.ts:95`                                       |
| The picker is hidden unless the engine offers a choice, or the stored mode is invalid for it     | `packages/renderer/src/features/connections/connection-editor.tsx:313-317`                          |
| `mysql` is placeholder text only, never submitted                                                | `packages/renderer/src/features/connections/form-model.ts:98-106`, `connection-editor.tsx:451-453`  |
| A blank Default database sends `database: undefined` to the driver                               | `packages/main/src/services/sql/connection-pool.ts:736`, `mysql-pool-options.ts:56`                 |
| The no-database pool is keyed `<profileId>:__default__`, unlike PostgreSQL's `postgres` fallback | `packages/main/src/services/sql/connection-pool.ts:725-726` vs `:598-599`                           |
| The collation options, and the "Illegal mix of collations" hint                                  | `packages/renderer/src/features/connections/form-model.ts:116-123`, `connection-editor.tsx:465-479` |
| Collation is sent as the connection's `charset`; blank sends nothing                             | `packages/main/src/services/sql/mysql-pool-options.ts:57`                                           |
| `ssl: encrypt ? { rejectUnauthorized: !trustServerCertificate } : undefined`                     | `packages/main/src/services/sql/mysql-pool-options.ts:58`                                           |
| Encrypt on / trust cert on are the shipped defaults                                              | `packages/renderer/src/features/connections/form-model.ts:152-153`                                  |
| MySQL pools are keyed per database and share the profile's tunnel                                | `packages/main/src/services/sql/connection-pool.ts:117, 194-246`                                    |
| MariaDB images are classified as MySQL                                                           | `packages/main/src/services/docker/detector.ts:65`                                                  |

</details>
