// Cookie import from fixture profiles built here (never a real browser profile): every browser
// root points at a temporary home through KEY_COOKIE_IMPORT_HOME.
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  browserOfAppName,
  chromiumKey,
  cookieDomainsFor,
  decrypt,
  decryptChromiumValue,
  electronCookie,
  findCookies,
  knownBrowsers,
  locateCookies,
  needsKeychain,
  parseBinaryCookies,
  summarize,
} from "./cookie-import";

const home = mkdtempSync(join(tmpdir(), "key-cookie-fixture-"));
const env = { KEY_COOKIE_IMPORT_HOME: home };
afterAll(() => rmSync(home, { recursive: true, force: true }));
const browser = (id: string) => knownBrowsers(env).find((b) => b.id === id)!;
const sqlite = (file: string, sql: string) => execFileSync("/usr/bin/sqlite3", [file, sql]);
const future = Math.floor(Date.now() / 1000) + 86_400 * 30;

function encrypt(value: string, password: string, host: string, dbVersion: number) {
  const plain = dbVersion >= 24 ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  const cipher = createCipheriv("aes-128-cbc", chromiumKey(password), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

describe("cookie domains", () => {
  it("asks for each host and its parent domains, never a bare top-level domain", () => {
    expect(cookieDomainsFor(["login.uni.example.edu"]).sort()).toEqual(
      ["login.uni.example.edu", ".login.uni.example.edu", ".uni.example.edu", ".example.edu"].sort(),
    );
    expect(cookieDomainsFor(["bad host'; drop", ""])).toEqual([]);
  });
  it("knows browsers by their app names", () => {
    expect(browserOfAppName("Google Chrome")).toBe("chrome");
    expect(browserOfAppName("Microsoft Edge")).toBe("edge");
    expect(browserOfAppName("Brave Browser")).toBe("brave");
    expect(browserOfAppName("Arc")).toBe("arc");
    expect(browserOfAppName("Firefox")).toBe("firefox");
    expect(browserOfAppName("Safari")).toBe("safari");
    expect(browserOfAppName("Opera")).toBeUndefined();
  });
});

describe("Chromium profiles", () => {
  const password = "fixture-password";
  const root = browser("chrome").root;
  mkdirSync(join(root, "Profile 2"), { recursive: true });
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { last_used: "Profile 2" } }));
  const db = join(root, "Profile 2", "Cookies");
  sqlite(
    db,
    `create table meta(key text, value text); insert into meta values('version','24');
     create table cookies(host_key text, top_frame_site_key text, name text, value text, encrypted_value blob, path text, expires_utc integer, has_expires integer, is_secure integer, is_httponly integer, samesite integer);`,
  );
  const add = (host: string, name: string, value: string, extra = "''") => {
    const hex = encrypt(value, password, host, 24).toString("hex");
    const expires = (future + 11_644_473_600) * 1e6;
    sqlite(db, `insert into cookies values('${host}', ${extra}, '${name}', '', x'${hex}', '/', ${expires}, 1, 1, 1, 0)`);
  };
  add("login.microsoftonline.com", "ESTSAUTH", "sso-token");
  add(".uni.example.edu", "shib", "idp-session");
  add(".unrelated.example.com", "other", "never-read");
  add("login.microsoftonline.com", "partitioned", "x", "'https://elsewhere.example'");

  it("reads only the sites asked for, from the profile used last, with values still encrypted", async () => {
    const source = await locateCookies(browser("chrome"));
    expect(source.profile).toBe("Profile 2");
    const found = await findCookies(source, ["login.microsoftonline.com", "idp.uni.example.edu"]);
    expect(needsKeychain(found)).toBe(true);
    expect(summarize(found)).toEqual([
      { site: "login.microsoftonline.com", count: 1 },
      { site: "uni.example.edu", count: 1 },
    ]);
    const cookies = decrypt(found, chromiumKey(password));
    expect(cookies.map((c) => [c.host, c.name, c.value])).toEqual([
      ["login.microsoftonline.com", "ESTSAUTH", "sso-token"],
      [".uni.example.edu", "shib", "idp-session"],
    ]);
    expect(cookies[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: "no_restriction" });
    expect(Math.abs(cookies[0].expires! - future)).toBeLessThan(2);
  });
  it("drops values a wrong key cannot decrypt", async () => {
    const found = await findCookies(await locateCookies(browser("chrome")), ["login.microsoftonline.com"]);
    expect(decrypt(found, chromiumKey("wrong"))).toEqual([]);
    expect(decryptChromiumValue(Buffer.from("plain"), chromiumKey(password), "x", 24)).toBeUndefined();
  });
  it("reads older databases without the host hash", () => {
    const value = encrypt("old", password, "h", 20);
    expect(decryptChromiumValue(value, chromiumKey(password), "h", 20)).toBe("old");
  });
  it("says when a browser has no profile", async () => {
    expect((await locateCookies(browser("edge"))).problem).toBe("missing");
  });
});

