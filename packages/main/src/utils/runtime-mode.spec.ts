import { describe, expect, it } from 'vitest';
import { isDevelopmentHatchOpen, isTestHatchOpen } from './runtime-mode';

/**
 * The two environment hatches a shipped Joinery must not honour (J-161).
 *
 * J-161 closed this shape for the keychain service name. These are the siblings the cycle-9
 * review found: both are read from the process environment, both change what a shipped app
 * does, and neither was gated. The threat is the same one — someone who can set the
 * environment of a launch — and the answer is the same: honour the hatch only while the app is
 * unpackaged, and decide it in a pure function so both branches are provable here.
 *
 * `isPackagedApp` itself is not tested in this file. It is one guarded read of Electron's
 * `app.isPackaged`, and a vitest process is not a packaged Electron app, so there is nothing
 * honest to assert about it in-process; the packaged branch is proven by the callers that pass
 * `isPackaged: true` below and by a real packaged launch.
 *
 * J-167 adds the one way back in for a packaged app: `isTestBuild`, a property of the ARTIFACT
 * (`Contents/Resources/joinery-test-build`, written by `pnpm run package:test` and refused by
 * `pnpm run verify:package`) rather than of the environment. It is what lets the packaged smoke
 * run keep its hidden window and its throwaway keychain namespace without reopening the hole for
 * a release build, which cannot carry the marker.
 */
describe('isTestHatchOpen', () => {
  it('is open for the launchers: unpackaged with JOINERY_TEST=1', () => {
    expect(isTestHatchOpen({ isPackaged: false, env: { JOINERY_TEST: '1' } })).toBe(true);
  });

  it('is shut in a packaged app even with JOINERY_TEST=1', () => {
    expect(isTestHatchOpen({ isPackaged: true, env: { JOINERY_TEST: '1' } })).toBe(false);
  });

  // Same again with the flag stated rather than defaulted, so nobody can read the case above as
  // "an omitted field is undecided". A release bundle is `isTestBuild: false`.
  it('is shut in a packaged RELEASE build even with JOINERY_TEST=1', () => {
    expect(
      isTestHatchOpen({ isPackaged: true, isTestBuild: false, env: { JOINERY_TEST: '1' } })
    ).toBe(false);
  });

  /**
   * The packaged test bundle (J-167). `scripts/release/smoke-packaged-app.ts` boots a real
   * `Joinery.app` and needs the hidden window it has always had; without this case it gets a
   * visible one, which is how the J-167 review found this call site in the first place. The
   * capability is a stamped file inside the bundle, so a release build cannot reach this branch.
   */
  it('is open in a packaged app that carries the build-time test capability', () => {
    expect(
      isTestHatchOpen({ isPackaged: true, isTestBuild: true, env: { JOINERY_TEST: '1' } })
    ).toBe(true);
  });

  it('is shut in a test build that did not ask for it', () => {
    expect(isTestHatchOpen({ isPackaged: true, isTestBuild: true, env: {} })).toBe(false);
  });

  it('is shut when the variable is absent', () => {
    expect(isTestHatchOpen({ isPackaged: false, env: {} })).toBe(false);
  });

  // Exactly '1', as every launcher sets it. A truthy-string test would open the hatch on
  // `JOINERY_TEST=0`, which is what someone writes when they mean "off".
  it.each(['0', 'true', 'yes', '', ' 1'])('is shut for the near-miss value %j', value => {
    expect(isTestHatchOpen({ isPackaged: false, env: { JOINERY_TEST: value } })).toBe(false);
  });
});

describe('isDevelopmentHatchOpen', () => {
  it('is open for `pnpm run dev`: unpackaged with NODE_ENV=development', () => {
    expect(isDevelopmentHatchOpen({ isPackaged: false, env: { NODE_ENV: 'development' } })).toBe(
      true
    );
  });

  /**
   * The sharper of the two. Development mode loads `http://localhost:4200` into the window
   * instead of the bundled renderer, opens devtools, and relaxes the content-security policy —
   * so honouring it in a packaged app would let whoever set the variable serve their own page
   * into the signed, user-trusted app, with its preload bridge attached.
   */
  it('is shut in a packaged app even with NODE_ENV=development', () => {
    expect(isDevelopmentHatchOpen({ isPackaged: true, env: { NODE_ENV: 'development' } })).toBe(
      false
    );
  });

  /**
   * And it stays shut for a packaged TEST build, unlike the test hatch above (J-167). A stamped
   * bundle has no Vite dev server to load, so opening this would buy nothing and would let
   * whoever set `NODE_ENV` serve their own page into a bundle that already carries the preload
   * bridge — the one hatch where "it is only a test build" is not a good enough reason.
   */
  it('is shut in a packaged test build too — a stamped bundle has no dev server', () => {
    expect(
      isDevelopmentHatchOpen({
        isPackaged: true,
        isTestBuild: true,
        env: { NODE_ENV: 'development' },
      })
    ).toBe(false);
  });

  it.each(['production', 'test', ''])('is shut for NODE_ENV=%j', value => {
    expect(isDevelopmentHatchOpen({ isPackaged: false, env: { NODE_ENV: value } })).toBe(false);
  });

  it('is shut when NODE_ENV is absent', () => {
    expect(isDevelopmentHatchOpen({ isPackaged: false, env: {} })).toBe(false);
  });
});
