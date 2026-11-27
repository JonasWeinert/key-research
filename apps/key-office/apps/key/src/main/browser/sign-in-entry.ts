// Where a sign-in starts. A sign-in page's address, and many addresses on the way to it, carry a
// one-time request bound to cookies of the browser that made it (an OAuth `state`, a SAML
// request, Shibboleth's `ss:mem:` target, a flow token…). Opened in another browser they are
// stale. So the sign-in window always starts on a clean ENTRY: the last page of the site the
// person was going to before the first sign-in hop, which makes that site issue a fresh request
// in the window. Pure functions, unit-tested (sign-in-entry.test.ts).

/** Well-known sign-in services (hosts, and their subdomains). */
const IDP_HOSTS =
  /(^|\.)(login\.microsoftonline\.com|login\.microsoftonline\.us|login\.microsoft\.com|login\.live\.com|account\.live\.com|b2clogin\.com|accounts\.google\.com|okta\.com|oktapreview\.com|okta-emea\.com|auth0\.com|onelogin\.com|duosecurity\.com|pingone\.com|pingone\.eu|pingidentity\.com|myopenathens\.net|openathens\.net|appleid\.apple\.com|idp\.apple\.com)$/i;
/** The usual names of an institution's own sign-in hosts (idp.uni.edu, sso.…, login.…). */
const IDP_LABEL = /(^|\.)(idp|idp[0-9]+|sso|login|signin|auth|shibboleth|shib|adfs|sts|cas|wayf|weblogin|websso)[0-9-]*\./i;
/** Paths that are sign-in endpoints wherever they live. */
const IDP_PATH = /\/idp\/profile\/|\/adfs\/(ls|oauth2)\b|\/oauth2\/(v2\.0\/)?authorize\b|\/saml2?\/(sso|idp|login)\b|\/(?:common|organizations|consumers|[0-9a-f-]{36})\/(saml2|wsfed|login|oauth2)\b|\/cas\/login\b|\/fido\/get\b/i;
/** Query parameters that are a one-time request or its answer. */
const ONE_TIME_PARAM =
  /^(samlrequest|samlresponse|relaystate|sigalg|signature|ticket|code|state|session_state|nonce|flowtoken|ctx|sft|sfttag|wctx|wresult|wa|request|request_uri|login_hint_token|id_token|access_token|authuser_state|execution|conversation|spentityid|samlds|return_to_state)$/i;
/** Parameter values that point at state kept by the server for one browser (Shibboleth). */
const ONE_TIME_VALUE = /^ss:mem:|^cookie:/i;

const parse = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u : undefined;
  } catch {
    return undefined;
  }
};

/** A library proxy's start page (EZproxy `login?url=`/`qurl=`, OpenAthens redirector): it asks
 * for a fresh sign-in each time, so it is a good place to start one, not a sign-in page. */
export function isProxyLogin(url: string) {
  const u = parse(url);
  if (!u) return false;
  const target = u.searchParams.get("url") || u.searchParams.get("qurl");
  if (!target || !/^https?:/i.test(target)) return false;
  return /\/login\/?$|\/redirector\//i.test(u.pathname) || /(^|\.)(ezproxy|idm\.oclc\.org)/i.test(u.hostname);
}

/** Whether a page is a sign-in service's (identity provider's), by host or by path. */
export function isIdentityUrl(url: string, known: Iterable<string> = []) {
  const u = parse(url);
  if (!u || isProxyLogin(url)) return false;
  const host = u.hostname.toLowerCase();
  for (const k of known) if (host === k) return true;
  return IDP_HOSTS.test(host) || IDP_LABEL.test(host) || IDP_PATH.test(u.pathname);
}
/** The same, for a bare host (no path to go by). */
export function isIdentityHost(host: string) {
  return IDP_HOSTS.test(host) || IDP_LABEL.test(host);
}

/** Whether an address carries a one-time sign-in request or answer. */
export function hasOneTimeParams(url: string) {
  const u = parse(url);
  if (!u) return false;
  for (const [key, value] of u.searchParams) if (ONE_TIME_PARAM.test(key) || ONE_TIME_VALUE.test(value)) return true;
  return false;
}

/** One step of a tab's way to a sign-in, oldest first. */
export interface Hop {
  url: string;
  at: number;
  /** A page that was shown (committed). */
  committed?: boolean;
  /** Where a server redirect pointed (not a navigation someone or a page started). */
  redirect?: boolean;
  /** How long it was shown before the next navigation started (ms; none while current). */
  dwell?: number;
}
/** A page left this quickly without the person doing anything is an auto-submitting step. */
const TRANSIT_MS = 1000;

/** Where a sign-in window should start for a tab that went `hops` (and was opened from
 * `opener`, if it was): the last page of the site the person was going to before the first
 * sign-in hop of this sign-in, skipping redirects, auto-submitting steps and addresses with
 * one-time requests. Undefined when there is none: the window then must not start at all on a
 * sign-in address (ask where the person was going). */
export function signInEntry(hops: Hop[], opener?: string, known: Iterable<string> = []) {
  const knownList = [...known];
  const identity = (url: string) => isIdentityUrl(url, knownList);
  // The current sign-in: from the end, back over sign-in pages and the steps between them.
  let first = -1;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (identity(hops[i].url)) first = i;
    // Not on a sign-in page now (a sign-in frame inside a site's page), or a page someone
    // chose before the sign-in pages: the search ends.
    else if (first < 0 || !transit(hops[i])) break;
  }
  const before = first >= 0 ? hops.slice(0, first) : hops;
  for (let i = before.length - 1; i >= 0; i--) {
    const hop = before[i];
    if (identity(hop.url) || transit(hop)) continue;
    return hop.url;
  }
  if (opener && !identity(opener) && !hasOneTimeParams(opener) && parse(opener)) return opener;
  return undefined;
}
/** A step on the way, not a page someone chose: where a redirect pointed, a page left at once,
 * or an address with a one-time request. The address a navigation started with (a link, a
 * typed address) is a choice even when the site redirected it at once. A library proxy's start
 * page is never a step. */
function transit(hop: Hop) {
  if (isProxyLogin(hop.url)) return false;
  return (!!hop.redirect && !hop.committed) || (!!hop.committed && hop.dwell !== undefined && hop.dwell < TRANSIT_MS) || hasOneTimeParams(hop.url);
}

/** An address for logs: no query values, no fragment (they may hold tokens). */
export function redactUrl(url: string) {
  const u = parse(url);
  if (!u) return url.replace(/[?#].*$/, "");
  const keys = [...new Set([...u.searchParams.keys()])];
  return `${u.origin}${u.pathname}${keys.length ? "?" + keys.map((k) => `${k}=…`).join("&") : ""}`;
}
