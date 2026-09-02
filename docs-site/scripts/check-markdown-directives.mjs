/**
 * Guard: Markdown container directives must actually parse on THIS machine.
 *
 * J-103. Astro 7's Markdown processor is Sätteri, a Rust parser reached through a NAPI native
 * binding, and Starlight's `:::note` / `:::caution` asides are container directives that only
 * exist if that binding understands them. When the binding is missing or is the wrong version,
 * nothing fails: satteri's loader silently falls through to whatever `@bruits/satteri-<platform>`
 * it can resolve, `containerDirective` never fires, and every aside ships to the page as literal
 * ":::note" body text. That is exactly what happened on Apple Silicon, where satteri 0.10.4 has
 * no darwin-arm64 binding on npm and pnpm's hoisted fallback handed it Starlight's 0.9.5 one.
 *
 * So this asserts the capability rather than the version numbers: render one container directive
 * through the same processor `astro build` uses and require that the parser saw it. A silent
 * fallback fails here, in a second, instead of being noticed by a reader.
 *
 * `--dist` runs the other half, after `astro build`: no built page may contain a literal `:::`
 * at the start of a paragraph. The probe above cannot see that, because it turns the directive
 * feature on itself; this catches the day Starlight stops turning it on. It is a no-op while the
 * site's callouts are blockquotes, and free either way.
 *
 * Run by `pnpm run check` and `pnpm run build`, so it gates local builds and the Pages workflow
 * alike. `pnpm-workspace.yaml`'s `overrides` block carries the pin that keeps it green.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURE = ':::note\nJ-103 container directive fixture.\n:::\n';

/**
 * `@astrojs/markdown-satteri` is a transitive optional dependency of `astro`, never a direct one
 * of this package, so a bare specifier does not resolve from `docs-site/`. Resolve it the way
 * Astro itself does: from astro's own real directory, since pnpm's symlinked layout means
 * `createRequire` on the link path walks the wrong tree.
 */
function resolveMarkdownSatteri(docsSiteRoot) {
  const astroPackageJson = new URL('node_modules/astro/package.json', docsSiteRoot);
  const requireFromAstro = createRequire(realpathSync(astroPackageJson));
  return requireFromAstro.resolve('@astrojs/markdown-satteri');
}

/** An mdast plugin whose only job is to count the container directives the parser reports. */
function createDirectiveCounter(counter) {
  return {
    name: 'j103-directive-probe',
    containerDirective() {
      counter.seen += 1;
    },
  };
}

/** Every `.html` under `dir`, depth-first. `maxDepth` bounds a tree that should be ~3 deep. */
function collectHtmlFiles(dir, maxDepth) {
  if (maxDepth < 0) {
    throw new Error(`dist/ is nested deeper than expected while scanning ${dir}`);
  }
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectHtmlFiles(full, maxDepth - 1));
    } else if (entry.name.endsWith('.html')) {
      found.push(full);
    }
  }
  return found;
}

/** No built page may open a paragraph with `:::` — that is an aside that failed to become one. */
function assertNoLiteralDirectivesInDist(distDir) {
  const offenders = collectHtmlFiles(distDir, 8).filter(file =>
    readFileSync(file, 'utf8').includes('<p>:::')
  );
  if (offenders.length === 0) {
    return;
  }
  throw new Error(
    `${offenders.length} built page(s) ship a literal ':::' where an aside should be:\n` +
      offenders.map(file => `  ${file}`).join('\n') +
      `\nThe container directive was written but never parsed. See the J-103 note in astro.config.mjs.`
  );
}

async function main() {
  const docsSiteRoot = new URL('../', import.meta.url);
  if (process.argv.includes('--dist')) {
    assertNoLiteralDirectivesInDist(fileURLToPath(new URL('dist', docsSiteRoot)));
    return;
  }
  const entry = resolveMarkdownSatteri(docsSiteRoot);
  const { createSatteriMarkdownProcessor } = await import(pathToFileURL(entry).href);

  const counter = { seen: 0 };
  const processor = await createSatteriMarkdownProcessor({
    features: { directive: true },
    mdastPlugins: [createDirectiveCounter(counter)],
  });
  const { code } = await processor.render(FIXTURE);

  if (counter.seen === 1 && !code.includes(':::')) {
    return;
  }

  const detail =
    counter.seen === 0
      ? 'the parser reported no container directive at all'
      : `the parser reported ${counter.seen} container directives and emitted ${JSON.stringify(code)}`;
  throw new Error(
    `Markdown container directives are not being parsed on this platform (${process.platform}-${process.arch}): ${detail}.\n` +
      `Every ':::note' and ':::caution' on this site would ship as literal body text.\n` +
      `Processor: ${entry}\n` +
      `This is the J-103 failure mode: satteri loaded a native binding whose version does not match its\n` +
      `JavaScript layer. Check that the satteri version resolved by @astrojs/markdown-satteri publishes a\n` +
      `binding for this platform, and update the 'overrides' block in docs-site/pnpm-workspace.yaml.`
  );
}

await main();
