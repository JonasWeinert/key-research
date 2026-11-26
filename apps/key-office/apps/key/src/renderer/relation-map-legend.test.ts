import { describe, expect, it } from "vitest";
import { nextSelection } from "./relation-map-legend";

describe("relation map legend selection", () => {
  it("shows a kind alone, and everything when clicked again", () => {
    expect(nextSelection([], "topic", false)).toEqual(["topic"]);
    expect(nextSelection(["topic"], "topic", false)).toEqual([]);
    expect(nextSelection(["topic", "person"], "topic", false)).toEqual(["topic"]);
  });
  it("adds and removes kinds with a modifier, in map order", () => {
    expect(nextSelection(["person"], "topic", true)).toEqual(["topic", "person"]);
    expect(nextSelection(["topic", "person"], "person", true)).toEqual(["topic"]);
    expect(nextSelection(["topic"], "topic", true)).toEqual([]);
  });
});
