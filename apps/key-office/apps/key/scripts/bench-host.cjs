// Benchmarks the Rust host on its own (no Electron): startup to first answer, library
// commands on a synthetic 5,000-source / 5,000-tag library, and its memory. Compare builds:
//
//   node scripts/bench-host.cjs <host binary> [<another host binary> …] [--sources N]
//
// Each binary runs on its own temp library with OpenAlex in offline fixture mode.
const { spawn, execFileSync } = require("node:child_process");
const { mkdtempSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const argv = process.argv.slice(2);
const SOURCES = argv.includes("--sources") ? Number(argv[argv.indexOf("--sources") + 1]) : 5000;
const hosts = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--sources");
const pdfium = path.resolve(__dirname, "../../../../../vendor/pdfium/lib/libpdfium.dylib");

function host(executable) {
  const library = mkdtempSync(path.join(tmpdir(), "key-host-bench-"));
  const child = spawn(executable, ["--library", library], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, PDFIUM_DYNAMIC_LIB_PATH: pdfium, PDFIUM_LIB_PATH: pdfium, KEY_OPENALEX_FIXTURES: mkdtempSync(path.join(tmpdir(), "key-host-bench-fx-")) },
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
      buffer = buffer.subarray(total);
      const p = pending.get(header.id);
      if (!p) continue;
      pending.delete(header.id);
      header.ok ? p.resolve(header.result) : p.reject(new Error(String(header.error)));
    }
  });
  // The host bounds concurrent requests ("Backend busy"); retry like the Electron bridge's queue would.
  const invoke = async (command, args = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(command, args);
      } catch (e) {
        if (!/busy/i.test(String(e)) || attempt > 200) throw e;
        await new Promise((r) => setTimeout(r, 2));
      }
    }
  };
  const send = (command, args) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      const header = Buffer.from(JSON.stringify({ id, command, args, headers: {}, binaryLength: 0 }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(header.length);
      child.stdin.write(Buffer.concat([prefix, header]));
    });
  return { child, invoke };
}
const time = async (f) => {
  const t = process.hrtime.bigint();
  const value = await f();
  return [Number(process.hrtime.bigint() - t) / 1e6, value];
};
const rss = (pid) => Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 102.4) / 10;
const cpu = (pid) => {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim().split(":").map(Number);
  return t.reduce((s, x) => s * 60 + x, 0);
};

(async () => {
  const results = [];
  for (const executable of hosts) {
    const r = { executable, sizeMiB: Math.round(statSync(executable).size / 104857.6) / 10 };
    const t0 = process.hrtime.bigint();
    const h = host(executable);
    await h.invoke("store_status");
    r.startupToFirstAnswerMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    r.rssAfterStartMiB = rss(h.child.pid);
    const words = ["learning", "health", "policy", "networks", "economics", "survey", "trial", "cohort", "review", "model"];
    [r.seedMs] = await time(async () => {
      for (let i = 0; i < SOURCES; i += 8)
        await Promise.all(
          Array.from({ length: Math.min(8, SOURCES - i) }, (_, k) => {
            const j = i + k;
            return h.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `A ${words[j % 10]} study of ${words[(j * 3) % 10]} (${j})`, authors: [{ family: `Author${j % 977}`, given: "A." }], year: 1980 + (j % 45), tags: [`topic ${j + 1}`, `field ${words[(j * 7) % 10]}`] } });
          }),
        );
    });
    const runs = async (name, command, args, n = 5) => {
      const times = [];
      for (let i = 0; i < n; i++) times.push((await time(() => h.invoke(command, args)))[0]);
      times.sort((a, b) => a - b);
      r[name] = Math.round(times[Math.floor(n / 2)] * 10) / 10;
    };
    await runs("statusMs", "store_status", {});
    await runs("sourcesPage300Ms", "store_sources", { offset: 0, limit: 300 });
    await runs("facetsMs", "store_facets", {});
    await runs("tagIndexMs", "store_tag_index", {});
    await runs("searchMs", "store_search", { text: "economics", limit: 60, passagesPerSource: 3, collectionId: null, scope: "all", kind: null, tag: null, filters: [] });
    r.rssAfterWorkMiB = rss(h.child.pid);
    // Idle CPU for 10 s once the work is done.
    // Background work after the seed (lookups, indexing) settles first: wait until a 5 s window is quiet (max 3 min).
    for (let waited = 0; waited < 180; waited += 5) {
      const c = cpu(h.child.pid);
      await new Promise((res) => setTimeout(res, 5000));
      if (cpu(h.child.pid) - c < 0.05) break;
      r.settleSeconds = waited + 5;
    }
    const c0 = cpu(h.child.pid);
    await new Promise((res) => setTimeout(res, 10000));
    r.idleCpuPct = Math.round(((cpu(h.child.pid) - c0) / 10) * 1000) / 10;
    r.rssIdleMiB = rss(h.child.pid);
    // Import three PDFs and time until they are read and indexed; peak RSS of the host and its workers.
    const pdfs = ["interaction.pdf", "scientific-unlinked.pdf", "PUBMED_33599681.pdf"].map((n) => path.resolve(__dirname, "../../../../../tests/fixtures", n));
    const treeRss = () => {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
      const pids = new Set([h.child.pid]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) pids.add(pid), (grew = true);
      }
      return rows.filter(([pid]) => pids.has(pid)).reduce((s, [, , kb]) => s + kb, 0) / 1024;
    };
    let peak = 0;
    const [indexMs] = await time(async () => {
      for (const p of pdfs) await h.invoke("library_import_file", { path: p });
      for (let i = 0; i < 2400; i++) {
        peak = Math.max(peak, treeRss());
        const s = await h.invoke("store_status");
        if (i > 4 && !s.busy && !s.counts?.indexing && !s.activity?.reading && !s.activity?.embedding) break;
        await new Promise((res) => setTimeout(res, 250));
      }
    });
    r.indexThreePdfsMs = Math.round(indexMs);
    r.indexPeakTreeRssMiB = Math.round(peak);
    h.child.kill();
    results.push(r);
    console.error(JSON.stringify(r));
  }
  const keys = Object.keys(results[0]).filter((k) => k !== "executable");
  console.log(["metric".padEnd(24), ...results.map((r) => path.basename(path.dirname(r.executable)).padStart(14))].join(" "));
  for (const k of keys) console.log([k.padEnd(24), ...results.map((r) => String(r[k]).padStart(14))].join(" "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
