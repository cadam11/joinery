# Joinery Architecture Guide

## Overview

Joinery is a native desktop database IDE supporting SQL Server, PostgreSQL, and MySQL. Built with **Electron** (desktop shell), **React 19 + Tailwind v4** (UI), and **Node.js** (backend services).

```
                 ┌──────────────────────────────────────────┐
                 │              Electron Shell              │
                 │  ┌────────────────┐ ┌─────────────────┐ │
                 │  │  Main Process  │ │ Renderer Process │ │
                 │  │  (Node.js)     │ │ (React)          │ │
                 │  │                │ │                  │ │
                 │  │  SQL Providers │ │  Query Editor    │ │
                 │  │  AI Services   │ │  Object Explorer │ │
                 │  │  IPC Handlers  │ │  Connection Mgmt │ │
                 │  │  File I/O      │ │  Results Grid    │ │
                 │  └───────┬────────┘ └────────┬─────────┘ │
                 │          │    IPC (invoke)    │           │
                 │          └───────────────────-┘           │
                 └──────────────────────────────────────────┘
```

## Package Structure

```
packages/
├── main/                 # Electron main process (Node.js)
│   └── src/
│       ├── index.ts      # Entry point, app lifecycle, shutdown cleanup
│       ├── window.ts     # BrowserWindow creation, state persistence
│       ├── menu.ts       # Native menu bar (File, Edit, Query, etc.)
│       ├── ipc/          # IPC handler registration
│       │   ├── connection.ipc.ts   # Connect, test, save, delete
│       │   ├── query.ipc.ts        # Execute, cancel, history, export
│       │   ├── explorer.ipc.ts     # Object tree metadata
│       │   ├── database.ipc.ts     # Create, rename, drop databases
│       │   ├── backup.ipc.ts       # Backup/restore (SQL Server, PostgreSQL, MySQL)
│       │   ├── chat.ipc.ts         # AI chat conversations
│       │   ├── ai.ipc.ts           # AI features (tab rename, analysis)
│       │   └── workspace.ipc.ts    # File/folder operations
│       ├── services/
│       │   ├── sql/                # Database services
│       │   │   ├── dialect/        # SQL dialect abstraction
│       │   │   ├── provider/       # Database provider abstraction
│       │   │   ├── connection-pool.ts   # Multi-engine pool manager
│       │   │   ├── query-executor.ts    # Query execution, routed per engine
│       │   │   ├── metadata.ts          # Schema introspection
│       │   │   ├── backup-restore.ts    # Backup/restore (SQL Server, native T-SQL)
│       │   │   ├── pg-backup.ts         # Backup/restore (PostgreSQL, pg_dump/pg_restore)
│       │   │   ├── mysql-backup.ts      # Backup/restore (MySQL, mysqldump/mysql)
│       │   │   └── server-filesystem.ts # Server file browsing (MSSQL only)
│       │   ├── ai/                # AI services
│       │   │   ├── llm-providers.ts    # Multi-vendor LLM abstraction
│       │   │   ├── ai-service.ts       # Tab rename, SQL generation
│       │   │   ├── chat-service.ts     # Chat conversations + streaming
│       │   │   └── tool-registry.ts    # AI tool calling definitions
│       │   ├── config/            # Persistent storage (electron-store)
│       │   ├── docker/            # Docker container detection
│       │   ├── ssh/               # SSH tunnel manager (idle reconnect)
│       │   ├── azure/             # Microsoft Entra ID auth (Azure SQL)
│       │   └── keychain/          # macOS Keychain / Windows Credential Store
│       └── utils/
│           ├── tsql-builder.ts    # T-SQL statement generation (951 lines)
│           ├── logger.ts          # Structured logging
│           └── singleton.ts       # Singleton base class
│
├── renderer/             # React application (Vite)
│   └── src/
│       ├── state/                 # Zustand stores
│       ├── ipc/                   # Typed window.joinery wrappers, TanStack Query cache
│       ├── persistence/           # AppState bridge, legacy migration, theme mirror
│       ├── commands/              # Command bus, palette catalogue, menu registry
│       ├── features/              # Feature areas
│       │   ├── query/             # Query editor tab
│       │   ├── connections/       # Connection management page
│       │   └── chat/              # AI chat panel
│       ├── ui/                    # Radix + Tailwind primitives (buttons, dialogs, fields)
│       └── shell/                 # Shell, sidebar, Dockview workspace
│
├── shared/               # Shared types between main/renderer
│   └── src/
│       ├── types/                 # TypeScript interfaces
│       │   ├── connection.types.ts  # DatabaseEngine, ConnectionProfile
│       │   ├── database.types.ts    # Schema, table, column metadata types
│       │   ├── query.types.ts       # QueryRequest, QueryResult
│       │   ├── ai.types.ts          # AI/chat types
│       │   └── ...
│       ├── constants/
│       │   └── ipc-channels.ts    # All IPC channel name constants
│       └── validators/            # Input validation
│
└── preload/              # Electron preload scripts
    └── src/
        └── index.ts      # Context bridge (927 lines)
```

