/**
 * The two navigation decisions, as pure functions.
 *
 * A navigation that lands inside the app's own `BrowserWindow` inherits the whole
 * `window.joinery` preload surface — every SQL, keychain and filesystem channel. `sandbox: true`
 * and `contextIsolation: true` do not help here: the bridge is exposed to whatever document the
 * window holds. So the only safe rule is that the window never holds a document other than the
 * one the main process loaded, and that is what `decideNavigation` encodes.
 *
 * `decideWindowOpen` is the sibling case: `window.open(...)` from the renderer would otherwise
 * get a real child BrowserWindow with the same webPreferences.
 */

import { describe, expect, it } from 'vitest';

import { type AppEntry, decideNavigation, decideWindowOpen } from './navigation-guard';

const DEV_ENTRY: AppEntry = { kind: 'dev-server', url: 'http://localhost:4200' };
const FILE_ENTRY: AppEntry = {
  kind: 'file',
  path: '/Applications/Joinery.app/Contents/Resources/app.asar/packages/renderer/dist/browser/index.html',
};

describe('decideNavigation — dev-server entry', () => {
  it.each([
    'http://localhost:4200',
    'http://localhost:4200/',
    // A Vite full-reload (the fallback when a module is not hot-updatable) re-navigates to the
    // same origin, so it must stay allowed or dev-mode HMR breaks.
    'http://localhost:4200/?t=1730000000',
    'http://localhost:4200/some/deep/path',
  ])('allows %s', target => {
    expect(decideNavigation(target, DEV_ENTRY)).toEqual({ kind: 'allow' });
  });

  it.each([
    // Same host, different port or scheme: a different origin, so not the app.
    'http://localhost:4201/',
    'https://localhost:4200/',
    'http://127.0.0.1:4200/',
  ])('does not treat %s as the app document', target => {
    expect(decideNavigation(target, DEV_ENTRY).kind).not.toBe('allow');
  });

  it('forwards a genuinely external http(s) target to the OS browser', () => {
    expect(decideNavigation('https://usejoinery.com/docs', DEV_ENTRY)).toEqual({
      kind: 'open-externally',
      url: 'https://usejoinery.com/docs',
    });
  });
});

describe('decideNavigation — packaged file entry', () => {
  it('allows a navigation to exactly the loaded entry file', () => {
    const target = `file://${FILE_ENTRY.path}`;
    expect(decideNavigation(target, FILE_ENTRY)).toEqual({ kind: 'allow' });
  });

  it('allows the entry file when the URL percent-encodes its path', () => {
    const entry: AppEntry = { kind: 'file', path: '/Users/craig/My Apps/index.html' };
    expect(decideNavigation('file:///Users/craig/My%20Apps/index.html', entry)).toEqual({
      kind: 'allow',
    });
  });

  it('allows the entry file when the URL carries a query or fragment', () => {
    expect(decideNavigation(`file://${FILE_ENTRY.path}?boot=1#tab`, FILE_ENTRY)).toEqual({
      kind: 'allow',
    });
  });

  it.each([
    // A sibling file inside the same bundle is still not the entry point.
    '/Applications/Joinery.app/Contents/Resources/app.asar/packages/renderer/dist/browser/other.html',
    // Traversal out of the bundle.
    '/Applications/Joinery.app/Contents/Resources/app.asar/packages/renderer/dist/browser/../../../../../../../etc/passwd',
    '/etc/passwd',
  ])('blocks the file: URL %s', targetPath => {
    const decision = decideNavigation(`file://${targetPath}`, FILE_ENTRY);
    expect(decision.kind).toBe('block');
  });

  it('blocks a file: URL that only prefix-matches the entry path', () => {
    // `…/index.html.evil` starts with the entry path; a `startsWith` check would let it through.
    const decision = decideNavigation(`file://${FILE_ENTRY.path}.evil`, FILE_ENTRY);
    expect(decision.kind).toBe('block');
  });

  it.each(['evil.example', '127.0.0.1', 'attacker.example:8080'])(
    'blocks a file: URL carrying the host %j, even with the exact entry path',
    host => {
      // `file://<host>/<path>` parses with `protocol === 'file:'` and a `pathname` identical to
      // the local case, so a guard that compares only the path decides `allow` for a document
      // fetched from somewhere else entirely (a UNC share on Windows). The host is the whole
      // difference and it has to be checked. Found in review of the first cut of this file.
      const decision = decideNavigation(`file://${host}${FILE_ENTRY.path}`, FILE_ENTRY);
      expect(decision.kind).toBe('block');
    }
  );

  it.each(['localhost', 'LOCALHOST'])(
    'still allows the entry file when the URL spells the local host as %j',
    host => {
      // Not an exception to the rule above — the URL parser normalises a `localhost` file host to
      // the empty string, so these are the same URL as `file:///…`. Asserted so that tightening
      // the host check further cannot silently break the local case.
      expect(new URL(`file://${host}${FILE_ENTRY.path}`).host).toBe('');
      expect(decideNavigation(`file://${host}${FILE_ENTRY.path}`, FILE_ENTRY)).toEqual({
        kind: 'allow',
      });
    }
  );
});

