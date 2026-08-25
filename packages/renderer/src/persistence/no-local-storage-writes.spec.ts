/**
 * The structural guard on which modules may touch localStorage at all.
 *
 * Real user data is at stake — the whole snippet library was in the Angular keys and nowhere else
 * (PLAN.md 0.5) — so "only these two files, only these operations" cannot be a convention that
 * survives on comments: it has to be checkable. This spec is that check, and it is deliberately
 * about the source text rather than about behaviour, because behaviour tests can only cover the code
 * paths someone thought to test.
 *
 * ── The two permitted files, and the cutover ruling on each (Task 24) ─────────────────────────
 *
 * **`persistence/theme-mirror.ts` — the one `setItem`.** THE MIRROR STAYS. `index.html`'s pre-mount
 * script needs a synchronous source for the theme and there is no other: `AppState` is async IPC,
 * and a preload-injected global is not available to a `<head>` script. What it lost is its
 * `joinery-settings` fallback — that key is now deleted by the migration, so the fallback would be
 * live for at most one boot. The module documents the trade.
 *
 * **`persistence/legacy-local-storage.ts` — the one `removeItem`.** Until the cutover this file had
 * neither `setItem` nor `removeItem`, because the Angular renderer still read all six keys on every
 * boot. Angular is gone, so `migration.ts` now removes each key it has lifted, AFTER main
 * acknowledged the write and never for a key that failed to parse. That ordering is the whole
 * safety argument and it lives in `migration.ts`; this spec's job is only to keep the operation
 * confined to the one module that owns those key names.
 *
 * Everything else in the package — including any future feature — must persist through
 * main-process `AppState`. There is no `clear()` anywhere, ever: it would take keys this package
 * does not own.
 *
 * `import.meta.glob` rather than `node:fs`: this package's tsconfig omits `@types/node` on purpose
 * (`tsconfig.json:28-32`), and Vite's raw-glob import is typed by `vite/client`, which it does not.
 */

import { describe, expect, it } from 'vitest';
import { THEME_MIRROR_KEY } from './theme-mirror';

/** Every non-spec source file in the package, as text. Keyed by a path relative to `src/`. */
const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Specs and test helpers seed and clear their own jsdom storage; that is not user data. */
function isProductionSource(path: string): boolean {
  return !path.includes('.spec.') && !path.startsWith('../test/');
}

/**
 * The pre-mount script reads the same keys and must stay a reader. Not a module — and, since
 * J-22, not inline in `index.html` either: production ships `script-src 'self'`, which no inline
 * script satisfies, so it moved to `public/theme-boot.js`. Same code, same rules, new home.
 */
const preMountScript = Object.values(
  import.meta.glob<string>('../../public/theme-boot.js', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
);

/** The entry HTML, which must now carry no storage access of its own at all. */
const entryHtml = Object.values(
  import.meta.glob<string>('../../index.html', { query: '?raw', import: 'default', eager: true })
);

const WRITE_CALL = /localStorage\s*\.\s*(setItem|removeItem|clear)\b/;
/** `localStorage['setItem']` — a computed access defeats the pattern above. */
const COMPUTED_ACCESS = /localStorage\s*\[/;
/**
 * The alias escape: `const store = window.localStorage` (or a destructure, or passing it as an
 * argument) hands the object to code this spec cannot follow, and `store.setItem(…)` then looks
 * like any other method call. Reaching localStorage is only allowed to happen in place.
 */
const ALIASING =
  /(=\s*(window\s*\.\s*)?localStorage\b)|(\{[^}\n]*\blocalStorage\b[^}\n]*\}\s*=)|([(,]\s*(window\s*\.\s*)?localStorage\s*[,)])/;

function filesMatching(pattern: RegExp): { path: string; hits: string[] }[] {
  return Object.entries(sources)
    .filter(([path]) => isProductionSource(path))
    .map(([path, source]) => ({ path, hits: source.match(new RegExp(pattern.source, 'g')) ?? [] }))
    .filter(({ hits }) => hits.length > 0);
}

