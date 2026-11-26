// @vitest-environment jsdom
import { afterAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildSchemaExtensions, serializeNote } from "./schema";
import { citeHref, citeItemsOf, citedSources, noteCitations, rewriteCitations } from "./citations";
import { itemFromHref } from "./types";

const editor = new Editor({ extensions: buildSchemaExtensions(), content: "" });
afterAll(() => editor.destroy());

describe("citations in notes", () => {
  it("keeps the cited works in the link", () => {
    const href = citeHref([
      { id: "a b", locator: "12–14", label: "page", prefix: "see (also)" },
      { id: "c", suppressAuthor: true, label: "chapter", locator: "3" },
    ]);
    expect(href).not.toMatch(/[()\s]/);
    expect(itemFromHref(href)).toEqual({ kind: "source", id: "a b" });
    expect(citeItemsOf(href)).toEqual([
      { id: "a b", locator: "12–14", prefix: "see (also)" },
      { id: "c", locator: "3", label: "chapter", suppressAuthor: true },
    ]);
    expect(citeItemsOf("key://source/x#page:3")).toBeNull();
  });

  it("finds citations old and new, and round-trips them through Markdown", () => {
    const href = citeHref([{ id: "s1", locator: "4" }, { id: "s2" }]);
    const md = `One [(Doe, 2020, p. 5)](key://source/s0#page:4), two [(Doe, 2020; Roe, 2021)](${href}) and a [title link](key://source/s3).`;
    editor.commands.setContent(md, { contentType: "markdown" });
    const cites = noteCitations(editor.state.doc);
    expect(cites.map((c) => c.items)).toEqual([[{ id: "s0", locator: "5" }], [{ id: "s1", locator: "4" }, { id: "s2" }]]);
    expect(cites[1].explicit).toBe(true);
    expect(citedSources(editor.state.doc)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(serializeNote(editor)).toContain(`(${href})`);
  });

  it("rewrites the works a citation cites (checker fixes)", () => {
    const href = citeHref([{ id: "pre", locator: "12-14" }]);
    editor.commands.setContent(`Claim [(Doe, 2020)](${href}).`, { contentType: "markdown" });
    rewriteCitations(editor, (item) => (item.id === "pre" ? { ...item, id: "pub", locator: "12–14" } : item));
    const [cite] = noteCitations(editor.state.doc);
    expect(cite.items).toEqual([{ id: "pub", locator: "12–14" }]);
    expect(cite.text).toBe("(Doe, 2020)");
  });
});
