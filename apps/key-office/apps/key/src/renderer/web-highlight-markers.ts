// The saved web page reader's margin markers: a slim faded bar in each highlight's colour
// beside it, drawn into the page's own document so it scrolls with the text. A click opens
// the highlight's info card. Redrawn when the highlights change or the page reflows.
const BAR = "key-hl-bar";
const STYLE = "key-hl-bar-style";

const style = (rgb: Record<string, string>) =>
  `.${BAR}{position:absolute;z-index:2147483646;box-sizing:content-box;width:3px;padding:0 3px;margin:0;border-radius:3px;` +
  `background:rgb(var(--key-hl) / .5);background-clip:content-box;opacity:.75;cursor:pointer;transition:opacity .12s,background-color .12s}` +
  `.${BAR}:hover{opacity:1;background-color:rgb(var(--key-hl) / .95)}` +
  Object.entries(rgb).map(([c, v]) => `.${BAR}[data-color="${c}"]{--key-hl:${v}}`).join("");

/** Draws the bars for every `mark.<markClass>` in `doc`; answers a function that removes them. */
export function drawHighlightMarkers(doc: Document, markClass: string, rgb: Record<string, string>, onOpen: (id: string, rect: DOMRect) => void) {
  if (!doc.getElementById(STYLE)) {
    const el = doc.createElement("style");
    el.id = STYLE;
    el.textContent = style(rgb);
    doc.head.append(el);
  }
  const root = doc.documentElement;
  let frame = 0;
  const draw = () => {
    frame = 0;
    root.querySelectorAll(`:scope > .${BAR}`).forEach((bar) => bar.remove());
    const view = doc.defaultView;
    const x = view?.scrollX ?? 0;
    const y = view?.scrollY ?? 0;
    const boxes = new Map<string, { left: number; top: number; bottom: number; color: string }>();
    for (const mark of doc.querySelectorAll<HTMLElement>(`mark.${markClass}[data-annotation]`)) {
      const id = mark.dataset.annotation!;
      for (const rect of mark.getClientRects()) {
        if (!rect.width && !rect.height) continue;
        const box = boxes.get(id);
        if (!box) boxes.set(id, { left: rect.left, top: rect.top, bottom: rect.bottom, color: mark.dataset.color ?? "orange" });
        else Object.assign(box, { left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top), bottom: Math.max(box.bottom, rect.bottom) });
      }
    }
    for (const [id, box] of boxes) {
      const bar = doc.createElement("div");
      bar.className = BAR;
      bar.dataset.annotation = id;
      bar.dataset.color = box.color;
      bar.title = "Highlight";
      bar.style.left = `${Math.max(2, box.left + x - 12)}px`;
      bar.style.top = `${box.top + y}px`;
      bar.style.height = `${Math.max(4, box.bottom - box.top)}px`;
      bar.addEventListener("mousedown", (e) => e.preventDefault());
      bar.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const first = doc.querySelector<HTMLElement>(`mark.${markClass}[data-annotation="${CSS.escape(id)}"]`);
        onOpen(id, (first ?? bar).getBoundingClientRect());
      });
      root.append(bar);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  draw();
  const observer = new ((doc.defaultView as (Window & typeof globalThis) | null)?.ResizeObserver ?? ResizeObserver)(schedule);
  observer.observe(doc.body);
  doc.defaultView?.addEventListener("resize", schedule);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    doc.defaultView?.removeEventListener("resize", schedule);
    root.querySelectorAll(`:scope > .${BAR}`).forEach((bar) => bar.remove());
  };
}

/** Where a rectangle in the page's frame stands: in view, or scrolled out of it. */
export const inFrameView = (doc: Document, rect: DOMRect) => {
  const height = doc.defaultView?.innerHeight ?? doc.documentElement.clientHeight;
  const width = doc.defaultView?.innerWidth ?? doc.documentElement.clientWidth;
  return rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width && (rect.width > 0 || rect.height > 0);
};