describe("Firefox profiles", () => {
  const root = browser("firefox").root;
  const profile = join(root, "Profiles", "abc.default-release");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(root, "profiles.ini"), "[Profile0]\nName=old\nIsRelative=1\nPath=Profiles/old\n\n[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\nLocked=1\n");
  const db = join(profile, "cookies.sqlite");
  sqlite(db, "create table moz_cookies(originAttributes text, name text, value text, host text, path text, expiry integer, isSecure integer, isHttpOnly integer, sameSite integer)");
  sqlite(db, `insert into moz_cookies values('', 'ezproxy', 'abc', '.ezproxy.uni.example.edu', '/', ${future * 1000}, 1, 0, 1)`);
  sqlite(db, `insert into moz_cookies values('^userContextId=2', 'container', 'no', '.ezproxy.uni.example.edu', '/', ${future}, 1, 0, 1)`);
  sqlite(db, `insert into moz_cookies values('', 'expired', 'no', '.ezproxy.uni.example.edu', '/', 1000, 1, 0, 1)`);

  it("reads the install's default profile in plain text, leaving containers and expired cookies", async () => {
    const source = await locateCookies(browser("firefox"));
    expect(source.profile).toBe("abc.default-release");
    const found = await findCookies(source, ["login.ezproxy.uni.example.edu"]);
    expect(needsKeychain(found)).toBe(false);
    const cookies = decrypt(found);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: "ezproxy", value: "abc", sameSite: "lax", secure: true, expires: future });
  });
});

/** A binarycookies file with one page of records. */
function binaryCookies(records: Array<{ host: string; name: string; path: string; value: string; flags: number; expires: number }>) {
  const bodies = records.map((r) => {
    const strings = [r.host, r.name, r.path, r.value].map((s) => Buffer.concat([Buffer.from(s), Buffer.alloc(1)]));
    const header = Buffer.alloc(56);
    let at = 56;
    const offsets = strings.map((s) => ((at += s.length), at - s.length));
    header.writeUInt32LE(56 + strings.reduce((n, s) => n + s.length, 0), 0);
    header.writeUInt32LE(r.flags, 8);
    offsets.forEach((o, i) => header.writeUInt32LE(o, 16 + i * 4));
    header.writeDoubleLE(r.expires - 978_307_200, 40);
    return Buffer.concat([header, ...strings]);
  });
  const head = Buffer.alloc(8 + records.length * 4);
  head.writeUInt32BE(0x00000100, 0);
  head.writeUInt32LE(records.length, 4);
  let at = head.length + 4;
  bodies.forEach((b, i) => {
    head.writeUInt32LE(at, 8 + i * 4);
    at += b.length;
  });
  const page = Buffer.concat([head, Buffer.alloc(4), ...bodies]);
  const file = Buffer.alloc(12);
  file.write("cook", 0, "latin1");
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(page.length, 8);
  return Buffer.concat([file, page]);
}

describe("Safari cookies", () => {
  it("parses binarycookies records", () => {
    const parsed = parseBinaryCookies(
      binaryCookies([
        { host: ".uni.example.edu", name: "shib", path: "/", value: "v1", flags: 5, expires: future },
        { host: "old.example.edu", name: "gone", path: "/", value: "v2", flags: 0, expires: 1_000_000_000 },
      ]),
    );
    expect(parsed).toEqual([{ host: ".uni.example.edu", name: "shib", path: "/", value: "v1", secure: true, httpOnly: true, sameSite: "unspecified", expires: future }]);
    expect(() => parseBinaryCookies(Buffer.from("nope"))).toThrow();
  });
  it("finds the container's file and filters by site", async () => {
    const dir = join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Cookies.binarycookies"), binaryCookies([
      { host: ".uni.example.edu", name: "shib", path: "/", value: "v1", flags: 1, expires: future },
      { host: ".elsewhere.example.org", name: "other", path: "/", value: "v2", flags: 1, expires: future },
    ]));
    const found = await findCookies(await locateCookies(browser("safari")), ["idp.uni.example.edu"]);
    expect(decrypt(found).map((c) => c.name)).toEqual(["shib"]);
  });
});

describe("into Key's browser", () => {
  it("keeps domain cookies on their domain and host-only cookies on their host", () => {
    expect(electronCookie({ host: ".uni.example.edu", name: "a", value: "1", path: "/", secure: true, httpOnly: false, sameSite: "lax", expires: future })).toEqual({
      url: "https://uni.example.edu/",
      name: "a",
      value: "1",
      domain: ".uni.example.edu",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: future,
    });
    expect(electronCookie({ host: "login.example.com", name: "__Host-x", value: "1", path: "/", secure: true, httpOnly: true, sameSite: "strict" })).not.toHaveProperty("domain");
  });
});
