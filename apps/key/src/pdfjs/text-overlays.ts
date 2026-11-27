import type {
  NativeBounds,
  NativeLink,
  NativeTextPage,
  ScientificCitation,
} from '../engines/types';
import {
  boundsForRange,
  localMatches,
  fetchTextPage,
  normalizeRange,
  textForRange,
  type PageHost,
  type ReaderAnnotation,
  type ReaderSearchMatch,
  type SelectionSnapshot,
  type TextPosition,
  type TextRange,
} from './reader-model';

function rectStyle(element: HTMLElement, bounds: NativeBounds) {
  element.style.left = `${bounds.left * 100}%`;
  element.style.top = `${bounds.top * 100}%`;
  element.style.width = `${Math.max(0, bounds.right - bounds.left) * 100}%`;
  element.style.height = `${Math.max(0, bounds.bottom - bounds.top) * 100}%`;
}

/** Where the text column holding a passage starts on its lines, so a highlight that begins
 *  mid-line gets its marker in the margin rather than over the words before it. */
function columnStart(text: NativeTextPage | undefined, left: number, top: number, bottom: number) {
  if (!text) return left;
  const lefts: number[] = [];
  for (const character of text.characters) {
    const b = character.bounds;
    if (!b || b.left >= left || !character.value.trim()) continue;
    const middle = (b.top + b.bottom) / 2;
    if (middle >= top && middle <= bottom) lefts.push(b.left, b.right);
  }
  lefts.sort((a, b) => b - a);
  let start = left;
  // Walk left along the lines until a gap wider than a column gutter.
  for (const x of lefts) {
    if (start - x > 0.03) break;
    start = Math.min(start, x);
  }
  return start;
}

function viewportRectForBounds(host: HTMLElement, bounds: NativeBounds[]) {
  if (bounds.length === 0) return;
  const page = host.getBoundingClientRect();
  const left = Math.min(...bounds.map(bound => bound.left));
  const top = Math.min(...bounds.map(bound => bound.top));
  const right = Math.max(...bounds.map(bound => bound.right));
  const bottom = Math.max(...bounds.map(bound => bound.bottom));
  return new DOMRect(
    page.left + left * page.width,
    page.top + top * page.height,
    Math.max(1, (right - left) * page.width),
    Math.max(1, (bottom - top) * page.height),
  );
}

export function characterIndexAtPoint(
  text: NativeTextPage,
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number,
  maximumDistance = 24,
) {
  let closest: { index: number; distance: number } | null = null;
  for (let index = 0; index < text.characters.length; index += 1) {
    const bounds = text.characters[index]?.bounds;
    if (!bounds) continue;
    const dx =
      x < bounds.left
        ? (bounds.left - x) * pageWidth
        : x > bounds.right
          ? (x - bounds.right) * pageWidth
          : 0;
    const dy =
      y < bounds.top
        ? (bounds.top - y) * pageHeight
        : y > bounds.bottom
          ? (y - bounds.bottom) * pageHeight
          : 0;
    const distance = Math.hypot(dx, dy);
    if (
      !closest ||
      distance < closest.distance ||
      (distance === closest.distance &&
        Math.abs(x - (bounds.left + bounds.right) / 2) <
          Math.abs(
            x -
              ((text.characters[closest.index]?.bounds?.left ?? 0) +
                (text.characters[closest.index]?.bounds?.right ?? 0)) /
                2,
          ))
    ) {
      closest = { index, distance };
    }
  }
  return closest && closest.distance <= maximumDistance ? closest.index : null;
}

/** A host's mark in the page (a review's evidence or a value's source; SelectionMenu.tsx):
 * boxes in fractions of the page, drawn apart from the user's highlights. */
export interface HostMark {
  id: string;
  page: number;
  bounds: NativeBounds[];
  tone: string;
  label: string;
}

interface SelectionDrag {
  pointerId: number;
  anchor: TextPosition;
  latest: TextPosition;
  originX: number;
  originY: number;
  moved: boolean;
}

