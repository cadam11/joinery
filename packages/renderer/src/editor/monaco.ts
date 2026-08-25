/**
 * The one module in this package that imports Monaco at runtime, and the one that installs its
 * worker environment. Everything else in `src/editor/` imports Monaco **as types only**, and
 * `eslint.config.js` bans the specifier everywhere outside this directory — the same shape as the
 * `src/markdown/` sanitize seam and the `src/ipc/` bridge seam.
 *
 * ── Why the worker wiring looks like this (Task 10 Step 0, PLAN.md R1) ──────────────────────
 *
 * The R1 spike ran three candidate wirings against the PACKAGED app — the React bundle inside
 * `app.asar`, loaded over `file://`, `sandbox: true` — and only two of them work. The full evidence
 * is in `.superpowers/sdd/PLAN/task-10-report.md`; what matters here is why `getWorker` is not
 * optional:
 *
 * Monaco 0.56 can resolve its own worker. `editorWorkerService.js:58` declares
 * `esmModuleLocationBundler: () => new URL('…/editorWebWorkerMain.js', import.meta.url)`, and Vite
 * does rewrite that — but it rewrites it as a **copied asset**, not as a bundled worker, so the file
 * that lands in the asar still contains Monaco's own relative imports. Monaco then wraps the URL in a
 * **blob module worker** that `await import()`s it (`webWorkerServiceImpl.js:getWorkerBootstrapUrl`),
 * and inside a `blob:file:///<uuid>` module those relative specifiers cannot be resolved at all:
 *
 *   Failed to resolve module specifier "../../../base/common/worker/webWorkerBootstrap.js".
 *   Invalid relative url or base scheme isn't hierarchical.
 *
 * The failure is worse than it looks, and it is the reason this is wired explicitly rather than left
 * to a "it seems to work" default: the `new Worker(...)` call itself SUCCEEDS, so
 * `EditorWorkerClient._getOrCreateWorker` never throws, the main-thread fallback never installs, and
 * nothing is logged. `$ping` simply never answers. Measured: a worker-backed operation waits
 * forever, in silence.
 *
 * Vite's `?worker` import fixes it by bundling the worker's whole graph into one chunk, which the
 * spike then measured loading as `new Worker('file://…/assets/editorWebWorkerMain-<hash>.js')` from a
 * `file://` document inside the asar — allowed, no CSP violation, and the diff round trip returned
 * real line changes with no fallback warning.
 *
 * **The documented fallback, if it is ever needed:** change the specifier below to
 * `…editorWebWorkerMain.js?worker&inline`, which embeds the worker source and constructs it from a
 * `blob:` URL. The spike measured that wiring working too, so this is a one-word change rather than a
 * research project. It is not the default because an inline worker is duplicated bytes in the main
 * chunk and a `blob:` worker is harder to attribute in a profile.
 *
 * **What a CSP has to allow** (PLAN.md §8 asks this task to record it): `worker-src 'self' blob:`
 * covers both wirings — measured, including the `file://` worker, which `'self'` does match for a
 * same-directory asset. Monaco also needs `style-src 'unsafe-inline'` (it injects its theme as a
 * `<style>` element) and `font-src 'self'` (codicon.ttf). Monaco itself needs neither `unsafe-eval`
 * nor `connect-src`. The two violations the spike's candidate policy DID report belong to this app,
 * not to Monaco: `index.html`'s pre-mount theme script, and zod 4 probing `Function('')` once
 * behind a lazy getter to decide whether it may JIT (it catches the failure and falls back, so a
 * CSP costs one console report and nothing else).
 *
 * **The CSP shipped in J-22** grants exactly the above (`packages/main/src/security/
 * content-security-policy.ts`), and its production `script-src` is `'self'` alone. The spike's
 * suggestion that the pre-mount script "needs a hash or a nonce" did not survive contact: the hash
 * route was implemented and measured NOT to work over `file://`, so that script moved out of
 * `index.html` into `packages/renderer/public/theme-boot.js` instead, where `'self'` covers it. The
 * `blob:` worker and the `data:`/`blob:` images are asserted live in `tests/e2e-react/
 * security.spec.ts`; the `'self'` worker is not, because it needs a DB connection to mount.
 *
 * ── The entry point ────────────────────────────────────────────────────────────────────────
 *
 * `editor/editor.main.js` rather than the bare `monaco-editor` specifier or `editor.api.js` alone:
 *
 *  - the bare specifier resolves to `esm/vs/index.js`, which additionally pulls the LSP client;
 *  - `editor.api.js` is the typed API surface and NOTHING else — no find widget, no suggest
 *    controller, no comment action, i.e. none of the commands this task takes over. Monaco 0.56
 *    removed `editor.all.js`, so `editor.main.js` is the only entry that carries the contributions
 *    without hand-listing forty of them.
 *
 * `editor.main.js` also registers all ~80 basic languages, but each one is a `registerLanguage` stub
 * with a dynamic `import()` loader, so only the three SQL dialects this app selects are ever fetched
 * (`sql`, `pgsql` and `mysql` land as their own lazy chunks). The types come from `editor.api.js`
 * because `editor.main.js` ships no `.d.ts` of its own; both specifiers resolve into the same module
 * graph, so this is one instance, not two.
 */

import 'monaco-editor/editor/editor.main.js';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/common/services/editorWebWorkerMain.js?worker';

/**
 * Installed at module-evaluation time, which is the only correct moment: Monaco reads
 * `globalThis.MonacoEnvironment` the first time something needs a worker, and by then the first
 * editor may already exist. Since this module is the only importer of Monaco, "before Monaco is
 * used" and "when this module evaluates" are the same instant.
 *
 * `label` is ignored on purpose. Only one worker kind can be reached from here: the editor worker.
 * The four language-service workers (`css`/`html`/`json`/`ts`) are emitted as assets by
 * `editor.main.js`'s feature registrations but can only be requested by opening a model in one of
 * those languages, which this app never does — every model it creates is SQL.
 */
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };
