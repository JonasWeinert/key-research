// Shell icons: Key's own set (paths as data in @key-reader/ui/glyphs, shared with the reader).
import type { SVGProps } from "react";
import { Glyph } from "@key-reader/ui/Glyph";
import { glyphs, type GlyphName } from "@key-reader/ui/glyphs";

export type IconName = GlyphName;
/** For icon names that arrive as data (status bar items from views). */
export const isIconName = (name: unknown): name is IconName => typeof name === "string" && Object.hasOwn(glyphs, name);

/** A property type's badge. */
export const propertyTypeIcon = (type?: string): IconName =>
  type === "number" ? "hash" : type === "boolean" ? "check" : type === "select" ? "list" : type === "formula" ? "function" : "text";

export function Icon({ name, size = 16, ...rest }: SVGProps<SVGSVGElement> & { name: IconName; size?: number; filled?: boolean }) {
  // The reader resolves its own @types/react; the props are the same at runtime.
  return <Glyph name={name} size={size} {...(rest as object)} />;
}
