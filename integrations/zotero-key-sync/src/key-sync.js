/* Key Sync inside Zotero: records every change to items, collections, tags, notes,
 * attachments and annotations in a durable journal, and answers Key on Zotero's local
 * connector server (127.0.0.1:23119) under /key-sync/. Read-only towards the library.
 */
/* global Zotero, Services, IOUtils, PathUtils, KeySyncCore */
/* exported KeySync */
var KeySync = {
  id: null,
  version: null,
  rootURI: null,
  journal: null,
  api: null,
  observerID: null,
  saveTimer: null,
  saving: null,
  started: false,

  TOKEN_PREF: "extensions.key-sync.token",

  log(message) {
    Zotero.debug("Key Sync: " + message);
  },

  get journalPath() {
    return PathUtils.join(Zotero.DataDirectory.dir, "key-sync", "journal.json");
  },

  /** The pairing token, created on first use and saved to prefs.js at once so Key can
   *  find it there. */
  token() {
    let token = Zotero.Prefs.get(this.TOKEN_PREF, true);
    if (typeof token !== "string" || token.length < 32) {
      token = KeySyncCore.randomId(24);
      Zotero.Prefs.set(this.TOKEN_PREF, token, true);
      try {
        Services.prefs.savePrefFile(null);
      } catch (e) {
        this.log("Could not save prefs: " + e);
      }
    }
    return token;
  },

  /** Key's installer lets Zotero enable this plugin when it finds it in the profile by
   *  relaxing extensions.autoDisableScopes once; put back what was there before. */
  restoreInstallPrefs() {
    const MARK = "extensions.key-sync.restoreAutoDisableScopes";
    try {
      if (!Services.prefs.prefHasUserValue(MARK)) return;
      const previous = Services.prefs.getIntPref(MARK, -1);
      if (previous < 0) Services.prefs.clearUserPref("extensions.autoDisableScopes");
      else Services.prefs.setIntPref("extensions.autoDisableScopes", previous);
      Services.prefs.clearUserPref(MARK);
      Services.prefs.savePrefFile(null);
      this.log("Restored extensions.autoDisableScopes after Key's install");
    } catch (e) {
      this.log("Could not restore install prefs: " + e);
    }
  },

  regenerateToken() {
    Zotero.Prefs.clear(this.TOKEN_PREF, true);
    return this.token();
  },

  async startup({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.restoreInstallPrefs();
    this.token();
    await this.loadJournal();
    this.api = KeySyncCore.createAPI({
      journal: this.journal,
      adapter: this.adapter,
      token: () => this.token(),
      version,
      zoteroVersion: () => Zotero.version,
      onChange: () => this.scheduleSave(),
    });
    this.registerEndpoints();
    this.observerID = Zotero.Notifier.registerObserver(this, ["item", "collection", "collection-item", "item-tag", "tag"], "keySync");
    this.started = true;
    // Changes made while the plugin was off (or not yet saved before a crash).
    this.catchUp().catch((e) => this.log("Catch-up failed: " + e));
  },

  shutdown() {
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = null;
    for (const route of this.api ? this.api.routes : []) delete Zotero.Server.Endpoints["/key-sync/" + route];
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.journal && this.journal.dirty) this.save();
    this.started = false;
  },

  async loadJournal() {
    let state = {};
    try {
      if (await IOUtils.exists(this.journalPath)) state = await IOUtils.readJSON(this.journalPath);
    } catch (e) {
      // A damaged journal starts over under a new epoch: Key resyncs once.
      this.log("Journal unreadable, starting a new one: " + e);
      state = {};
    }
    this.journal = new KeySyncCore.Journal(state);
    if (!state.epoch) this.scheduleSave();
  },

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  },

  save() {
    if (!this.journal) return null;
    const data = this.journal.toJSON();
    this.journal.dirty = false;
    const write = async () => {
      await IOUtils.makeDirectory(PathUtils.parent(this.journalPath), { ignoreExisting: true });
      await IOUtils.writeJSON(this.journalPath, data, { tmpPath: this.journalPath + ".tmp" });
    };
    this.saving = (this.saving || Promise.resolve()).then(write).catch((e) => this.log("Could not save the journal: " + e));
    return this.saving;
  },

  registerEndpoints() {
    const plugin = this;
    for (const route of this.api.routes) {
      const Endpoint = function () {};
      Endpoint.prototype = {
        supportedMethods: ["GET", "POST"],
        supportedDataTypes: ["application/json"],
        permitBookmarklet: false,
        // One parameter: Zotero passes {method, pathname, searchParams, headers, data}.
        init: async function (requestData) {
          return plugin.api.handle({ ...requestData, pathname: "/key-sync/" + route });
        },
      };
      Zotero.Server.Endpoints["/key-sync/" + route] = Endpoint;
    }
  },

  // ── Change journal ───────────────────────────────────

  /** Zotero.Notifier observer. Records the top-level item of anything that changed. */
  async notify(event, type, ids, extraData) {
    try {
      const journal = this.journal;
      if (!journal) return;
      if (type === "item") {
        for (const id of ids) {
          if (event === "delete") {
            const data = (extraData && extraData[id]) || {};
            if (data.key) journal.record("item", "delete", data.libraryID ?? null, data.key);
            continue;
          }
          const item = Zotero.Items.get(id);
          if (!item) continue;
          journal.record("item", "upsert", item.libraryID, this.topLevel(item).key);
        }
      } else if (type === "collection") {
        for (const id of ids) {
          if (event === "delete") {
            const data = (extraData && extraData[id]) || {};
            if (data.key) journal.record("collection", "delete", data.libraryID ?? null, data.key);
            continue;
          }
          const collection = Zotero.Collections.get(id);
          if (collection) journal.record("collection", "upsert", collection.libraryID, collection.key);
        }
      } else if (type === "collection-item" || type === "item-tag") {
        // ids are "collectionID-itemID" and "itemID-tagID".
        for (const pair of ids) {
          const [a, b] = String(pair).split("-").map(Number);
          const item = Zotero.Items.get(type === "collection-item" ? b : a);
          if (item) journal.record("item", "upsert", item.libraryID, this.topLevel(item).key);
          if (type === "collection-item") {
            const collection = Zotero.Collections.get(a);
            if (collection) journal.record("collection", "upsert", collection.libraryID, collection.key);
          }
        }
      } else if (type === "tag" && (event === "modify" || event === "delete")) {
        // A tag renamed or deleted everywhere touches items that are not notified one by one.
        const libraries = new Set();
        for (const id of ids) {
          const data = (extraData && extraData[id]) || {};
          libraries.add(data.libraryID ?? Zotero.Libraries.userLibraryID);
        }
        for (const libraryID of libraries) journal.record("library", "upsert", libraryID, String(libraryID));
      }
      if (journal.dirty) this.scheduleSave();
    } catch (e) {
      this.log("Notifier failed: " + e);
    }
  },

  /** Items changed since the journal was last saved, recorded again. */
  async catchUp() {
    const since = this.journal.savedAt;
    if (!since) return;
    // Zotero keeps clientDateModified as "YYYY-MM-DD HH:MM:SS" in UTC. A minute of slack.
    const iso = new Date(since - 60000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const rows = await Zotero.DB.queryAsync("SELECT itemID FROM items WHERE clientDateModified >= ?", [iso]);
    for (const row of rows || []) {
      const item = await Zotero.Items.getAsync(row.itemID);
      if (item) this.journal.record("item", "upsert", item.libraryID, this.topLevel(item).key);
    }
    if (this.journal.dirty) this.scheduleSave();
  },

  topLevel(item) {
    let top = item;
    for (let i = 0; i < 4 && top.parentItem; i++) top = top.parentItem;
    return top;
  },

  // ── Library adapter (read-only) ──────────────────────

  adapter: {
    async libraries() {
      return Zotero.Libraries.getAll()
        .filter((l) => l.libraryType === "user" || l.libraryType === "group")
        .map((l) => ({ libraryID: l.libraryID, name: l.name, type: l.libraryType, editable: !!l.editable }));
    },

    defaultLibraryID() {
      return Zotero.Libraries.userLibraryID;
    },

    async collections(libraryID) {
      return Zotero.Collections.getByLibrary(libraryID, true)
        .filter((c) => !c.deleted)
        .map((c) => ({ key: c.key, name: c.name, parentKey: c.parentKey || null, version: c.version, deleted: false }));
    },

    async scopeKeys(libraryID, scope) {
      let ids = [];
      const wanted = new Set();
      if (scope.type === "all") {
        ids = (await KeySync.topLevelRows(libraryID)).filter((r) => !r.deleted).map((r) => r.itemID);
      }
      if (scope.type === "collections" || scope.type === "mixed") {
        for (const key of scope.collections) {
          const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
          if (!collection || collection.deleted) continue;
          for (const id of collection.getChildItems(true, false)) wanted.add(id);
        }
      }
      if (scope.type === "items" || scope.type === "mixed") {
        for (const key of scope.items) {
          const id = Zotero.Items.getIDFromLibraryAndKey(libraryID, key);
          if (id) wanted.add(id);
        }
      }
      ids = ids.concat([...wanted]);
      const keys = [];
      for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
        const lk = Zotero.Items.getLibraryAndKeyFromID(id);
        if (lk) keys.push(lk.key);
      }
      return keys;
    },

    async records(libraryID, keys) {
      const missing = [];
      const tops = new Map();
      for (const key of keys) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
        if (!item) {
          missing.push(key);
          continue;
        }
        const top = KeySync.topLevel(item);
        tops.set(top.id, top);
      }
      const items = [...tops.values()];
      await KeySync.load(items);
      // Read before the items, so a change made meanwhile makes the stamp look stale.
      const stamps = await KeySync.stamps(libraryID, items.map((i) => i.id));
      const records = [];
      for (const item of items) records.push({ ...(await KeySync.serialize(item)), stamp: stamps.get(item.id) || "" });
      return { records, missing };
    },

    async versions(libraryID) {
      return (await KeySync.topLevelRows(libraryID)).map((r) => ({ key: r.key, version: r.version, stamp: r.stamp, deleted: !!r.deleted }));
    },
  },

  /** Top-level items of a library (not notes, files or annotations inside an item), each
   *  with a stamp that changes when it or anything inside it changes: the latest
   *  modification time and the number of parts. */
  async topLevelRows(libraryID) {
    // Zotero.DB returns rows only for statements that start with SELECT: no WITH.
    const rows = await Zotero.DB.queryAsync(
      `SELECT I.itemID, I.key, I.version, S.stamp, (D.itemID IS NOT NULL) AS deleted
       FROM items I LEFT JOIN deletedItems D USING (itemID)
       LEFT JOIN (
         SELECT F.top AS top, MAX(X.clientDateModified) || '#' || COUNT(*) AS stamp
         FROM (
           SELECT itemID AS top, itemID AS id FROM items WHERE libraryID = ?1
           UNION ALL SELECT parentItemID, itemID FROM itemNotes WHERE parentItemID IS NOT NULL
           UNION ALL SELECT parentItemID, itemID FROM itemAttachments WHERE parentItemID IS NOT NULL
           UNION ALL SELECT A.parentItemID, N.itemID FROM itemAnnotations N JOIN itemAttachments A ON A.itemID = N.parentItemID WHERE A.parentItemID IS NOT NULL
           UNION ALL SELECT N.parentItemID, N.itemID FROM itemAnnotations N
         ) F JOIN items X ON X.itemID = F.id
         WHERE F.id = F.top OR F.id NOT IN (SELECT itemID FROM deletedItems)
         GROUP BY F.top
       ) S ON S.top = I.itemID
       WHERE I.libraryID = ?1
         AND I.itemID NOT IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NOT NULL)
         AND I.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL)
         AND I.itemID NOT IN (SELECT itemID FROM itemAnnotations)
       ORDER BY I.itemID`,
      [libraryID],
    );
    return (rows || []).map((r) => ({ itemID: r.itemID, key: r.key, version: r.version, stamp: r.stamp || "", deleted: r.deleted }));
  },

  /** Stamps (see topLevelRows) of some top-level items, by item ID. */
  async stamps(libraryID, itemIDs) {
    const wanted = new Set(itemIDs);
    const stamps = new Map();
    if (!wanted.size) return stamps;
    for (const row of await this.topLevelRows(libraryID)) if (wanted.has(row.itemID)) stamps.set(row.itemID, row.stamp);
    return stamps;
  },

  async load(items) {
    if (!items.length) return;
    try {
      await Zotero.Items.loadDataTypes(items);
    } catch (e) {
      this.log("Could not load item data: " + e);
    }
  },

  async serialize(item) {
    const record = {
      key: item.key,
      libraryID: item.libraryID,
      version: item.version,
      itemType: item.itemType,
      dateAdded: item.dateAdded,
      dateModified: item.dateModified,
      deleted: !!item.deleted,
      fields: {},
      creators: [],
      tags: item.getTags().map((t) => t.tag),
      collections: item
        .getCollections()
        .map((id) => Zotero.Collections.get(id))
        .filter((c) => c && !c.deleted)
        .map((c) => c.key),
      attachments: [],
      notes: [],
    };
    if (item.isNote()) {
      record.note = { key: item.key, title: item.getNoteTitle(), html: item.getNote() };
      return record;
    }
    if (item.isAttachment()) {
      record.fields.title = item.getField("title");
      record.attachment = await this.attachment(item);
      return record;
    }
    for (const name of item.getUsedFields(true)) {
      const value = item.getField(name);
      if (value !== "" && value !== undefined && value !== null) record.fields[name] = String(value);
    }
    record.creators = item.getCreatorsJSON();
    const attachments = item.getAttachments(false).map((id) => Zotero.Items.get(id)).filter((a) => a && !a.deleted);
    const notes = item.getNotes(false).map((id) => Zotero.Items.get(id)).filter((n) => n && !n.deleted);
    await this.load([...attachments, ...notes]);
    for (const attachment of attachments) record.attachments.push(await this.attachment(attachment));
    record.notes = notes.map((n) => ({ key: n.key, title: n.getNoteTitle(), html: n.getNote() }));
    return record;
  },

  async attachment(item) {
    const file = item.isFileAttachment();
    let path = null;
    if (file) {
      try {
        path = item.getFilePath() || null;
      } catch (e) {
        path = null;
      }
    }
    let annotations = [];
    if (file && typeof item.getAnnotations === "function") {
      const list = item.getAnnotations(false).filter((a) => !a.deleted);
      await this.load(list);
      annotations = list.map((a) => {
        let pageIndex = null;
        try {
          pageIndex = JSON.parse(a.annotationPosition || "{}").pageIndex ?? null;
        } catch (e) {
          pageIndex = null;
        }
        return {
          key: a.key,
          type: KeySyncCore.ANNOTATION_TYPES[a.annotationType] || 0,
          text: a.annotationText || "",
          comment: a.annotationComment || "",
          color: a.annotationColor || "",
          pageIndex,
          sortIndex: a.annotationSortIndex || "",
        };
      });
    }
    return {
      key: item.key,
      title: item.getField("title"),
      contentType: item.attachmentContentType || "",
      linkMode: item.attachmentLinkMode,
      path,
      annotations,
    };
  },

  /** What the preferences pane shows. */
  status() {
    const j = this.journal;
    return {
      running: this.started,
      port: Zotero.Prefs.get("httpServer.port"),
      seq: j ? j.seq : 0,
      size: j ? j.entries.size : 0,
      lastClientAt: j ? j.lastClientAt : 0,
    };
  },

  /** Asks Key to sync at its next check, without any change in Zotero. */
  ping() {
    if (!this.journal) return;
    this.journal.record("ping", "upsert", null, "");
    this.scheduleSave();
  },
};