describe('decideNavigation — schemes that are never a navigation', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'about:blank',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'smb://attacker.example/share',
    'ms-msdt:/id PCWDiagnostic',
  ])('blocks %j', target => {
    for (const entry of [DEV_ENTRY, FILE_ENTRY]) {
      expect(decideNavigation(target, entry).kind).toBe('block');
    }
  });

  it('forwards mailto: to the OS handler rather than navigating', () => {
    expect(decideNavigation('mailto:hi@example.com', FILE_ENTRY)).toEqual({
      kind: 'open-externally',
      url: 'mailto:hi@example.com',
    });
  });

  it.each(['', '   ', 'not a url', '//usejoinery.com'])(
    'blocks the unparseable target %j',
    target => {
      expect(decideNavigation(target, FILE_ENTRY).kind).toBe('block');
    }
  );

  it('blocks non-string targets', () => {
    for (const target of [undefined, null, 42]) {
      expect(decideNavigation(target as unknown as string, FILE_ENTRY).kind).toBe('block');
    }
  });

  it('gives every block a reason that names the scheme but not the rest of the URL', () => {
    const decision = decideNavigation('data:text/html,<script>alert(1)</script>', FILE_ENTRY);
    expect(decision.kind).toBe('block');
    if (decision.kind !== 'block') return;
    expect(decision.reason).toContain('data:');
    expect(decision.reason).not.toContain('alert');
  });
});

describe('decideWindowOpen', () => {
  it('forwards an http(s) target to the OS browser', () => {
    expect(decideWindowOpen('https://usejoinery.com/')).toEqual({
      kind: 'open-externally',
      url: 'https://usejoinery.com/',
    });
    expect(decideWindowOpen('http://usejoinery.com/')).toEqual({
      kind: 'open-externally',
      url: 'http://usejoinery.com/',
    });
  });

  it('forwards mailto:', () => {
    expect(decideWindowOpen('mailto:hi@example.com')).toEqual({
      kind: 'open-externally',
      url: 'mailto:hi@example.com',
    });
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    '',
    'not a url',
  ])('blocks %j — a child window is never created', target => {
    expect(decideWindowOpen(target).kind).toBe('block');
  });

  it('never returns "allow" — a child BrowserWindow would inherit the preload bridge', () => {
    for (const target of ['http://localhost:4200/', 'https://usejoinery.com/', 'about:blank']) {
      // The union has no `allow` member, so this is a type-level guarantee as well; the assertion
      // pins the runtime side so a future edit cannot quietly widen it.
      expect(decideWindowOpen(target).kind).not.toBe('allow');
    }
  });
});
