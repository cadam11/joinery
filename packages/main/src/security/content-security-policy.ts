/**
 * The renderer's Content-Security-Policy.
 *
 * Joinery ships no CSP before J-22, which means a script that reaches the renderer can pull code
 * from anywhere. The policy below is the second half of the same fix as `navigation-guard.ts`:
 * that one keeps a hostile *document* out of the window, this one keeps hostile *code* out of the
 * document we do load.
 *
 * ── Where the loosenings come from ────────────────────────────────────────────────────────────
 *
 * Every non-`'self'` source here was measured in the Task 10 Monaco spike, whose findings are
 * written up at `packages/renderer/src/editor/monaco.ts`:
 *
 *  - `worker-src 'self' blob:` — Monaco's editor worker. Vite's `?worker` import emits it as a
 *    same-directory bundle asset, which `'self'` matches even over `file://`; the documented
 *    `?worker&inline` fallback constructs it from a `blob:` URL, so both wirings are covered and
 *    switching between them is not a CSP change.
 *  - `style-src 'unsafe-inline'` — Monaco injects its theme as a `<style>` element, and AG Grid,
 *    Dockview and Floating UI write `style` attributes for layout. `style-src` governs inline
 *    style attributes as well as elements, so there is no way to drop this without forking three
 *    libraries. This is the policy's one real weakness and it is a deliberate tradeoff.
 *
 * Monaco needs neither `'unsafe-eval'` nor `connect-src`, so neither is granted. One known
 * console report survives: zod 4 probes `Function('')` once behind a lazy getter to decide
 * whether it may JIT, catches the failure and falls back — a report, not a malfunction.
 *
 * ── Why production grants no inline script at all, not even a hash ────────────────────────────
 *
 * `packages/renderer/index.html` used to run its pre-mount theme script inline, and the obvious
 * accommodation was a `sha256-` of that script in `script-src`. It was implemented, and then
 * MEASURED not to work: over `file://` Chromium echoes the policy back with the correct digest
 * in it, reports the digest it requires — byte-identical — and refuses to execute the script
 * anyway. A `nonce-` is not available either, since nothing rewrites the HTML at load time. So
 * J-22 moved that script to `packages/renderer/public/theme-boot.js`, where plain `'self'`
 * covers it, and this module carries no inline-script accommodation at all. The guard that keeps
 * it that way is in this module's spec.
 */

/** The enforcing header. Report-only would document the policy without applying it. */
export const CSP_HEADER_NAME = 'Content-Security-Policy';

export interface ContentSecurityPolicyInput {
  /** `true` when the renderer is the Vite dev server rather than the built bundle. */
  readonly dev: boolean;
  /** The dev server's URL (e.g. `http://localhost:4200`). Required when `dev`, ignored otherwise. */
  readonly devServerUrl?: string;
}

/** `["'self'", 'http://localhost:4200', 'ws://localhost:4200']` for a dev server URL. */
function devConnectSources(devServerUrl: string): readonly string[] {
  let origin: URL;
  try {
    origin = new URL(devServerUrl);
  } catch {
    throw new Error(`Cannot build a development CSP: devServerUrl "${devServerUrl}" is not a URL`);
  }
  // `'self'` is not reliably read as covering a `ws:` URL, so Vite's HMR socket is listed
  // explicitly rather than hoped for.
  return ["'self'", origin.origin, `ws://${origin.host}`];
}

/**
 * The policy string for one build.
 *
 * The dev/prod split is confined to two directives, and both differences are forced:
 *
 *  - **`script-src`.** `@vitejs/plugin-react` injects an inline module preamble whose text the
 *    main process cannot know ahead of time, so dev needs `'unsafe-inline'`. Production grants
 *    `'self'` and nothing else. `'unsafe-eval'` is granted in neither: keeping dev honest about
 *    `eval` is worth more than silencing a console report.
 *  - **`connect-src`.** Vite's HMR websocket. Production grants `'self'` only, because every
 *    remote call Joinery makes — LLM providers included — happens in the main process.
 */
export function buildContentSecurityPolicy(input: ContentSecurityPolicyInput): string {
  const { dev, devServerUrl } = input;

  if (dev && !devServerUrl) {
    throw new Error('Cannot build a development CSP without a devServerUrl');
  }

  const scriptSources = dev ? ["'self'", "'unsafe-inline'"] : ["'self'"];
  const connectSources = dev ? devConnectSources(devServerUrl as string) : ["'self'"];

  const directives: readonly (readonly [string, readonly string[]])[] = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSources],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // `data:` for the app's inline SVG/PNG assets, `blob:` for a serialised mermaid diagram.
    ['img-src', ["'self'", 'data:', 'blob:']],
    // `data:` because a bundled font can be inlined below Vite's asset threshold.
    ['font-src', ["'self'", 'data:']],
    ['worker-src', ["'self'", 'blob:']],
    ['connect-src', connectSources],
    // The sinks with no legitimate use in this app: no plugins, no iframes, no <base> rewriting,
    // no form posts, and nothing may frame us.
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
}
