import type { SVGProps } from 'react';
import { glyphs, type Glyph as GlyphData, type GlyphName } from './glyphs';

export type GlyphProps = SVGProps<SVGSVGElement> & {
  name: GlyphName;
  size?: number;
  /** The filled variant, for selected or active states (falls back to the outline). */
  filled?: boolean;
};

/** Stroke in grid units: 1.4 at 16px, a little heavier when small and lighter when large so
 * the drawn weight stays close to 13px system text. */
export const glyphStroke = (size: number) => Math.min(2, Math.max(1.05, 1.4 * Math.sqrt(16 / size)));

export function Glyph({ name, size = 16, filled, strokeWidth, ...rest }: GlyphProps) {
  const base: GlyphData = glyphs[name];
  const g = (filled && base.on) || base;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? glyphStroke(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {g.f && <path d={g.f} fill="currentColor" fillRule="evenodd" stroke="none" />}
      {g.s && <path d={g.s} />}
    </svg>
  );
}
