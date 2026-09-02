/*
 * `joinery-ink` and `joinery-ivory`: the docs site's two Expressive Code themes.
 *
 * ── Why a theme object at all ──────────────────────────────────────────────────────────────
 *
 * Expressive Code writes its per-token colours as INLINE custom properties on every span
 * (`style="--0:#F0715A;--1:#B83C22"` — `--0` is the first theme in the array, `--1` the second),
 * and those values are generated at build time from the active theme's own `tokenColors`.
 * `expressiveCode.styleOverrides` reaches `CoreStyleSettings` only — border, canvas, fonts,
 * gutter, selection — so no CSS rule and no override can touch a syntax role. Supplying the
 * theme is the only lever that does. That is why `src/styles/brand.css` carried a tracked note
 * about the stock light theme's #3B61B0 keyword/string blue until this file replaced it.
 *
 * ── What this is a fork of ─────────────────────────────────────────────────────────────────
 *
 * Starlight's bundled default pair is Night Owl (`@astrojs/starlight/integrations/
 * expressive-code/themes/night-owl-{dark,light}.jsonc`, MIT © 2018 Sarah Drasner). The scope
 * table below is Night Owl **dark**'s 190 `tokenColors` rules, with every rule's foreground
 * remapped from Night Owl's ~44-colour palette onto Joinery's six syntax roles, then grouped by
 * (role, fontStyle). Scope order and font styles are Night Owl's; where one scope string was
 * claimed by two rules, the later claim won, which is how TextMate resolves it anyway.
 *
 * Night Owl **light** is deliberately NOT the light half's structural source. It collapses
 * strings, variables, built-in constants and function names into a single blue (#4876d6, 42 of
 * its 186 rules), which would flatten four Joinery roles into one. Using the dark rule table for
 * both themes gives the two modes identical role behaviour — which is what the app does, where
 * one `TOKEN_ROLES` table in `packages/renderer/src/editor/monaco-themes.ts` is applied to two
 * palettes.
 *
 * ── The six roles ──────────────────────────────────────────────────────────────────────────
 *
 * Source of truth: `packages/renderer/src/editor/monaco-themes.ts` (`INK_TOKENS` /
 * `IVORY_TOKENS`), which is itself pinned to `packages/renderer/src/styles/theme.css` by
 * `monaco-themes.spec.ts`. Ten of the twelve values are the app's, byte for byte. Two dark-mode
 * values are lifted, and the lift is measured rather than eyeballed — see `INK` below.
 *
 * Every one of the twelve clears WCAG AA (4.5:1) against the canvas it actually paints on:
 * #272A27 under ink, #F4F2EA under ivory. Ratios are recorded beside each value.
 */

/**
 * Ink (dark). Canvas: #272A27 — `--sl-color-gray-6`, which is `--j-charcoal`. Note this is NOT
 * the app's editor canvas (#171817, `--j-ink`): a docs code block sits on the charcoal plane so
 * it reads as a fitted panel rather than as a hole (see `brand.css`, `--j-code-bg`). The lighter
 * canvas costs about 1.0 of contrast, which is what the two lifts below pay back.
 */
const INK = {
  /*
   * The app's `--color-syntax-keyword` is `--j-oxide-lift` (#E8654A), which measures 5.42:1 on
   * the app's ink canvas but only 4.42:1 on charcoal — under AA. #F0715A is the next oxide up
   * and is already a brand.css token (`--sl-color-red`, 6.12:1 on ink), so this is a lift within
   * the palette rather than a new colour.
   */
  keyword: '#f0715a', // 4.99:1 on #272A27
  string: '#c8f04a', // 11.07:1 — --j-chartreuse, the app's value
  number: '#e6a23c', //  6.63:1 — --j-amber, the app's value
  /*
   * The app's `--color-syntax-comment` (#85887F, its `--color-fg-subtle`) measures 4.94:1 on ink
   * and 4.03:1 on charcoal — under AA. #95988F is the same hue (80°) and chroma lifted until it
   * reproduces the app's own measured ratio on this canvas. It and `IVORY.comment` below are the
   * two values on this site that are not already `brand.css` tokens; neither is declared there
   * because no CSS rule reads it — a syntax colour never reaches the stylesheet at all. Both are
   * listed, with that reason, in `scripts/verify-dist.mjs`, which fails the build on any third.
   */
  comment: '#95988f', //  4.95:1 on #272A27
  function: '#f2efe7', // 12.63:1 — --j-ivory, the app's value
  type: '#b4b3ab', //  6.90:1 — the app's --color-fg-muted
  fg: '#f2efe7', // 12.63:1 — the app's `identifier` colour is its foreground
};

