/**
 * The renderer's Content-Security-Policy.
 *
 * Two things are pinned here that are easy to get subtly wrong:
 *
 *  - **Production grants no inline script whatsoever.** Not `'unsafe-inline'`, and not a
 *    `sha256-` either: the hash route was implemented for the entry HTML's pre-mount theme script
 *    and MEASURED not to work over `file://` (Chromium echoes the correct digest back and refuses
 *    the script anyway), so J-22 moved that script to `public/theme-boot.js` instead. The last
 *    test in this file is the guard that keeps the entry HTML free of inline script, because that
 *    is what makes the production directive survivable.
 *  - **The directives Monaco, AG Grid and mermaid actually need.** These were measured in the
 *    Task 10 spike and written down at `packages/renderer/src/editor/monaco.ts`; the assertions
 *    below are that record turned into a gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, CSP_HEADER_NAME } from './content-security-policy';

const DEV_SERVER_URL = 'http://localhost:4200';

/** Split a policy string into `directive -> source list`. */
function directives(policy: string): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {};
  for (const clause of policy.split(';')) {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const [name, ...sources] = parts;
    expect(map[name], `directive ${name} appears twice`).toBeUndefined();
    map[name] = sources;
  }
  return map;
}

describe('CSP_HEADER_NAME', () => {
  it('is the enforcing header, not the report-only one', () => {
    expect(CSP_HEADER_NAME).toBe('Content-Security-Policy');
  });
});

describe('buildContentSecurityPolicy — production', () => {
  const policy = buildContentSecurityPolicy({ dev: false });
  const parsed = directives(policy);

  it('locks the default down to the app itself', () => {
    expect(parsed['default-src']).toEqual(["'self'"]);
  });

  it('allows no remote script, no inline script and no eval', () => {
    expect(parsed['script-src']).toEqual(["'self'"]);
    expect(policy).not.toContain('sha256-');
  });

  it('allows inline style, because Monaco, AG Grid, Dockview and Radix all set it', () => {
    // Monaco injects its theme as a <style> element; AG Grid, Dockview and Floating UI write
    // `style` attributes for layout. `style-src` governs both, so there is no way to drop this
    // without forking three libraries. Documented tradeoff, not an oversight.
    expect(parsed['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('allows the Monaco worker, from the bundle or from a blob', () => {
    // `?worker` emits a same-directory asset (matched by 'self'); the documented inline fallback
    // in editor/monaco.ts constructs it from a blob: URL.
    expect(parsed['worker-src']).toEqual(["'self'", 'blob:']);
  });

  it('allows data: and blob: images, and data: fonts', () => {
    // mermaid renders to an inline SVG that the app can serialise to a blob/data URL; the app
    // icon and codicon.ttf ride along as bundle assets.
    expect(parsed['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(parsed['font-src']).toEqual(["'self'", 'data:']);
  });

  it('permits no network egress from the renderer — every remote call lives in main', () => {
    expect(parsed['connect-src']).toEqual(["'self'"]);
  });

  it('closes the sinks that have no legitimate use in this app', () => {
    expect(parsed['object-src']).toEqual(["'none'"]);
    expect(parsed['frame-src']).toEqual(["'none'"]);
    expect(parsed['base-uri']).toEqual(["'none'"]);
    expect(parsed['form-action']).toEqual(["'none'"]);
    expect(parsed['frame-ancestors']).toEqual(["'none'"]);
  });

  it('never mentions the dev server, even if a URL is passed by mistake', () => {
    const withDevUrl = buildContentSecurityPolicy({ dev: false, devServerUrl: DEV_SERVER_URL });
    expect(withDevUrl).not.toContain('localhost');
    expect(withDevUrl).not.toContain('ws:');
  });

  it('is a single line with no trailing semicolon, so it is a valid header value', () => {
    expect(policy).not.toMatch(/[\r\n]/);
    expect(policy.endsWith(';')).toBe(false);
  });
});

describe('buildContentSecurityPolicy — development', () => {
  const policy = buildContentSecurityPolicy({ dev: true, devServerUrl: DEV_SERVER_URL });
  const parsed = directives(policy);

  it("allows inline script, because Vite's injected preamble cannot be known ahead of time", () => {
    // @vitejs/plugin-react injects an inline module preamble whose text the main process cannot
    // know, so 'unsafe-inline' is the only workable dev answer. This is the one place dev is
    // looser than production, and it is deliberate.
    expect(parsed['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("still refuses 'unsafe-eval', so a CSP-visible eval fails in dev too, not only in the DMG", () => {
    expect(parsed['script-src']).not.toContain("'unsafe-eval'");
  });

  it("opens connect-src to the dev server's websocket so Vite HMR can connect", () => {
    // 'self' is not reliably taken to cover a ws: URL, so the origin is listed explicitly.
    expect(parsed['connect-src']).toEqual([
      "'self'",
      'http://localhost:4200',
      'ws://localhost:4200',
    ]);
  });

  it('derives the websocket origin from the dev server URL rather than hard-coding a port', () => {
    const other = buildContentSecurityPolicy({ dev: true, devServerUrl: 'http://127.0.0.1:5173/' });
    expect(directives(other)['connect-src']).toEqual([
      "'self'",
      'http://127.0.0.1:5173',
      'ws://127.0.0.1:5173',
    ]);
  });

  it('keeps every non-script directive identical to production', () => {
    const prod = directives(buildContentSecurityPolicy({ dev: false }));
    for (const name of Object.keys(prod)) {
      if (name === 'script-src' || name === 'connect-src') continue;
      expect(parsed[name], `directive ${name} drifted between dev and prod`).toEqual(prod[name]);
    }
  });

  it('throws rather than emitting a policy with a hole when the dev server URL is missing', () => {
    expect(() => buildContentSecurityPolicy({ dev: true })).toThrow(/devServerUrl/);
    expect(() => buildContentSecurityPolicy({ dev: true, devServerUrl: 'not a url' })).toThrow(
      /devServerUrl/
    );
  });
});

// ── The guard that makes production's `script-src 'self'` survivable ─────────────────────────
//
// It is not enough for the policy to be strict; the renderer has to be able to live under it.
// The one thing that would silently break is an inline <script> in the entry HTML — it would run
// fine in dev (where 'unsafe-inline' is granted) and be blocked in the shipped DMG, which is the
// worst possible place to find out. So: no inline script, and this is where that is enforced.
describe('the renderer entry HTML', () => {
  const indexHtml = resolve(process.cwd(), 'packages/renderer/index.html');

  it('exists where this spec expects it', () => {
    expect(
      existsSync(indexHtml),
      `expected the renderer entry HTML at ${indexHtml}; is vitest running from the repo root?`
    ).toBe(true);
  });

  it('carries no inline <script>, so production needs no exception for one', () => {
    const html = readFileSync(indexHtml, 'utf-8');
    const inline: string[] = [];

    // The regex assumes no attribute value contains a `>`, which holds for this file.
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const [, attributes, body] = match;
      if (/\bsrc\s*=/i.test(attributes)) continue;
      if (body.trim() === '') continue;
      inline.push(body.trim().slice(0, 80));
    }

    expect(
      inline,
      "an inline <script> appeared in the entry HTML. Production ships `script-src 'self'`, " +
        'which will block it in the packaged app while dev keeps working. Move it to ' +
        'packages/renderer/public/ and load it with a src, as theme-boot.js does.'
    ).toEqual([]);
  });
});
