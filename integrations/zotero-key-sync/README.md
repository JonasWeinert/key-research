# Key Sync for Zotero

A Zotero plugin that keeps Key in step with a Zotero library, instead of a one-time import.
It targets Zotero 7, 8 and 9 (tested on Zotero 9.0.6) and only reads from Zotero.

## Install

1. Build the plugin: `node integrations/zotero-key-sync/build.mjs` → `dist/key-sync.xpi`.
   Key's packaged app carries the same file; its Zotero sheet has **Show plugin in Finder**.
2. In Zotero: **Tools → Plugins**, then drag `key-sync.xpi` onto the window (or use the gear
   menu → **Install Plugin From File…**).
3. In Key: **Add → Import from Zotero…**, choose **Keep in sync**, then what to sync.

Key finds the pairing code in Zotero's preferences file on its own. If it cannot (for example
with a custom Zotero profile), copy the code from **Zotero → Settings → Key Sync** into Key.

## How it works

- A `Zotero.Notifier` observer records every change to items, notes, attachments, annotations,
  tags, collections and collection membership in a change journal, as the top-level item (or
  collection) that changed. Each change gets the next sequence number; only the latest change
  per object is kept. The journal is saved to `<Zotero data dir>/key-sync/journal.json`, so
  nothing is lost while Key is closed. On start-up the plugin records items modified since the
  journal was last saved, which covers changes made while it was disabled.
- Key polls the plugin on Zotero's local connector server (`127.0.0.1:23119`, the
  `httpServer.port` pref) every 15 seconds while it runs, when its window gets focus, and backs off
  when Zotero is not running. It asks only for changes since the last sequence number it applied,
  then fetches those items and merges them with the same rules as the one-time import (edits made
  in Key are kept; items deleted in Zotero go to Key's trash; Key's own notes are never deleted).
- Zotero's server only listens on the loopback interface and rejects other Host headers;
  every endpoint but the handshake requires the pairing code.

## Protocol (`/key-sync/…`, protocol 1)

All bodies are JSON. Send `Authorization: Bearer <pairing code>`.

| Endpoint | |
| --- | --- |
| `GET handshake` | `{name, protocol, version, zotero, paired}`; when paired also `epoch`, `seq`, `defaultLibraryID`, `libraries`. Works without the code, so Key can tell "plugin missing" from "not paired". |
| `GET collections?libraryID=` | `{collections: [{key, name, parentKey}]}` |
| `POST items` `{libraryID, scope, offset, limit}` | A page of top-level items in scope (`{type: "all"}`, `{type: "collections", collections: [keys]}`, `{type: "items", items: [keys]}`): `{items, total, next, seq, epoch}` |
| `POST items` `{libraryID, scope, keysOnly: true}` | Only the keys in scope: `{keys, total}`. |
| `POST items` `{libraryID, keys}` | Those items (a child key returns its top-level item); `missing` lists keys that no longer exist. |
| `GET changes?since=&epoch=&libraryID=` | `{epoch, seq, floor, more, resyncRequired, changes: [{seq, kind, op, key, libraryID}]}`. `kind` is `item`, `collection`, `library` (refetch it all) or `ping`; `op` is `upsert` or `delete`. `resyncRequired` when the journal cannot answer (another epoch, dropped entries, or a lost save). |
| `GET versions?libraryID=` | Every top-level item's key, version, modification date and whether it is in the trash, for a full reconcile. |
| `POST ping` | Asks Key to sync at its next check. |

An item record has `key, itemType, dateAdded, dateModified, deleted, fields, creators, tags,
collections, attachments [{key, contentType, linkMode, path, annotations}], notes [{key, title,
html}]`; a standalone note has `note`, a standalone file `attachment`.

`src/key-sync-core.js` (journal and protocol) does not depend on Zotero: Key's mock server
(`apps/key-office/apps/key/scripts/mock-zotero-plugin.cjs`) runs the same file over an in-memory
library, and `node --test integrations/zotero-key-sync/test` covers it.

## Trying it in a throwaway Zotero

Never point a test at your real profile. Start Zotero with a temporary profile and data
directory, and the plugin linked unpacked:

```sh
P=$(mktemp -d)
mkdir -p $P/profile/extensions $P/data
printf %s "$PWD/integrations/zotero-key-sync/src" > "$P/profile/extensions/key-sync@key.dev"
cat > $P/profile/user.js <<EOF
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.zotero.httpServer.port", 23139);
user_pref("extensions.zotero.dataDir", "$P/data");
user_pref("extensions.zotero.useDataDir", true);
EOF
/Applications/Zotero.app/Contents/MacOS/zotero -profile $P/profile -datadir $P/data -no-remote
curl http://127.0.0.1:23139/key-sync/handshake
```
