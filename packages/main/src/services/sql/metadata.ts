/**
 * Metadata Service
 * Queries databases for metadata (SQL Server, PostgreSQL, MySQL).
 * Uses the SQL dialect abstraction for engine-specific queries.
 */

import type {
  DatabaseInfo,
  SchemaInfo,
  TableInfo,
  ViewInfo,
  ProcedureInfo,
  FunctionInfo,
  ObjectDefinition,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  ConstraintInfo,
  TriggerInfo,
  ExtendedProperty,
  TableProperties,
} from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { ObjectCache } from '../../utils/object-cache';
import { TsqlBuilder } from '../../utils/tsql-builder';
import { ConnectionPoolManager } from './connection-pool';
import type { SQLDialect } from './dialect';
import { tablePropertiesPgDsqlSql, tablePropertiesPgStandardSql } from './pg-table-properties';

export class MetadataService extends BaseSingleton {
  private poolManager: ConnectionPoolManager;
  private databaseCache: ObjectCache<DatabaseInfo[]>;
  private schemaCache: ObjectCache<SchemaInfo[]>;
  private tableCache: ObjectCache<TableInfo[]>;
  private viewCache: ObjectCache<ViewInfo[]>;
  private procedureCache: ObjectCache<ProcedureInfo[]>;
  private functionCache: ObjectCache<FunctionInfo[]>;

  /**
   * Get the SQL dialect for a connection
   */
  private getDialect(connectionId: string): SQLDialect {
    return this.poolManager.getDialectForProfile(connectionId);
  }

  /**
   * Execute a query on any engine (MSSQL or PG).
   * Routes to the correct pool based on the connection's engine.
   */
  private async queryAny<T>(connectionId: string, sql: string, database?: string): Promise<T[]> {
    const engine = this.poolManager.getEngineForProfile(connectionId);

    if (engine === 'postgresql') {
      const pool = await this.poolManager.getPgPool(connectionId, database);
      const result = await pool.query(sql);
      return result.rows as T[];
    }

    if (engine === 'mysql') {
      const pool = await this.poolManager.getMySQLPool(connectionId, database);
      const [rows] = await pool.query(sql);
      return rows as T[];
    }

    // Default: SQL Server
    const result = await this.poolManager.query<T>(connectionId, sql, database);
    return result.recordset;
  }

  constructor() {
    super();
    this.poolManager = ConnectionPoolManager.getInstance();

    // Caches with 1 minute TTL
    this.databaseCache = new ObjectCache({ ttlMs: 60000 });
    this.schemaCache = new ObjectCache({ ttlMs: 60000 });
    this.tableCache = new ObjectCache({ ttlMs: 60000 });
    this.viewCache = new ObjectCache({ ttlMs: 60000 });
    this.procedureCache = new ObjectCache({ ttlMs: 60000 });
    this.functionCache = new ObjectCache({ ttlMs: 60000 });
  }

