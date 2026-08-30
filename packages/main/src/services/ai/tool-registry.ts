/**
 * Tool Registry - Defines and executes tools available to the AI chat agent
 */

import type { ToolDefinition, DatabaseEngine } from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { createLogger } from '../../utils/logger';
import { ConnectionPoolManager } from '../sql/connection-pool';
import { getDialect } from '../sql/dialect';
import { buildRowCountQuery, type ParameterisedQuery } from './row-count-query';

const log = createLogger('ToolRegistry');

// Handler function type
type ToolHandler = (
  args: Record<string, unknown>,
  connectionId?: string,
  database?: string,
  conversationId?: string
) => Promise<unknown>;

export class ToolRegistry extends BaseSingleton {
  private tools: Map<string, ToolDefinition> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();
  /** Active editor content per conversation, set by ChatService before each request */
  private editorContent: Map<string, string> = new Map();

  constructor() {
    super();
    this.registerBuiltinTools();
  }

  /** Set the active editor content for a conversation (called by ChatService before each request) */
  setEditorContent(conversationId: string, content: string | undefined): void {
    if (content) {
      this.editorContent.set(conversationId, content);
    } else {
      this.editorContent.delete(conversationId);
    }
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get tools formatted for LLM provider APIs (provider-agnostic format).
   * Each LLM provider in llm-providers.ts converts this to its native format.
   */
  getToolsForAPI(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.getTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    connectionId?: string,
    database?: string,
    conversationId?: string
  ): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown tool: ${name}`);

    log.info(`Executing tool: ${name}`, args);
    const result = await handler(args, connectionId, database, conversationId);
    return result;
  }

  private register(tool: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(tool.name, tool);
    this.handlers.set(tool.name, handler);
  }

  /**
   * Execute a query on any engine and return rows.
   * Routes to the correct pool based on the connection's engine.
   */
  private async queryAny(
    connectionId: string,
    sql: string,
    database?: string
  ): Promise<Record<string, unknown>[]> {
    const pool = ConnectionPoolManager.getInstance();
    const engine = pool.getEngineForProfile(connectionId);

    if (engine === 'postgresql') {
      const pgPool = await pool.getPgPool(connectionId, database);
      const result = await pgPool.query(sql);
      return result.rows as Record<string, unknown>[];
    }

    if (engine === 'mysql') {
      const mysqlPool = await pool.getMySQLPool(connectionId, database);
      const [rows] = await mysqlPool.query(sql);
      return rows as Record<string, unknown>[];
    }

    // Default: SQL Server
    const result = await pool.query<Record<string, unknown>>(connectionId, sql, database);
    return result.recordset || [];
  }

  /**
   * Execute a query whose values are bound by the driver rather than written
   * into the SQL text. Use this for anything carrying a model-supplied string.
   *
   * The safety property is the binding itself: a bound value reaches the
   * server out of band and is never lexed as SQL, so it cannot close a literal
   * or start a statement — on any engine, under any server setting.
   *
   * Two of the three channels reinforce that by refusing to carry a second
   * statement at all: node-pg's extended query protocol, and a mysql2
   * server-side prepared statement (`execute`, which is why
   * `multipleStatements: true` on that pool is unreachable from here). The
   * SQL Server channel does NOT. `request.query()` reaches the server as
   * `sp_executesql`, which runs an ordinary multi-statement batch — Joinery
   * depends on that, since `adaptSqlForPool` prepends `USE [db];` to the
   * statement. On SQL Server the binding is therefore the whole of the
   * defence, not a belt-and-braces second line of it.
   *
   * `queryAny` above stays on the unbound path because it is handed complete,
   * dialect-built SQL.
   */
  private async queryAnyWithParams(
    connectionId: string,
    query: ParameterisedQuery,
    database?: string
  ): Promise<Record<string, unknown>[]> {
    const pool = ConnectionPoolManager.getInstance();
    const engine = pool.getEngineForProfile(connectionId);

    if (engine === 'postgresql') {
      const pgPool = await pool.getPgPool(connectionId, database);
      const result = await pgPool.query(query.sql, query.params);
      return result.rows as Record<string, unknown>[];
    }

    if (engine === 'mysql') {
      const mysqlPool = await pool.getMySQLPool(connectionId, database);
      // `execute`, not `query`: a prepared statement binds values server-side,
      // so `multipleStatements: true` on this pool is unreachable from them.
      const [rows] = await mysqlPool.execute(query.sql, query.params);
      return rows as Record<string, unknown>[];
    }

    // Default: SQL Server
    const result = await pool.queryWithParams<Record<string, unknown>>(
      connectionId,
      query.sql,
      query.params,
      database
    );
    return result.recordset || [];
  }

  /** Get the engine for a connection */
  private getEngine(connectionId: string): DatabaseEngine {
    return ConnectionPoolManager.getInstance().getEngineForProfile(connectionId);
  }

  private registerBuiltinTools(): void {
    // ---- Query Tools ----

    this.register(
      {
        name: 'execute_query',
        description:
          'Execute a SQL query against the current database and return results. Use for SELECT queries and data retrieval.',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'The SQL query to execute' },
          },
          required: ['sql'],
        },
        category: 'query',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const rows = await this.queryAny(connectionId, args.sql as string, database);
        const sliced = rows.slice(0, 50);
        return {
          rowCount: rows.length,
          columns: sliced.length > 0 ? Object.keys(sliced[0]) : [],
          rows: sliced,
          truncated: rows.length > 50,
        };
      }
    );

    this.register(
      {
        name: 'execute_ddl',
        description: 'Execute a DDL statement (CREATE, ALTER, DROP). Use for schema modifications.',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'The DDL SQL statement to execute' },
          },
          required: ['sql'],
        },
        requiresConfirmation: true,
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const pool = ConnectionPoolManager.getInstance();
        await pool.executeDDL(connectionId, args.sql as string, database);
        return { success: true, message: 'Statement executed successfully' };
      }
    );

    // ---- Schema Tools ----

    this.register(
      {
        name: 'list_tables',
        description: 'List all tables in the current database, optionally filtered by schema.',
        parameters: {
          type: 'object',
          properties: {
            schema: { type: 'string', description: 'Schema name to filter by (optional)' },
          },
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const dialect = getDialect(this.getEngine(connectionId));
        const db = database || '';
        const sql = dialect.listTablesSQL(db, args.schema as string | undefined);
        return this.queryAny(connectionId, sql, database);
      }
    );

    this.register(
      {
        name: 'describe_table',
        description:
          'Get detailed column information for a table including data types, nullability, and primary keys.',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
            schema: { type: 'string', description: 'Schema name (default depends on engine)' },
          },
          required: ['table'],
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const engine = this.getEngine(connectionId);
        const dialect = getDialect(engine);
        const schema =
          (args.schema as string) ||
          (engine === 'postgresql' ? 'public' : engine === 'mysql' ? database || '' : 'dbo');
        const table = args.table as string;
        const sql = dialect.listColumnsSQL(database || '', schema, table);
        return this.queryAny(connectionId, sql, database);
      }
    );

    this.register(
      {
        name: 'list_databases',
        description: 'List all databases on the server.',
        parameters: { type: 'object', properties: {} },
        category: 'server',
      },
      async (_args, connectionId) => {
        if (!connectionId) throw new Error('No active connection');
        const dialect = getDialect(this.getEngine(connectionId));
        const isAzure = await ConnectionPoolManager.getInstance().isAzureSQL(connectionId);
        const sql = dialect.listDatabasesSQL(isAzure);
        return this.queryAny(connectionId, sql);
      }
    );

    this.register(
      {
        name: 'list_views',
        description: 'List all views in the current database.',
        parameters: {
          type: 'object',
          properties: {
            schema: { type: 'string', description: 'Schema name to filter by (optional)' },
          },
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const dialect = getDialect(this.getEngine(connectionId));
        const sql = dialect.listViewsSQL(database || '', args.schema as string | undefined);
        return this.queryAny(connectionId, sql, database);
      }
    );

    this.register(
      {
        name: 'list_stored_procedures',
        description: 'List stored procedures in the current database.',
        parameters: {
          type: 'object',
          properties: {
            schema: { type: 'string', description: 'Schema name to filter by (optional)' },
          },
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const dialect = getDialect(this.getEngine(connectionId));
        const sql = dialect.listProceduresSQL(database || '', args.schema as string | undefined);
        return this.queryAny(connectionId, sql, database);
      }
    );

    // ---- Utility Tools ----

    this.register(
      {
        name: 'get_server_info',
        description: 'Get database server version, edition, and configuration info.',
        parameters: { type: 'object', properties: {} },
        category: 'server',
      },
      async (_args, connectionId) => {
        if (!connectionId) throw new Error('No active connection');
        const engine = this.getEngine(connectionId);

        if (engine === 'postgresql') {
          const isDsql = ConnectionPoolManager.getInstance().isDsqlCached(connectionId);
          const sql = isDsql
            ? `SELECT version() AS version, current_database() AS database, current_user AS user`
            : `SELECT version() AS version, current_database() AS database,
               current_user AS user, inet_server_addr()::text AS server_address`;
          const rows = await this.queryAny(connectionId, sql);
          return rows[0] || {};
        }

        if (engine === 'mysql') {
          const sql = `SELECT VERSION() AS version, DATABASE() AS \`database\`,
                       CURRENT_USER() AS user, @@hostname AS server_name,
                       @@max_connections AS max_connections`;
          const rows = await this.queryAny(connectionId, sql);
          return rows[0] || {};
        }

