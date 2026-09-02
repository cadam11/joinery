/**
 * Vitest configuration for the packaged-app smoke tier (J-88).
 *
 * Picks up `tests/smoke-packaged/**` only. It needs two things the other tiers do not: a bundle
 * built by `pnpm run package:test` (the `pretest:smoke:packaged` script builds one) and the
 * docker-compose.test.yml network (`pnpm run test:harness:up`).
 *
 * ── Vitest rather than Playwright, and that is forced rather than chosen ──────────────────────
 *
 * The tier's whole safety property is that it refuses a bundle without the J-167 test marker, and
 * the refusal it must reuse — `assertBundleIsTestCapable` — lives in
 * `scripts/release/smoke-packaged-app.ts`, which runs under Node's ESM type stripping and reads
 * `import.meta.dirname` at module scope. Playwright's TS loader emits CommonJS, so importing that
 * module from a `playwright test` spec is a hard `SyntaxError: Cannot use 'import.meta' outside a
 * module` (measured, not assumed). Vitest loads it as the ESM it is. Playwright's Electron DRIVER
 * is still what launches the app — `_electron.launch`, imported as a library exactly as
 * `smoke-packaged-app.ts` imports it — so nothing about the launch differs from the other tiers.
 *
 * Kept out of `vitest.config.ts` for the reason the integration tier is: `pnpm run test` must stay
 * a fast pass that needs no infrastructure. Neither project there collects `tests/**`, so this
 * file's specs cannot be swept into the unit tier by accident.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No `vite-tsconfig-paths`, unlike the other two configs: the three aliases below are every
  // workspace import this tier makes, and the plugin's only other effect here is to re-parse
  // `docs-site/tsconfig.json` and warn about it on every run.
  test: {
    include: ['tests/smoke-packaged/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],

    environment: 'node',

    // Packaging is the pretest script's job, but booting a bundle and warming three connection
    // pools is not fast. Bounded, and every test states its own budget too.
    testTimeout: 120_000,
    hookTimeout: 180_000,

    // One app, one Keychain namespace, three shared containers: nothing here may overlap.
    fileParallelism: false,

    // `@joinery/main` resolves to SOURCE, and only for the one constant the tier asserts on
    // (`TEST_BUILD_WARNING`). `keytar` is deliberately NOT aliased to the unit tier's mock: this
    // process never loads keytar at all — it inspects the real Keychain through the `security`
    // CLI, because a mock would be a mock of the exact claim the tier exists to make.
    alias: {
      '@joinery/shared': new URL('./packages/shared/src', import.meta.url).pathname,
      '@joinery/main': new URL('./packages/main/src', import.meta.url).pathname,
      '@joinery/preload': new URL('./packages/preload/src', import.meta.url).pathname,
    },

    reporters: ['default'],
  },
});
