// The browser's one profile: a persistent partition shared by every browser tab, window,
// workspace and headless page, kept across restarts (cookies, storage, cache, logins).
// Nothing clears it but "Clear browsing data" in Settings.
import { app, session, type Session } from "electron";
import { browserUserAgent, looksLikePdf } from "./urls";

export const BROWSER_PARTITION = "persist:key-browser";
/** Permissions a page gets without asking; everything else is refused. */
const ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write", "storage-access", "top-level-storage-access"]);
/** Bot-check cookies (Cloudflare's) are left exactly as the check sets them. */
const CHALLENGE_COOKIE = /^(__cf|cf_|__cflb|_cfuvid)/i;

const SESSION_COOKIE_DAYS = 30;
/** PDFs a page's frames tried to load, by the page's contents id (a few each). */
const pdfFrames = new Map<number, string[]>();
function notePdfFrame(contentsId: number, url: string) {
  const list = pdfFrames.get(contentsId) ?? [];
  pdfFrames.set(contentsId, [url, ...list.filter((u) => u !== url)].slice(0, 8));
  if (pdfFrames.size > 200) pdfFrames.delete(pdfFrames.keys().next().value!);
}
/** Whether a frame of this page was a PDF at `url`. */
export function wasPdfFrame(contentsId: number, url: string) {
  return pdfFrames.get(contentsId)?.includes(url) ?? false;
}
let configured: Session | undefined;
export function browserSession(): Session {
  if (configured) return configured;
  const ses = session.fromPartition(BROWSER_PARTITION, { cache: true });
  // Chrome's user agent (requests, `navigator`, workers alike). Accept-Language is left as
  // Chromium sends it: overriding it here does not reach `navigator.languages`, and a header
  // that disagrees with the page's languages is itself what bot checks look for.
  ses.setUserAgent(browserUserAgent(app.userAgentFallback, app.getName()));
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  // Bluetooth, HID, serial, USB: never chosen on a page's behalf.
  ses.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback("");
  });
  ses.on("select-serial-port", (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback("");
  });
  ses.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  // A page that is a PDF is downloaded instead of shown in Chromium's viewer: the download
  // (with this profile's cookies) opens in the app's own reader. See BrowserService.
  ses.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const headers = details.responseHeaders ?? {};
    const type = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]?.[0];
    if (!looksLikePdf(type, undefined)) return callback({});
    // A PDF in a frame or object would show in Chromium's viewer (`plugins: false` does not
    // stop it): it is not loaded. A page that is only that PDF opens it in the reader instead
    // (see PageActions); the address is noted for that.
    if (details.resourceType === "subFrame" || details.resourceType === "object") {
      if (details.webContentsId !== undefined) notePdfFrame(details.webContentsId, details.url);
      return callback({ cancel: true });
    }
    if (details.resourceType !== "mainFrame") return callback({});
    const disposition = Object.keys(headers).find((name) => name.toLowerCase() === "content-disposition");
    const value = disposition ? headers[disposition][0] : "";
    if (disposition) delete headers[disposition];
    headers["Content-Disposition"] = [/^\s*attachment/i.test(value) ? value : value.replace(/^\s*inline\s*;?\s*/i, "attachment; ") || "attachment"];
    callback({ responseHeaders: headers });
  });
  // Session cookies (no expiry) would end with the app: they are kept for 30 days instead,
  // so sign-ins last across restarts the way they do in a browser that restores its session.
  ses.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session || !cookie.domain || CHALLENGE_COOKIE.test(cookie.name) || /(^|\.)cloudflare\.com$/i.test(cookie.domain)) return;
    const host = cookie.domain.replace(/^\./, "");
    void ses.cookies
      .set({
        url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: Date.now() / 1000 + SESSION_COOKIE_DAYS * 86400,
      })
      .catch(() => undefined);
  });
  // Cookies reach disk now, not only when Chromium gets round to it.
  app.on("before-quit", () => void ses.cookies.flushStore().catch(() => undefined));
  configured = ses;
  return ses;
}

/** Wipes the profile: cookies, storage, cache, logins. */
export async function clearBrowsingData() {
  const ses = browserSession();
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  await ses.clearHostResolverCache();
  await ses.cookies.flushStore();
}
