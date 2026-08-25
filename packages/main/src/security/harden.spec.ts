/**
 * The thin Electron wiring: it turns the pure decisions in `navigation-guard.ts` and
 * `content-security-policy.ts` into installed handlers.
 *
 * The `WebContents` / `Session` objects here are hand-built fakes with only the members the
 * installers touch, cast at the boundary. That is deliberate: launching a real `BrowserWindow`
 * would put this in the e2e tier and cost seconds per case, and `tests/e2e-react/security.spec.ts`
 * already covers the "it is really installed on the real window" half.
 *
 * Logging is asserted through the logger's own listener fan-out (`onLogEntry`) rather than a
 * console spy, because "the block was recorded" is the observable the Output panel shows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogEntry } from '@joinery/shared';
import { onLogEntry } from '../utils/logger';
import {
  installContentSecurityPolicy,
  installNavigationGuards,
  installNavigationGuardsForEveryWindow,
  SECURITY_LOG_TAG,
} from './harden';
import type { AppEntry } from './navigation-guard';

const FILE_ENTRY: AppEntry = { kind: 'file', path: '/app/dist/browser/index.html' };

// ── Fakes ────────────────────────────────────────────────────────────────────────────────

type WindowOpenHandler = (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse;
type WillNavigateListener = (details: Electron.Event<{ url: string }>) => void;

interface FakeWebContents {
  readonly windowOpen: () => WindowOpenHandler;
  readonly willNavigate: () => WillNavigateListener;
  readonly willRedirect: () => WillNavigateListener;
  readonly contents: Electron.WebContents;
}

function fakeWebContents(): FakeWebContents {
  let windowOpen: WindowOpenHandler | undefined;
  const listeners = new Map<string, WillNavigateListener>();

  const contents = {
    setWindowOpenHandler(handler: WindowOpenHandler) {
      windowOpen = handler;
    },
    on(event: string, listener: WillNavigateListener) {
      listeners.set(event, listener);
      return contents;
    },
  };

  const listener = (event: string): WillNavigateListener => {
    const registered = listeners.get(event);
    if (!registered) throw new Error(`no ${event} listener was registered`);
    return registered;
  };

  return {
    windowOpen: () => {
      if (!windowOpen) throw new Error('setWindowOpenHandler was never called');
      return windowOpen;
    },
    willNavigate: () => listener('will-navigate'),
    willRedirect: () => listener('will-redirect'),
    contents: contents as unknown as Electron.WebContents,
  };
}

/** Just enough `app` to capture the one hook `installNavigationGuardsForEveryWindow` registers. */
function fakeApp(): {
  readonly createContents: (contents: Electron.WebContents) => void;
  readonly app: Electron.App;
} {
  let created: ((event: unknown, contents: Electron.WebContents) => void) | undefined;

  const app = {
    on(event: string, listener: (event: unknown, contents: Electron.WebContents) => void) {
      if (event === 'web-contents-created') created = listener;
      return app;
    },
  };

  return {
    createContents: contents => {
      if (!created) throw new Error('no web-contents-created listener was registered');
      created({}, contents);
    },
    app: app as unknown as Electron.App,
  };
}

function navigationEvent(url: string): Electron.Event<{ url: string }> & {
  readonly prevented: () => boolean;
} {
  let prevented = false;
  return {
    url,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    prevented: () => prevented,
  };
}

function openDetails(url: string): Electron.HandlerDetails {
  return { url } as unknown as Electron.HandlerDetails;
}

// ── Log capture ──────────────────────────────────────────────────────────────────────────

let entries: LogEntry[] = [];
let stopListening: (() => void) | undefined;

beforeEach(() => {
  entries = [];
  stopListening = onLogEntry(entry => entries.push(entry));
});

afterEach(() => {
  stopListening?.();
  stopListening = undefined;
});

function securityEntries(): LogEntry[] {
  return entries.filter(entry => entry.tag === SECURITY_LOG_TAG);
}

// ── installNavigationGuards ──────────────────────────────────────────────────────────────

describe('installNavigationGuards — window.open', () => {
  it('denies every window open, and forwards an https target to the OS browser', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const response = fake.windowOpen()(openDetails('https://usejoinery.com/'));

    expect(response).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://usejoinery.com/');
  });

  it('denies and does NOT forward a blocked scheme, and records why', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    expect(fake.windowOpen()(openDetails('file:///etc/passwd'))).toEqual({ action: 'deny' });

    expect(openExternal).not.toHaveBeenCalled();
    const logged = securityEntries();
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe('warn');
    expect(logged[0].message).toContain('file:');
  });
});

describe('installNavigationGuards — will-navigate', () => {
  it('lets the app navigate to its own entry document', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const event = navigationEvent(`file://${FILE_ENTRY.path}`);
    fake.willNavigate()(event);

    expect(event.prevented()).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(securityEntries()).toEqual([]);
  });

  it('cancels an external navigation and hands the URL to the OS browser instead', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const event = navigationEvent('https://usejoinery.com/docs');
    fake.willNavigate()(event);

    expect(event.prevented()).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://usejoinery.com/docs');
  });

  it('cancels a blocked navigation, forwards nothing, and records the reason', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const event = navigationEvent('file:///etc/passwd');
    fake.willNavigate()(event);

    expect(event.prevented()).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(securityEntries().map(e => e.level)).toEqual(['warn']);
  });

  it('logs — never swallows — a rejection from openExternal', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('no handler for scheme');
    });
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    fake.willNavigate()(navigationEvent('https://usejoinery.com/'));
    // The handler is synchronous by contract (Electron does not await it), so the rejection
    // settles on a later microtask.
    await vi.waitFor(() => expect(securityEntries().some(e => e.level === 'error')).toBe(true));
    expect(securityEntries().find(e => e.level === 'error')?.message).toContain(
      'no handler for scheme'
    );
  });
});

