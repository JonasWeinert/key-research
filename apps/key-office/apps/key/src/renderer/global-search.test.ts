import { describe, expect, it } from "vitest";
import { EMPTY_FIND, itemFilter, sidebarFilter, type FindState } from "./global-search";

const tag = { field: "tag", op: "is" as const, value: "covid", label: "covid" };

describe("sidebar clicks in a search tab", () => {
  it("narrow to a collection, then to the library's sources", () => {
    const inCollection = sidebarFilter({ ...EMPTY_FIND, filters: [tag] }, { kind: "sources", collectionId: "c1", title: "Reading" })!;
    expect(inCollection.kinds).toEqual(["source"]);
    expect(inCollection.filters.map((f) => [f.field, f.value])).toEqual([
      ["tag", "covid"],
      ["collection", "c1"],
    ]);
    const library = sidebarFilter(inCollection, { kind: "sources" })!;
    expect(library.kinds).toEqual(["source"]);
    expect(library.filters).toEqual([tag]);
  });

  it("leave the search alone when the click changes nothing, so it opens instead", () => {
    const state: FindState = { text: "x", kinds: ["source"], filters: [] };
    expect(sidebarFilter(state, { kind: "sources" })).toBeUndefined();
    const note = sidebarFilter(state, { kind: "note", id: "n1", title: "Alpha" })!;
    expect(note.filters).toEqual([itemFilter("note", "n1", "Alpha")]);
    expect(note.kinds).toEqual([]);
    expect(note.text).toBe("x");
    expect(sidebarFilter(note, { kind: "note", id: "n1", title: "Alpha" })).toBeUndefined();
  });

  it("show highlights or pages only", () => {
    expect(sidebarFilter(EMPTY_FIND, { kind: "highlights" })!.kinds).toEqual(["highlight"]);
    expect(sidebarFilter({ ...EMPTY_FIND, filters: [tag] }, { kind: "records" })).toEqual({ ...EMPTY_FIND, kinds: ["record"], filters: [] });
  });
});

