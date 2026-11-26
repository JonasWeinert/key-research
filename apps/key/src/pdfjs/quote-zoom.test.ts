import { describe, expect, it } from 'vitest';
import { locateQuote } from './quote-locate';
import { quoteZoom, zoomTransitionFrame } from './quote-zoom';

const viewport = { width: 1000, height: 800 };

describe('quoteZoom', () => {
  it('keeps the zoom when the quote fits at a readable size', () => {
    expect(quoteZoom({ viewport, rect: { width: 500, height: 80 }, zoom: 1, pageScale: 1.5 })).toBe(1);
  });
  it('zooms out only as far as needed when the quote does not fit', () => {
    const zoom = quoteZoom({ viewport, rect: { width: 600, height: 880 }, zoom: 1.5, pageScale: 2 });
    expect(zoom).toBeCloseTo((1.5 * 800 * 0.55) / 880, 5);
    expect(zoom).toBeLessThan(1.5);
  });
  it('zooms in small text up to a readable size, no further than the fit', () => {
    // Drawn at 0.6 px/pt: reading needs ×2.08; the fit allows ×(720/300)=2.4.
    const zoom = quoteZoom({ viewport, rect: { width: 300, height: 40 }, zoom: 0.5, pageScale: 0.6 });
    expect(zoom).toBeCloseTo(0.5 * (1.25 / 0.6), 5);
    // A wide line: the fit (×1.2) limits the zoom-in before reading does.
    const wide = quoteZoom({ viewport, rect: { width: 600, height: 40 }, zoom: 0.5, pageScale: 0.6 });
    expect(wide).toBeCloseTo(0.5 * 1.2, 5);
  });
  it('caps zooming in at maxZoom but never zooms out a zoom the user chose', () => {
    expect(quoteZoom({ viewport, rect: { width: 20, height: 10 }, zoom: 1, pageScale: 0.2, maxZoom: 2.5 })).toBe(2.5);
    expect(quoteZoom({ viewport, rect: { width: 100, height: 20 }, zoom: 4, pageScale: 6, maxZoom: 2.5 })).toBe(4);
  });
  it('ignores changes too small to notice', () => {
    expect(quoteZoom({ viewport, rect: { width: 740, height: 100 }, zoom: 1, pageScale: 1.5 })).toBe(1);
  });
});

describe('zoomTransitionFrame', () => {
  const anchor = { content: { x: 400, y: 1200 }, start: { x: 100, y: 600 }, end: { x: 500, y: 400 } };
  const scroll = { x: 0, y: 800 };
  it('starts where the quote was, at the old scale', () => {
    const frame = zoomTransitionFrame(0, anchor, scroll, 1, 2);
    expect(frame.scale).toBe(0.5);
    expect(anchor.content.x * frame.scale + frame.translateX - scroll.x).toBeCloseTo(100);
    expect(anchor.content.y * frame.scale + frame.translateY - scroll.y).toBeCloseTo(600);
  });
  it('ends exactly on the final layout', () => {
    const frame = zoomTransitionFrame(1, anchor, scroll, 1, 2);
    expect(frame.scale).toBe(1);
    expect(anchor.content.x + frame.translateX - scroll.x).toBeCloseTo(500);
    expect(anchor.content.y + frame.translateY - scroll.y).toBeCloseTo(400);
  });
});

describe('locateQuote', () => {
  const page = (text: string) => ({
    page: 3,
    text,
    characters: [...text].map(value => ({ value, bounds: { left: 0, top: 0, right: 0.01, bottom: 0.01 } })),
  });
  it('finds a quote despite different line breaks, hyphenation and spacing', () => {
    const text = 'Intro. The algo-\nrithm guided  novices to acquire images. Next sentence.';
    const range = locateQuote(page(text), 'the algorithm guided novices to acquire images');
    expect(range).not.toBeNull();
    expect(text.slice(range!.start.index, range!.end.index + 1)).toBe('The algo-\nrithm guided  novices to acquire images');
    expect(range!.start.page).toBe(3);
  });
  it('anchors a lightly edited quote by its opening and close', () => {
    const text = 'Before. Five level three trained echocardiographers independently and blindly evaluated each acquisition of the study. After.';
    const quote = 'Five level three trained echocardiographers [independently] and blindly evaluated each acquisition of the study';
    const range = locateQuote(page(text), quote.replace('[independently]', 'separately'));
    expect(text.slice(range!.start.index, range!.end.index + 1)).toBe(
      'Five level three trained echocardiographers independently and blindly evaluated each acquisition of the study',
    );
  });
  it('returns null when the page does not have it', () => {
    expect(locateQuote(page('Nothing relevant here at all.'), 'a completely different passage')).toBeNull();
  });
});
