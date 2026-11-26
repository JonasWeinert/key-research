// Display glue for the host's citation engine (key-cite): every citation, bibliography and
// quote attribution in the UI comes from these calls, in the style and locale chosen in
// Settings unless one is passed. The clipboard gets plain text, HTML and RTF.
import { bridge, type Invoke } from "./library-api";

export interface Formatted {
  text: string;
  html: string;
  rtf: string;
}
export interface CiteItem {
  id: string;
  /** "12", "12–14" */
  locator?: string;
  /** page (default), chapter, section, paragraph, figure, … */
  label?: string;
  prefix?: string;
  suffix?: string;
  suppressAuthor?: boolean;
  authorOnly?: boolean;
  narrative?: boolean;
}
export interface Citation {
  items: CiteItem[];
  noteNumber?: number;
}
export interface StyleSummary {
  id: string;
  title: string;
  shortTitle?: string;
  format: "author-date" | "numeric" | "note" | "label" | "author";
  class: "in-text" | "note";
  bundled: boolean;
  parent?: string;
  fields: string[];
  defaultLocale?: string;
}
export interface Rendered {
  citations: Formatted[];
  bibliography?: Formatted & { entries: (Formatted & { id: string })[]; hangingIndent: boolean };
  noteStyle: boolean;
  missing: string[];
  style?: StyleSummary;
}
export interface RenderRequest {
  citations?: Citation[];
  /** A bibliography of these (and of everything cited). */
  ids?: string[];
  bibliography?: boolean;
  /** Works not in the library, in the source shape (a web result). */
  sources?: unknown[];
  style?: string;
  locale?: string;
}

export const renderCitations = (invoke: Invoke, workspaceId: string, request: RenderRequest) =>
  invoke<Rendered>("store_cite_render", { ...request }, workspaceId);

/** One in-text citation: "(Narang et al., 2021, p. 4)". `page` is 0-based like the reader's. */
export async function inTextCitation(invoke: Invoke, workspaceId: string, id: string, options: { page?: number; narrative?: boolean } = {}) {
  const locator = options.page === undefined || options.page < 0 ? undefined : String(options.page + 1);
  const out = await renderCitations(invoke, workspaceId, { citations: [{ items: [{ id, locator, narrative: options.narrative }] }], bibliography: false });
  return out.citations[0];
}

/** Reference list entries for `ids`, in the order the style sorts them. */
export async function bibliography(invoke: Invoke, workspaceId: string, ids: string[], extra: Omit<RenderRequest, "ids"> = {}) {
  const out = await renderCitations(invoke, workspaceId, { ...extra, ids, bibliography: true });
  return out.bibliography;
}

/** Where a quotation is from: "Narang et al., 2021, p. 4" (or the note / reference). */
export const quoteAttribution = (invoke: Invoke, workspaceId: string | undefined, id: string, page?: number) =>
  invoke<Formatted>("store_cite_attribution", { id, page: page === undefined || page < 0 ? null : String(page + 1) }, workspaceId);

export interface StyleList {
  styles: StyleSummary[];
  locales: { code: string; name: string }[];
  folder?: string;
  style: string;
  locale?: string;
  /** The shipped styles and locales (data files beside the app); missing means only Key's basic style. */
  data?: { available: boolean; dir?: string; error?: string; styles: number; locales: number };
}
export const listStyles = (invoke: Invoke, workspaceId?: string) => invoke<StyleList>("store_cite_styles", {}, workspaceId);
export const installStyle = (invoke: Invoke, workspaceId: string | undefined, from: { xml: string } | { url: string }) =>
  invoke<StyleSummary>("store_cite_style_install", from, workspaceId);
export const removeStyle = (invoke: Invoke, workspaceId: string | undefined, id: string) =>
  invoke<{ removed: boolean }>("store_cite_style_remove", { id }, workspaceId);

/** Plain text, HTML and RTF on the clipboard (through the main process; the web clipboard
 *  has no RTF), falling back to what the page can write. */
export async function writeRichClipboard(content: { text: string; html?: string; rtf?: string }) {
  const write = bridge()?.writeClipboard;
  if (write) {
    try {
      await write(content);
      return;
    } catch {
      // A view without the shell's bridge: the web clipboard below.
    }
  }
  try {
    const parts: Record<string, Blob> = { "text/plain": new Blob([content.text], { type: "text/plain" }) };
    if (content.html) parts["text/html"] = new Blob([content.html], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  } catch {
    await navigator.clipboard.writeText(content.text);
  }
}

/** Text as RTF: control characters escaped, everything past ASCII as \\uN?. */
export function rtfText(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const code = text.charCodeAt(i);
    if (c === "\\" || c === "{" || c === "}") out += `\\${c}`;
    else if (c === "\n") out += "\\line ";
    else if (code < 128) out += c;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
}

/** One RTF document of several RTF fragments (citations are fragments, entries too). */
export function rtfDocument(fragments: string[]) {
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24\n${fragments.map((f) => `{\\pard\\sa120 ${f}\\par}`).join("\n")}}`;
}

// Formatted references for drags out of the library: a drag's data must be set while the
// drag starts, so rows render theirs when pressed and the drag reads them here.
const prepared = new Map<string, { at: number; value: Formatted }>();
const preparedKey = (workspaceId: string, ids: string[]) => `${workspaceId}\u0000${ids.join("\u0001")}`;
export function prepareReferences(invoke: Invoke, workspaceId: string, ids: string[]) {
  if (!ids.length) return;
  const key = preparedKey(workspaceId, ids);
  const hit = prepared.get(key);
  if (hit && Date.now() - hit.at < 30_000) return;
  void bibliography(invoke, workspaceId, ids)
    .then((bib) => {
      if (!bib) return;
      prepared.set(key, { at: Date.now(), value: { text: bib.text, html: bib.html, rtf: bib.rtf } });
      if (prepared.size > 50) prepared.delete(prepared.keys().next().value!);
    })
    .catch(() => {});
}
export const preparedReferences = (workspaceId: string, ids: string[]) => prepared.get(preparedKey(workspaceId, ids))?.value;
