/**
 * J-147 — every `MetadataService` entry point, executed against a live PostgreSQL and MySQL.
 *
 * Why this file exists: `PgDialect.listTriggersQuery` shipped `NOT t.tgenabled::boolean`, which
 * PostgreSQL refuses at PARSE time (`cannot cast type "char" to boolean`). It had therefore never
 * returned a row in any shipped build, and it took a human running the query by hand to notice —
 * nothing in the repo had ever executed that SQL against a server. The unit tier asserts the SQL
 * *text*, which cannot tell a valid query from an invalid one, and `metadata-bound-parameters.spec.ts`
 * only reaches `listTables` / `listColumns` / `listIndexes` / `listForeignKeys` / `getTableProperties`.
 *
 * So the property under test here is deliberately coarse and total: **every public entry point on
 * `MetadataService` runs against each engine at least once, on objects that actually exist**. A
 * query the server refuses to parse fails this tier, whatever the reason. The assertions on the
 * returned rows are the second layer — they are what catches a query that parses and answers
 * wrongly, which is how the `tgtype` bit mapping below was found.
 *
 * MSSQL is deliberately out of scope. J-147 asks for the engines whose metadata SQL had no live
 * coverage at all, which is PostgreSQL and MySQL; SQL Server's side of `MetadataService` is
 * `TsqlBuilder`, a separate surface that needs its own T-SQL fixture objects and its own audit.
 * That is filed as a follow-up rather than bolted on here.
 *
 * Doubles: the only fake here is the connection-profile store, mocked exactly as
 * `tests/integration/metadata/metadata-bound-parameters.spec.ts` mocks it, so the real
 * `ConnectionPoolManager` opens real `pg` / `mysql2` pools without touching the Keychain. Every
 * other object in the flow — dialects, pool manager, `MetadataService` — is the production one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { DatabaseEngine } from '@joinery/shared';

import {
  applyFixture,
  execInDatabase,
  TEST_CONNECTIONS,
  withFreshDatabase,
  type Engine,
} from '../../helpers/db-fixtures.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeProfiles: Map<string, any> = new Map();
const fakePasswords: Map<string, string> = new Map();

vi.mock('@joinery/main/services/config/connection-profiles', () => ({
  ConnectionProfilesStore: {
    getInstance: () => ({
      getById: (id: string) => fakeProfiles.get(id),
      getPassword: async (id: string) => fakePasswords.get(id) ?? null,
    }),
  },
}));

const { ConnectionPoolManager } = await import('@joinery/main/services/sql/connection-pool');
const { MetadataService } = await import('@joinery/main/services/sql/metadata');

const ENGINES: Engine[] = ['postgres', 'mysql'];

const ENGINE_FOR_PROFILE: Record<Engine, DatabaseEngine> = {
  mssql: 'mssql',
  postgres: 'postgresql',
  mysql: 'mysql',
};

/**
 * Extra objects the canned fixtures do not create. Without them `listViews`, `listProcedures`,
 * `listFunctions`, `listTriggers`, `listExtendedProperties` and `getObjectDefinition` would only
 * prove "the server parsed it", never "the server answered with the object".
 *
 * MySQL routine and trigger bodies are single-statement on purpose: `execInDatabase` opens the
 * MySQL connection with `multipleStatements`, so a `;` inside a `BEGIN … END` would split.
 */
const EXTRA_OBJECTS: Record<'postgres' | 'mysql', string> = {
  postgres: `
CREATE VIEW active_products AS SELECT id, sku, name FROM products WHERE active;
CREATE FUNCTION product_count() RETURNS integer LANGUAGE sql AS 'SELECT count(*)::int FROM products';
CREATE PROCEDURE touch_products() LANGUAGE sql AS 'UPDATE products SET name = name';
CREATE FUNCTION products_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE TRIGGER trg_products_update BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_audit();
ALTER TABLE products ADD CONSTRAINT ck_products_price CHECK (price_cents >= 0);
COMMENT ON TABLE products IS 'Fixture products table';
COMMENT ON COLUMN products.sku IS 'Stock keeping unit';
`,
  mysql: `
CREATE VIEW active_products AS SELECT id, sku, name FROM products WHERE active = 1;
CREATE FUNCTION product_count() RETURNS INT DETERMINISTIC READS SQL DATA
  RETURN (SELECT COUNT(*) FROM products);
CREATE PROCEDURE touch_products() UPDATE products SET name = name;
CREATE TRIGGER trg_products_update BEFORE UPDATE ON products
  FOR EACH ROW SET NEW.name = NEW.name;
ALTER TABLE products ADD CONSTRAINT ck_products_price CHECK (price_cents >= 0);
ALTER TABLE products COMMENT = 'Fixture products table';
ALTER TABLE products MODIFY sku VARCHAR(32) NOT NULL COMMENT 'Stock keeping unit';
`,
};

