/**
 * The packaged-app smoke tier (J-88).
 *
 * One question, asked of the artefact a user actually installs rather than of the source tree:
 * **does the packaged bundle still connect to a database and return rows?**
 *
 * ── Why this exists next to the other tiers ───────────────────────────────────────────────────
 *
 * `pnpm run verify:package` extracts `app.asar` and `require()`s each module the main process
 * depends on under plain Node — it never starts Electron. `pnpm run smoke:package`
 * (`scripts/release/smoke-packaged-app.ts`, J-90) does start it, and stops at "a window loaded the
 * renderer": no database, no query, no IPC round trip. Every tier that drives Joinery against the
 * three Docker engines — `tests/e2e-react/`, `tests/integration/` — runs the app UNPACKAGED, from
 * `packages/main/dist/index.js`.
 *
 * So nothing committed before this file ever proved that the packaged bundle can execute a query.
 * Task 24's merge gate did it once with a scratch Playwright spec that was never committed, which
 * is the gap J-88 was filed for. Every failure mode in between belongs to packaging and to nothing
 * else: an asar exclusion that removed a driver (J-90 took 121 MB out of the archive), a native
 * module that did not get rebuilt for Electron's ABI, a `files` glob that dropped a dialect module,
 * a CSP that only bites under `file://`.
 *
 * ── What it does NOT cover, deliberately ──────────────────────────────────────────────────────
 *
 * The connection editor, the results grid and the explorer tree. Those are `tests/e2e-react/`'s
 * job and they are engine-agnostic — nothing about packaging changes a React dialog. This tier
 * drives the app through its own preload bridge (`window.joinery`, the same object the renderer
 * calls) because what packaging can break is the renderer→preload→main→driver→server path, and the
 * bridge is the shortest honest route down it. Adding three engine-specific dialog fillers would
 * have widened the surface without adding a packaging failure mode.
 *
 * ── Hermeticity, which is the reason this tier needs a marked bundle ──────────────────────────
 *
 * A packaged Joinery refuses `JOINERY_KEYCHAIN_SERVICE` (J-161) unless the BUNDLE carries the
 * build-time test marker (J-167) — and it must refuse it, because the packaged binary is the one
 * the user trusted with their Keychain. So this tier launches only a bundle built by
 * `pnpm run package:test`, and `tests/smoke-packaged/packaged-app.ts` proves that before it starts
 * anything. Every run gets its OWN throwaway service namespace, and the launcher's `close()`
 * deletes every item under it; the assertions below check both halves — the vault landed in the
 * throwaway namespace, and the developer's production namespace was left exactly as it was found.
 *
 * Run it with `pnpm run test:smoke:packaged`, which packages a test bundle first. Needs the Docker
 * harness up (`pnpm run test:harness:up`) and macOS.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Page } from '@playwright/test';
import { APP_ID } from '@joinery/shared';
import type {
  ActiveConnection,
  ConnectionProfile,
  DatabaseEngine,
  LogEntry,
  QueryRequest,
  QueryResult,
} from '@joinery/shared';
import type { JoineryAPI } from '@joinery/preload';
import { TEST_BUILD_WARNING } from '@joinery/main/utils/test-build-capability';

import {
  keychainItemCount,
  launchPackagedJoinery,
  smokeKeychainServices,
  type LaunchedPackagedApp,
} from './packaged-app';

/** Packaging a bundle is the `pretest` script's job; booting one is still not fast. */
const BOOT_TIMEOUT_MS = 120_000;
/** A connect plus a query against a container, with room for a cold pool. */
const ENGINE_TIMEOUT_MS = 60_000;

/**
 * One case per engine: the profile the app is asked to save, and a query whose answer only the
 * real server can give.
 *
 * The connection facts are the harness containers' (`tests/docker-compose.test.yml`), restated here
 * rather than imported from `tests/helpers/db-fixtures.ts` for the reason
 * `tests/helpers/react/app.ts` gives about the same four values: that module is the integration
 * tier's, and this tier needs the connection facts and nothing else from it.
 *
 * The SQL is engine-specific on purpose. A portable `SELECT 1` would prove a round trip happened
 * and not which server answered it, so each case asks the server to name itself and the assertion
 * checks the name — a profile that silently landed on the wrong container fails here rather than
 * passing.
 */
interface EngineCase {
  readonly label: string;
  readonly engine: DatabaseEngine;
  readonly server: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly sql: string;
  readonly identifies: RegExp;
}