/**
 * Ivory (light). Canvas: #F4F2EA — `--sl-color-gray-7`. All six are the app's `IVORY_TOKENS`
 * unchanged: the app's own ivory canvas (#F2EFE7) is within a point of this one, so every ratio
 * lands within 0.15 of the app's measured value and none of them needed a lift.
 */
const IVORY = {
  keyword: '#b83c22', //  5.05:1 on #F4F2EA — --j-oxide-deep
  string: '#4d7811', //  4.67:1 — --j-verify-deep
  number: '#8a5a10', //  5.28:1 — --j-amber-deep
  comment: '#666961', //  4.99:1
  function: '#171817', // 15.88:1 — --j-ink
  type: '#5a5d57', //  5.97:1
  fg: '#171817', // 15.88:1
};

/**
 * The forked rule table: Night Owl dark's scopes, grouped by the Joinery role their original
 * colour maps to. `fontStyle` is Night Owl's own value (`''` is its explicit "no style" reset)
 * except for two roles, where the app's editor is followed instead:
 *
 *   - `comment` is italic. Night Owl resets it; `monaco-themes.ts` italicises it.
 *   - `function` is bold. `monaco-themes.ts` gives `predefined` bold, and it has to: the role's
 *     colour IS the foreground colour in both palettes, so weight is the only thing that makes
 *     it a distinct role rather than a sixth name for the fifth colour.
 *
 * Keyword bold is the one app cue deliberately not ported. Night Owl's last rule (see
 * `FONT_STYLE_RESETS`) resets the font style of `keyword`, `keyword.operator*` and `storage.type`
 * and is at least as specific, so a bold keyword role would apply to some keyword scopes and not
 * others. Colour carries the role here instead.
 */
