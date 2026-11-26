// Saves a browser tab's page as one self-contained HTML file: the DOM as it is now, with
// scripts, frames, plugins and event handlers removed, stylesheets and images inlined as
// data, and a Content-Security-Policy that blocks any network access when it is shown.
import type { WebContents } from "electron";
import { browserSession } from "./profile";

export interface PageMeta {
  title: string;
  url: string;
  canonical?: string;
  site?: string;
  authors: string[];
  date?: string;
  doi?: string;
  description?: string;
  language?: string;
  type?: string;
}
export interface PageSnapshot {
  html: string;
  meta: PageMeta;
  capturedAt: string;
}

/** What a snapshot shows with: no scripts, no requests, only inlined data. */
export const SNAPSHOT_CSP = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:; form-action 'none'";

// Runs in an isolated world of the page (the page's own scripts cannot interfere): answers
// the cleaned DOM with resource URLs replaced by tokens, the URLs, and the page's metadata.
const COLLECT = String.raw`(() => {
  const resources = [], seen = new Map();
  const res = (raw, base) => {
    if (!raw) return "";
    raw = String(raw).trim();
    if (/^data:/i.test(raw)) return raw;
    let url; try { url = new URL(raw, base || document.baseURI).href; } catch { return ""; }
    if (!/^https?:/i.test(url)) return "";
    let i = seen.get(url); if (i === undefined) { i = resources.length; resources.push(url); seen.set(url, i); }
    return "key-res:" + i;
  };
  const css = (text, base) => text.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => /^data:/i.test(u) || /^#/.test(u) ? m : 'url("' + res(u, base) + '")');
  const sheets = [];
  const live = [...document.querySelectorAll("style, link[rel~=stylesheet]")];
  const liveImages = [...document.querySelectorAll("img")];
  const liveCanvases = [...document.querySelectorAll("canvas")];
  const root = document.documentElement.cloneNode(true);
  // Stylesheets: a <style>'s rules as the page has them now (CSS-in-JS fills them by script),
  // a linked one by its URL, fetched with the profile afterwards.
  [...root.querySelectorAll("style, link[rel~=stylesheet]")].forEach((el, i) => {
    const from = live[i];
    const style = document.createElement("style");
    if (from && from.media) style.setAttribute("media", from.media);
    if (from && from.tagName === "LINK") {
      if (from.disabled) { el.remove(); return; }
      let href; try { href = new URL(from.getAttribute("href"), document.baseURI).href; } catch {}
      if (!href || !/^https?:/.test(href)) { el.remove(); return; }
      sheets.push(href);
      style.textContent = "key-css:" + (sheets.length - 1);
    } else {
      let text = "";
      try { text = [...from.sheet.cssRules].map((r) => r.cssText).join("\n"); } catch { text = from ? from.textContent : ""; }
      style.textContent = css(text || "", document.baseURI);
    }
    el.replaceWith(style);
  });
  [...root.querySelectorAll("img")].forEach((el, i) => {
    const from = liveImages[i];
    const src = (from && (from.currentSrc || from.src)) || el.getAttribute("data-src") || el.getAttribute("src");
    el.setAttribute("src", res(src));
    for (const a of ["srcset", "sizes", "loading", "decoding", "data-src", "data-srcset"]) el.removeAttribute(a);
  });
  [...root.querySelectorAll("canvas")].forEach((el, i) => {
    try { const img = document.createElement("img"); img.src = liveCanvases[i].toDataURL(); img.width = liveCanvases[i].width; img.style.cssText = el.style.cssText; el.replaceWith(img); } catch { el.remove(); }
  });
  root.querySelectorAll("script, noscript, iframe, frame, frameset, object, embed, applet, portal, base, template, meta[http-equiv], link, picture > source, video > source, audio > source, track").forEach((el) => el.remove());
  root.querySelectorAll("video, audio").forEach((el) => { el.removeAttribute("src"); el.removeAttribute("autoplay"); if (el.hasAttribute("poster")) el.setAttribute("poster", res(el.getAttribute("poster"))); });
  root.querySelectorAll("[style]").forEach((el) => el.setAttribute("style", css(el.getAttribute("style"), document.baseURI)));
  root.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || ((n === "href" || n === "src" || n === "action" || n === "formaction" || n === "xlink:href") && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  });
  root.querySelectorAll("a[href]").forEach((el) => { try { el.setAttribute("href", new URL(el.getAttribute("href"), document.baseURI).href); } catch { el.removeAttribute("href"); } el.removeAttribute("target"); el.removeAttribute("ping"); });
  root.querySelectorAll("svg image[href], svg use[href]").forEach((el) => { const v = el.getAttribute("href"); if (v && !v.startsWith("#")) el.setAttribute("href", res(v)); });
  root.querySelectorAll("form").forEach((el) => el.removeAttribute("action"));
  root.querySelectorAll("input").forEach((el) => el.removeAttribute("autofocus"));
  // Metadata from the tags scholarly sites and publishers use, then Open Graph, then JSON-LD.
  const metas = (...names) => names.flatMap((n) => [...document.querySelectorAll('meta[name="' + n + '" i], meta[property="' + n + '" i]')].map((m) => (m.getAttribute("content") || "").trim()).filter(Boolean));
  const first = (...names) => metas(...names)[0];
  let ld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { const d = JSON.parse(s.textContent); ld.push(...(Array.isArray(d) ? d : d["@graph"] || [d])); } catch {} }
  const article = ld.find((d) => d && /Article|Posting|Report|WebPage|Blog/i.test([].concat(d["@type"] || []).join(" ")));
  const ldAuthors = article ? [].concat(article.author || []).map((a) => (typeof a === "string" ? a : a && a.name) || "").filter(Boolean) : [];
  let authors = metas("citation_author", "dc.creator", "dcterms.creator");
  if (!authors.length) authors = ldAuthors;
  if (!authors.length) authors = metas("author", "article:author", "parsely-author", "sailthru.author").filter((a) => !/^https?:/.test(a));
  const doiText = first("citation_doi", "dc.identifier", "prism.doi", "bepress_citation_doi") || "";
  const doiMatch = (doiText + " " + location.href).match(/10\.\d{4,9}\/[^\s"'<>?#]+/);
  const canonical = document.querySelector('link[rel="canonical"]');
  return {
    html: "<!doctype html>\n" + root.outerHTML,
    resources, sheets,
    meta: {
      title: (first("citation_title", "og:title", "twitter:title") || document.title || "").trim(),
      url: location.href,
      canonical: canonical ? canonical.href : undefined,
      site: first("og:site_name", "citation_journal_title", "application-name") || (article && article.publisher && article.publisher.name) || undefined,
      authors: [...new Set(authors)].slice(0, 40),
      date: first("citation_publication_date", "citation_date", "article:published_time", "dc.date", "dcterms.date", "date", "parsely-pub-date") || (article && article.datePublished) || undefined,
      doi: doiMatch ? doiMatch[0].replace(/[.,;)]+$/, "") : undefined,
      description: first("citation_abstract", "description", "og:description", "dc.description") || undefined,
      language: document.documentElement.lang || undefined,
      type: first("og:type") || undefined,
    },
  };
})()`;

