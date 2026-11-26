// The tag manager's view of the analysis the host runs (key-store `tag_analysis.rs`, the
// `store_tag_suggestions` and `store_tag_plan` commands): the shapes it answers, and the few
// text helpers the manager's forms use for their default values.
import type { PlannedChange } from "./tag-plan";

export interface TagCount {
  name: string;
  count: number;
}
export interface TagItem {
  id: string;
  title: string;
  year?: number | null;
  /** Indexes into `tags`. */
  tags: number[];
}
export interface TagMeta {
  parent?: string | null;
  color?: string | null;
}
export interface TagIndex {
  tags: TagCount[];
  items: TagItem[];
  sourceCount: number;
  tree: Record<string, TagMeta>;
}
export interface PropertyInfo {
  name: string;
  type: string;
  options?: string[];
}

export type SuggestionKind = "merge" | "nest" | "hierarchy" | "property" | "cleanup";

export type TagPlan =
  | { type: "merge"; from: string[]; to: string }
  | { type: "nest"; parent: string; children: string[] }
  | { type: "hierarchy"; splits: { tag: string; path: string[] }[] }
  | { type: "property"; name: string; propertyType: "boolean" | "select"; values: [string, string | boolean][]; removeTags: boolean }
  | { type: "delete"; tags: string[] };

export interface Suggestion {
  /** Stable across runs for the same tags, so a dismissal sticks. */
  id: string;
  kind: SuggestionKind;
  title: string;
  evidence: string;
  /** 0–1. */
  confidence: number;
  tags: string[];
  /** Sources the change touches. */
  items: number;
  plan: TagPlan;
  /** What applying it does now; absent when it no longer applies. */
  change?: PlannedChange;
}

const PREFIX = /^[_#!@*+~.\-\s]+/;

/** Diacritics off, lower case: how tag names are compared. */
export function fold(text: string) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

/** The path a tag name spells out, if any ("methods/survey" → ["methods", "survey"]). */
export function splitPath(tag: string): string[] | undefined {
  if (/^https?:|^10\.\d{4,}\//i.test(tag)) return undefined;
  for (const pattern of [/\s*::\s*/, /\s*\/\s*/, /\s*>\s*/, /\s+[-–—]\s+/, /\s*:\s*/]) {
    const parts = tag.split(pattern).map((p) => p.trim());
    if (parts.length > 1 && parts.length <= 4 && parts.every((p) => p.length > 0 && p.length <= 48 && /\p{L}/u.test(p))) return parts;
  }
  return undefined;
}

/** A value as the property shows it: the tag's own words, the delimiter prefix off. */
export function valueLabel(tag: string, prefix?: string) {
  let text = tag.replace(PREFIX, "").trim();
  if (prefix) {
    const path = splitPath(text);
    if (path && path.length > 1 && fold(path[0]) === fold(prefix)) text = path.slice(1).join(" ");
  }
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : tag;
}
