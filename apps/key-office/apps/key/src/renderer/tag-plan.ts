// The tag tree (tags plus their parents and colours from the store's tag tree) and the
// translation of a tag plan into one store operation (`store_tag_apply`), with a preview
// of exactly what will change.
import { fold, plural, type TagIndex, type TagMeta, type TagPlan } from "./tag-analysis";

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
export function sortTree(list: TagNode[], sort: TagSort): TagNode[] {
  const sorted = [...list].sort((a, b) => (sort === "count" ? b.total - a.total : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
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

// ── Plans to operations ──────────────────────────────────────────────────────

export interface TagOperation {
  replace: { from: string; to: string[] }[];
  tree: Record<string, TagMeta | null>;
  property?: { name: string; config: Record<string, unknown>; values: [string, string | boolean][]; removeTags: boolean };
}

export interface PlannedChange {
  operation: TagOperation;
  /** "Merge 3 tags into “Machine learning”". */
  label: string;
  /** One line per change, for the preview. */
  lines: { before: string; after: string; detail?: string }[];
  /** Sources whose tags or properties change. */
  items: number;
}

export type ManagerPlan =
  | TagPlan
  | { type: "rename"; tag: string; to: string }
  | { type: "unnest"; tags: string[] }
  | { type: "color"; tags: string[]; color: string | null };

function existingName(tree: TagTree, name: string) {
  return tree.nodes.get(key(name))?.name ?? name.trim();
}

/** Turns a plan into the store operation, its label and its preview. Throws when it cannot apply. */
export function planChange(plan: ManagerPlan, index: TagIndex, tree: TagTree = buildTree(index)): PlannedChange {
  const meta = index.tree ?? {};
  const metaOf = (name: string): TagMeta => {
    const entry = Object.entries(meta).find(([k]) => key(k) === key(name));
    return entry ? { ...entry[1] } : {};
  };
  const metaKey = (name: string) => Object.keys(meta).find((k) => key(k) === key(name));
  const op: TagOperation = { replace: [], tree: {} };
  const holders = new Map<string, Set<number>>();
  index.tags.forEach((t) => holders.set(key(t.name), new Set()));
  const tagIndex = new Map(index.tags.map((t, i) => [i, key(t.name)]));
  index.items.forEach((item, i) => item.tags.forEach((t) => holders.get(tagIndex.get(t)!)?.add(i)));
  const itemsOf = (names: string[]) => {
    const all = new Set<number>();
    names.forEach((n) => holders.get(key(n))?.forEach((i) => all.add(i)));
    return all.size;
  };
  const countOf = (name: string) => tree.nodes.get(key(name))?.count ?? 0;
  const setMeta = (name: string, next: TagMeta | null) => {
    const k = metaKey(name) ?? name;
    if (next && !next.parent) delete next.parent;
    if (next && !next.color) delete next.color;
    op.tree[k] = next;
  };
  const lines: PlannedChange["lines"] = [];
  const isAncestor = (maybe: string, of: string) => key(maybe) === key(of) || ancestors(tree, of).some((a) => key(a) === key(maybe));

  /** Children of removed tags move up to `to` (or the removed tag's own parent). */
  const reparent = (removed: string[], to: (removed: string) => string | null) => {
    const gone = new Set(removed.map(key));
    for (const node of tree.nodes.values())
      if (node.parent && gone.has(key(node.parent)) && !gone.has(key(node.name))) setMeta(node.name, { ...metaOf(node.name), parent: to(node.parent) });
  };

  switch (plan.type) {
    case "rename":
    case "merge": {
      const from = plan.type === "rename" ? [plan.tag] : plan.from;
      const to = plan.type === "rename" ? plan.to.trim() : plan.to;
      if (!to) throw Error("Enter a tag name.");
      if (to.length > 128) throw Error("Tag names are at most 128 characters.");
      const target = from.some((f) => key(f) === key(to)) ? to : existingName(tree, to);
      const sources = from.filter((f) => f !== target);
      if (!sources.length) throw Error("Nothing to change.");
      for (const f of sources) {
        op.replace.push({ from: f, to: [target] });
        lines.push({ before: f, after: target, detail: plural(countOf(f), "item") });
      }
      // The surviving tag keeps its place, or takes the first merged tag's.
      const base = metaOf(target);
      const inherited = sources.map(metaOf).find((m) => m.parent || m.color) ?? {};
      const next: TagMeta = { parent: base.parent ?? inherited.parent, color: base.color ?? inherited.color };
      if (next.parent && isAncestor(target, next.parent)) next.parent = undefined;
      for (const f of sources) if (metaKey(f) && key(f) !== key(target)) op.tree[metaKey(f)!] = null;
      if (next.parent || next.color || metaKey(target) || sources.some((f) => metaKey(f))) setMeta(target, next);
      reparent(sources.filter((f) => key(f) !== key(target)), () => target);
      const label = plan.type === "rename" || sources.length === 1 && !tree.nodes.has(key(to)) ? `Rename “${sources[0]}” to “${target}”` : `Merge ${plural(sources.length, "tag")} into “${target}”`;
      return { operation: op, label, lines, items: itemsOf(sources) };
    }
    case "delete": {
      for (const t of plan.tags) {
        if (countOf(t)) op.replace.push({ from: t, to: [] });
        if (metaKey(t)) op.tree[metaKey(t)!] = null;
        lines.push({ before: t, after: "", detail: countOf(t) ? `removed from ${plural(countOf(t), "item")}` : "removed from the tree" });
      }
      reparent(plan.tags, (removed) => metaOf(removed).parent ?? null);
      return { operation: op, label: `Remove ${plan.tags.length === 1 ? `“${plan.tags[0]}”` : plural(plan.tags.length, "tag")}`, lines, items: itemsOf(plan.tags) };
    }
    case "nest": {
      const parent = existingName(tree, plan.parent);
      if (!parent) throw Error("Enter a parent name.");
      if (!tree.nodes.has(key(parent))) setMeta(parent, {});
      let moved = 0;
      for (const child of plan.children) {
        if (key(child) === key(parent) || isAncestor(child, parent)) continue;
        setMeta(child, { ...metaOf(child), parent });
        lines.push({ before: child, after: `${parent} › ${tree.nodes.get(key(child))?.name ?? child}` });
        moved++;
      }
      if (!moved) throw Error("A tag cannot go under itself or under a tag inside it.");
      return { operation: op, label: `Nest ${moved === 1 ? `“${lines[0].before}”` : plural(moved, "tag")} under “${parent}”`, lines, items: 0 };
    }
    case "unnest": {
      for (const t of plan.tags) {
        const next = { ...metaOf(t), parent: null };
        setMeta(t, next.color || !countOf(t) ? next : null);
        lines.push({ before: t, after: t, detail: "to the top level" });
      }
      return { operation: op, label: `Move ${plan.tags.length === 1 ? `“${plan.tags[0]}”` : plural(plan.tags.length, "tag")} to the top level`, lines, items: 0 };
    }
    case "color": {
      for (const t of plan.tags) setMeta(t, { ...metaOf(t), color: plan.color });
      return { operation: op, label: plan.color ? "Change colour" : "Remove colour", lines, items: 0 };
    }
    case "hierarchy": {
      const leaves = new Map<string, number>();
      plan.splits.forEach((s) => leaves.set(key(s.path.at(-1)!), (leaves.get(key(s.path.at(-1)!)) ?? 0) + 1));
      const ensured = new Set<string>();
      for (const { tag, path } of plan.splits) {
        const chain = path.slice(0, -1).map((segment) => existingName(tree, segment));
        chain.forEach((segment, i) => {
          if (ensured.has(key(segment))) return;
          ensured.add(key(segment));
          const current = metaOf(segment);
          if (i > 0 && !current.parent) setMeta(segment, { ...current, parent: chain[i - 1] });
          else if (!tree.nodes.has(key(segment)) && !(key(segment) in op.tree)) setMeta(segment, {});
        });
        const leaf = path.at(-1)!;
        // A short name another tag already has, or two paths share, keeps the full name.
        const clash = (leaves.get(key(leaf)) ?? 0) > 1 || (tree.nodes.has(key(leaf)) && key(leaf) !== key(tag));
        const name = clash ? tag : leaf;
        if (name !== tag) op.replace.push({ from: tag, to: [name] });
        if (metaKey(tag) && name !== tag) op.tree[metaKey(tag)!] = null;
        op.tree[name] = { ...metaOf(tag), parent: chain.at(-1)! };
        lines.push({ before: tag, after: [...chain, name].join(" › "), detail: name === tag ? "keeps its name" : undefined });
      }
      return { operation: op, label: `Nest ${plural(plan.splits.length, "tag")} by their names`, lines, items: itemsOf(plan.splits.filter((s) => op.replace.some((r) => r.from === s.tag)).map((s) => s.tag)) };
    }
    case "property": {
      const name = plan.name.trim();
      if (!name) throw Error("Enter a property name.");
      const values = plan.values.filter(([t]) => tree.nodes.has(key(t)));
      if (!values.length) throw Error("None of these tags are left.");
      const options = [...new Set(values.map(([, v]) => String(v)))];
      op.property = {
        name,
        config: plan.propertyType === "boolean" ? { type: "boolean" } : { type: "select", options },
        values: plan.propertyType === "boolean" ? values.map(([t]) => [t, true]) : values,
        removeTags: plan.removeTags,
      };
      for (const [t, v] of op.property.values) lines.push({ before: t, after: plan.propertyType === "boolean" ? `${name}: checked` : `${name}: ${v}`, detail: plural(countOf(t), "item") });
      return {
        operation: op,
        label: `Turn ${values.length === 1 ? `“${values[0][0]}”` : plural(values.length, "tag")} into “${name}”`,
        lines,
        items: itemsOf(values.map(([t]) => t)),
      };
    }
  }
}
