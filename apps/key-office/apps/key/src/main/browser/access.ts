// Whether a publisher let this network in: read from what a direct request answered (its
// status, where it redirected, what kind of thing came back) and, for a page, from what the
// page shows once loaded (sign-in links, "get access" buttons, access meta tags, schema.org's
// isAccessibleForFree). No Electron here; the browser feeds it plain data.
//
// "granted" means the full text (or the PDF) came back; "denied" means the publisher wants a
// sign-in, a purchase or an institution; "unknown" is everything else (a home page, a bot
// check, a captive portal, a server error), which is never learned from.

export type Access = "granted" | "denied" | "unknown";
export interface AccessVerdict {
  access: Access;
  /** In words, for the bar and the settings list. */
  reason: string;
  /** The answer says something about this network's entitlement (an open-access article
   * loading says nothing: it loads everywhere). */
  telling: boolean;
}

const verdict = (access: Access, reason: string, telling = access !== "unknown"): AccessVerdict => ({ access, reason, telling });
export const UNKNOWN = verdict("unknown", "");

/** Where a sign-in, a paywall or a purchase page lives. Extend here: `host` is tested on the
 * host name, `path` on the path with its query. */
export const SIGN_IN_PATTERNS: { host?: RegExp; path?: RegExp; reason: string }[] = [
  { path: /\/action\/(showLogin|ssostart|showPurchase|showAccess)/i, reason: "sent to a sign-in page" },
  { host: /(^|[.-])(idp|sso|wayf|login|signin|auth|shibboleth)[.-]/i, reason: "sent to a sign-in service" },
  { host: /(^|\.)(openathens\.net|myopenathens\.net|seamlessaccess\.org|wayf\.[a-z.]+)$/i, reason: "sent to an institution sign-in" },
  { path: /shibboleth|\/Shibboleth\.sso\b|\/wayf\b|\/idp\//i, reason: "sent to an institution sign-in" },
  { path: /\/(login|signin|sign-in|log-in|sso|cas\/login|institutional-login)(\/|\?|$)/i, reason: "sent to a sign-in page" },
  { path: /\/(purchase|checkout|buy|paywall|subscribe|get-?access|request-?access|access-?options)(\/|\?|$)/i, reason: "sent to a purchase page" },
];

const parse = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/** Why `url` is a sign-in or purchase page, or undefined when it does not look like one. */
export function signInPage(url: string) {
  const at = parse(url);
  if (!at) return undefined;
  const path = `${at.pathname}${at.search}`;
  return SIGN_IN_PATTERNS.find((p) => (!p.host || p.host.test(at.hostname)) && (!p.path || p.path.test(path)) && (p.host || p.path))?.reason;
}

/** The same site: one host the other's subdomain or equal (www.x.org and x.org). */
export function sameSite(a: string, b: string) {
  const x = a.toLowerCase().replace(/^www\./, "");
  const y = b.toLowerCase().replace(/^www\./, "");
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

export interface ResponseFacts {
  /** The address the response is for. */
  url: string;
  status: number;
  /** Where a redirect goes. */
  location?: string;
  contentType?: string;
  /** The request asked for a PDF. */
  wantPdf?: boolean;
}

/** One HTTP answer to a direct request. A redirect that is not to a sign-in is "unknown":
 * where it ends decides. */
export function classifyResponse(facts: ResponseFacts): AccessVerdict {
  const { status } = facts;
  if (status === 401) return verdict("denied", "asked for a sign-in (HTTP 401)");
  if (status === 402) return verdict("denied", "asked for payment (HTTP 402)");
  if (status === 403) return verdict("denied", "refused access (HTTP 403)");
  if (status >= 300 && status < 400) {
    const next = facts.location ? parse(facts.location) ?? parse(new URL(facts.location, facts.url).toString()) : undefined;
    const why = next && signInPage(next.toString());
    return why ? verdict("denied", why) : UNKNOWN;
  }
  if (status < 200 || status >= 300) return UNKNOWN;
  const why = signInPage(facts.url);
  if (why) return verdict("denied", why);
  const type = (facts.contentType ?? "").toLowerCase();
  if (facts.wantPdf) {
    if (/pdf|octet-stream/.test(type)) return verdict("granted", "sent the PDF");
    if (/html/.test(type)) return verdict("denied", "answered the PDF with a web page");
  }
  return UNKNOWN;
}

/** What the page script reads (see PAGE_ACCESS_SCRIPT). */
export interface PageFacts {
  url: string;
  title: string;
  /** Meta tags by lower-case name: citation_pdf_url, access, citation_access, dc.rights… */
  meta: Record<string, string>;
  /** schema.org's isAccessibleForFree on the page's JSON-LD, when it says. */
  free?: boolean;
  /** The start of the page's visible text, lower case. */
  text: string;
  /** Links and buttons' text and targets, lower case (a few dozen). */
  actions: string[];
  /** A password field. */
  password: boolean;
  /** A Creative Commons licence link. */
  openLicence: boolean;
}

/** Words publishers put on a paywall. Extend here. */
export const PAYWALL_PHRASES: RegExp[] = [
  /\bget access\b/,
  /\bpurchase (this |the )?(article|chapter|pdf|access)\b/,
  /\bbuy (this |the )?(article|chapter|pdf|issue)\b/,
  /\brent (this |the )?article\b/,
  /\baccess (it )?through your (institution|library|organi[sz]ation)\b/,
  /\b(sign|log) ?in (through|via) your (institution|library|organi[sz]ation)\b/,
  /\binstitutional (login|sign[ -]?in|access)\b/,
  /\bcheck (for )?access\b/,
  /\byou (do not|don['’]t) have access\b/,
  /\bpreview of subscription content\b/,
  /\bsubscribe (now )?to (read|continue|access)\b/,
  /\bthis (content|article) is (only )?available (to|for) (subscribers|members)\b/,
  /\baccess options\b/,
  /\bfull (text )?access to this article\b/,
];
/** Meta tags some publishers set to say whether this reader may read it. */
const ACCESS_META = ["access", "citation_access", "dc.rights.accessrights", "access_level"];

/** A page loaded directly: is it the full text, a paywall, or neither? */
export function classifyPage(page: PageFacts): AccessVerdict {
  const why = signInPage(page.url);
  if (why) return verdict("denied", why);
  for (const name of ACCESS_META) {
    const value = page.meta[name]?.trim().toLowerCase();
    if (!value) continue;
    if (/^(no|false|restricted|subscription|denied|abstract|none)$/.test(value)) return verdict("denied", "says this reader has no access");
    if (/^(yes|true|full|entitled|granted)$/.test(value)) return verdict("granted", "says this reader has access");
  }
  const markers = PAYWALL_PHRASES.filter((p) => p.test(page.text) || page.actions.some((a) => p.test(a))).length + (page.actions.some((a) => !!signInPage(a)) ? 1 : 0);
  const pdf = !!page.meta.citation_pdf_url;
  const open = page.openLicence || page.free === true;
  if (page.free === false && markers) return verdict("denied", "shows a paywall");
  if (markers >= 2 || (markers && !pdf && !open)) return verdict("denied", "asks you to sign in or buy access");
  if (page.password && !pdf && /sign ?in|log ?in|password/i.test(page.title)) return verdict("denied", "asks you to sign in");
  const article = pdf || !!page.meta.citation_fulltext_html_url || (!!page.meta.citation_title && page.text.length > 2500);
  if (article) return verdict("granted", open ? "is open access" : "showed the full text", !open);
  return UNKNOWN;
}

/** Runs in the page (isolated world): what classifyPage reads, plain data out. */
export const PAGE_ACCESS_SCRIPT = `(() => {
  const meta = {};
  for (const m of document.querySelectorAll("meta[name], meta[property]")) {
    const name = (m.getAttribute("name") || m.getAttribute("property") || "").toLowerCase();
    if (name && !(name in meta)) meta[name] = (m.getAttribute("content") || "").slice(0, 400);
  }
  let free;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "null");
      for (const item of [].concat(data && data["@graph"] ? data["@graph"] : data)) {
        const value = item && item.isAccessibleForFree;
        if (value !== undefined) free = value === true || String(value).toLowerCase() === "true";
      }
    } catch {}
  }
  const actions = [...document.querySelectorAll("a[href], button")].slice(0, 400)
    .map((el) => ((el.textContent || "").trim().slice(0, 80) + " " + (el.getAttribute("href") ? new URL(el.getAttribute("href"), location.href).href : "")).toLowerCase())
    .filter((s) => /access|sign|log ?in|purchase|buy|rent|subscri|institution|showlogin|shibboleth|openathens|wayf|idp/.test(s))
    .slice(0, 40);
  return {
    url: location.href,
    title: document.title || "",
    meta,
    free,
    text: ((document.body && document.body.innerText) || "").slice(0, 6000).toLowerCase(),
    actions,
    password: !!document.querySelector('input[type="password"]'),
    openLicence: !!document.querySelector('a[href*="creativecommons.org/licenses"], link[href*="creativecommons.org/licenses"]'),
  };
})()`;

/** A page script's answer, checked (never trusted as it came). */
export function pageFacts(value: unknown): PageFacts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.url !== "string") return undefined;
  const meta: Record<string, string> = {};
  if (v.meta && typeof v.meta === "object")
    for (const [k, m] of Object.entries(v.meta as Record<string, unknown>).slice(0, 300)) if (typeof m === "string") meta[k.toLowerCase()] = m;
  return {
    url: v.url,
    title: String(v.title ?? "").slice(0, 300),
    meta,
    free: typeof v.free === "boolean" ? v.free : undefined,
    text: String(v.text ?? "").slice(0, 6000).toLowerCase(),
    actions: Array.isArray(v.actions) ? v.actions.slice(0, 40).map((a) => String(a).toLowerCase()) : [],
    password: v.password === true,
    openLicence: v.openLicence === true,
  };
}

/** What a cheap probe of the proxy said about this network: its login (cookies left out)
 * asked for `target`. EZproxy sends a campus address straight on to the site; elsewhere it
 * shows its sign-in. Anything else (a captive portal, an error) says nothing. */
export function classifyProbe(facts: { status: number; location?: string; contentType?: string; url: string }, target: string, isProxied: (url: string) => boolean): "direct" | "proxy" | "unknown" {
  const targetHost = parse(target)?.hostname;
  if (!targetHost) return "unknown";
  if (facts.status >= 300 && facts.status < 400 && facts.location) {
    const next = parse(new URL(facts.location, facts.url).toString());
    if (!next) return "unknown";
    if (sameSite(next.hostname, targetHost) && !isProxied(next.toString())) return "direct";
    if (isProxied(next.toString())) return "unknown";
    return signInPage(next.toString()) ? "proxy" : "unknown";
  }
  const own = parse(facts.url)?.hostname;
  if (facts.status === 200 && /html/i.test(facts.contentType ?? "") && own) return "proxy";
  if (facts.status === 401 || facts.status === 403) return "proxy";
  return "unknown";
}
