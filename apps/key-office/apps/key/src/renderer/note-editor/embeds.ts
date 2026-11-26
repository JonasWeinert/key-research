// What the app plugs into the editor's embeds, kept apart from the editor so the shell can
// set them without loading the editor (the editor itself is loaded on first use).
import { createContext, type ReactNode } from "react";
import type { ItemLink, SourceRef } from "./types";

/** An embed's own view of its item: a relation map with the options it was saved with. */
export interface EmbedView {
  view: string;
  kinds?: string[];
  cap?: number;
  minCount?: number;
  editable: boolean;
  /** Keeps changed options (and the Markdown fallback line) in the note. */
  update(attrs: { kinds?: string[]; cap?: number; minCount?: number; label?: string }): void;
}
/** How an embedded item shows (set by the app); `depth` counts embeds within embeds. */
export type EmbedRenderer = (item: ItemLink, depth: number, label: string, view?: EmbedView) => ReactNode;
let embedRenderer: EmbedRenderer | null = null;
export function setEmbedRenderer(render: EmbedRenderer) {
  embedRenderer = render;
}
export const getEmbedRenderer = () => embedRenderer;
/** Where the "Relation map" block finds what to centre on, when the editor's props don't say. */
let mapCenterSearch: ((query: string) => Promise<SourceRef[]>) | null = null;
export function setMapCenterSearch(search: (query: string) => Promise<SourceRef[]>) {
  mapCenterSearch = search;
}
export const defaultMapCenterSearch = (query: string) => mapCenterSearch?.(query) ?? Promise.resolve([]);
/** How deep the embed being drawn is: a note embedded in a note that embeds it stops there. */
export const EmbedDepth = createContext(0);