const ROLE_SCOPES = [
  {
    role: 'type',
    scopes: [
      'markup.changed', 'meta.diff.header.git', 'meta.diff.header.from-file',
      'meta.diff.header.to-file', 'support.constant.math', 'variable', 'entity.name.class',
      'meta.class entity.name.type.class', 'entity.other.inherited-class',
      'punctuation.definition.tag', 'meta.tag', 'entity.name.tag.custom',
      'support.constant.meta.property-value', 'support.type', 'support.class',
      'support.variable.dom', 'punctuation.definition.string',
      'meta.property-list entity.name.tag.reference', 'entity.other.attribute-name.id',
      'punctuation.definition.parameters', 'keyword.control.operator', 'variable.instance',
      'variable.other.instance', 'variable.readwrite.instance',
      'variable.other.readwrite.instance', 'variable.other.property', 'support.constant',
      'keyword.other.special-method', 'keyword.other.new', 'keyword.other.debugger',
      'support.function', 'variable.language', 'support.variable.property',
      'punctuation.definition.list.begin', 'punctuation.definition.list.end',
      'punctuation.separator.arguments', 'punctuation.definition.list',
      'variable.assignment.coffee', 'entity.name.type.class.cs', 'storage.type.cs',
      'entity.name.type.enum.cs', 'string.interpolated.single.dart',
      'string.interpolated.double.dart', 'support.class.dart', 'entity.name.tag.wildcard.css',
      'entity.name.tag.wildcard.less', 'entity.name.tag.wildcard.scss',
      'entity.name.tag.wildcard.sass', 'source.elixir entity.name.function',
      'source.elixir punctuation.definition.string',
      'source.elixir variable.other.readwrite.module.elixir',
      'source.elixir variable.other.readwrite.module.elixir punctuation.definition.variable.elixir',
      'constant.keyword.clojure', 'entity.other.attribute-name.id.html',
      'punctuation.definition.tag.html', 'meta.class entity.name.type.class.js',
      'support.type.property-name.json', 'support.constant.json', 'variable.other.object.js',
      'constant.language.symbol.hashkey.ruby', 'entity.name.tag.less',
      'punctuation.definition.metadata.markdown', 'markup.inline.raw.string.markdown',
      'support.class.php', 'variable.other.global.php',
      'variable.other.global.php punctuation.definition.variable',
      'entity.name.function.decorator.python', 'variable.scss', 'variable.sass',
      'variable.parameter.url.scss', 'variable.parameter.url.sass', 'entity.name.tag.scss',
      'entity.name.tag.sass', 'entity.name.type.ts', 'entity.name.tag.yaml',
      'meta.class entity.name.type.class.tsx', 'entity.name.type.tsx',
      'entity.name.type.module.tsx',
    ],
  },
  {
    role: 'keyword',
    scopes: [
      'markup.deleted.diff', 'storage.type', 'invalid', 'invalid.deprecated',
      'keyword.operator.assignment', 'keyword.operator.arithmetic', 'keyword.operator.bitwise',
      'keyword.operator.increment', 'keyword.operator.ternary', 'object.comma', 'invalid.broken',
      'invalid.unimplemented', 'invalid.illegal', 'variable.interpolation',
      'punctuation.section.embedded', 'string.template meta.template.expression',
      'source.go keyword.package.go', 'source.go keyword.import.go',
      'source.go keyword.function.go', 'source.go keyword.type.go', 'source.go keyword.struct.go',
      'source.go keyword.interface.go', 'source.go keyword.const.go', 'source.go keyword.var.go',
      'source.go keyword.map.go', 'source.go keyword.channel.go', 'source.go keyword.control.go',
      'markup.heading.markdown', 'markup.heading.setext.1.markdown',
      'markup.heading.setext.2.markdown', 'punctuation.definition.string.markdown',
      'punctuation.definition.string.begin.markdown', 'punctuation.definition.string.end.markdown',
      'meta.link.inline.markdown punctuation.definition.string',
      'beginning.punctuation.definition.list.markdown', 'source.python variable.language.special',
      'keyword.control', 'meta.class.ts meta.var.expr.ts storage.type.ts',
      'meta.class.tsx meta.var.expr.tsx storage.type.tsx',
    ],
  },
  {
    role: 'string',
    scopes: [
      'markup.inserted.diff', 'string', 'string.quoted', 'string.regexp',
      'string.regexp keyword.other', 'meta.property-name', 'raw',
      'meta.structure.dictionary.value.json string.quoted.double',
      'string.quoted.double.json punctuation.definition.string.json',
      'entity.name.type.class.ruby', 'markup.inline.raw.markdown',
      'markup.underline.link.markdown', 'markup.underline.link.image.markdown',
    ],
  },
  {
    role: 'fg',
    scopes: [
      'object', 'meta.brace', 'punctuation.terminator.expression',
      'punctuation.definition.arguments', 'punctuation.definition.array',
      'punctuation.section.array', 'meta.array', 'string.template punctuation.definition.string',
      'variable.parameter.function.coffee', 'variable.other.readwrite.cs',
      'entity.name.type.namespace.cs', 'string.unquoted.preprocessor.message.cs',
      'variable.other.object.cs', 'meta.namespace-block.cpp', 'meta.preprocessor.macro.cpp',
      'terminator.js', 'meta.js punctuation.definition.js', 'variable.other.meta.import.js',
      'meta.import.js variable.other', 'variable.other.meta.export.js',
      'meta.export.js variable.other', 'variable.parameter.function.js',
      'variable.other.object.jsx', 'variable.object.property.js', 'variable.object.property.jsx',
      'variable.js', 'variable.other.js', 'support.class.js', 'variable.other.ruby',
      'string.other.link.title.markdown', 'string.other.link.description.markdown',
      'variable.other.php', 'meta.function-call.php punctuation', 'meta.function-call.python',
      'meta.function-call.generic.python', 'punctuation.python',
      'source.css.scss meta.at-rule variable', 'source.css.sass meta.at-rule variable',
      'variable.other.readwrite.alias.ts', 'variable.other.readwrite.alias.tsx',
      'variable.other.readwrite.ts', 'variable.other.readwrite.tsx', 'variable.other.object.ts',
      'variable.other.object.tsx', 'variable.object.property.ts', 'variable.object.property.tsx',
      'variable.other.ts', 'variable.other.tsx', 'variable.tsx', 'variable.ts',
      'meta.import.ts punctuation.definition.block',
      'meta.import.tsx punctuation.definition.block',
      'meta.export.ts punctuation.definition.block',
      'meta.export.tsx punctuation.definition.block', 'variable.other.readwrite.js',
      'variable.parameter', 'meta.jsx.children', 'meta.jsx.children.js', 'meta.jsx.children.tsx',
    ],
  },
  {
    role: 'comment',
    fontStyle: 'italic',
    scopes: [
      'comment', 'meta.function punctuation.separator.comma', 'comment.line.double-slash', 'quote',
      'entity.name.type.instance.jsdoc', 'entity.name.type.instance.phpdoc',
      'variable.other.jsdoc', 'variable.other.phpdoc', 'markup.quote.markdown',
      'meta.type.parameters.ts entity.name.type', 'meta.type.parameters.tsx entity.name.type',
    ],
  },
  {
    role: 'number',
    fontStyle: '',
    scopes: [
      'constant.numeric', 'constant.character.numeric', 'support.class.component.js',
      'support.class.component.tsx',
    ],
  },
  {
    role: 'function',
    fontStyle: 'bold',
    scopes: [
      'constant.language', 'punctuation.definition.constant', 'variable.other.constant',
      'constant.character', 'constant.other', 'entity.name.function', 'variable.function',
      'meta.function-call', 'source.elixir support.type.elixir',
      'source.elixir meta.module.elixir entity.name.class.elixir',
      'source.elixir constant.other.symbol.elixir', 'source.elixir constant.other.keywords.elixir',
      'source.go meta.function-call.go', 'entity.name.function.preprocessor.cpp',
      'entity.scope.name.cpp', 'variable.other.readwrite.powershell',
      'support.function.powershell', 'meta.method.declaration storage.type.js',
      'variable.parameter.function.python', 'meta.function-call.arguments.python',
      'support.class.node.ts', 'support.class.node.tsx', 'meta.decorator punctuation.decorator.ts',
      'meta.decorator punctuation.decorator.tsx', 'meta.tag.js meta.jsx.children.tsx',
      'meta.method.declaration storage.type.ts', 'meta.method.declaration storage.type.tsx',
    ],
  },
  {
    role: 'number',
    scopes: [
      'constant.character.escape', 'constant.language.null', 'constant.language.boolean',
      'constant.other.color.rgb-value punctuation.definition.constant', 'constant.other.color',
      'keyword.other.unit', 'meta.attribute-selector.css entity.other.attribute-name.attribute',
      'source.go constant.language.go', 'source.go constant.other.placeholder.go',
      'storage.type.language.primitive.cpp',
      'meta.structure.dictionary.json meta.structure.dictionary.value constant.language',
      'keyword.other.unit.css',
      'meta.attribute-selector.less entity.other.attribute-name.attribute',
      'constant.language.python',
      'meta.attribute-selector.scss entity.other.attribute-name.attribute',
      'meta.attribute-selector.sass entity.other.attribute-name.attribute',
      'keyword.other.unit.scss', 'keyword.other.unit.sass',
    ],
  },
  {
    role: 'keyword',
    fontStyle: '',
    scopes: [
      'punctuation.accessor', 'keyword', 'storage', 'meta.var.expr',
      'meta.class meta.method.declaration meta.var.expr storage.type.js',
      'storage.type.property.js', 'storage.type.property.ts', 'storage.type.property.tsx',
      'keyword.operator.relational', 'meta.delimiter.period', 'meta.selector',
      'entity.name.tag.doctype', 'meta.tag.sgml.doctype', 'keyword.operator.logical',
      'keyword.control.conditional.js', 'keyword.operator.comparison', 'keyword.control.flow.js',
      'keyword.control.flow.ts', 'keyword.control.flow.tsx', 'keyword.control.ruby',
      'keyword.control.def.ruby', 'keyword.control.loop.js', 'keyword.control.loop.ts',
      'keyword.control.import.js', 'keyword.control.import.ts', 'keyword.control.import.tsx',
      'keyword.control.from.js', 'keyword.control.from.ts', 'keyword.control.from.tsx',
      'keyword.control.conditional.ts', 'keyword.control.switch.js', 'keyword.control.switch.ts',
      'keyword.operator.instanceof.js', 'keyword.operator.expression.instanceof.ts',
      'keyword.operator.expression.instanceof.tsx', 'source.elixir .punctuation.binary.elixir',
      'meta.tag.sgml.doctype.html',
    ],
  },
  {
    role: 'type',
    fontStyle: '',
    scopes: [
      'entity.name.tag', 'meta.tag.other.html', 'meta.tag.other.js', 'meta.tag.other.tsx',
      'entity.name.tag.tsx', 'entity.name.tag.js', 'meta.tag.js', 'meta.tag.tsx', 'meta.tag.html',
      'entity.other.attribute-name', 'keyword.operator', 'variable.parameter.function',
      'entity.name.tag.css', 'entity.name.tag.custom.css', 'support.constant.property-value.css',
      'entity.name.type.js', 'entity.name.type.module.js',
    ],
  },
  {
    role: 'string',
    fontStyle: '',
    scopes: [
      'support.type.vendor.property-name', 'support.constant.vendor.property-value',
      'support.type.property-name', 'meta.property-list entity.name.tag',
    ],
  },
  {
    role: 'fg',
    fontStyle: '',
    scopes: ['variable.other.object.property'],
  },
  {
    role: 'keyword',
    fontStyle: 'italic',
    scopes: ['italic', 'markup.italic.markdown'],
  },
  {
    role: 'type',
    fontStyle: 'bold',
    scopes: [
      'bold', 'punctuation.separator.hash.cs', 'keyword.preprocessor.region.cs',
      'keyword.preprocessor.endregion.cs', 'markup.bold.markdown',
    ],
  },
];

