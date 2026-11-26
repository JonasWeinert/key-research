// A stand-in for Zotero with the Key Sync plugin: Zotero's local server answering
// /key-sync/… with the plugin's own protocol code (integrations/zotero-key-sync/src/
// key-sync-core.js) over an in-memory library. Used by smoke-zotero-sync.cjs; runs alone too:
//   node scripts/mock-zotero-plugin.cjs [port]   (prints the port and pairing code)
const http = require("node:http");
const path = require("node:path");
const { Journal, createAPI } = require(path.resolve(__dirname, "../../../../../integrations/zotero-key-sync/src/key-sync-core.js"));

const stampOf = (n) => `2026-01-01 00:00:${String(n % 60).padStart(2, "0")}#${n}`;

/** Starts the mock. `library` holds {collections: [{key, name, parentKey}], items: [record]}. */
async function startMockZotero({ port = 0, token = "a".repeat(48), library = { collections: [], items: [] } } = {}) {
  const journal = new Journal({});
  const collections = new Map(library.collections.map((c) => [c.key, { ...c }]));
  const items = new Map();
  let edits = 0;
  // "ok", "missing" (Zotero without the plugin: 404 for /key-sync/…).
  let mode = "ok";
  const children = (record) => [
    ...(record.attachments ?? []).flatMap((a) => [a.key, ...(a.annotations ?? []).map((n) => n.key)]),
    ...(record.notes ?? []).map((n) => n.key),
  ];
  const topOf = (key) => (items.has(key) ? key : [...items.values()].find((r) => children(r).includes(key))?.key);
  const put = (record, quiet = false) => {
    const full = { libraryID: 1, deleted: false, fields: {}, creators: [], tags: [], collections: [], attachments: [], notes: [], dateAdded: "2026-01-01 00:00:00", ...record };
    full.stamp = stampOf(++edits);
    items.set(full.key, full);
    if (!quiet) journal.record("item", "upsert", 1, full.key);
    return full;
  };
  for (const record of library.items) put(record, true);

  const adapter = {
    libraries: async () => [{ libraryID: 1, name: "My Library", type: "user", editable: true }],
    defaultLibraryID: () => 1,
    collections: async () => [...collections.values()].map((c) => ({ key: c.key, name: c.name, parentKey: c.parentKey ?? null, deleted: false })),
    scopeKeys: async (_, scope) => {
      const live = [...items.values()].filter((r) => !r.deleted);
      if (scope.type === "all") return live.map((r) => r.key);
      const wanted = new Set(scope.collections ?? []);
      const keys = new Set(scope.items ?? []);
      return live.filter((r) => keys.has(r.key) || r.collections.some((c) => wanted.has(c))).map((r) => r.key);
    },
    records: async (_, keys) => {
      const found = new Map();
      const missing = [];
      for (const key of keys) {
        const top = topOf(key);
        if (top) found.set(top, items.get(top));
        else missing.push(key);
      }
      return { records: [...found.values()], missing };
    },
    versions: async () => [...items.values()].map((r) => ({ key: r.key, stamp: r.stamp, deleted: !!r.deleted })),
  };
  const api = createAPI({ journal, adapter, token: () => token, version: "1.0.0", zoteroVersion: () => "9.0.6 (mock)" });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const url = new URL(req.url, "http://127.0.0.1");
      // Zotero's own checks: loopback Host only.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return res.writeHead(400).end("Invalid Host header");
      if (url.pathname === "/connector/ping") return res.writeHead(200, { "content-type": "text/html" }).end("Zotero is running");
      if (!url.pathname.startsWith("/key-sync/") || mode === "missing") return res.writeHead(404, { "content-type": "text/plain" }).end("No endpoint found");
      let data;
      try {
        data = body ? JSON.parse(body) : undefined;
      } catch {
        return res.writeHead(400).end("Invalid JSON");
      }
      const [status, type, text] = await api.handle({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, headers: req.headers, data });
      res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) }).end(text);
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    token,
    journal,
    setMode: (next) => (mode = next),
    put: (record) => put(record),
    edit: (key, change) => {
      const record = structuredClone(items.get(key));
      change(record);
      return put(record);
    },
    erase: (key) => {
      items.delete(key);
      journal.record("item", "delete", 1, key);
    },
    collection: (c) => {
      collections.set(c.key, c);
      journal.record("collection", "upsert", 1, c.key);
    },
    item: (key) => items.get(key),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { startMockZotero };

if (require.main === module) {
  startMockZotero({ port: Number(process.argv[2]) || 0 }).then((mock) => console.log(`Mock Zotero with Key Sync on 127.0.0.1:${mock.port}, pairing code ${mock.token}`));
}