describe.each(ENGINES)('MetadataService entry points on %s (J-147)', engine => {
  afterEach(() => {
    MetadataService.resetInstance();
    fakeProfiles.clear();
    fakePasswords.clear();
  });

  it('executes every entry point against a live server', async () => {
    await withFreshDatabase(engine, async db => {
      await applyFixture(engine, db.databaseName, 'seed');
      await execInDatabase(engine, db.databaseName, EXTRA_OBJECTS[engine as 'postgres' | 'mysql']);

      const { database, schema } = metadataArgs(engine, db.databaseName);
      const connectionId = registerProfile(engine, db.databaseName);
      const metadata = MetadataService.getInstance();

      try {
        // ── server- and database-level ──────────────────────────────────
        const databases = await metadata.listDatabases(connectionId, true);
        expect(databases.map(d => d.name)).toContain(db.databaseName);

        const schemas = await metadata.listSchemas(connectionId, database, true);
        expect(schemas.map(s => s.name)).toContain(schema);

        const tables = await metadata.listTables(connectionId, database, true);
        expect(tables.map(t => t.name.toLowerCase())).toContain('products');

        const views = await metadata.listViews(connectionId, database, true);
        expect(views.map(v => v.name.toLowerCase())).toContain('active_products');

        const procedures = await metadata.listProcedures(connectionId, database, true);
        expect(procedures.map(p => p.name.toLowerCase())).toContain('touch_products');

        const functions = await metadata.listFunctions(connectionId, database, true);
        expect(functions.map(f => f.name.toLowerCase())).toContain('product_count');

        // ── object definition ───────────────────────────────────────────
        const viewDef = await metadata.getObjectDefinition(
          connectionId,
          database,
          schema,
          'active_products',
          'view'
        );
        expect(viewDef.definition).not.toBe('-- Definition not available');
        expect(viewDef.definition.toLowerCase()).toContain('products');

        // The second arm of the query's COALESCE — `pg_get_functiondef` on PostgreSQL,
        // `ROUTINE_DEFINITION` on MySQL — which the view above never reaches.
        const functionDef = await metadata.getObjectDefinition(
          connectionId,
          database,
          schema,
          'product_count',
          'function'
        );
        expect(functionDef.definition).not.toBe('-- Definition not available');
        expect(functionDef.definition.toLowerCase()).toContain('count');

        // ── table-level ─────────────────────────────────────────────────
        const columns = await metadata.listColumns(connectionId, database, schema, 'products');
        expect(columns.map(c => c.name.toLowerCase())).toContain('sku');

        const indexes = await metadata.listIndexes(connectionId, database, schema, 'products');
        expect(indexes.map(i => i.name.toLowerCase())).toContain('ix_products_category');

        const foreignKeys = await metadata.listForeignKeys(
          connectionId,
          database,
          schema,
          'orders'
        );
        expect(foreignKeys.map(f => f.referencedTable.toLowerCase())).toContain('customers');

        const constraints = await metadata.listConstraints(
          connectionId,
          database,
          schema,
          'products'
        );
        expect(constraints.map(c => c.name.toLowerCase())).toContain('ck_products_price');

        // The regression this ticket records: on PostgreSQL this used to raise
        // `cannot cast type "char" to boolean` before the query reached the catalogue.
        const triggers = await metadata.listTriggers(connectionId, database, schema, 'products');
        expect(triggers.map(t => t.name.toLowerCase())).toContain('trg_products_update');
        const trigger = triggers.find(t => t.name.toLowerCase() === 'trg_products_update')!;
        expect(trigger.isEnabled).toBe(true);
        // The trigger is `BEFORE UPDATE`, and nothing else.
        expect(trigger.triggerType).toBe('update');

        const properties = await metadata.listExtendedProperties(
          connectionId,
          database,
          schema,
          'products'
        );
        expect(properties.map(p => p.value)).toContain('Stock keeping unit');

        // ── the fan-out dialog, which rejects wholesale if any arm above throws ──
        const tableProperties = await metadata.getTableProperties(
          connectionId,
          database,
          schema,
          'products'
        );
        expect(tableProperties.name.toLowerCase()).toBe('products');
        expect(tableProperties.triggers.map(t => t.name.toLowerCase())).toContain(
          'trg_products_update'
        );

        // ── scripting ───────────────────────────────────────────────────
        const createScript = await metadata.scriptTableAsCreate(
          connectionId,
          database,
          schema,
          'products'
        );
        expect(createScript).toContain('CREATE TABLE');
        expect(createScript.toLowerCase()).toContain('sku');

        const insertScript = await metadata.scriptTableAsInsert(
          connectionId,
          database,
          schema,
          'products'
        );
        expect(insertScript).toContain('INSERT INTO');
        // `id` is SERIAL / AUTO_INCREMENT on both engines, so it must be skipped.
        expect(insertScript.toLowerCase()).not.toContain('"id"');
        expect(insertScript.toLowerCase()).not.toContain('`id`');

        const enriched = await metadata.getEnrichedColumnMetadata(
          connectionId,
          database,
          schema,
          'orders'
        );
        const customerId = enriched.find(c => c.name.toLowerCase() === 'customer_id');
        expect(customerId, 'expected a customer_id column').toBeDefined();
        expect(customerId!.foreignKey?.referencedTable.toLowerCase()).toBe('customers');
        const orderId = enriched.find(c => c.name.toLowerCase() === 'id');
        expect(orderId!.isIdentity).toBe(true);
      } finally {
        await closeJoineryPools();
      }
    });
  });
});