/**
 * Night Owl's three font-style-only rules, kept verbatim and kept last. They carry no colour, so
 * the remap above never touched them; they exist to strip italics the base rules would otherwise
 * apply, and dropping them would put italics back on operators, punctuation and CSS sources.
 */
const FONT_STYLE_RESETS = [
  { fontStyle: '', scopes: ['storage.type.function.arrow.js'] },
  { fontStyle: '', scopes: ['variable.other.object.js'] },
  {
    fontStyle: '',
    scopes: [
      'meta.property-list.css meta.property-value.css variable.other.less',
      'meta.property-list.scss variable.scss', 'meta.property-list.sass variable.sass',
      'meta.brace', 'keyword.operator.operator', 'keyword.operator.or.regexp',
      'keyword.operator.expression.in', 'keyword.operator.relational',
      'keyword.operator.assignment', 'keyword.operator.comparison', 'keyword.operator.type',
      'keyword.operator', 'keyword', 'punctuation.definition.string', 'punctuation',
      'variable.other.readwrite.js', 'storage.type', 'source.css', 'string.quoted',
    ],
  },
];

/** Every role name `ROLE_SCOPES` is allowed to use. Asserted, so a typo cannot ship a blank. */
const ROLE_NAMES = ['keyword', 'string', 'number', 'comment', 'function', 'type', 'fg'];

