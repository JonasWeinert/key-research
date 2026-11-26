import type { SVGProps } from 'react';
import { Glyph } from './Glyph';
import type { GlyphName } from './glyphs';

// The reader's names for Key's shared icon set (ui/glyphs.ts).
const names = {
  add: 'plus',
  close: 'close',
  document: 'doc',
  search: 'search',
  sidebar: 'sidebar',
  split: 'split',
  previous: 'chevronLeft',
  next: 'chevronRight',
  zoom_out: 'zoomOut',
  zoom_in: 'zoomIn',
  fit_width: 'fitWidth',
  comments: 'comment',
  book: 'book',
  highlight: 'highlight',
  note: 'note',
  copy: 'copy',
  delete: 'trash',
  more: 'more',
  check: 'check',
  panel_left: 'sidebar',
  expand: 'expand',
  collapse: 'collapse',
  quote: 'quote',
  external: 'external',
  retry: 'retry',
} as const satisfies Record<string, GlyphName>;

export type IconName = keyof typeof names;

export function Icon({
  name,
  size = 16,
  filled,
  ...props
}: { name: IconName; size?: number; filled?: boolean } & SVGProps<SVGSVGElement>) {
  return <Glyph name={names[name]} size={size} filled={filled} {...props} />;
}