export class PdfJsTextOverlayManager {
  readonly textPages = new Map<number, NativeTextPage>();
  private readonly documentId: string;
  private readonly hosts: PageHost[];
  private readonly pending = new Map<number, Promise<NativeTextPage>>();
  private annotations: ReaderAnnotation[] = [];
  private hostMarks: HostMark[] = [];
  private hostMarkListener?: (mark: HostMark, rect: DOMRect) => void;
  private flashMarkId: string | null = null;
  private searchMatches: ReaderSearchMatch[] = [];
  private activeSearchId: string | null = null;
  private resultTarget: ReaderSearchMatch | null = null;
  /** An annotation briefly lit up to draw the eye (after "Show in PDF"). */
  private flashId: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where the pointer was when it last hovered a citation. */
  private citationPoint: { x: number; y: number } | null = null;
  /** A quoted passage (no highlight of its own) briefly lit up the same way. */
  private flashPassage: { page: number; bounds: NativeBounds[] } | null = null;
  private links: Array<NativeLink & { synthetic?: boolean }> = [];
  private citations: ScientificCitation[] = [];
  private liveSelection: TextRange | null = null;
  private selectionListener?: (snapshot: SelectionSnapshot | null) => void;
  private annotationListener?: (annotation: ReaderAnnotation | null, rect?: DOMRect) => void;
  private linkListener?: (
    link: NativeLink & { synthetic?: boolean },
    rect: DOMRect,
  ) => void;
  private linkHoverListener?: (
    link: (NativeLink & { synthetic?: boolean }) | null,
    rect?: DOMRect,
  ) => void;
  private citationListener?: (citation: ScientificCitation, rect: DOMRect) => void;
  private citationHoverListener?: (
    citation: ScientificCitation | null,
    rect?: DOMRect,
  ) => void;
  private selectionDrag: SelectionDrag | null = null;
  private suppressActivationPointer: number | null = null;
  private destroyed = false;

  constructor(documentId: string, hosts: PageHost[]) {
    this.documentId = documentId;
    this.hosts = hosts;
    document.addEventListener('pointermove', this.onSelectionPointerMove, true);
    document.addEventListener('pointerup', this.onSelectionPointerUp, true);
    document.addEventListener('pointercancel', this.onSelectionPointerUp, true);
    for (const host of hosts) {
      host.element.addEventListener('pointerdown', this.onSelectionPointerDown);
      host.element.addEventListener('pointerup', this.onPointerUp);
      host.element.addEventListener('pointermove', this.onPointerMove);
      host.element.addEventListener('pointerleave', this.onPointerLeave);
    }
  }

  onSelection(listener: (snapshot: SelectionSnapshot | null) => void) {
    this.selectionListener = listener;
  }

  /** The host's marks; a click on one goes to `onHostMarkActivation`. */
  setHostMarks(marks: HostMark[]) {
    this.hostMarks = marks;
    this.renderAll();
    for (const page of new Set(marks.map(m => m.page))) if (!this.textPages.has(page)) this.renderPage(page);
  }

  onHostMarkActivation(listener: (mark: HostMark, rect: DOMRect) => void) {
    this.hostMarkListener = listener;
  }

  /** Lights up a host mark briefly (its source chip was clicked). */
  flashHostMark(id: string, duration = 1800) {
    this.flashMarkId = id;
    this.renderAll();
    for (const m of this.hostMarks.filter(m => m.id === id)) this.renderPage(m.page);
    window.setTimeout(() => {
      if (this.flashMarkId !== id) return;
      this.flashMarkId = null;
      this.renderAll();
    }, duration);
  }

  hostMarkRect(id: string): DOMRect | null {
    const mark = this.hostMarks.find(m => m.id === id);
    const host = mark && this.hosts[mark.page]?.element;
    return mark && host ? viewportRectForBounds(host, mark.bounds) ?? null : null;
  }

  onAnnotationActivation(
    listener: (annotation: ReaderAnnotation | null, rect?: DOMRect) => void,
  ) {
    this.annotationListener = listener;
  }

  onLinkActivation(
    listener: (
      link: NativeLink & { synthetic?: boolean },
      rect: DOMRect,
    ) => void,
  ) {
    this.linkListener = listener;
  }

  onLinkHover(
    listener: (
      link: (NativeLink & { synthetic?: boolean }) | null,
      rect?: DOMRect,
    ) => void,
  ) {
    this.linkHoverListener = listener;
  }

  onCitationActivation(
    listener: (citation: ScientificCitation, rect: DOMRect) => void,
  ) {
    this.citationListener = listener;
  }

