// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { describeRange, locate, rangeFor, textIndex, unwrap, wrapRange } from "./web-anchors";

const page = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};
const select = (body: HTMLElement, text: string, nth = 0) => {
  const index = textIndex(body);
  let at = -1;
  for (let i = 0; i <= nth; i++) at = index.text.indexOf(text, at + 1);
  return rangeFor(index, at, at + text.length)!;
};

describe("web anchors", () => {
  it("describes a selection across elements and finds it again", () => {
    const body = page("<p>The quick <b>brown fox</b> jumps.</p><p>Over the lazy dog.</p>");
    const anchor = describeRange(textIndex(body), select(body, "brown fox jumps"))!;
    expect(anchor.selectors[0]).toMatchObject({ type: "TextQuoteSelector", exact: "brown fox jumps", prefix: "The quick " });
    expect(locate(textIndex(body), anchor)).toEqual({ start: 10, end: 25 });
  });

  it("re-anchors by quote and context when the text moved", () => {
    const body = page("<p>alpha beta gamma. alpha beta delta.</p>");
    const anchor = describeRange(textIndex(body), select(body, "alpha beta", 1))!;
    page("<p>Inserted words first. alpha beta gamma. alpha beta delta.</p>");
    const at = locate(textIndex(document.body), anchor)!;
    expect(textIndex(document.body).text.slice(at.end, at.end + 6)).toBe(" delta");
  });

  it("matches a quote whose spacing changed", () => {
    const body = page("<p>one   two\n three</p>");
    const at = locate(textIndex(body), undefined, "two three")!;
    expect(textIndex(body).text.slice(at.start, at.end)).toBe("two\n three");
  });

  it("wraps and unwraps marks without changing the text", () => {
    const body = page("<p>The quick <b>brown fox</b> jumps.</p>");
    const before = body.innerHTML;
    const marks = wrapRange(textIndex(body), 4, 15, () => document.createElement("mark"));
    expect(marks.map((m) => m.textContent)).toEqual(["quick ", "brown"]);
    expect(textIndex(body).text).toBe("The quick brown fox jumps.");
    unwrap(marks);
    expect(body.innerHTML).toBe(before);
  });
});
