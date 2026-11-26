// API keys and other named secrets, encrypted at rest under userData (secrets.json). Values
// stay in the main process: the renderer only learns whether one is set and its last four
// characters, child processes get the few they need over their IPC channel, never through
// the environment, and nothing here logs a value.
//
// Where the encryption key lives, and why. Electron's safeStorage keeps one key for the whole
// app in a single Keychain item ("Key Safe Storage"), so there is never more than one item and
// never a prompt per secret. macOS asks before an app reads that item only when the app's code
// identity differs from the one that created it. A build signed with a Developer ID keeps its
// identity across updates, so it is asked at most once, if ever. An ad-hoc or unsigned build
// (electron-builder with `identity: null`, `npm run dev`'s Electron binary) gets a new identity
// with every rebuild, and macOS would ask again after each one. Those builds therefore never
// touch the Keychain: they encrypt with a random key kept next to the secrets in a file only
// this user can read ("Stored on this Mac"). Smokes and tests use that file too. When a signed
// build finds secrets stored that way it moves them into the Keychain once; when an unsigned
// build finds Keychain secrets it leaves them locked (Settings offers to unlock, which may ask
// once) rather than prompting by itself. A failed or refused Keychain read is not retried on
// its own, so there is no prompt loop.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SecretBackend = "keychain" | "local";
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}
export interface SecretStatus {
  set: boolean;
  /** The last four characters, for "••••abcd". */
  hint?: string;
  updatedAt?: number;
}
export interface SecretStoreState {
  backend: SecretBackend;
  /** Why this backend: "signed", "unsigned", "development", "tests", "override", "unavailable". */
  reason: string;
  /** Keychain secrets this build cannot read without asking (see unlock). */
  locked: boolean;
  error?: string;
}

interface Stored {
  value: string;
  hint: string;
  updatedAt: number;
}
interface FileShape {
  version: 1;
  backend: SecretBackend;
  secrets: Record<string, Stored>;
}

const NAME = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
export const hintOf = (value: string) => value.slice(-4);

export class SecretStore {
  private values = new Map<string, string>();
  private file: FileShape = { version: 1, backend: "local", secrets: {} };
  private state: SecretStoreState = { backend: "local", reason: "tests", locked: false };
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(name: string) => void>();

  constructor(
    private readonly options: {
      dir: string;
      /** The backend this build should use (see preferredBackend). */
      backend: SecretBackend;
      reason: string;
      /** Only touched when the backend is "keychain". */
      safeStorage?: SafeStorageLike;
    },
  ) {}

  private get path() {
    return join(this.options.dir, "secrets.json");
  }
  private get keyPath() {
    return join(this.options.dir, "secrets.key");
  }

