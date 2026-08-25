import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// `dangerouslySetInnerHTML` is banned outside src/markdown/. The Angular renderer bound
// unsanitized strings to `[innerHTML]` in several places; CLAUDE.md's AI rules answer that
// with exactly one sanctioned path — a single component that parses with `marked` and
// sanitizes with DOMPurify. src/markdown/ (Task 6) is that component's home and the only
// place the escape hatch is allowed; the ban lands now so nothing can grow a second one
// before it exists.
//
// Two selectors because the property reaches JSX through two different AST node types:
// `JSXIdentifier` for `<div dangerouslySetInnerHTML={…}>`, and `Identifier` for every
// other route — an object literal handed to `createElement`, a spread prop, a variable
// built up and passed along.
const NO_INNER_HTML = ['JSXIdentifier', 'Identifier'].map(nodeType => ({
  selector: `${nodeType}[name="dangerouslySetInnerHTML"]`,
  message:
    'dangerouslySetInnerHTML is banned outside src/markdown/. Render untrusted or ' +
    'AI-generated content through the markdown component, which sanitizes with DOMPurify.',
}));

// `window.joinery` is reachable from anywhere, and importing `JoineryAPI` makes it
// *type-clean* to reach: preload ships `declare global { interface Window { joinery:
// JoineryAPI } }`, so `window.joinery.query.execute(…)` compiles anywhere in the package
// with no availability guard and no query key. src/ipc/ is the one boundary that may read
// it (api.ts:findJoineryApi), and this turns that from a convention into a gate.
//
// Three selectors, because one is trivially bypassed and each of the first two was measured
// against a real bypass attempt before the next was added:
//
//  1. the canonical `window.joinery`, which carries the blame precisely;
//  2. the bare identifier, because `(window as SomeCast).joinery` is a TSAsExpression whose
//     `object.name` is not `window` — a cast defeats selector 1, and a cast is exactly what
//     someone working around the guard reaches for. This also covers `const { joinery } =
//     window`;
//  3. the computed form, because `(window as Cast)['joinery']` has a string Literal for its
//     property and so defeats BOTH of the above. Verified: before this selector existed that
//     line linted clean.
//
// `Object.defineProperty(window, 'joinery', …)` is deliberately still allowed — it is a
// CallExpression, not a member access, and it is how src/test/joinery-mock.ts installs the
// bridge for tests. A plain `window.joinery` trips selectors 1 and 2 and reports twice; that
// is noise on a line which must not exist at all.
const NO_BRIDGE_BYPASS = [
  'MemberExpression[object.name="window"][property.name="joinery"]',
  'Identifier[name="joinery"]',
  'MemberExpression[computed=true][property.value="joinery"]',
].map(selector => ({
  selector,
  message: 'Reach the bridge through src/ipc (ipc() / findJoineryApi()), never window.joinery.',
}));

// `ipcKeys.<ns>.key(op, …args)` is the query-key door that bypasses `useIpcQuery`'s required,
// separately-supplied `keyArgs` — the rule that keeps the three passwords `connection.test` takes,
// and the API keys `ai.setApiKey` takes, out of the query cache. It accepts any argument list, which
// is correct for invalidation (a partial key is the point there) and is exactly what a hand-rolled
// `useQuery({ queryKey: ipcKeys.x.key(…), queryFn: … })` would use to route around the discipline.
//
// Task 4's nine stores established that nothing outside this directory needs it: they hold their own
// state and call `ipc()` directly, so `key()` has no consumer except invalidation — and invalidation
// now has its own typed door, `useInvalidateIpc`. So the identifier is banned everywhere except
// `src/ipc/`, where `keys.ts`, `use-ipc-call.ts` and `use-invalidate-ipc.ts` live.
//
// One selector is enough here, unlike the bridge ban: `ipcKeys` is an imported binding rather than a
// global, so there is no cast or computed-access route to it — a file that does not name it in an
// import statement cannot reach it at all, and the import statement's specifier is an `Identifier`
// this catches.
const NO_KEY_FACTORY = [
  {
    selector: 'Identifier[name="ipcKeys"]',
    message:
      'ipcKeys is confined to src/ipc/. Invalidate with useInvalidateIpc(); read with useIpcQuery, ' +
      'which builds its own key from the keyArgs you supply.',
  },
];