/**
 * The workbench colours the theme itself owns.
 *
 * Deliberately short. `astro.config.mjs` keeps `useStarlightUiThemeColors: true`, so Starlight
 * overwrites the frame chrome — title bar, tab bar, borders, scrollbars, editor background — with
 * `var(--sl-color-*)` references that `brand.css` already resolves to brand tokens. Restating
 * those here would be a second source of truth for the same pixels.
 *
 * What is left is the set Starlight does not set and Expressive Code still reads. Every one of
 * them has a VS Code workbench default, and those defaults are the stock editor blues
 * (#0060C0, #237893, #ADD6FF) — so leaving any of them out does not leave it unset, it ships a
 * blue. Each entry below is the same token `packages/renderer/src/editor/monaco-themes.ts`
 * gives the equivalent Monaco colour id.
 */
function workbenchColors(palette, canvas, selection) {
  return {
    // Read by the core as `codeForeground`: the colour of any token no rule above claims.
    'editor.foreground': palette.fg,
    // Starlight overwrites this with its own contrast reference; declaring the canvas the block
    // actually paints on keeps the theme self-describing, and it is the value every ratio in
    // this file was measured against.
    'editor.background': canvas,
    focusBorder: palette.keyword,
    // The gutter, shown only on blocks that ask for line numbers. Contrast-adjusted by the core
    // against the code background before use, so these are a starting point, not a final value.
    'editorLineNumber.foreground': palette.comment,
    'editorLineNumber.activeForeground': palette.fg,
    // Selections. Expressive Code leaves text selection to the browser unless
    // `useThemedSelectionColors` is on, and nothing renders a menu — but an unreferenced default
    // is still a blue sitting in the shipped stylesheet waiting for an upgrade to start using it.
    'editor.selectionBackground': selection,
    'menu.selectionBackground': selection,
    'menu.selectionForeground': palette.fg,
    // The "Copied!" tooltip on every copy button. The frames plugin takes this colour and forces
    // its luminance to 0.18, so only the hue survives — and the brand's green is the string role
    // (chartreuse under ink, `--j-verify-deep` under ivory).
    'terminal.ansiGreen': palette.string,
  };
}

