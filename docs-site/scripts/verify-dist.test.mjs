/**
 * Tests for `verify-dist.mjs`, the built-output guard (J-125).
 *
 *   node --test scripts/
 *
 * Run `pnpm run build` first: every case below works against the REAL `dist/`, copied to a
 * temporary directory and then deliberately broken one condition at a time. Synthesising a
 * fixture site instead would let the guard pass over a shape the build never emits — which is
 * the failure mode the guard exists to prevent, so it is not one the tests may reproduce.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  brandPaletteColours,
  contrastRatio,
  resolveColour,
  rootCustomProperties,
  syntaxColourFailures,
  verifyPalette,
} from './verify-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(HERE, '..');
const DIST = join(DOCS_ROOT, 'dist');
const GUARD = join(HERE, 'verify-dist.mjs');

/** Temporary copies made by `brokenDist`, removed once the file's cases are done. */
const scratchDirs = [];

before(() => {
  assert.ok(
    existsSync(join(DIST, 'index.html')),
    `${DIST}/index.html is missing — run \`pnpm run build\` before \`node --test scripts/\`.`
  );
});

after(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

/** Copy the real `dist/`, hand it to `mutate`, and return the copy's path. */
async function brokenDist(mutate) {
  const dir = await mkdtemp(join(tmpdir(), 'joinery-dist-'));
  scratchDirs.push(dir);
  await cp(DIST, dir, { recursive: true });
  await mutate(dir);
  return dir;
}

function runGuard(distDir) {
  const run = spawnSync(process.execPath, [GUARD, '--dist', distDir], { encoding: 'utf8' });
  assert.equal(run.error, undefined, `spawning the guard failed: ${run.error}`);
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

/** The first built page carrying Expressive Code's inline per-token custom properties. */
async function firstPageWithSyntaxSpans(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes('style="--0:#')) return path;
  }
  throw new Error(`no built page in ${dir} carries Expressive Code syntax spans`);
}

describe('contrastRatio', () => {
  test('spans the WCAG range', () => {
    assert.equal(contrastRatio('#ffffff', '#000000'), 21);
    assert.equal(contrastRatio('#4d7811', '#4d7811'), 1);
  });

  test('reproduces the ratio expressive-code-themes.mjs records for its thinnest margin', () => {
    // `IVORY.string` is annotated "4.67:1" against the ivory code canvas #F4F2EA.
    assert.equal(contrastRatio('#4d7811', '#f4f2ea').toFixed(2), '4.67');
  });
});

describe('brand.css', () => {
  const brandCss = () => readFile(join(DOCS_ROOT, 'src/styles/brand.css'), 'utf8');

  test('resolves --j-code-bg to the charcoal plane under ink and gray-7 under ivory', async () => {
    const properties = rootCustomProperties(await brandCss());
    assert.equal(resolveColour(properties.dark, '--j-code-bg'), '#272a27');
    assert.equal(resolveColour(properties.light, '--j-code-bg'), '#f4f2ea');
  });

  test('yields the palette the syntax themes are checked against', async () => {
    const colours = brandPaletteColours(rootCustomProperties(await brandCss()));
    // Two spot values from opposite ends of the file: a layer-1 brand constant and a derived one.
    assert.ok(colours.has('#c8f04a'), '--j-chartreuse');
    assert.ok(colours.has('#4d7811'), '--j-verify-deep');
    // The blue that `expressive-code-themes.mjs` was written to retire is not in it.
    assert.ok(!colours.has('#3b61b0'));
  });
});