## Multi-Database Architecture

Joinery supports multiple database engines through a dialect abstraction over SQL generation, plus
per-engine pool management inside a single connection-pool manager.

### SQL Dialect Layer

The `SQLDialect` abstract class encapsulates all engine-specific SQL syntax:

```
dialect/
├── sql-dialect.ts      # Abstract base class
├── mssql-dialect.ts    # SQL Server: [brackets], sys.*, GO, BACKUP/RESTORE
├── pg-dialect.ts       # PostgreSQL: "double-quotes", pg_catalog, information_schema
├── mysql-dialect.ts    # MySQL: `backticks`, information_schema, mysqldump/mysql CLI
└── index.ts            # Factory: getDialect(engine) → dialect instance
```

**Key responsibilities:**

- Identifier quoting (`[name]` vs `"name"` vs `` `name` ``)
- Database context switching (`USE [db]` vs connection-level)
- DDL generation (CREATE/ALTER/DROP DATABASE)
- All metadata queries (list databases, schemas, tables, columns, indexes, FKs, etc.)
- Feature flags (`supportsBackupRestore`, `supportsExtendedProperties`, etc.)

### Connection Pool Layer

There is no provider-class layer. `ConnectionPoolManager` (connection-pool.ts) holds MSSQL,
PostgreSQL, and MySQL pools in parallel maps and exposes one getter per engine — `getPool`
(`mssql`), `getPgPool` (`pg`), `getMySQLPool` (`mysql2`, one pool per trust level) — along with
each engine's "Test Connection" probe. Callers pick a getter via
`getEngineForProfile(profileId)`.

Pool options that are worth testing without standing up a driver live in pure builder modules
beside it:

```
connection-pool.ts            # Pools, probes, SSH tunnels, engine routing
mysql-pool-options.ts         # mysql2 options + cache keys, per trust level
aurora-dsql-pool-options.ts   # Aurora DSQL (IAM-token) pg options
```

An abstract `DatabaseProvider` hierarchy (`sql/provider/`, with `PgProvider` and `MySQLProvider`)
existed until J-148 but was never wired to anything; it was deleted rather than completed. Git
history has it if the abstraction is ever wanted.

### Connection Profile

```typescript
interface ConnectionProfile {
  engine: DatabaseEngine; // 'mssql' | 'postgresql' | 'mysql'
  server: string;
  port: number; // Auto-set: 1433 / 5432 / 3306
  // ... other fields
}
```

Legacy profiles without `engine` are backfilled to `'mssql'` at read time.

### Adding a New Engine

Joinery ships three engines (SQL Server, PostgreSQL, MySQL) today. To add a fourth:

1. Create `dialect/<engine>-dialect.ts` extending `SQLDialect`
2. Register it in `dialect/index.ts`
3. Add a pool getter and a "Test Connection" probe in `connection-pool.ts`
4. Add routing in `query-executor.ts`

## IPC Communication

All renderer↔main communication uses typed IPC channels defined in `shared/constants/ipc-channels.ts`.

**Pattern:** `ipcRenderer.invoke(channel, ...args)` → `ipcMain.handle(channel, handler)`

```
Renderer (React)                      Main (Node.js)
┌──────────────┐                      ┌──────────────┐
│ src/ipc/*    │ ─── invoke ────────→ │ IPC Handlers │
│ (Promise)    │ ←── result ────────  │ (safeHandle) │
└──────────────┘                      └──────────────┘
```

Channel naming: `domain:action` (e.g., `query:execute`, `connection:test`)

The preload script (`packages/preload/src/index.ts`) bridges the IPC channels using `contextBridge.exposeInMainWorld`.

## State Management

The renderer uses **Zustand stores**, one per domain, under `packages/renderer/src/state/`:

