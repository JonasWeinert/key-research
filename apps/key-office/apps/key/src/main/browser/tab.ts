// A browser tab's page: a WebContentsView on the browser profile that reports what its
// tab and bar show (title, favicon, back/forward, loading) and offers the usual context menu.
import { clipboard, Menu, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from "electron";
import { browserSession } from "./profile";
import { harden, newPageView } from "./pages";
import { webUrl } from "./urls";

export interface WebTabState {
  url: string;
  title: string;
  favicon?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** A page has been shown (a tab opened straight onto a PDF never shows one). */
  committed: boolean;
}
export interface WebTabHooks {
  changed(patch: Partial<WebTabState>): void;
  /** A link to open in a tab of its own; `background` keeps this tab in front. */
  open(url: string, background: boolean): void;
  /** Opens in the system's default browser. */
  external(url: string): void;
  window(): BaseWindow | undefined;
}

const favicons = new Map<string, string>();
/** A favicon as a data URL (the shell cannot load remote images), fetched with the profile. */
async function faviconData(url: string) {
  const known = favicons.get(url);
  if (known) return known;
  const response = await browserSession().fetch(url, { signal: AbortSignal.timeout(5000) });
  const type = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || !/^image\//i.test(type) || bytes.length > 100_000) throw Error("No usable favicon");
  const data = `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
  if (favicons.size > 200) favicons.clear();
  favicons.set(url, data);
  return data;
}

function errorPage(url: string, description: string) {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Can’t open this page</title>
<style>:root{color-scheme:light dark;font:13px -apple-system,system-ui,sans-serif}body{margin:0;display:grid;place-items:center;height:100vh;background:Canvas;color:CanvasText}
main{max-width:420px;padding:24px}h1{font-size:17px;font-weight:600;margin:0 0 8px}p{margin:0 0 6px;opacity:.7;line-height:1.45;overflow-wrap:anywhere}</style>
<main><h1>Can’t open this page</h1><p>${escape(description)}</p><p>${escape(url)}</p></main>`)}`;
}

export function createWebTab(url: string, hooks: WebTabHooks) {
  const view = newPageView();
  const contents = view.webContents;
  harden(contents, (target, disposition) => hooks.open(target, disposition === "background-tab"));
  let failedUrl: string | undefined;
  const history = () => ({
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
  contents.on("did-start-loading", () => hooks.changed({ loading: true }));
  contents.on("did-stop-loading", () => hooks.changed({ loading: false, ...history() }));
  contents.on("did-navigate", (_event, target) => {
    // The error page stands in for the URL that failed.
    if (target.startsWith("data:")) return hooks.changed({ committed: true, ...history() });
    failedUrl = undefined;
    hooks.changed({ url: target, committed: true, ...history() });
  });
  contents.on("did-navigate-in-page", (_event, target, isMainFrame) => {
    if (isMainFrame) hooks.changed({ url: target, ...history() });
  });
  contents.on("page-title-updated", (_event, title) => {
    if (!failedUrl) hooks.changed({ title });
  });
  contents.on("page-favicon-updated", (_event, icons) => {
    const icon = icons.find((i) => webUrl(i));
    if (icon) void faviconData(icon).then((favicon) => hooks.changed({ favicon }), () => undefined);
  });
  contents.on("did-fail-load", (_event, code, description, target, isMainFrame) => {
    // -3: aborted (a download, or a newer navigation); errors on the error page itself are left alone.
    if (!isMainFrame || code === -3 || target.startsWith("data:")) return;
    failedUrl = target;
    hooks.changed({ url: target, title: "Can’t open this page", favicon: undefined, loading: false });
    void contents.loadURL(errorPage(target, description || `Error ${code}`)).catch(() => undefined);
  });
  contents.on("context-menu", (_event, params) => {
    const page = failedUrl ?? contents.getURL();
    const link = webUrl(params.linkURL);
    const image = params.mediaType === "image" ? webUrl(params.srcURL) : undefined;
    const items: MenuItemConstructorOptions[] = [];
    if (link)
      items.push(
        { label: "Open Link in New Tab", click: () => hooks.open(link, false) },
        { label: "Open Link in Default Browser", click: () => hooks.external(link) },
        { label: "Copy Link", click: () => clipboard.writeText(link) },
        { type: "separator" },
      );
    if (image)
      items.push(
        { label: "Open Image in New Tab", click: () => hooks.open(image, false) },
        { label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) },
        { type: "separator" },
      );
    if (params.isEditable)
      items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, { type: "separator" });
    else if (params.selectionText.trim()) items.push({ role: "copy" }, { type: "separator" });
    items.push(
      { label: "Back", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: "Forward", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: "Reload", click: () => contents.reload() },
    );
    if (webUrl(page))
      items.push(
        { type: "separator" },
        { label: "Open Page in Default Browser", click: () => hooks.external(page) },
        { label: "Copy Page Link", click: () => clipboard.writeText(page) },
      );
    const window = hooks.window();
    Menu.buildFromTemplate(items).popup(window ? { window } : {});
  });
  void contents.loadURL(url).catch(() => undefined);
  return view;
}

/** The page a tab shows now (the failed URL while its error page is up). */
export function currentUrl(contents: WebContents, fallback: string) {
  const url = contents.getURL();
  return webUrl(url) ?? fallback;
}
