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
 * This module is the one place `app.isPackaged` and these two hatch variables are read.
 * `utils/env-hatch-gating.spec.ts` fails the unit tier if any other file in `packages/main` reads
 * one of them, which is what keeps the rule true through the next refactor.
 */

import { app, type App } from 'electron';

/** The two facts every hatch decision below is a function of. */
export interface RuntimeSignals {
  /** Electron's `app.isPackaged` — see {@link isPackagedApp}. */
  isPackaged: boolean;
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
 * The Playwright / perf-benchmark hatch: `JOINERY_TEST=1` tells the main process to skip
 * non-essential startup, currently keeping the main window hidden so it does not flash in and out
 * on every spec.
 *
 * Shut in a packaged app. Otherwise anyone who can set the environment of a launch can start the
 * signed, user-trusted Joinery with no visible window — the same confused-deputy shape J-161
 * closed for the credential vault, one rung down.
 */
export function isTestHatchOpen(signals: RuntimeSignals): boolean {
  if (signals.isPackaged) return false;
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
 */
export function isDevelopmentHatchOpen(signals: RuntimeSignals): boolean {
  if (signals.isPackaged) return false;
  return signals.env.NODE_ENV === 'development';
}
