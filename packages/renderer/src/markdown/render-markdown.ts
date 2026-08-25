import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

/**
 * The single seam that turns model-authored markdown into HTML.
 *
 * Parse with `marked`, then sanitize with DOMPurify. DOMPurify uses the browser's
 * real HTML parser rather than pattern matching, which is what makes it correct on
 * the cases a regex filter misses — entity-encoded scheme names, `srcdoc`, and
 * attribute smuggling generally.
 *
 * Callers must not bypass this function. `dangerouslySetInnerHTML` is applied to
 * its output, never to raw model text — and `eslint.config.js` bans that property
 * everywhere except this directory, so there is no second route.
 *
 * PORTED FROM `packages/renderer/src/app/shared/markdown/markdown-renderer.ts`, and
 * deliberately not improved: every executable line below is byte-identical to the
 * Angular original, because the original's config is the security review that was
 * already done. `sanitize-parity.spec.ts` compares the two files' code (comments and
 * whitespace stripped) and fails if they diverge, so a "small tidy-up" here cannot
 * silently widen the sanitizer. Only the doc comments differ, where they named
 * Angular APIs.
 */

/** Built once. Rebuilding per call would re-register every extension on each streamed chunk. */
const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  {
    gfm: true,
    // A single newline becomes <br>. Model output leans on this heavily; changing
    // it silently reflows every message in the app.
    breaks: true,
    async: false,
  }
);

/**
 * Tags with no legitimate place in chat output, each of which is an execution or
 * exfiltration vector on its own:
 * - `style` can hide or reposition UI over the rest of the app
 * - `iframe` / `object` / `embed` load and execute foreign documents
 * - `form` turns any nested control into an outbound request
 * - `svg` / `math` carry their own script-bearing element sets; mermaid's SVG is
 *   sanitized separately against the SVG profile, so it does not need this path
 *
 * The interactive controls (`button`, `select`, `textarea`, `option`, `label`) are
 * forbidden for a different reason than the rest: not because they can execute
 * anything — event handlers and `formaction` are stripped — but because chat
 * renders model output and tool results inside the app's own chrome, with no
 * visual boundary marking where untrusted content begins. A working text field
 * next to an "Approve" button is a credible spoof even when it is completely inert.
 *
 * `input` is the deliberate exception: GFM task lists render as disabled
 * checkboxes, and forbidding it would silently degrade a common model output. It
 * is narrowed to exactly that shape by the hook below.
 */
const FORBID_TAGS = [
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'svg',
  'math',
  'button',
  'select',
  'textarea',
  'option',
  'label',
];

const FORBID_ATTR = ['srcdoc', 'style', 'formaction', 'xlink:href', 'ping'];

/**
 * Narrows `input` to the disabled checkbox a GFM task list needs. Anything else —
 * a text field, `type="image"` (which is an outbound GET at render time) — is
 * dropped. Registered once at module scope; DOMPurify hooks are global.
 */
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input') {
    return;
  }
  const element = node as Element;
  const isTaskListCheckbox = element.getAttribute('type')?.toLowerCase() === 'checkbox';
  if (!isTaskListCheckbox) {
    element.remove();
    return;
  }
  element.setAttribute('disabled', '');
});

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  // Belt-and-braces: `class` is already in DOMPurify's html profile, so this
  // widens nothing. It is here so that a future profile change cannot silently
  // strip the language-*/hljs-* hooks the code styling hangs off.
  ADD_ATTR: ['class'],
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_DATA_ATTR: false,
};

/**
 * Render markdown to HTML that is safe to hand to `dangerouslySetInnerHTML`.
 *
 * Pure apart from DOMPurify's use of a detached document. Tolerates any string,
 * including partial input — mid-stream chunks routinely arrive with unterminated
 * fences. Throws only on a non-string argument, which is a programming error;
 * callers read this inside a render pass, so a throw there takes down the view.
 */
export function renderMarkdown(md: string): string {
  if (typeof md !== 'string') {
    throw new TypeError(`renderMarkdown expects a string, received ${typeof md}`);
  }
  if (md === '') {
    return '';
  }

  // `async: false` above makes this synchronous; the cast documents that.
  const rawHtml = marked.parse(md) as string;
  return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
}

