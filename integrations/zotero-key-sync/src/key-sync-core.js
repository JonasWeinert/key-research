/* Key Sync core: the change journal and the /key-sync HTTP protocol, independent of Zotero.
 *
 * Loaded into Zotero with Services.scriptloader.loadSubScript (it defines the global
 * KeySyncCore) and, unchanged, by Key's mock plugin server and tests through node:vm, so
 * the protocol Key is tested against is the one the plugin speaks.
 */
/* exported KeySyncCore */
var KeySyncCore = (() => {
  const PROTOCOL = 1;
  /** Entries kept before the oldest are dropped; a client behind them resyncs. */
  const JOURNAL_LIMIT = 50000;
  /** Changes returned per request; the client asks again from the last one. */
  const CHANGES_PAGE = 2000;
  const ITEMS_PAGE = 100;
  const ITEMS_PAGE_MAX = 500;

  const randomId = (bytes = 16) => {
    const a = new Uint8Array(bytes);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  /**
   * A durable, compacting change journal. Each change gets the next sequence number; only
   * the latest change of each object is kept (a client asking "since N" needs to know which
   * objects changed, not how often). `floor` is the newest sequence number dropped to stay
   * under the limit: a client that last saw less than it must resync.
   */
  class Journal {
    constructor(state = {}, options = {}) {
      this.limit = options.limit || JOURNAL_LIMIT;
      this.now = options.now || (() => Date.now());
      this.epoch = typeof state.epoch === "string" && state.epoch ? state.epoch : randomId(8);
      this.seq = Number.isSafeInteger(state.seq) ? state.seq : 0;
      this.floor = Number.isSafeInteger(state.floor) ? state.floor : 0;
      this.savedAt = Number.isFinite(state.savedAt) ? state.savedAt : 0;
      this.lastClientAt = Number.isFinite(state.lastClientAt) ? state.lastClientAt : 0;
      this.entries = new Map();
      for (const e of Array.isArray(state.entries) ? state.entries.slice().sort((a, b) => a.seq - b.seq) : []) {
        if (e && Number.isSafeInteger(e.seq) && e.kind && e.key !== undefined) this.entries.set(Journal.id(e), e);
      }
      this.dirty = false;
    }

    static id(e) {
      return `${e.kind}:${e.libraryID ?? ""}:${e.key}`;
    }

    /** Records a change. `op` is "upsert" or "delete"; kind "item", "collection",
     *  "library" (refetch everything in it) or "ping" (sync now, nothing changed). */
    record(kind, op, libraryID, key) {
      if (kind !== "ping" && (key === undefined || key === null || key === "")) return null;
      const entry = { seq: ++this.seq, kind, op, libraryID: libraryID ?? null, key: key ?? "", at: this.now() };
      const id = Journal.id(entry);
      this.entries.delete(id);
      this.entries.set(id, entry);
      while (this.entries.size > this.limit) {
        const [oldest, dropped] = this.entries.entries().next().value;
        this.entries.delete(oldest);
        this.floor = Math.max(this.floor, dropped.seq);
      }
      this.dirty = true;
      return entry;
    }

    /** Changes after `since` for one library (pings for all), oldest first. */
    since(since, libraryID, epoch) {
      const from = Number(since);
      const valid = Number.isSafeInteger(from) && from >= 0;
      // A client from another journal, ahead of this one (a save was lost) or behind what
      // was dropped cannot be brought up to date from it.
      const resyncRequired = !valid || (epoch !== undefined && epoch !== null && epoch !== "" && epoch !== this.epoch) || from > this.seq || from < this.floor;
      const changes = [];
      let more = false;
      if (!resyncRequired) {
        for (const e of this.entries.values()) {
          if (e.seq <= from) continue;
          if (e.kind !== "ping" && libraryID !== undefined && libraryID !== null && e.libraryID !== libraryID) continue;
          if (changes.length >= CHANGES_PAGE) {
            more = true;
            break;
          }
          changes.push(e);
        }
      }
      const seq = more ? changes[changes.length - 1].seq : this.seq;
      return { epoch: this.epoch, seq, floor: this.floor, resyncRequired, more, changes };
    }

    toJSON() {
      return {
        protocol: PROTOCOL,
        epoch: this.epoch,
        seq: this.seq,
        floor: this.floor,
        savedAt: this.now(),
        lastClientAt: this.lastClientAt,
        entries: [...this.entries.values()],
      };
    }
  }

  const json = (status, body) => [status, "application/json", JSON.stringify(body)];
  const header = (headers, name) => {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name) ?? undefined;
    const wanted = name.toLowerCase();
    for (const k of Object.keys(headers)) if (k.toLowerCase() === wanted) return headers[k];
    return undefined;
  };
  const param = (searchParams, name) => {
    if (!searchParams) return undefined;
    if (typeof searchParams.get === "function") return searchParams.get(name) ?? undefined;
    return searchParams[name];
  };
  /** Same length and characters, compared without stopping early. */
  const sameSecret = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };
  const normalizeScope = (scope) => {
    const list = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === "string" && k) : []);
    if (!scope || typeof scope !== "object") return { type: "all" };
    if (scope.type === "collections") return { type: "collections", collections: list(scope.collections) };
    if (scope.type === "items") return { type: "items", items: list(scope.items) };
    if (scope.type === "mixed") return { type: "mixed", collections: list(scope.collections), items: list(scope.items) };
    return { type: "all" };
  };

  /**
   * The /key-sync endpoints over a library adapter:
   *   libraries() → [{libraryID, name, type, editable}]
   *   defaultLibraryID() → number
   *   collections(libraryID) → [{key, name, parentKey, deleted}]
   *   scopeKeys(libraryID, scope) → top-level item keys, in a stable order
   *   records(libraryID, keys) → {records, missing}; child keys resolve to their top-level item
   *   versions(libraryID) → [{key, version, dateModified, deleted}] for top-level items
   */
  function createAPI({ journal, adapter, token, version, zoteroVersion, onChange }) {
    const libraryOf = (value) => {
      const n = Number(value);
      return Number.isSafeInteger(n) && n > 0 ? n : adapter.defaultLibraryID();
    };
    const routes = {
      async handshake(req, authorized) {
        const base = { name: "key-sync", protocol: PROTOCOL, version, zotero: zoteroVersion(), paired: authorized };
        if (!authorized) return json(200, base);
        return json(200, {
          ...base,
          epoch: journal.epoch,
          seq: journal.seq,
          defaultLibraryID: adapter.defaultLibraryID(),
          libraries: await adapter.libraries(),
        });
      },
      async collections(req) {
        const libraryID = libraryOf(param(req.searchParams, "libraryID"));
        return json(200, { libraryID, collections: await adapter.collections(libraryID) });
      },
      async changes(req) {
        const libraryID = libraryOf(param(req.searchParams, "libraryID"));
        journal.lastClientAt = Date.now();
        return json(200, { libraryID, ...journal.since(param(req.searchParams, "since") ?? 0, libraryID, param(req.searchParams, "epoch")) });
      },
      async versions(req) {
        const libraryID = libraryOf(param(req.searchParams, "libraryID"));
        return json(200, { libraryID, items: await adapter.versions(libraryID) });
      },
      async items(req) {
        const body = req.data && typeof req.data === "object" ? req.data : {};
        const libraryID = libraryOf(body.libraryID ?? param(req.searchParams, "libraryID"));
        // Before reading, so a change made while a page is read is in the next delta.
        const seq = journal.seq;
        if (Array.isArray(body.keys)) {
          const keys = body.keys.filter((k) => typeof k === "string" && k).slice(0, ITEMS_PAGE_MAX);
          const { records, missing } = await adapter.records(libraryID, keys);
          return json(200, { libraryID, seq, epoch: journal.epoch, items: records, missing, total: records.length, next: null });
        }
        const scope = normalizeScope(body.scope);
        const all = await adapter.scopeKeys(libraryID, scope);
        // Only which items are in scope, for a reconcile.
        if (body.keysOnly) return json(200, { libraryID, seq, epoch: journal.epoch, keys: all, total: all.length });
        const offset = Math.max(0, Number(body.offset) || 0);
        const limit = Math.min(ITEMS_PAGE_MAX, Math.max(1, Number(body.limit) || ITEMS_PAGE));
        const page = all.slice(offset, offset + limit);
        const { records, missing } = await adapter.records(libraryID, page);
        const next = offset + limit < all.length ? offset + limit : null;
        return json(200, { libraryID, seq, epoch: journal.epoch, items: records, missing, total: all.length, next });
      },
      async ping() {
        journal.record("ping", "upsert", null, "");
        onChange && onChange();
        return json(200, { seq: journal.seq });
      },
    };
    const methods = { handshake: ["GET"], collections: ["GET"], changes: ["GET"], versions: ["GET"], items: ["POST"], ping: ["POST"] };

    return {
      routes: Object.keys(routes),
      /** Answers one request: {method, pathname, searchParams, headers, data} → [status, type, body]. */
      async handle(req) {
        const name = String(req.pathname || "").replace(/^\/key-sync\/?/, "").replace(/\/$/, "");
        const route = routes[name];
        if (!route) return json(404, { error: "not-found" });
        if (!methods[name].includes(String(req.method || "GET").toUpperCase())) return json(405, { error: "method-not-allowed" });
        const auth = header(req.headers, "authorization") || "";
        const given = auth.replace(/^Bearer\s+/i, "").trim();
        const authorized = sameSecret(given, token());
        if (name !== "handshake" && !authorized) return json(401, { error: "unauthorized" });
        try {
          return await route(req, authorized);
        } catch (e) {
          return json(500, { error: String((e && e.message) || e) });
        }
      },
    };
  }

  /** Maps Zotero's annotation type names onto the numbers its database uses. */
  const ANNOTATION_TYPES = { highlight: 1, note: 2, image: 3, ink: 4, underline: 5, text: 6 };

  return { PROTOCOL, Journal, createAPI, normalizeScope, randomId, ANNOTATION_TYPES, CHANGES_PAGE };
})();
if (typeof module !== "undefined") module.exports = KeySyncCore;
