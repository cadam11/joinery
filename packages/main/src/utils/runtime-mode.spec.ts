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
 */
describe('isTestHatchOpen', () => {
  it('is open for the launchers: unpackaged with JOINERY_TEST=1', () => {
    expect(isTestHatchOpen({ isPackaged: false, env: { JOINERY_TEST: '1' } })).toBe(true);
  });

  it('is shut in a packaged app even with JOINERY_TEST=1', () => {
    expect(isTestHatchOpen({ isPackaged: true, env: { JOINERY_TEST: '1' } })).toBe(false);
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

  it.each(['production', 'test', ''])('is shut for NODE_ENV=%j', value => {
    expect(isDevelopmentHatchOpen({ isPackaged: false, env: { NODE_ENV: value } })).toBe(false);
  });

  it('is shut when NODE_ENV is absent', () => {
    expect(isDevelopmentHatchOpen({ isPackaged: false, env: {} })).toBe(false);
  });
});
