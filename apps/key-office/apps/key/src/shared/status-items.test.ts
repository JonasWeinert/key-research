import { describe, expect, it } from "vitest";
import { MAX_STATUS_ITEMS, overflowingStatusItems, sanitizeStatusItems } from "./status-items";

describe("sanitizeStatusItems", () => {
  it("keeps well-formed items and only their known fields", () => {
    expect(sanitizeStatusItems([{ id: "a", label: "Details", icon: "info", active: true, title: "Show", extra: 1 }])).toEqual([
      { id: "a", label: "Details", icon: "info", active: true, title: "Show" },
    ]);
  });
  it("drops items without an id, duplicates, and ones with neither label nor icon", () => {
    expect(sanitizeStatusItems([{ label: "x" }, { id: "a", label: "A" }, { id: "a", label: "B" }, { id: "b" }, null, "c"])).toEqual([{ id: "a", label: "A" }]);
  });
  it("treats anything but an array as no items, and caps the count", () => {
    expect(sanitizeStatusItems({ id: "a" })).toEqual([]);
    expect(sanitizeStatusItems(Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, label: "x" })))).toHaveLength(MAX_STATUS_ITEMS);
  });
});

describe("status item kinds", () => {
  it("keeps text, progress, busy and priority, clamped", () => {
    expect(sanitizeStatusItems([{ id: "n", label: "2 items", text: true, progress: 1.4, busy: true, priority: 120 }])).toEqual([
      { id: "n", label: "2 items", text: true, progress: 1, busy: true, priority: 100 },
    ]);
    expect(sanitizeStatusItems([{ id: "n", label: "x", text: "yes", progress: NaN, priority: "high" }])).toEqual([{ id: "n", label: "x" }]);
  });
});

describe("overflowingStatusItems", () => {
  const items = [
    { id: "zotero", width: 100, priority: 40 },
    { id: "work", width: 120, priority: 90 },
    { id: "count", width: 60 },
    { id: "selected", width: 70, priority: 30 },
  ];
  it("hides nothing when everything fits", () => {
    expect(overflowingStatusItems(items, 400, 4)).toEqual(new Set());
  });
  it("drops the lowest priority first, and everything below an item that does not fit", () => {
    expect(overflowingStatusItems(items, 300, 4)).toEqual(new Set(["selected"]));
    expect(overflowingStatusItems(items, 200, 4)).toEqual(new Set(["zotero", "selected"]));
    expect(overflowingStatusItems(items, 100, 4)).toEqual(new Set(["work", "count", "zotero", "selected"]));
  });
});
