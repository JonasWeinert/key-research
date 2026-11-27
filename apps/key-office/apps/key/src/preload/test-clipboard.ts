// Test mode only (main/test-mode.ts registers it in every session): the page's clipboard is
// the run's in-memory one in main, never the system clipboard. Copy and cut keep what the page
// put on the clipboard (or the selection), paste hands the page the run's clipboard, and
// navigator.clipboard reads and writes it.
import { contextBridge, ipcRenderer } from "electron";

type Types = Record<string, string>;
const read = (): Types => ipcRenderer.sendSync("key:test-clipboard-read") ?? {};
const write = (types: Types) => void ipcRenderer.sendSync("key:test-clipboard-write", types);

const editable = (el: EventTarget | null): el is HTMLElement =>
  el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|tel|password|number|)$/.test(el.type)));

/** What the browser itself would copy: the selected text (and HTML), or a field's selection. */
function selectionTypes(): Types {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart: a, selectionEnd: b, value } = active;
    return a !== null && b !== null && b > a ? { "text/plain": value.slice(a, b) } : {};
  }
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return {};
  const holder = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) holder.append(selection.getRangeAt(i).cloneContents());
  return { "text/plain": selection.toString(), "text/html": holder.innerHTML };
}

for (const type of ["copy", "cut"] as const)
  window.addEventListener(
    type,
    (event) => {
      if (!event.isTrusted) return;
      // Runs after the page's own handlers (added now, so last on the way back up).
      window.addEventListener(
        type,
        (done) => {
          const data = done.clipboardData;
          const types: Types = {};
          if (done.defaultPrevented && data) for (const t of data.types) if (t !== "Files") types[t] = data.getData(t);
          const browserDefault = !done.defaultPrevented;
          write(browserDefault ? selectionTypes() : types);
          done.preventDefault();
          if (browserDefault && type === "cut" && editable(document.activeElement)) document.execCommand("delete");
        },
        { once: true },
      );
    },
    true,
  );

window.addEventListener(
  "paste",
  (event) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const types = read();
    const data = new DataTransfer();
    for (const [t, v] of Object.entries(types)) data.setData(t, v);
    const target = event.target ?? document.activeElement ?? document.body;
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
    target.dispatchEvent(paste);
    if (paste.defaultPrevented || !editable(document.activeElement)) return;
    const html = types["text/html"];
    if (html && document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable) document.execCommand("insertHTML", false, html);
    else if (types["text/plain"]) document.execCommand("insertText", false, types["text/plain"]);
  },
  true,
);

try {
  contextBridge.exposeInMainWorld("__keyTestClipboard", { read, write });
  contextBridge.executeInMainWorld({
    func: () => {
      const bridge = (window as unknown as { __keyTestClipboard: { read(): Types; write(t: Types): void } }).__keyTestClipboard;
      const clip = {
        readText: async () => bridge.read()["text/plain"] ?? "",
        writeText: async (text: string) => bridge.write({ "text/plain": String(text) }),
        read: async () => {
          const types = bridge.read();
          const parts: Record<string, Blob> = {};
          for (const [t, v] of Object.entries(types)) parts[t] = new Blob([v], { type: t });
          return Object.keys(parts).length ? [new ClipboardItem(parts)] : [];
        },
        write: async (items: ClipboardItem[]) => {
          const types: Types = {};
          for (const item of items) for (const t of item.types) types[t] = await (await item.getType(t)).text();
          bridge.write(types);
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      };
      Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => clip });
    },
  });
} catch {
  // A page without context isolation: copy and paste above still use the run's clipboard.
}
