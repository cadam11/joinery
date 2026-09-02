#!/usr/bin/env node
/**
 * Assert two properties of the BUILT site that nothing else on this project checks (J-125,
 * from J-99 Phase 3).
 *
 *   node scripts/verify-dist.mjs [--dist <directory>]
 *
 * `pnpm run build` chains it after `astro build`, so a regression in either property fails the
 * build — locally and in `.github/workflows/docs.yml`, which runs that same script. It reads
 * only the built output and the two source files the expected values come from; it needs no
 * dependency beyond Node.
 *
 * ── 1. The syntax palette ───────────────────────────────────────────────────────────────────
 *
 * Expressive Code writes each token's colour as an inline custom property on the span itself
 * (`style="--0:#C8F04A;--1:#4D7811"` — `--0` is the first theme in `joineryEcThemes`, `--1` the
 * second), generated at build time from the theme's own `tokenColors`. No stylesheet can reach
 * those values, so the built HTML is the only place a wrong one shows up. That is exactly how
 * the #3B61B0 keyword/string blue was found by hand, three separate times.
 *
 * Two assertions, and the expected values come from source rather than from a snapshot of
 * today's output — a guard that agrees with whatever the build just emitted verifies nothing:
 *
 *   a. Every `--N:#rrggbb` in every built page is one of the colours
 *      `src/styles/expressive-code-themes.mjs` declares for that theme. This is what catches a
 *      value the site never chose — Expressive Code's own contrast auto-adjustment, a Starlight
 *      default leaking through, or a stale `dist/`.
 *   b. Every colour that file declares is itself a colour `src/styles/brand.css` declares, save
 *      for the two named in `UNTOKENISED_SYNTAX_COLOURS` below. Without this, (a) is circular:
 *      writing a blue into the theme file would make the built page agree with it. brand.css's
 *      own authority chain is `docs/brand/tokens.css` and `plans/ui-overhaul/PROPOSAL.md` §2.2.
 *   c. Every colour that file declares clears WCAG AA (4.5:1) against the canvas the code block
 *      actually paints on, which is `--j-code-bg` resolved out of `src/styles/brand.css` — the
 *      charcoal plane under ink, `--sl-color-gray-7` under ivory. The thinnest current margin is
 *      the ivory string role, #4D7811 at 4.67:1, and any future lightening of either the colour
 *      or the canvas erodes it silently. The theme's own `editor.background` is checked against
 *      the same resolved value, so the ratios recorded beside each colour stay honest.
 *
 * ── 2. The landing page's links ─────────────────────────────────────────────────────────────
 *
 * `starlight-links-validator` collects links from the Markdown processor and from Starlight
 * frontmatter. `src/pages/index.astro` is the one non-Starlight route on the site, so its
 * internal links are invisible to it and sat outside every automated gate. Each one is resolved
 * here against the built output — the page file must exist, and a fragment must name an `id`
 * that is really in the target page.
 *
 * Both checks carry a floor (`MIN_SYNTAX_SPANS`, `MIN_INTERNAL_HREFS`). A guard that stops
 * matching passes silently otherwise, which is the one failure mode that would make it worse
 * than nothing.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { joineryEcThemes } from '../src/styles/expressive-code-themes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(HERE, '..');
const BRAND_CSS = join(DOCS_ROOT, 'src/styles/brand.css');
const ASTRO_CONFIG = join(DOCS_ROOT, 'astro.config.mjs');

/** WCAG AA for body text. `expressive-code-themes.mjs` measures every value against this. */
const AA_CONTRAST = 4.5;

/* Explicit caps. Each one is an assertion about the shape of the site, not a performance knob. */
const MAX_CSS_BLOCKS = 500;
const MAX_VAR_HOPS = 8;
const MAX_HTML_FILES = 500;
const MAX_LANDING_HREFS = 500;
const MAX_REPORTED_FAILURES = 40;

/*
 * Floors, so neither check can pass by matching nothing. The built site currently carries ~175
 * syntax spans and 33 distinct internal landing hrefs (31 of them page links, plus the canonical
 * URL and the favicon); both floors sit well under that and well over zero.
 */
const MIN_SYNTAX_SPANS = 50;
const MIN_INTERNAL_HREFS = 30;

// ── Colour ────────────────────────────────────────────────────────────────────────────────────

