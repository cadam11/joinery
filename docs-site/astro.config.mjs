// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { joineryEcThemes } from './src/styles/expressive-code-themes.mjs';

/**
 * Joinery's user documentation site.
 *
 * Served from the `usejoinery.com` apex (J-108, revisiting plans/docs-site/PROPOSAL.md D1),
 * so there is deliberately NO `base`: the site sits at the domain root and a root-absolute
 * link such as `[Install](/getting-started/install/)` now resolves correctly. That is the
 * whole point of the move. Under the previous `cadam11.github.io/joinery` project-page pair
 * every root-absolute link silently 404'd, and the `/joinery` prefix had to be threaded
 * through by hand anywhere a link could not be relative.
 *
 * The domain is pinned by `public/CNAME`, which ships inside the Pages artifact so that each
 * deploy reasserts it rather than clearing the repository's Pages custom-domain setting.
 *
 * `starlight-links-validator` below remains the guard on internal links —
 * `errorOnRelativeLinks: false` because relative links between docs pages are exactly what
 * authors are told to write, and both link styles now resolve against the same root.
 */
export default defineConfig({
  site: 'https://usejoinery.com',
  // Emit `/getting-started/install/index.html`, so a link written as
  // `../install/` resolves the same way in `astro preview` as it does on Pages.
  trailingSlash: 'always',
  build: { format: 'directory' },
  /*
   * Container directives (`:::note`, `:::caution`) DO work here as of J-103. Starlight enables
   * the feature by mutating `config.markdown.processor.options.features` from its
   * `astro:config:setup` hook, and no declaration is needed in this file for that to take
   * effect — `scripts/check-markdown-directives.mjs` proves it on every `check` and `build`.
   *
   * They did not work before, and the reason is worth keeping because it was silent. Astro 7's
   * Markdown processor is Sätteri, a Rust parser reached through a NAPI native binding.
   * `@astrojs/markdown-satteri@0.3.7` asks for satteri `^0.10.3` and got 0.10.4 — a partial
   * release whose `@bruits/satteri-darwin-arm64` and `@bruits/satteri-linux-x64-musl` packages
   * were never published (the registry jumps 0.10.3 to 0.10.5 for both). satteri's loader then
   * resolved `@bruits/satteri-darwin-arm64` through pnpm's hoisted fallback and got the 0.9.5
   * binding that `@astrojs/starlight` had installed for its own satteri copy. The NAPI version
   * guard that would have caught that is inert unless `NAPI_RS_ENFORCE_VERSION_CHECK` is set —
   * and it is unusable here anyway, because satteri's generated loader compares against a stale
   * hard-coded "0.10.1" and so rejects the correct binding too. So 0.10.4's JavaScript drove a
   * 0.9.5 native parser on Apple Silicon, `containerDirective` never fired, and every aside
   * shipped as literal ":::note" body text. CI (linux-x64-gnu) had a valid 0.10.4 binding and
   * was never affected, which is the platform split that made this hard to see.
   *
   * The fix is the `overrides` block in `pnpm-workspace.yaml`, pinning that range to 0.10.5.
   *
   * The site's callouts are still blockquotes with a bold lead word, styled by
   * `src/styles/brand.css` — that is the house style across every page now, not a workaround,
   * and converting roughly sixty of them to asides is a separate content decision.
   */
  integrations: [
    starlight({
      title: 'Joinery',
      description:
        'User documentation for Joinery — a desktop database workbench for SQL Server, PostgreSQL and MySQL.',
      // The three-bar mark, in its light-surface and dark-surface variants. Copied into
      // src/assets/ rather than referenced across the repo boundary: `docs-site/` builds
      // from its own directory and must not reach up into the app's tree.
      logo: {
        light: './src/assets/lockup-on-light.svg',
        dark: './src/assets/lockup-on-dark.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/brand.css'],
      /*
       * Fenced code blocks.
       *
       * `themes` replaces Starlight's bundled Night Owl pair with `joinery-ink` /
       * `joinery-ivory`, whose six syntax roles are the app editor's own
       * (`src/styles/expressive-code-themes.mjs` explains the fork and carries every measured
       * contrast ratio). This is the only lever that reaches a syntax colour at all: Expressive
       * Code inlines them on each span from the active theme's `tokenColors`, and
       * `styleOverrides` reaches `CoreStyleSettings` — border, canvas, fonts, gutter,
       * selection — and nothing else. It retires the tracked #3B61B0 note that
       * `src/styles/brand.css` used to carry, and with it the last blue on the site.
       */
      expressiveCode: {
        themes: joineryEcThemes,
        /*
         * Starlight defaults this to `themes === undefined`, so supplying themes would silently
         * turn it off and take the frame chrome — title bar, tab bar, borders, scrollbars, code
         * canvas — back to whatever the theme objects declare. Keep it on: brand.css already
         * themes every `--sl-color-*` this integration writes, so it IS the brand chrome, and
         * the alternative is restating those values a second time inside the theme files.
         */
        useStarlightUiThemeColors: true,
        /*
         * Off, from a default of 5.5. This is the setting that invented #3B61B0: it darkened
         * Night Owl Light's #4876D6 until it cleared 5.5:1, against a background
         * (`theme.bg`, which Starlight pins to #23262F/#F6F7F9) that is not the one the block
         * actually paints on. With a hand-measured palette that guess is not wanted — every one
         * of the twelve values is checked against the real canvas in the theme file, and leaving
         * this on would let it move them afterwards.
         */
        minSyntaxHighlightingColorContrast: 0,
        styleOverrides: {
          // One themed custom property rather than a per-theme function: the two values live
          // beside every other colour decision in brand.css. See that file for each one.
          codeBackground: 'var(--j-code-bg)',
          borderColor: 'var(--sl-color-hairline)',
        },
      },
      // The Starlight internals this site depends on (PROPOSAL §2.2): the ink-first default
      // from plans/ui-overhaul/PROPOSAL.md D2. Both files are needed, not just the provider —
      // their headers explain why. If a Starlight major breaks them, the documented fallback
      // is to delete both and accept Starlight's `auto`.
      //
      // TRACKED: these two `.astro` files are the only source in the repository that no format
      // gate covers. The root `format:check` glob was widened to `.mdx` in Phase 2; `.astro`
      // was NOT added, because Prettier has no built-in Astro parser and errors with "No parser
      // could be inferred" on both files. Covering them needs `prettier-plugin-astro` in the
      // ROOT devDependencies plus a `plugins` entry in `.prettierrc.json` — a root dependency
      // and root lockfile change, which is a separate piece of work from the docs content.
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      social: [
        {
          icon: 'github',
          label: 'Joinery on GitHub',
          href: 'https://github.com/cadam11/joinery',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/cadam11/joinery/edit/main/docs-site/',
      },
      lastUpdated: true,
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { slug: 'getting-started/install' },
            { slug: 'getting-started/prerequisites' },
            { slug: 'getting-started/first-run' },
            { slug: 'getting-started/connect-sql-server' },
            { slug: 'getting-started/connect-postgresql' },
            { slug: 'getting-started/connect-mysql' },
            { slug: 'getting-started/connect-ssh' },
            { slug: 'getting-started/workspace-tour' },
          ],
        },
        {
          label: 'Features',
          // The section overview first, then all seventeen guides in the order
          // plans/docs-site/PROPOSAL.md §4 lists them. The section page groups the same set by
          // task rather than by that order — the one divergence is SQL dialect conversion, which
          // the proposal lists late and the section page files with the editor, where it belongs.
          items: [
            { slug: 'features' },
            { slug: 'features/query-editor' },
            { slug: 'features/results-grid' },
            { slug: 'features/execution-plans' },
            { slug: 'features/object-explorer' },
            { slug: 'features/find-a-database-object' },
            { slug: 'features/command-palette' },
            { slug: 'features/keyboard-shortcuts' },
            { slug: 'features/snippets' },
            { slug: 'features/query-history' },
            { slug: 'features/erd' },
            { slug: 'features/schema-diff' },
            { slug: 'features/backup-and-restore' },
            { slug: 'features/databases' },
            { slug: 'features/docker-containers' },
            { slug: 'features/sql-dialect-conversion' },
            { slug: 'features/ai-assistant' },
            { slug: 'features/ai-setup' },
          ],
        },
        {
          label: 'Reference',
          // Section page first, then the six pages. This array IS the order — an explicit `items`
          // list overrides `sidebar.order`, which the pages carry anyway so that a page moved out
          // of this list still sorts sensibly. Three of them are written
          // by `scripts/generate-reference.mjs` from the app's own source — do not hand-edit
          // `reference/keyboard-shortcuts.md`, `reference/commands.md` or
          // `reference/ai-providers.md`; `pnpm run check` and `pnpm run build` verify them.
          items: [
            { slug: 'reference' },
            { slug: 'reference/keyboard-shortcuts' },
            { slug: 'reference/commands' },
            { slug: 'reference/settings' },
            { slug: 'reference/supported-engines' },
            { slug: 'reference/ai-providers' },
            { slug: 'reference/storage-locations' },
          ],
        },
        {
          label: 'Troubleshooting',
          // Section page first, then the five pages in the order plans/docs-site/PROPOSAL.md §1
          // lists them, which is also roughly the order a new user hits them. This array IS the
          // order — an explicit `items` list overrides `sidebar.order`, which the pages carry
          // anyway so that a page moved out of this list still sorts sensibly.
          items: [
            { slug: 'troubleshooting' },
            { slug: 'troubleshooting/docker-not-detected' },
            { slug: 'troubleshooting/credentials-and-keychain' },
            { slug: 'troubleshooting/missing-cli-tools' },
            { slug: 'troubleshooting/sql-conversion-and-python' },
            { slug: 'troubleshooting/connections-and-tunnels' },
          ],
        },
        // About stays a single link rather than a group, on the Phase 1 rule that a group whose
        // only child repeats its own label reads as a bug: it still holds exactly one page.
        // Features became a group the moment it held ten, and Reference and Troubleshooting
        // above did the same.
        { slug: 'about' },
      ],
      plugins: [
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          errorOnInvalidHashes: true,
          errorOnLocalLinks: true,
        }),
      ],
    }),
  ],
});
