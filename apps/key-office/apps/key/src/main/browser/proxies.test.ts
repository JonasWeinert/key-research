import { describe, expect, it } from "vitest";
import {
  cleanHost,
  ezproxyHost,
  ezproxyLanding,
  ezproxyLogin,
  findProxied,
  fromConnector,
  fromZoteroDesktop,
  hyphenate,
  mergeProxies,
  openAthensRedirect,
  proxyForHost,
  sanitizeData,
  schemeProblem,
  toProper,
  toProxy,
  unhyphenate,
  type LibraryProxy,
} from "./proxies";

const proxy = (patch: Partial<LibraryProxy>): LibraryProxy => ({
  id: "p",
  name: "Test",
  kind: "ezproxy",
  scheme: "%h.ezproxy.uni.edu/%p",
  hosts: ["www.jstor.org"],
  autoAssociate: true,
  dotsToHyphens: false,
  enabled: true,
  source: "manual",
  ...patch,
});

describe("library proxies", () => {
  it("rewrites hosts both ways (dotted)", () => {
    const p = proxy({});
    expect(toProxy(p, "https://www.jstor.org/stable/123?x=1")).toBe("https://www.jstor.org.ezproxy.uni.edu/stable/123?x=1");
    expect(toProper(p, "https://www.jstor.org.ezproxy.uni.edu/stable/123?x=1")).toBe("https://www.jstor.org/stable/123?x=1");
    // Already proxied: not again.
    expect(toProxy(p, "https://www.jstor.org.ezproxy.uni.edu/stable/123")).toBeUndefined();
  });

  it("rewrites hosts with dots as hyphens, keeping hyphens of the name", () => {
    const p = proxy({ dotsToHyphens: true, hosts: ["onlinelibrary.wiley.com"] });
    expect(hyphenate("ascpt.online-library.wiley.com")).toBe("ascpt-online--library-wiley-com");
    expect(unhyphenate("ascpt-online--library-wiley-com")).toBe("ascpt.online-library.wiley.com");
    expect(toProxy(p, "https://journals.sage-pub.com/doi/10.1/x")).toBe("https://journals-sage--pub-com.ezproxy.uni.edu/doi/10.1/x");
    expect(toProper(p, "https://journals-sage--pub-com.ezproxy.uni.edu/doi/10.1/x")).toBe("https://journals.sage-pub.com/doi/10.1/x");
    // Dotted pages of the same proxy still read back.
    expect(toProper(p, "https://www.nature.com.ezproxy.uni.edu/a")).toBe("https://www.nature.com/a");
  });

  it("keeps the proxy's own https port and refuses sites on ports of their own", () => {
    const p = proxy({ scheme: "https://%h.proxy.uni.edu:8443/%p", dotsToHyphens: true });
    expect(toProxy(p, "https://www.jstor.org/a/b.pdf")).toBe("https://www-jstor-org.proxy.uni.edu:8443/a/b.pdf");
    expect(toProper(p, "https://www-jstor-org.proxy.uni.edu:8443/a/b.pdf")).toBe("https://www.jstor.org/a/b.pdf");
    expect(toProxy(p, "https://www.jstor.org:8080/a")).toBeUndefined();
    const login = proxy({ scheme: "https://login.proxy.uni.edu:2443/login?url=%u" });
    expect(toProxy(login, "https://example.org:8080/a?b=1")).toBe("https://login.proxy.uni.edu:2443/login?url=https%3A%2F%2Fexample.org%3A8080%2Fa%3Fb%3D1");
    expect(toProper(login, "https://login.proxy.uni.edu:2443/login?url=https%3A%2F%2Fexample.org%3A8080%2Fa%3Fb%3D1")).toBe("https://example.org:8080/a?b=1");
  });

  it("sends through a login URL and reads pages back by their host pattern", () => {
    const p = proxy({ scheme: "https://lse.idm.oclc.org/login?qurl=%u", properScheme: "%h.lse.idm.oclc.org/%p", dotsToHyphens: true });
    expect(toProxy(p, "https://www.nature.com/articles/x")).toBe("https://lse.idm.oclc.org/login?qurl=https%3A%2F%2Fwww.nature.com%2Farticles%2Fx");
    expect(toProper(p, "https://www-nature-com.lse.idm.oclc.org/articles/x")).toBe("https://www.nature.com/articles/x");
    expect(toProper(p, "https://lse.idm.oclc.org/login?qurl=https%3A%2F%2Fwww.nature.com%2Farticles%2Fx")).toBe("https://www.nature.com/articles/x");
    expect(toProxy(p, "https://www-nature-com.lse.idm.oclc.org/articles/x")).toBeUndefined();
  });

  it("handles OpenAthens and library link prefixes", () => {
    const oa = proxy({ kind: "openathens", scheme: "https://go.openathens.net/redirector/uni.edu?url=%u" });
    const sent = toProxy(oa, "https://www.sciencedirect.com/science/article/pii/S1")!;
    expect(sent).toBe("https://go.openathens.net/redirector/uni.edu?url=https%3A%2F%2Fwww.sciencedirect.com%2Fscience%2Farticle%2Fpii%2FS1");
    expect(toProper(oa, sent)).toBe("https://www.sciencedirect.com/science/article/pii/S1");
    const prefix = proxy({ kind: "redirect", scheme: "https://libkey.io/libraries/42/redirect?url={url}".replace("{url}", "%u") });
    expect(toProper(prefix, toProxy(prefix, "https://doi.org/10.1/x")!)).toBe("https://doi.org/10.1/x");
  });

  it("supports directory and file variables", () => {
    const p = proxy({ scheme: "https://proxy.uni.edu/%h/%d/%f" });
    expect(toProxy(p, "https://www.jstor.org/a/b/c.pdf?x=1")).toBe("https://proxy.uni.edu/www.jstor.org/a/b/c.pdf?x=1");
    expect(toProper(p, "https://proxy.uni.edu/www.jstor.org/a/b/c.pdf")).toBe("https://www.jstor.org/a/b/c.pdf");
  });

  it("checks schemes", () => {
    expect(schemeProblem("ezproxy.uni.edu/login")).toMatch(/%h|%u/);
    expect(schemeProblem("%h.ezproxy.uni.edu")).toMatch(/%p/);
    expect(schemeProblem("https://resolver.uni.edu/?target={url}")).toBeUndefined();
    expect(cleanHost(" HTTPS://WWW.Jstor.org/stable ")).toBe("www.jstor.org");
    expect(cleanHost("not a host")).toBe("");
  });

  it("finds the proxy of a page and of a host", () => {
    const list = [proxy({ enabled: false, id: "off" }), proxy({ id: "on", hosts: ["www.jstor.org", "www.nature.com"] })];
    expect(findProxied(list, "https://www.jstor.org.ezproxy.uni.edu/x")?.proxy.id).toBe("on");
    expect(proxyForHost(list, "www.nature.com")?.id).toBe("on");
    expect(proxyForHost(list, "nature.com")).toBeUndefined();
  });

  it("recognises EZproxy logins and the host they lead to", () => {
    const headers = { Server: ["EZproxy"] };
    const login = ezproxyLogin("https://login.ezproxy.uni.edu/login?qurl=https%3A%2F%2Fwww.jstor.org%2Fstable%2F1", headers)!;
    expect(login).toEqual({ login: "https://login.ezproxy.uni.edu/login", parameter: "qurl", target: "https://www.jstor.org/stable/1" });
    expect(ezproxyLogin("https://login.ezproxy.uni.edu/login?url=https://www.jstor.org/stable/1?a=b&c=d", headers)?.target).toBe("https://www.jstor.org/stable/1?a=b&c=d");
    expect(ezproxyLogin("https://login.ezproxy.uni.edu/login?qurl=x", {})).toBeUndefined();
    const landing = ezproxyLanding(login, "https://www-jstor-org.ezproxy.uni.edu/stable/1")!;
    expect(landing).toMatchObject({ name: "ezproxy.uni.edu", scheme: "https://login.ezproxy.uni.edu/login?qurl=%u", properScheme: "https://%h.ezproxy.uni.edu/%p", hosts: ["www.jstor.org"], dotsToHyphens: true });
    expect(ezproxyLanding(login, "https://www.jstor.org.ezproxy.uni.edu/stable/1")?.dotsToHyphens).toBe(false);
    expect(ezproxyLanding(login, "https://www.jstor.org/stable/1")).toBeUndefined();
    expect(ezproxyHost("https://www-tandfonline-com.ezproxy.uni.edu/doi/x", headers)).toMatchObject({ hosts: ["www.tandfonline.com"], scheme: "https://%h.ezproxy.uni.edu/%p" });
    expect(openAthensRedirect("https://go.openathens.net/redirector/uni.edu?url=https%3A%2F%2Fwww.nature.com%2Fx")).toMatchObject({ hosts: ["www.nature.com"], kind: "openathens" });
  });

  it("imports Connector and Zotero proxies and merges them", () => {
    const connector = fromConnector({ id: 1, autoAssociate: true, hosts: ["www.nature.com"], toProperScheme: "%h.lse.idm.oclc.org/%p", toProxyScheme: "https://lse.idm.oclc.org/login?qurl=%u" }, "c1")!;
    expect(connector).toMatchObject({ name: "lse.idm.oclc.org", scheme: "https://lse.idm.oclc.org/login?qurl=%u", properScheme: "%h.lse.idm.oclc.org/%p", source: "connector", dotsToHyphens: true });
    expect(toProper(connector, "https://www-nature-com.lse.idm.oclc.org/a")).toBe("https://www.nature.com/a");
    const desktop = fromZoteroDesktop({ scheme: "%h.lse.idm.oclc.org/%p", autoAssociate: 1 }, ["www.jstor.org"], "z1")!;
    const merged = mergeProxies([desktop], [connector]);
    expect(merged.proxies).toHaveLength(1);
    expect(merged.proxies[0].hosts).toEqual(["www.jstor.org", "www.nature.com"]);
    expect(merged.proxies[0].scheme).toBe("https://lse.idm.oclc.org/login?qurl=%u");
    expect(merged.updated).toBe(1);
    const data = sanitizeData({ prefs: { transparent: false, excluded: ["WWW.X.org", "bad host"] }, proxies: [connector, { scheme: "nope" }] }, () => "n");
    expect(data.prefs).toEqual({ transparent: false, autoRecognize: true, excluded: ["www.x.org"], followZotero: false });
    expect(data.proxies).toHaveLength(1);
  });
});
