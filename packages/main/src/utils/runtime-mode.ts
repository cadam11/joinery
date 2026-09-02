/**
 * What mode is this process in, and which environment hatches may it honour (J-161).
 *
 * J-161 established the rule for the keychain service name: an environment variable that changes
 * what a shipped app does is a hole, because the app is the signed binary the user has already
 * trusted — with their Keychain, and with whatever else macOS has granted it. So a hatch is
 * honoured only while the app is UNPACKAGED, and the decision is a pure function of two inputs so
 * that both branches are provable in the unit tier (a vitest process can never be a packaged
 * Electron app).
 *
 * The one exception J-167 adds is a property of the ARTIFACT rather than of the environment: a
 * bundle stamped `Contents/Resources/joinery-test-build` by `pnpm run package:test` gets the test
 * hatch back, so the packaged smoke run keeps its hidden window and its throwaway keychain
 * namespace. See `./test-build-capability`, and {@link RuntimeSignals.isTestBuild}.
 *
 * This module is the one place `app.isPackaged` and these two hatch variables are read.
 * `utils/env-hatch-gating.spec.ts` fails the unit tier if any other file in `packages/main` reads
 * one of them, which is what keeps the rule true through the next refactor.
 */

import { app, type App } from 'electron';

import { isTestCapableBuild } from './test-build-capability';

/** The facts every hatch decision below is a function of. */
export interface RuntimeSignals {
  /** Electron's `app.isPackaged` — see {@link isPackagedApp}. */
  isPackaged: boolean;
  /**
   * Whether the BUNDLE was built for testing — `isTestCapableBuild()` from
   * `./test-build-capability` (J-167). A property of the artifact, not of the environment: a
   * second environment variable would have reopened the hole this module closed, since whoever
   * can set one can set two.
   *
   * Optional, and absent means `false`, so a call site that forgets it fails CLOSED — it gets the
   * release behaviour rather than silently granting a hatch.
   */
  isTestBuild?: boolean;
  /** The environment to read. Passed in; never read from `process` by the predicates. */
  env: NodeJS.ProcessEnv;
}

/**
 * Electron's `app.isPackaged`: true inside a shipped `Joinery.app`, false when the app runs from
 * `node_modules/electron` (development, and every Playwright / perf launcher, which hand
 * `packages/main/dist/index.js` to the Electron binary as `args[0]`).
 *
 * `app` is typed non-optional and inside Electron it is. Under vitest the `electron` specifier
 * resolves to the npm shim, whose export is the binary's PATH rather than the API, so the binding
 * genuinely is undefined — measured, not defensive noise: a bare `app.isPackaged` read on a
 * startup path fails 63 unit tests across 8 files, because the test setup file pulls the
 * connection pool (and through it the credential store) in before any spec can mock electron.
 * "No Electron at all" is not a shipped app, which is the same answer `false` is.
 *
 * Kept a function rather than a constant so callers read it when they need it, and so a spec can
 * intercept it at the call site (`vi.spyOn`) to drive the packaged branch of a caller's wiring.
 */
export function isPackagedApp(): boolean {
  const electronApp: App | undefined = app;
  return electronApp?.isPackaged === true;
}

/**
 * This process's mode signals: the one place the ambient reads behind every hatch decision happen
 * (J-161, J-167, J-180).
 *
 * Three reads, all of them about the ARTIFACT rather than about what a caller believes: Electron's
 * `app.isPackaged`, a filesystem probe of this bundle's own `Contents/Resources` for the J-167
 * marker, and the process environment the hatches are read from. Every predicate below and every
 * hatch site elsewhere takes the result as an argument, so the decisions stay pure and both
 * branches stay provable in the unit tier — a vitest process can never be a packaged Electron app.
 *
 * `isTestBuild` is not optional in practice: without it the packaged smoke run
 * (`scripts/release/smoke-packaged-app.ts`) stops honouring its `JOINERY_TEST=1` and starts SHOWING
 * a window on a bundle whose whole job is to boot headlessly and quit. It used to be gathered
 * privately inside `window.ts`, where nothing pinned it (J-181); hoisting it here is what lets one
 * spec assert the field is filled in at all.
 *
 * `CredentialStore` deliberately still assembles the same three reads inline rather than calling
 * this. Its spec drives the packaged branch with `vi.spyOn(runtimeMode, 'isPackagedApp')` at that
 * call site, and a call through this function would put the read inside this module where the spy
 * cannot reach it — trading a proven packaged branch for one less duplicated line.
 */
