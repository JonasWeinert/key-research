import { describe, expect, it } from "vitest";
import { shortAuthors } from "./web-search";

describe("shortAuthors", () => {
  it("names one or two authors and shortens more", () => {
    expect(shortAuthors(["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"])).toBe("Vaswani et al.");
    expect(shortAuthors(["Ashish Vaswani", "Noam Shazeer"])).toBe("Vaswani & Shazeer");
  });
});