// Monaco is confined to `src/editor/`, which is the fourth seam in this file and the same shape as
// the other three: one directory owns a dangerous surface and everywhere else must go through it.
//
// The surface here is not a global but an import, so the rule is `no-restricted-imports` rather than
// another `no-restricted-syntax` selector — which is also why it needs no partitioning: it is a
// different rule id, so the `src/editor/**` override below cannot disturb the three bans above.
//
// Both patterns matter. `monaco-editor` is the bare specifier; `monaco-editor/*` covers the deep paths
// this app actually uses (`monaco-editor/editor/editor.main.js`, and the `?worker` import of
// `editor/common/services/editorWebWorkerMain.js`). Reaching either one outside the seam means a second
// owner of the theme, the worker environment and the language providers — which the Angular renderer had,
// registering its completion provider once per query tab.
const NO_MONACO_OUTSIDE_EDITOR = [
  {
    patterns: [
      {
        group: ['monaco-editor', 'monaco-editor/*'],
        message:
          'Monaco is confined to src/editor/. Use <SqlEditor> and its handle, or add what you need to ' +
          'src/editor/index.ts — the worker environment, the two themes and the SQL providers are ' +
          'registered exactly once, there.',
      },
    ],
  },
];

// Flat config, and therefore ESLint 9 pinned to this package rather than the
// repo-root ESLint 8 + .eslintrc.json, which still governs `packages/main`,
// `packages/preload`, `packages/cli` and the test tree. The two majors coexist
// deliberately (.syncpackrc ignores the mismatch): migrating the root to flat
// config is its own change with its own verification, and it is unrelated to
// deleting the Angular renderer, which is what this note used to be waiting on.
export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // `configs.flat.*` — the top-level `configs['recommended*']` keys are still the
  // legacy eslintrc shape and blow up under flat config.
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    languageOptions: {
      // No `globals.node`: the bundle runs sandboxed with nodeIntegration: false.
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
      'object-shorthand': 'error',
      'prefer-const': 'error',
      'no-restricted-imports': ['error', ...NO_MONACO_OUTSIDE_EDITOR],
    },
  },
  // The Monaco seam. Only `no-restricted-imports` is turned off here — the three `no-restricted-syntax`
  // bans still apply, so an editor file may not use innerHTML, reach the bridge, or name `ipcKeys`.
  { files: ['src/editor/**'], rules: { 'no-restricted-imports': 'off' } },
  {
    files: ['vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  // `public/theme-boot.js` — the pre-mount theme script, which J-22 moved out of `index.html`
  // so production's `script-src 'self'` could cover it. It runs before the bundle exists, so
  // `state/diagnostics` is not reachable from it and `console.warn` is its only way to be
  // non-silent about blocked storage. It is also plain ES5 in a copied-verbatim asset, not a
  // module: nothing here imports, and nothing may import it.
  { files: ['public/**/*.js'], rules: { 'no-console': 'off' } },
  // The three bans, and the ORDER AND SHAPE OF THESE THREE BLOCKS IS LOAD-BEARING.
  //
  // `no-restricted-syntax` options do NOT merge across flat-config objects: for a given
  // file, the last matching object replaces the rule's options wholesale. So the obvious
  // spelling — one block per ban, each with its own `ignores` — silently deletes the first
  // ban everywhere the second block also matches. That was measured, not assumed: with a
  // second `{ ignores: ['src/ipc/**'], rules: { 'no-restricted-syntax': [bridge] } }` block
  // appended, a fixture containing BOTH violations reported zero errors.
  //
  // So the file sets are partitioned instead, and each block states the complete rule for
  // the files it matches. src/markdown/ and src/ipc/ do not overlap, so every file resolves
  // to exactly one of these three. `ban-rules.spec.ts` asserts all four quadrants.
  {
    rules: {
      'no-restricted-syntax': ['error', ...NO_INNER_HTML, ...NO_BRIDGE_BYPASS, ...NO_KEY_FACTORY],
    },
  },
  // Task 6's sanitizing markdown component: may use innerHTML, may not touch the bridge or its keys.
  {
    files: ['src/markdown/**'],
    rules: { 'no-restricted-syntax': ['error', ...NO_BRIDGE_BYPASS, ...NO_KEY_FACTORY] },
  },
  // The IPC boundary: may read the bridge and own its query keys, may not use innerHTML.
  { files: ['src/ipc/**'], rules: { 'no-restricted-syntax': ['error', ...NO_INNER_HTML] } },
  // Last: turns off everything Prettier already owns.
  prettier
);
