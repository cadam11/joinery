import { describe, it, expect } from 'vitest';
import { renderMarkdown, sanitizeDiagramSvg } from './render-markdown';

/**
 * These tests are the contract for the only path that turns LLM output into HTML.
 *
 * PORTED VERBATIM from `packages/renderer/src/app/shared/markdown/markdown-renderer.spec.ts`.
 * The only edits are the import path and this comment: the Angular file's `@vitest-environment
 * jsdom` pragma is unnecessary here because the renderer vitest project is jsdom already.
 * Keeping the cases byte-identical is deliberate — they are the security review that was
 * already done, and `sanitize-parity.spec.ts` fences the implementation the same way.
 *
 * The renderer this replaces never invoked Angular's sanitizer on that path
 * (`enableSvgRenderer` defaulted true, which set `bypassAngularSanitizer`), so its
 * only defence was five regexes. Every XSS case below is written against the output
 * string rather than against an assumed DOM shape, so it stays meaningful no matter
 * how DOMPurify chooses to neuter the payload — dropping the tag, dropping the
 * attribute, and escaping the markup are all acceptable outcomes; leaving it live
 * is not.
 */

/** Assertions that must hold for ANY output, regardless of input. */
function expectNoActiveContent(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\son\w+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/srcdoc/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/formaction/i);
}

describe('renderMarkdown — XSS', () => {
  it('strips script elements', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expectNoActiveContent(html);
  });

  it('strips inline event handlers', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expectNoActiveContent(html);
  });

  it('strips javascript: hrefs written as raw HTML', () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">click</a>');
    expectNoActiveContent(html);
  });

  it('strips entity-encoded javascript: hrefs', () => {
    // The regex-based filter this replaces matched the literal string only, so
    // &#x6a;avascript: sailed straight through it.
    const html = renderMarkdown('<a href="&#x6a;avascript:alert(1)">click</a>');
    expectNoActiveContent(html);
  });

  it('strips javascript: hrefs written as markdown links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expectNoActiveContent(html);
  });

  it('strips iframe srcdoc', () => {
    // srcdoc appeared in none of the previous filter's five regexes.
    const html = renderMarkdown('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>');
    expectNoActiveContent(html);
  });

  it('strips svg animation event handlers', () => {
    const html = renderMarkdown('<svg><animate onbegin="alert(1)" /></svg>');
    expectNoActiveContent(html);
    expect(html).not.toMatch(/<animate/i);
  });

  it('strips object elements pointing at data: html', () => {
    const html = renderMarkdown(
      '<object data="data:text/html,<script>alert(1)</script>"></object>'
    );
    expectNoActiveContent(html);
    expect(html).not.toMatch(/<object/i);
  });

  it('strips form controls carrying formaction', () => {
    const html = renderMarkdown(
      '<form action="/x"><button formaction="javascript:alert(1)">go</button></form>'
    );
    expectNoActiveContent(html);
    expect(html).not.toMatch(/<form/i);
  });

  it('strips style attributes carrying javascript urls', () => {
    const html = renderMarkdown('<div style="background:url(javascript:alert(1))">x</div>');
    expectNoActiveContent(html);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  it('strips style elements', () => {
    const html = renderMarkdown('<style>body{display:none}</style>');
    expect(html).not.toMatch(/<style/i);
  });

  it('strips data-* attributes', () => {
    const html = renderMarkdown('<div data-evil="1">x</div>');
    expect(html).not.toMatch(/data-evil/i);
  });
});