  async load(): Promise<SecretStoreState> {
    this.state = { backend: this.options.backend, reason: this.options.reason, locked: false };
    this.values.clear();
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as FileShape;
      if (parsed?.version === 1 && parsed.secrets && typeof parsed.secrets === "object") this.file = { version: 1, backend: parsed.backend === "keychain" ? "keychain" : "local", secrets: parsed.secrets };
    } catch {
      this.file = { version: 1, backend: this.options.backend, secrets: {} };
    }
    const names = Object.keys(this.file.secrets);
    if (!names.length) {
      this.file.backend = this.options.backend;
      return this.status();
    }
    if (this.file.backend === "keychain" && this.options.backend === "local") {
      // Saved by a signed build; reading them here could make macOS ask. Wait for the user.
      this.state.locked = true;
      return this.status();
    }
    try {
      await this.decryptAll();
    } catch (error) {
      this.state.locked = true;
      this.state.error = describe(error);
      return this.status();
    }
    // A signed build moves secrets an unsigned one kept on this Mac into the Keychain, once.
    if (this.file.backend === "local" && this.options.backend === "keychain") {
      if (this.keychainReady()) {
        await this.persist("keychain");
        await rm(this.keyPath, { force: true }).catch(() => {});
      } else {
        this.state.backend = "local";
        this.state.reason = "unavailable";
      }
    }
    return this.status();
  }

  /** Reads Keychain secrets this build left locked: only when the user asks (may prompt once). */
  async unlock(): Promise<SecretStoreState> {
    if (!this.state.locked) return this.status();
    try {
      if (!this.options.safeStorage) throw Error("The Keychain is not available");
      for (const [name, stored] of Object.entries(this.file.secrets)) this.values.set(name, this.options.safeStorage.decryptString(Buffer.from(stored.value, "base64")));
      this.state.locked = false;
      this.state.error = undefined;
      // Keep using them without asking again: store them the way this build does.
      await this.persist(this.options.backend);
      for (const name of this.values.keys()) this.changed(name);
    } catch (error) {
      this.values.clear();
      this.state.error = describe(error);
    }
    return this.status();
  }

  status(): SecretStoreState {
    return { ...this.state, backend: this.state.locked ? this.file.backend : this.state.backend };
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  info(name: string): SecretStatus {
    const stored = this.file.secrets[name];
    return stored ? { set: true, hint: stored.hint, updatedAt: stored.updatedAt } : { set: false };
  }

  names() {
    return Object.keys(this.file.secrets);
  }

  onChange(listener: (name: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async set(name: string, value: string) {
    if (!NAME.test(name)) throw Error("Invalid secret name");
    const clean = value.trim();
    if (!clean) return this.delete(name);
    if (clean.length > 1000) throw Error("That key is too long");
    if (this.state.locked) {
      // Replacing locked secrets: the others stay locked in the file until unlocked or replaced.
      throw Error("Unlock the stored keys first, or remove them");
    }
    this.values.set(name, clean);
    this.file.secrets[name] = { value: "", hint: hintOf(clean), updatedAt: Date.now() };
    await this.persist(this.state.backend);
    this.changed(name);
  }

  async delete(name: string) {
    const had = name in this.file.secrets;
    this.values.delete(name);
    delete this.file.secrets[name];
    if (this.state.locked && !Object.keys(this.file.secrets).length) this.state.locked = false;
    if (this.state.locked) await this.write(this.file);
    else await this.persist(this.state.backend);
    if (had) this.changed(name);
  }

  /** Forgets every stored secret (Settings → Remove all, when locked ones cannot be read). */
  async clear() {
    const names = Object.keys(this.file.secrets);
    this.values.clear();
    this.file = { version: 1, backend: this.state.backend, secrets: {} };
    this.state.locked = false;
    this.state.error = undefined;
    await this.write(this.file);
    for (const name of names) this.changed(name);
  }

  private changed(name: string) {
    for (const listener of this.listeners) {
      try {
        listener(name);
      } catch {}
    }
  }

  private keychainReady() {
    try {
      return !!this.options.safeStorage?.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private async decryptAll() {
    const entries = Object.entries(this.file.secrets);
    if (this.file.backend === "keychain") {
      if (!this.options.safeStorage) throw Error("The Keychain is not available");
      for (const [name, stored] of entries) this.values.set(name, this.options.safeStorage.decryptString(Buffer.from(stored.value, "base64")));
      return;
    }
    const key = await this.localKey(false);
    for (const [name, stored] of entries) this.values.set(name, openLocal(key, stored.value));
  }

  /** Writes every value with `backend`, falling back to the local file when the Keychain is not there. */
  private async persist(backend: SecretBackend) {
    if (backend === "keychain" && !this.keychainReady()) {
      backend = "local";
      this.state.backend = "local";
      this.state.reason = "unavailable";
    }
    const secrets: Record<string, Stored> = {};
    const key = backend === "local" && this.values.size ? await this.localKey(true) : undefined;
    for (const [name, value] of this.values) {
      const meta = this.file.secrets[name] ?? { hint: hintOf(value), updatedAt: Date.now() };
      const sealed = backend === "keychain" ? this.options.safeStorage!.encryptString(value).toString("base64") : sealLocal(key!, value);
      secrets[name] = { value: sealed, hint: meta.hint, updatedAt: meta.updatedAt };
    }
    this.file = { version: 1, backend, secrets };
    this.state.backend = backend;
    await this.write(this.file);
  }

  private write(file: FileShape) {
    const run = async () => {
      await mkdir(this.options.dir, { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(file, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => {});
    return next;
  }

  private async localKey(create: boolean): Promise<Buffer> {
    try {
      const key = Buffer.from((await readFile(this.keyPath, "utf8")).trim(), "base64");
      if (key.length === 32) {
        await chmod(this.keyPath, 0o600).catch(() => {});
        return key;
      }
    } catch (error) {
      if (!create) throw Error("The key that encrypts stored API keys is missing");
    }
    if (!create) throw Error("The key that encrypts stored API keys is unreadable");
    const key = randomBytes(32);
    await mkdir(this.options.dir, { recursive: true });
    await writeFile(this.keyPath, key.toString("base64"), { mode: 0o600 });
    await chmod(this.keyPath, 0o600).catch(() => {});
    return key;
  }
}

function sealLocal(key: Buffer, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function openLocal(key: Buffer, sealed: string) {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// Never pass a message through that might quote a value: these come from crypto and safeStorage.
function describe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /denied|cancel|user/i.test(message) ? "Keychain access was refused" : "The stored keys could not be read";
}

/** Whether this build should keep secrets in the Keychain (see the comment at the top). */
export async function preferredBackend(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** The .app bundle (macOS). */
  bundlePath?: string;
  /** codesign's report; injectable for tests. */
  codesign?: (bundle: string) => Promise<string>;
}): Promise<{ backend: SecretBackend; reason: string }> {
  const { env } = input;
  // Automated runs never touch the real Keychain.
  if (env.KEY_TEST || env.KEY_SKIP_ONBOARDING || env.VITEST) return { backend: "local", reason: "tests" };
  if (env.KEY_SECRETS_BACKEND === "local" || env.KEY_SECRETS_BACKEND === "keychain") return { backend: env.KEY_SECRETS_BACKEND, reason: "override" };
  if (input.platform !== "darwin") return { backend: "keychain", reason: "signed" };
  if (!input.isPackaged || !input.bundlePath) return { backend: "local", reason: "development" };
  try {
    const report = await (input.codesign ?? codesignReport)(input.bundlePath);
    return isStablySigned(report) ? { backend: "keychain", reason: "signed" } : { backend: "local", reason: "unsigned" };
  } catch {
    return { backend: "local", reason: "unsigned" };
  }
}

/** Signed by a team (Developer ID or App Store), not ad hoc: its identity survives rebuilds. */
export function isStablySigned(report: string) {
  if (/Signature=adhoc|flags=0x[0-9a-f]*\(.*adhoc/i.test(report)) return false;
  const team = report.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  return !!team && team !== "not set";
}

function codesignReport(bundle: string) {
  return new Promise<string>((resolve, reject) =>
    execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], { timeout: 5000 }, (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}\n${stderr}`))),
  );
}
