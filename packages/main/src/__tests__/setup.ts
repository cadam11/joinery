/**
 * Test setup for @joinery/main
 * Runs before each test file.
 */

import { afterAll } from 'vitest';
// ⚠️ This import has reach well beyond the timer it exists for. Setup files run
// before the spec's own module graph, so `connection-pool.ts` — and everything
// it imports: mssql, pg, mysql2, the Aurora DSQL connector — is already loaded
// and bound to the REAL drivers by the time a spec registers
// `vi.mock('mysql2/promise')`. Such a mock intercepts the *spec's* resolution,
// not a binding another module already made, so it never reaches the code under
// test and the spec makes live network calls instead: a MySQL probe against a
// fake host produced a real `getaddrinfo ENOTFOUND` while the recorder sat empty
// (J-149).
//
// Mocking a module the spec imports directly is fine — `mysql-pool-trust.spec.ts`
// mocks './connection-pool' itself and that lands. What cannot be reached this
// way is a *transitive* dependency of a module this file already pulled in. To
// intercept one of those, spy on the driver module: both MySQL test-connection
// paths call `mysql.createPool(...)`, a property read at call time, so
// `vi.spyOn(mysql, 'createPool')` reaches them. `mysql-test-pool.spec.ts` is the
// worked example.
import { ConnectionPoolManager } from '../services/sql/connection-pool';

// Stop the cleanup timer to prevent Jest open handle warnings
afterAll(() => {
  try {
    ConnectionPoolManager.getInstance().stopCleanupTimer();
  } catch {
    // Singleton may not have been instantiated
  }
});