        const sql = `
          SELECT
            SERVERPROPERTY('ProductVersion') AS version,
            SERVERPROPERTY('ProductLevel') AS service_pack,
            SERVERPROPERTY('Edition') AS edition,
            SERVERPROPERTY('ServerName') AS server_name,
            @@MAX_CONNECTIONS AS max_connections`;
        const rows = await this.queryAny(connectionId, sql);
        return rows[0] || {};
      }
    );

    this.register(
      {
        name: 'get_table_row_count',
        description: 'Get the approximate row count for a table.',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
            schema: { type: 'string', description: 'Schema name (default depends on engine)' },
          },
          required: ['table'],
        },
        category: 'database',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const engine = this.getEngine(connectionId);
        const schema =
          (args.schema as string) ||
          (engine === 'postgresql' ? 'public' : engine === 'mysql' ? database || '' : 'dbo');
        const table = args.table as string;

        // `schema` and `table` come from the model's tool call, so they are
        // bound as parameters rather than written into the SQL (J-136).
        const query = buildRowCountQuery(engine, schema, table);
        const rows = await this.queryAnyWithParams(connectionId, query, database);
        return { table: `${schema}.${table}`, rowCount: rows[0]?.row_count || 0 };
      }
    );

    this.register(
      {
        name: 'get_table_indexes',
        description: 'List indexes on a table.',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
            schema: { type: 'string', description: 'Schema name (default depends on engine)' },
          },
          required: ['table'],
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const engine = this.getEngine(connectionId);
        const dialect = getDialect(engine);
        const schema =
          (args.schema as string) ||
          (engine === 'postgresql' ? 'public' : engine === 'mysql' ? database || '' : 'dbo');
        const table = args.table as string;
        const sql = dialect.listIndexesSQL(database || '', schema, table);
        return this.queryAny(connectionId, sql, database);
      }
    );

    this.register(
      {
        name: 'get_foreign_keys',
        description: 'List foreign key relationships for a table.',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
            schema: { type: 'string', description: 'Schema name (default depends on engine)' },
          },
          required: ['table'],
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const engine = this.getEngine(connectionId);
        const dialect = getDialect(engine);
        const schema =
          (args.schema as string) ||
          (engine === 'postgresql' ? 'public' : engine === 'mysql' ? database || '' : 'dbo');
        const table = args.table as string;
        const sql = dialect.listForeignKeysSQL(database || '', schema, table);
        return this.queryAny(connectionId, sql, database);
      }
    );

    this.register(
      {
        name: 'get_object_definition',
        description:
          'Get the CREATE script / definition for a view, stored procedure, or function.',
        parameters: {
          type: 'object',
          properties: {
            object_name: { type: 'string', description: 'Object name' },
            schema: { type: 'string', description: 'Schema name (default depends on engine)' },
          },
          required: ['object_name'],
        },
        category: 'schema',
      },
      async (args, connectionId, database) => {
        if (!connectionId) throw new Error('No active connection');
        const engine = this.getEngine(connectionId);
        const dialect = getDialect(engine);
        const schema =
          (args.schema as string) ||
          (engine === 'postgresql' ? 'public' : engine === 'mysql' ? database || '' : 'dbo');
        const objectName = args.object_name as string;
        const sql = dialect.getObjectDefinitionSQL(database || '', schema, objectName);
        const rows = await this.queryAny(connectionId, sql, database);
        const definition = rows[0]?.definition as string | undefined;
        return {
          objectName: `${schema}.${objectName}`,
          definition: definition || 'Definition not available (may be a table or encrypted object)',
        };
      }
    );

    this.register(
      {
        name: 'create_database',
        description: 'Create a new database on the server.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Database name' },
          },
          required: ['name'],
        },
        requiresConfirmation: true,
        category: 'server',
      },
      async (args, connectionId) => {
        if (!connectionId) throw new Error('No active connection');
        const pool = ConnectionPoolManager.getInstance();
        const dialect = getDialect(this.getEngine(connectionId));
        const dbName = args.name as string;
        const sql = dialect.createDatabaseSQL({ name: dbName });
        await pool.executeDDL(connectionId, sql);
        return { success: true, message: `Database ${dbName} created successfully` };
      }
    );

    this.register(
      {
        name: 'rename_database',
        description: 'Rename a database.',
        parameters: {
          type: 'object',
          properties: {
            current_name: { type: 'string', description: 'Current database name' },
            new_name: { type: 'string', description: 'New database name' },
          },
          required: ['current_name', 'new_name'],
        },
        requiresConfirmation: true,
        category: 'server',
      },
      async (args, connectionId) => {
        if (!connectionId) throw new Error('No active connection');
        const pool = ConnectionPoolManager.getInstance();
        const dialect = getDialect(this.getEngine(connectionId));
        const sql = dialect.renameDatabaseSQL({
          currentName: args.current_name as string,
          newName: args.new_name as string,
        });
        await pool.executeDDL(connectionId, sql);
        return {
          success: true,
          message: `Database renamed from ${args.current_name} to ${args.new_name}`,
        };
      }
    );

    this.register(
      {
        name: 'delete_database',
        description: 'Drop/delete a database. This is destructive and cannot be undone.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Database name to delete' },
          },
          required: ['name'],
        },
        requiresConfirmation: true,
        category: 'server',
      },
      async (args, connectionId) => {
        if (!connectionId) throw new Error('No active connection');
        const pool = ConnectionPoolManager.getInstance();
        const dialect = getDialect(this.getEngine(connectionId));
        const sql = dialect.dropDatabaseSQL({ name: args.name as string, closeConnections: true });
        await pool.executeDDL(connectionId, sql);
        return { success: true, message: `Database ${args.name} deleted` };
      }
    );

    // ---- UI Action Tools ----

    this.register(
      {
        name: 'open_query_tab',
        description:
          'Open a new query editor tab in the app, optionally pre-filled with SQL. Set autoExecute to true to immediately run the query and show results.',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL to pre-fill in the editor' },
            title: { type: 'string', description: 'Tab title (optional)' },
            autoExecute: {
              type: 'boolean',
              description: 'Whether to run the query immediately (default: false)',
            },
          },
          required: ['sql'],
        },
        category: 'utility',
      },
      async (args, _connectionId, database) => {
        return {
          success: true,
          message: args.autoExecute ? 'Opening query tab and running query' : 'Opening query tab',
          _uiAction: {
            type: 'open-query-tab',
            params: { sql: args.sql, title: args.title, autoExecute: args.autoExecute, database },
          },
        };
      }
    );

    this.register(
      {
        name: 'navigate_to_database',
        description:
          'Switch the active database context in the app. Use when the user wants to work with a different database.',
        parameters: {
          type: 'object',
          properties: {
            database: { type: 'string', description: 'Database name to switch to' },
          },
          required: ['database'],
        },
        category: 'utility',
      },
      async args => {
        return {
          success: true,
          message: `Switching to database: ${args.database}`,
          _uiAction: { type: 'navigate-database', params: { database: args.database } },
        };
      }
    );

    this.register(
      {
        name: 'open_settings',
        description:
          'Open the app settings dialog. Use when the user wants to configure settings, AI providers, or preferences.',
        parameters: { type: 'object', properties: {} },
        category: 'utility',
      },
      async () => {
        return {
          success: true,
          message: 'Opening settings',
          _uiAction: { type: 'open-settings' },
        };
      }
    );

    // ---- Editor Content Tools ----

    this.register(
      {
        name: 'read_editor_content',
        description:
          "Read the contents of the user's active query editor tab. Returns lines within the specified range. Useful when the editor content is too long to fit in the preview, or when you need to inspect a specific section.",
        parameters: {
          type: 'object',
          properties: {
            start_line: { type: 'number', description: 'Start line number (1-based, default: 1)' },
            end_line: {
              type: 'number',
              description: 'End line number (1-based, inclusive). Omit to read to the end.',
            },
          },
        },
        category: 'utility',
      },
      async (args, _connectionId, _database, conversationId) => {
        const content = conversationId ? this.editorContent.get(conversationId) : undefined;
        if (!content) {
          return {
            error: 'No active editor content available. The user may not have a query tab open.',
          };
        }
        const lines = content.split('\n');
        const start = Math.max(1, (args.start_line as number) || 1);
        const end = Math.min(lines.length, (args.end_line as number) || lines.length);
        const selected = lines.slice(start - 1, end);
        return {
          totalLines: lines.length,
          startLine: start,
          endLine: end,
          lines: selected.map((l, i) => `${start + i}: ${l}`).join('\n'),
        };
      }
    );

    this.register(
      {
        name: 'search_editor_content',
        description:
          "Search the user's active query editor tab using a regular expression. Returns matching lines with their line numbers.",
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regular expression pattern to search for' },
            case_sensitive: {
              type: 'boolean',
              description: 'Whether the search is case-sensitive (default: false)',
            },
          },
          required: ['pattern'],
        },
        category: 'utility',
      },
      async (args, _connectionId, _database, conversationId) => {
        const content = conversationId ? this.editorContent.get(conversationId) : undefined;
        if (!content) {
          return {
            error: 'No active editor content available. The user may not have a query tab open.',
          };
        }
        const flags = (args.case_sensitive as boolean) ? 'g' : 'gi';
        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern as string, flags);
        } catch (e) {
          return { error: `Invalid regex pattern: ${(e as Error).message}` };
        }
        const lines = content.split('\n');
        const matches: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${i + 1}: ${lines[i]}`);
          }
          regex.lastIndex = 0; // reset for global regex
        }
        return {
          totalLines: lines.length,
          matchCount: matches.length,
          matches: matches.slice(0, 100).join('\n'),
          truncated: matches.length > 100,
        };
      }
    );
  }
}
