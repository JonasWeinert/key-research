// Publisher online readers and PDF viewers: pages that only wrap a PDF. The browser goes to
// the PDF itself instead (it downloads and opens in the app's reader). One rule per kind of
// viewer; add a rule here for a new one.
import { webUrl } from "./urls";

export interface ReaderRule {
  name: string;
  /** The PDF behind a viewer at `url`, or undefined when `url` is not one of its viewers. */
  pdf(url: URL): string | undefined;
}

const DOI_PATH = /^\/doi\/(?:epdf|reader|epub|full-pdf|pdfplus)\/(10\.\d{4,9}\/.+)$/i;
const absolute = (value: string | null | undefined, base: URL) => {
  if (!value) return undefined;
  try {
    return webUrl(new URL(value, base).toString());
  } catch {
    return undefined;
  }
};

export const READER_RULES: ReaderRule[] = [
  {
    // pdf.js viewers (`…/web/viewer.html?file=…`, `/pdfjs/…?file=…`) and similar `?file=` viewers.
    name: "pdf.js viewer",
    pdf(url) {
      if (!/(viewer(\.html?)?|pdfjs[^/]*|pdfviewer[^/]*|\/web\/?)$/i.test(url.pathname) && !/\/pdfjs\//i.test(url.pathname)) return undefined;
      return absolute(url.searchParams.get("file") ?? new URLSearchParams(url.hash.slice(1)).get("file"), url);
    },
  },
  {
    // Google's and Microsoft's document viewers: the document is a parameter.
    name: "docs viewer",
    pdf(url) {
      if (url.hostname === "docs.google.com" && /^\/(viewer|gview)$/.test(url.pathname)) return absolute(url.searchParams.get("url"), url);
      return undefined;
    },
  },
  {
    // Wiley's ePDF reader: its direct PDF.
    name: "Wiley ePDF",
    pdf(url) {
      if (!/(^|\.)wiley\.com$/i.test(url.hostname)) return undefined;
      const doi = url.pathname.match(DOI_PATH)?.[1];
      return doi ? `${url.origin}/doi/pdfdirect/${doi}?download=true` : undefined;
    },
  },
  {
    // Atypon platforms (Taylor & Francis, SAGE, ACS, ACM, AMS, Annual Reviews…): /doi/epdf|reader/… → /doi/pdf/….
    name: "Atypon reader",
    pdf(url) {
      const doi = url.pathname.match(DOI_PATH)?.[1];
      return doi ? `${url.origin}/doi/pdf/${doi}?download=true` : undefined;
    },
  },
  {
    // Elsevier's reader: the ScienceDirect PDF of the same article.
    name: "Elsevier reader",
    pdf(url) {
      if (url.hostname !== "reader.elsevier.com") return undefined;
      const pii = url.pathname.match(/\/pii\/([A-Z0-9]+)/i)?.[1];
      return pii ? `https://www.sciencedirect.com/science/article/pii/${pii}/pdfft?isDTMRedirect=true&download=true` : undefined;
    },
  },
  {
    // ScienceDirect's in-page PDF view (`…/pii/X/pdf`): the download link (`pdfft`).
    name: "ScienceDirect",
    pdf(url) {
      if (!/(^|\.)sciencedirect\.com$/i.test(url.hostname)) return undefined;
      const pii = url.pathname.match(/^\/science\/article\/(?:abs\/)?pii\/([A-Z0-9]+)\/pdf$/i)?.[1];
      return pii ? `${url.origin}/science/article/pii/${pii}/pdfft?isDTMRedirect=true&download=true` : undefined;
    },
  },
  {
    // IEEE Xplore's frame around a PDF.
    name: "IEEE stamp",
    pdf(url) {
      if (!/(^|\.)ieeexplore\.ieee\.org$/i.test(url.hostname) || !/^\/stamp\/stamp\.jsp$/i.test(url.pathname)) return undefined;
      const number = url.searchParams.get("arnumber");
      return number ? `${url.origin}/stampPDF/getPDF.jsp?tp=&arnumber=${encodeURIComponent(number)}` : undefined;
    },
  },
  {
    // Springer's and Nature's ePDF reader (`/epdf/…`) for a DOI: the PDF of that DOI.
    name: "Springer Nature ePDF",
    pdf(url) {
      if (/(^|\.)link\.springer\.com$/i.test(url.hostname)) {
        const doi = url.pathname.match(/^\/(?:epdf|content\/epdf)\/(10\.\d{4,9}\/.+?)(?:\.pdf)?$/i)?.[1];
        return doi ? `${url.origin}/content/pdf/${doi}.pdf` : undefined;
      }
      if (/(^|\.)nature\.com$/i.test(url.hostname)) {
        const id = url.pathname.match(/^\/articles\/([^/]+)\.epdf$/i)?.[1];
        return id ? `${url.origin}/articles/${id}.pdf` : undefined;
      }
      return undefined;
    },
  },
];

/** The PDF behind a viewer or online reader at `value`, if it is one (and not the PDF itself). */
export function pdfBehindViewer(value: string, rules = READER_RULES): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!webUrl(value)) return undefined;
  for (const rule of rules) {
    const pdf = rule.pdf(url);
    if (pdf && pdf !== url.toString()) return pdf;
  }
  return undefined;
}
