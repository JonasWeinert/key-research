import { describe, expect, it } from "vitest";
import { classifyPage, classifyProbe, classifyResponse, pageFacts, sameSite, signInPage, type PageFacts } from "./access";

const page = (patch: Partial<PageFacts>): PageFacts => ({ url: "https://journal.example/article/1", title: "An article", meta: {}, text: "", actions: [], password: false, openLicence: false, ...patch });
const fullText = "introduction ".repeat(300);

describe("access signals: responses", () => {
  it("reads 401, 402 and 403 as a refusal", () => {
    for (const status of [401, 402, 403]) expect(classifyResponse({ url: "https://www.jstor.org/stable/1", status }).access).toBe("denied");
  });
  it("reads redirects to sign-in, SSO and purchase pages as a refusal", () => {
    const denied = [
      "https://onlinelibrary.wiley.com/action/showLogin?uri=%2Fdoi%2F10.1%2Fx",
      "https://idp.uni.ac.uk/idp/profile/SAML2/Redirect/SSO",
      "https://shibboleth.uni.edu/x",
      "https://my.openathens.net/?passiveLogin=false",
      "https://wayf.example.org/select",
      "https://www.publisher.com/login?redirect=/article/1",
      "https://www.publisher.com/purchase/article/1",
      "https://www.publisher.com/get-access?doi=1",
    ];
    for (const location of denied) expect(classifyResponse({ url: "https://www.publisher.com/article/1", status: 302, location }), location).toMatchObject({ access: "denied", telling: true });
  });
  it("leaves ordinary redirects, errors and bot checks undecided", () => {
    expect(classifyResponse({ url: "https://doi.org/10.1/x", status: 302, location: "https://www.publisher.com/article/1" }).access).toBe("unknown");
    expect(classifyResponse({ url: "https://www.publisher.com/a", status: 500 }).access).toBe("unknown");
    expect(classifyResponse({ url: "https://www.publisher.com/a", status: 429 }).access).toBe("unknown");
    expect(classifyResponse({ url: "https://www.publisher.com/a", status: 200, contentType: "text/html" }).access).toBe("unknown");
  });
  it("reads a PDF request answered with a web page as a refusal, and a PDF as access", () => {
    expect(classifyResponse({ url: "https://p.com/a.pdf", status: 200, contentType: "text/html; charset=utf-8", wantPdf: true }).access).toBe("denied");
    expect(classifyResponse({ url: "https://p.com/a.pdf", status: 200, contentType: "application/pdf", wantPdf: true }).access).toBe("granted");
  });
  it("tells sign-in pages from articles", () => {
    expect(signInPage("https://www.tandfonline.com/action/showLogin?uri=x")).toBeTruthy();
    expect(signInPage("https://www.tandfonline.com/doi/full/10.1080/1")).toBeUndefined();
    expect(signInPage("https://www.author-services.com/x")).toBeUndefined();
    expect(sameSite("www.jstor.org", "jstor.org")).toBe(true);
    expect(sameSite("jstor.org", "nature.com")).toBe(false);
  });
});

describe("access signals: pages", () => {
  it("a paywall: get access, institution sign-in, no PDF", () => {
    const paywall = page({ text: "abstract … get access to the full text. access through your institution. purchase this article", actions: ["log in via your institution https://journal.example/action/showlogin"] });
    expect(classifyPage(paywall)).toMatchObject({ access: "denied", telling: true });
  });
  it("one paywall phrase with a PDF link still reads as full text, two do not", () => {
    expect(classifyPage(page({ meta: { citation_pdf_url: "https://j/x.pdf", citation_title: "x" }, text: `${fullText} check access` })).access).toBe("granted");
    expect(classifyPage(page({ meta: { citation_pdf_url: "https://j/x.pdf" }, text: "buy this article. access options" })).access).toBe("denied");
  });
  it("publisher access meta tags and schema.org's isAccessibleForFree", () => {
    expect(classifyPage(page({ meta: { access: "No" } })).access).toBe("denied");
    expect(classifyPage(page({ meta: { access: "Yes" } })).access).toBe("granted");
    expect(classifyPage(page({ free: false, text: "subscribe to read the rest" })).access).toBe("denied");
  });
  it("an open-access article loads but says nothing about the network", () => {
    expect(classifyPage(page({ meta: { citation_pdf_url: "https://j/x.pdf" }, openLicence: true }))).toMatchObject({ access: "granted", telling: false });
    expect(classifyPage(page({ meta: { citation_pdf_url: "https://j/x.pdf" }, free: true }))).toMatchObject({ access: "granted", telling: false });
  });
  it("a full-text article reads as access", () => {
    expect(classifyPage(page({ meta: { citation_pdf_url: "https://j/x.pdf", citation_title: "x" }, text: fullText }))).toMatchObject({ access: "granted", telling: true });
  });
  it("a home page, a captive portal or a bot check say nothing", () => {
    expect(classifyPage(page({ url: "https://journal.example/", title: "Journal", text: "latest issue" })).access).toBe("unknown");
    expect(classifyPage(page({ title: "Wi-Fi terms", text: "accept the terms to continue" })).access).toBe("unknown");
    expect(classifyPage(page({ title: "Just a moment...", text: "checking your browser" })).access).toBe("unknown");
  });
  it("a sign-in form page", () => {
    expect(classifyPage(page({ url: "https://journal.example/signin?x=1" })).access).toBe("denied");
    expect(classifyPage(page({ title: "Sign in", password: true })).access).toBe("denied");
  });
  it("checks what the page script answered", () => {
    expect(pageFacts(null)).toBeUndefined();
    expect(pageFacts({ url: "https://x", meta: { Citation_PDF_URL: "a", bad: 3 }, actions: "nope", text: "ABC" })).toMatchObject({ meta: { citation_pdf_url: "a" }, actions: [], text: "abc" });
  });
});

describe("access signals: the proxy probe", () => {
  const proxied = (u: string) => u.includes(".ezproxy.uni.edu");
  const url = "https://login.ezproxy.uni.edu/login?qurl=https%3A%2F%2Fwww.jstor.org%2F";
  it("EZproxy sending a campus address straight on: direct", () => {
    expect(classifyProbe({ url, status: 302, location: "https://www.jstor.org/" }, "https://www.jstor.org/", proxied)).toBe("direct");
  });
  it("its sign-in (a page or an SSO redirect): proxy", () => {
    expect(classifyProbe({ url, status: 200, contentType: "text/html" }, "https://www.jstor.org/", proxied)).toBe("proxy");
    expect(classifyProbe({ url, status: 302, location: "https://idp.uni.edu/idp/profile/SAML2" }, "https://www.jstor.org/", proxied)).toBe("proxy");
  });
  it("a proxied address (signed in by IP) or somewhere else (a captive portal): nothing", () => {
    expect(classifyProbe({ url, status: 302, location: "https://www-jstor-org.ezproxy.uni.edu/" }, "https://www.jstor.org/", proxied)).toBe("unknown");
    expect(classifyProbe({ url, status: 302, location: "http://captive.hotel.example/portal" }, "https://www.jstor.org/", proxied)).toBe("unknown");
    expect(classifyProbe({ url, status: 502 }, "https://www.jstor.org/", proxied)).toBe("unknown");
  });
});
