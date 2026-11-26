// Zooming to a quote: the zoom at which a passage sits comfortably in the viewport, and the
// in-between frames of the move there.

export interface QuoteZoomInput {
  /** The visible reading area, CSS px. */
  viewport: { width: number; height: number };
  /** The quote's bounding box at the current zoom, CSS px. */
  rect: { width: number; height: number };
  zoom: number;
  /** CSS px per PDF point at the current zoom (how large the text is drawn). */
  pageScale: number;
  minZoom?: number;
  /** Never zoom in past this to reach a quote. */
  maxZoom?: number;
}

/** Share of the viewport a quote may fill. */
export const QUOTE_FILL = { width: 0.72, height: 0.55 };
/** 12 pt body text drawn at about 15 px reads comfortably. */
export const READABLE_SCALE = 1.25;

/**
 * Keeps the current zoom when the quote already fits at a readable size; zooms out only when
 * it does not fit, and in (up to `maxZoom`) only as far as reading needs and the fit allows.
 */
export function quoteZoom({
  viewport,
  rect,
  zoom,
  pageScale,
  minZoom = 0.2,
  maxZoom = 2.5,
}: QuoteZoomInput): number {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const fit = Math.min(
    (viewport.width * QUOTE_FILL.width) / width,
    (viewport.height * QUOTE_FILL.height) / height,
  );
  let target = zoom;
  if (fit < 1) {
    target = zoom * fit;
  } else {
    const readable = READABLE_SCALE / Math.max(0.01, pageScale);
    if (readable > 1) target = Math.min(zoom * Math.min(readable, fit), Math.max(zoom, maxZoom));
  }
  target = Math.max(minZoom, target);
  return Math.abs(target / zoom - 1) < 0.04 ? zoom : target;
}

/**
 * Where something at `start` should be drawn at progress `t`, moving to `end`, while the
 * drawing scale goes from `fromZoom` to `toZoom`: the transform (origin top-left) to apply to
 * content already laid out at `toZoom`, so the move animates without re-rendering.
 */
export function zoomTransitionFrame(
  t: number,
  anchor: { content: { x: number; y: number }; start: { x: number; y: number }; end: { x: number; y: number } },
  scroll: { x: number; y: number },
  fromZoom: number,
  toZoom: number,
) {
  const eased = easeOutCubic(Math.min(1, Math.max(0, t)));
  const scale = (fromZoom + (toZoom - fromZoom) * eased) / toZoom;
  const x = anchor.start.x + (anchor.end.x - anchor.start.x) * eased;
  const y = anchor.start.y + (anchor.end.y - anchor.start.y) * eased;
  // screen = content * scale + translate - scroll
  return {
    scale,
    translateX: x + scroll.x - anchor.content.x * scale,
    translateY: y + scroll.y - anchor.content.y * scale,
  };
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
