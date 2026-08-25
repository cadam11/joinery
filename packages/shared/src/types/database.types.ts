/**
 * Database-related type definitions
 */

export type DatabaseState = 'online' | 'offline' | 'restoring' | 'recovering' | 'suspect';
export type RecoveryModel = 'simple' | 'full' | 'bulk_logged';
export type ObjectType =
  'database' | 'table' | 'view' | 'procedure' | 'function' | 'index' | 'trigger' | 'column';

export interface DatabaseInfo {
  name: string;
  databaseId?: number;
  sizeBytes?: number;
  sizeMB?: number;
  state: DatabaseState;
  recoveryModel?: RecoveryModel;
  collation?: string;
  compatibilityLevel?: number;
  isSystemDb?: boolean;
  createdAt?: string;
  lastBackupDate?: string;
  lastLogBackupDate?: string;
}

export interface CreateDatabaseOptions {
  name: string;
  collation?: string;
  recoveryModel?: RecoveryModel;
}

export interface RenameDatabaseOptions {
  currentName: string;
  newName: string;
  closeConnections?: boolean;
}

export interface DeleteDatabaseOptions {
  name: string;
  closeConnections?: boolean;
}

// Unified result type for database operations
export interface DatabaseOperationResult {
  success: boolean;
  /** The SQL statement that was executed (T-SQL, PL/pgSQL, or MySQL) */
  tsql: string;
  error?: string;
  message?: string;
}

// Legacy aliases
export type CreateDatabaseResult = DatabaseOperationResult;
export type RenameDatabaseResult = DatabaseOperationResult;
export type DeleteDatabaseResult = DatabaseOperationResult;

export interface SchemaInfo {
  name: string;
  owner?: string;
  isSystem: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  rowCount?: number;
  sizeKb?: number;
  createdAt?: string;
}

export interface ViewInfo {
  schema: string;
  name: string;
  createdAt?: string;
}

export interface ProcedureInfo {
  schema: string;
  name: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface FunctionInfo {
  schema: string;
  name: string;
  type: 'Scalar' | 'Table-valued' | 'Inline Table-valued';
  createdAt?: string;
  modifiedAt?: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isNullable: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  defaultValue?: string;
  ordinalPosition: number;
}

export interface IndexInfo {
  name: string;
  type: 'clustered' | 'nonclustered' | 'unique' | 'primary' | 'xml' | 'spatial';
  columns: string[];
  isUnique: boolean;
  isPrimaryKey?: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema: string;
  referencedColumns: string[];
  onDelete?: 'no_action' | 'cascade' | 'set_null' | 'set_default';
  onUpdate?: 'no_action' | 'cascade' | 'set_null' | 'set_default';
}

export interface ConstraintInfo {
  name: string;
  type: 'primary_key' | 'foreign_key' | 'unique' | 'check' | 'default';
  columns: string[];
  definition?: string;
}

export interface TriggerInfo {
  name: string;
  isEnabled: boolean;
  triggerType: 'insert' | 'update' | 'delete' | 'instead_of';
  createdAt?: string;
}

export interface TableMetadata {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
  rowCount?: number;
  sizeKb?: number;
  createdAt?: string;
}

export interface ObjectMetadata {
  name: string;
  type: ObjectType | string;
  schema: string;
  database?: string;
  definition?: string;
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  createdAt?: string;
  modifiedAt?: string;
}

export interface ObjectDefinition {
  objectType: 'table' | 'view' | 'procedure' | 'function';
  schema: string;
  name: string;
  definition: string;
}

/**
 * Extended Property - SQL Server's way of adding documentation/metadata to objects
 * See: sp_addextendedproperty, fn_listextendedproperty
 */
export interface ExtendedProperty {
  name: string;
  value: string;
  level0Type?: string; // 'SCHEMA'
  level0Name?: string; // schema name
  level1Type?: string; // 'TABLE', 'VIEW', etc.
  level1Name?: string; // object name
  level2Type?: string; // 'COLUMN', 'INDEX', etc.
  level2Name?: string; // column/index name
}

/**
 * Comprehensive table properties including storage, space, and metadata
 */
export interface TableProperties {
  // Basic Info
  schema: string;
  name: string;
  objectId: number;
  createdAt: string;
  modifiedAt?: string;

  // Storage & Space
  rowCount: number;
  dataSpaceKb: number;
  indexSpaceKb: number;
  unusedSpaceKb: number;
  totalSpaceKb: number;

  // Table Settings
  hasIdentity: boolean;
  identityColumn?: string;
  identitySeed?: number;
  identityIncrement?: number;
  isReplicated: boolean;
  hasTextImage: boolean;
  textImageOnFilegroup?: string;
  filegroup: string;

  // Additional metadata
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
  extendedProperties: ExtendedProperty[];
}
