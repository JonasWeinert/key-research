// The tag manager's view of the analysis the host runs (key-store `tag_analysis.rs`, the
// `store_tag_suggestions`, `store_tag_plan` and `store_tag_convert_defaults` commands): the
// shapes it answers, and how the manager compares names in its own tree.
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

/** Diacritics off, lower case: how tag names are compared. */
export function fold(text: string) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

