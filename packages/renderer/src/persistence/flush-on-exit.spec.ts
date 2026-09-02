/**
 * The flush-on-exit registry: the one place a debounced renderer write is emptied before the
 * window goes away (J-74).
 *
 * Three properties are worth asserting, because each one is a way the registry could look like it
 * works and lose a write anyway:
 *
 * 1. **Every registered writer runs, even when one of them throws.** The registry exists so that
 *    three independent debounces are emptied by one event; a flusher that throws must not take the
 *    other two down with it, and the failure must be reported rather than swallowed.
 * 2. **A name is registered at most once.** Two owners under one name means one of them is silently
 *    dropped — which is precisely the "the write never happened" failure this module closes.
 * 3. **Nothing is flushed once the bridge is gone.** The flush fires IPC calls, and on the teardown
 *    path the preload bridge can be gone already; a write attempt then is a thrown error inside an
 *    unload listener, with no caller to catch it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installJoineryMock, removeJoineryMock } from '../test/joinery-mock';
import { setDiagnosticsSink } from '../state/diagnostics';
import {
  flushPendingWritesOnExit,
  installExitFlush,
  registeredExitFlushNames,
  registerExitFlush,
} from './flush-on-exit';

const teardowns: (() => void)[] = [];
let reported: string[] = [];

beforeEach(() => {
  reported = [];
  // Any bridge object at all: the registry only asks whether one is there.
  teardowns.push(installJoineryMock({ app: { setState: () => Promise.resolve() } }));
  teardowns.push(
    setDiagnosticsSink({ error: context => reported.push(context), warn: () => undefined })
  );
});

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  removeJoineryMock();
});

describe('the flush-on-exit registry', () => {
  it('runs every registered flusher once', () => {
    const ran: string[] = [];
    teardowns.push(registerExitFlush('geometry', () => ran.push('geometry')));
    teardowns.push(registerExitFlush('tabs', () => ran.push('tabs')));

    flushPendingWritesOnExit();

    expect(ran).toEqual(['geometry', 'tabs']);
  });

  it('names what is registered, so the shell’s wiring can be asserted', () => {
    teardowns.push(registerExitFlush('geometry', () => undefined));
    teardowns.push(registerExitFlush('tabs', () => undefined));

    expect([...registeredExitFlushNames()].sort()).toEqual(['geometry', 'tabs']);
  });

  it('stops running a flusher once it has been unregistered', () => {
    let runs = 0;
    const unregister = registerExitFlush('geometry', () => {
      runs += 1;
    });

    unregister();
    flushPendingWritesOnExit();

    expect(runs).toBe(0);
    expect(registeredExitFlushNames()).toEqual([]);
  });

  it('refuses a second registration under the same name', () => {
    teardowns.push(registerExitFlush('geometry', () => undefined));

    // Two owners under one name is one owner silently dropped — the failure this module closes.
    expect(() => registerExitFlush('geometry', () => undefined)).toThrow(/already registered/);
  });

  it('runs the remaining flushers when one throws, and reports the failure', () => {
    const ran: string[] = [];
    teardowns.push(
      registerExitFlush('geometry', () => {
        throw new Error('the bridge went away mid-write');
      })
    );
    teardowns.push(registerExitFlush('tabs', () => ran.push('tabs')));

    flushPendingWritesOnExit();

    expect(ran).toEqual(['tabs']);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('geometry');
  });

  it('flushes on beforeunload and on pagehide', () => {
    let runs = 0;
    teardowns.push(
      registerExitFlush('geometry', () => {
        runs += 1;
      })
    );
    teardowns.push(installExitFlush());

    window.dispatchEvent(new Event('beforeunload'));
    expect(runs).toBe(1);

    // A page can be discarded without a `beforeunload` at all; `pagehide` is the one event
    // Chromium always fires on the way out.
    window.dispatchEvent(new Event('pagehide'));
    expect(runs).toBe(2);
  });

  it('removes its listeners when torn down', () => {
    let runs = 0;
    teardowns.push(
      registerExitFlush('geometry', () => {
        runs += 1;
      })
    );
    const uninstall = installExitFlush();

    uninstall();
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pagehide'));

    expect(runs).toBe(0);
  });

  it('flushes nothing once the bridge is gone', () => {
    let runs = 0;
    teardowns.push(
      registerExitFlush('geometry', () => {
        runs += 1;
      })
    );

    removeJoineryMock();
    flushPendingWritesOnExit();

    expect(runs).toBe(0);
    expect(reported).toEqual([]);
  });
});