  /**
   * List all databases on a connection
   */
  async listDatabases(connectionId: string, forceRefresh = false): Promise<DatabaseInfo[]> {
    const cacheKey = `databases:${connectionId}`;

    if (!forceRefresh) {
      const cached = this.databaseCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dialect = this.getDialect(connectionId);
    const isAzure = await this.poolManager.isAzureSQL(connectionId);
    const sql = dialect.listDatabasesSQL(isAzure);
    const rows = await this.queryAny<DatabaseInfo>(connectionId, sql);

    const databases = rows.map(row => ({
      ...row,
      isSystemDb: Boolean(row.isSystemDb),
      state: (row.state?.toLowerCase() || 'online') as DatabaseInfo['state'],
      recoveryModel: (row.recoveryModel?.toLowerCase() ||
        'simple') as DatabaseInfo['recoveryModel'],
    }));

    this.databaseCache.set(cacheKey, databases);
    return databases;
  }

  /**
   * List schemas in a database (excluding system schemas)
   */
  async listSchemas(
    connectionId: string,
    database: string,
    forceRefresh = false
  ): Promise<SchemaInfo[]> {
    const cacheKey = `schemas:${connectionId}:${database}`;

    if (!forceRefresh) {
      const cached = this.schemaCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dialect = this.getDialect(connectionId);
    const sql = dialect.listSchemasSQL(database);
    const rows = await this.queryAny<SchemaInfo>(connectionId, sql, database);

    const schemas = rows.map(row => ({
      ...row,
      isSystem: Boolean(row.isSystem),
    }));

    this.schemaCache.set(cacheKey, schemas);
    return schemas;
  }

  /**
   * List tables in a database
   */
  async listTables(
    connectionId: string,
    database: string,
    forceRefresh = false
  ): Promise<TableInfo[]> {
    const cacheKey = `tables:${connectionId}:${database}`;

    if (!forceRefresh) {
      const cached = this.tableCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dialect = this.getDialect(connectionId);
    const sql = dialect.listTablesSQL(database);
    const rows = await this.queryAny<TableInfo>(connectionId, sql, database);

    this.tableCache.set(cacheKey, rows);
    return rows;
  }

  /**
   * List views in a database
   */
  async listViews(
    connectionId: string,
    database: string,
    forceRefresh = false
  ): Promise<ViewInfo[]> {
    const cacheKey = `views:${connectionId}:${database}`;

    if (!forceRefresh) {
      const cached = this.viewCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dialect = this.getDialect(connectionId);
    const sql = dialect.listViewsSQL(database);
    const rows = await this.queryAny<ViewInfo>(connectionId, sql, database);

    this.viewCache.set(cacheKey, rows);
    return rows;
  }

  /**
   * List stored procedures in a database
   */
  async listProcedures(
    connectionId: string,
    database: string,
    forceRefresh = false
  ): Promise<ProcedureInfo[]> {
    const cacheKey = `procedures:${connectionId}:${database}`;

    if (!forceRefresh) {
      const cached = this.procedureCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dialect = this.getDialect(connectionId);
    const sql = dialect.listProceduresSQL(database);
    const rows = await this.queryAny<ProcedureInfo>(connectionId, sql, database);

    this.procedureCache.set(cacheKey, rows);
    return rows;
  }

  /**
   * List user-defined functions in a database
   */
  async listFunctions(
    connectionId: string,
    database: string,
    forceRefresh = false
  ): Promise<FunctionInfo[]> {
    const cacheKey = `functions:${connectionId}:${database}`;

    if (!forceRefresh) {
      const cached = this.functionCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dialect = this.getDialect(connectionId);
    const sql = dialect.listFunctionsSQL(database);
    const rows = await this.queryAny<FunctionInfo>(connectionId, sql, database);

    this.functionCache.set(cacheKey, rows);
    return rows;
  }

  /**
   * Get the definition of a database object
   */
  async getObjectDefinition(
    connectionId: string,
    database: string,
    schema: string,
    name: string,
    objectType: string
  ): Promise<ObjectDefinition> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.getObjectDefinitionSQL(database, schema, name);
    const rows = await this.queryAny<{ definition: string }>(connectionId, sql, database);

    return {
      objectType: objectType as ObjectDefinition['objectType'],
      schema,
      name,
      definition: rows[0]?.definition || '-- Definition not available',
    };
  }

  /**
   * List columns for a table
   */
  async listColumns(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.listColumnsSQL(database, schema, table);
    const rows = await this.queryAny<ColumnInfo>(connectionId, sql, database);
    return rows.map(row => ({
      ...row,
      isNullable: Boolean(row.isNullable),
      isPrimaryKey: Boolean(row.isPrimaryKey),
      isForeignKey: Boolean(row.isForeignKey),
    }));
  }

  /**
   * List indexes for a table
   */
  async listIndexes(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<IndexInfo[]> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.listIndexesSQL(database, schema, table);
    const rows = await this.queryAny<{
      name: string;
      type: string;
      isUnique: boolean;
      isPrimaryKey: boolean;
      columns: string;
    }>(connectionId, sql, database);
    return rows.map(row => ({
      name: row.name,
      type: row.type as IndexInfo['type'],
      isUnique: Boolean(row.isUnique),
      isPrimaryKey: Boolean(row.isPrimaryKey),
      columns: row.columns ? row.columns.split(', ') : [],
    }));
  }

  /**
   * List foreign keys for a table
   */
  async listForeignKeys(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ForeignKeyInfo[]> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.listForeignKeysSQL(database, schema, table);
    const rows = await this.queryAny<{
      name: string;
      columns: string;
      referencedSchema: string;
      referencedTable: string;
      referencedColumns: string;
      onDelete: string;
      onUpdate: string;
    }>(connectionId, sql, database);
    return rows.map(row => ({
      name: row.name,
      columns: row.columns ? row.columns.split(', ') : [],
      referencedSchema: row.referencedSchema,
      referencedTable: row.referencedTable,
      referencedColumns: row.referencedColumns ? row.referencedColumns.split(', ') : [],
      onDelete: row.onDelete as ForeignKeyInfo['onDelete'],
      onUpdate: row.onUpdate as ForeignKeyInfo['onUpdate'],
    }));
  }

  /**
   * List constraints for a table
   */
  async listConstraints(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ConstraintInfo[]> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.listConstraintsSQL(database, schema, table);
    const rows = await this.queryAny<{
      name: string;
      type: string;
      columns: string;
      definition: string;
    }>(connectionId, sql, database);
    return rows.map(row => ({
      name: row.name,
      type: row.type as ConstraintInfo['type'],
      columns: row.columns ? row.columns.split(', ') : [],
      definition: row.definition,
    }));
  }

  /**
   * List triggers for a table
   */
  async listTriggers(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<TriggerInfo[]> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.listTriggersSQL(database, schema, table);
    const rows = await this.queryAny<{
      name: string;
      isDisabled: boolean;
      triggerType: string;
      createdAt: string;
    }>(connectionId, sql, database);
    return rows.map(row => ({
      name: row.name,
      isEnabled: !row.isDisabled,
      triggerType: row.triggerType as TriggerInfo['triggerType'],
      createdAt: row.createdAt,
    }));
  }

  /**
   * List extended properties (MSSQL) or COMMENT ON descriptions (PG) for a table and its columns.
   * Returns data shaped as ExtendedProperty[] for UI consistency across engines.
   */
  async listExtendedProperties(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ExtendedProperty[]> {
    const dialect = this.getDialect(connectionId);
    const sql = dialect.listObjectCommentsSQL(database, schema, table);
    if (!sql) return [];

    const rows = await this.queryAny<ExtendedProperty>(connectionId, sql, database);
    return rows;
  }

  /**
   * Get comprehensive table properties including space, storage, and all metadata
   */
  async getTableProperties(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<TableProperties> {
    const engine = this.poolManager.getEngineForProfile(connectionId);

    // For PostgreSQL, build properties from pg_catalog queries
    if (engine === 'postgresql') {
      return this.getTablePropertiesPg(connectionId, database, schema, table);
    }

    // For MySQL, build properties from information_schema
    if (engine === 'mysql') {
      return this.getTablePropertiesMySQL(connectionId, database, schema, table);
    }

    // SQL Server: use TsqlBuilder for detailed system view queries
    const propertiesSql = TsqlBuilder.getTableProperties(database, schema, table);
    const propertiesResult = await this.poolManager.query<{
      schema: string;
      name: string;
      objectId: number;
      createdAt: string;
      modifiedAt: string;
      rowCount: number;
      dataSpaceKb: number;
      indexSpaceKb: number;
      unusedSpaceKb: number;
      totalSpaceKb: number;
      hasIdentity: boolean;
      identityColumn: string;
      identitySeed: number;
      identityIncrement: number;
      isReplicated: boolean;
      hasTextImage: boolean;
      textImageOnFilegroup: string;
      filegroup: string;
    }>(connectionId, propertiesSql, database);

    const baseProps = propertiesResult.recordset[0];
    if (!baseProps) {
      throw new Error(`Table ${schema}.${table} not found`);
    }

    // Get all related metadata in parallel
    const [columns, indexes, foreignKeys, constraints, triggers, extendedProperties] =
      await Promise.all([
        this.listColumns(connectionId, database, schema, table),
        this.listIndexes(connectionId, database, schema, table),
        this.listForeignKeys(connectionId, database, schema, table),
        this.listConstraints(connectionId, database, schema, table),
        this.listTriggers(connectionId, database, schema, table),
        this.listExtendedProperties(connectionId, database, schema, table),
      ]);

    return {
      schema: baseProps.schema,
      name: baseProps.name,
      objectId: baseProps.objectId,
      createdAt: baseProps.createdAt,
      modifiedAt: baseProps.modifiedAt,
      rowCount: baseProps.rowCount || 0,
      dataSpaceKb: baseProps.dataSpaceKb || 0,
      indexSpaceKb: baseProps.indexSpaceKb || 0,
      unusedSpaceKb: baseProps.unusedSpaceKb || 0,
      totalSpaceKb: baseProps.totalSpaceKb || 0,
      hasIdentity: Boolean(baseProps.hasIdentity),
      identityColumn: baseProps.identityColumn || undefined,
      identitySeed: baseProps.identitySeed || undefined,
      identityIncrement: baseProps.identityIncrement || undefined,
      isReplicated: Boolean(baseProps.isReplicated),
      hasTextImage: Boolean(baseProps.hasTextImage),
      textImageOnFilegroup: baseProps.textImageOnFilegroup || undefined,
      filegroup: baseProps.filegroup || 'PRIMARY',
      columns,
      indexes,
      foreignKeys,
      constraints,
      triggers,
      extendedProperties,
    };
  }

  /**
   * Get table properties for PostgreSQL using pg_catalog
   */
  private async getTablePropertiesPg(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<TableProperties> {
    const sql = this.poolManager.isDsqlCached(connectionId)
      ? tablePropertiesPgDsqlSql(schema, table)
      : tablePropertiesPgStandardSql(schema, table);

    const rows = await this.queryAny<TableProperties>(connectionId, sql, database);
    const props = rows[0] || ({} as TableProperties);

    // Fetch sub-resources using dialect-routed methods
    const [columns, indexes, foreignKeys, constraints, triggers, extendedProperties] =
      await Promise.all([
        this.listColumns(connectionId, database, schema, table),
        this.listIndexes(connectionId, database, schema, table),
        this.listForeignKeys(connectionId, database, schema, table),
        this.listConstraints(connectionId, database, schema, table),
        this.listTriggers(connectionId, database, schema, table),
        this.listExtendedProperties(connectionId, database, schema, table),
      ]);

    return {
      ...props,
      columns,
      indexes,
      foreignKeys,
      constraints,
      triggers,
      extendedProperties,
    };
  }

  /**
   * Get table properties for MySQL using information_schema
   */
  private async getTablePropertiesMySQL(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<TableProperties> {
    const dialect = this.getDialect(connectionId);
    const sql = `
SELECT
  TABLE_SCHEMA AS \`schema\`,
  TABLE_NAME AS name,
  0 AS \`objectId\`,
  CREATE_TIME AS \`createdAt\`,
  UPDATE_TIME AS \`modifiedAt\`,
  TABLE_ROWS AS \`rowCount\`,
  ROUND(DATA_LENGTH / 1024) AS \`dataSpaceKb\`,
  ROUND(INDEX_LENGTH / 1024) AS \`indexSpaceKb\`,
  ROUND(DATA_FREE / 1024) AS \`unusedSpaceKb\`,
  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024) AS \`totalSpaceKb\`,
  IF(AUTO_INCREMENT IS NOT NULL, true, false) AS \`hasIdentity\`,
  ENGINE AS filegroup
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${dialect.quoteLiteral(schema)}
  AND TABLE_NAME = ${dialect.quoteLiteral(table)};`;

    const rows = await this.queryAny<TableProperties>(connectionId, sql, database);
    const props = rows[0] || ({} as TableProperties);

    // Fetch sub-resources using dialect-routed methods
    const [columns, indexes, foreignKeys, constraints, triggers, extendedProperties] =
      await Promise.all([
        this.listColumns(connectionId, database, schema, table),
        this.listIndexes(connectionId, database, schema, table),
        this.listForeignKeys(connectionId, database, schema, table),
        this.listConstraints(connectionId, database, schema, table),
        this.listTriggers(connectionId, database, schema, table),
        this.listExtendedProperties(connectionId, database, schema, table),
      ]);

    return {
      ...props,
      columns,
      indexes,
      foreignKeys,
      constraints,
      triggers,
      extendedProperties,
    };
  }

  /**
   * Generate CREATE TABLE script
   */
  async scriptTableAsCreate(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<string> {
    const engine = this.poolManager.getEngineForProfile(connectionId);

    // For PostgreSQL, generate CREATE TABLE from information_schema
    if (engine === 'postgresql') {
      return this.scriptTableAsCreatePg(connectionId, database, schema, table);
    }

    // For MySQL, generate CREATE TABLE from information_schema
    if (engine === 'mysql') {
      return this.scriptTableAsCreateMySQL(connectionId, database, schema, table);
    }

    // SQL Server: use TsqlBuilder for detailed scripting
    const columnsSql = TsqlBuilder.getTableScriptData(database, schema, table);
    const columnsResult = await this.poolManager.query<{
      ordinalPosition: number;
      columnName: string;
      dataType: string;
      maxLength: number;
      precision: number;
      scale: number;
      isNullable: boolean;
      isIdentity: boolean;
      identitySeed: number;
      identityIncrement: number;
      defaultValue: string;
      defaultConstraintName: string;
      computedDefinition: string;
      computedIsPersisted: boolean;
    }>(connectionId, columnsSql, database);

    // Get primary key
    const pkSql = TsqlBuilder.getPrimaryKeyScript(database, schema, table);
    const pkResult = await this.poolManager.query<{
      constraintName: string;
      indexType: string;
      columns: string;
    }>(connectionId, pkSql, database);

    // Get foreign keys
    const fkSql = TsqlBuilder.getForeignKeyScript(database, schema, table);
    const fkResult = await this.poolManager.query<{
      constraintName: string;
      columns: string;
      referencedSchema: string;
      referencedTable: string;
      referencedColumns: string;
      onDelete: string;
      onUpdate: string;
    }>(connectionId, fkSql, database);

    // Get other constraints
    const constraintsSql = TsqlBuilder.getConstraintsScript(database, schema, table);
    const constraintsResult = await this.poolManager.query<{
      constraintType: string;
      constraintName: string;
      indexType: string;
      columns: string;
      definition: string;
    }>(connectionId, constraintsSql, database);

    // Get indexes
    const indexesSql = TsqlBuilder.getIndexesScript(database, schema, table);
    const indexesResult = await this.poolManager.query<{
      indexName: string;
      indexType: string;
      isUnique: boolean;
      keyColumns: string;
      includedColumns: string;
      filterDefinition: string;
    }>(connectionId, indexesSql, database);

    // Build the CREATE TABLE script
    return this.buildCreateTableScript(
      schema,
      table,
      columnsResult.recordset,
      pkResult.recordset[0],
      fkResult.recordset,
      constraintsResult.recordset,
      indexesResult.recordset
    );
  }

  /**
   * Build CREATE TABLE script from metadata
   */
  private buildCreateTableScript(
    schema: string,
    table: string,
    columns: Array<{
      columnName: string;
      dataType: string;
      maxLength: number;
      precision: number;
      scale: number;
      isNullable: boolean;
      isIdentity: boolean;
      identitySeed: number;
      identityIncrement: number;
      defaultValue: string;
      computedDefinition: string;
      computedIsPersisted: boolean;
    }>,
    primaryKey: { constraintName: string; indexType: string; columns: string } | undefined,
    foreignKeys: Array<{
      constraintName: string;
      columns: string;
      referencedSchema: string;
      referencedTable: string;
      referencedColumns: string;
      onDelete: string;
      onUpdate: string;
    }>,
    constraints: Array<{
      constraintType: string;
      constraintName: string;
      indexType: string;
      columns: string;
      definition: string;
    }>,
    indexes: Array<{
      indexName: string;
      indexType: string;
      isUnique: boolean;
      keyColumns: string;
      includedColumns: string;
      filterDefinition: string;
    }>
  ): string {
    const lines: string[] = [];
    lines.push(`CREATE TABLE [${schema}].[${table}]`);
    lines.push('(');

    // Columns
    const columnDefs: string[] = [];
    for (const col of columns) {
      let def = `    [${col.columnName}]`;

      if (col.computedDefinition) {
        def += ` AS ${col.computedDefinition}`;
        if (col.computedIsPersisted) {
          def += ' PERSISTED';
        }
      } else {
        def += ` ${this.formatColumnType(col)}`;

        if (col.isIdentity) {
          def += ` IDENTITY(${col.identitySeed || 1},${col.identityIncrement || 1})`;
        }

        def += col.isNullable ? ' NULL' : ' NOT NULL';

        if (col.defaultValue) {
          def += ` DEFAULT ${col.defaultValue}`;
        }
      }

      columnDefs.push(def);
    }

    // Primary Key
    if (primaryKey) {
      const pkType = primaryKey.indexType === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED';
      columnDefs.push(
        `    CONSTRAINT [${primaryKey.constraintName}] PRIMARY KEY ${pkType} (${primaryKey.columns})`
      );
    }

    // Unique constraints
    for (const c of constraints.filter(x => x.constraintType === 'UNIQUE')) {
      const uqType = c.indexType === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED';
      columnDefs.push(`    CONSTRAINT [${c.constraintName}] UNIQUE ${uqType} (${c.columns})`);
    }

    // Check constraints
    for (const c of constraints.filter(x => x.constraintType === 'CHECK')) {
      columnDefs.push(`    CONSTRAINT [${c.constraintName}] CHECK ${c.definition}`);
    }

    // Foreign keys
    for (const fk of foreignKeys) {
      let fkDef = `    CONSTRAINT [${fk.constraintName}] FOREIGN KEY (${fk.columns})`;
      fkDef += ` REFERENCES [${fk.referencedSchema}].[${fk.referencedTable}] (${fk.referencedColumns})`;
      if (fk.onDelete && fk.onDelete !== 'NO_ACTION') {
        fkDef += ` ON DELETE ${fk.onDelete.replace('_', ' ')}`;
      }
      if (fk.onUpdate && fk.onUpdate !== 'NO_ACTION') {
        fkDef += ` ON UPDATE ${fk.onUpdate.replace('_', ' ')}`;
      }
      columnDefs.push(fkDef);
    }

    lines.push(columnDefs.join(',\n'));
    lines.push(');');
    lines.push('GO');

    // Non-clustered indexes (separate statements)
    for (const idx of indexes) {
      lines.push('');
      let idxDef = `CREATE`;
      if (idx.isUnique) {
        idxDef += ' UNIQUE';
      }
      idxDef += ` ${idx.indexType} INDEX [${idx.indexName}]`;
      idxDef += ` ON [${schema}].[${table}] (${idx.keyColumns})`;
      if (idx.includedColumns) {
        idxDef += ` INCLUDE (${idx.includedColumns})`;
      }
      if (idx.filterDefinition) {
        idxDef += ` WHERE ${idx.filterDefinition}`;
      }
      idxDef += ';';
      lines.push(idxDef);
      lines.push('GO');
    }

    return lines.join('\n');
  }

  /**
   * Format column type for CREATE TABLE
   */
  private formatColumnType(col: {
    dataType: string;
    maxLength: number;
    precision: number;
    scale: number;
  }): string {
    const type = col.dataType.toLowerCase();

    // Types with length
    if (['varchar', 'nvarchar', 'char', 'nchar', 'binary', 'varbinary'].includes(type)) {
      const len =
        col.maxLength === -1 ? 'MAX' : type.startsWith('n') ? col.maxLength / 2 : col.maxLength;
      return `[${col.dataType}](${len})`;
    }

    // Types with precision and scale
    if (['decimal', 'numeric'].includes(type)) {
      return `[${col.dataType}](${col.precision}, ${col.scale})`;
    }

    // Types with only precision
    if (['float'].includes(type) && col.precision !== 53) {
      return `[${col.dataType}](${col.precision})`;
    }

    // Types with scale only (datetime2, time, datetimeoffset)
    if (['datetime2', 'time', 'datetimeoffset'].includes(type) && col.scale !== 7) {
      return `[${col.dataType}](${col.scale})`;
    }

    return `[${col.dataType}]`;
  }

  /**
   * Generate CREATE TABLE script for PostgreSQL
   */
  private async scriptTableAsCreatePg(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<string> {
    const columns = await this.listColumns(connectionId, database, schema, table);
    const dialect = this.getDialect(connectionId);
    const fullName = dialect.quoteSchemaObject(schema, table);

    const colDefs = columns.map(col => {
      let def = `  ${dialect.quoteIdentifier(col.name)} ${col.dataType}`;
      if (col.maxLength && col.dataType === 'character varying') {
        def += `(${col.maxLength})`;
      }
      if (!col.isNullable) def += ' NOT NULL';
      if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
      return def;
    });

    // Add primary key constraint
    const pkCols = columns.filter(c => c.isPrimaryKey).map(c => dialect.quoteIdentifier(c.name));
    if (pkCols.length > 0) {
      colDefs.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    }

    return `CREATE TABLE ${fullName} (\n${colDefs.join(',\n')}\n);`;
  }

  /**
   * Generate CREATE TABLE script for MySQL
   */
  private async scriptTableAsCreateMySQL(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<string> {
    const dialect = this.getDialect(connectionId);

    // Query column details including auto_increment from EXTRA field
    const colSql = `
SELECT
  COLUMN_NAME AS name,
  COLUMN_TYPE AS columnType,
  IS_NULLABLE,
  COLUMN_DEFAULT AS defaultValue,
  EXTRA,
  COLUMN_KEY
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${dialect.quoteLiteral(schema)}
  AND TABLE_NAME = ${dialect.quoteLiteral(table)}
ORDER BY ORDINAL_POSITION;`;

    const colRows = await this.queryAny<{
      name: string;
      columnType: string;
      IS_NULLABLE: string;
      defaultValue: string | null;
      EXTRA: string;
      COLUMN_KEY: string;
    }>(connectionId, colSql, database);

    const fullName = dialect.quoteSchemaObject(schema, table);

    const colDefs = colRows.map(col => {
      let def = `  ${dialect.quoteIdentifier(col.name)} ${col.columnType}`;
      if (col.IS_NULLABLE === 'NO') def += ' NOT NULL';
      if (col.EXTRA?.includes('auto_increment')) def += ' AUTO_INCREMENT';
      if (col.defaultValue !== null && !col.EXTRA?.includes('auto_increment')) {
        def += ` DEFAULT ${col.defaultValue}`;
      }
      return def;
    });

    // Add primary key
    const pkCols = colRows
      .filter(c => c.COLUMN_KEY === 'PRI')
      .map(c => dialect.quoteIdentifier(c.name));
    if (pkCols.length > 0) {
      colDefs.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    }

    return `CREATE TABLE ${fullName} (\n${colDefs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  }

  /**
   * Generate INSERT statement template for a table
   */
  async scriptTableAsInsert(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<string> {
    const engine = this.poolManager.getEngineForProfile(connectionId);
    const dialect = this.getDialect(connectionId);
    const columns = await this.listColumns(connectionId, database, schema, table);

    if (engine === 'postgresql') {
      // PG insert template — skip identity/serial columns
      const nonIdentityCols = columns.filter(c => {
        const def = c.defaultValue?.toLowerCase() || '';
        return !def.includes('nextval(') && !def.includes('generated');
      });
      const colNames = nonIdentityCols.map(c => dialect.quoteIdentifier(c.name)).join(', ');
      const values = nonIdentityCols.map(c => `/* ${c.dataType} */`).join(', ');
      return `INSERT INTO ${dialect.quoteSchemaObject(schema, table)} (${colNames})\nVALUES (${values});`;
    }

    if (engine === 'mysql') {
      // MySQL insert template — skip auto_increment columns
      const extraSql = `
SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${dialect.quoteLiteral(schema)}
  AND TABLE_NAME = ${dialect.quoteLiteral(table)}
  AND EXTRA LIKE '%auto_increment%'`;
      const autoIncRows = await this.queryAny<{ COLUMN_NAME: string }>(
        connectionId,
        extraSql,
        database
      );
      const autoIncCols = new Set(autoIncRows.map(r => r.COLUMN_NAME));

      const nonAutoCols = columns.filter(c => !autoIncCols.has(c.name));
      const colNames = nonAutoCols.map(c => dialect.quoteIdentifier(c.name)).join(', ');
      const values = nonAutoCols.map(c => `/* ${c.dataType} */`).join(', ');
      return `INSERT INTO ${dialect.quoteSchemaObject(schema, table)} (${colNames})\nVALUES (${values});`;
    }

    // SQL Server path
    const columnData = columns.map(c => ({
      name: c.name,
      dataType: c.dataType,
      isIdentity: false,
    }));

    const columnsSql = TsqlBuilder.getTableScriptData(database, schema, table);
    const result = await this.poolManager.query<{
      columnName: string;
      isIdentity: boolean;
    }>(connectionId, columnsSql, database);

    for (const r of result.recordset) {
      const col = columnData.find(c => c.name === r.columnName);
      if (col) {
        col.isIdentity = Boolean(r.isIdentity);
      }
    }

    return TsqlBuilder.generateInsertTemplate(schema, table, columnData);
  }

  /**
   * Get enriched column metadata for a table with PK/FK info
   * Returns data in the format expected by ColumnMetadata (for query results)
   */
  async getEnrichedColumnMetadata(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<
    Array<{
      name: string;
      type: string;
      nullable: boolean;
      maxLength: number | null;
      precision: number | null;
      scale: number | null;
      isPrimaryKey: boolean;
      isIdentity: boolean;
      defaultValue: string | null;
      foreignKey: {
        referencedSchema: string;
        referencedTable: string;
        referencedColumn: string;
        constraintName: string;
      } | null;
    }>
  > {
    // Get columns and FK info in parallel
    const [columns, foreignKeys] = await Promise.all([
      this.listColumns(connectionId, database, schema, table),
      this.listForeignKeys(connectionId, database, schema, table),
    ]);

    const engine = this.poolManager.getEngineForProfile(connectionId);

    // Get identity column info (MSSQL uses TsqlBuilder, PG uses column defaults)
    const identityMap = new Map<string, { isIdentity: boolean; defaultValue: string }>();
    if (engine === 'postgresql') {
      // PG: detect identity from column defaults (nextval, GENERATED)
      for (const col of columns) {
        const def = col.defaultValue?.toLowerCase() || '';
        const isId = def.includes('nextval(') || def.includes('generated');
        identityMap.set(col.name, { isIdentity: isId, defaultValue: col.defaultValue || '' });
      }
    } else if (engine === 'mysql') {
      // MySQL: detect auto_increment from information_schema.COLUMNS.EXTRA
      const dialect = this.getDialect(connectionId);
      const extraSql = `
SELECT COLUMN_NAME, EXTRA, COLUMN_DEFAULT FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${dialect.quoteLiteral(schema)}
  AND TABLE_NAME = ${dialect.quoteLiteral(table)}`;
      const extraRows = await this.queryAny<{
        COLUMN_NAME: string;
        EXTRA: string;
        COLUMN_DEFAULT: string | null;
      }>(connectionId, extraSql, database);
      for (const r of extraRows) {
        identityMap.set(r.COLUMN_NAME, {
          isIdentity: r.EXTRA?.includes('auto_increment') ?? false,
          defaultValue: r.COLUMN_DEFAULT || '',
        });
      }
    } else {
      const identitySql = TsqlBuilder.getTableScriptData(database, schema, table);
      const identityResult = await this.poolManager.query<{
        columnName: string;
        isIdentity: boolean;
        defaultValue: string;
      }>(connectionId, identitySql, database);
      for (const r of identityResult.recordset) {
        identityMap.set(r.columnName, {
          isIdentity: Boolean(r.isIdentity),
          defaultValue: r.defaultValue,
        });
      }
    }

    // Build a map of column -> FK info
    const fkMap = new Map<
      string,
      {
        referencedSchema: string;
        referencedTable: string;
        referencedColumn: string;
        constraintName: string;
      }
    >();
    for (const fk of foreignKeys) {
      // Handle composite FKs - each column maps to corresponding referenced column
      const cols = fk.columns;
      const refCols = fk.referencedColumns;
      for (let i = 0; i < cols.length; i++) {
        fkMap.set(cols[i], {
          referencedSchema: fk.referencedSchema,
          referencedTable: fk.referencedTable,
          referencedColumn: refCols[i] || refCols[0],
          constraintName: fk.name,
        });
      }
    }

    return columns.map(col => ({
      name: col.name,
      type: col.dataType,
      nullable: col.isNullable,
      maxLength: col.maxLength ?? null,
      precision: col.precision ?? null,
      scale: col.scale ?? null,
      isPrimaryKey: col.isPrimaryKey ?? false,
      isIdentity: identityMap.get(col.name)?.isIdentity ?? false,
      defaultValue: identityMap.get(col.name)?.defaultValue ?? null,
      foreignKey: fkMap.get(col.name) ?? null,
    }));
  }

  /**
   * Invalidate all caches for a connection
   */
  invalidateConnection(connectionId: string): void {
    this.databaseCache.invalidatePrefix(`databases:${connectionId}`);
    this.tableCache.invalidatePrefix(`tables:${connectionId}`);
    this.viewCache.invalidatePrefix(`views:${connectionId}`);
    this.procedureCache.invalidatePrefix(`procedures:${connectionId}`);
    this.functionCache.invalidatePrefix(`functions:${connectionId}`);
  }

  /**
   * Invalidate database list cache for a connection
   */
  invalidateDatabases(connectionId: string): void {
    this.databaseCache.invalidatePrefix(`databases:${connectionId}`);
  }

  /**
   * Clear all caches
   */
  clearAllCaches(): void {
    this.databaseCache.clear();
    this.tableCache.clear();
    this.viewCache.clear();
    this.procedureCache.clear();
  }
}
