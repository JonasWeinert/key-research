// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildSchemaExtensions, serializeNote } from "./note-editor/schema";
import { QuotePaste, insertQuote } from "./note-editor/quotePaste";
import {
  QUOTE_MIME,
  authorPhrase,
  parseQuotePayload,
  quoteAttribution,
  quoteFromHtml,
  quoteHtml,
  quotePlainText,
  readQuote,
  type QuotePayload,
} from "./quote-clipboard";

const quote: QuotePayload = {
  v: 1,
  text: "Each nurse scanned 30 pa-\ntients aged at least\n18 years.",
  workspaceId: "w1",
  sourceId: "src1",
  documentHash: "abc",
  page: 3,
  rects: [[100, 200, 3000, 400]],
  color: "yellow",
  citation: { authors: ["Narang", "Bae", "Hong"], year: 2021, title: "Utility of a Deep-Learning Algorithm." },
};

const transfer = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? "" });

describe("quote text", () => {
  it("names one, two or many authors", () => {
    expect(authorPhrase([])).toBe("");
    expect(authorPhrase(["Narang"])).toBe("Narang");
    expect(authorPhrase(["Narang", "Bae"])).toBe("Narang & Bae");
    expect(authorPhrase(["Narang", "Bae", "Hong"])).toBe("Narang et al.");
  });
  it("puts the quote on one line, joins hyphenated words, then attributes it", () => {
    expect(quotePlainText(quote)).toBe(
      "“Each nurse scanned 30 patients aged at least 18 years.” — Narang et al. (2021), Utility of a Deep-Learning Algorithm, p. 4",
    );
  });
  it("uses the citation engine's attribution when it has one", () => {
    expect(quotePlainText({ ...quote, attribution: "Narang et al., 2021, p. 4" })).toBe("“Each nurse scanned 30 patients aged at least 18 years.” — Narang et al., 2021, p. 4");
  });
  it("leaves out what is not known", () => {
    expect(quoteAttribution({ page: 0, citation: { authors: [] } })).toBe("p. 1");
    expect(quoteAttribution({ page: 1, citation: { authors: [], title: "A title" } })).toBe("A title, p. 2");
    expect(quoteAttribution({ page: 1, citation: { authors: ["Smith"] } })).toBe("Smith, p. 2");
    expect(quoteAttribution({ page: 1, citation: { authors: [], year: 1999 } })).toBe("(1999), p. 2");
    expect(quotePlainText({ ...quote, citation: { authors: [] }, page: Number.NaN })).toBe(
      "“Each nurse scanned 30 patients aged at least 18 years.”",
    );
  });
});

describe("quote payload", () => {
  it("round-trips through the HTML marker, escaping included", () => {
    const tricky = { ...quote, text: `He said "<b>no</b>" & left` };
    const html = quoteHtml(tricky);
    expect(html).toContain("<p>He said &quot;&lt;b&gt;no&lt;/b&gt;&quot; &amp; left</p>");
    expect(quoteFromHtml(`<meta charset="utf-8">${html}`)).toEqual({ ...tricky, text: tricky.text });
  });
  it("prefers the custom type and falls back to the HTML", () => {
    expect(readQuote(transfer({ [QUOTE_MIME]: JSON.stringify(quote) }))?.sourceId).toBe("src1");
    expect(readQuote(transfer({ "text/html": quoteHtml(quote) }))?.page).toBe(3);
    expect(readQuote(transfer({ "text/plain": quotePlainText(quote) }))).toBeNull();
    expect(readQuote(transfer({ "text/html": "<p>ordinary</p>" }))).toBeNull();
  });
  it("rejects anything that is not a quote", () => {
    expect(parseQuotePayload("{")).toBeNull();
    expect(parseQuotePayload({ v: 2, text: "x", documentHash: "a", page: 0 })).toBeNull();
    expect(parseQuotePayload({ v: 1, text: " ", documentHash: "a", page: 0 })).toBeNull();
    expect(parseQuotePayload({ v: 1, text: "x", documentHash: "a", page: 0, rects: [[1, 2], "x"] })?.rects).toEqual([]);
  });
});

describe("pasting a quote into a note", () => {
  const editor = (content = "") =>
    new Editor({ extensions: [...buildSchemaExtensions(), QuotePaste], content, contentType: "markdown" } as never);

  it("becomes a source quote that links back to its page", () => {
    const e = editor();
    expect(insertQuote(e.view, quote)).toBe(true);
    const markdown = serializeNote(e);
    expect(markdown).toContain('```quote source="src1" page="3" color="yellow"');
    expect(markdown).toContain("Each nurse scanned 30 patients aged at least 18 years.");
    e.destroy();
  });

  it("is handled by the paste plugin from the clipboard's HTML", () => {
    const e = editor();
    const event = { clipboardData: transfer({ "text/html": quoteHtml(quote), "text/plain": quotePlainText(quote) }) };
    const handled = e.view.someProp("handlePaste", (handle) => handle(e.view, event as unknown as ClipboardEvent, null as never));
    expect(handled).toBe(true);
    expect(e.state.doc.firstChild?.type.name).toBe("sourceQuote");
    e.destroy();
  });

  it("leaves other pastes and quotes without a source alone", () => {
    const e = editor();
    const plain = { clipboardData: transfer({ "text/plain": "hello" }) };
    expect(e.view.someProp("handlePaste", (handle) => handle(e.view, plain as unknown as ClipboardEvent, null as never))).toBeFalsy();
    expect(insertQuote(e.view, { ...quote, sourceId: undefined })).toBe(false);
    e.destroy();
  });
});