  onCitationHover(
    listener: (citation: ScientificCitation | null, rect?: DOMRect) => void,
  ) {
    this.citationHoverListener = listener;
  }

  async ensurePage(page: number) {
    if (this.destroyed) return;
    if (this.textPages.has(page)) {
      const cached = this.textPages.get(page)!;
      this.textPages.delete(page); this.textPages.set(page, cached);
      return cached;
    }
    let request = this.pending.get(page);
    if (!request) {
      const host = this.hosts[page];
      if (!host) return;
      request = fetchTextPage(this.documentId, page, host);
      this.pending.set(page, request);
    }
    try {
      const text = await request;
      if (this.destroyed) return;
      this.textPages.set(page, text);
      this.mountTextLayer(this.hosts[page], text);
      this.renderPage(page);
      // Native search streams pages from SQLite; keep only a small reader working set.
      if (!this.selectionDrag && !this.liveSelection) {
        for (const cachedPage of this.textPages.keys()) {
          if (this.textPages.size <= 12) break;
          const host = this.hosts[cachedPage]; const rect = host.element.getBoundingClientRect();
          if (cachedPage === page || (host.element.isConnected && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight)) continue;
          this.textPages.delete(cachedPage);
          host.element.querySelector('.pdfjs-text-layer')?.remove();
          host.element.querySelector('.pdfjs-overlay-layer')?.replaceChildren();
          host.element.querySelector(':scope > .pdfjs-marker-layer')?.replaceChildren();
        }
      }
      return text;
    } finally {
      this.pending.delete(page);
    }
  }

  async ensurePages(pages: Iterable<number>) {
    for (const page of new Set(pages)) { if (this.destroyed) return; await this.ensurePage(page); }
  }

  async search(query: string, cancelled: () => boolean): Promise<ReaderSearchMatch[]> {
    const matches: ReaderSearchMatch[] = [];
    for (let page = 0; page < this.hosts.length; page += 1) {
      if (this.destroyed || cancelled()) return [];
      const host = this.hosts[page];
      const text = this.textPages.get(page) ?? await fetchTextPage(this.documentId, page, host);
      if (this.destroyed || cancelled()) return [];
      matches.push(...localMatches(new Map([[page, text]]), query).slice(0, 20_000 - matches.length));
      if (!host.element.isConnected) host.page.cleanup();
      if (matches.length >= 20_000) break;
      if (page % 8 === 7) await new Promise(resolve => window.setTimeout(resolve, 0));
    }
    return matches;
  }

  async ensureAllPages() {
    await this.ensurePages(this.hosts.map((_, page) => page));
  }

  setAnnotations(annotations: ReaderAnnotation[]) {
    this.annotations = annotations;
    this.renderAll();
  }

  flashAnnotation(id: string, duration = 1800) {
    clearTimeout(this.flashTimer);
    this.flashId = id;
    this.renderAll();
    this.flashTimer = setTimeout(() => {
      this.flashId = null;
      this.renderAll();
    }, duration);
  }

  flashBounds(page: number, bounds: NativeBounds[], duration = 1800) {
    clearTimeout(this.flashTimer);
    this.flashPassage = { page, bounds };
    this.renderAll();
    this.flashTimer = setTimeout(() => {
      this.flashPassage = null;
      this.renderAll();
    }, duration);
  }

  setResultTarget(target: ReaderSearchMatch | null) {
    this.resultTarget = target;
    this.renderAll();
  }

  setSearch(matches: ReaderSearchMatch[], activeId: string | null) {
    this.searchMatches = matches;
    this.activeSearchId = activeId;
    this.renderAll();
  }

  setLinks(links: Array<NativeLink & { synthetic?: boolean }>) {
    this.links = links;
    this.renderAll();
  }

  setCitations(citations: ScientificCitation[]) {
    this.citations = citations;
    this.renderAll();
  }

  setSelection(range: TextRange | null) {
    this.liveSelection = range;
    this.renderAll();
  }

  clearBrowserSelection() {
    window.getSelection()?.removeAllRanges();
    this.setSelection(null);
  }

