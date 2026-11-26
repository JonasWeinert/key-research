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
