// "Cite" in the PDF reader copies a passage as a quote. Inside Key it pastes as a source quote
// that links back to the page; anywhere else as plain text, attributed in the citation style
// chosen in Settings (the host's citation engine formats `attribution`):
//   “quoted text” — Narang et al., 2021, p. 4
// The clipboard carries three forms: a custom type with the whole quote (read by notes when
// Chromium keeps it), HTML whose blockquote holds the same data in an attribute (survives
// when custom types are dropped), and the plain text above.

export const QUOTE_MIME = "application/x-key-quote+json";
const ATTRIBUTE = "data-key-quote";

export interface QuotePayload {
  v: 1;
  text: string;
  workspaceId?: string;
  sourceId?: string;
  documentHash: string;
  /** 0-based; -1 for a source without pages (a saved web page). */
  page: number;
  /** On `page`, [x, y, width, height] in 0–65535 of the page. */
  rects: number[][];
  color?: string;
  citation: { authors: string[]; year?: number | string; title?: string };
  /** Where the quote is from, formatted by the citation engine in the chosen style. */
  attribution?: string;
}

/** "Narang", "Narang & Bae", "Narang et al." */
export function authorPhrase(authors: string[]) {
  const names = authors.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

/** The passage on one line, as it is quoted. */
export function quoteBody(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where the quote is from: the engine's attribution, or for a passage from outside the
 *  library "Narang et al. (2021), Title, p. 4", leaving out what is unknown. */
export function quoteAttribution(quote: Pick<QuotePayload, "citation" | "page" | "attribution">) {
  if (quote.attribution?.trim()) return quote.attribution.trim();
  const who = authorPhrase(quote.citation.authors);
  const year = quote.citation.year ? String(quote.citation.year) : "";
  const head = who && year ? `${who} (${year})` : who || (year ? `(${year})` : "");
  const title = quote.citation.title?.trim().replace(/\.$/, "");
  return [head, title, Number.isFinite(quote.page) && quote.page >= 0 ? `p. ${quote.page + 1}` : ""].filter(Boolean).join(", ");
}

export function quotePlainText(quote: QuotePayload) {
  const attribution = quoteAttribution(quote);
  return `“${quoteBody(quote.text)}”${attribution ? ` — ${attribution}` : ""}`;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function quoteHtml(quote: QuotePayload) {
  const attribution = quoteAttribution(quote);
  return (
    `<blockquote ${ATTRIBUTE}="${escapeHtml(JSON.stringify(quote))}"><p>${escapeHtml(quoteBody(quote.text))}</p>` +
    (attribution ? `<p>— ${escapeHtml(attribution)}</p>` : "") +
    `</blockquote>`
  );
}

/** A quote payload, checked: null for anything else. */
export function parseQuotePayload(value: unknown): QuotePayload | null {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const q = data as Partial<QuotePayload> | null;
  if (!q || typeof q !== "object" || q.v !== 1) return null;
  if (typeof q.text !== "string" || !q.text.trim() || typeof q.documentHash !== "string") return null;
  if (typeof q.page !== "number" || !Number.isFinite(q.page)) return null;
  return {
    v: 1,
    text: q.text,
    workspaceId: typeof q.workspaceId === "string" ? q.workspaceId : undefined,
    sourceId: typeof q.sourceId === "string" ? q.sourceId : undefined,
    documentHash: q.documentHash,
    page: q.page,
    rects: Array.isArray(q.rects) ? q.rects.filter((r): r is number[] => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)) : [],
    color: typeof q.color === "string" ? q.color : undefined,
    attribution: typeof q.attribution === "string" ? q.attribution : undefined,
    citation: {
      authors: Array.isArray(q.citation?.authors) ? q.citation!.authors.filter((a): a is string => typeof a === "string") : [],
      year: q.citation?.year,
      title: typeof q.citation?.title === "string" ? q.citation.title : undefined,
    },
  };
}

/** The quote in pasted HTML: the marker attribute, decoded by the browser's parser. */
export function quoteFromHtml(html: string): QuotePayload | null {
  if (!html.includes(ATTRIBUTE)) return null;
  const element = new DOMParser().parseFromString(html, "text/html").querySelector(`[${ATTRIBUTE}]`);
  return element ? parseQuotePayload(element.getAttribute(ATTRIBUTE)) : null;
}

/** The quote a paste or drop carries, from the custom type or the HTML marker. */
export function readQuote(data: Pick<DataTransfer, "getData"> | null | undefined): QuotePayload | null {
  if (!data) return null;
  return parseQuotePayload(data.getData(QUOTE_MIME) || "null") ?? quoteFromHtml(data.getData("text/html") || "");
}

/**
 * Puts the quote on the clipboard in all three forms. A copy event is the one way a page can
 * write a custom type that Chromium hands back on paste; when the document cannot run one
 * (no focus), the async clipboard writes the HTML and plain forms.
 */
export async function writeQuoteClipboard(quote: QuotePayload): Promise<void> {
  const plain = quotePlainText(quote);
  const html = quoteHtml(quote);
  let written = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", plain);
    event.clipboardData.setData("text/html", html);
    event.clipboardData.setData(QUOTE_MIME, JSON.stringify(quote));
    written = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
  if (written) return;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}
