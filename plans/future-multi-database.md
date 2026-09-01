# Multi-Database Provider Architecture

> **Status: Largely Implemented (as of April 2025)**
> PostgreSQL and MySQL support have been shipped. The actual implementation differs from the proposals below: it uses a `DatabaseEngine` type plus a dialect layer (`sql/dialect/`) for SQL generation, and keeps every engine's connections in `ConnectionPoolManager` (`sql/connection-pool.ts`) — there is no provider-class abstraction. A `DatabaseProvider` hierarchy did exist in `sql/provider/` but was never wired to anything and was deleted in J-148. SQLite and Oracle remain unimplemented. This document is retained for historical context; the sections below describe the proposal, not the code.

## Overview

This document outlines a provider-based architecture to support multiple database platforms beyond SQL Server. The goal is to abstract database-specific operations behind a common interface, allowing Joinery to connect to PostgreSQL, MySQL, SQLite, Oracle, and other databases with minimal UI changes.

## Current State (Updated)

Joinery supports **SQL Server**, **PostgreSQL**, and **MySQL** via:

- `mssql` / `tedious` for SQL Server, `pg` for PostgreSQL, `mysql2` for MySQL
- Engine-specific SQL generation through the **dialect** layer (`sql/dialect/`)
- Engine-specific connection management through **providers** (`sql/provider/`)
- Unified `DatabaseEngine = 'mssql' | 'postgresql' | 'mysql'` type
- Engine-aware Docker detection, backup/restore, metadata, and AI tools

## Proposed Architecture

### Core Abstraction Layer

```
packages/main/src/services/database/
├── providers/
│   ├── base-provider.ts          # Abstract base class
│   ├── sqlserver-provider.ts     # SQL Server implementation
│   ├── postgres-provider.ts      # PostgreSQL implementation
│   ├── mysql-provider.ts         # MySQL implementation
│   └── sqlite-provider.ts        # SQLite implementation
├── interfaces/
│   ├── connection.interface.ts   # Connection configuration
│   ├── metadata.interface.ts     # Schema/object metadata
│   ├── query.interface.ts        # Query execution
│   └── scripting.interface.ts    # Object scripting
├── database-service.ts           # Provider orchestration
└── provider-registry.ts          # Provider registration
```

### Base Provider Interface

```typescript
interface IDatabaseProvider {
  // Identity
  readonly id: string; // 'sqlserver', 'postgres', etc.
  readonly displayName: string; // 'SQL Server', 'PostgreSQL', etc.
  readonly icon: string; // Icon identifier

  // Connection
  connect(config: ConnectionConfig): Promise<Connection>;
  disconnect(connectionId: string): Promise<void>;
  testConnection(config: ConnectionConfig): Promise<TestResult>;

  // Metadata
  listDatabases(connectionId: string): Promise<DatabaseInfo[]>;
  listSchemas(connectionId: string, database: string): Promise<SchemaInfo[]>;
  listTables(connectionId: string, database: string, schema?: string): Promise<TableInfo[]>;
  listViews(connectionId: string, database: string, schema?: string): Promise<ViewInfo[]>;
  listProcedures(connectionId: string, database: string, schema?: string): Promise<ProcedureInfo[]>;
  listFunctions(connectionId: string, database: string, schema?: string): Promise<FunctionInfo[]>;

  // Table details
  getColumns(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]>;
  getIndexes(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<IndexInfo[]>;
  getForeignKeys(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ForeignKeyInfo[]>;
  getConstraints(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ConstraintInfo[]>;

  // Query execution
  executeQuery(
    connectionId: string,
    database: string,
    sql: string,
    options?: QueryOptions
  ): Promise<QueryResult>;
  cancelQuery(queryId: string): Promise<void>;

  // Scripting
  scriptTableAsCreate(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<string>;
  scriptTableAsInsert(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<string>;
  scriptViewAsCreate(
    connectionId: string,
    database: string,
    schema: string,
    view: string
  ): Promise<string>;
  scriptProcedureAsCreate(
    connectionId: string,
    database: string,
    schema: string,
    procedure: string
  ): Promise<string>;

  // Database operations
  createDatabase(
    connectionId: string,
    name: string,
    options?: CreateDatabaseOptions
  ): Promise<void>;
  dropDatabase(connectionId: string, name: string): Promise<void>;
  backupDatabase?(
    connectionId: string,
    database: string,
    path: string,
    options?: BackupOptions
  ): Promise<void>;
  restoreDatabase?(connectionId: string, path: string, options?: RestoreOptions): Promise<void>;

  // Provider capabilities
  getCapabilities(): ProviderCapabilities;
}

interface ProviderCapabilities {
  supportsSchemas: boolean; // PostgreSQL yes, MySQL no (uses databases)
  supportsStoredProcedures: boolean; // Most yes, SQLite no
  supportsFunctions: boolean;
  supportsBackupRestore: boolean;
  supportsTransactions: boolean;
  supportsMultipleResultSets: boolean;
  defaultPort: number;
  syntaxHighlightLanguage: string; // 'sql', 'pgsql', 'mysql', etc.
}
```

