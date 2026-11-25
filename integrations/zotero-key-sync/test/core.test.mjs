// node --test integrations/zotero-key-sync/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Journal, createAPI } = require("../src/key-sync-core.js");

test("journal keeps the latest change per object, in order", () => {
  const j = new Journal({}, { now: () => 1 });
  j.record("item", "upsert", 1, "A");
  j.record("item", "upsert", 1, "B");
  j.record("item", "delete", 1, "A");
  const all = j.since(0, 1);
  assert.equal(all.resyncRequired, false);
  assert.deepEqual(all.changes.map((c) => [c.seq, c.key, c.op]), [[2, "B", "upsert"], [3, "A", "delete"]]);
  assert.deepEqual(j.since(2, 1).changes.map((c) => c.key), ["A"]);
  assert.equal(j.since(3, 1).changes.length, 0);
  // Other libraries are filtered; pings reach every client.
  j.record("item", "upsert", 2, "G");
  j.record("ping", "upsert", null, "");
  assert.deepEqual(j.since(3, 1).changes.map((c) => c.kind), ["ping"]);
});

test("journal survives a save and asks for a resync when it cannot answer", () => {
  const j = new Journal({}, { limit: 3 });
  for (const key of ["A", "B", "C", "D", "E"]) j.record("item", "upsert", 1, key);
  assert.equal(j.floor, 2);
  assert.equal(j.since(1, 1).resyncRequired, true);
  assert.equal(j.since(2, 1).resyncRequired, false);
  const restored = new Journal(JSON.parse(JSON.stringify(j)));
  assert.equal(restored.seq, 5);
  assert.equal(restored.epoch, j.epoch);
  assert.deepEqual(restored.since(2, 1).changes.map((c) => c.key), ["C", "D", "E"]);
  // Ahead of the journal (a lost save) or from another journal: start over.
  assert.equal(restored.since(9, 1).resyncRequired, true);
  assert.equal(restored.since(4, 1, "other").resyncRequired, true);
  assert.equal(restored.since(4, 1, j.epoch).resyncRequired, false);
});

test("changes come in pages", () => {
  const j = new Journal({});
  for (let i = 0; i < 2500; i++) j.record("item", "upsert", 1, `K${i}`);
  const first = j.since(0, 1);
  assert.equal(first.more, true);
  assert.equal(first.changes.length, 2000);
  assert.equal(first.seq, 2000);
  const second = j.since(first.seq, 1);
  assert.equal(second.more, false);
  assert.equal(second.changes.length, 500);
  assert.equal(second.seq, 2500);
});

test("the API checks the pairing code and pages items by scope", async () => {
  const journal = new Journal({});
  const records = { A: { key: "A" }, B: { key: "B" }, C: { key: "C" } };
  const api = createAPI({
    journal,
    token: () => "secret-token",
    version: "1.0.0",
    zoteroVersion: () => "7.0.11",
    adapter: {
      libraries: async () => [{ libraryID: 1, name: "My Library", type: "user", editable: true }],
      defaultLibraryID: () => 1,
      collections: async () => [{ key: "COL", name: "Thesis", parentKey: null }],
      scopeKeys: async (_, scope) => (scope.type === "items" ? scope.items : ["A", "B", "C"]),
      records: async (_, keys) => ({ records: keys.filter((k) => records[k]).map((k) => records[k]), missing: keys.filter((k) => !records[k]) }),
      versions: async () => [],
    },
  });
  const call = (method, pathname, { token, search = {}, data } = {}) =>
    api.handle({ method, pathname, searchParams: new URLSearchParams(search), headers: token ? { Authorization: `Bearer ${token}` } : {}, data });
  const open = await call("GET", "/key-sync/handshake");
  assert.equal(open[0], 200);
  assert.deepEqual(JSON.parse(open[2]).paired, false);
  assert.equal((await call("GET", "/key-sync/changes"))[0], 401);
  assert.equal((await call("GET", "/key-sync/changes", { token: "wrong-token!" }))[0], 401);
  const hello = JSON.parse((await call("GET", "/key-sync/handshake", { token: "secret-token" }))[2]);
  assert.equal(hello.paired, true);
  assert.equal(hello.libraries[0].name, "My Library");
  const page = JSON.parse((await call("POST", "/key-sync/items", { token: "secret-token", data: { scope: { type: "all" }, limit: 2 } }))[2]);
  assert.deepEqual([page.items.map((i) => i.key), page.total, page.next], [["A", "B"], 3, 2]);
  const rest = JSON.parse((await call("POST", "/key-sync/items", { token: "secret-token", data: { scope: { type: "all" }, offset: 2, limit: 2 } }))[2]);
  assert.deepEqual([rest.items.map((i) => i.key), rest.next], [["C"], null]);
  const byKey = JSON.parse((await call("POST", "/key-sync/items", { token: "secret-token", data: { keys: ["B", "GONE"] } }))[2]);
  assert.deepEqual([byKey.items.map((i) => i.key), byKey.missing], [["B"], ["GONE"]]);
  assert.equal((await call("GET", "/key-sync/items", { token: "secret-token" }))[0], 405);
  assert.equal((await call("GET", "/key-sync/nothing", { token: "secret-token" }))[0], 404);
  await call("POST", "/key-sync/ping", { token: "secret-token" });
  const changes = JSON.parse((await call("GET", "/key-sync/changes", { token: "secret-token", search: { since: "0" } }))[2]);
  assert.deepEqual(changes.changes.map((c) => c.kind), ["ping"]);
});