describe('no code path may write a localStorage key', () => {
  it('finds the sources at all, so a broken glob cannot pass this suite vacuously', () => {
    const paths = Object.keys(sources).filter(isProductionSource);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.some(path => path.endsWith('theme-mirror.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('legacy-local-storage.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('state/tab.ts'))).toBe(true);
  });

  it('permits exactly two files to touch storage, each with exactly one operation', () => {
    const writers = filesMatching(WRITE_CALL);

    // Glob keys are relative to this file, so both are siblings.
    expect(writers.map(({ path }) => path).sort()).toEqual([
      './legacy-local-storage.ts',
      './theme-mirror.ts',
    ]);
    const byPath = new Map(writers.map(({ path, hits }) => [path, hits]));
    // The mirror WRITES and never removes; the legacy module REMOVES and never writes. Each file's
    // full hit list is asserted, so a second operation appearing in either one fails here.
    expect(byPath.get('./theme-mirror.ts')).toEqual(['localStorage.setItem']);
    expect(byPath.get('./legacy-local-storage.ts')).toEqual(['localStorage.removeItem']);
  });

  it('confines removeItem to the module that owns the six key names', () => {
    // `tab.state.ts:465` — and Task 4's port of it — called `removeItem` on an Angular-owned key
    // from a store that had no business deciding the key was disposable. The removal now lives
    // next to the reads, behind `migration.ts`'s "written and acknowledged" precondition.
    const destructive = filesMatching(/localStorage\s*\.\s*removeItem\b/);
    expect(destructive.map(({ path }) => path)).toEqual(['./legacy-local-storage.ts']);
  });

  it('has no clear() anywhere, which would take keys this package does not own', () => {
    expect(filesMatching(/localStorage\s*\.\s*clear\b/)).toEqual([]);
  });

  it('keeps the destructive function to exactly one caller', () => {
    // The test above confines `removeItem` to one FILE. That is not enough on its own: a wrapper
    // around it can be called from anywhere, and `clearLegacyLocalStorage`'s safety is entirely a
    // property of its single caller establishing the preconditions (write acknowledged, lift
    // uncontested, key neither rejected nor partial). So the arity is asserted rather than
    // documented. `persistence/index.ts` deliberately does not re-export it.
    //
    // Matches a CALL, not a mention, so the barrel's comment explaining the omission does not
    // register as a caller.
    const callers = Object.entries(sources)
      .filter(([path]) => isProductionSource(path) && !path.endsWith('legacy-local-storage.ts'))
      .filter(([, source]) => /\bclearLegacyLocalStorage\s*\(/.test(source))
      .map(([path]) => path);

    expect(callers).toEqual(['./migration.ts']);
  });

  it('has no computed localStorage access, which would sidestep the check above', () => {
    expect(filesMatching(COMPUTED_ACCESS)).toEqual([]);
  });

  it('never aliases the storage object, which would sidestep it too', () => {
    expect(filesMatching(ALIASING)).toEqual([]);
  });

  it('keeps the pre-mount script a reader, of the mirror only', () => {
    // It runs before any module and duplicates the mirror read, so it is outside the glob above and
    // would otherwise never be checked at all.
    expect(preMountScript).toHaveLength(1);
    const html = preMountScript[0] ?? '';
    expect(html).toMatch(/localStorage\s*\.\s*getItem/);
    expect(html).not.toMatch(WRITE_CALL);
    expect(html).not.toMatch(COMPUTED_ACCESS);
    expect(html).not.toMatch(ALIASING);

    // The cutover ruling, asserted rather than described: the script reads the React-owned mirror
    // and no longer falls back to Angular's settings object — a key the migration now deletes.
    // Both halves matter; a script still naming `joinery-settings` would be reading a key that is
    // gone by the second boot.
    const read = (key: string): boolean => html.includes(`'${key}'`);
    expect(read(THEME_MIRROR_KEY)).toBe(true);
    expect(read('joinery-settings')).toBe(false);
  });

  it('leaves no storage access behind in the entry HTML itself', () => {
    // The script moved out of `index.html` for the CSP (J-22). This asserts the move was a move
    // and not a copy: a leftover inline reader there would be invisible to every other check in
    // this file, since the glob above only reaches `public/theme-boot.js` now.
    expect(entryHtml).toHaveLength(1);
    expect(entryHtml[0] ?? '').not.toMatch(/localStorage/);
  });

  it('writes a React-owned key, not one of the Angular six', () => {
    // The mirror's key name is the other half of the claim: one writer is only safe if what it
    // writes is ours. `legacy-local-storage.ts` owns the list of names that are not.
    expect(THEME_MIRROR_KEY.startsWith('joinery')).toBe(true);
    const quoted = (sources['./legacy-local-storage.ts'] ?? '').match(/'joinery[^']*'/g) ?? [];
    const angularKeys = new Set(quoted.map(literal => literal.slice(1, -1)));
    expect(angularKeys.size).toBeGreaterThanOrEqual(6);
    expect(angularKeys.has(THEME_MIRROR_KEY)).toBe(false);
  });
});