function tokenColors(palette) {
  return [...ROLE_SCOPES, ...FONT_STYLE_RESETS].map(({ role, fontStyle, scopes }) => {
    if (role !== undefined && !ROLE_NAMES.includes(role)) {
      throw new Error(`Unknown syntax role "${role}" in expressive-code-themes.mjs`);
    }
    const foreground = role === undefined ? undefined : palette[role];
    return {
      scope: scopes,
      settings: {
        ...(foreground === undefined ? {} : { foreground }),
        ...(fontStyle === undefined ? {} : { fontStyle }),
      },
    };
  });
}

/**
 * The pair, dark first. Order is load-bearing twice over: Expressive Code names the first theme's
 * inline custom property `--0` and the second's `--1`, and Starlight's `themeCssSelector` keys the
 * `[data-theme]` rules off each theme's `type`. Dark first also matches the stock Starlight order
 * (`['starlight-dark', 'starlight-light']`), so nothing downstream has to change.
 */
export const joineryEcThemes = [
  {
    name: 'joinery-ink',
    type: 'dark',
    // Selection wash: the app's `--color-active` under ink.
    colors: workbenchColors(INK, '#272a27', '#e8654a24'),
    tokenColors: tokenColors(INK),
  },
  {
    name: 'joinery-ivory',
    type: 'light',
    // Selection wash: the app's `--color-active` under ivory.
    colors: workbenchColors(IVORY, '#f4f2ea', '#d6492f1a'),
    tokenColors: tokenColors(IVORY),
  },
];
