// How quickly the Rust host answers what the user does while it is busy with background work.
// Seeds a library, then saturates the host (indexing 40 PDFs with layout analysis, a metadata
// lookup queue, duplicate recounts, a bulk import of references) and meanwhile times the
// interactive commands behind clicks and keystrokes. No Electron.
//
//   node scripts/bench-priority.cjs <host binary> [<another host binary> …] [--sources N] [--seconds S] [--json FILE]
//
// Each binary runs on its own temp library with OpenAlex in offline fixture mode.
const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SOURCES = Number(option("--sources", 3000));
const SECONDS = Number(option("--seconds", 40));
const JSON_OUT = option("--json", null);
// Busy loops at normal priority on this many cores: a machine with no spare CPU (low-end).
const HOG = Number(option("--hog", 0));
const valued = new Set(["--sources", "--seconds", "--json", "--hog"]);
const hosts = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
const repo = path.resolve(__dirname, "../../../../..");
const pdfium = path.join(repo, "vendor/pdfium/lib/libpdfium.dylib");

function host(executable) {
  const library = mkdtempSync(path.join(tmpdir(), "key-prio-bench-"));
  const child = spawn(executable, ["--library", library], {
    // KEY_BENCH_STDERR=file keeps the host's log (with KEY_LOCK_TRACE_MS: long lock holds).
    stdio: ["pipe", "pipe", process.env.KEY_BENCH_STDERR ? openSync(process.env.KEY_BENCH_STDERR, "a") : "ignore"],
    env: { ...process.env, PDFIUM_DYNAMIC_LIB_PATH: pdfium, PDFIUM_LIB_PATH: pdfium, KEY_OPENALEX_FIXTURES: mkdtempSync(path.join(tmpdir(), "key-prio-bench-fx-")) },
  });
  let buffer = Buffer.alloc(0);
  let next = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const n = buffer.readUInt32LE(0);
      if (buffer.length < 4 + n) return;
      const header = JSON.parse(buffer.subarray(4, 4 + n));
      const total = 4 + n + (header.binaryLength ?? 0);
      if (buffer.length < total) return;
      const body = buffer.subarray(4 + n, total);
      buffer = buffer.subarray(total);
      const p = pending.get(header.id);
      if (!p) continue;
      pending.delete(header.id);
      if (!header.ok) p.reject(new Error(String(header.error)));
      else p.resolve(header.json ? JSON.parse(body) : header.binaryLength ? body : header.result);
    }
  });
  const send = (command, args, headers) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      const header = Buffer.from(JSON.stringify({ id, command, args, headers, binaryLength: 0 }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(header.length);
      child.stdin.write(Buffer.concat([prefix, header]));
    });
  // `class` is the priority hint the Electron bridge sends (older hosts ignore it).
  const invoke = async (command, args = {}, klass) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(command, args, klass ? { "x-key-class": klass } : {});
      } catch (e) {
        if (!/busy/i.test(String(e)) || attempt > 2000) throw e;
        await new Promise((r) => setTimeout(r, 2));
      }
    }
  };
  return { child, invoke, library };
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
const stats = (times) => {
  const s = [...times].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  const r = (x) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1) ?? NaN) };
};

/** Copies of the fixture PDFs, each made unique (bytes after %%EOF) so none is a duplicate. */
function pdfCopies(count) {
  const dir = path.join(repo, "tests/fixtures");
  const names = readdirSync(dir).filter((n) => /^PUBMED_.*\.pdf$/.test(n));
  const out = mkdtempSync(path.join(tmpdir(), "key-prio-pdfs-"));
  const files = [];
  for (let i = 0; i < count; i++) {
    const bytes = readFileSync(path.join(dir, names[i % names.length]));
    const file = path.join(out, `paper-${i}.pdf`);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from(`\n%key-bench ${i} ${Math.random()}\n`)]));
    files.push(file);
  }
  return files;
}