export function runtimeSignals(): RuntimeSignals {
  return { isPackaged: isPackagedApp(), isTestBuild: isTestCapableBuild(), env: process.env };
}

/**
 * May this build honour a test-only environment hatch at all? The shared predicate every hatch
 * site composes with its own variable (J-180).
 *
 * Unpackaged, or packaged and stamped with the J-167 marker. Written once because it had already
 * been written twice by hand — `isTestHatchOpen` and `service-name.ts` — and a third hatch
 * (`JOINERY_DOCKER_FIXTURE`, J-76) shipped with the check simply missing. The composition is the
 * awkward part to re-derive: `isTestCapableBuild()` alone is `false` for the UNPACKAGED Electron
 * the Playwright and visual tiers launch, so gating on it would break both tiers, and
 * `!isPackaged` alone locks the packaged smoke tier out.
 *
 * `isTestBuild` absent means `false`, so a call site that forgets the field gets the release
 * behaviour — the safe direction to fail in.
 *
 * NOT for `NODE_ENV=development`, which is deliberately stricter: see
 * {@link isDevelopmentHatchOpen}.
 */
export function areTestHatchesHonoured(
  signals: Pick<RuntimeSignals, 'isPackaged' | 'isTestBuild'>
): boolean {
  return !signals.isPackaged || signals.isTestBuild === true;
}

/**
 * The Playwright / perf-benchmark hatch: `JOINERY_TEST=1` tells the main process to skip
 * non-essential startup, currently keeping the main window hidden so it does not flash in and out
 * on every spec.
 *
 * Shut in a packaged app. Otherwise anyone who can set the environment of a launch can start the
 * signed, user-trusted Joinery with no visible window — the same confused-deputy shape J-161
 * closed for the credential vault, one rung down.
 *
 * Open again for a packaged bundle that carries the J-167 marker, because
 * `scripts/release/smoke-packaged-app.ts` boots a real bundle and has always relied on the hidden
 * window. A release bundle cannot reach that branch: nothing in the release path stamps the
 * marker, and `pnpm run verify:package` fails on an artifact that carries one.
 */
export function isTestHatchOpen(signals: RuntimeSignals): boolean {
  if (!areTestHatchesHonoured(signals)) return false;
  return signals.env.JOINERY_TEST === '1';
}

/**
 * The development hatch: `NODE_ENV=development` makes the window load the Vite dev server at
 * `http://localhost:4200` instead of the bundled renderer, open devtools, and take the relaxed
 * content-security policy.
 *
 * Shut in a packaged app, and this is the sharper of the two: honouring it there would let whoever
 * set the variable serve their own page into the signed app, with its preload bridge attached. A
 * packaged app has no dev server to talk to in the first place, so nothing legitimate is lost.
 *
 * Deliberately NOT reopened by the J-167 test-build marker, unlike {@link isTestHatchOpen}. A
 * stamped bundle has no dev server either, so there is nothing to gain — and the loss is the same
 * one: someone who can set `NODE_ENV` would be serving their own page into a bundle that already
 * carries the preload bridge.
 */
export function isDevelopmentHatchOpen(signals: RuntimeSignals): boolean {
  if (signals.isPackaged) return false;
  return signals.env.NODE_ENV === 'development';
}