/** The three 0-255 channels of `#rgb` or `#rrggbb`. Throws on anything else. */
function hexChannels(hex) {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) throw new Error(`Not an opaque hex colour: ${JSON.stringify(hex)}`);
  const digits = match[1];
  const wide = digits.length === 3 ? [...digits].map(d => d + d).join('') : digits;
  return [0, 2, 4].map(at => parseInt(wide.slice(at, at + 2), 16));
}

/** WCAG 2.x relative luminance. */
function relativeLuminance(hex) {
  const [r, g, b] = hexChannels(hex).map(channel => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. Order-independent. */
export function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a
  );
  return (lighter + 0.05) / (darker + 0.05);
}

// ── brand.css ─────────────────────────────────────────────────────────────────────────────────

/** Which canvases a selector list applies to. Non-`:root` rules hold no palette and are skipped. */
function modesForSelector(selector) {
  const modes = new Set();
  for (const part of selector.split(',')) {
    const one = part.trim();
    if (one.includes("[data-theme='light']")) modes.add('light');
    else if (one.includes("[data-theme='dark']")) modes.add('dark');
    else if (one.endsWith(':root')) {
      modes.add('dark');
      modes.add('light');
    }
  }
  return [...modes];
}

/**
 * The custom properties `:root` declares, split by canvas and applied in source order so the
 * result is what the cascade resolves on a page of that theme.
 */
export function rootCustomProperties(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const properties = { dark: new Map(), light: new Map() };
  let blocks = 0;
  for (const [, selector, body] of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    blocks += 1;
    if (blocks > MAX_CSS_BLOCKS) {
      throw new Error(`${BRAND_CSS} has more than ${MAX_CSS_BLOCKS} rules`);
    }
    const modes = modesForSelector(selector);
    if (modes.length === 0) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      for (const mode of modes) properties[mode].set(name, value.trim());
    }
  }
  return properties;
}

/** Follow `var(--x)` indirection to the opaque hex a custom property finally resolves to. */
export function resolveColour(properties, name) {
  let current = name;
  for (let hop = 0; hop <= MAX_VAR_HOPS; hop += 1) {
    const value = properties.get(current);
    if (value === undefined) throw new Error(`brand.css declares no ${current} (from ${name})`);
    const indirect = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    if (!indirect) return value.toLowerCase();
    current = indirect[1];
  }
  throw new Error(`${name} is still indirect after ${MAX_VAR_HOPS} var() hops in brand.css`);
}

/**
 * The syntax colours that are deliberately NOT `brand.css` tokens. Both are comment roles, and
 * both are documented at their declaration in `src/styles/expressive-code-themes.mjs`: a syntax
 * colour never reaches a stylesheet, so there is nothing for a token to be read by. Adding a
 * third entry here should take an argument, which is the point of listing them.
 */
const UNTOKENISED_SYNTAX_COLOURS = new Map([
  ['#95988f', "INK.comment — the app's #85887F lifted to clear AA on the charcoal code canvas"],
  ['#666961', 'IVORY.comment — measured against the ivory code canvas, not a UI surface'],
]);

/** Every opaque hex `brand.css` declares on a `:root` rule, in either canvas. */
export function brandPaletteColours(properties) {
  const colours = new Set();
  for (const map of [properties.dark, properties.light]) {
    for (const value of map.values()) {
      const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
      if (hex) colours.add(value.toLowerCase());
    }
  }
  return colours;
}

/**
 * What `brand.css` is the authority for: `--j-code-bg` per canvas, which is the surface a fenced
 * code block actually paints on, and the full set of colours the file declares.
 */
async function brandPalette() {
  const css = await readFile(BRAND_CSS, 'utf8');
  const properties = rootCustomProperties(css);
  const canvases = {
    dark: resolveColour(properties.dark, '--j-code-bg'),
    light: resolveColour(properties.light, '--j-code-bg'),
  };
  // Both canvases must be opaque hex: every contrast ratio below is measured against them.
  hexChannels(canvases.dark);
  hexChannels(canvases.light);
  return { canvases, colours: brandPaletteColours(properties) };
}

// ── Check 1: the syntax palette ───────────────────────────────────────────────────────────────

/** Every colour a theme can put on a token, as `[label, hex]`, deduplicated by colour. */
function themeColours(theme) {
  const byColour = new Map();
  const foreground = theme.colors?.['editor.foreground'];
  if (typeof foreground === 'string') byColour.set(foreground.toLowerCase(), 'editor.foreground');
  for (const rule of theme.tokenColors ?? []) {
    const colour = rule.settings?.foreground;
    if (typeof colour !== 'string') continue;
    const label = Array.isArray(rule.scope) ? rule.scope[0] : String(rule.scope);
    if (!byColour.has(colour.toLowerCase())) byColour.set(colour.toLowerCase(), label);
  }
  return [...byColour].map(([colour, label]) => [label, colour]);
}

