import { describe, expect, it } from "vitest";
import { fieldNamed, fieldsStarting, typedFilter, type FilterField } from "./filter-fields";
import { filterKey, storeFilters, type SearchFilter } from "./search-suggest";

const field = (f: Partial<FilterField>): FilterField => ({ id: "x", field: "x", label: "X", group: "publication", type: "text", ops: ["contains"], names: [], examples: [], help: "", ...f });
const fields: FilterField[] = [
  field({ id: "title", field: "title", label: "Title", names: ["ti"] }),
  field({ id: "year", field: "year", label: "Year", type: "number", names: ["published"] }),
  field({ id: "added", field: "added", label: "Added", type: "date" }),
  field({ id: "rating", field: "property", key: "Rating", label: "Rating", type: "number", group: "properties" }),
  field({ id: '"Reading status"', field: "property", key: "Reading status", label: "Reading status", type: "select", group: "properties", options: [{ value: "To read", label: "To read" }] }),
  field({ id: "status", field: "status", label: "Reading", type: "select", names: ["readingstatus"], group: "reading" }),
];

describe("the filter field list", () => {
  it("completes field names, the workspace's properties first", () => {
    expect(fieldsStarting(fields, "ra").map((f) => f.id)).toEqual(["rating"]);
    expect(fieldsStarting(fields, "pub").map((f) => f.id)).toEqual(["year"]);
    expect(fieldsStarting(fields, "r")).toEqual([]);
    expect(fieldsStarting(fields, "reading").map((f) => f.id)).toEqual(["status", '"Reading status"']);
    expect(fieldsStarting(fields, "readi").map((f) => f.id)).toEqual(['"Reading status"', "status"]);
  });
  it("finds a property by its name before a field's other names", () => {
    expect(fieldNamed(fields, "reading status")?.key).toBe("Reading status");
    expect(fieldNamed(fields, "readingstatus")?.key).toBe("Reading status");
    expect(fieldNamed(fields, "ti")?.id).toBe("title");
  });
  it("writes a built filter as it would be typed", () => {
    expect(typedFilter(fields[3], "gt", "3")).toBe("rating>3");
    expect(typedFilter(fields[3], "between", "1", "4")).toBe("rating:1..4");
    expect(typedFilter(fields[4], "is", "To read")).toBe('"Reading status":"To read"');
    expect(typedFilter(fields[0], "contains", "deep learning", "", true)).toBe('-title:"deep learning"');
    expect(typedFilter(fields[0], "is", "Attention")).toBe("title=Attention");
    expect(typedFilter(fields[2], "empty", "")).toBe("added:empty");
    expect(typedFilter(fields[1], "notEmpty", "")).toBe("year:any");
  });
});

describe("typed filter tokens", () => {
  const rating: SearchFilter = { field: "property", key: "Rating", op: "gt", value: "3", label: "more than 3", scope: "Rating", valueType: "number" };
  const either: SearchFilter = { field: "any", op: "is", value: "", label: "gold or green", any: [{ field: "oaStatus", op: "is", value: "gold", label: "Gold" }, { field: "oaStatus", op: "is", value: "green", label: "Green" }] };
  it("reach the store with their type, negation and OR group, without labels", () => {
    expect(storeFilters([{ ...rating, negate: true }, either])).toEqual([
      { field: "property", key: "Rating", op: "gt", value: "3", negate: true, valueType: "number", any: undefined },
      { field: "any", op: "is", value: "", key: undefined, negate: undefined, valueType: undefined, any: [
        { field: "oaStatus", op: "is", value: "gold", key: undefined, negate: undefined, valueType: undefined, any: undefined },
        { field: "oaStatus", op: "is", value: "green", key: undefined, negate: undefined, valueType: undefined, any: undefined },
      ] },
    ]);
  });
  it("are told apart by negation and group members", () => {
    expect(filterKey(rating)).not.toBe(filterKey({ ...rating, negate: true }));
    expect(filterKey(either)).not.toBe(filterKey({ ...either, any: either.any!.slice(0, 1) }));
  });
});
