// The tag tree the manager shows (tags plus their parents and colours from the store's tag
// tree), and plans as the host turns them into one store operation (`store_tag_plan`, then
// `store_tag_apply`), with a preview of exactly what will change.
import type { Invoke } from "./library-api";
import { fold, type TagIndex, type TagMeta, type TagPlan } from "./tag-analysis";

export interface TagNode {
  name: string;
  /** Items carrying the tag itself. */
  count: number;
  /** Items carrying it or any tag under it. */
  total: number;
  parent?: string;
  color?: string;
  children: TagNode[];
  /** Only in the tree: a heading for other tags, on no item itself. */
  group: boolean;
  depth: number;
}

export interface TagTree {
  roots: TagNode[];
  /** By folded name. */
  nodes: Map<string, TagNode>;
}

const key = (name: string) => fold(name.trim());

export function buildTree(index: TagIndex): TagTree {
  const nodes = new Map<string, TagNode>();
  const add = (name: string, count: number, group: boolean) => {
    const k = key(name);
    const old = nodes.get(k);
    if (old) {
      old.count += count;
      old.group = old.group && group;
      return old;
    }
    const node: TagNode = { name, count, total: 0, children: [], group, depth: 0 };
    nodes.set(k, node);
    return node;
  };
  index.tags.forEach((t) => add(t.name, t.count, false));
  for (const [name, meta] of Object.entries(index.tree ?? {})) {
    const node = add(name, 0, true);
    if (meta?.color) node.color = meta.color;
    if (meta?.parent) add(meta.parent, 0, true);
  }
  for (const [name, meta] of Object.entries(index.tree ?? {})) {
    const node = nodes.get(key(name))!;
    const parent = meta?.parent ? nodes.get(key(meta.parent)) : undefined;
    if (!parent || parent === node) continue;
    // A parent chain that comes back to this tag would loop: it stays at the top.
    let up: TagNode | undefined = parent,
      loops = false;
    for (let guard = 0; up && guard < 64; guard++) {
      if (up === node) loops = true;
      up = up.parent ? nodes.get(key(up.parent)) : undefined;
    }
    if (!loops) node.parent = parent.name;
  }
  const roots: TagNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(key(node.parent)) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  // Totals: each item counted once per ancestor.
  const byIndex = index.tags.map((t) => nodes.get(key(t.name))!);
  const totals = new Map<TagNode, number>();
  for (const item of index.items) {
    const seen = new Set<TagNode>();
    for (const t of item.tags) {
      let node: TagNode | undefined = byIndex[t];
      for (let guard = 0; node && guard < 64 && !seen.has(node); guard++) {
        seen.add(node);
        node = node.parent ? nodes.get(key(node.parent)) : undefined;
      }
    }
    seen.forEach((node) => totals.set(node, (totals.get(node) ?? 0) + 1));
  }
  const walk = (list: TagNode[], depth: number) => {
    for (const node of list) {
      node.depth = depth;
      node.total = totals.get(node) ?? node.count;
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return { roots, nodes };
}

export type TagSort = "name" | "count";
// One collator for every comparison: `localeCompare` with options builds one per call,
// which on thousands of tags costs more than the rest of the tree.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
export function sortTree(list: TagNode[], sort: TagSort): TagNode[] {
  const sorted = [...list].sort((a, b) => (sort === "count" ? b.total - a.total : 0) || collator.compare(a.name, b.name));
  return sorted.map((node) => ({ ...node, children: sortTree(node.children, sort) }));
}

/** The rows a tree shows: expanded branches, or every match (with its ancestors) when filtering. */
export function visibleRows(roots: TagNode[], expanded: Set<string>, query: string): TagNode[] {
  const rows: TagNode[] = [];
  const q = fold(query.trim());
  const matches = (node: TagNode): boolean => fold(node.name).includes(q) || node.children.some(matches);
  const walk = (list: TagNode[]) => {
    for (const node of list) {
      if (q && !matches(node)) continue;
      rows.push(node);
      if (q || expanded.has(key(node.name))) walk(node.children);
    }
  };
  walk(roots);
  return rows;
}

export function ancestors(tree: TagTree, name: string): string[] {
  const out: string[] = [];
  let node = tree.nodes.get(key(name));
  for (let guard = 0; node?.parent && guard < 64; guard++) {
    out.push(node.parent);
    node = tree.nodes.get(key(node.parent));
  }
  return out;
}

// ── Plans to operations (key-store `tag_plan.rs`) ──────────────────────────────

export interface TagOperation {
  replace: { from: string; to: string[] }[];
  tree: Record<string, TagMeta | null>;
  property?: { name: string; config: Record<string, unknown>; values: [string, string | boolean][]; removeTags: boolean } | null;
}

export interface PlannedChange {
  operation: TagOperation;
  /** "Merge 3 tags into “Machine learning”". */
  label: string;
  /** One line per change, for the preview. */
  lines: { before: string; after: string; detail?: string }[];
  /** Sources whose tags or properties change. */
  items: number;
  /** For a select property: items holding more than one of its tags. */
  multiple?: number;
}

export type ManagerPlan =
  | Exclude<TagPlan, { type: "nest" }>
  | { type: "nest"; parent: string; children: string[]; renameParent?: string }
  | { type: "rename"; tag: string; to: string }
  | { type: "unnest"; tags: string[] }
  | { type: "color"; tags: string[]; color: string | null };

/** The plan against the tags as they are now. Rejects with the reason when it cannot apply. */
export function planChange(invoke: Invoke, workspaceId: string, plan: ManagerPlan): Promise<PlannedChange> {
  return invoke<PlannedChange>("store_tag_plan", { plan }, workspaceId);
}

/** `store_tag_apply_many` with `withIndex`: the whole index when items changed, else the tree. */
export interface ApplyResult {
  affected: number;
  index?: TagIndex;
  tree?: Record<string, TagMeta>;
}

/** The index as it will look once the host has applied `operations`, so the tree can move
 *  at once; the host's answer replaces it. Display only: renames and removals carry over
 *  to items, tree entries are set or cleared, and the rest waits for the host. */
export function applyLocally(index: TagIndex, operations: TagOperation[]): TagIndex {
  let { tags, items } = index;
  const tree = { ...(index.tree ?? {}) };
  for (const op of operations) {
    for (const [name, meta] of Object.entries(op.tree)) {
      if (meta) tree[name] = meta;
      else delete tree[name];
    }
    const to = new Map(op.replace.map((r) => [key(r.from), r.to]));
    if (op.property?.removeTags) op.property.values.forEach(([t]) => to.set(key(t), []));
    if (!to.size) continue;
    const at = new Map<string, number>();
    const next: { name: string; count: number }[] = [];
    const remap = tags.map((t) =>
      (to.get(key(t.name)) ?? [t.name]).map((name) => {
        let i = at.get(key(name));
        if (i === undefined) {
          i = next.length;
          at.set(key(name), i);
          next.push({ name, count: 0 });
        }
        return i;
      }),
    );
    items = items.map((item) => ({ ...item, tags: [...new Set(item.tags.flatMap((t) => remap[t] ?? []))] }));
    items.forEach((item) => item.tags.forEach((t) => next[t].count++));
    // Tags no item holds any more drop out (indexes shift, so remap once more).
    const keep = next.map((t, i) => [t, i] as const).filter(([t]) => t.count > 0);
    const shift = new Map(keep.map(([, i], j) => [i, j]));
    tags = keep.map(([t]) => t);
    items = items.map((item) => ({ ...item, tags: item.tags.map((t) => shift.get(t)!).filter((t) => t !== undefined) }));
  }
  return { ...index, tags, items, tree };
}
