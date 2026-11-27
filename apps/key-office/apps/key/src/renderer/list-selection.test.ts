import { describe, expect, it } from "vitest";
import { clickSelection, moveSelection, selectAllRows, selectionIds, type ListSelection } from "./list-selection";

const order = ["a", "b", "c", "d", "e"];
const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
const ids = (s: ListSelection) => [...s.selected].sort();

describe("list selection", () => {
  it("clicks, ⌘-clicks and ⇧-click ranges", () => {
    let s: ListSelection = { selected: new Set() };
    s = clickSelection(s, order, "b", plain);
    expect([ids(s), s.focus, s.anchor]).toEqual([[], "b", "b"]);
    expect(selectionIds(s)).toEqual(["b"]);
    s = clickSelection(s, order, "d", { ...plain, metaKey: true });
    expect(ids(s)).toEqual(["b", "d"]);
    s = clickSelection(s, order, "b", { ...plain, ctrlKey: true });
    expect(ids(s)).toEqual(["d"]);
    // The anchor is the last ⌘-clicked row: the range runs from it.
    s = clickSelection(s, order, "d", { ...plain, shiftKey: true });
    expect([ids(s), s.anchor, s.focus]).toEqual([["b", "c", "d"], "b", "d"]);
    s = clickSelection(s, order, "a", { ...plain, shiftKey: true });
    expect(ids(s)).toEqual(["a", "b"]);
    s = clickSelection(s, order, "e", plain);
    expect([ids(s), s.focus]).toEqual([[], "e"]);
  });

  it("moves, extends with ⇧ and selects all", () => {
    let s: ListSelection = { selected: new Set(), focus: "b", anchor: "b" };
    s = moveSelection(s, order, 1, true);
    expect([ids(s), s.focus]).toEqual([["b", "c"], "c"]);
    s = moveSelection(s, order, 1, true);
    expect(ids(s)).toEqual(["b", "c", "d"]);
    s = moveSelection(s, order, -1, false);
    expect([ids(s), s.focus, s.anchor]).toEqual([[], "c", "c"]);
    s = moveSelection(s, order, 10, false);
    expect(s.focus).toBe("e");
    expect(moveSelection({ selected: new Set() }, order, 1, false).focus).toBe("a");
    expect(moveSelection(s, [], 1, false)).toBe(s);
    expect(ids(selectAllRows(s, order))).toEqual(order);
  });
});
