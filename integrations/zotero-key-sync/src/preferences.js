/* Key Sync preferences pane: pairing code, status and a sync request. */
/* global Zotero */
window.KeySyncPrefs = {
  init(win) {
    const doc = (win || window).document;
    const plugin = Zotero.KeySync;
    const token = doc.getElementById("key-sync-token");
    const status = doc.getElementById("key-sync-status");
    if (!plugin || !token || token.dataset.ready) return;
    token.dataset.ready = "1";
    const show = () => {
      token.value = plugin.token();
      const s = plugin.status();
      const seen = s.lastClientAt ? `Key last checked ${new Date(s.lastClientAt).toLocaleString()}.` : "Key has not connected yet.";
      status.textContent = `${seen} ${s.size.toLocaleString()} changes kept (latest ${s.seq.toLocaleString()}). Listening on 127.0.0.1:${s.port}.`;
    };
    doc.getElementById("key-sync-copy").addEventListener("command", () => {
      Zotero.Utilities.Internal.copyTextToClipboard(plugin.token());
    });
    doc.getElementById("key-sync-regenerate").addEventListener("command", () => {
      plugin.regenerateToken();
      show();
    });
    doc.getElementById("key-sync-now").addEventListener("command", () => {
      plugin.ping();
      show();
    });
    show();
    const timer = setInterval(() => {
      if (!doc.defaultView || !doc.getElementById("key-sync-token")) clearInterval(timer);
      else show();
    }, 5000);
  },
};
// Panes in Zotero 8 may load the script after the fragment's onload has run.
if (document.getElementById("key-sync-token")) window.KeySyncPrefs.init(window);