/**
 * Sanitize mermaid's rendered SVG against the SVG profile.
 *
 * Kept separate from {@link renderMarkdown} because that path forbids `svg`
 * outright. Mermaid runs with `securityLevel: 'strict'`, but its output is still
 * derived from model-authored diagram source, so it is sanitized rather than
 * trusted.
 *
 * KNOWN LIMITATION: `<style>` survives here, and a `<style>` inside an inline SVG
 * joins the *document* stylesheet set — so CSS that escapes the diagram can
 * restyle the whole app. It cannot be forbidden outright because every diagram
 * colour mermaid emits lives in that block. This is defence-in-depth only: mermaid
 * at `securityLevel: 'strict'` prefixes its selectors with the diagram id and
 * rejects `%%{init: themeCSS}%%` and `classDef` brace-escape attempts, so no
 * model-authored CSS is known to reach here. Scoping or re-providing that CSS from
 * app styles is tracked as follow-up work.
 */
export function sanitizeDiagramSvg(svg: string, scopeTo?: string): string {
  if (typeof svg !== 'string') {
    throw new TypeError(`sanitizeDiagramSvg expects a string, received ${typeof svg}`);
  }
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['xlink:href', 'href', 'formaction'],
    ALLOW_DATA_ATTR: false,
  });

  return scopeTo === undefined ? clean : withScopedStyleOnly(clean, scopeTo);
}

/**
 * Drop any `<style>` whose rules are not confined to `#${scopeTo}` (J-25).
 *
 * A `<style>` inside an inline SVG joins the DOCUMENT stylesheet set, so CSS that escapes the
 * diagram restyles the whole app. It cannot simply be forbidden — every colour mermaid emits lives
 * in that block — so this checks rather than strips: mermaid at `securityLevel: 'strict'` prefixes
 * every selector with the diagram's own id, and a block that does not is not mermaid's.
 *
 * Defence in depth, not a live fix: no model-authored CSS is known to reach here. Mermaid rejected
 * the `%%{init: themeCSS}%%` directive, a `classDef` brace escape and a `url()` payload when those
 * were tried against it. This closes the path anyway, because "no known way in" is a statement
 * about today's mermaid.
 *
 * **Fails closed.** A block the browser will not parse into rules is dropped rather than trusted —
 * an unparseable stylesheet is exactly what a payload aiming at a parser quirk looks like, and the
 * cost of being wrong is a colourless diagram rather than a restyled app.
 */
function withScopedStyleOnly(svg: string, scopeTo: string): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const styles = Array.from(parsed.querySelectorAll('style'));
  if (styles.length === 0) return svg;

  for (const style of styles) {
    if (!everyRuleIsScopedTo(style.textContent ?? '', scopeTo)) style.remove();
  }
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

/**
 * True when every selector in `css` is confined to `#${scopeTo}`.
 *
 * Parsing is the browser's, through a detached stylesheet: hand-rolling CSS parsing is how a
 * scoping check gets fooled by a comment, a string or an `@media` block.
 */
function everyRuleIsScopedTo(css: string, scopeTo: string): boolean {
  if (css.trim() === '') return true;

  const holder = document.createElement('style');
  holder.textContent = css;
  document.head.append(holder);
  try {
    const rules = holder.sheet?.cssRules;
    // No sheet, or a stylesheet that parsed to nothing while the text was not empty: fail closed.
    if (rules === undefined || rules.length === 0) return false;
    return Array.from(rules).every(rule => ruleIsScopedTo(rule, scopeTo));
  } catch {
    // Cross-origin or an environment without CSSOM. Fail closed for the same reason.
    return false;
  } finally {
    holder.remove();
  }
}

/**
 * True when `selector` begins with `#${id}` AND the id ENDS there.
 *
 * The boundary is the whole point: `#d1-evil` starts with `#d1`, so a bare `startsWith` would
 * admit any id that merely shares a prefix with the diagram's. A CSS identifier continues with
 * letters, digits, `-`, `_` or an escape, so anything else — end of string, whitespace, a
 * combinator, `.`, `#`, `[`, `:` — is a real end.
 */
function startsWithId(selector: string, id: string): boolean {
  const prefix = `#${id}`;
  if (!selector.startsWith(prefix)) return false;

  const next = selector.charAt(prefix.length);
  return next === '' || !/[\w\-\\]/.test(next);
}

/** One rule, and the grouping rules that can contain others. */
function ruleIsScopedTo(rule: CSSRule, scopeTo: string): boolean {
  const grouped = (rule as CSSGroupingRule).cssRules;
  if (grouped !== undefined) {
    return Array.from(grouped).every(inner => ruleIsScopedTo(inner, scopeTo));
  }

  const selector = (rule as CSSStyleRule).selectorText;
  // A rule with no selector is an at-rule this check cannot reason about — `@font-face`,
  // `@import`. Neither belongs in a diagram, so neither is allowed to pass.
  if (typeof selector !== 'string') return false;

  return selector.split(',').every(one => startsWithId(one.trim(), scopeTo));
}
