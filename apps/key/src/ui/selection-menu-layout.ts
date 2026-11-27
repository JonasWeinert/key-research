// The selection menu's pure parts: where it goes beside its passage, which keys it answers, what
// a typed filter keeps and how focus moves. SelectionMenu.tsx renders; this decides.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Below the passage, or above it when there is no room below. */
  side: 'below' | 'above';
  /** The menu's height may not pass this (it scrolls inside). */
  maxHeight: number;
  maxWidth: number;
}

const right = (b: Box) => b.left + b.width;
const bottom = (b: Box) => b.top + b.height;

/** Where a menu of `size` goes for a passage at `anchor`, inside `area` (the reader's own box,
 * so it stays beside a sidebar): below the passage when it fits, else above, else on the side
 * with more room, shortened to fit; shifted sideways to stay inside; never wider than the area. */
export function placeMenu(anchor: Box, size: { width: number; height: number }, area: Box, options: { gap?: number; margin?: number; maxWidth?: number } = {}): Placement {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const maxWidth = Math.max(120, Math.min(options.maxWidth ?? 420, area.width - margin * 2));
  const width = Math.min(size.width, maxWidth);
  const below = bottom(area) - margin - (bottom(anchor) + gap);
  const above = anchor.top - gap - (area.top + margin);
  let side: Placement['side'];
  if (size.height <= below) side = 'below';
  else if (size.height <= above) side = 'above';
  else side = below >= above ? 'below' : 'above';
  const room = Math.max(80, side === 'below' ? below : above);
  const height = Math.min(size.height, room);
  let top = side === 'below' ? bottom(anchor) + gap : anchor.top - gap - height;
  // A passage scrolled partly out of the area: keep the menu inside it all the same.
  top = Math.max(area.top + margin, Math.min(top, bottom(area) - margin - height));
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(area.left + margin, Math.min(centre - width / 2, right(area) - margin - width));
  return { left: Math.round(left), top: Math.round(top), side, maxHeight: Math.floor(room), maxWidth: Math.floor(maxWidth) };
}

/** The area a menu may use: the reader's box cut to the window. */
export function clipArea(reader: Box | null | undefined, viewport: { width: number; height: number }): Box {
  const v = { left: 0, top: 0, width: viewport.width, height: viewport.height };
  if (!reader || reader.width <= 0 || reader.height <= 0) return v;
  const left = Math.max(v.left, reader.left);
  const top = Math.max(v.top, reader.top);
  return { left, top, width: Math.max(0, Math.min(right(v), right(reader)) - left), height: Math.max(0, Math.min(bottom(v), bottom(reader)) - top) };
}

export interface KeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** A host's key as written ("3", "shift+3", "enter", "e") → what it matches. */
export function parseKey(spec: string): { key: string; shift: boolean } {
  const parts = spec.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  const shift = parts.includes('shift');
  return { key: parts.filter(p => p !== 'shift')[0] ?? '', shift };
}

/** Does the key press match the spec? Digits by their key code too, so Shift+3 is still "3". */
export function keyMatches(event: KeyLike, spec: string | undefined): boolean {
  if (!spec || event.metaKey || event.ctrlKey || event.altKey) return false;
  const { key, shift } = parseKey(spec);
  if (!key || !!event.shiftKey !== shift) return false;
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}` || event.code === `Numpad${key}` || (!event.code && event.key === key) || (!shift && event.key === key);
  return event.key.toLowerCase() === key;
}

/** How a key is shown on its cap: "3", "⇧3", "↩". */
export function keyLabel(spec: string): string {
  const { key, shift } = parseKey(spec);
  const names: Record<string, string> = { enter: '↩', escape: 'esc', esc: 'esc', tab: '⇥', space: '␣' };
  const cap = names[key] ?? key.toUpperCase();
  return `${shift ? '⇧' : ''}${cap}`;
}

/** The actions a typed filter keeps: every word somewhere in the label, detail, group or keywords. */
export function filterItems<T extends { label: string; detail?: string; group?: string; keywords?: string }>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter(item => {
    const hay = `${item.label} ${item.detail ?? ''} ${item.group ?? ''} ${item.keywords ?? ''}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

/** The next focus index: arrows move and wrap, Home/End jump. */
export function moveIndex(current: number, count: number, key: string): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const back = key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ShiftTab';
  if (current < 0) return back ? count - 1 : 0;
  return (current + (back ? -1 : 1) + count) % count;
}

/** True when two boxes overlap by more than a hair (the smokes' and tests' check). */
export function intersects(a: Box, b: Box, tolerance = 0.5): boolean {
  return a.left + tolerance < right(b) && b.left + tolerance < right(a) && a.top + tolerance < bottom(b) && b.top + tolerance < bottom(a);
}

/** Groups in order of first appearance (criteria by PICO part, fields by form section). */
export function grouped<T extends { group?: string }>(items: T[]): Array<{ group: string; items: T[] }> {
  const out: Array<{ group: string; items: T[] }> = [];
  for (const item of items) {
    const g = item.group ?? '';
    const last = out.find(x => x.group === g);
    if (last) last.items.push(item);
    else out.push({ group: g, items: [item] });
  }
  return out;
}
