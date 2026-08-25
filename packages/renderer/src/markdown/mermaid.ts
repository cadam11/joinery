/**
 * Mermaid, loaded on first use and rendered against the live DOM.
 *
 * Ported from `markdown-viewer.component.ts`. Two things about it are load-bearing:
 *
 * - **The dynamic import stays dynamic.** Mermaid is ~190KB and most assistant messages
 *   contain no diagram. CLAUDE.md's forbidden-patterns list rules out dynamic `import()`
 *   generally; this is the documented exception (the task brief states it), and it is the
 *   only one in the package.
 * - **`securityLevel: 'strict'`.** The renderer this replaces used `'loose'`, which permits
 *   click handlers and raw HTML labels inside diagrams whose source is model-authored.
 *
 * `initialize` runs on every call rather than only the first. Caching the module but skipping
 * it would let whichever component rendered the first diagram pin the theme for the rest of
 * the process, quietly making the theme argument a no-op.
 */

import { sanitizeDiagramSvg } from './render-markdown';

/** How many diagrams one message may render. Model output is not a trusted bound. */
const MAX_DIAGRAMS_PER_MESSAGE = 20;

export type MermaidTheme = 'default' | 'base' | 'dark' | 'forest' | 'neutral';

/** The subset of mermaid's API this module uses. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let mermaidModule: MermaidApi | null = null;

async function loadMermaid(theme: MermaidTheme): Promise<MermaidApi> {
  if (!mermaidModule) {
    const { default: mermaid } = await import('mermaid');
    mermaidModule = mermaid as unknown as MermaidApi;
  }
  mermaidModule.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    suppressErrorRendering: true,
  });
  return mermaidModule;
}

/**
 * Replaces every `pre > code.language-mermaid` under `root` with rendered, re-sanitized SVG.
 *
 * Returns the diagram failures as messages rather than throwing: one malformed diagram in a
 * message must not blank the other nineteen, and a failure degrades to the readable source
 * rather than to empty space.
 *
 * Unavoidably imperative — mermaid renders against a live document. Called from an effect,
 * after the sanitized HTML has been committed.
 */
/** One diagram to draw: its source, and the element the drawing replaces. */
interface PendingDiagram {
  readonly source: string;
  readonly target: HTMLElement;
}

/**
 * Everything under `root` that needs drawing for `theme` — the unrendered blocks, and the
 * already-rendered diagrams drawn for a different one.
 *
 * The second half is J-40. Rendering replaces the `pre` with a div, so the source block is gone
 * from the DOM: a re-run after a theme change used to match zero blocks and return early, leaving
 * a dark diagram on an ivory canvas. The source is stamped onto the container precisely so the
 * diagram can be drawn again, and the theme is stamped beside it so only diagrams that are
 * actually out of date get redrawn.
 */
function pendingDiagrams(root: HTMLElement, theme: MermaidTheme): PendingDiagram[] {
  const fresh: PendingDiagram[] = [];
  for (const block of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const pre = block.parentElement;
    if (pre !== null) fresh.push({ source: block.textContent ?? '', target: pre });
  }

  const stale: PendingDiagram[] = [];
  for (const drawn of root.querySelectorAll<HTMLElement>('[data-mermaid-source]')) {
    if (drawn.dataset.mermaidTheme === theme) continue;
    stale.push({ source: drawn.dataset.mermaidSource ?? '', target: drawn });
  }

  // One cap across both: a message that redraws is not a licence to exceed the bound.
  return [...fresh, ...stale].slice(0, MAX_DIAGRAMS_PER_MESSAGE);
}

export async function renderDiagramsIn(
  root: HTMLElement,
  theme: MermaidTheme
): Promise<readonly string[]> {
  const pending = pendingDiagrams(root, theme);
  if (pending.length === 0) {
    return [];
  }

  const mermaid = await loadMermaid(theme);
  const failures: string[] = [];

  for (const [index, { source, target }] of pending.entries()) {
    const container = document.createElement('div');
    // Stamped before the draw, so a diagram that FAILS still carries what it needs to be tried
    // again under another theme rather than being stuck on its error state forever.
    container.dataset.mermaidSource = source;
    container.dataset.mermaidTheme = theme;

    try {
      const { svg } = await mermaid.render(`diagram-${index}-${Date.now()}`, source);
      container.className = 'mermaid-diagram';
      container.innerHTML = sanitizeDiagramSvg(svg);
    } catch (error) {
      // A malformed diagram must degrade to readable source, not blank space.
      container.className = 'mermaid-error';
      container.textContent = source;
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`Diagram failed to render: ${reason}`);
    }
    target.replaceWith(container);
  }

  return failures;
}
