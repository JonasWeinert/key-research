import { describe, expect, it } from "vitest";
import { checkClientData, checkRequest, type CredentialJson } from "./passkey-proxy";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const answer = (data: Record<string, unknown>): CredentialJson => ({ id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: b64u(JSON.stringify(data)) } });

describe("which pages may use the passkey proxy, for which rp ID", () => {
  it("allows the page's host and its parent domains, on https (or this computer)", () => {
    expect(checkRequest("https://login.microsoft.com", "login.microsoft.com")).toBe("login.microsoft.com");
    expect(checkRequest("https://login.microsoft.com", "microsoft.com")).toBe("microsoft.com");
    expect(checkRequest("https://login.microsoft.com", undefined)).toBe("login.microsoft.com");
    expect(checkRequest("http://rp.localhost:5000", "rp.localhost")).toBe("rp.localhost");
  });
  it("refuses other sites, bare suffixes and plain http", () => {
    expect(() => checkRequest("https://evil.example", "microsoft.com")).toThrow(/may not use passkeys/);
    expect(() => checkRequest("https://login.microsoft.com", "com")).toThrow(/may not use passkeys/);
    expect(() => checkRequest("https://notmicrosoft.com", "microsoft.com")).toThrow(/may not use passkeys/);
    expect(() => checkRequest("http://login.microsoft.com", "login.microsoft.com")).toThrow(/secure/);
    expect(() => checkRequest("null", undefined)).toThrow();
  });
});

describe("the answer from Chrome", () => {
  it("must be made for the requesting origin, request kind and embedding", () => {
    const origin = "https://login.microsoft.com";
    expect(() => checkClientData(answer({ type: "webauthn.get", origin, challenge: "c" }), "get", origin, false)).not.toThrow();
    expect(() => checkClientData(answer({ type: "webauthn.get", origin: "https://evil.example" }), "get", origin, false)).toThrow(/not made for this page/);
    expect(() => checkClientData(answer({ type: "webauthn.create", origin }), "get", origin, false)).toThrow(/not made for this page/);
    expect(() => checkClientData(answer({ type: "webauthn.get", origin, crossOrigin: true }), "get", origin, false)).toThrow(/not made for this page/);
    expect(() => checkClientData(answer({ type: "webauthn.get", origin, crossOrigin: true, topOrigin: "https://journal.example" }), "get", origin, true)).not.toThrow();
    expect(() => checkClientData({ id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "!!" } }, "get", origin, false)).toThrow();
  });
});