| Store              | Purpose                                | Key state                                     |
| ------------------ | -------------------------------------- | --------------------------------------------- |
| `connection.ts`    | Active connection, profiles, databases | `activeConnectionId`, `profiles`, `databases` |
| `tab.ts`           | Open tabs, active tab, tab content     | `tabs`, `activeTabId`                         |
| `query-history.ts` | Query execution history                | `entries`, `isLoading`                        |
| `query-results.ts` | Cached result snapshots                | `snapshots`                                   |
| `ai.ts`            | AI model/vendor configuration          | `settings`, `vendors`                         |
| `settings.ts`      | App settings + the resolved theme      | `settings`, `nativeTheme`                     |

Anything fetched over IPC (schema metadata, Docker containers) goes through TanStack Query in
`src/ipc/` instead, so caching and invalidation are not hand-rolled per store. Anything that must
survive a quit is written to main-process `AppState` through `src/persistence/`; the renderer writes
exactly one `localStorage` key of its own, the pre-mount theme mirror.

## AI Integration

Joinery supports multiple LLM providers through `llm-providers.ts`:

| Provider  | Models         |
| --------- | -------------- |
| Google    | Gemini family  |
| Anthropic | Claude family  |
| OpenAI    | GPT family     |
| Groq      | Llama, Mixtral |
| Cerebras  | Fast inference |

**Key rule:** All AI calls go through the provider abstraction. Never make direct API calls.

**Features:**

- Chat with tool calling (SQL execution, schema inspection)
- Tab auto-rename via AI
- SQL generation from natural language
- Query analysis and optimization suggestions

## Query Editor

The query editor uses **Monaco Editor** with engine-aware syntax highlighting:

- **SQL Server connections:** Monaco language `sql` (T-SQL)
- **PostgreSQL connections:** Monaco language `pgsql`
- **MySQL connections:** Monaco language `mysql`

Language updates reactively when the active connection changes.

### Flyway/Skyway Placeholder Detection

When executing SQL containing `${placeholder}` tokens (Flyway syntax), Joinery prompts for values before execution. Values are remembered globally in `localStorage`.

### Key Shortcuts

| Shortcut         | Action                     |
| ---------------- | -------------------------- |
| F5               | Execute query              |
| Ctrl/Cmd+E       | Execute query (SSMS-style) |
| Ctrl/Cmd+Enter   | Execute query              |
| Ctrl/Cmd+Shift+F | Format SQL                 |
| Ctrl/Cmd+G       | Go to line                 |

## Security Model

1. **Context Isolation:** Always enabled. Renderer has no direct Node.js access.
2. **Credentials:** Stored in macOS Keychain / Windows Credential Store via `keytar`. Never in files or memory longer than necessary.
3. **SQL Safety:** Identifiers escaped via dialect-specific quoting. String literals escaped.
4. **IPC Validation:** All IPC handlers wrapped in `safeHandle` for error boundaries.
5. **No eval/new Function:** Strictly forbidden in all contexts.

## App Lifecycle & Shutdown

The `before-quit` handler performs ordered cleanup:

1. Stop pool cleanup timer
2. Close workspace file watchers
3. Cancel all active SQL queries
4. Stop backup/restore progress intervals
5. Abort active AI streams
6. Close all SQL connection pools
7. Force exit after 3-second timeout if cleanup hangs

## Testing

**Framework:** Vitest with @vitest/coverage-v8 (standard Vitest + v8 coverage setup)

```bash
pnpm test              # Run all tests (vitest run)
pnpm run test:watch    # Watch mode (vitest watch)
pnpm run test:coverage # Run with v8 coverage report
```

**Test structure:**

- `*.spec.ts` files co-located with source (explicit `import { describe, it, expect } from 'vitest'`)
- `packages/*/src/__tests__/setup.ts` — per-package setup files
- `packages/main/src/__mocks__/keytar.ts` — mock for native keytar module
- Root `vitest.config.ts` with vite-tsconfig-paths for alias resolution

**Coverage thresholds:** 10% minimum for statements, branches, functions, lines

**CI:** GitHub Actions runs on every PR to `main`:

- Triggers on changes to `packages/**`, `pnpm-lock.yaml`, `vitest.config.ts`
- Type-check all packages (main, renderer, preload)
- Run full test suite with coverage
- Coverage artifact uploaded (30-day retention)

## Common Commands

```bash
pnpm run dev              # Start in dev mode (hot reload)
pnpm run build            # Build for production
pnpm run package          # Package as .app
pnpm run package:dmg      # Create distributable DMG
pnpm test                 # Run all tests
pnpm run lint             # Lint all code
pnpm run typecheck        # TypeScript check without emit
```