### Connection Configuration

```typescript
interface ConnectionConfig {
  providerId: string; // Which provider to use
  name: string; // User-friendly name
  host: string;
  port: number;
  database?: string; // Default database

  // Authentication
  authenticationType: 'password' | 'integrated' | 'certificate' | 'token';
  username?: string;
  password?: string; // Stored in Keychain

  // SSL/TLS
  ssl?: {
    enabled: boolean;
    rejectUnauthorized?: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  };

  // Provider-specific options
  options?: Record<string, unknown>;
}
```

### Provider-Specific Implementations

#### SQL Server Provider

- Uses `mssql` / `tedious` packages
- Supports Windows Authentication, SQL Auth, Azure AD
- Full backup/restore capabilities
- T-SQL syntax

#### PostgreSQL Provider

- Uses `pg` package
- Schema-aware (public, custom schemas)
- `pg_dump` / `pg_restore` for backup
- PL/pgSQL syntax

#### MySQL Provider

- Uses `mysql2` package
- Database = Schema concept
- `mysqldump` for backup
- MySQL syntax variants

#### SQLite Provider

- Uses `better-sqlite3` package
- File-based connections
- No schemas, single database
- Limited feature set

### UI Adaptations

1. **Connection Dialog**
   - Provider selector dropdown
   - Dynamic form fields based on provider
   - Provider-specific options section

2. **Explorer Tree**
   - Adapt hierarchy based on `supportsSchemas`
   - Show/hide features based on capabilities
   - Provider-specific icons

3. **Query Editor**
   - Syntax highlighting per provider
   - Auto-complete with provider-specific keywords
   - Execution behavior differences

4. **Context Menus**
   - Enable/disable items based on capabilities
   - Provider-specific actions

### Migration Path

1. **Phase 1: Abstraction**
   - Extract SQL Server code into provider
   - Define interfaces
   - Create provider registry
   - Minimal UI changes

2. **Phase 2: PostgreSQL**
   - Implement PostgreSQL provider
   - Add provider selection to connection dialog
   - Test with PostgreSQL databases

3. **Phase 3: Additional Providers**
   - MySQL support
   - SQLite support
   - Community-contributed providers

### Shared Package Types

```typescript
// packages/shared/src/types/database.types.ts

export type DatabaseProviderId = 'sqlserver' | 'postgres' | 'mysql' | 'sqlite' | 'oracle';

export interface DatabaseInfo {
  name: string;
  sizeBytes?: number;
  owner?: string;
  createdAt?: Date;
  collation?: string;
}

export interface SchemaInfo {
  name: string;
  owner?: string;
  isSystem: boolean;
}

export interface TableInfo {
  name: string;
  schema: string;
  rowCount?: number;
  sizeBytes?: number;
  createdAt?: Date;
  modifiedAt?: Date;
}

// ... similar for ViewInfo, ProcedureInfo, FunctionInfo, etc.
```

### IPC Channel Updates

```typescript
// Current: SQL Server specific
'sql:execute-query';
'sql:list-databases';

// Future: Provider-agnostic
'database:execute-query';
'database:list-databases';
'database:get-provider-capabilities';
```

### Configuration Storage

Connection profiles would include provider ID:

```json
{
  "id": "conn-123",
  "providerId": "postgres",
  "name": "Local PostgreSQL",
  "host": "localhost",
  "port": 5432,
  "database": "myapp",
  "username": "postgres"
}
```

### Testing Strategy

- Unit tests per provider
- Integration tests with Docker containers
- E2E tests for provider switching
- Mock providers for UI testing

## Benefits

1. **Broader User Base** - Support developers using various databases
2. **Code Organization** - Clear separation of concerns
3. **Maintainability** - Provider-specific bugs isolated
4. **Extensibility** - Easy to add new providers
5. **Consistency** - Same UI patterns across databases

## Risks & Mitigations

| Risk                            | Mitigation                                   |
| ------------------------------- | -------------------------------------------- |
| Feature parity across providers | Capabilities interface, graceful degradation |
| Performance differences         | Provider-specific optimizations              |
| SQL dialect differences         | Per-provider syntax highlighting/validation  |
| Testing complexity              | Docker-based test environments               |

## Timeline Estimate

- Phase 1 (Abstraction): 2-3 weeks
- Phase 2 (PostgreSQL): 2-3 weeks
- Phase 3 (MySQL/SQLite): 1-2 weeks each

## Open Questions

1. Should provider packages be lazy-loaded to reduce bundle size?
2. How to handle provider-specific UI customizations (e.g., PostgreSQL has different index types)?
3. Should we support provider plugins from npm?
4. Cloud database variants (Azure SQL, Amazon RDS, etc.) - same provider or separate?
