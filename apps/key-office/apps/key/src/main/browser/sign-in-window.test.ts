import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { CdpPipe } from "./cdp-pipe";
import { cookieMatches, cookieSites, electronCookie, isIdentityHost, signInCookies, type CdpCookie } from "./sign-in-window";

vi.mock("electron", () => ({ app: {}, dialog: {}, ipcMain: {}, session: {}, shell: {}, webContents: {} }));
const { chooseWay } = await import("./sign-in");

const cookie = (domain: string, name = "c", extra: Partial<CdpCookie> = {}): CdpCookie => ({ name, value: "v", domain, path: "/", expires: -1, httpOnly: true, secure: true, session: true, ...extra });

describe("the sign-in window's cookies", () => {
  it("copies only cookies the sign-in's hosts receive", () => {
    const hosts = ["moodle.lse.ac.uk", "login.microsoftonline.com"];
    expect(cookieMatches("moodle.lse.ac.uk", hosts)).toBe(true);
    expect(cookieMatches(".lse.ac.uk", hosts)).toBe(true);
    // A host-only cookie of a parent domain is not sent to the subdomain.
    expect(cookieMatches("lse.ac.uk", hosts)).toBe(false);
    expect(cookieMatches(".microsoftonline.com", hosts)).toBe(true);
    expect(cookieMatches("login.live.com", hosts)).toBe(false);
    expect(cookieMatches(".evil-lse.ac.uk", hosts)).toBe(false);
    const all = [cookie("moodle.lse.ac.uk", "MoodleSession"), cookie("login.microsoftonline.com", "ESTSAUTH"), cookie(".google.com", "NID"), cookie("moodle.lse.ac.uk", "chips", { partitionKey: { topLevelSite: "https://x.org" } })];
    const picked = signInCookies(all, hosts);
    expect(picked.map((c) => c.name)).toEqual(["MoodleSession", "ESTSAUTH"]);
    expect(cookieSites(picked)).toEqual(["login.microsoftonline.com", "moodle.lse.ac.uk"]);
  });
  it("turns DevTools cookies into Electron's", () => {
    expect(electronCookie(cookie("login.microsoftonline.com", "ESTSAUTH", { sameSite: "None" }))).toEqual({
      url: "https://login.microsoftonline.com/",
      name: "ESTSAUTH",
      value: "v",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
    const persistent = electronCookie(cookie(".lse.ac.uk", "p", { secure: false, session: false, expires: 2_000_000_000, sameSite: "Lax", path: "/x" }));
    expect(persistent).toMatchObject({ url: "http://lse.ac.uk/x", domain: ".lse.ac.uk", expirationDate: 2_000_000_000, sameSite: "lax" });
  });
  it("knows the usual sign-in services", () => {
    for (const host of ["login.microsoftonline.com", "login.microsoft.com", "idp.lse.ac.uk", "shibboleth.uni.example.edu", "uni.okta.com", "accounts.google.com"]) expect(isIdentityHost(host)).toBe(true);
    for (const host of ["moodle.lse.ac.uk", "www.nature.com", "webauthn.io"]) expect(isIdentityHost(host)).toBe(false);
  });
});

describe("the way a passkey sign-in goes on", () => {
  const chrome = { id: "chrome" as const, name: "Google Chrome", executable: "/x" };
  const edge = { id: "edge" as const, name: "Microsoft Edge", executable: "/y" };
  const browsers = [
    { id: "safari" as const, name: "Safari", kind: "safari" as const, root: "/" },
    { id: "firefox" as const, name: "Firefox", kind: "firefox" as const, root: "/" },
  ];
  it("prefers the chosen browser's window, then the default browser's, then any", () => {
    expect(chooseWay("edge", [chrome, edge], { appName: "Safari", id: "safari" }, browsers)).toMatchObject({ kind: "window", app: edge });
    expect(chooseWay("default", [chrome, edge], { appName: "Microsoft Edge", id: "edge" }, browsers)).toMatchObject({ kind: "window", app: edge });
    expect(chooseWay("default", [chrome, edge], { appName: "Safari", id: "safari" }, browsers)).toMatchObject({ kind: "window", app: chrome });
    expect(chooseWay("arc", [edge], { appName: "Arc", id: "arc" }, browsers)).toMatchObject({ kind: "window", app: edge });
  });
  it("hands over to Safari or Firefox when chosen, or when no Chromium browser is installed", () => {
    expect(chooseWay("safari", [chrome], { appName: "Google Chrome", id: "chrome" }, browsers)).toMatchObject({ kind: "handoff", appName: "Safari" });
    expect(chooseWay("default", [], { appName: "Firefox", id: "firefox" }, browsers)).toMatchObject({ kind: "handoff", appName: "Firefox" });
  });
});

describe("the DevTools pipe", () => {
  it("frames messages with NUL bytes and matches replies and events", async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const pipe = new CdpPipe(toBrowser, fromBrowser);
    const events: string[] = [];
    pipe.on((method) => events.push(method));
    let written = "";
    toBrowser.on("data", (d) => (written += d));
    const reply = pipe.send("Browser.getVersion");
    await new Promise((r) => setImmediate(r));
    expect(written).toBe(JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} }) + "\0");
    // A reply split across chunks, and an event in the same chunk.
    fromBrowser.write('{"id":1,"result":{"product":"Chrome/1');
    fromBrowser.write('42"}}\0{"method":"Target.targetCreated","params":{}}\0');
    expect(await reply).toEqual({ product: "Chrome/142" });
    expect(events).toEqual(["Target.targetCreated"]);
    const failing = pipe.send("Nope.nope");
    fromBrowser.write('{"id":2,"error":{"message":"not found"}}\0');
    await expect(failing).rejects.toThrow("not found");
    pipe.close();
    await expect(pipe.send("Browser.close")).rejects.toThrow();
  });
});
