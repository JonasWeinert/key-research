// The passkey proxy: a passkey request of a page in Key's browser is answered by the passkey
// dialog of a Chromium browser on this Mac (Chrome, Edge, Brave…), which Electron lacks: the
// QR code for a phone, security keys, the browser's own passkey providers. The page and the
// whole sign-in stay in Key; only the request and its answer cross over, and no cookie moves.
// Chrome runs with a profile of Key's own (never the person's), driven over a private DevTools
// pipe. For each request it shows a small window on a blank document of the REQUESTING ORIGIN,
// served by Key itself (Fetch.fulfillRequest: nothing of the site loads there and no request
// leaves Chrome), and asks for the credential there, so Chrome's own WebAuthn checks (origin,
// secure context, rp ID) apply. A frame of another origin is reproduced as such (a blank page of
// the top origin with an iframe of the frame's origin and the passkey permission policy).
// The answer's clientDataJSON must name the requesting origin, or it is refused.
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe } from "./cdp-pipe";
import { activateProcess, endStaleInstance, type ChromiumApp } from "./sign-in-window";

export type PasskeyOp = "get" | "create";
/** A credential as `PublicKeyCredential.toJSON()` gives it (buffers as base64url). */
export interface CredentialJson {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: string | null;
  clientExtensionResults?: Record<string, unknown>;
  response: Record<string, unknown> & { clientDataJSON: string };
}
export type PasskeyErrorName = "NotAllowedError" | "SecurityError" | "InvalidStateError" | "NotSupportedError" | "AbortError" | "TypeError" | "UnknownError" | "ConstraintError";
export class PasskeyError extends Error {
  constructor(
    readonly kind: PasskeyErrorName,
    message: string,
  ) {
    super(message);
  }
}

/** Whether a page at `origin` may use passkeys for `rpId` (its host or a parent domain of it;
 * https, or http on this computer), and the effective rp ID. Chrome checks again. */
export function checkRequest(origin: string, rpId: string | undefined) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new PasskeyError("SecurityError", "This page cannot use passkeys.");
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new PasskeyError("SecurityError", "Passkeys need a secure (https) page.");
  const host = url.hostname.toLowerCase();
  const rp = (rpId || host).toLowerCase();
  if (!(host === rp || host.endsWith(`.${rp}`)) || (!rp.includes(".") && rp !== "localhost")) throw new PasskeyError("SecurityError", `${url.origin} may not use passkeys for ${rp}.`);
  return rp;
}

const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
/** The client data Chrome signed must be for this origin, this kind of request and this
 * embedding, or the answer is not passed on. */
