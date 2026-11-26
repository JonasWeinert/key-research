// A web page's reference list and the in-text links to it, read from its DOM. Pages mark
// their bibliography in a handful of ways: a list with a references class or id (Wikipedia,
// publishers' JATS-derived markup), a section under a "References" heading, entries with ids
// like "ref-12", "B12", "CR12" or "cite_note-12", or only `citation_reference` meta tags.
// In-text citations are links to those entries ("#ref-12").
//
// `detectWebReferences` must stay self-contained (no imports, no helpers outside it): main
// also runs it in a browser page as source text (`WEB_REFERENCES_SCRIPT`).

export interface WebReference {
  /** 1-based, in list order. */
  number: number;
  text: string;
  /** The entry's element id (the in-text links' target). */
  anchor?: string;
  doi?: string;
  url?: string;
  title?: string;
  authors?: string[];
  year?: number;
}
export interface WebReferenceScan {
  references: WebReference[];
  /** In-text links: their target id and the reference numbers they name. */
  citations: { anchor: string; numbers: number[] }[];
  /** How the list was found. */
  method: "list" | "entries" | "meta" | "json-ld" | "none";
}

export function detectWebReferences(doc: Document): WebReferenceScan {
  const MAX = 1000;
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const heading = /^(\d+\.?\s*)?(references( and notes)?|bibliography|works cited|literature cited|literature|cited works|reference list|citations|sources|notes and references|references cited)$/i;
  const idPattern = /^(ref|reference|bib|bibr|cite|cite_note|cr|b|r|en|fn)[-_:.]?[a-z]*[-_:.]?\d+/i;
  const doiOf = (s: string) => {
    const m = s.match(/10\.\d{4,9}\/[^\s"'<>]+/);
    return m ? decodeURIComponent(m[0]).replace(/[.,;)\]]+$/, "").toLowerCase() : undefined;
  };

  // The element that holds the entries.
  const containerSelectors = [
    '[role="doc-bibliography"]',
    "ol.references",
    "ul.references",
    ".reflist ol",
    "ol.reference-list",
    "ul.reference-list",
    ".ref-list",
    "#references",
    "#References",
    "#bibliography",
    "#Bibliography",
    "#Bib1",
    ".c-article-references",
    "section.references",
    "div.references",
    ".bibliography",
    ".citation-list",
    "ol.refs",
    "#reference-list",
    "#ref-list",
    ".article-references",
  ];
  const entriesIn = (root: Element) => {
    const marked = [...root.querySelectorAll('[role="doc-biblioentry"]')];
    if (marked.length) return marked;
    const lists = [...root.querySelectorAll("ol, ul")].filter((l) => !l.parentElement?.closest("li"));
    const list = root.matches("ol, ul") ? root : lists.sort((a, b) => b.children.length - a.children.length)[0];
    if (list) {
      const items = [...list.children].filter((c) => c.tagName === "LI");
      if (items.length) return items;
    }
    const byId = [...root.querySelectorAll("[id]")].filter((el) => idPattern.test(el.id) && clean(el.textContent).length > 20);
    if (byId.length) return byId.filter((el) => !byId.some((o) => o !== el && o.contains(el)));
    return [...root.querySelectorAll(":scope > p, :scope > div")].filter((el) => clean(el.textContent).length > 30);
  };
  let entries: Element[] = [];
  let method: WebReferenceScan["method"] = "none";
  for (const selector of containerSelectors) {
    for (const root of doc.querySelectorAll(selector)) {
      const found = entriesIn(root);
      if (found.length > entries.length) entries = found;
    }
    if (entries.length >= 2) break;
  }
  // A heading named "References": the list (or entries) after it, up to the next heading.
  if (entries.length < 2) {
    for (const h of doc.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")) {
      if (!heading.test(clean(h.textContent))) continue;
      const section = h.closest("section");
      let found: Element[] = [];
      if (section && section.querySelector("h1, h2, h3, h4, h5, h6") === h) found = entriesIn(section);
      if (found.length < 2) {
        const after: Element[] = [];
        for (let el = h.nextElementSibling; el && !/^H[1-6]$/.test(el.tagName); el = el.nextElementSibling) after.push(el);
        const list = after.find((el) => el.matches("ol, ul")) ?? after.map((el) => el.querySelector("ol, ul")).find(Boolean);
        found = list ? [...list.children].filter((c) => c.tagName === "LI") : after.filter((el) => el.matches("p, div") && clean(el.textContent).length > 30);
      }
      if (found.length > entries.length) entries = found;
    }
  }
  if (entries.length >= 1) method = "list";
  // Entries by id alone, wherever they are.
  if (entries.length < 2) {
    const byId = [...doc.querySelectorAll("li[id], div[id], p[id]")].filter((el) => idPattern.test(el.id) && clean(el.textContent).length > 30);
    const outer = byId.filter((el) => !byId.some((o) => o !== el && o.contains(el)));
    if (outer.length >= 2) {
      entries = outer;
      method = "entries";
    }
  }

  const references: WebReference[] = [];
  const elements = new Map<number, Element>();
  for (const el of entries.slice(0, MAX)) {
    const copy = el.cloneNode(true) as Element;
    // Wikipedia's "^ a b" back links and similar jump-back controls are not the reference.
    copy.querySelectorAll('.mw-cite-backlink, .cite-backlink, a[href*="#cite_ref"], [class*="backlink"], .c-article-references__links, .ref-label, .label, button, style, script').forEach((x) => x.remove());
    let text = clean(copy.textContent).replace(/^\^\s*/, "");
    if (text.length < 8) continue;
    if (text.length > 2000) text = text.slice(0, 2000);
    const links = [...el.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    const doiLink = links.find((h) => /doi\.org\/10\./i.test(h));
    const doi = (doiLink && doiOf(doiLink)) || doiOf(text);
    const url = links.find((h) => /^https?:/i.test(h) && !/doi\.org\//i.test(h) && !/[?&](title=|action=)|wikipedia\.org\/wiki\/(special|help):|scholar\.google|pubmed\.ncbi.*term=|worldcat|crossref\.org\/guestquery/i.test(h));
    const titled = el.querySelector('[itemprop="name"], [itemprop="headline"], .citation-title, .ref-title, .article-title, span.title');
    const quoted = text.match(/["“]([^"”]{12,300})[”"]/);
    const italic = clean(el.querySelector("cite i, i, em")?.textContent);
    const title = clean(titled?.textContent) || (quoted ? clean(quoted[1]).replace(/[.,]$/, "") : undefined) || (italic.length >= 12 ? italic : undefined);
    const year = text.match(/\b(1[6-9]\d\d|20\d\d)[a-z]?\b/);
    const authors = [...el.querySelectorAll('[itemprop="author"], .citation-author, .ref-author, .author')].map((a) => clean(a.textContent)).filter(Boolean);
    const anchor = el.id || el.querySelector("[id]")?.id || undefined;
    elements.set(references.length + 1, el);
    references.push({
      number: references.length + 1,
      text,
      ...(anchor ? { anchor } : {}),
      ...(doi ? { doi } : {}),
      ...(url ? { url } : {}),
      ...(title ? { title: title.slice(0, 400) } : {}),
      ...(authors.length ? { authors: authors.slice(0, 20) } : {}),
      ...(year ? { year: Number(year[1]) } : {}),
    });
  }

  // Only Highwire-style meta tags: "citation_title=…; citation_author=…; citation_doi=…".
  if (!references.length) {
    for (const meta of doc.querySelectorAll('meta[name="citation_reference" i]')) {
      const content = meta.getAttribute("content") ?? "";
      const fields = new Map<string, string[]>();
      for (const part of content.split(/;\s*(?=citation_)/)) {
        const at = part.indexOf("=");
        if (at < 0) continue;
        const key = part.slice(0, at).trim().toLowerCase();
        fields.set(key, [...(fields.get(key) ?? []), part.slice(at + 1).trim()]);
      }
      const get = (k: string) => fields.get(k)?.[0];
      const title = get("citation_title");
      const authors = fields.get("citation_author") ?? [];
      const year = (get("citation_publication_date") ?? get("citation_date") ?? get("citation_year") ?? "").match(/\d{4}/);
      const venue = get("citation_journal_title");
      const doi = get("citation_doi") ? doiOf(get("citation_doi")!) ?? get("citation_doi")!.toLowerCase() : undefined;
      const text = clean([authors.join(", "), year ? `(${year[0]})` : "", title, venue].filter(Boolean).join(". ")) || clean(content);
      if (text.length < 8 || references.length >= MAX) continue;
      references.push({ number: references.length + 1, text, ...(doi ? { doi } : {}), ...(title ? { title } : {}), ...(authors.length ? { authors } : {}), ...(year ? { year: Number(year[0]) } : {}) });
    }
    if (references.length) method = "meta";
  }
  // schema.org "citation" in JSON-LD (on the live page; saved copies keep no scripts).
  if (!references.length) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data: unknown;
      try {
        data = JSON.parse(s.textContent ?? "");
      } catch {
        continue;
      }
      const nodes = (Array.isArray(data) ? data : ((data as { "@graph"?: unknown[] })?.["@graph"] ?? [data])) as Record<string, unknown>[];
      for (const node of nodes) {
        for (const c of ([] as unknown[]).concat(node?.citation ?? [])) {
          if (references.length >= MAX) break;
          const item = (typeof c === "string" ? { name: c } : c) as Record<string, unknown>;
          const title = clean(String(item.name ?? item.headline ?? ""));
          const id = String(item.sameAs ?? item["@id"] ?? item.url ?? "");
          const doi = doiOf(id) ?? doiOf(String(item.identifier ?? ""));
          const authors = ([] as unknown[]).concat(item.author ?? []).map((a) => clean(typeof a === "string" ? a : String((a as { name?: string })?.name ?? ""))).filter(Boolean);
          const year = String(item.datePublished ?? "").match(/\d{4}/);
          const text = clean([authors.join(", "), year ? `(${year[0]})` : "", title].filter(Boolean).join(". "));
          if (text.length < 8) continue;
          references.push({ number: references.length + 1, text, ...(doi ? { doi } : {}), ...(title ? { title } : {}), ...(authors.length ? { authors } : {}), ...(year ? { year: Number(year[0]) } : {}), ...(/^https?:/.test(id) && !doi ? { url: id } : {}) });
        }
      }
    }
    if (references.length) method = "json-ld";
  }

  // In-text links to the entries: "#ref-12" (or this page's URL with that fragment).
  const byAnchor = new Map<string, number>();
  elements.forEach((el, number) => {
    if (el.id) byAnchor.set(el.id, number);
    el.querySelectorAll("[id]").forEach((x) => byAnchor.has(x.id) || byAnchor.set(x.id, number));
  });
  const citations: WebReferenceScan["citations"] = [];
  const seen = new Set<string>();
  if (byAnchor.size) {
    const page = (doc.location?.href ?? "").split("#")[0];
    for (const a of doc.querySelectorAll("a[href*='#']")) {
      const href = a.getAttribute("href") ?? "";
      const [base, hash] = [href.slice(0, href.indexOf("#")), href.slice(href.indexOf("#") + 1)];
      if (base && page && base !== page && !page.startsWith("about:")) {
        // A saved copy keeps links absolute: same page is the one its snapshot names.
        const own = doc.querySelector('meta[name="key-snapshot"]')?.getAttribute("content") ?? "";
        if (!own.includes(base.replace(/"/g, ""))) continue;
      }
      let id = hash;
      try {
        id = decodeURIComponent(hash);
      } catch {
        /* as written */
      }
      const number = byAnchor.get(id);
      if (number === undefined || a.closest("li, [role=doc-biblioentry]") && entries.some((el) => el.contains(a))) continue;
      if (!seen.has(id)) {
        seen.add(id);
        citations.push({ anchor: id, numbers: [number] });
      }
    }
  }
  return { references, citations, method: references.length ? method : "none" };
}

/** The references as the library stores an analysis' (key-store's ReferenceInput): what the
 * page says about each seeds its metadata until the lookup answers. */
export function referenceInputs(scan: WebReferenceScan) {
  return scan.references.map((r) => ({
    number: r.number,
    page: null,
    rects: [],
    text: r.text,
    metadata:
      r.title || r.doi
        ? { source: "page", title: r.title ?? r.text, authors: r.authors ?? [], ...(r.year ? { year: r.year } : {}), ...(r.doi ? { doi: r.doi } : {}), ...(r.url ? { landingUrl: r.url } : {}) }
        : null,
  }));
}

/** The detection as a script for a page (run in an isolated world, answers the scan). */
export const WEB_REFERENCES_SCRIPT = `(${detectWebReferences.toString()})(document)`;