  viewportRectForRange(range: TextRange) {
    const rects: DOMRect[] = [];
    for (let page = range.start.page; page <= range.end.page; page += 1) {
      const host = this.hosts[page];
      const text = this.textPages.get(page);
      if (!host || !text) continue;
      const rect = viewportRectForBounds(
        host.element,
        boundsForRange(text, range),
      );
      if (rect) rects.push(rect);
    }
    if (rects.length === 0) return;
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.right));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  }

  viewportRectForPageBounds(page: number, bounds: NativeBounds[]) {
    const host = this.hosts[page];
    return host ? viewportRectForBounds(host.element, bounds) : undefined;
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('pointermove', this.onSelectionPointerMove, true);
    document.removeEventListener('pointerup', this.onSelectionPointerUp, true);
    document.removeEventListener('pointercancel', this.onSelectionPointerUp, true);
    for (const host of this.hosts) {
      host.element.removeEventListener('pointerdown', this.onSelectionPointerDown);
      host.element.removeEventListener('pointerup', this.onPointerUp);
      host.element.removeEventListener('pointermove', this.onPointerMove);
      host.element.removeEventListener('pointerleave', this.onPointerLeave);
      host.element
        .querySelectorAll('.pdfjs-text-layer, .pdfjs-overlay-layer, .pdfjs-marker-layer')
        .forEach(element => element.remove());
    }
    this.pending.clear();
    this.textPages.clear();
  }

  private mountTextLayer(host: PageHost, text: NativeTextPage) {
    host.element.querySelector('.pdfjs-text-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'pdfjs-text-layer';
    layer.setAttribute('aria-label', `Selectable text for page ${text.page + 1}`);
    for (const run of selectableRuns(text)) {
      const span = document.createElement('span');
      span.className = 'pdfjs-text-run';
      span.dataset.page = String(text.page);
      span.dataset.startIndex = String(run.start);
      span.dataset.endIndex = String(run.end);
      span.textContent = run.text;
      rectStyle(span, run.bounds);
      span.style.setProperty(
        '--glyph-height',
        String(Math.max(0.001, run.bounds.bottom - run.bounds.top)),
      );
      layer.append(span);
    }
    host.element.append(layer);
  }

  private overlayLayer(page: number) {
    const host = this.hosts[page];
    if (!host) return null;
    let layer = host.element.querySelector<HTMLDivElement>('.pdfjs-overlay-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'pdfjs-overlay-layer';
      host.element.insertBefore(layer, host.element.querySelector('.pdfjs-text-layer'));
    }
    return layer;
  }

  /** Above the text layer, so the margin markers take the pointer. */
  private markerLayer(page: number) {
    const host = this.hosts[page];
    if (!host) return null;
    let layer = host.element.querySelector<HTMLDivElement>(':scope > .pdfjs-marker-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'pdfjs-marker-layer';
      host.element.append(layer);
    }
    return layer;
  }

  private paintBounds(
    layer: HTMLElement,
    bounds: NativeBounds[],
    className: string,
    id?: string,
  ) {
    for (const bound of bounds) {
      const element = document.createElement('div');
      element.className = className;
      if (id) element.dataset.id = id;
      rectStyle(element, bound);
      layer.append(element);
    }
  }

  /** A slim bar in the margin beside a highlight, in its colour; a click opens its card. */
  private marginMarker(page: number, annotation: ReaderAnnotation, bounds: NativeBounds[]) {
    const top = Math.min(...bounds.map(b => b.top));
    const bottom = Math.max(...bounds.map(b => b.bottom));
    const left = columnStart(this.textPages.get(page), Math.min(...bounds.map(b => b.left)), top, bottom);
    const marker = document.createElement('div');
    marker.className = `pdfjs-highlight-marker color-${annotation.color}${annotation.comment ? ' has-comment' : ''}`;
    marker.dataset.id = annotation.id;
    marker.title = annotation.comment ? 'Highlight with a comment' : 'Highlight';
    marker.style.left = `max(2px, calc(${left * 100}% - 11px))`;
    marker.style.top = `${top * 100}%`;
    marker.style.height = `${Math.max(0.004, bottom - top) * 100}%`;
    marker.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    marker.addEventListener('pointerup', event => {
      event.preventDefault();
      event.stopPropagation();
      const host = this.hosts[page]?.element;
      this.annotationListener?.(annotation, host ? viewportRectForBounds(host, bounds) : marker.getBoundingClientRect());
    });
    return marker;
  }

  private renderPage(page: number) {
    const layer = this.overlayLayer(page);
    const text = this.textPages.get(page);
    if (!layer) return;
    layer.replaceChildren();
    const markers = this.markerLayer(page);
    markers?.replaceChildren();
    if (this.resultTarget?.page === page) {
      this.paintBounds(layer, this.resultTarget.bounds, 'pdfjs-result-target', this.resultTarget.id);
    }
    if (this.flashPassage?.page === page) {
      this.paintBounds(layer, this.flashPassage.bounds, 'pdfjs-passage-flash');
    }
    for (const annotation of this.annotations) {
      if (page < annotation.range.start.page || page > annotation.range.end.page) continue;
      const className = `pdfjs-highlight color-${annotation.color}${
        annotation.comment ? ' has-comment' : ''
      }${annotation.id === this.flashId ? ' flash' : ''}`;
      const bounds = annotation.anchor?.pages.find(p => p.page === page)?.bounds ?? (text ? boundsForRange(text, annotation.range) : []);
      this.paintBounds(layer, bounds, className, annotation.id);
      if (bounds.length) (markers ?? layer).append(this.marginMarker(page, annotation, bounds));
    }
    for (const mark of this.hostMarks) {
      if (mark.page !== page || !mark.bounds.length) continue;
      this.paintBounds(layer, mark.bounds, `pdfjs-host-mark tone-${mark.tone}${mark.id === this.flashMarkId ? ' flash' : ''}`, mark.id);
      // Its label at the start, in the margin's colour: what the passage is for.
      const first = mark.bounds.reduce((a, b) => (b.top < a.top - 0.002 || (Math.abs(b.top - a.top) <= 0.002 && b.left < a.left) ? b : a));
      const tag = document.createElement('div');
      tag.className = `pdfjs-host-mark-tag tone-${mark.tone}`;
      tag.dataset.id = mark.id;
      tag.textContent = mark.label.split(":")[0];
      tag.style.left = `${first.left * 100}%`;
      tag.style.top = `${first.top * 100}%`;
      tag.title = mark.label;
      (markers ?? layer).append(tag);
    }
    if (!text) return;
    for (const match of this.searchMatches.filter(match => match.page === page)) {
      this.paintBounds(
        layer,
        match.bounds,
        match.id === this.activeSearchId
          ? 'pdfjs-search-match active'
          : 'pdfjs-search-match',
        match.id,
      );
    }
    for (const link of this.links.filter(link => link.page === page)) {
      this.paintBounds(
        layer,
        [link.bounds],
        link.synthetic ? 'pdfjs-link-overlay citation' : 'pdfjs-link-overlay',
        String(link.id),
      );
    }
    for (const citation of this.citations.filter(citation => citation.page === page)) {
      const element = document.createElement('div');
      element.className = 'pdfjs-link-overlay citation';
      element.dataset.id = citation.id;
      rectStyle(element, citation.bounds);
      element.addEventListener('pointerenter', () => {
        const rect = viewportRectForBounds(this.hosts[page].element, [citation.bounds]);
        this.citationHoverListener?.(citation, rect);
      });
      element.addEventListener('pointerleave', event => {
        const host = this.hosts[page].element.getBoundingClientRect();
        const x = (event.clientX - host.left) / host.width;
        const y = (event.clientY - host.top) / host.height;
        const { left, right, top, bottom } = citation.bounds;
        // A re-render under a still pointer, not the pointer moving away.
        if (x >= left && x <= right && y >= top && y <= bottom) return;
        this.citationHoverListener?.(null);
      });
      element.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        const rect = viewportRectForBounds(this.hosts[page].element, [citation.bounds]);
        if (rect) this.citationListener?.(citation, rect);
      });
      layer.append(element);
    }
    if (this.liveSelection) {
      this.paintBounds(
        layer,
        boundsForRange(text, this.liveSelection),
        'pdfjs-selection-highlight',
      );
    }
  }

  private renderAll() {
    for (const page of this.textPages.keys()) this.renderPage(page);
    if (this.resultTarget && !this.textPages.has(this.resultTarget.page)) this.renderPage(this.resultTarget.page);
  }

  private publishSelection(range: TextRange | null) {
    this.liveSelection = range;
    this.renderAll();
    if (!range) {
      this.selectionListener?.(null);
      return;
    }
    const rect = this.viewportRectForRange(range);
    if (!rect) return;
    this.selectionListener?.({
      range,
      text: textForRange(this.textPages, range),
      viewportRect: rect,
    });
  }

  private textPositionAtPoint(clientX: number, clientY: number) {
    for (let page = 0; page < this.hosts.length; page += 1) {
      const host = this.hosts[page];
      const text = this.textPages.get(page);
      if (!host || !text) continue;
      const rect = host.element.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        continue;
      }
      const index = characterIndexAtPoint(
        text,
        (clientX - rect.left) / rect.width,
        (clientY - rect.top) / rect.height,
        rect.width,
        rect.height,
      );
      if (index !== null) return { page, index };
    }
    return null;
  }

  private readonly onSelectionPointerDown = (event: PointerEvent) => {
    if (
      this.destroyed ||
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest('.pdfjs-text-layer')
    ) {
      return;
    }
    const anchor = this.textPositionAtPoint(event.clientX, event.clientY);
    if (!anchor) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    this.selectionDrag = {
      pointerId: event.pointerId,
      anchor,
      latest: anchor,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    };
  };

  private readonly onSelectionPointerMove = (event: PointerEvent) => {
    const drag = this.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) < 3
    ) {
      return;
    }
    const latest = this.textPositionAtPoint(event.clientX, event.clientY);
    if (!latest) return;
    event.preventDefault();
    drag.moved = true;
    drag.latest = latest;
    this.publishSelection(normalizeRange(drag.anchor, drag.latest));
  };

  private readonly onSelectionPointerUp = (event: PointerEvent) => {
    const drag = this.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.selectionDrag = null;
    if (!drag.moved) {
      this.publishSelection(null);
      return;
    }
    event.preventDefault();
    this.suppressActivationPointer = event.pointerId;
    window.setTimeout(() => {
      if (this.suppressActivationPointer === event.pointerId) {
        this.suppressActivationPointer = null;
      }
    }, 0);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.suppressActivationPointer === event.pointerId) return;
    const currentTarget = event.currentTarget as HTMLElement;
    const { clientX, clientY } = event;
    queueMicrotask(() => {
      const host = currentTarget.closest<HTMLElement>('.pdfjs-page');
      const page = Number(host?.dataset.pageIndex);
      if (!host || !Number.isInteger(page)) return;
      const rect = host.getBoundingClientRect();
      const x = (clientX - rect.left) / rect.width;
      const y = (clientY - rect.top) / rect.height;
      const hit = (b: NativeBounds) => x >= b.left && x <= b.right && y >= b.top - 0.004 && y <= b.bottom + 0.004;
      const mark = [...this.hostMarks].reverse().find(m => m.page === page && m.bounds.some(hit));
      if (mark && this.hostMarkListener) {
        const rect = viewportRectForBounds(host, mark.bounds);
        if (rect) {
          this.annotationListener?.(null);
          this.hostMarkListener(mark, rect);
          return;
        }
      }
      const text = this.textPages.get(page);
      if (!text) return;
      const annotation = [...this.annotations]
        .reverse()
        .find(candidate => {
          if (page < candidate.range.start.page || page > candidate.range.end.page) return false;
          return boundsForRange(text, candidate.range).some(
            bounds =>
              x >= bounds.left &&
              x <= bounds.right &&
              y >= bounds.top &&
              y <= bounds.bottom,
          );
        });
      this.annotationListener?.(
        annotation ?? null,
        annotation
          ? viewportRectForBounds(host, boundsForRange(text, annotation.range))
          : undefined,
      );
      if (annotation) return;
      const citation = [...this.citations]
        .reverse()
        .find(
          candidate =>
            candidate.page === page &&
            x >= candidate.bounds.left &&
            x <= candidate.bounds.right &&
            y >= candidate.bounds.top &&
            y <= candidate.bounds.bottom,
        );
      if (citation) {
        const citationRect = viewportRectForBounds(host, [citation.bounds]);
        if (citationRect) this.citationListener?.(citation, citationRect);
        return;
      }
      const link = [...this.links]
        .reverse()
        .find(
          candidate =>
            candidate.page === page &&
            x >= candidate.bounds.left &&
            x <= candidate.bounds.right &&
            y >= candidate.bounds.top &&
            y <= candidate.bounds.bottom,
        );
      if (link) {
        const linkRect = viewportRectForBounds(host, [link.bounds]);
        if (linkRect) this.linkListener?.(link, linkRect);
      }
    });
  };

  private linkAt(event: PointerEvent) {
    const host = (event.currentTarget as HTMLElement).closest<HTMLElement>('.pdfjs-page');
    const page = Number(host?.dataset.pageIndex);
    if (!host || !Number.isInteger(page)) return null;
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return [...this.links]
      .reverse()
      .find(
        candidate =>
          candidate.page === page &&
          x >= candidate.bounds.left &&
          x <= candidate.bounds.right &&
          y >= candidate.bounds.top &&
          y <= candidate.bounds.bottom,
      ) ?? null;
  }

  private citationAt(event: PointerEvent) {
    const host = (event.currentTarget as HTMLElement).closest<HTMLElement>('.pdfjs-page');
    const page = Number(host?.dataset.pageIndex);
    if (!host || !Number.isInteger(page)) return null;
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const citation =
      [...this.citations]
        .reverse()
        .find(
          candidate =>
            candidate.page === page &&
            x >= candidate.bounds.left &&
            x <= candidate.bounds.right &&
            y >= candidate.bounds.top &&
            y <= candidate.bounds.bottom,
        ) ?? null;
    return {
      citation,
      rect: citation ? viewportRectForBounds(host, [citation.bounds]) : undefined,
    };
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.selectionDrag) return;
    const citationHit = this.citationAt(event);
    if (citationHit?.citation) {
      this.citationPoint = { x: event.clientX, y: event.clientY };
      this.linkHoverListener?.(null);
      this.citationHoverListener?.(
        citationHit.citation,
        citationHit.rect,
      );
      return;
    }
    // Chromium repeats the last pointer position after the layers re-render (while the
    // citations are being replaced by a newer analysis): only real movement ends a hover.
    const still =
      this.citationPoint &&
      Math.abs(event.clientX - this.citationPoint.x) < 0.5 &&
      Math.abs(event.clientY - this.citationPoint.y) < 0.5;
    if (still) return;
    this.citationPoint = null;
    this.citationHoverListener?.(null);
    const link = this.linkAt(event);
    this.linkHoverListener?.(
      link,
      link
        ? viewportRectForBounds(
            (event.currentTarget as HTMLElement).closest<HTMLElement>('.pdfjs-page')!,
            [link.bounds],
          )
        : undefined,
    );
  };

  private readonly onPointerLeave = (event: PointerEvent) => {
    if (this.selectionDrag) return;
    // Re-rendering the text or overlay layers under a still pointer makes Chromium report a
    // leave although the pointer never left the page: not a hover ending.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under && (event.currentTarget as HTMLElement).contains(under)) return;
    this.linkHoverListener?.(null);
    this.citationHoverListener?.(null);
  };
}

