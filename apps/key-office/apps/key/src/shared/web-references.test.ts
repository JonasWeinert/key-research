// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { detectWebReferences, referenceInputs, WEB_REFERENCES_SCRIPT } from "./web-references";

const doc = (html: string) => new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");

describe("detectWebReferences", () => {
  it("reads a Wikipedia-style list and the in-text links to it", () => {
    const scan = detectWebReferences(
      doc(`<p>Health rose<sup><a href="#cite_note-1">[1]</a></sup> and so did income<sup><a href="#cite_note-2">[2]</a></sup>.</p>
      <h2>References</h2>
      <div class="reflist"><ol class="references">
        <li id="cite_note-1"><span class="mw-cite-backlink"><a href="#cite_ref-1">^</a></span> <cite>Deaton, A. (2013). “The Great Escape: Health, Wealth, and the Origins of Inequality”. Princeton. <a href="https://doi.org/10.1515/9781400847969">doi:10.1515/9781400847969</a></cite></li>
        <li id="cite_note-2"><span class="mw-cite-backlink"><a href="#cite_ref-2">^</a></span> Preston, S. H. (1975). The changing relation between mortality and level of economic development. Population Studies 29.</li>
      </ol></div>`),
    );
    expect(scan.method).toBe("list");
    expect(scan.references).toHaveLength(2);
    expect(scan.references[0]).toMatchObject({ number: 1, anchor: "cite_note-1", doi: "10.1515/9781400847969", year: 2013, title: "The Great Escape: Health, Wealth, and the Origins of Inequality" });
    expect(scan.references[0].text.startsWith("Deaton")).toBe(true);
    expect(scan.citations).toEqual([
      { anchor: "cite_note-1", numbers: [1] },
      { anchor: "cite_note-2", numbers: [2] },
    ]);
  });

  it("finds JATS-style entries by id under a References section", () => {
    const scan = detectWebReferences(
      doc(`<p>As shown <a href="#B1">1</a>, <a href="#B2">2</a>.</p>
      <section><h2>References</h2>
        <div id="B1" class="ref">Smith J, Lee K. A long enough reference title about things. J Things. 2020;1:2.</div>
        <div id="B2" class="ref">Doe A. Another long enough reference about other things. Nature. 2019.</div>
      </section>`),
    );
    expect(scan.references.map((r) => r.anchor)).toEqual(["B1", "B2"]);
    expect(scan.citations.map((c) => c.numbers[0])).toEqual([1, 2]);
  });

  it("falls back to citation_reference meta tags", () => {
    const d = doc("<p>No list here.</p>");
    const meta = d.createElement("meta");
    meta.name = "citation_reference";
    meta.content = "citation_title=Income and health; citation_author=Jane Roe; citation_publication_date=2018; citation_doi=10.1000/xyz";
    d.head.append(meta);
    const scan = detectWebReferences(d);
    expect(scan.method).toBe("meta");
    expect(scan.references[0]).toMatchObject({ title: "Income and health", doi: "10.1000/xyz", year: 2018, authors: ["Jane Roe"] });
    expect(referenceInputs(scan)[0].metadata).toMatchObject({ source: "page", doi: "10.1000/xyz" });
  });

  it("is self-contained, so it runs as a page script", () => {
    expect(WEB_REFERENCES_SCRIPT).not.toMatch(/__name|_\$|import\(/);
    document.body.innerHTML = '<ol class="references"><li id="r1">Someone. A reference title long enough. 2001.</li><li id="r2">Another. A second reference title. 2002.</li></ol>';
    // eslint-disable-next-line no-eval
    expect((0, eval)(WEB_REFERENCES_SCRIPT).references).toHaveLength(2);
  });
});
