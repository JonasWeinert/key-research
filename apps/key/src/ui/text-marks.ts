// A host's marks in flowing text (reading mode, a saved page): found by their quoted words and
// painted with the CSS Custom Highlight API, so the page's own markup is left alone. A quote the
// text no longer has exactly is placed by its first words; one it lacks is not drawn.
import type { ReaderMark } from './SelectionMenu';

const TONES = ['notMet', 'met', 'evidence', 'source', 'accent', 'danger'] as const;
const fold = (s: string) => s.toLowerCase().replace(/[­￼]/g, '').replace(/[‐-―−]/g, '-').replace(/[   ]/g, ' ');

interface Flat {
  text: string;
  /** For each character of `text`: its node and offset. */
  at: Array<[Text, number]>;
}

/** The root's text with runs of space as one, and where each character came from. */
function flatten(root: Node): Flat {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('script, style, noscript, .ksm, [data-ksm-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  const at: Flat['at'] = [];
  let space = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = fold(node.data);
    for (let i = 0; i < value.length; i += 1) {
      const c = /\s/.test(value[i]) ? ' ' : value[i];
      if (c === ' ' && space) continue;
      space = c === ' ';
      text += c;
      at.push([node, i]);
    }
    // Blocks meet with a space ("…trial.Methods" reads as two words).
    if (!space && !node.nextSibling && node.parentElement && endsBlock(node.parentElement)) {
      text += ' ';
      at.push([node, node.data.length]);
      space = true;
    }
  }
  return { text, at };
}

function endsBlock(el: Element) {
  const next = el.nextSibling;
  return !next || (next instanceof Element && /^(P|DIV|LI|H[1-6]|TD|TH|SECTION|ARTICLE|BLOCKQUOTE|FIGCAPTION|TR)$/.test(next.tagName));
}

/** Where a quote is in the root's text: the whole of it, else its first words. */
export function findQuote(root: Node, quote: string, flat = flatten(root)): Range | null {
  const want = fold(quote).replace(/\s+/g, ' ').trim();
  if (!want) return null;
  const tries = [want, want.slice(0, 120), want.slice(0, 60), want.replace(/-\s/g, '')];
  for (const t of tries) {
    if (t.length < 4) continue;
    const i = flat.text.indexOf(t);
    if (i < 0) continue;
    const start = flat.at[i];
    const end = flat.at[Math.min(flat.at.length - 1, i + t.length - 1)];
    const doc = root.ownerDocument ?? (root as Document);
    const range = doc.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], Math.min(end[0].data.length, end[1] + 1));
    return range;
  }
  return null;
}

type HighlightRegistry = Map<string, unknown> & { delete(name: string): boolean };
interface HighlightWindow {
  CSS?: { highlights?: HighlightRegistry };
  Highlight?: new (...ranges: Range[]) => unknown;
}

/** Paints marks into a document (and returns where each landed); calling it again replaces them. */
export function paintTextMarks(root: Node, marks: Pick<ReaderMark, 'id' | 'text' | 'tone'>[], prefix = 'ksm'): Map<string, Range> {
  const doc = root.ownerDocument ?? (root as Document);
  const win = (doc.defaultView ?? window) as unknown as HighlightWindow;
  const registry = win.CSS?.highlights;
  const found = new Map<string, Range>();
  const flat = flatten(root);
  for (const mark of marks) {
    const range = findQuote(root, mark.text, flat);
    if (range) found.set(mark.id, range);
  }
  if (registry && win.Highlight) {
    for (const tone of TONES) {
      const ranges = marks.filter(m => m.tone === tone && found.has(m.id)).map(m => found.get(m.id)!);
      const name = `${prefix}-${tone}`;
      if (ranges.length) registry.set(name, new win.Highlight(...ranges));
      else registry.delete(name);
    }
  }
  return found;
}

/** The mark under a point, if any. */
export function markAt(found: Map<string, Range>, x: number, y: number): { id: string; rect: DOMRect } | null {
  for (const [id, range] of found) {
    for (const r of range.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 2) return { id, rect: range.getBoundingClientRect() };
    }
  }
  return null;
}

/** The styles a document needs to show the painted marks (theme colours passed in). */
export function textMarkStyles(colors: Record<string, string>, prefix = 'ksm'): string {
  return TONES.map(tone => {
    const c = colors[tone] ?? colors.evidence ?? 'Highlight';
    return `::highlight(${prefix}-${tone}) { background-color: color-mix(in srgb, ${c} 18%, transparent); text-decoration: underline 2px ${c}; text-underline-offset: 3px; }`;
  }).join('\n');
}
