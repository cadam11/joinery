/**
 * T-SQL Builder - Generates safe T-SQL statements
 */

import type {
  CreateDatabaseOptions,
  RenameDatabaseOptions,
  DeleteDatabaseOptions,
  BackupType,
} from '@joinery/shared';

/**
 * Internal options for backup T-SQL generation (no connectionId needed)
 */
export interface BackupTsqlOptions {
  databaseName: string;
  destinationPath: string;
  backupType: BackupType | 'full_copy_only';
  compression: boolean;
  /** Emits `WITH CHECKSUM`, so the server validates pages as it writes them. */
  checksum: boolean;
  /** Emits `COPY_ONLY`, leaving the differential base and the log chain untouched. */
  copyOnly?: boolean;
  description?: string;
}

/**
 * Internal options for restore T-SQL generation (no connectionId needed)
 */
export interface RestoreTsqlOptions {
  sourcePath: string;
  targetDatabaseName: string;
  overwriteExisting: boolean;
  fileMoves: Array<{ logicalName: string; destinationPath: string }>;
  recoveryState: 'recovery' | 'norecovery' | 'standby';
}

export class TsqlBuilder {
  /**
   * Safely escape a SQL identifier (database name, table name, etc.)
   * In SQL Server, only ] needs to be escaped (as ]]) inside brackets
   */
  static escapeIdentifier(name: string): string {
    const cleaned = name.replace(/\]/g, ']]');
    return `[${cleaned}]`;
  }

  /**
   * Safely escape a string literal (escapes quotes, caller adds delimiters)
   */
  static escapeString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Generate CREATE DATABASE statement
   */
  static createDatabase(options: CreateDatabaseOptions): string {
    const name = this.escapeIdentifier(options.name);
    let sql = `CREATE DATABASE ${name}`;

    if (options.collation) {
      sql += `\nCOLLATE ${options.collation}`;
    }

    sql += ';';

    if (options.recoveryModel && options.recoveryModel !== 'full') {
      sql += `\n\nALTER DATABASE ${name}\nSET RECOVERY ${options.recoveryModel.toUpperCase()};`;
    }

    return sql;
  }

  /**
   * Generate ALTER DATABASE ... MODIFY NAME statement
   */
  static renameDatabase(options: RenameDatabaseOptions): string {
    const current = this.escapeIdentifier(options.currentName);
    const next = this.escapeIdentifier(options.newName);

    let sql = '';

    if (options.closeConnections) {
      sql += `ALTER DATABASE ${current}\nSET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n\n`;
    }

    sql += `ALTER DATABASE ${current}\nMODIFY NAME = ${next};\n\n`;
    sql += `ALTER DATABASE ${next}\nSET MULTI_USER;`;

    return sql;
  }

  /**
   * Generate DROP DATABASE statement
   */
  static dropDatabase(options: DeleteDatabaseOptions): string {
    const escaped = this.escapeIdentifier(options.name);

    let sql = '';

    if (options.closeConnections) {
      sql += `ALTER DATABASE ${escaped}\nSET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n\n`;
    }

    sql += `DROP DATABASE ${escaped};`;

    return sql;
  }

  /**
   * Alias for dropDatabase to match DeleteDatabaseOptions naming
   */
  static deleteDatabase(options: DeleteDatabaseOptions): string {
    return this.dropDatabase(options);
  }

  /**
   * Generate the `BACKUP DATABASE` — or `BACKUP LOG` — statement for `options`.
   *
   * `'log'` used to fall through both arms of the type branch and pick up `INIT` like everything
   * else, so a requested transaction-log backup ran as a FULL backup that *overwrote* the
   * destination, and reported success (J-48a). A user taking a log backup onto the file holding
   * their full backup destroyed it.
   *
   * Hence the two rules below that are not cosmetic:
   * - a log backup is `BACKUP LOG`, never `BACKUP DATABASE`;
   * - a log backup appends (`NOINIT`). Log backups form a chain, and `INIT` would discard every
   *   backup already in the file — which is the destructive half of the original bug.
   */
  static backup(options: BackupTsqlOptions): string {
    const dbName = this.escapeIdentifier(options.databaseName);
    const path = this.escapeString(options.destinationPath);
    const isLog = options.backupType === 'log';

    const verb = isLog ? 'BACKUP LOG' : 'BACKUP DATABASE';
    let sql = `${verb} ${dbName}\nTO DISK = N'${path}'\nWITH`;

    const withOptions: string[] = [];

    // COPY_ONLY is legal for a full or a log backup and meaningless for a differential, which is
    // why the union carries `full_copy_only` as well as the flag: the two spellings agree here.
    if (options.copyOnly === true || options.backupType === 'full_copy_only') {
      withOptions.push('COPY_ONLY');
    } else if (options.backupType === 'differential') {
      withOptions.push('DIFFERENTIAL');
    }

    withOptions.push(isLog ? 'NOINIT' : 'INIT');

    if (options.compression) {
      withOptions.push('COMPRESSION');
    }

    if (options.checksum) {
      withOptions.push('CHECKSUM');
    }

    if (options.description) {
      withOptions.push(`DESCRIPTION = N'${this.escapeString(options.description)}'`);
    }

    withOptions.push('STATS = 5'); // Report progress every 5%

    sql += ' ' + withOptions.join(', ') + ';';

    return sql;
  }

  /**
   * Generate RESTORE DATABASE statement
   */
  static restore(options: RestoreTsqlOptions): string {
    const dbName = this.escapeIdentifier(options.targetDatabaseName);
    const path = this.escapeString(options.sourcePath);

    let sql = `RESTORE DATABASE ${dbName}\nFROM DISK = N'${path}'\nWITH`;

    const withOptions: string[] = [];

    // File moves
    for (const move of options.fileMoves) {
      const logical = this.escapeString(move.logicalName);
      const dest = this.escapeString(move.destinationPath);
      withOptions.push(`MOVE N'${logical}' TO N'${dest}'`);
    }

    if (options.overwriteExisting) {
      withOptions.push('REPLACE');
    }

    // Recovery state. `STANDBY` used to live here as `STANDBY = N'standby.dat'` — a relative path
    // resolved against the server's working directory, so the undo file landed somewhere nobody
    // could name. Removed with the union member that reached it (J-51c).
    if (options.recoveryState === 'norecovery') {
      withOptions.push('NORECOVERY');
    } else {
      withOptions.push('RECOVERY');
    }

    withOptions.push('STATS = 5');

    sql += '\n    ' + withOptions.join(',\n    ') + ';';

    return sql;
  }

  /**
   * Generate RESTORE FILELISTONLY statement
   */
  static getBackupFileInfo(path: string): string {
    const escaped = this.escapeString(path);
    return `RESTORE FILELISTONLY FROM DISK = N'${escaped}';`;
  }

  /**
   * Generate RESTORE HEADERONLY statement
   */
  static getBackupHeaderInfo(path: string): string {
    const escaped = this.escapeString(path);
    return `RESTORE HEADERONLY FROM DISK = N'${escaped}';`;
  }

  /**
   * Generate query to list databases. Caller passes `isAzure=true` for Azure
   * SQL Database / Synapse — those engines have no msdb.dbo.backupset, and
   * SQL Server validates cross-database references at parse time, so a
   * CASE WHEN guard would not actually skip them. We split into two queries
   * instead.
   */
  static listDatabases(isAzure = false): string {
    return isAzure ? this.listDatabasesAzure() : this.listDatabasesOnPrem();
  }

  private static listDatabasesAzure(): string {
    // Azure SQL doesn't expose sys.master_files server-wide. The closest
    // we can get without per-database queries is the configured MaxSize
    // via DATABASEPROPERTYEX — that's the *quota*, not actual usage,
    // but it's still more informative than 0.
    return `
SELECT
  d.name,
  d.database_id as databaseId,
  CAST(DATABASEPROPERTYEX(d.name, 'MaxSizeInBytes') AS BIGINT) as sizeBytes,
  d.state_desc as state,
  d.recovery_model_desc as recoveryModel,
  d.collation_name as collation,
  d.compatibility_level as compatibilityLevel,
  CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END as isSystemDb,
  d.create_date as createdAt,
  CAST(NULL AS DATETIME) as lastBackupDate,
  CAST(NULL AS DATETIME) as lastLogBackupDate
FROM sys.databases d
ORDER BY d.name;`;
  }

  private static listDatabasesOnPrem(): string {
    return `
SELECT
  d.name,
  d.database_id as databaseId,
  COALESCE(SUM(CAST(f.size AS BIGINT)) * 8 * 1024, 0) as sizeBytes,
  d.state_desc as state,
  d.recovery_model_desc as recoveryModel,
  d.collation_name as collation,
  d.compatibility_level as compatibilityLevel,
  CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END as isSystemDb,
  d.create_date as createdAt,
  (SELECT MAX(backup_finish_date) FROM msdb.dbo.backupset WHERE database_name = d.name AND type = 'D') as lastBackupDate,
  (SELECT MAX(backup_finish_date) FROM msdb.dbo.backupset WHERE database_name = d.name AND type = 'L') as lastLogBackupDate
FROM sys.databases d
LEFT JOIN sys.master_files f ON d.database_id = f.database_id
GROUP BY d.name, d.database_id, d.state_desc, d.recovery_model_desc,
         d.collation_name, d.compatibility_level, d.create_date
ORDER BY d.name;`;
  }

  /**
   * Generate query to list schemas (excluding system schemas)
   */
  static listSchemas(database: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  s.name,
  p.name as owner,
  CASE
    WHEN s.name IN ('sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin',
      'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader',
      'db_datawriter', 'db_denydatareader', 'db_denydatawriter')
    THEN 1
    WHEN s.name LIKE 'db_%' THEN 1
    ELSE 0
  END as isSystem
FROM sys.schemas s
LEFT JOIN sys.database_principals p ON s.principal_id = p.principal_id
WHERE s.schema_id < 16384
ORDER BY
  CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END,
  s.name;`;
  }

  /**
   * Generate query to list tables
   */
  static listTables(database: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  s.name as [schema],
  t.name as name,
  ISNULL(p.rows, 0) as [rowCount],
  ISNULL(SUM(CAST(a.total_pages AS BIGINT)) * 8, 0) as sizeKb,
  t.create_date as createdAt
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
LEFT JOIN sys.allocation_units a ON p.partition_id = a.container_id
GROUP BY s.name, t.name, p.rows, t.create_date
ORDER BY s.name, t.name;`;
  }

  /**
   * Generate query to list views
   */
  static listViews(database: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  s.name as [schema],
  v.name as name,
  v.create_date as createdAt
FROM sys.views v
INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
ORDER BY s.name, v.name;`;
  }

  /**
   * Generate query to list stored procedures
   */
  static listProcedures(database: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  s.name as [schema],
  p.name as name,
  p.create_date as createdAt,
  p.modify_date as modifiedAt
FROM sys.procedures p
INNER JOIN sys.schemas s ON p.schema_id = s.schema_id
WHERE p.is_ms_shipped = 0
ORDER BY s.name, p.name;`;
  }

  /**
   * Generate query to list user-defined functions
   */
  static listFunctions(database: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  s.name as [schema],
  o.name as name,
  CASE o.type
    WHEN 'FN' THEN 'Scalar'
    WHEN 'IF' THEN 'Inline Table-valued'
    WHEN 'TF' THEN 'Table-valued'
    ELSE o.type_desc
  END as [type],
  o.create_date as createdAt,
  o.modify_date as modifiedAt
FROM sys.objects o
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE o.type IN ('FN', 'IF', 'TF')
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name;`;
  }

  /**
   * Generate query to get object definition
   */
  static getObjectDefinition(database: string, schema: string, name: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT OBJECT_DEFINITION(OBJECT_ID('${this.escapeString(schema)}.${this.escapeString(name)}')) as definition;`;
  }

  /**
   * Generate query to list columns for a table
   */
  static listColumns(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  c.name,
  t.name as dataType,
  c.max_length as maxLength,
  c.precision,
  c.scale,
  c.is_nullable as isNullable,
  CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END as isPrimaryKey,
  CASE WHEN fk.parent_column_id IS NOT NULL THEN 1 ELSE 0 END as isForeignKey,
  dc.definition as defaultValue,
  c.column_id as ordinalPosition
FROM sys.columns c
INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
INNER JOIN sys.objects o ON c.object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
LEFT JOIN (
  SELECT ic.column_id, ic.object_id
  FROM sys.index_columns ic
  INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.is_primary_key = 1
) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
LEFT JOIN sys.foreign_key_columns fk ON c.object_id = fk.parent_object_id AND c.column_id = fk.parent_column_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
ORDER BY c.column_id;`;
  }

  /**
   * Generate query to list indexes for a table
   */
  static listIndexes(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  i.name,
  CASE i.type
    WHEN 1 THEN 'clustered'
    WHEN 2 THEN 'nonclustered'
    WHEN 3 THEN 'xml'
    WHEN 4 THEN 'spatial'
    ELSE 'nonclustered'
  END as type,
  i.is_unique as isUnique,
  i.is_primary_key as isPrimaryKey,
  STUFF((
    SELECT ', ' + c.name
    FROM sys.index_columns ic
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
    ORDER BY ic.key_ordinal
    FOR XML PATH('')
  ), 1, 2, '') as columns
FROM sys.indexes i
INNER JOIN sys.objects o ON i.object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
  AND i.name IS NOT NULL
ORDER BY i.is_primary_key DESC, i.name;`;
  }

  /**
   * Generate query to list foreign keys for a table
   */
  static listForeignKeys(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  fk.name,
  STUFF((
    SELECT ', ' + c.name
    FROM sys.foreign_key_columns fkc
    INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
    WHERE fkc.constraint_object_id = fk.object_id
    ORDER BY fkc.constraint_column_id
    FOR XML PATH('')
  ), 1, 2, '') as columns,
  rs.name as referencedSchema,
  OBJECT_NAME(fk.referenced_object_id) as referencedTable,
  STUFF((
    SELECT ', ' + c.name
    FROM sys.foreign_key_columns fkc
    INNER JOIN sys.columns c ON fkc.referenced_object_id = c.object_id AND fkc.referenced_column_id = c.column_id
    WHERE fkc.constraint_object_id = fk.object_id
    ORDER BY fkc.constraint_column_id
    FOR XML PATH('')
  ), 1, 2, '') as referencedColumns,
  CASE fk.delete_referential_action
    WHEN 0 THEN 'no_action'
    WHEN 1 THEN 'cascade'
    WHEN 2 THEN 'set_null'
    WHEN 3 THEN 'set_default'
  END as onDelete,
  CASE fk.update_referential_action
    WHEN 0 THEN 'no_action'
    WHEN 1 THEN 'cascade'
    WHEN 2 THEN 'set_null'
    WHEN 3 THEN 'set_default'
  END as onUpdate
FROM sys.foreign_keys fk
INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
INNER JOIN sys.schemas rs ON fk.schema_id = rs.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
ORDER BY fk.name;`;
  }

  /**
   * Generate query to list constraints for a table
   */
  static listConstraints(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  kc.name,
  CASE kc.type
    WHEN 'PK' THEN 'primary_key'
    WHEN 'UQ' THEN 'unique'
  END as type,
  STUFF((
    SELECT ', ' + c.name
    FROM sys.index_columns ic
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
    ORDER BY ic.key_ordinal
    FOR XML PATH('')
  ), 1, 2, '') as columns,
  NULL as definition
FROM sys.key_constraints kc
INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'

UNION ALL

SELECT
  cc.name,
  'check' as type,
  NULL as columns,
  cc.definition
FROM sys.check_constraints cc
INNER JOIN sys.objects o ON cc.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'

UNION ALL

SELECT
  dc.name,
  'default' as type,
  c.name as columns,
  dc.definition
FROM sys.default_constraints dc
INNER JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
INNER JOIN sys.objects o ON dc.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'

ORDER BY type, name;`;
  }

  /**
   * Generate query to list triggers for a table
   */
  static listTriggers(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  t.name,
  t.is_disabled as isDisabled,
  CASE
    WHEN t.is_instead_of_trigger = 1 THEN 'instead_of'
    WHEN EXISTS(SELECT 1 FROM sys.trigger_events te WHERE te.object_id = t.object_id AND te.type = 1) THEN 'insert'
    WHEN EXISTS(SELECT 1 FROM sys.trigger_events te WHERE te.object_id = t.object_id AND te.type = 2) THEN 'update'
    WHEN EXISTS(SELECT 1 FROM sys.trigger_events te WHERE te.object_id = t.object_id AND te.type = 3) THEN 'delete'
    ELSE 'unknown'
  END as triggerType,
  t.create_date as createdAt
FROM sys.triggers t
INNER JOIN sys.objects o ON t.parent_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
ORDER BY t.name;`;
  }

  /**
   * Generate query to get extended properties for a table and its columns
   */
  static listExtendedProperties(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
-- Get table-level extended properties
SELECT
  ep.name,
  CAST(ep.value AS NVARCHAR(MAX)) as value,
  'SCHEMA' as level0Type,
  '${this.escapeString(schema)}' as level0Name,
  'TABLE' as level1Type,
  '${this.escapeString(table)}' as level1Name,
  NULL as level2Type,
  NULL as level2Name
FROM sys.extended_properties ep
INNER JOIN sys.objects o ON ep.major_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
  AND ep.minor_id = 0

UNION ALL

-- Get column-level extended properties
SELECT
  ep.name,
  CAST(ep.value AS NVARCHAR(MAX)) as value,
  'SCHEMA' as level0Type,
  '${this.escapeString(schema)}' as level0Name,
  'TABLE' as level1Type,
  '${this.escapeString(table)}' as level1Name,
  'COLUMN' as level2Type,
  c.name as level2Name
FROM sys.extended_properties ep
INNER JOIN sys.objects o ON ep.major_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
INNER JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
  AND ep.minor_id > 0

ORDER BY level2Type, level2Name, name;`;
  }

  /**
   * Generate query to get comprehensive table properties
   */
  static getTableProperties(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  s.name as [schema],
  t.name as name,
  t.object_id as objectId,
  t.create_date as createdAt,
  t.modify_date as modifiedAt,

  -- Row count
  ISNULL(SUM(p.rows), 0) as [rowCount],

  -- Space info
  ISNULL(SUM(CASE WHEN a.type = 1 THEN a.total_pages END) * 8, 0) as dataSpaceKb,
  ISNULL(SUM(CASE WHEN a.type = 2 THEN a.total_pages END) * 8, 0) as indexSpaceKb,
  ISNULL(SUM(a.total_pages - a.used_pages) * 8, 0) as unusedSpaceKb,
  ISNULL(SUM(a.total_pages) * 8, 0) as totalSpaceKb,

  -- Identity info (using sys.identity_columns for reliability)
  CASE WHEN idc.object_id IS NOT NULL THEN 1 ELSE 0 END as hasIdentity,
  idc.name as identityColumn,
  idc.seed_value as identitySeed,
  idc.increment_value as identityIncrement,

  -- Replication & text image
  t.is_replicated as isReplicated,
  CASE WHEN t.lob_data_space_id > 0 THEN 1 ELSE 0 END as hasTextImage,
  tids.name as textImageOnFilegroup,

  -- Filegroup
  fg.name as filegroup

FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
LEFT JOIN sys.allocation_units a ON p.partition_id = a.container_id
LEFT JOIN sys.indexes i ON t.object_id = i.object_id AND i.type IN (0, 1)
LEFT JOIN sys.filegroups fg ON i.data_space_id = fg.data_space_id
LEFT JOIN sys.data_spaces tids ON t.lob_data_space_id = tids.data_space_id
LEFT JOIN sys.identity_columns idc ON t.object_id = idc.object_id
WHERE s.name = '${this.escapeString(schema)}'
  AND t.name = '${this.escapeString(table)}'
GROUP BY s.name, t.name, t.object_id, t.create_date, t.modify_date,
         idc.object_id, idc.name, idc.seed_value, idc.increment_value,
         t.is_replicated, t.lob_data_space_id, tids.name, fg.name;`;
  }

  /**
   * Generate T-SQL to add an extended property
   */
  static addExtendedProperty(
    database: string,
    schema: string,
    table: string,
    propertyName: string,
    propertyValue: string,
    column?: string
  ): string {
    const escapedValue = this.escapeString(propertyValue);
    const escapedName = this.escapeString(propertyName);

    if (column) {
      return `
USE ${this.escapeIdentifier(database)};
EXEC sp_addextendedproperty
  @name = N'${escapedName}',
  @value = N'${escapedValue}',
  @level0type = N'SCHEMA', @level0name = N'${this.escapeString(schema)}',
  @level1type = N'TABLE', @level1name = N'${this.escapeString(table)}',
  @level2type = N'COLUMN', @level2name = N'${this.escapeString(column)}';`;
    }

    return `
USE ${this.escapeIdentifier(database)};
EXEC sp_addextendedproperty
  @name = N'${escapedName}',
  @value = N'${escapedValue}',
  @level0type = N'SCHEMA', @level0name = N'${this.escapeString(schema)}',
  @level1type = N'TABLE', @level1name = N'${this.escapeString(table)}';`;
  }

  /**
   * Generate T-SQL to update an extended property
   */
  static updateExtendedProperty(
    database: string,
    schema: string,
    table: string,
    propertyName: string,
    propertyValue: string,
    column?: string
  ): string {
    const escapedValue = this.escapeString(propertyValue);
    const escapedName = this.escapeString(propertyName);

    if (column) {
      return `
USE ${this.escapeIdentifier(database)};
EXEC sp_updateextendedproperty
  @name = N'${escapedName}',
  @value = N'${escapedValue}',
  @level0type = N'SCHEMA', @level0name = N'${this.escapeString(schema)}',
  @level1type = N'TABLE', @level1name = N'${this.escapeString(table)}',
  @level2type = N'COLUMN', @level2name = N'${this.escapeString(column)}';`;
    }

    return `
USE ${this.escapeIdentifier(database)};
EXEC sp_updateextendedproperty
  @name = N'${escapedName}',
  @value = N'${escapedValue}',
  @level0type = N'SCHEMA', @level0name = N'${this.escapeString(schema)}',
  @level1type = N'TABLE', @level1name = N'${this.escapeString(table)}';`;
  }

  /**
   * Generate T-SQL to drop an extended property
   */
  static dropExtendedProperty(
    database: string,
    schema: string,
    table: string,
    propertyName: string,
    column?: string
  ): string {
    const escapedName = this.escapeString(propertyName);

    if (column) {
      return `
USE ${this.escapeIdentifier(database)};
EXEC sp_dropextendedproperty
  @name = N'${escapedName}',
  @level0type = N'SCHEMA', @level0name = N'${this.escapeString(schema)}',
  @level1type = N'TABLE', @level1name = N'${this.escapeString(table)}',
  @level2type = N'COLUMN', @level2name = N'${this.escapeString(column)}';`;
    }

    return `
USE ${this.escapeIdentifier(database)};
EXEC sp_dropextendedproperty
  @name = N'${escapedName}',
  @level0type = N'SCHEMA', @level0name = N'${this.escapeString(schema)}',
  @level1type = N'TABLE', @level1name = N'${this.escapeString(table)}';`;
  }

  /**
   * Generate query to get comprehensive CREATE TABLE script data
   * This returns all the information needed to build a CREATE TABLE statement
   */
  static getTableScriptData(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};

-- Get columns with full type info
SELECT
  c.column_id as ordinalPosition,
  c.name as columnName,
  tp.name as dataType,
  c.max_length as maxLength,
  c.precision,
  c.scale,
  c.is_nullable as isNullable,
  c.is_identity as isIdentity,
  idc.seed_value as identitySeed,
  idc.increment_value as identityIncrement,
  dc.definition as defaultValue,
  dc.name as defaultConstraintName,
  cc.definition as computedDefinition,
  cc.is_persisted as computedIsPersisted
FROM sys.columns c
INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
INNER JOIN sys.objects o ON c.object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
LEFT JOIN sys.computed_columns cc ON c.object_id = cc.object_id AND c.column_id = cc.column_id
LEFT JOIN sys.identity_columns idc ON c.object_id = idc.object_id AND c.column_id = idc.column_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
ORDER BY c.column_id;`;
  }

  /**
   * Generate query to get primary key info for scripting
   */
  static getPrimaryKeyScript(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  kc.name as constraintName,
  i.type_desc as indexType,
  STUFF((
    SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
    FROM sys.index_columns ic
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ORDER BY ic.key_ordinal
    FOR XML PATH('')
  ), 1, 2, '') as columns
FROM sys.key_constraints kc
INNER JOIN sys.indexes i ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
  AND kc.type = 'PK';`;
  }

  /**
   * Generate query to get foreign keys for scripting
   */
  static getForeignKeyScript(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  fk.name as constraintName,
  STUFF((
    SELECT ', ' + QUOTENAME(c.name)
    FROM sys.foreign_key_columns fkc
    INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
    WHERE fkc.constraint_object_id = fk.object_id
    ORDER BY fkc.constraint_column_id
    FOR XML PATH('')
  ), 1, 2, '') as columns,
  SCHEMA_NAME(ro.schema_id) as referencedSchema,
  ro.name as referencedTable,
  STUFF((
    SELECT ', ' + QUOTENAME(c.name)
    FROM sys.foreign_key_columns fkc
    INNER JOIN sys.columns c ON fkc.referenced_object_id = c.object_id AND fkc.referenced_column_id = c.column_id
    WHERE fkc.constraint_object_id = fk.object_id
    ORDER BY fkc.constraint_column_id
    FOR XML PATH('')
  ), 1, 2, '') as referencedColumns,
  fk.delete_referential_action_desc as onDelete,
  fk.update_referential_action_desc as onUpdate
FROM sys.foreign_keys fk
INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id
INNER JOIN sys.objects ro ON fk.referenced_object_id = ro.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}';`;
  }

  /**
   * Generate query to get unique constraints and check constraints for scripting
   */
  static getConstraintsScript(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
-- Unique constraints
SELECT
  'UNIQUE' as constraintType,
  kc.name as constraintName,
  i.type_desc as indexType,
  STUFF((
    SELECT ', ' + QUOTENAME(c.name)
    FROM sys.index_columns ic
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ORDER BY ic.key_ordinal
    FOR XML PATH('')
  ), 1, 2, '') as columns,
  NULL as definition
FROM sys.key_constraints kc
INNER JOIN sys.indexes i ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
  AND kc.type = 'UQ'

UNION ALL

-- Check constraints
SELECT
  'CHECK' as constraintType,
  cc.name as constraintName,
  NULL as indexType,
  NULL as columns,
  cc.definition
FROM sys.check_constraints cc
INNER JOIN sys.objects o ON cc.parent_object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}';`;
  }

  /**
   * Generate query to get non-clustered indexes for scripting
   */
  static getIndexesScript(database: string, schema: string, table: string): string {
    return `
USE ${this.escapeIdentifier(database)};
SELECT
  i.name as indexName,
  i.type_desc as indexType,
  i.is_unique as isUnique,
  STUFF((
    SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
    FROM sys.index_columns ic
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ORDER BY ic.key_ordinal
    FOR XML PATH('')
  ), 1, 2, '') as keyColumns,
  STUFF((
    SELECT ', ' + QUOTENAME(c.name)
    FROM sys.index_columns ic
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
    ORDER BY ic.key_ordinal
    FOR XML PATH('')
  ), 1, 2, '') as includedColumns,
  i.filter_definition as filterDefinition
FROM sys.indexes i
INNER JOIN sys.objects o ON i.object_id = o.object_id
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE s.name = '${this.escapeString(schema)}'
  AND o.name = '${this.escapeString(table)}'
  AND i.is_primary_key = 0
  AND i.type > 0
  AND i.is_unique_constraint = 0
ORDER BY i.name;`;
  }

  /**
   * Generate INSERT statement template for a table
   */
  static generateInsertTemplate(
    schema: string,
    table: string,
    columns: Array<{ name: string; dataType: string; isIdentity: boolean }>
  ): string {
    // Filter out identity columns
    const insertColumns = columns.filter(c => !c.isIdentity);
    const columnNames = insertColumns.map(c => `[${c.name}]`).join(',\n    ');
    const valuePlaceholders = insertColumns
      .map(c => {
        // Provide type hints in comments
        const hint = this.getValuePlaceholder(c.dataType);
        return `${hint} /* ${c.name} */`;
      })
      .join(',\n    ');

    return `INSERT INTO [${schema}].[${table}] (
    ${columnNames}
)
VALUES (
    ${valuePlaceholders}
);`;
  }

  /**
   * Get a placeholder value based on data type
   */
  private static getValuePlaceholder(dataType: string): string {
    const type = dataType.toLowerCase();
    if (type.includes('char') || type.includes('text')) return "N''";
    if (type.includes('date') || type.includes('time')) return 'GETDATE()';
    if (type.includes('bit')) return '0';
    if (type.includes('int') || type.includes('decimal') || type.includes('numeric')) return '0';
    if (type.includes('float') || type.includes('real') || type.includes('money')) return '0.0';
    if (type.includes('uniqueidentifier')) return 'NEWID()';
    if (type.includes('binary') || type.includes('image')) return '0x';
    if (type.includes('xml')) return "N'<root/>'";
    return 'NULL';
  }
}