/**
 * The source half of check 1 (assertions b and c): each theme's declared canvas agrees with
 * brand.css, and every colour it can emit is both a brand.css colour and AA-legible on that
 * canvas.
 */
export function verifyPalette(themes, canvases, brandColours) {
  const failures = [];
  for (const theme of themes) {
    const canvas = canvases[theme.type];
    if (canvas === undefined) {
      failures.push(`${theme.name}: unknown theme type ${JSON.stringify(theme.type)}.`);
      continue;
    }
    const declared = String(theme.colors?.['editor.background'] ?? '').toLowerCase();
    if (declared !== canvas) {
      failures.push(
        `${theme.name}: editor.background is ${declared || '(unset)'}, but brand.css resolves ` +
          `--j-code-bg to ${canvas} on the ${theme.type} canvas.`
      );
    }
    for (const [label, colour] of themeColours(theme)) {
      if (!brandColours.has(colour) && !UNTOKENISED_SYNTAX_COLOURS.has(colour)) {
        failures.push(
          `${theme.name}: ${label} ${colour} is off-palette — src/styles/brand.css declares no ` +
            `such colour, and it is not one of the documented exceptions in verify-dist.mjs.`
        );
      }
      const ratio = contrastRatio(colour, canvas);
      if (ratio >= AA_CONTRAST) continue;
      failures.push(
        `${theme.name}: ${label} ${colour} measures ${ratio.toFixed(2)}:1 on ${canvas}, ` +
          `under the AA floor of ${AA_CONTRAST}:1.`
      );
    }
  }
  return failures;
}

/** One allow-set of lowercase hexes per theme, indexed the way Expressive Code names them. */
function allowedSyntaxColours(themes) {
  return themes.map(theme => new Set(themeColours(theme).map(([, colour]) => colour)));
}

/**
 * The dist half of check 1, for one built page. One message per distinct (theme, colour) pair:
 * a single wrong value lands on every token of that role on the page, and forty copies of one
 * sentence is a report nobody reads.
 */
