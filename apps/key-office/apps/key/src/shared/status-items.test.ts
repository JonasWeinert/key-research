import { describe, expect, it } from "vitest";
import { MAX_STATUS_ITEMS, sanitizeStatusItems } from "./status-items";

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
