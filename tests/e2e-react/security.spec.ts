/**
 * The main-process hardening from J-22, asserted against the real packaged window.
 *
 * The unit tier (`packages/main/src/security/*.spec.ts`) owns every decision branch. What only a
 * launched app can show is that the guards are actually *installed* on the window that carries
 * the preload bridge, and that the production CSP is both **enforced** and **survivable** — a
 * policy nothing can boot under would pass every unit test in the suite, and so would one whose
 * header never reaches the document.
 *
 * Deliberately absent: the "forward an https link to the OS browser" path. Asserting it means
 * letting `shell.openExternal` succeed, which opens the developer's real browser mid-run. Its
 * decision and its forwarding are covered in `navigation-guard.spec.ts` and `harden.spec.ts`.
 *
 * `globalThis` rather than `window` inside every `evaluate` body: the launched app's Playwright
 * `Page` is bound to the name `window` in this file, so `window.open` in a callback would read as
 * the Page's member to the type-checker while meaning the DOM's at runtime.
 */

import { expect, test } from '@playwright/test';

import { waitForShell, withJoineryReact } from '../helpers/joinery-actions-react';

/** A `file:` URL no packaged app has any business navigating to. */
const OFF_LIMITS = 'file:///etc/passwd';

/** How Chromium words a CSP refusal in the console. */
const CSP_REPORT = /Content Security Policy|Refused to (load|execute|apply|connect|create)/i;

test.describe('Joinery — main-process hardening (J-22)', () => {
  test('enforces the CSP: an injected inline script does not run', async () => {
    await withJoineryReact(async ({ window }) => {
      // Playwright evaluates through the debugger, which is exempt from CSP, so the probe has to
      // be a real DOM injection. This is the assertion that proves the header landed at all:
      // without it, `script.textContent` would execute like any other inline script.
      const ranInjectedScript = await window.evaluate(() => {
        const script = document.createElement('script');
        script.textContent = 'globalThis.__joineryCspProbe = true;';
        document.head.appendChild(script);
        script.remove();
        return '__joineryCspProbe' in globalThis;
      });

      expect(ranInjectedScript).toBe(false);
    });
  });

  test('boots the whole shell without a single CSP refusal', async () => {
    await withJoineryReact(async ({ window }) => {
      const reports: string[] = [];
      window.on('console', message => {
        if (CSP_REPORT.test(message.text())) reports.push(message.text());
      });

      // A reload rather than the initial launch: `withJoineryReact` hands the window over after
      // the shell is up, so the listener above would miss the boot it is meant to watch. The
      // reload re-fetches the entry HTML through `onHeadersReceived` and re-runs everything —
      // `public/theme-boot.js`, React, Tailwind, Dockview, Radix and Sonner.
      await window.reload();
      await waitForShell(window);

      // Nothing the shell does at boot is refused. If a directive ever needs loosening, this is
      // where it will say so, in Chromium's own wording. It is also the guard on the pre-mount
      // theme script: it was inline until J-22, and `script-src 'self'` would report it here.
      expect(reports).toEqual([]);

      // The theme boot ran, which is the other half of "survivable" — the attribute it writes is
      // the reason it exists.
      await expect(window.locator('html')).toHaveAttribute('data-theme', /^(system|light|dark)$/);
    });
  });

  test('grants the loosenings the renderer actually needs, over file://', async () => {
    // The two directives that are easy to get wrong under `file://`, exercised directly rather
    // than through the libraries that depend on them. Monaco's editor worker and mermaid's
    // rendered SVG both live behind a DB connection, so the e2e tier cannot reach them without
    // Docker — but a Worker and an Image are the same CSP check, minus the setup.
    await withJoineryReact(async ({ window }) => {
      // `worker-src 'self' blob:` — the `blob:` half, which is Monaco's documented `?worker&inline`
      // fallback. The `'self'` half is proved by the app booting at all: its own bundle chunks are
      // same-directory `file://` assets matched by `'self'`.
      const workerAnswer = await window.evaluate(async () => {
        const source = 'self.onmessage = event => self.postMessage(event.data * 2);';
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try {
          const worker = new Worker(url);
          try {
            return await new Promise<number>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('worker never answered')), 5000);
              worker.onmessage = event => {
                clearTimeout(timer);
                resolve(event.data as number);
              };
              worker.onerror = () => {
                clearTimeout(timer);
                reject(new Error('worker failed to start'));
              };
              worker.postMessage(21);
            });
          } finally {
            worker.terminate();
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      expect(workerAnswer).toBe(42);

      // `img-src 'self' data: blob:` — both non-`'self'` halves. A 1x1 transparent GIF is the
      // smallest thing that distinguishes "loaded" from "blocked".
      const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const imagesLoaded = await window.evaluate(async gif => {
        const load = (src: string) =>
          new Promise<boolean>(resolve => {
            const image = new Image();
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = src;
          });

        const bytes = Uint8Array.from(atob(gif.split(',')[1]), c => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
        try {
          return { data: await load(gif), blob: await load(blobUrl) };
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }, GIF);
      expect(imagesLoaded).toEqual({ data: true, blob: true });
    });
  });

  test('denies window.open rather than handing a child window the preload bridge', async () => {
    await withJoineryReact(async ({ app, window }) => {
      const before = app.windows().length;

      const opened = await window.evaluate(target => {
        // `window.open` returning null is what `{ action: 'deny' }` looks like from the renderer.
        return globalThis.open(target, '_blank') !== null;
      }, OFF_LIMITS);

      expect(opened).toBe(false);
      expect(app.windows()).toHaveLength(before);
      // Still the app, still responsive.
      await expect(window.getByTestId('app-shell')).toBeVisible();

      // And the refusal is Joinery's, not Chromium's: the guard records every block under the
      // `Security` tag, which is what the Output panel shows the user.
      const refusals = await window.evaluate(async () => {
        const bridge = (
          globalThis as unknown as {
            joinery: { logs: { getRecent: () => Promise<{ tag: string; message: string }[]> } };
          }
        ).joinery;
        const entries = await bridge.logs.getRecent();
        return entries.filter(entry => entry.tag === 'Security').map(entry => entry.message);
      });
      expect(refusals.some(message => message.includes('file:'))).toBe(true);
    });
  });

  test('blocks a renderer-initiated navigation away from the app document', async () => {
    await withJoineryReact(async ({ app, window }) => {
      // Read the URL from the main process rather than from the Playwright page: cancelling a
      // navigation leaves the page's own navigation state pending, so every page-side wait after
      // this point would block on a navigation that is never going to commit. `webContents` is
      // also the thing whose document actually matters — it is what holds the preload bridge.
      const currentUrl = () =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());

      const before = await currentUrl();
      expect(before).toContain('index.html');

      await window.evaluate(target => {
        globalThis.location.href = target;
      }, OFF_LIMITS);

      // `will-navigate` fires on the main process and the guard cancels it, so the document never
      // changes. Given half a second to be wrong before asserting that it is not.
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(await currentUrl()).toBe(before);
    });
  });

  test('refuses a dangerous scheme on the app:open-external channel', async () => {
    await withJoineryReact(async ({ window }) => {
      const rejection = await window.evaluate(async () => {
        const bridge = (
          globalThis as unknown as {
            joinery: { app: { openExternal: (url: string) => Promise<void> } };
          }
        ).joinery;
        try {
          await bridge.app.openExternal('javascript:alert(1)');
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });

      // The renderer must be told, not silently ignored — the markdown viewer and the welcome
      // panel both surface this message.
      expect(rejection).not.toBeNull();
      expect(rejection).toContain('javascript:');
    });
  });
});
