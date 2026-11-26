import { describe, expect, it } from "vitest";
import { rowsThatFit } from "./sidebar-budget";

describe("sidebar budget", () => {
  it("shows every row that fits, else leaves a row for Show more", () => {
    expect(rowsThatFit(undefined, 50, 29)).toBeUndefined();
    expect(rowsThatFit(290, 10, 29)).toBeUndefined();
    expect(rowsThatFit(290, 11, 29)).toBe(9);
    expect(rowsThatFit(20, 11, 29)).toBe(2);
  });
});