// ── installContentSecurityPolicy ─────────────────────────────────────────────────────────

interface FakeSession {
  readonly respond: (
    responseHeaders?: Record<string, string[]>
  ) => Electron.HeadersReceivedResponse;
  readonly session: Electron.Session;
}

function fakeSession(): FakeSession {
  type Listener = (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void
  ) => void;
  let listener: Listener | undefined;

  const session = {
    webRequest: {
      onHeadersReceived(candidate: Listener) {
        listener = candidate;
      },
    },
  };

  return {
    respond: responseHeaders => {
      if (!listener) throw new Error('onHeadersReceived was never called');
      let captured: Electron.HeadersReceivedResponse | undefined;
      listener({ responseHeaders } as unknown as Electron.OnHeadersReceivedListenerDetails, r => {
        captured = r;
      });
      if (!captured) throw new Error('the listener never invoked its callback');
      return captured;
    },
    session: session as unknown as Electron.Session,
  };
}

describe('installContentSecurityPolicy', () => {
  it('adds the policy to every response and preserves the headers already there', () => {
    const fake = fakeSession();
    installContentSecurityPolicy(fake.session, "default-src 'self'");

    const response = fake.respond({ 'Content-Type': ['text/html'] });

    expect(response.responseHeaders).toEqual({
      'Content-Type': ['text/html'],
      'Content-Security-Policy': ["default-src 'self'"],
    });
  });

  it('replaces a policy the response already carried, whatever its casing', () => {
    const fake = fakeSession();
    installContentSecurityPolicy(fake.session, "default-src 'self'");

    const response = fake.respond({
      'content-security-policy': ['default-src *'],
      'CONTENT-SECURITY-POLICY-REPORT-ONLY': ['default-src *'],
    });

    // Exactly one enforcing policy survives — two would be intersected by the browser, which
    // makes the effective policy impossible to reason about. Report-only is left alone.
    const names = Object.keys(response.responseHeaders ?? {});
    expect(names.filter(n => n.toLowerCase() === 'content-security-policy')).toEqual([
      'Content-Security-Policy',
    ]);
    expect(response.responseHeaders?.['Content-Security-Policy']).toEqual(["default-src 'self'"]);
    expect(names).toContain('CONTENT-SECURITY-POLICY-REPORT-ONLY');
  });

  it('copes with a response that carried no headers at all', () => {
    const fake = fakeSession();
    installContentSecurityPolicy(fake.session, "default-src 'self'");

    expect(fake.respond(undefined).responseHeaders).toEqual({
      'Content-Security-Policy': ["default-src 'self'"],
    });
  });

  it('never cancels a request', () => {
    const fake = fakeSession();
    installContentSecurityPolicy(fake.session, "default-src 'self'");
    expect(fake.respond({}).cancel).toBeUndefined();
  });
});

describe('installNavigationGuards — will-redirect', () => {
  it('cancels a server-side redirect to a blocked URL and records the reason', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const event = navigationEvent('file:///etc/passwd');
    fake.willRedirect()(event);

    expect(event.prevented()).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(securityEntries().map(e => e.level)).toEqual(['warn']);
  });

  it('cancels a redirect off-origin and hands the URL to the OS browser instead', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const event = navigationEvent('https://example.com/');
    fake.willRedirect()(event);

    expect(event.prevented()).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/');
  });

  it('lets a redirect that lands back on the entry document through', () => {
    const openExternal = vi.fn(async () => undefined);
    const fake = fakeWebContents();
    installNavigationGuards(fake.contents, { entry: FILE_ENTRY, openExternal });

    const event = navigationEvent(`file://${FILE_ENTRY.path}`);
    fake.willRedirect()(event);

    expect(event.prevented()).toBe(false);
    expect(securityEntries()).toEqual([]);
  });
});

describe('installNavigationGuardsForEveryWindow', () => {
  it('guards a window created later, with nobody remembering to wire it', () => {
    const openExternal = vi.fn(async () => undefined);
    const electronApp = fakeApp();
    installNavigationGuardsForEveryWindow(electronApp.app, { entry: FILE_ENTRY, openExternal });

    // The second window J-129 exists to protect: created after startup, wired by nothing.
    const second = fakeWebContents();
    electronApp.createContents(second.contents);

    const event = navigationEvent('file:///etc/passwd');
    second.willNavigate()(event);
    expect(event.prevented()).toBe(true);

    const redirect = navigationEvent('https://example.com/');
    second.willRedirect()(redirect);
    expect(redirect.prevented()).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/');

    expect(second.windowOpen()({ url: 'https://example.com/' } as Electron.HandlerDetails)).toEqual(
      { action: 'deny' }
    );
  });

  it('guards every window, not just the first', () => {
    const openExternal = vi.fn(async () => undefined);
    const electronApp = fakeApp();
    installNavigationGuardsForEveryWindow(electronApp.app, { entry: FILE_ENTRY, openExternal });

    for (const fake of [fakeWebContents(), fakeWebContents(), fakeWebContents()]) {
      electronApp.createContents(fake.contents);
      const event = navigationEvent('file:///etc/passwd');
      fake.willNavigate()(event);
      expect(event.prevented()).toBe(true);
    }
  });
});
