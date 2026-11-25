/* Key Sync for Zotero 7 and 8: a bootstrapped plugin. See key-sync.js. */
/* global Zotero, Services */
var KeySync;
var KeySyncCore;

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "key-sync-core.js");
  Services.scriptloader.loadSubScript(rootURI + "key-sync.js");
  Zotero.KeySync = KeySync;
  Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "preferences.xhtml",
    scripts: [rootURI + "preferences.js"],
    label: "Key Sync",
  });
  await KeySync.startup({ id, version, rootURI });
}

function shutdown() {
  if (KeySync) KeySync.shutdown();
  if (typeof Zotero !== "undefined") delete Zotero.KeySync;
  KeySync = undefined;
  KeySyncCore = undefined;
}

function install() {}

function uninstall() {}
