// What a loaded browser page is, read from its DOM once it has loaded: a scholarly article
// (its DOI, title and PDF), a page that only shows an embedded PDF, or a bot check.

export interface ScholarlyArticle {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  /** The article's PDF, when the page names one (citation_pdf_url). */
  pdfUrl?: string;
}
export interface PageScan {
  article?: ScholarlyArticle;
  /** A PDF embedded as the page's main content (an embed, object or iframe filling it). */
  embeddedPdf?: string;
  /** Frames filling the page with no sign of a PDF in their markup (one may have loaded one). */
  bigFrames?: string[];
  /** A Cloudflare (or similar) "checking your browser" page. */
  challenge?: boolean;
}

/** Runs in the page (isolated world): plain data out, nothing kept. */
export const SCAN_SCRIPT = `(() => {
  const meta = (...names) => {
    for (const name of names) {
      const el = document.querySelector('meta[name="' + name + '" i], meta[property="' + name + '" i]');
      const value = el && el.getAttribute("content");
      if (value && value.trim()) return value.trim();
    }
  };
  const all = (name) => [...document.querySelectorAll('meta[name="' + name + '" i]')].map((m) => (m.getAttribute("content") || "").trim()).filter(Boolean);
  let ld;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "null");
      const items = [].concat(data && data["@graph"] ? data["@graph"] : data);
      ld = items.find((i) => i && /ScholarlyArticle/.test([].concat(i["@type"]).join(" ")));
      if (ld) break;
    } catch {}
  }
  const ldDoi = ld && [].concat(ld.doi || ld.identifier || [], ld.sameAs || []).map((x) => typeof x === "string" ? x : x && (x.value || x["@id"])).find((x) => /10\\.\\d{4,9}\\//.test(x || ""));
  const doi = meta("citation_doi", "dc.identifier", "dc.Identifier", "prism.doi", "bepress_citation_doi", "eprints.id_number") || ldDoi;
  const title = meta("citation_title", "dc.title", "DC.title", "eprints.title") || (ld && (ld.headline || ld.name));
  const pdf = meta("citation_pdf_url", "eprints.document_url");
  const date = meta("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "prism.publicationDate") || (ld && ld.datePublished) || "";
  const year = Number((String(date).match(/(1[5-9]|20)\\d\\d/) || [])[0]) || undefined;
  const article = (doi && /10\\.\\d{4,9}\\//.test(doi)) || (title && (pdf || all("citation_author").length)) ? {
    doi, title, pdfUrl: pdf && new URL(pdf, location.href).href, year,
    authors: all("citation_author").slice(0, 100),
    venue: meta("citation_journal_title", "citation_conference_title", "prism.publicationName", "dc.source"),
  } : undefined;
  // An embedded PDF that is the page: it covers most of the window.
  const area = innerWidth * innerHeight || 1;
  // The document itself is a PDF (a blob or data PDF the tab went to).
  let embeddedPdf = /pdf/i.test(document.contentType || "") ? location.href : undefined;
  const bigFrames = [];
  if (!embeddedPdf) for (const el of document.querySelectorAll("embed, object, iframe")) {
    const src = el.getAttribute(el.tagName === "OBJECT" ? "data" : "src") || "";
    const r = el.getBoundingClientRect();
    if (!src || r.width * r.height < area * 0.5) continue;
    const href = new URL(src, location.href).href;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type.includes("pdf") || /\\.pdf([?#]|$)/i.test(src) || (el.tagName !== "IFRAME" && /^blob:|^data:application\\/pdf/i.test(src))) {
      embeddedPdf = href;
      break;
    }
    if (/^https?:/i.test(href)) bigFrames.push(href);
  }
  const challenge = /^(just a moment|attention required|one more step|checking your browser)/i.test(document.title) || !!document.querySelector("#challenge-form, #challenge-stage, #cf-challenge-running, script[src*='/cdn-cgi/challenge-platform/']");
  return { article, embeddedPdf, bigFrames: bigFrames.slice(0, 4), challenge };
})()`;

/** A bare DOI ("10.x/y") from a DOI, a doi.org link or a "doi:" string. */
export function bareDoiOf(value: string | undefined) {
  const match = String(value ?? "")
    .trim()
    .match(/(10\.\d{4,9}\/[^\s"<>]+)/);
  return match ? decodeURIComponent(match[1]).replace(/[.,;]+$/, "") : undefined;
}

/** The DOI a doi.org link resolves, if `url` is one. */
export function doiOfResolverUrl(url: string | undefined) {
  try {
    const parsed = new URL(url ?? "");
    if (!/^(dx\.)?doi\.org$/i.test(parsed.hostname)) return undefined;
    return bareDoiOf(decodeURIComponent(parsed.pathname.slice(1)));
  } catch {
    return undefined;
  }
}

/** The scan as main keeps it: a DOI from the doi.org link the tab came through fills a gap. */
export function cleanScan(raw: unknown, viaDoi?: string): PageScan {
  const value = (raw ?? {}) as PageScan;
  const a = value.article;
  const doi = bareDoiOf(a?.doi) ?? viaDoi;
  const article: ScholarlyArticle | undefined =
    a || doi
      ? {
          doi,
          title: typeof a?.title === "string" ? a.title.slice(0, 500) : undefined,
          authors: Array.isArray(a?.authors) ? a.authors.filter((x) => typeof x === "string").slice(0, 100) : undefined,
          year: typeof a?.year === "number" ? a.year : undefined,
          venue: typeof a?.venue === "string" ? a.venue.slice(0, 300) : undefined,
          pdfUrl: typeof a?.pdfUrl === "string" ? a.pdfUrl : undefined,
        }
      : undefined;
  return {
    article,
    embeddedPdf: typeof value.embeddedPdf === "string" ? value.embeddedPdf : undefined,
    bigFrames: Array.isArray(value.bigFrames) ? value.bigFrames.filter((x) => typeof x === "string") : undefined,
    challenge: value.challenge === true,
  };
}
