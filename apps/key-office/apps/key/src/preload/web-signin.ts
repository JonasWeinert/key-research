// Runs at document start in every frame of Key's browser profile, iframes included
// (session.registerPreloadScript with nodeIntegrationInSubFrames). It only tells the app when a
// page starts and ends a passkey request (navigator.credentials get/create with `publicKey`;
// not the quiet autofill kind, `mediation: "conditional"`, which waits by design), so Key can
// offer its sign-in window instead of an endless wait, and lets the person stop waiting: the
// page then hears NotAllowedError, as if they had cancelled a browser's passkey dialog. The
// request itself is passed on unchanged.
import { contextBridge, ipcRenderer } from "electron";

const token = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

function install(token: string) {
  const container = navigator.credentials;
  if (!container || typeof PublicKeyCredential === "undefined") return;
  const proto = Object.getPrototypeOf(container) as Record<string, unknown>;
  let next = 0;
  for (const kind of ["get", "create"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, kind);
    const original = descriptor?.value as ((this: CredentialsContainer, options?: CredentialRequestOptions) => Promise<Credential | null>) | undefined;
    if (!descriptor || typeof original !== "function") continue;
    const methods = {
      [kind](this: CredentialsContainer, options?: CredentialRequestOptions & CredentialCreationOptions) {
        const publicKey = options?.publicKey as (PublicKeyCredentialRequestOptions & PublicKeyCredentialCreationOptions) | undefined;
        if (!publicKey || options?.mediation === "conditional") return original.call(this, options);
        const id = ++next;
        const stop = new AbortController();
        const signal = options!.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([options!.signal, stop.signal]) : options!.signal ?? stop.signal;
        const onStop = () => stop.abort(new DOMException("The sign-in was stopped.", "NotAllowedError"));
        addEventListener(`key-webauthn-stop-${token}`, onStop);
        const list = (kind === "get" ? publicKey.allowCredentials : publicKey.excludeCredentials) ?? [];
        const transports = [...new Set(list.flatMap((c) => (c && Array.isArray(c.transports) ? c.transports : [])))];
        const report = (state: string, extra: Record<string, unknown> = {}) =>
          dispatchEvent(
            new CustomEvent(`key-webauthn-${token}`, {
              detail: JSON.stringify({
                id,
                kind,
                state,
                rpId: String((kind === "get" ? publicKey.rpId : publicKey.rp?.id) || location.hostname),
                ...extra,
              }),
            }),
          );
        report("start", {
          transports,
          allowed: list.length,
          userVerification: (kind === "get" ? publicKey.userVerification : publicKey.authenticatorSelection?.userVerification) ?? "preferred",
        });
        const done = (ok: boolean, error?: string) => {
          removeEventListener(`key-webauthn-stop-${token}`, onStop);
          report("end", { ok, error });
        };
        return original.call(this, { ...options, signal }).then(
          (value) => (done(true), value),
          (error: unknown) => {
            done(false, error instanceof Error ? error.name : "Error");
            throw error;
          },
        );
      },
    };
    Object.defineProperty(proto, kind, { ...descriptor, value: methods[kind] });
  }
}

try {
  contextBridge.executeInMainWorld({ func: install, args: [token] });
  addEventListener(`key-webauthn-${token}`, (event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail === "string" && detail.length < 2000) ipcRenderer.send("key-browser:webauthn", detail);
  });
  ipcRenderer.on("key-browser:webauthn-stop", () => dispatchEvent(new Event(`key-webauthn-stop-${token}`)));
} catch {
  /* a page without a main world (or an old runtime): nothing to watch */
}
