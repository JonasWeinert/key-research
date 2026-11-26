import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SecretStore, isStablySigned, preferredBackend, type SafeStorageLike } from "./secrets";

const KEY = "sk-live-abcdefghijklmnop1234";

/** Stands in for Electron's safeStorage: reversible, and counts every Keychain touch. */
function fakeSafeStorage(options: { deny?: boolean } = {}) {
  const calls = { available: 0, encrypt: 0, decrypt: 0 };
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => (calls.available++, true),
    encryptString: (plain) => (calls.encrypt++, Buffer.from(`kc:${Buffer.from(plain).toString("hex")}`)),
    decryptString: (sealed) => {
      calls.decrypt++;
      if (options.deny) throw Error("User canceled the operation");
      return Buffer.from(sealed.toString().slice(3), "hex").toString();
    },
  };
  return { storage, calls };
}
const dir = () => mkdtemp(join(tmpdir(), "key-secrets-"));

describe("secret store", () => {
  it("keeps values encrypted on this Mac, readable only by the user, and answers only hints", async () => {
    const at = await dir();
    const store = new SecretStore({ dir: at, backend: "local", reason: "tests" });
    await store.load();
    await store.set("service:openalex", KEY);
    expect(store.get("service:openalex")).toBe(KEY);
    expect(store.info("service:openalex")).toMatchObject({ set: true, hint: "1234" });
    const file = await readFile(join(at, "secrets.json"), "utf8");
    expect(file).not.toContain(KEY);
    expect((await stat(join(at, "secrets.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(at, "secrets.key"))).mode & 0o777).toBe(0o600);
    const again = new SecretStore({ dir: at, backend: "local", reason: "tests" });
    await again.load();
    expect(again.get("service:openalex")).toBe(KEY);
    await again.delete("service:openalex");
    expect(again.info("service:openalex")).toEqual({ set: false });
  });

  it("never touches the Keychain for a local store", async () => {
    const { storage, calls } = fakeSafeStorage();
    const store = new SecretStore({ dir: await dir(), backend: "local", reason: "unsigned", safeStorage: storage });
    await store.load();
    await store.set("service:x", KEY);
    expect(calls).toEqual({ available: 0, encrypt: 0, decrypt: 0 });
  });

  it("uses one Keychain key for every secret in a signed build, and moves local ones in once", async () => {
    const at = await dir();
    const local = new SecretStore({ dir: at, backend: "local", reason: "unsigned" });
    await local.load();
    await local.set("service:a", "key-a-0001");
    await local.set("service:b", "key-b-0002");
    const { storage, calls } = fakeSafeStorage();
    const signed = new SecretStore({ dir: at, backend: "keychain", reason: "signed", safeStorage: storage });
    expect((await signed.load()).backend).toBe("keychain");
    expect([signed.get("service:a"), signed.get("service:b")]).toEqual(["key-a-0001", "key-b-0002"]);
    await expect(stat(join(at, "secrets.key"))).rejects.toThrow();
    const reopened = new SecretStore({ dir: at, backend: "keychain", reason: "signed", safeStorage: storage });
    await reopened.load();
    expect(reopened.get("service:b")).toBe("key-b-0002");
    expect(calls.decrypt).toBe(2);
  });

  it("leaves Keychain secrets locked in an unsigned build until the user unlocks them, without retrying", async () => {
    const at = await dir();
    const { storage } = fakeSafeStorage();
    const signed = new SecretStore({ dir: at, backend: "keychain", reason: "signed", safeStorage: storage });
    await signed.load();
    await signed.set("service:a", KEY);
    const denied = fakeSafeStorage({ deny: true });
    const unsigned = new SecretStore({ dir: at, backend: "local", reason: "unsigned", safeStorage: denied.storage });
    const state = await unsigned.load();
    expect(state).toMatchObject({ locked: true, backend: "keychain" });
    expect(denied.calls.decrypt).toBe(0);
    expect(unsigned.get("service:a")).toBeUndefined();
    expect(unsigned.info("service:a").hint).toBe("1234");
    expect((await unsigned.unlock()).error).toBe("Keychain access was refused");
    expect(denied.calls.decrypt).toBe(1);
    // Unlocked with access: kept on this Mac from then on, so no later run asks.
    const allowed = new SecretStore({ dir: at, backend: "local", reason: "unsigned", safeStorage: fakeSafeStorage().storage });
    await allowed.load();
    expect((await allowed.unlock()).locked).toBe(false);
    expect(allowed.get("service:a")).toBe(KEY);
    const later = new SecretStore({ dir: at, backend: "local", reason: "unsigned" });
    expect((await later.load()).locked).toBe(false);
    expect(later.get("service:a")).toBe(KEY);
  });

  it("notifies on change", async () => {
    const store = new SecretStore({ dir: await dir(), backend: "local", reason: "tests" });
    await store.load();
    const seen = vi.fn();
    store.onChange(seen);
    await store.set("service:a", KEY);
    await store.delete("service:a");
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("which backend", () => {
  const signedReport = "Executable=/Applications/Key.app/Contents/MacOS/Key\nAuthority=Developer ID Application: Someone (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
  const adhocReport = "CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc\nTeamIdentifier=not set\n";
  it("reads codesign", () => {
    expect(isStablySigned(signedReport)).toBe(true);
    expect(isStablySigned(adhocReport)).toBe(false);
    expect(isStablySigned("")).toBe(false);
  });
  it("keeps tests, development and ad-hoc builds out of the Keychain", async () => {
    const base = { platform: "darwin" as const, isPackaged: true, bundlePath: "/Applications/Key.app" };
    expect(await preferredBackend({ ...base, env: { KEY_SKIP_ONBOARDING: "1" }, codesign: async () => signedReport })).toEqual({ backend: "local", reason: "tests" });
    expect(await preferredBackend({ ...base, env: {}, isPackaged: false, codesign: async () => signedReport })).toEqual({ backend: "local", reason: "development" });
    expect(await preferredBackend({ ...base, env: {}, codesign: async () => adhocReport })).toEqual({ backend: "local", reason: "unsigned" });
    expect(await preferredBackend({ ...base, env: {}, codesign: async () => signedReport })).toEqual({ backend: "keychain", reason: "signed" });
    expect(await preferredBackend({ ...base, env: {}, codesign: async () => Promise.reject(Error("no codesign")) })).toEqual({ backend: "local", reason: "unsigned" });
  });
});