const ENGINE_CASES: readonly EngineCase[] = [
  {
    label: 'SQL Server',
    engine: 'mssql',
    server: '127.0.0.1',
    port: 11433,
    username: 'sa',
    password: 'JoineryTest!Pa55',
    database: 'master',
    sql: 'SELECT 1 AS smoke, @@VERSION AS server_version',
    identifies: /Microsoft SQL Server/i,
  },
  {
    label: 'PostgreSQL',
    engine: 'postgresql',
    server: '127.0.0.1',
    port: 15432,
    username: 'joinery',
    password: 'joinery',
    database: 'joinery_test',
    sql: 'SELECT 1 AS smoke, version() AS server_version',
    identifies: /PostgreSQL/i,
  },
  {
    label: 'MySQL',
    engine: 'mysql',
    server: '127.0.0.1',
    port: 13306,
    username: 'root',
    password: 'joinery',
    database: 'joinery_test',
    sql: 'SELECT 1 AS smoke, VERSION() AS server_version',
    identifies: /^\d+\.\d+/,
  },
];

/** The profile a case asks the packaged app to save. `id: ''` is what makes the store create one. */
function profileFor(testCase: EngineCase): ConnectionProfile {
  return {
    id: '',
    name: `smoke-${testCase.engine}`,
    engine: testCase.engine,
    server: testCase.server,
    port: testCase.port,
    authenticationType: 'sql',
    username: testCase.username,
    database: testCase.database,
    // The harness containers speak plaintext; Joinery defaults to encrypt-on.
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 30,
  };
}

// ── The four bridge calls this tier makes, each one line of in-page code ───────────────────────
//
// `window.joinery` is the preload bridge (`packages/preload/src/index.ts`), so these run in the
// packaged renderer and cross into the packaged main process exactly as the React app's own calls
// do. The cast is the honest form: `JoineryAPI`'s global `Window` augmentation describes the
// renderer's window, not the DOM lib's.

function saveProfile(
  page: Page,
  profile: ConnectionProfile,
  password: string
): Promise<ConnectionProfile> {
  return page.evaluate(
    arg =>
      (window as unknown as { joinery: JoineryAPI }).joinery.connection.save(
        arg.profile,
        arg.password
      ),
    { profile, password }
  );
}

function connect(page: Page, profileId: string): Promise<ActiveConnection> {
  return page.evaluate(
    id => (window as unknown as { joinery: JoineryAPI }).joinery.connection.connect(id),
    profileId
  );
}

function execute(page: Page, request: QueryRequest): Promise<QueryResult> {
  return page.evaluate(
    req => (window as unknown as { joinery: JoineryAPI }).joinery.query.execute(req),
    request
  );
}

function recentLogs(page: Page): Promise<LogEntry[]> {
  return page.evaluate(() =>
    (window as unknown as { joinery: JoineryAPI }).joinery.logs.getRecent()
  );
}

describe('the packaged Joinery bundle', () => {
  let launched: LaunchedPackagedApp;
  /**
   * How many items the developer's PRODUCTION namespace held before the run. Recorded rather than
   * asserted to be any particular number — it is whatever this machine's installed Joinery has
   * saved, and the only claim this tier makes about it is that the number does not move.
   */
  let productionItemsBefore: number;

  beforeAll(async () => {
    productionItemsBefore = keychainItemCount(APP_ID);
    launched = await launchPackagedJoinery();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    // Throws if anything could not be cleaned up, which fails the file — a leaked Keychain item is
    // a failure of this tier and not a footnote to it.
    await launched.close();
    expect(smokeKeychainServices()).toEqual([]);
    expect(keychainItemCount(APP_ID)).toBe(productionItemsBefore);
  }, BOOT_TIMEOUT_MS);

  it('loads its renderer from inside app.asar', () => {
    expect(launched.window.url()).toContain('app.asar');
  });

  it('reports its build-time test capability in its own log', async () => {
    const entries = await recentLogs(launched.window);
    expect(entries.map(entry => entry.message)).toContain(TEST_BUILD_WARNING);
  });

  it('keeps its credential vault in the throwaway keychain namespace', async () => {
    await saveProfile(
      launched.window,
      { ...profileFor(ENGINE_CASES[0]!), name: 'smoke-keychain-probe' },
      'a-password-nothing-can-use'
    );

    // One item, because `CredentialStore` keeps every password in a single `credentials-vault`
    // entry — so this count is 1 whether this test ran first or after the three engine cases.
    expect(keychainItemCount(launched.keychainService)).toBe(1);
    expect(keychainItemCount(APP_ID)).toBe(productionItemsBefore);
  });

  it.each(ENGINE_CASES)(
    'connects to $label and runs a real query',
    async testCase => {
      const saved = await saveProfile(launched.window, profileFor(testCase), testCase.password);
      expect(saved.id).not.toBe('');

      const active = await connect(launched.window, saved.id);
      expect(active.status).toBe('connected');

      const result = await execute(launched.window, {
        connectionId: saved.id,
        database: testCase.database,
        sql: testCase.sql,
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const rows = result.resultSets?.[0]?.rows ?? [];
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.smoke)).toBe(1);
      expect(String(rows[0]?.server_version)).toMatch(testCase.identifies);
    },
    ENGINE_TIMEOUT_MS
  );
});
