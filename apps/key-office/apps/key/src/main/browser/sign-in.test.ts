import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ app: {}, dialog: {}, ipcMain: {}, session: {}, shell: {}, webContents: {} }));
const { chainHosts, SignInHosts } = await import("./sign-in");

const page = (url: string) => ({ url, at: 0, committed: true });

describe("a sign-in's sites", () => {
  it("are the entry's and every one the tab went through since", () => {
    const trail = [
      page("https://elsewhere.example/"),
      page("https://www.nature.com/articles/x"),
      page("https://ezproxy.uni.example.edu/login?url=https://www.nature.com/articles/x"),
      page("https://idp.uni.example.edu/idp/profile/SAML2/Redirect/SSO"),
      page("https://login.microsoftonline.com/common/saml2"),
    ];
    const hosts = chainHosts(trail, trail[1].url, trail[4].url, "login.microsoft.com");
    expect(hosts.sort()).toEqual(["ezproxy.uni.example.edu", "idp.uni.example.edu", "login.microsoft.com", "login.microsoftonline.com", "www.nature.com"]);
  });
  it("include an entry that came from another tab", () => {
    expect(chainHosts([page("https://login.live.com/x")], "https://app.example/", "https://login.live.com/x").sort()).toEqual(["app.example", "login.live.com"]);
  });
});

describe("where a sign-in request returns to", () => {
  it("is the home page of the site in redirect_uri or wreply, never the request", async () => {
    const { returnSite } = await import("./sign-in");
    expect(returnSite("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=a&redirect_uri=https%3A%2F%2Fwww.office.com%2Flandingv2&state=s")).toBe("https://www.office.com/");
    expect(returnSite("https://fs.uni.edu/adfs/ls/?wa=wsignin1.0&wreply=https%3A%2F%2Fmoodle.uni.edu%2Fauth%2F")).toBe("https://moodle.uni.edu/");
    expect(returnSite("https://login.microsoftonline.com/common/login")).toBeUndefined();
  });
});

describe("what Key remembers per sign-in service", () => {
  it("opens the window by itself where chosen, or where a passkey was asked for and Here was not chosen", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "key-signin-hosts-")), "sign-in-hosts.json");
    const hosts = new SignInHosts(file);
    expect(hosts.automatic("login.microsoftonline.com")).toBe(false);
    hosts.notePasskey("login.microsoftonline.com");
    expect(hosts.automatic("login.microsoftonline.com")).toBe(true);
    hosts.set("login.microsoftonline.com", "here");
    expect(hosts.automatic("login.microsoftonline.com")).toBe(false);
    hosts.set("idp.uni.edu", "window");
    expect(hosts.automatic("idp.uni.edu")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const again = new SignInHosts(file);
    expect(again.list()).toEqual([
      { host: "idp.uni.edu", choice: "window", passkey: false, automatic: true },
      { host: "login.microsoftonline.com", choice: "here", passkey: true, automatic: false },
    ]);
    again.set("login.microsoftonline.com", undefined);
    expect(again.list().map((h) => h.host)).toEqual(["idp.uni.edu"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(file, "utf8")).passkey).toEqual([]);
  });
});