describe('verifyPalette', () => {
  const canvases = { dark: '#272a27', light: '#f4f2ea' };
  const brandColours = new Set(['#4d7811', '#171817', '#8fd41c']);

  const theme = (overrides = {}) => ({
    name: 'joinery-ivory',
    type: 'light',
    colors: { 'editor.background': '#f4f2ea', 'editor.foreground': '#171817' },
    tokenColors: [{ scope: ['string'], settings: { foreground: '#4d7811', ...overrides } }],
  });

  test('passes the palette as shipped', () => {
    assert.deepEqual(verifyPalette([theme()], canvases, brandColours), []);
  });

  test('fails when a syntax colour is lightened below AA', () => {
    const failures = verifyPalette([theme({ foreground: '#8fd41c' })], canvases, brandColours);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /#8fd41c/);
    assert.match(failures[0], /4\.5/);
  });

  test('fails when a syntax colour is not a brand.css colour at all', () => {
    // #3B61B0 is the blue the theme fork was written to retire; contrast alone would pass it.
    const failures = verifyPalette([theme({ foreground: '#3b61b0' })], canvases, brandColours);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /off-palette/);
    assert.match(failures[0], /#3b61b0/);
  });

  test('accepts the two documented non-token comment colours', () => {
    const ivoryComment = theme({ foreground: '#666961' });
    assert.deepEqual(verifyPalette([ivoryComment], canvases, brandColours), []);
  });

  test('fails when the theme canvas drifts from brand.css', () => {
    const drifted = theme();
    drifted.colors['editor.background'] = '#fbfaf5';
    const failures = verifyPalette([drifted], canvases, brandColours);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /--j-code-bg/);
  });
});

describe('syntaxColourFailures', () => {
  const allowed = [new Set(['#c8f04a']), new Set(['#4d7811'])];

  test('accepts the pair Expressive Code emits for a string token', () => {
    const html = '<span style="--0:#C8F04A;--1:#4D7811">x</span>';
    assert.deepEqual(syntaxColourFailures(html, 'page.html', allowed), []);
  });

  test('rejects the #3B61B0 defect class', () => {
    const html = '<span style="--0:#C8F04A;--1:#3B61B0">x</span>';
    const failures = syntaxColourFailures(html, 'page.html', allowed);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /#3b61b0/i);
    assert.match(failures[0], /page\.html/);
  });
});

describe('the guard over a built site', () => {
  test('passes on the real dist/', () => {
    const { code, output } = runGuard(DIST);
    assert.equal(code, 0, output);
  });

  test('fails on an off-palette syntax colour', async () => {
    const dir = await brokenDist(async copy => {
      const page = await firstPageWithSyntaxSpans(copy);
      const html = await readFile(page, 'utf8');
      await writeFile(page, html.replace('style="--0:#', 'style="--0:#3B61B0;--9:#'));
    });
    const { code, output } = runGuard(dir);
    assert.equal(code, 1, output);
    assert.match(output, /#3b61b0/i);
  });

  test('fails when a landing href no longer resolves in the built output', async () => {
    const dir = await brokenDist(copy => rm(join(copy, 'about'), { recursive: true }));
    const { code, output } = runGuard(dir);
    assert.equal(code, 1, output);
    assert.match(output, /\/about\//);
  });

  test('fails when a landing fragment no longer resolves', async () => {
    const dir = await brokenDist(async copy => {
      const page = join(copy, 'index.html');
      const html = await readFile(page, 'utf8');
      await writeFile(page, html.replace('id="main"', 'id="content"'));
    });
    const { code, output } = runGuard(dir);
    assert.equal(code, 1, output);
    assert.match(output, /#main/);
  });

  test('fails rather than passing vacuously when the landing loses its links', async () => {
    const dir = await brokenDist(async copy => {
      const page = join(copy, 'index.html');
      const html = await readFile(page, 'utf8');
      await writeFile(page, html.replace(/href="[^"]*"/g, 'data-href=""'));
    });
    const { code, output } = runGuard(dir);
    assert.equal(code, 1, output);
    assert.match(output, /internal href/i);
  });

  test('fails rather than passing vacuously when the built pages lose their syntax spans', async () => {
    const dir = await brokenDist(async copy => {
      const entries = await readdir(copy, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
        const path = join(entry.parentPath, entry.name);
        const html = await readFile(path, 'utf8');
        if (html.includes('style="--0:#'))
          await writeFile(path, html.replace(/style="--\d[^"]*"/g, 'data-x=""'));
      }
    });
    const { code, output } = runGuard(dir);
    assert.equal(code, 1, output);
    assert.match(output, /syntax/i);
  });
});