const ITEM_LIMIT = 8 * 1024 * 1024;
const TOTAL_LIMIT = 48 * 1024 * 1024;

/** Fetches with the browser profile (its cookies and logins), as data. */
async function fetchData(url: string, budget: { left: number }): Promise<{ type: string; bytes: Buffer } | undefined> {
  try {
    const response = await browserSession().fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > ITEM_LIMIT || bytes.length > budget.left) return undefined;
    budget.left -= bytes.length;
    return { type: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim(), bytes };
  } catch {
    return undefined;
  }
}
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]);
      }
    }),
  );
  return out;
}
const dataUrl = (file: { type: string; bytes: Buffer }) => `data:${file.type};base64,${file.bytes.toString("base64")}`;

/** A stylesheet's text with its imports inlined and what it refers to (fonts, images) as data. */
async function inlineCss(text: string, base: string, budget: { left: number }, depth = 0): Promise<string> {
  const imports: { match: string; url: string }[] = [];
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi)) {
    try {
      imports.push({ match: m[0], url: new URL(m[2], base).href });
    } catch {
      /* not a URL */
    }
  }
  for (const item of imports) {
    const file = depth < 3 ? await fetchData(item.url, budget) : undefined;
    text = text.replace(item.match, file ? await inlineCss(file.bytes.toString("utf8"), item.url, budget, depth + 1) : "");
  }
  const refs = new Map<string, string>();
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (/^(data:|#)/i.test(m[2]) || !m[2]) continue;
    try {
      refs.set(m[2], new URL(m[2], base).href);
    } catch {
      /* not a URL */
    }
  }
  const unique = [...new Set(refs.values())];
  const files = await mapLimit(unique, 6, (url) => fetchData(url, budget));
  const found = new Map(unique.map((url, i) => [url, files[i] && dataUrl(files[i]!)]));
  return text.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q, raw) => {
    if (/^(data:|#)/i.test(raw) || !raw) return whole;
    const data = found.get(refs.get(raw) ?? "");
    return data ? `url("${data}")` : "url()";
  });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Captures `contents`' page as it shows now. */
export async function capturePage(contents: WebContents): Promise<PageSnapshot> {
  const collected = (await contents.executeJavaScriptInIsolatedWorld(1999, [{ code: COLLECT }], false)) as {
    html: string;
    resources: string[];
    sheets: string[];
    meta: PageMeta;
  };
  const budget = { left: TOTAL_LIMIT };
  const sheets = await mapLimit(collected.sheets, 4, async (url) => {
    const file = await fetchData(url, budget);
    return file ? inlineCss(file.bytes.toString("utf8"), url, budget) : "";
  });
  const files = await mapLimit(collected.resources, 6, (url) => fetchData(url, budget));
  const capturedAt = new Date().toISOString();
  let html = collected.html
    .replace(/key-css:(\d+)/g, (_m, i) => (sheets[Number(i)] ?? "").replace(/<\/style/gi, "<\\/style"))
    .replace(/key-res:(\d+)/g, (_m, i) => {
      const file = files[Number(i)];
      return file && /^(image|font|application\/font|application\/x-font|video|audio)/.test(file.type) ? dataUrl(file) : "";
    });
  // In case anything slipped through: no scripts, whatever the markup did.
  html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">` +
    `<meta name="key-snapshot" content="${escape(JSON.stringify({ url: collected.meta.url, capturedAt }))}">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : head + html;
  return { html, meta: collected.meta, capturedAt };
}