interface SelectableRun {
  start: number;
  end: number;
  text: string;
  bounds: NativeBounds;
}

function selectableRuns(text: NativeTextPage): SelectableRun[] {
  const output: SelectableRun[] = [];
  let current: SelectableRun | null = null;
  for (let index = 0; index < text.characters.length; index += 1) {
    const character = text.characters[index];
    const bounds = character.bounds;
    if (!bounds || character.value === '\n' || character.value === '\r') {
      if (current) output.push(current);
      current = null;
      continue;
    }
    const height = bounds.bottom - bounds.top;
    const currentHeight = current
      ? current.bounds.bottom - current.bounds.top
      : height;
    const sameLine =
      current &&
      Math.abs(current.bounds.top - bounds.top) <= Math.max(height, currentHeight) * 0.5 &&
      bounds.left <=
        current.bounds.right + Math.max(0.012, (bounds.right - bounds.left) * 3.2) &&
      bounds.left >= current.bounds.left - 0.01;
    if (!current || !sameLine) {
      if (current) output.push(current);
      current = {
        start: index,
        end: index,
        text: character.value,
        bounds: { ...bounds },
      };
      continue;
    }
    current.end = index;
    current.text += character.value;
    current.bounds.left = Math.min(current.bounds.left, bounds.left);
    current.bounds.top = Math.min(current.bounds.top, bounds.top);
    current.bounds.right = Math.max(current.bounds.right, bounds.right);
    current.bounds.bottom = Math.max(current.bounds.bottom, bounds.bottom);
  }
  if (current) output.push(current);
  return output;
}