async function run(executable) {
  const h = host(executable);
  const words = ["learning", "health", "policy", "networks", "economics", "survey", "trial", "cohort", "review", "model"];
  await h.invoke("store_status");
  const created = [];
  for (let i = 0; i < SOURCES; i += 16)
    created.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(16, SOURCES - i) }, (_, k) => {
          const j = i + k;
          return h.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `A ${words[j % 10]} study of ${words[(j * 3) % 10]} (${j})`, doi: `10.5555/bench.${j}`, creators: [{ family: `Author${j % 977}`, given: "A." }], year: 1980 + (j % 45), tags: [`topic ${j % 300}`, `field ${words[(j * 7) % 10]}`], indexStatus: "skipped" } });
        }),
      )),
    );
  const ids = created.map((s) => s.id);
  // One PDF the "user" works in (imported and indexed before the load starts).
  const [opened] = await h.invoke("store_import_files", { paths: pdfCopies(1) });
  for (let i = 0; i < 600; i++) {
    const s = await h.invoke("store_source", { id: opened.id });
    if (["ready", "indexed", "failed"].includes(s.indexStatus)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const hash = (await h.invoke("store_source", { id: opened.id })).fileHash ?? opened.fileHash;

  let typed = 0;
  let added = 0;
  const query = ["e", "ec", "eco", "econ", "econo", "econom", "economi", "economic", "economics"];
  const ops = {
    add: async () => {
      const doi = `10.5555/new.${added++}.${Math.random().toString(36).slice(2)}`;
      await h.invoke("store_match_identifiers", { works: [{ key: "work", doi, title: "Added while busy" }] }, "interactive");
      const source = await h.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `Added while busy ${added}`, doi, indexStatus: "skipped" } }, "interactive");
      // The row is shown now; the lookup is queued behind it.
      void h.invoke("store_enrich", { ids: [source.id] }, "foreground").catch(() => {});
    },
    openSource: () => h.invoke("store_source", { id: ids[Math.floor(Math.random() * ids.length)] }, "interactive"),
    listPage: () => h.invoke("store_sources", { offset: 0, limit: 100 }, "interactive"),
    typeSearch: () => h.invoke("store_search", { text: query[typed++ % query.length], limit: 30, mode: "keyword", passagesPerSource: 1, scope: "all", filters: [] }, "interactive"),
    openPdf: async () => {
      await h.invoke("library_source_info", { hash }, "interactive");
      await h.invoke("library_source_range", { hash, offset: 0, length: 65536 }, "interactive");
    },
    highlight: () => h.invoke("library_apply_annotations", { hash, upserts: [{ id: `bench-${Math.random()}`, type: "highlight", pageIndex: 0, color: "yellow", text: "x" }], deleted: [] }, "interactive"),
    noteEdit: () => h.invoke("store_note_save", { id: null, sourceId: opened.id, title: "Bench", body: `Edited ${Math.random()}` }, "interactive"),
    tagEdit: () => h.invoke("store_bulk_tag", { ids: [ids[Math.floor(Math.random() * ids.length)]], add: ["bench"], remove: [] }, "interactive"),
    undo: () => h.invoke("store_undo", {}, "interactive").catch(() => {}),
    tagManager: () => h.invoke("store_tag_index", {}, "interactive"),
    status: () => h.invoke("store_status", {}, "background"),
  };
  const measure = async (seconds, stopWhen) => {
    const times = Object.fromEntries(Object.keys(ops).map((k) => [k, []]));
    const end = now() + seconds * 1000;
    while (now() < end && !(stopWhen?.() ?? false)) {
      for (const [name, op] of Object.entries(ops)) {
        const t = now();
        await op();
        times[name].push(now() - t);
        // A user does not click continuously.
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    return Object.fromEntries(Object.entries(times).map(([k, v]) => [k, stats(v)]));
  };

  const result = { executable, hog: HOG, quiet: await measure(5) };

  // Saturate: 40 PDFs indexed with layout analysis, lookups queued for every source, duplicate
  // recounts and a bulk import of references, all at once.
  let stop = false;
  const load = [];
  const pdfs = pdfCopies(40);
  for (let i = 0; i < pdfs.length; i += 10) load.push(h.invoke("store_import_files", { paths: pdfs.slice(i, i + 10) }, "background").catch(() => {}));
  load.push(h.invoke("store_enrich", { ids }, "background").catch(() => {}));
  load.push((async () => {
    while (!stop) await h.invoke("store_duplicates", { withSources: false }, "background").catch(() => {});
  })());
  load.push((async () => {
    // Two at a time, as the Electron bridge lets background work through.
    for (let j = 0; !stop; j += 2)
      await Promise.all(Array.from({ length: 2 }, (_, k) => h.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `Imported ${words[(j + k) % 10]} item ${j + k}`, year: 2000 + ((j + k) % 25), indexStatus: "skipped" } }, "background").catch(() => {})));
  })());
  const hogs = Array.from({ length: HOG }, () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
  await Promise.all(load.slice(0, 4));
  // "The user opens a new PDF while 40 wait": how long until it is indexed.
  const [fresh] = await h.invoke("store_import_files", { paths: pdfCopies(1) }, "interactive");
  await h.invoke("store_index_priority", { ids: [fresh.id], reason: "opened" }, "foreground");
  const t0 = now();
  let openedIndexedMs = null;
  const watch = (async () => {
    for (let i = 0; i < 2400 && !stop; i++) {
      const s = await h.invoke("store_source", { id: fresh.id }, "background");
      if (["ready", "indexed", "failed"].includes(s.indexStatus)) return (openedIndexedMs = Math.round(now() - t0));
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  result.busy = await measure(SECONDS);
  const status = await h.invoke("store_status");
  result.indexedDuringBusy = status.counts?.indexed ?? status.counts;
  await Promise.race([watch, new Promise((r) => setTimeout(r, 60000))]);
  result.openedIndexedMs = openedIndexedMs;
  stop = true;
  for (const hog of hogs) hog.kill();
  h.child.kill();
  return result;
}

(async () => {
  const results = [];
  for (const executable of hosts) {
    const r = await run(executable);
    results.push(r);
    console.error(JSON.stringify(r));
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`\n${r.executable}${r.hog ? ` (${r.hog} busy cores)` : ""}`);
    console.log(["operation".padEnd(12), "quiet p50", "quiet p95", "busy p50", "busy p95", "busy max", "n"].map((s, i) => (i ? s.padStart(10) : s)).join(" "));
    for (const k of Object.keys(r.busy)) {
      const q = r.quiet[k];
      const b = r.busy[k];
      console.log([k.padEnd(12), q.p50, q.p95, b.p50, b.p95, b.max, b.n].map((s, i) => (i ? String(s).padStart(10) : s)).join(" "));
    }
    console.log(`opened PDF indexed during bulk: ${r.openedIndexedMs ?? "not within the window"} ms; indexed while busy: ${JSON.stringify(r.indexedDuringBusy)}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