export function checkClientData(credential: CredentialJson, op: PasskeyOp, origin: string, crossOrigin: boolean) {
  let data: { type?: string; origin?: string; crossOrigin?: boolean };
  try {
    data = JSON.parse(b64urlDecode(String(credential.response?.clientDataJSON ?? "")).toString("utf8"));
  } catch {
    throw new PasskeyError("SecurityError", "The passkey answer could not be read.");
  }
  if (data.origin !== origin || data.type !== (op === "get" ? "webauthn.get" : "webauthn.create") || !!data.crossOrigin !== crossOrigin)
    throw new PasskeyError("SecurityError", "The passkey answer was not made for this page.");
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE = (title: string, text: string, frame?: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>
  html{color-scheme:light dark}body{margin:0;display:grid;place-items:center;height:100vh;font:14px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;padding:0 28px;box-sizing:border-box}
  b{display:block;font-size:15px;margin-bottom:6px}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;opacity:0}</style></head>
  <body><div><b>${escape(title)}</b>${escape(text)}</div>${frame ? `<iframe allow="publickey-credentials-get *; publickey-credentials-create *" src="${escape(frame)}"></iframe>` : ""}</body></html>`;
/** A path no site uses, so nothing cached or registered for it applies. */
const BLANK_PATH = "/.well-known/key-passkey";

/** Runs in Chrome, on the blank document of the requesting origin: the request with the page's
 * options (buffers as {"$b64": …}), answered as `toJSON()`. */
const CEREMONY = (op: PasskeyOp, options: unknown) => `(async () => {
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object") {
      if (typeof v.$b64 === "string") { const s = atob(v.$b64.replace(/-/g, "+").replace(/_/g, "/")); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
    }
    return v;
  };
  const b64 = (buf) => { const b = new Uint8Array(buf); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
  window.__keyAbort = new AbortController();
  try {
    const c = await navigator.credentials.${op}({ publicKey: dec(${JSON.stringify(options)}), signal: window.__keyAbort.signal });
    if (!c) return JSON.stringify({ error: "NotAllowedError", message: "No passkey was chosen." });
    let json;
    try { json = c.toJSON(); } catch {
      const r = c.response;
      json = { id: c.id, rawId: b64(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: {}, response: { clientDataJSON: b64(r.clientDataJSON) } };
      if (r.signature) Object.assign(json.response, { authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : null });
      else Object.assign(json.response, { attestationObject: b64(r.attestationObject), authenticatorData: b64(r.getAuthenticatorData()), transports: r.getTransports(), publicKey: r.getPublicKey() ? b64(r.getPublicKey()) : null, publicKeyAlgorithm: r.getPublicKeyAlgorithm() });
    }
    return JSON.stringify({ credential: json });
  } catch (e) {
    return JSON.stringify({ error: (e && e.name) || "UnknownError", message: String((e && e.message) || e) });
  }
})()`;

export interface PasskeyRequest {
  op: PasskeyOp;
  /** The page's options, buffers as {"$b64": …}. */
  options: Record<string, unknown>;
  /** The requesting frame's origin (from Electron, never from the page). */
  origin: string;
  /** The top frame's origin. */
  topOrigin: string;
  /** For the window's title and text. */
  site: string;
  near?: { x: number; y: number; width: number; height: number };
}

interface Options {
  app: ChromiumApp;
  profileDir: string;
  headless?: boolean;
  virtualAuthenticator?: boolean;
  onTrace?(event: string, detail: Record<string, unknown>): void;
}

/** A Chrome instance for passkey requests: started on demand, closed after each request (test
 * runs keep it a minute, with one virtual authenticator, for the next request). */
export class PasskeyProxy {
  private child?: ChildProcess;
  private pipe?: CdpPipe;
  private target = "";
  private session = "";
  private evalSession = "";
  private frameSessions = new Map<string, string>();
  private documents = new Map<string, string>();
  private authenticator = false;
  private idle?: ReturnType<typeof setTimeout>;
  private busy = false;
  constructor(private readonly options: Options) {}

  private trace(event: string, detail: Record<string, unknown> = {}) {
    this.options.onTrace?.(event, detail);
  }
  get app() {
    return this.options.app;
  }
  get running() {
    return !!this.pipe && !this.pipe.closed && this.child?.exitCode === null && this.child.signalCode === null;
  }

  private async start(near?: PasskeyRequest["near"]) {
    if (this.running) return;
    const { profileDir, app, headless } = this.options;
    await mkdir(dirname(profileDir), { recursive: true, mode: 0o700 });
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await chmod(profileDir, 0o700);
    await endStaleInstance(profileDir, (detail) => this.trace("passkey-stale", detail));
    const width = 460,
      height = 360;
    const x = near ? Math.round(near.x + (near.width - width) / 2) : undefined;
    const y = near ? Math.round(near.y + Math.max(60, (near.height - height) / 3)) : undefined;
    const args = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--hide-crash-restore-bubble",
      "--disable-default-apps",
      `--window-size=${width},${height}`,
      ...(x !== undefined && y !== undefined ? [`--window-position=${x},${y}`] : []),
      ...(headless ? ["--headless=new", "--use-mock-keychain", "about:blank"] : ["--app=about:blank"]),
    ];
    const child = spawn(app.executable, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    child.once("error", () => undefined);
    const pipe = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    this.child = child;
    this.pipe = pipe;
    this.authenticator = false;
    child.once("exit", () => pipe.close());
    this.trace("passkey-start", { pid: child.pid, kind: headless ? "headless" : "app window" });
    try {
      await pipe.send("Browser.getVersion", {}, undefined, Number(process.env.KEY_SIGNIN_LAUNCH_MS) || 20_000);
    } catch {
      child.kill();
      throw new PasskeyError("NotAllowedError", `${app.name} could not open the passkey window.`);
    }
    pipe.on((method, params, sessionId) => void this.event(method, params, sessionId));
    const end = Date.now() + 15_000;
    let page: string | undefined;
    while (!page && Date.now() < end) {
      const { targetInfos } = await pipe.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
      const pages = targetInfos.filter((t) => t.type === "page");
      page = pages.find((t) => t.url === "about:blank" || t.url === "")?.targetId;
      for (const other of pages) if (page && other.targetId !== page) await pipe.send("Target.closeTarget", { targetId: other.targetId }).catch(() => undefined);
      if (!page) await new Promise((r) => setTimeout(r, 150));
    }
    if (!page) throw new PasskeyError("NotAllowedError", "The passkey window did not open.");
    this.target = page;
    const { sessionId } = await pipe.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page, flatten: true });
    this.session = sessionId;
    await this.prepare(sessionId);
    await pipe.send("Page.enable", {}, sessionId).catch(() => undefined);
  }

  /** A page or frame session: only Key's blank documents load; new frames wait until ready. */
  private async prepare(sessionId: string) {
    const pipe = this.pipe!;
    await pipe.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId).catch(() => undefined);
    await pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => undefined);
  }

  private async event(method: string, params: Record<string, any>, sessionId?: string) {
    const pipe = this.pipe!;
    if (method === "Fetch.requestPaused") {
      const body = this.documents.get(String(params.request?.url ?? ""));
      // Only the blank documents Key serves; nothing else loads, nothing leaves Chrome.
      if (body !== undefined && params.resourceType === "Document")
        await pipe
          .send(
            "Fetch.fulfillRequest",
            {
              requestId: params.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: "Content-Type", value: "text/html; charset=utf-8" },
                { name: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; frame-src *" },
                { name: "Cache-Control", value: "no-store" },
              ],
              body: Buffer.from(body).toString("base64"),
            },
            sessionId,
          )
          .catch(() => undefined);
      else await pipe.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
      return;
    }
    if (method === "Target.attachedToTarget" && params.sessionId) {
      if (params.targetInfo?.type === "iframe") {
        this.frameSessions.set(params.targetInfo.targetId, params.sessionId);
        await this.prepare(params.sessionId);
        await pipe.send("Page.enable", {}, params.sessionId).catch(() => undefined);
      }
      await pipe.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => undefined);
    }
  }

  /** Test runs: Chrome's virtual authenticator stands in for the phone (one per window). */
  private async virtualAuthenticator() {
    if (!this.options.virtualAuthenticator || this.authenticator) return;
    this.authenticator = true;
    const send = <T = unknown>(m: string, p: Record<string, unknown>) => this.pipe!.send<T>(m, p, this.session);
    await send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    // Smokes take the "person" away (no touch) to test cancel, timeout and abort.
    Object.assign(globalThis, { keyPasskeyPresence: (presence: boolean) => send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: presence }) });
  }

  /** Asks Chrome for the credential: its passkey dialog shows over the small window. */
  async request(request: PasskeyRequest, signal: AbortSignal): Promise<CredentialJson> {
    if (this.busy) throw new PasskeyError("NotAllowedError", "Another passkey request is still open.");
    this.busy = true;
    clearTimeout(this.idle);
    let aborted = false;
    // Stopped by the page (its AbortSignal: AbortError) or by the person in Key (Cancel:
    // NotAllowedError, as when a browser's passkey dialog is cancelled).
    const stopped = () => (signal.reason === "cancel" ? new PasskeyError("NotAllowedError", "The passkey request was cancelled.") : new PasskeyError("AbortError", "The passkey request was stopped."));
    const abortNow = () => {
      aborted = true;
      this.trace("passkey-abort", { reason: String(signal.reason) });
      void this.pipe?.send("Runtime.evaluate", { expression: "window.__keyAbort && window.__keyAbort.abort()" }, this.evalSession).catch(() => undefined);
      // If the request does not end, its document does.
      setTimeout(() => {
        if (this.busy) void this.pipe?.send("Page.navigate", { url: "about:blank" }, this.session).catch(() => undefined);
      }, 600);
    };
    signal.addEventListener("abort", abortNow, { once: true });
    try {
      await this.start(request.near);
      await this.virtualAuthenticator();
      const crossOrigin = request.topOrigin !== request.origin;
      const title = `Passkey for ${request.site} — Key`;
      const text = `Use your passkey to finish signing in to ${request.site} in Key.`;
      const frameUrl = `${request.origin}${BLANK_PATH}`;
      const topUrl = crossOrigin ? `${request.topOrigin}${BLANK_PATH}` : frameUrl;
      this.documents.clear();
      this.frameSessions.clear();
      if (crossOrigin) {
        this.documents.set(topUrl, PAGE(title, text, frameUrl));
        this.documents.set(frameUrl, "<!doctype html><title>Key</title>");
      } else this.documents.set(frameUrl, PAGE(title, text));
      this.trace("passkey-window", { origin: request.origin, crossOrigin });
      await this.navigate(topUrl);
      this.evalSession = this.session;
      let context: number | undefined;
      if (crossOrigin) {
        // The frame of the requesting origin: in its own process (target) when site-isolated.
        const end = Date.now() + 8000;
        while (!context && Date.now() < end) {
          context = await this.frameContext(frameUrl);
          if (!context) await new Promise((r) => setTimeout(r, 100));
        }
        if (!context) throw new PasskeyError("NotSupportedError", "The passkey request of this embedded page could not be reproduced.");
      }
      if (signal.aborted) throw stopped();
      void this.focus();
      const answer = await this.pipe!.send<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        { expression: CEREMONY(request.op, request.options), awaitPromise: true, userGesture: true, returnByValue: true, ...(context ? { contextId: context } : {}) },
        this.evalSession,
        Math.min(Number(request.options.timeout) || 300_000, 600_000) + 15_000,
      );
      const value = JSON.parse(answer.result?.value ?? "{}") as { credential?: CredentialJson; error?: string; message?: string };
      if (aborted) throw stopped();
      if (!value.credential) throw new PasskeyError((value.error as PasskeyErrorName) || "NotAllowedError", value.message || "No passkey was used.");
      checkClientData(value.credential, request.op, request.origin, crossOrigin);
      this.trace("passkey-done", { origin: request.origin });
      return value.credential;
    } catch (error) {
      this.trace("passkey-failed", { reason: error instanceof PasskeyError ? error.kind : "error" });
      if (aborted) throw stopped();
      if (error instanceof PasskeyError) throw error;
      throw new PasskeyError("NotAllowedError", (error as Error).message);
    } finally {
      signal.removeEventListener("abort", abortNow);
      this.busy = false;
      await this.rest();
    }
  }

  private async navigate(url: string) {
    const pipe = this.pipe!;
    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(() => (off(), resolve()), 8000);
      const off = pipe.on((method, _params, sessionId) => {
        if (method === "Page.loadEventFired" && sessionId === this.session) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    const { errorText } = await pipe.send<{ errorText?: string }>("Page.navigate", { url }, this.session);
    if (errorText) throw new PasskeyError("NotAllowedError", `The passkey window could not open: ${errorText}`);
    await loaded;
  }

  /** An execution context of the frame showing `url` (its own target when site-isolated). */
  private async frameContext(url: string) {
    for (const sessionId of [...this.frameSessions.values(), this.session]) {
      type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] };
      const tree = await this.pipe!.send<{ frameTree: Tree }>("Page.getFrameTree", {}, sessionId).catch(() => undefined);
      if (!tree) continue;
      const all: Tree["frame"][] = [];
      const walk = (t: Tree) => (all.push(t.frame), t.childFrames?.forEach(walk));
      walk(tree.frameTree);
      const frame = all.find((f) => f.url === url);
      if (!frame) continue;
      const world = await this.pipe!.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.id, worldName: "key-passkey" }, sessionId).catch(() => undefined);
      if (world?.executionContextId) {
        this.evalSession = sessionId;
        return world.executionContextId;
      }
    }
    return undefined;
  }

  /** Brings the passkey window forward (Key's Chrome process, never the person's Chrome). */
  async focus() {
    if (this.options.headless || !this.child?.pid) return;
    await this.pipe?.send("Target.activateTarget", { targetId: this.target }).catch(() => undefined);
    if (process.platform === "darwin") await activateProcess(this.child.pid).catch(() => undefined);
  }

  private async rest() {
    this.documents.clear();
    if (this.options.headless) {
      await this.pipe?.send("Page.navigate", { url: "about:blank" }, this.session).catch(() => undefined);
      this.idle = setTimeout(() => void this.close(), 60_000);
    } else await this.close();
  }

  async close() {
    clearTimeout(this.idle);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await this.pipe?.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => (child.kill(), resolve()), 4000);
      child.once("exit", () => (clearTimeout(timer), resolve()));
    });
  }
}
