import { describe, expect, it } from "vitest";
import { couldNot, plainError, rawError } from "./plain-error";

describe("plainError", () => {
  it("drops the IPC prefix and keeps a readable message", () => {
    expect(rawError(new Error("Error invoking remote method 'key:invoke': Error: Source not found"))).toBe("Source not found");
    expect(plainError("Error invoking remote method 'key:invoke': Error: Source not found")).toBe("Source not found");
  });
  it("says what happened and what to do for technical errors", () => {
    expect(plainError("getaddrinfo ENOTFOUND api.openalex.org")).toMatch(/could not reach the internet.*try again/i);
    expect(plainError("HTTP 429 Too Many Requests")).toMatch(/slow down/);
    expect(plainError("request failed with status 503")).toMatch(/on its side/);
    expect(plainError("ENOENT: no such file or directory, open '/x.pdf'")).toMatch(/not where Key expected/);
    expect(plainError("")).toMatch(/restart Key/);
  });
  it("names the action", () => {
    expect(couldNot("save the page", new Error("ETIMEDOUT"))).toBe("Could not save the page. The service took too long to answer. Try again; a slow or busy network can cause this.");
    expect(couldNot("save the page", "Not a saved web page")).toBe("Could not save the page. Not a saved web page.");
  });
});
