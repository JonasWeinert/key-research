import { describe, expect, it } from "vitest";
import { hasOneTimeParams, isIdentityUrl, isProxyLogin, redactUrl, signInEntry, type Hop } from "./sign-in-entry";

const page = (url: string, dwell?: number): Hop => ({ url, at: 0, committed: true, dwell });
const redirect = (url: string): Hop => ({ url, at: 0, redirect: true });

describe("sign-in services", () => {
  it("are known by host, by the usual names and by their endpoints' paths", () => {
    for (const url of [
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
      "https://login.microsoft.com/common/fido/get?uiflavor=Web",
      "https://uni.b2clogin.com/uni.onmicrosoft.com/oauth2/v2.0/authorize",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://uni.okta.com/app/x/sso/saml",
      "https://idp.uni.ac.uk/idp/profile/SAML2/Redirect/SSO?SAMLRequest=x",
      "https://shibboleth.uni.edu/",
      "https://fs.uni.edu/adfs/ls/?wa=wsignin1.0",
      "https://auth.example.org/realms/x/protocol/openid-connect/auth",
      "https://my.uni.edu/idp/profile/SAML2/POST/SSO",
    ])
      expect(isIdentityUrl(url), url).toBe(true);
    for (const url of ["https://moodle.lse.ac.uk/course/view.php?id=1", "https://www.nature.com/articles/x", "https://webauthn.io/", "https://lse.idm.oclc.org/login?url=https://www.jstor.org/stable/1"])
      expect(isIdentityUrl(url), url).toBe(false);
  });
  it("tells a library proxy's start page from a sign-in page", () => {
    expect(isProxyLogin("https://lse.idm.oclc.org/login?url=https://www.jstor.org/stable/1")).toBe(true);
    expect(isProxyLogin("https://login.ezproxy.uni.edu/login?qurl=https%3A%2F%2Fwww.nature.com%2F")).toBe(true);
    expect(isProxyLogin("https://go.openathens.net/redirector/uni.ac.uk?url=https%3A%2F%2Fwww.nature.com")).toBe(true);
    expect(isProxyLogin("https://login.microsoftonline.com/common/login")).toBe(false);
  });
  it("spots one-time requests and answers in addresses", () => {
    expect(hasOneTimeParams("https://sp.uni.edu/Shibboleth.sso/Login?SAMLDS=1&target=ss%3Amem%3Aabc")).toBe(true);
    expect(hasOneTimeParams("https://app.example/callback?code=1&state=2")).toBe(true);
    expect(hasOneTimeParams("https://login.microsoftonline.com/x/saml2?SAMLRequest=abc&RelayState=y")).toBe(true);
    expect(hasOneTimeParams("https://www.nature.com/articles/x?error=cookies_not_supported")).toBe(false);
  });
  it("redacts query values in traces", () => {
    expect(redactUrl("https://login.microsoftonline.com/common/oauth2/authorize?client_id=abc&state=secret#frag")).toBe(
      "https://login.microsoftonline.com/common/oauth2/authorize?client_id=…&state=…",
    );
  });
});

describe("where a sign-in window starts", () => {
  it("is the page before the first sign-in hop, never the sign-in page", () => {
    const hops = [
      page("https://moodle.lse.ac.uk/my/", 4000),
      redirect("https://moodle.lse.ac.uk/auth/oidc/?source=loginpage"),
      page("https://login.microsoftonline.com/tenant/oauth2/authorize?client_id=a&state=s&nonce=n", 9000),
      page("https://login.microsoft.com/common/fido/get?uiflavor=Web"),
    ];
    expect(signInEntry(hops)).toBe("https://moodle.lse.ac.uk/my/");
  });
  it("skips one-time steps between the site and the sign-in, and between sign-in services", () => {
    const hops = [
      page("https://journals.example/article/1", 5000),
      redirect("https://journals.example/Shibboleth.sso/Login?SAMLDS=1&target=ss%3Amem%3Aabc"),
      page("https://wayf.uni.edu/DS?entityID=x&return=y", 3000),
      page("https://bridge.uni.edu/relay?SAMLRequest=abc", 200),
      page("https://login.microsoftonline.com/t/saml2?SAMLRequest=abc"),
    ];
    expect(signInEntry(hops)).toBe("https://journals.example/article/1");
  });
  it("starts at a library proxy's start page, which asks for a fresh sign-in", () => {
    const hops = [
      page("https://www.jstor.org/stable/1", 3000),
      redirect("https://lse.idm.oclc.org/login?url=https://www.jstor.org/stable/1"),
      page("https://login.microsoftonline.com/t/saml2?SAMLRequest=abc"),
    ];
    expect(signInEntry(hops)).toBe("https://lse.idm.oclc.org/login?url=https://www.jstor.org/stable/1");
  });
  it("uses the page that opened the tab when the tab opened on the sign-in page", () => {
    const hops = [page("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=a&state=s")];
    expect(signInEntry(hops, "https://app.example/dashboard")).toBe("https://app.example/dashboard");
    expect(signInEntry(hops)).toBeUndefined();
    expect(signInEntry(hops, "https://login.live.com/x")).toBeUndefined();
  });
  it("is the page itself when a frame inside it asks for the passkey", () => {
    const hops = [page("https://a.example/one", 3000), page("https://journal.example/embedded")];
    expect(signInEntry(hops)).toBe("https://journal.example/embedded");
  });
  it("is the address a navigation started with, even when the site redirected it at once", () => {
    const hops = [
      { url: "https://strict.example/home", at: 0 },
      redirect("https://gateway.example/idp/profile/SAML2/Redirect/SSO?SAMLRequest=r"),
      page("https://gateway.example/idp/profile/SAML2/Redirect/SSO?execution=e1s1"),
    ];
    expect(signInEntry(hops)).toBe("https://strict.example/home");
  });
  it("counts hosts where a passkey was asked for as sign-in pages", () => {
    const hops = [page("https://app.example/home", 3000), page("https://portal.uni.example/verify")];
    expect(signInEntry(hops, undefined, ["portal.uni.example"])).toBe("https://app.example/home");
  });
});
