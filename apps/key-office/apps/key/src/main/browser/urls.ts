// What the in-app browser does with a URL, a user agent and a download, without Electron.

/** A page the in-app browser shows: http or https, without credentials in the URL. */
export function webUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Links the system handles (mail, phone): never the browser, never the app. */
export function systemUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return ["mailto:", "tel:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Where a browser page may go by itself: the web, and the blank and data pages it makes. */
export function navigable(value: string) {
  if (webUrl(value)) return true;
  return /^about:blank(#.*)?$/i.test(value);
}

/** The host shown above a page: no "www.", nothing else of the URL. */
export function hostLabel(value: string | undefined) {
  try {
    return value ? new URL(value).hostname.replace(/^www\./i, "") : "";
  } catch {
    return "";
  }
}

/** A Chrome user agent: the Electron and app tokens dropped, so sites treat the browser as Chrome. */
export function browserUserAgent(fallback: string, appName = "Key") {
  const name = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return fallback
    .replace(/\s+Electron\/\S+/gi, "")
    .replace(new RegExp(`\\s+${name}\\/\\S+`, "gi"), "")
    .replace(/\s+@key\/electron\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Whether a download is a PDF, by its type or its name. */
export function looksLikePdf(mime: string | undefined, filename: string | undefined) {
  return /^application\/(x-)?pdf\b/i.test(mime ?? "") || /\.pdf$/i.test(filename ?? "");
}

/** A readable title for a PDF from its file name or URL ("1706.03762v7" from ".../pdf/1706.03762v7"). */
export function pdfTitle(filename: string | undefined, url: string | undefined) {
  const fromName = (filename ?? "").replace(/\.pdf$/i, "").trim();
  if (fromName && !/^(download|file|pdf|document|view)$/i.test(fromName)) return fromName.slice(0, 200);
  try {
    const parts = new URL(url ?? "").pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(parts.at(-1) ?? "").replace(/\.pdf$/i, "");
    if (last && !/^(download|pdf|view|content)$/i.test(last)) return last.slice(0, 200);
    return hostLabel(url) || "PDF";
  } catch {
    return fromName || "PDF";
  }
}

/** A file name safe to save in the Downloads folder. */
export function safeFileName(name: string | undefined) {
  const clean = (name ?? "")
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return clean || "download";
}

/** `name`, or `name (2)`… until `taken` says no. */
export function uniqueName(name: string, taken: (candidate: string) => boolean) {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

/** The PDF a publisher's article page points to (Highwire/Google Scholar meta tag). */
export function citationPdfUrl(html: string, base: string) {
  const tag = html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]*>/i)?.[0];
  const content = tag?.match(/content=["']([^"']+)["']/i)?.[1];
  if (!content) return undefined;
  try {
    return webUrl(new URL(content.replace(/&amp;/g, "&"), base).toString());
  } catch {
    return undefined;
  }
}
