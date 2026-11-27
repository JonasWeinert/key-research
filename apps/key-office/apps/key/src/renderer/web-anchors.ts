// Anchors for highlights on a saved web page, in the W3C Web Annotation style: a text quote
// (exact text with some context either side) and a text position (character offsets into the
// page's text). A highlight finds its place again by position when the text there still
// matches, else by the quote and its context, else by the quote with spacing ignored.

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix: string;
  suffix: string;
}
export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}
export type WebSelector = TextQuoteSelector | TextPositionSelector;
export interface WebAnchor {
  version: 1;
  kind: "web";
  selectors: WebSelector[];
}

const CONTEXT = 32;
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);

/** The page's text nodes in document order, and where each starts in their joined text. */
export function textIndex(root: Node) {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: (node) => (node.parentElement && SKIP.has(node.parentElement.tagName) ? 2 : 1),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += (node as Text).data;
  }
  return { nodes, starts, text };
}
export type TextIndex = ReturnType<typeof textIndex>;

/** The character offset of a DOM point (a text node or an element boundary) in `index`. */
export function offsetOf(index: TextIndex, container: Node, offset: number): number {
  if (container.nodeType === 3) {
    const at = index.nodes.indexOf(container as Text);
    return at < 0 ? -1 : index.starts[at] + offset;
  }
  // An element boundary: the first text node at or after it.
  const doc = container.ownerDocument ?? (container as Document);
  const probe = doc.createRange();
  probe.setStart(container, offset);
  for (let i = 0; i < index.nodes.length; i++) {
    const node = index.nodes[i];
    if (probe.comparePoint(node, 0) >= 0) return index.starts[i];
  }
  return index.text.length;
}

/** Selectors for a range of the page. */
export function describeRange(index: TextIndex, range: Range): WebAnchor | undefined {
  const start = offsetOf(index, range.startContainer, range.startOffset);
  const end = offsetOf(index, range.endContainer, range.endOffset);
  if (start < 0 || end <= start) return undefined;
  const exact = index.text.slice(start, end);
  if (!exact.trim()) return undefined;
  return {
    version: 1,
    kind: "web",
    selectors: [
      { type: "TextQuoteSelector", exact, prefix: index.text.slice(Math.max(0, start - CONTEXT), start), suffix: index.text.slice(end, end + CONTEXT) },
      { type: "TextPositionSelector", start, end },
    ],
  };
}

/** How many characters of `a`'s end match `b`'s end (or starts, with `fromStart`). */
function overlap(a: string, b: string, fromStart: boolean) {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && (fromStart ? a[n] === b[n] : a[a.length - 1 - n] === b[b.length - 1 - n])) n++;
  return n;
}

/** Text with runs of whitespace collapsed, and a map from its offsets back to the original's. */
function collapse(text: string) {
  let out = "";
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (space) continue;
      space = true;
      out += " ";
    } else {
      space = false;
      out += text[i];
    }
    map.push(i);
  }
  map.push(text.length);
  return { out, map };
}

/** Where the anchor's text is now, as offsets into `index.text`; undefined when it is gone. */
export function locate(index: TextIndex, anchor: WebAnchor | undefined, fallbackText?: string): { start: number; end: number } | undefined {
  const quote = anchor?.selectors.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector");
  const position = anchor?.selectors.find((s): s is TextPositionSelector => s.type === "TextPositionSelector");
  const exact = quote?.exact ?? fallbackText ?? "";
  const text = index.text;
  if (position && position.end <= text.length && (!exact || text.slice(position.start, position.end) === exact))
    return { start: position.start, end: position.end };
  if (!exact.trim()) return undefined;
  // Every place the quote occurs, scored by how much of its context matches and how near it is.
  let best: { start: number; score: number } | undefined;
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    const prefix = quote ? overlap(text.slice(Math.max(0, at - quote.prefix.length), at), quote.prefix, false) : 0;
    const suffix = quote ? overlap(text.slice(at + exact.length, at + exact.length + quote.suffix.length), quote.suffix, true) : 0;
    const distance = position ? Math.abs(at - position.start) / Math.max(1, text.length) : 0;
    const score = prefix + suffix - distance;
    if (!best || score > best.score) best = { start: at, score };
  }
  if (best) return { start: best.start, end: best.start + exact.length };
  // Spacing changed (or the quote was copied with different line breaks): match collapsed.
  const page = collapse(text);
  const wanted = collapse(exact).out.trim();
  const at = wanted ? page.out.indexOf(wanted) : -1;
  if (at < 0) return undefined;
  return { start: page.map[at], end: page.map[at + wanted.length - 1] + 1 };
}

/** A DOM range for offsets into `index.text`. */
export function rangeFor(index: TextIndex, start: number, end: number): Range | undefined {
  const find = (offset: number, preferNext: boolean) => {
    for (let i = 0; i < index.nodes.length; i++) {
      const from = index.starts[i];
      const to = from + index.nodes[i].data.length;
      if (offset < to || (offset === to && !preferNext)) return { node: index.nodes[i], offset: offset - from };
    }
    const last = index.nodes.at(-1);
    return last ? { node: last, offset: last.data.length } : undefined;
  };
  const a = find(start, true);
  const b = find(end, false);
  if (!a || !b) return undefined;
  const range = a.node.ownerDocument!.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Wraps offsets [start, end) of the page in marks made by `make`; answers the marks. */
export function wrapRange(index: TextIndex, start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (let i = 0; i < index.nodes.length; i++) {
    const node = index.nodes[i];
    const from = index.starts[i];
    const to = from + node.data.length;
    if (to <= start || from >= end) continue;
    const parent = node.parentElement;
    // Whitespace between blocks (in a table or list) cannot hold a mark.
    if (!parent || /^(TABLE|TBODY|THEAD|TFOOT|TR|UL|OL|DL|SELECT|COLGROUP)$/.test(parent.tagName)) continue;
    let target = node;
    const a = Math.max(start, from) - from;
    const b = Math.min(end, to) - from;
    if (b < target.data.length) target.splitText(b);
    if (a > 0) target = target.splitText(a);
    if (!target.data.length) continue;
    const mark = make();
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

/** Takes marks out again, leaving their text where it was. */
export function unwrap(marks: Iterable<Element>) {
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}