export function syntaxColourFailures(html, file, allowedByThemeIndex) {
  const failures = new Map();
  for (const [, index, hex] of html.matchAll(/--(\d+):(#[0-9a-fA-F]{3,8})/g)) {
    const colour = hex.toLowerCase();
    if (failures.has(`${index}|${colour}`)) continue;
    const allowed = allowedByThemeIndex[Number(index)];
    if (allowed === undefined) {
      failures.set(
        `${index}|${colour}`,
        `${file}: syntax colour ${colour} is bound to unknown theme index --${index}.`
      );
      continue;
    }
    if (allowed.has(colour)) continue;
    failures.set(
      `${index}|${colour}`,
      `${file}: off-palette syntax colour ${colour} on --${index}. Expected one of ` +
        `${[...allowed].join(', ')} from src/styles/expressive-code-themes.mjs.`
    );
  }
  return [...failures.values()];
}

/** Every built page, bounded. */
async function builtPages(distDir) {
  const entries = await readdir(distDir, { recursive: true, withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    if (pages.length >= MAX_HTML_FILES) {
      throw new Error(`More than ${MAX_HTML_FILES} built pages under ${distDir}`);
    }
    pages.push(join(entry.parentPath, entry.name));
  }
  return pages;
}

async function verifyDistSyntaxColours(distDir, themes) {
  const allowed = allowedSyntaxColours(themes);
  const failures = [];
  let spans = 0;
  for (const page of await builtPages(distDir)) {
    const html = await readFile(page, 'utf8');
    spans += html.match(/--\d+:#[0-9a-fA-F]{3,8}/g)?.length ?? 0;
    failures.push(...syntaxColourFailures(html, page.slice(distDir.length + 1), allowed));
  }
  if (spans < MIN_SYNTAX_SPANS) {
    failures.push(
      `Only ${spans} inline syntax colours across the built pages, under the floor of ` +
        `${MIN_SYNTAX_SPANS}. Either the code blocks are gone or this guard has stopped matching ` +
        `what Expressive Code emits.`
    );
  }
  return failures;
}

// ── Check 2: the landing page's links ─────────────────────────────────────────────────────────

/** `site` from astro.config.mjs, which is what a same-origin absolute href must match. */
async function siteOrigin() {
  const config = await readFile(ASTRO_CONFIG, 'utf8');
  const declared = /^\s*site:\s*'([^']+)'/m.exec(config);
  if (!declared) throw new Error(`astro.config.mjs declares no \`site\`; cannot classify hrefs`);
  return new URL(declared[1]).origin;
}

/**
 * The built file a site-root path names, or `null`. Astro is configured
 * `trailingSlash: 'always'` with `build.format: 'directory'`, so a page path ends in `/` and maps
 * to `index.html`; the extensionless and `.html` forms are tried anyway so a hand-written href
 * that omits the slash reports as missing rather than as a false pass.
 */
function builtFileFor(distDir, pathname) {
  const candidates = pathname.endsWith('/')
    ? [join(distDir, pathname, 'index.html')]
    : [
        join(distDir, pathname),
        join(distDir, pathname, 'index.html'),
        join(distDir, `${pathname}.html`),
      ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/** Does `file` carry an element with this id? */
async function hasFragment(file, fragment) {
  if (!file.endsWith('.html')) return false;
  const html = await readFile(file, 'utf8');
  return new RegExp(`\\sid=["']${fragment.replace(/[^\w-]/g, '\\$&')}["']`).test(html);
}

async function verifyLandingHrefs(distDir, origin) {
  const landing = join(distDir, 'index.html');
  if (!existsSync(landing)) return [`The built site has no index.html at ${distDir}.`];
  const html = await readFile(landing, 'utf8');
  // `[\s"']` before the attribute name, so `data-href=` and `xlink:href=` are not mistaken for it.
  const matches = [...html.matchAll(/[\s"']href\s*=\s*"([^"]*)"/g)];
  const hrefs = [...new Set(matches.map(match => match[1].trim()).filter(href => href !== ''))];
  if (hrefs.length > MAX_LANDING_HREFS) {
    return [`The landing page carries more than ${MAX_LANDING_HREFS} distinct hrefs.`];
  }

  const failures = [];
  let internal = 0;
  for (const href of hrefs) {
    const target = new URL(href, `${origin}/`);
    if (target.origin !== origin) continue;
    internal += 1;
    const file = builtFileFor(distDir, decodeURIComponent(target.pathname));
    if (file === null) {
      failures.push(
        `Landing href "${href}" resolves to ${target.pathname}, which the build did not emit.`
      );
      continue;
    }
    const fragment = target.hash.slice(1);
    if (fragment === '' || (await hasFragment(file, fragment))) continue;
    failures.push(
      `Landing href "${href}" points at #${fragment}, which no element in ${target.pathname} declares.`
    );
  }

  if (internal < MIN_INTERNAL_HREFS) {
    failures.push(
      `Only ${internal} internal href${internal === 1 ? '' : 's'} found on the landing page, ` +
        `under the floor of ${MIN_INTERNAL_HREFS}. Either the page lost its links or this guard ` +
        `has stopped matching them.`
    );
  }
  return failures;
}

// ── Entry point ───────────────────────────────────────────────────────────────────────────────

/** `--dist <directory>`, defaulting to the build's own output. */
function distFromArgv(argv) {
  const at = argv.indexOf('--dist');
  if (at === -1) return join(DOCS_ROOT, 'dist');
  const value = argv[at + 1];
  if (value === undefined) throw new Error('--dist needs a directory');
  return resolve(value);
}

function report(failures) {
  console.error(`\nverify-dist: ${failures.length} problem(s) in the built site:\n`);
  for (const failure of failures.slice(0, MAX_REPORTED_FAILURES)) console.error(`  ✗ ${failure}`);
  const hidden = failures.length - MAX_REPORTED_FAILURES;
  if (hidden > 0) console.error(`  … and ${hidden} more.`);
  console.error('');
}

async function main(argv) {
  const distDir = distFromArgv(argv);
  if (!existsSync(distDir)) {
    console.error(`verify-dist: ${distDir} does not exist — build the site first.`);
    return 1;
  }
  const { canvases, colours } = await brandPalette();
  const failures = [
    ...verifyPalette(joineryEcThemes, canvases, colours),
    ...(await verifyDistSyntaxColours(distDir, joineryEcThemes)),
    ...(await verifyLandingHrefs(distDir, await siteOrigin())),
  ];
  if (failures.length > 0) {
    report(failures);
    return 1;
  }
  console.log('verify-dist: syntax palette and landing hrefs check out.');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
