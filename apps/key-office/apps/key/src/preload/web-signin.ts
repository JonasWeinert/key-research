// Runs at document start in every frame of Key's browser profile, iframes included
// (session.registerPreloadScript with nodeIntegrationInSubFrames). Passkey requests
// (navigator.credentials get/create with `publicKey`) go to Key's passkey proxy
// (main/browser/passkey-proxy.ts): a Chromium browser on this Mac shows its own passkey dialog
// (phone QR code, security key, saved passkeys) for this page's origin, and the answer comes
// back here as a PublicKeyCredential. The page and its sign-in stay in Key. When no such
// browser is there, the request goes to Electron as before, and Key says when it waits (the
// start/end reports), so the person can stop waiting or finish elsewhere. Autofill requests
// (`mediation: "conditional"`) are left to Electron: the proxy cannot offer them.
import { contextBridge, ipcRenderer } from "electron";

const token = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** Runs in the page's own world (serialized: no outside references). */
function install(token: string) {
  const container = navigator.credentials;
  if (!container || typeof PublicKeyCredential === "undefined") return;
  // What the page could tamper with later is taken now.
  const listen = addEventListener.bind(window),
    unlisten = removeEventListener.bind(window),
    send = dispatchEvent.bind(window),
    Custom = CustomEvent,
    Json = JSON,
    Dom = DOMException,
    defineProperty = Object.defineProperty,
    create = Object.create;
  const proto = Object.getPrototypeOf(container) as Record<string, unknown>;
  let next = 0;
  const b64 = (buf: ArrayBuffer | ArrayBufferView) => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const unb64 = (s: string) => {
    const t = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
    return out.buffer;
  };
  // Options to JSON: buffers as {"$b64": …}; functions and signals left out.
  const enc = (v: unknown): unknown => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $b64: b64(v as ArrayBuffer) };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== "function").map(([k, x]) => [k, enc(x)]));
    return v;
  };
  /** Asks Key (through the preload's world) and waits for the answer. */
  const ask = (op: string, payload: unknown) =>
    new Promise<{ ok?: boolean; fallback?: boolean; credential?: any; name?: string; message?: string; value?: unknown }>((resolve) => {
      const id = `${token}-${++next}`;
      const on = (event: Event) => {
        const detail = Json.parse(String((event as CustomEvent).detail));
        if (detail.id !== id) return;
        unlisten(`key-webauthn-reply-${token}`, on);
        resolve(detail);
      };
      listen(`key-webauthn-reply-${token}`, on);
      send(new Custom(`key-webauthn-ask-${token}`, { detail: Json.stringify({ id, op, payload }) }));
    });
  /** A PublicKeyCredential the page can use like a native one (own data, native prototypes). */
  const build = (json: any, kind: "get" | "create") => {
    const r = json.response;
    const response = create((kind === "get" ? AuthenticatorAssertionResponse : AuthenticatorAttestationResponse).prototype);
    const own = (target: object, values: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(values)) defineProperty(target, k, { value: v, enumerable: true, configurable: true });
    };
    own(response, { clientDataJSON: unb64(r.clientDataJSON) });
    if (kind === "get") own(response, { authenticatorData: unb64(r.authenticatorData), signature: unb64(r.signature), userHandle: r.userHandle ? unb64(r.userHandle) : null });
    else
      own(response, {
        attestationObject: unb64(r.attestationObject),
        getTransports: () => [...(r.transports ?? [])],
        getAuthenticatorData: () => unb64(r.authenticatorData),
        getPublicKey: () => (r.publicKey ? unb64(r.publicKey) : null),
        getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      });
    const credential = create(PublicKeyCredential.prototype);
    const extensions = json.clientExtensionResults ?? {};
    own(credential, {
      id: json.id,
      rawId: unb64(json.rawId),
      type: "public-key",
      authenticatorAttachment: json.authenticatorAttachment ?? null,
      response,
      getClientExtensionResults: () => Json.parse(Json.stringify(extensions)),
      toJSON: () => Json.parse(Json.stringify(json)),
    });
    return credential as PublicKeyCredential;
  };
  for (const kind of ["get", "create"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, kind);
    const original = descriptor?.value as ((this: CredentialsContainer, options?: CredentialRequestOptions) => Promise<Credential | null>) | undefined;
    if (!descriptor || typeof original !== "function") continue;
    const methods = {
      [kind](this: CredentialsContainer, options?: CredentialRequestOptions & CredentialCreationOptions) {
        const publicKey = options?.publicKey as (PublicKeyCredentialRequestOptions & PublicKeyCredentialCreationOptions) | undefined;
        if (!publicKey || options?.mediation === "conditional") return original.call(this, options);
        const signal = options!.signal;
        if (signal?.aborted) return Promise.reject(signal.reason ?? new Dom("The request was aborted.", "AbortError"));
        const self = this;
        return (async () => {
          let id = "";
          const onAbort = () => void ask("abort", { request: id });
          const asked = ask(kind, { options: enc(publicKey) });
          id = `${token}-${next}`;
          signal?.addEventListener("abort", onAbort, { once: true });
          const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason ?? new Dom("The request was aborted.", "AbortError")), { once: true }));
          try {
            const answer = await Promise.race([asked, aborted]);
            if (answer.fallback) return passOn(self, options!);
            if (!answer.ok) throw new Dom(answer.message || "The passkey request did not finish.", answer.name || "NotAllowedError");
            return build(answer.credential, kind);
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
        })();
      },
    };
    // Without the proxy: Electron's own WebAuthn, with Key watching for an endless wait.
    const passOn = (self: CredentialsContainer, options: CredentialRequestOptions & CredentialCreationOptions) => {
      const publicKey = options.publicKey as PublicKeyCredentialRequestOptions & PublicKeyCredentialCreationOptions;
      const id = ++next;
      const stop = new AbortController();
      const signal = options.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([options.signal, stop.signal]) : options.signal ?? stop.signal;
      const onStop = () => stop.abort(new Dom("The sign-in was stopped.", "NotAllowedError"));
      listen(`key-webauthn-stop-${token}`, onStop);
      const report = (state: string, extra: Record<string, unknown> = {}) =>
        send(new Custom(`key-webauthn-${token}`, { detail: Json.stringify({ id, kind, state, rpId: String((kind === "get" ? publicKey.rpId : publicKey.rp?.id) || location.hostname), ...extra }) }));
      report("start");
      const done = (ok: boolean, error?: string) => {
        unlisten(`key-webauthn-stop-${token}`, onStop);
        report("end", { ok, error });
      };
      return original.call(self, { ...options, signal }).then(
        (value) => (done(true), value),
        (error: unknown) => {
          done(false, error instanceof Error ? error.name : "Error");
          throw error;
        },
      );
    };
    defineProperty(proto, kind, { ...descriptor, value: methods[kind] });
  }
  // What the proxy can do, truthfully: a platform passkey and a phone (through the browser's
  // dialog) when a Chromium browser is there; no autofill passkeys.
  const statics: Record<string, () => Promise<unknown>> = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => !!(await ask("available", {})).value,
    isConditionalMediationAvailable: async () => false,
    getClientCapabilities: async () => {
      const proxy = !!(await ask("available", {})).value;
      return { conditionalGet: false, conditionalCreate: false, hybridTransport: proxy, passkeyPlatformAuthenticator: proxy, userVerifyingPlatformAuthenticator: proxy, relatedOrigins: false, signalAllAcceptedCredentials: false, signalCurrentUserDetails: false, signalUnknownCredential: false };
    },
  };
  for (const [name, fn] of Object.entries(statics)) if (name in PublicKeyCredential) defineProperty(PublicKeyCredential, name, { value: fn, configurable: true, writable: true });
}

try {
  contextBridge.executeInMainWorld({ func: install, args: [token] });
  // Requests to the proxy: the user activation is read here, where the page cannot fake it.
  addEventListener(`key-webauthn-ask-${token}`, (event) => {
    const raw = (event as CustomEvent).detail;
    if (typeof raw !== "string" || raw.length > 200_000) return;
    let message: { id: string; op: string; payload: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const activation = !!navigator.userActivation?.isActive;
    void ipcRenderer
      .invoke("key-browser:passkey", message.op, { id: message.id, activation, ...(message.payload as object) })
      .then(
        (answer) => answer,
        (error) => ({ ok: false, name: "NotAllowedError", message: String(error?.message ?? error) }),
      )
      .then((answer) => dispatchEvent(new CustomEvent(`key-webauthn-reply-${token}`, { detail: JSON.stringify({ id: message.id, ...answer }) })));
  });
  addEventListener(`key-webauthn-${token}`, (event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail === "string" && detail.length < 2000) ipcRenderer.send("key-browser:webauthn", detail);
  });
  ipcRenderer.on("key-browser:webauthn-stop", () => dispatchEvent(new Event(`key-webauthn-stop-${token}`)));
} catch {
  /* a page without a main world (or an old runtime): nothing to watch */
}
