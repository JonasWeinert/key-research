// The browser's one profile: a persistent partition shared by every browser tab, window,
// workspace and headless page, kept across restarts (cookies, storage, cache, logins).
// Nothing clears it but "Clear browsing data" in Settings.
import { app, session, type Session } from "electron";
import { browserUserAgent, looksLikePdf } from "./urls";

export const BROWSER_PARTITION = "persist:key-browser";
/** Permissions a page gets without asking; everything else is refused. */
const ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write"]);

const SESSION_COOKIE_DAYS = 30;
let configured: Session | undefined;
export function browserSession(): Session {
  if (configured) return configured;
  const ses = session.fromPartition(BROWSER_PARTITION, { cache: true });
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
    if (details.resourceType !== "mainFrame" || !looksLikePdf(type, undefined)) return callback({});
    const disposition = Object.keys(headers).find((name) => name.toLowerCase() === "content-disposition");
    const value = disposition ? headers[disposition][0] : "";
    if (disposition) delete headers[disposition];
    headers["Content-Disposition"] = [/^\s*attachment/i.test(value) ? value : value.replace(/^\s*inline\s*;?\s*/i, "attachment; ") || "attachment"];
    callback({ responseHeaders: headers });
  });
  // Session cookies (no expiry) would end with the app: they are kept for 30 days instead,
  // so sign-ins last across restarts the way they do in a browser that restores its session.
  ses.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session || !cookie.domain) return;
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