/**
 * The PostgreSQL trigger list on its own, because the shared test above only reaches one arm of
 * the `tgtype` CASE and one value of `tgenabled` — and both of those were wrong in shipped builds
 * (J-135 for the `::boolean` cast, J-147 for the bit numbering). Every arm gets a trigger here.
 */
describe('PgDialect trigger list against a live server (J-147)', () => {
  afterEach(() => {
    MetadataService.resetInstance();
    fakeProfiles.clear();
    fakePasswords.clear();
  });

  it("reports each trigger's own event, and a disabled trigger as disabled", async () => {
    await withFreshDatabase('postgres', async db => {
      await execInDatabase(
        'postgres',
        db.databaseName,
        `
CREATE VIEW products_view AS SELECT * FROM products;
CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE TRIGGER tg_update BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION noop();
CREATE TRIGGER tg_delete AFTER DELETE ON products FOR EACH ROW EXECUTE FUNCTION noop();
CREATE TRIGGER tg_insert AFTER INSERT ON products FOR EACH ROW EXECUTE FUNCTION noop();
CREATE TRIGGER tg_instead INSTEAD OF INSERT ON products_view
  FOR EACH ROW EXECUTE FUNCTION noop();
ALTER TABLE products DISABLE TRIGGER tg_delete;
`
      );

      const connectionId = registerProfile('postgres', db.databaseName);
      const metadata = MetadataService.getInstance();

      try {
        const triggers = await metadata.listTriggers(
          connectionId,
          db.databaseName,
          'public',
          'products'
        );
        const byName = new Map(triggers.map(t => [t.name, t]));

        // Every one of these is a ROW trigger, so `tgtype` bit 1 is set on all of them: testing
        // that bit first is what made all three report 'insert'.
        expect(byName.get('tg_insert')?.triggerType).toBe('insert');
        expect(byName.get('tg_update')?.triggerType).toBe('update');
        expect(byName.get('tg_delete')?.triggerType).toBe('delete');

        expect(byName.get('tg_insert')?.isEnabled).toBe(true);
        expect(byName.get('tg_delete')?.isEnabled).toBe(false);

        const viewTriggers = await metadata.listTriggers(
          connectionId,
          db.databaseName,
          'public',
          'products_view'
        );
        expect(viewTriggers.map(t => t.triggerType)).toEqual(['instead_of']);
      } finally {
        await closeJoineryPools();
      }
    });
  });
});

// ---- helpers (same shape as metadata-bound-parameters.spec.ts) ----

/**
 * The `(database, schema)` pair `MetadataService` is called with per engine: `public` on
 * PostgreSQL, and the database itself on MySQL, which conflates the two.
 */
function metadataArgs(engine: Engine, dbName: string): { database: string; schema: string } {
  switch (engine) {
    case 'mssql':
      return { database: dbName, schema: 'dbo' };
    case 'postgres':
      return { database: dbName, schema: 'public' };
    case 'mysql':
      return { database: dbName, schema: dbName };
  }
}

/**
 * Release Joinery's own pools before the fixture drops the database out from under them —
 * PostgreSQL's `DROP DATABASE … (FORCE)` otherwise kills a live backend and node-pg raises an
 * unhandled 57P01.
 */
async function closeJoineryPools(): Promise<void> {
  await ConnectionPoolManager.getInstance().closeAll();
  ConnectionPoolManager.resetInstance();
}

/** Register a connection profile pointing at `dbName`, and return its id. */
function registerProfile(engine: Engine, dbName: string): string {
  const connectionId = randomUUID();
  const c = TEST_CONNECTIONS[engine];

  fakeProfiles.set(connectionId, {
    id: connectionId,
    name: `${engine}-j147`,
    server: c.host,
    port: c.port,
    username: c.user,
    database: dbName,
    engine: ENGINE_FOR_PROFILE[engine],
  });
  fakePasswords.set(connectionId, c.password);
  return connectionId;
}
