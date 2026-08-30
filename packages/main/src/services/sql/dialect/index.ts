/**
 * SQL Dialect Registry
 *
 * Factory for getting the correct dialect instance per database engine.
 */

import type { DatabaseEngine, EngineCapabilities, EngineVariant } from '@joinery/shared';
import { SQLDialect } from './sql-dialect';
import { MSSQLDialect } from './mssql-dialect';
import { PgDialect } from './pg-dialect';
import { PgDsqlDialect } from './pg-dsql-dialect';
import { MySQLDialect } from './mysql-dialect';

export { SQLDialect } from './sql-dialect';
export {
  BoundValues,
  unboundQuery,
  placeholderFor,
  type ParameterisedQuery,
  type PlaceholderStyle,
} from './parameterised-query';
export { MSSQLDialect } from './mssql-dialect';
export { PgDialect } from './pg-dialect';
export { PgDsqlDialect } from './pg-dsql-dialect';
export { MySQLDialect } from './mysql-dialect';

const dialects: Record<DatabaseEngine, SQLDialect> = {
  mssql: new MSSQLDialect(),
  postgresql: new PgDialect(),
  mysql: new MySQLDialect(),
};

const pgDsqlDialect = new PgDsqlDialect();

/** Get the dialect instance for a given database engine (and optional variant) */
export function getDialect(engine: DatabaseEngine, variant?: EngineVariant): SQLDialect {
  if (engine === 'postgresql' && variant === 'dsql') {
    return pgDsqlDialect;
  }
  return dialects[engine];
}

/** App-level capabilities derived from a dialect, shipped to the renderer. */
export function capabilitiesForDialect(dialect: SQLDialect): EngineCapabilities {
  return {
    supportsMultipleDatabases: dialect.supportsMultipleDatabases,
    supportsDatabaseManagement: dialect.supportsDatabaseManagement,
    supportsStoredProcedures: dialect.supportsStoredProcedures,
    supportsTriggers: dialect.supportsTriggers,
    supportsBackupRestore: dialect.supportsBackupTooling,
  };
}