describe('renderMarkdown — interactive controls', () => {
  it('keeps GFM task-list checkboxes', () => {
    const html = renderMarkdown('- [x] done');
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
  });

  it('forces task-list checkboxes to be disabled', () => {
    const html = renderMarkdown('- [ ] todo');
    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it('drops non-checkbox inputs', () => {
    // input type=image is an outbound GET at render time, and a text field inside
    // the app's own chrome is a credible spoof even when inert.
    const html = renderMarkdown('<input type="text" value="password">');
    expect(html).not.toMatch(/<input/i);
  });

  it('drops the rest of the form-control kit', () => {
    const html = renderMarkdown(
      '<button>Approve</button><select><option>a</option></select><textarea>x</textarea><label>L</label>'
    );
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toMatch(/<select/i);
    expect(html).not.toMatch(/<option/i);
    expect(html).not.toMatch(/<textarea/i);
    expect(html).not.toMatch(/<label/i);
  });
});

describe('sanitizeDiagramSvg', () => {
  it('strips script from diagram SVG', () => {
    const svg = sanitizeDiagramSvg('<svg><script>alert(1)</script><rect/></svg>');
    expect(svg).not.toMatch(/<script/i);
  });

  it('strips event handlers on SVG elements', () => {
    const svg = sanitizeDiagramSvg('<svg><rect onclick="alert(1)" /></svg>');
    expect(svg).not.toMatch(/\son\w+\s*=/i);
  });

  it('strips animation elements that can rewrite attributes', () => {
    // <animate attributeName="href" to="javascript:..."> is the classic.
    const svg = sanitizeDiagramSvg(
      '<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>'
    );
    expect(svg).not.toMatch(/<animate/i);
    expect(svg).not.toMatch(/javascript:/i);
  });

  it('strips foreignObject, which reintroduces arbitrary HTML', () => {
    const svg = sanitizeDiagramSvg(
      '<svg><foreignObject><body><img src=x onerror=alert(1)></body></foreignObject></svg>'
    );
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/onerror/i);
  });

  it('strips href on use and image elements', () => {
    const svg = sanitizeDiagramSvg(
      '<svg><use href="#x"/><image href="https://evil.example/p.png"/></svg>'
    );
    expect(svg).not.toMatch(/href=/i);
  });

  it('keeps a style block when no scope is asked for — the caller decides', () => {
    // Unscoped is still the signature's default: `renderMarkdown`'s own sanitizing has no diagram
    // id to check against. Only `mermaid.ts` knows the id, and only it passes one.
    const svg = sanitizeDiagramSvg('<svg><style>.x{fill:red}</style></svg>');
    expect(svg).toMatch(/<style/i);
  });

  // ── J-25: the limitation this file used to merely document ──────────────────────────────
  //
  // A <style> inside an inline SVG joins the DOCUMENT stylesheet set, so CSS that escapes the
  // diagram restyles the whole app. It cannot be forbidden without losing every mermaid colour,
  // so it is checked instead: mermaid at securityLevel 'strict' prefixes every selector with the
  // diagram's own id, and a block that does not is not mermaid's.

  it('keeps mermaid’s own CSS, which is prefixed with the diagram id', () => {
    const svg = sanitizeDiagramSvg(
      '<svg><style>#d1 .node rect{fill:red}#d1 .edge{stroke:blue}</style></svg>',
      'd1'
    );
    expect(svg).toMatch(/<style/i);
    expect(svg).toContain('fill:red');
  });

  it('drops CSS that reaches outside the diagram', () => {
    const svg = sanitizeDiagramSvg('<svg><style>body{display:none}</style></svg>', 'd1');
    expect(svg).not.toMatch(/<style/i);
  });

  it('drops a block where only SOME selectors are scoped', () => {
    // The interesting shape: one legitimate-looking rule carrying one that is not. A check that
    // looked at the first rule, or at `includes('#d1')`, would pass this.
    const svg = sanitizeDiagramSvg(
      '<svg><style>#d1 .node{fill:red} body{display:none}</style></svg>',
      'd1'
    );
    expect(svg).not.toMatch(/<style/i);
  });

  it('drops a selector list where one member escapes', () => {
    const svg = sanitizeDiagramSvg('<svg><style>#d1 .node, body{display:none}</style></svg>', 'd1');
    expect(svg).not.toMatch(/<style/i);
  });

  it('looks inside a grouping rule rather than trusting its wrapper', () => {
    const escaping = sanitizeDiagramSvg(
      '<svg><style>@media screen{body{display:none}}</style></svg>',
      'd1'
    );
    expect(escaping).not.toMatch(/<style/i);

    const scoped = sanitizeDiagramSvg(
      '<svg><style>@media screen{#d1 .node{fill:red}}</style></svg>',
      'd1'
    );
    expect(scoped).toMatch(/<style/i);
  });

  it('refuses a rule whose scope it cannot reason about', () => {
    // `@font-face` has no selector to check. Neither it nor `@import` belongs in a diagram.
    const svg = sanitizeDiagramSvg(
      '<svg><style>@font-face{font-family:x;src:url(data:,)}</style></svg>',
      'd1'
    );
    expect(svg).not.toMatch(/<style/i);
  });

  it('fails closed on a block that will not parse into rules', () => {
    // An unparseable stylesheet is what a payload aiming at a parser quirk looks like. The cost of
    // being wrong here is a colourless diagram, not a restyled app.
    const svg = sanitizeDiagramSvg('<svg><style>this is not css at all</style></svg>', 'd1');
    expect(svg).not.toMatch(/<style/i);
  });

  it('does not mistake a longer id for the one it was given', () => {
    // `#d1-evil` starts with `#d1`. Prefix checks that forget the boundary are a classic.
    const svg = sanitizeDiagramSvg('<svg><style>#d1-evil{display:none}</style></svg>', 'd1');
    expect(svg).not.toMatch(/<style/i);
  });
});

describe('renderMarkdown — fidelity', () => {
  it('renders GFM tables', () => {
    const html = renderMarkdown(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'));
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<th/);
    expect(html).toMatch(/<td/);
  });

  it('renders GFM task lists', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo');
    expect(html).toMatch(/<input/);
    expect(html).toMatch(/type="checkbox"/);
  });

  it('renders fenced code with a language- class', () => {
    // The language- class is what the code styling hangs off, so this is the
    // canary for an over-tight sanitizer config. (`class` is in DOMPurify's html
    // profile already — the explicit ADD_ATTR is belt-and-braces, not load-bearing.)
    const html = renderMarkdown('```sql\nSELECT 1;\n```');
    expect(html).toMatch(/<pre/);
    expect(html).toMatch(/<code[^>]*class="[^"]*language-sql/);
  });

  it('turns a single newline into a line break', () => {
    // breaks: true. This materially changes how LLM output reads.
    const html = renderMarkdown('one\ntwo');
    expect(html).toMatch(/<br\s*\/?>/);
  });

  it('renders the inline elements the chat CSS styles', () => {
    const html = renderMarkdown('**b** *i* `c`\n\n> quote\n\n1. one\n\n- bullet');
    expect(html).toMatch(/<strong>/);
    expect(html).toMatch(/<em>/);
    expect(html).toMatch(/<code>/);
    expect(html).toMatch(/<blockquote>/);
    expect(html).toMatch(/<ol>/);
    expect(html).toMatch(/<ul>/);
  });

  it('renders headings h1 through h4', () => {
    const html = renderMarkdown('# a\n\n## b\n\n### c\n\n#### d');
    expect(html).toMatch(/<h1[^>]*>/);
    expect(html).toMatch(/<h2[^>]*>/);
    expect(html).toMatch(/<h3[^>]*>/);
    expect(html).toMatch(/<h4[^>]*>/);
  });

  it('preserves ordinary links', () => {
    const html = renderMarkdown('[docs](https://example.com/a)');
    expect(html).toMatch(/<a[^>]+href="https:\/\/example\.com\/a"/);
  });

  it('highlights code in a known language', () => {
    // Highlighting has never actually rendered in this app — no theme CSS was
    // ever loaded — so this asserts the markup exists for the theme to colour.
    const html = renderMarkdown('```sql\nSELECT 1;\n```');
    expect(html).toMatch(/class="[^"]*hljs/);
  });

  it('leaves an unknown language unhighlighted rather than throwing', () => {
    const html = renderMarkdown('```notalanguage\nx\n```');
    expect(html).toMatch(/<code/);
    expect(html).toContain('x');
  });
});

describe('renderMarkdown — partial and hostile input', () => {
  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('tolerates an unterminated code fence mid-stream', () => {
    const html = renderMarkdown('```sql\nSELECT 1;');
    expect(html).toMatch(/<pre/);
  });

  it('tolerates a half-written table row mid-stream', () => {
    const html = renderMarkdown('| a | b |\n| - |');
    expect(typeof html).toBe('string');
  });

  it('tolerates a lone asterisk', () => {
    expect(typeof renderMarkdown('*')).toBe('string');
  });

  it('handles a 100KB document without throwing', () => {
    const big = 'lorem ipsum dolor sit amet\n\n'.repeat(4000);
    expect(big.length).toBeGreaterThan(100_000);
    const html = renderMarkdown(big);
    expect(html).toMatch(/<p>/);
  });
});
