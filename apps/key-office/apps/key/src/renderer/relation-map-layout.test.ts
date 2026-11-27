import { describe, expect, it } from "vitest";
import type { MapKind, RelationMapData } from "./library-api";
import { MAP_ORDER, layoutMap } from "./relation-map-layout";

const data: RelationMapData = {
  center: { kind: "topic", id: "T1", name: "Open science", count: 10 },
  nodes: [
    ...["A", "B", "C", "D"].map((n, i) => ({ kind: "person" as const, id: n, name: `Person ${n}`, count: 8 - i })),
    ...["x", "y"].map((n, i) => ({ kind: "tag" as const, id: n, name: n, count: 5 - i })),
    { kind: "venue", id: "V", name: "Journal", count: 3 },
    { kind: "topic", id: "T2", name: "Peer review", count: 1 },
  ],
  links: [{ a: "person:A", b: "tag:x", weight: 4 }],
  more: {},
};
const all = new Set<MapKind>(MAP_ORDER);

describe("layoutMap", () => {
  it("places every shown node left or right of the centre, labels reading outward on distinct rows", () => {
    const layout = layoutMap(data, { width: 760, height: 420, kinds: all, minCount: 1 });
    expect(layout.nodes).toHaveLength(8);
    for (const n of layout.nodes) {
      expect(Math.sign(n.x - layout.cx)).toBe(n.dx);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(420);
    }
    const right = layout.nodes.filter((n) => n.dx > 0).map((n) => n.y);
    expect(new Set(right).size).toBe(right.length);
    expect(layout.links).toEqual([{ a: "person:A", b: "tag:x", weight: 4, strength: 1 }]);
  });

  it("keeps nodes clear of the centre's label at any width", () => {
    const long = { ...data, center: { ...data.center, name: "Open science and the reproducibility of results" } };
    for (const width of [280, 340, 420, 520, 640, 760]) {
      const layout = layoutMap(long, { width, height: 300, kinds: all, minCount: 1, compact: width < 500 });
      const chars = Math.min(34, long.center.name.length);
      const half = (chars * 6.15 * (12.5 / 11.5) + 4) / 2;
      // The label's box (12.5px text below the centre) and each node's mark with its own label's gap.
      const top = layout.cy + layout.centerR + 6 + 2;
      const bottom = top + 16.5;
      for (const n of layout.nodes) {
        const onRows = n.y + n.r > top && n.y - n.r < bottom;
        if (onRows) expect(Math.abs(n.x - layout.cx) - n.r, `${n.key} at ${width}px`).toBeGreaterThan(half);
      }
    }
  });

  it("sizes the strongest largest and is deterministic", () => {
    const a = layoutMap(data, { width: 760, height: 420, kinds: all, minCount: 1 });
    const b = layoutMap(data, { width: 760, height: 420, kinds: all, minCount: 1 });
    expect(a).toEqual(b);
    const size = (key: string) => a.nodes.find((n) => n.key === key)!.r;
    expect(size("person:A")).toBeGreaterThan(size("person:D"));
  });

  it("hides kinds and weak nodes as asked", () => {
    const layout = layoutMap(data, { width: 760, height: 420, kinds: new Set<MapKind>(["person", "tag"]), minCount: 5 });
    expect(layout.nodes.map((n) => n.key).sort()).toEqual(["person:A", "person:B", "person:C", "person:D", "tag:x"]);
  });
});
