import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {}, ipcMain: {}, session: {}, shell: {}, webContents: {} }));
const { signInChain } = await import("./sign-in");

const step = (url: string) => ({ url, host: new URL(url).hostname });

describe("a sign-in's chain of sites", () => {
  it("starts at the page that sent the tab to the sign-in pages and lists every site since", () => {
    const trail = [
      "https://www.nature.com/articles/x",
      "https://ezproxy.uni.example.edu/login?url=https://www.nature.com/articles/x",
      "https://idp.uni.example.edu/idp/profile/SAML2/Redirect/SSO",
      "https://login.microsoftonline.com/common/saml2",
    ].map(step);
    const chain = signInChain(trail, trail[3].url, "login.microsoft.com");
    expect(chain.url).toBe(trail[1].url);
    expect(chain.hosts.sort()).toEqual(["ezproxy.uni.example.edu", "idp.uni.example.edu", "login.microsoft.com", "login.microsoftonline.com"]);
  });
  it("starts on the sign-in page when the tab opened there, and on the page itself without one", () => {
    const direct = [step("https://login.microsoftonline.com/common/oauth2")];
    expect(signInChain(direct, direct[0].url).url).toBe(direct[0].url);
    const plain = [step("https://webauthn.io/"), step("https://webauthn.io/demo")];
    expect(signInChain(plain, plain[1].url)).toEqual({ url: plain[1].url, hosts: ["webauthn.io"] });
    expect(signInChain([], "https://example.org/a").url).toBe("https://example.org/a");
  });
});
