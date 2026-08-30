/**
 * Vitest Configuration — Joinery
 *
 * Follows a standard Vitest monorepo testing pattern:
 * - Vitest with v8 coverage
 * - Per-package test projects
 * - Shared setup files with timeout configuration
 *
 * Two projects, because the renderer's specs need jsdom and everything else needs
 * node. Coverage, thresholds and the reporter stay root-level: they are
 * whole-run concerns, not per-project ones.
 */

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        // `extends: true` inherits the root plugins (vite-tsconfig-paths), so
        // this project resolves modules exactly as the single-project config did.
        extends: true,
        test: {
          name: 'node',

          // Test discovery. The renderer is excluded rather than left to the
          // `.ts`-only glob: a stray `.spec.ts` there would otherwise run in the
          // node environment AND load the main-process setup file below.
          include: ['packages/*/src/**/*.{test,spec}.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'packages/renderer/**'],

          // Environment
          environment: 'node',

          // Timeouts
          testTimeout: 30000,
          hookTimeout: 30000,

          // Setup files
          setupFiles: ['./packages/main/src/__tests__/setup.ts'],

          // Module resolution
          alias: {
            '@joinery/shared': new URL('./packages/shared/src', import.meta.url).pathname,
            keytar: new URL('./packages/main/src/__mocks__/keytar.ts', import.meta.url).pathname,
            ssh2: new URL('./packages/main/src/__mocks__/ssh2.ts', import.meta.url).pathname,
          },
        },
      },
      {
        // Build scripts under `scripts/`, which no package owns and so no package's test
        // project collected. Its own project rather than a widened `include` on `node`
        // above: that one loads `packages/main/src/__tests__/setup.ts`, which imports the
        // connection-pool singleton. A cask rewriter has no business booting that.
        extends: true,
        test: {
          name: 'scripts',
          include: ['scripts/**/*.{test,spec}.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          include: ['packages/renderer/src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'jsdom',
          // Only so that `?raw` imports of CSS return the file's text. Vitest's default
          // (`css: false`) stubs every CSS module to an empty string, and `?raw` is stubbed
          // with it — which silently makes `ui/cn.spec.ts`'s type-ladder drift guard compare
          // against nothing. Measured, not assumed. No spec imports CSS as a module, so
          // enabling processing has no other effect.
          css: true,
          testTimeout: 30000,
          hookTimeout: 30000,
          setupFiles: ['./packages/renderer/src/test/setup.ts'],

          // ── Deleted at cutover: the ag-grid-community alias and `server.deps.inline` ──────────
          //
          // This project used to carry an absolute-path `alias` for `ag-grid-community` pointing
          // into `packages/renderer-react/node_modules/…`, plus `server.deps.inline:
          // ['ag-grid-react']` to force `ag-grid-react`'s own import through it. Both existed
          // because `nodeLinker: hoisted` gives the repo root ONE copy of each package and that
          // slot belonged to the Angular renderer's `ag-grid-community@35` — so `@36` landed twice
          // on disk, `ModuleRegistry` is module state, and the grid reported every feature
          // unregistered (AG Grid error #200). Task 11's report §1 has the full failure.
          //
          // Deleting the Angular package freed the root slot: there is now one physical `@36`, both
          // halves of the grid resolve to it, and nothing is needed in their place. The alias also
          // named the pre-rename path, so leaving it would have failed this whole project to
          // resolve — see PLAN.md Phase D.
        },
      },
    ],

    // Coverage — scoped to packages that have tests
    coverage: {
      provider: 'v8',
      include: ['packages/main/src/**/*.ts', 'packages/shared/src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts',
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/__mocks__/**',
        // `packages/preload` has no tests, so including it would only drag the thresholds down.
        'packages/preload/**',
        // `packages/renderer` is a different case and this line is a DECISION, not an oversight
        // (Task 24 review, M7): it holds ~2,190 of the repo's ~2,690 tests, and the `include` above
        // names only main and shared, so folding it in would move the thresholds' meaning entirely.
        // The exclusion was inherited from when this package was `renderer-react` and genuinely
        // untested; raising the gate to cover it is worth doing on its own, with numbers chosen for
        // the code rather than inherited from a 10% floor written for the main process.
        'packages/renderer/**',
      ],
      thresholds: {
        statements: 10,
        branches: 5,
        functions: 10,
        lines: 10,
      },
      reporter: ['text', 'text-summary', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },

    // Reporter
    reporters: ['default'],
  },
});
