import { describe, expect, it } from 'vitest';
import { clipArea, filterItems, grouped, intersects, keyLabel, keyMatches, moveIndex, placeMenu, type Box } from './selection-menu-layout';

const area: Box = { left: 0, top: 0, width: 800, height: 600 };
const inside = (p: { left: number; top: number }, size: { width: number; height: number }, a: Box) =>
  p.left >= a.left && p.top >= a.top && p.left + size.width <= a.left + a.width && p.top + size.height <= a.top + a.height;

describe('placeMenu', () => {
  it('goes below the passage, centred, when there is room', () => {
    const p = placeMenu({ left: 300, top: 100, width: 200, height: 20 }, { width: 300, height: 120 }, area);
    expect(p.side).toBe('below');
    expect(p.top).toBe(128);
    expect(p.left).toBe(250);
  });
  it('flips above when the passage is near the bottom', () => {
    const p = placeMenu({ left: 300, top: 540, width: 200, height: 20 }, { width: 300, height: 120 }, area);
    expect(p.side).toBe('above');
    expect(p.top + 120).toBeLessThanOrEqual(540 - 8);
  });
  it('shifts sideways to stay inside a narrow reader beside a sidebar', () => {
    for (const width of [300, 380, 520]) {
      const reader: Box = { left: 0, top: 40, width, height: 700 };
      for (const left of [0, width / 2, width - 10]) {
        const size = { width: 340, height: 200 };
        const p = placeMenu({ left, top: 300, width: 10, height: 16 }, size, reader, { maxWidth: 380 });
        const w = Math.min(size.width, p.maxWidth);
        expect(inside(p, { width: w, height: Math.min(size.height, p.maxHeight) }, reader)).toBe(true);
        expect(p.maxWidth).toBeLessThanOrEqual(width - 16);
      }
    }
  });
  it('shortens a tall menu to the larger side and keeps it inside', () => {
    const p = placeMenu({ left: 100, top: 290, width: 50, height: 20 }, { width: 300, height: 900 }, area);
    expect(p.maxHeight).toBeLessThan(600);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + Math.min(900, p.maxHeight)).toBeLessThanOrEqual(592);
  });
  it('stays inside when the passage scrolled partly out of view', () => {
    const p = placeMenu({ left: 100, top: -200, width: 50, height: 20 }, { width: 200, height: 100 }, area);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it('never overlaps the passage when it fits on either side', () => {
    const anchor = { left: 200, top: 250, width: 300, height: 40 };
    for (const height of [60, 200, 240]) {
      const p = placeMenu(anchor, { width: 300, height }, area);
      expect(intersects({ left: p.left, top: p.top, width: 300, height }, anchor)).toBe(false);
    }
  });
});

describe('clipArea', () => {
  it('cuts the reader to the window', () => {
    expect(clipArea({ left: -20, top: 30, width: 500, height: 2000 }, { width: 400, height: 700 })).toEqual({ left: 0, top: 30, width: 400, height: 670 });
    expect(clipArea(null, { width: 400, height: 700 })).toEqual({ left: 0, top: 0, width: 400, height: 700 });
  });
});

describe('keys', () => {
  it('matches digits with and without Shift by their code', () => {
    expect(keyMatches({ key: '3', code: 'Digit3' }, '3')).toBe(true);
    expect(keyMatches({ key: '#', code: 'Digit3', shiftKey: true }, 'shift+3')).toBe(true);
    expect(keyMatches({ key: '#', code: 'Digit3', shiftKey: true }, '3')).toBe(false);
    expect(keyMatches({ key: '3', code: 'Digit3' }, 'shift+3')).toBe(false);
    expect(keyMatches({ key: '3', code: 'Digit3', metaKey: true }, '3')).toBe(false);
    expect(keyMatches({ key: 'Enter' }, 'enter')).toBe(true);
    expect(keyMatches({ key: 'n' }, 'n')).toBe(true);
    expect(keyMatches({ key: 'n' }, undefined)).toBe(false);
  });
  it('shows keys on caps', () => {
    expect(keyLabel('3')).toBe('3');
    expect(keyLabel('shift+3')).toBe('⇧3');
    expect(keyLabel('enter')).toBe('↩');
    expect(keyLabel('escape')).toBe('esc');
  });
  it('moves focus with wrapping', () => {
    expect(moveIndex(-1, 4, 'ArrowDown')).toBe(0);
    expect(moveIndex(-1, 4, 'ArrowUp')).toBe(3);
    expect(moveIndex(3, 4, 'ArrowDown')).toBe(0);
    expect(moveIndex(0, 4, 'ShiftTab')).toBe(3);
    expect(moveIndex(2, 4, 'Home')).toBe(0);
    expect(moveIndex(1, 4, 'End')).toBe(3);
    expect(moveIndex(0, 0, 'ArrowDown')).toBe(-1);
  });
});

describe('filter and groups', () => {
  const items = [
    { label: 'Adults aged 18 or over', group: 'Population' },
    { label: 'Randomised trial', group: 'Study design', keywords: 'RCT' },
    { label: 'Exercise programme', group: 'Intervention' },
    { label: 'Children', group: 'Population' },
  ];
  it('keeps what every typed word matches', () => {
    expect(filterItems(items, 'rct').map(i => i.label)).toEqual(['Randomised trial']);
    expect(filterItems(items, 'pop ad').map(i => i.label)).toEqual(['Adults aged 18 or over']);
    expect(filterItems(items, '')).toHaveLength(4);
  });
  it('groups in order of first appearance', () => {
    expect(grouped(items).map(g => [g.group, g.items.length])).toEqual([
      ['Population', 2],
      ['Study design', 1],
      ['Intervention', 1],
    ]);
  });
});
