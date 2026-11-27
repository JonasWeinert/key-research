// Repeatable performance benchmark of the Key Electron app on isolated temp profiles.
// Measures startup (fresh and warm profile), memory per process (RSS and macOS physical
// footprint) at each stage, idle CPU and wakeups, interaction latencies on a 5,000-source /
// 5,000-tag library, scroll frame times and long tasks, bundle sizes and script time, all
// unthrottled and with Chromium CPU throttling (4×, 6×) to stand in for a low-end machine.
//
//   node scripts/bench-electron.cjs [--quick] [--idle-minutes N] [--sources N] [--out file.json] [--label text]
//
// --quick: 1 startup run each, 30 s idle instead of 10 min, no 6× pass. Writes JSON and prints a table.
// KEY_ELECTRON_EXECUTABLE runs a packaged Key.app binary instead of the built `out/`.
const { mkdtemp, mkdir, writeFile, readdir, stat, readFile } = require("node:fs/promises");
const { gzipSync } = require("node:zlib");
const http = require("node:http");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { launch, close, processes, cpuOver, until, scrollProbe, throttle, delay, FIXTURES } = require("./perf-lib.cjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const QUICK = flag("--quick");
const SOURCES = Number(opt("--sources", 5000));
const IDLE_MS = Number(opt("--idle-minutes", QUICK ? 0.5 : 10)) * 60_000;
const RUNS = Number(opt("--runs", QUICK ? 1 : 3));
const RATES = QUICK ? [1, 4] : [1, 4, 6];
const APP = process.env.KEY_BENCH_APP ?? path.resolve(__dirname, "..");
const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

async function seed(shell, workspaceId, count) {
  const start = Date.now();
  await shell.evaluate(
    async ({ id, count }) => {
      const words = ["learning", "health", "policy", "networks", "economics", "survey", "trial", "cohort", "review", "model", "climate", "education", "behaviour", "markets", "genomics"];
      const pick = (i, n) => words[(i * 7 + n * 13) % words.length];
      for (let i = 0; i < count; i += 50) {
        const batch = [];
        for (let j = i; j < Math.min(count, i + 50); j++)
          batch.push(
            window.key.invoke(
              "store_create",
              {
                source: {
                  kind: "reference",
                  itemType: "article",
                  title: `A ${pick(j, 1)} study of ${pick(j, 2)} and ${pick(j, 3)} (${j + 1})`,
                  authors: [{ family: `Author${j % 977}`, given: "A." }],
                  year: 1980 + (j % 45),
                  tags: [`topic ${j + 1}`, `field ${pick(j, 4)}`],
                },
              },
              id,
            ),
          );
        await Promise.all(batch);
      }
    },
    { id: workspaceId, count },
  );
  return Date.now() - start;
}

async function bundle() {
  const dir = path.join(APP, "out/renderer/assets");
  const files = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/\.(js|mjs|css)$/.test(name)) continue;
    const bytes = await readFile(path.join(dir, name));
    files.push({ name, kB: Math.round(bytes.length / 1024), gzipKB: Math.round(gzipSync(bytes).length / 1024) });
  }
  files.sort((a, b) => b.kB - a.kB);
  const html = async (n) => (await readFile(path.join(APP, "out/renderer", n), "utf8").catch(() => "")).match(/assets\/[^"]+/g) ?? [];
  return { files, shellHtmlRefs: await html("index.html"), pdfHtmlRefs: await html("pdf.html") };
}

/** JS heap and DOM size of a page now (durations need the domain enabled before the work: see shellLoadWork). */
async function scriptMetrics(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  await cdp.detach().catch(() => {});
  return { jsHeapMiB: Math.round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes };
}

async function pdfReady(app, hash, start) {
  for (;;) {
    for (const page of app.windows().filter((p) => p.url().endsWith("/pdf.html"))) {
      try {
        if ((await page.evaluate(() => window.key.readerReady())).source.hash !== hash) continue;
        await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((c) => c.width > 0 && c.height > 0), undefined, { polling: "raf", timeout: 30000 });
        return { page, ms: Date.now() - start };
      } catch {}
    }
    if (Date.now() - start > 60000) throw Error("Reader did not render");
    await delay(16);
  }
}

/** Renderer interactions on the seeded library, at one CPU throttling rate. */
async function interactions(app, shell, ws, rate) {
  const r = {};
  const cdp = await throttle(shell, rate);
  try {
    // Open the library on 5k sources: heading and first rows.
    await shell.evaluate(() => window.key.tabAction("open-home"));
    await shell.waitForFunction(() => !document.querySelector(".kx-row"));
    let t = Date.now();
    await shell.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    r.openLibraryMs = await until(shell, () => document.querySelectorAll(".kx-row").length > 5, null, t);
    await delay(800);
    // Scroll the virtualised list.
    r.libraryScroll = await scrollProbe(shell, ".kx-list", { steps: 150, stepPx: 140 });
    // Type to search: first results.
    const input = shell.locator(".kx-library-main input[aria-label]").first();
    await input.click();
    await input.fill("");
    t = Date.now();
    await shell.keyboard.type("economics", { delay: 30 });
    r.typeToSearchMs = await until(shell, () => document.querySelectorAll("[data-hit]").length > 0, null, t);
    r.searchAfterLastKeyMs = r.typeToSearchMs - 9 * 30;
    await input.fill("");
    await shell.keyboard.press("Escape");
    await delay(300);
    // Command palette (menu accelerator path).
    t = Date.now();
    await app.evaluate(({ Menu }) => {
      const find = (items) => items.flatMap((i) => (i.label === "Commands…" ? [i] : i.submenu ? find(i.submenu.items) : []));
      find(Menu.getApplicationMenu().items)[0].click();
    });
    r.openPaletteMs = await until(shell, () => document.querySelector(".kx-palette :is(input, textarea)"), null, t);
    await delay(200);
    await shell.keyboard.press("Escape");
    await shell.waitForFunction(() => !document.querySelector(".kx-palette"));
    // Settings (the app menu's item, as ⌘, does).
    t = Date.now();
    await app.evaluate(({ Menu }) => {
      const find = (items) => items.flatMap((i) => (i.label === "Key Settings…" ? [i] : i.submenu ? find(i.submenu.items) : []));
      find(Menu.getApplicationMenu().items)[0].click();
    });
    r.openSettingsMs = await until(shell, () => document.querySelector(".kx-settings-nav"), null, t);
    await delay(300);
    await shell.keyboard.press("Escape");
    await shell.waitForFunction(() => !document.querySelector(".kx-settings-nav"), undefined, { timeout: 5000 }).catch(() => {});
    await delay(200);
    // Tag manager on 5k tags.
    t = Date.now();
    await shell.evaluate((id) => window.dispatchEvent(new CustomEvent("key:open-tag-manager", { detail: { workspaceId: id } })), ws.id);
    r.openTagManagerMs = await until(shell, () => document.querySelector('[role="dialog"][aria-label="Manage tags"]'), null, t);
    r.tagManagerSuggestionsMs = await until(shell, () => document.querySelector('[role="dialog"][aria-label="Manage tags"] .kx-tm-card, [role="dialog"][aria-label="Manage tags"] [role="region"]'), null, t, 60000).catch(() => null);
    await delay(300);
    await shell.keyboard.press("Escape");
    await shell.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Manage tags"]'), undefined, { timeout: 5000 }).catch(() => {});
    r.script = await scriptMetrics(shell);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return r;
}

async function serveWeb() {
  const server = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Bench page</title><h1>Bench page</h1>${"<p>Lorem ipsum dolor sit amet. </p>".repeat(200)}`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-bench-"));
  const out = opt("--out", path.join(temp, "bench.json"));
  const fixtures = await mkdtemp(path.join(tmpdir(), "key-bench-openalex-"));
  // Synthetic sources must never reach OpenAlex: fixture mode with no fixtures.
  const env = { KEY_OPENALEX_FIXTURES: fixtures };
  const result = { label: opt("--label", ""), date: new Date().toISOString(), quick: QUICK, sources: SOURCES, packaged: !!process.env.KEY_ELECTRON_EXECUTABLE, host: process.env.KEY_HOST_EXECUTABLE ?? "default", stages: {}, startup: {}, interactions: {} };
  const { server, url: webUrl } = await serveWeb();
  try {
    result.bundle = await bundle();
    // 1. Fresh-profile launches (the first run of a new user: workspace created, host started).
    const fresh = [];
    for (let i = 0; i < RUNS; i++) {
      const dir = path.join(temp, `fresh-${i}`);
      const { app, timings } = await launch({ profile: path.join(dir, "profile"), workspaces: path.join(dir, "ws"), env });
      fresh.push(timings);
      await close(app);
    }
    // 2. The long session on one profile: seed, then every stage.
    const main = { profile: path.join(temp, "main/profile"), workspaces: path.join(temp, "main/ws"), env };
    let { app, shell, mainPid, timings } = await launch(main);
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    result.seedMs = await seed(shell, ws.id, SOURCES);
    await close(app);
    // Warm launches on the seeded profile.
    const warm = [];
    for (let i = 0; i < RUNS; i++) {
      ({ app, timings } = await launch(main));
      warm.push(timings);
      if (i < RUNS - 1) await close(app);
    }
    ({ shell } = { shell: await app.firstWindow() });
    mainPid = await app.evaluate(() => process.pid);
    const summarize = (runs) => ({ runs, median: Object.fromEntries(["spawnToMainMs", "mainToRendererMs", "firstPaintMs", "firstContentfulPaintMs", "domContentLoadedMs", "interactiveMs"].map((k) => [k, median(runs.map((r) => r[k]))])) });
    result.startup.fresh = summarize(fresh);
    result.startup.warm = summarize(warm);

    const stage = async (name, ms = 3000) => {
      await delay(ms);
      result.stages[name] = await processes(app, mainPid);
      console.error(`[bench] ${name}: ${result.stages[name].totalFootprintMiB} MiB footprint, ${result.stages[name].totalRssMiB} MiB RSS`);
    };
    // Idle Home.
    await stage("idleHome", 8000);
    result.idleHomeCpu = await cpuOver(app, mainPid, QUICK ? 10000 : 30000);
    // Library with 5k sources.
    await shell.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await shell.waitForFunction(() => document.querySelectorAll(".kx-row").length > 5);
    await stage("library5k");
    result.libraryIdleCpu = await cpuOver(app, mainPid, 10000);
    // CPU while scrolling the library.
    {
      const scroll = shell.evaluate(async () => {
        const el = document.querySelector(".kx-list");
        for (let i = 0; i < 300; i++) {
          el.scrollTop = (i % 150) * 200;
          await new Promise(requestAnimationFrame);
        }
      });
      result.libraryScrollCpu = await cpuOver(app, mainPid, 4000);
      await scroll;
    }
    // Interactions at each throttling rate.
    for (const rate of RATES) {
      result.interactions[`${rate}x`] = await interactions(app, shell, ws, rate);
      console.error(`[bench] interactions ${rate}x`, JSON.stringify(result.interactions[`${rate}x`]));
    }
    // Shell renderer startup under throttling: reload the shell with the CPU slowed.
    result.startup.throttledShellReload = {};
    for (const rate of RATES.filter((r) => r > 1)) {
      await shell.evaluate(() => window.key.tabAction("open-home"));
      const cdp = await throttle(shell, rate);
      const t = Date.now();
      await shell.reload();
      result.startup.throttledShellReload[`${rate}x`] = await until(shell, () => document.querySelector('[aria-label="Home"]') && document.querySelector(".key-sidebar"), null, t);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach().catch(() => {});
      await delay(1000);
    }
    {
      // Script, style and layout time of a shell load (V8 code cache warm, as on every launch after the first).
      const cdp = await shell.context().newCDPSession(shell);
      await cdp.send("Performance.enable");
      const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
      const t = Date.now();
      await shell.reload();
      result.startup.unthrottledShellReload = await until(shell, () => document.querySelector('[aria-label="Home"]') && document.querySelector(".key-sidebar"), null, t);
      const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
      const d = (k) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
      result.startup.shellLoadWork = { scriptMs: d("ScriptDuration"), taskMs: d("TaskDuration"), layoutMs: d("LayoutDuration"), styleMs: d("RecalcStyleDuration"), jsHeapMiB: Math.round(after.JSHeapUsedSize / 1048576) };
      await cdp.detach().catch(() => {});
    }
    await delay(1500);
    // One PDF.
    const inputs = ["interaction.pdf", "scientific-unlinked.pdf", "PUBMED_33599681.pdf"].map((n) => path.join(FIXTURES, n));
    const pdfs = await shell.evaluate(async ({ inputs, id }) => {
      const out = [];
      for (const input of inputs) {
        const info = await window.key.invoke("library_import_file", { path: input }, id);
        out.push({ ...info, documentHash: info.hash, workspaceId: id });
      }
      return out;
    }, { inputs, id: ws.id });
    await shell.evaluate(() => window.key.tabAction("open-home"));
    await delay(2000);
    let t = Date.now();
    await shell.evaluate((s) => window.key.openSource(s), pdfs[0]);
    let reader = await pdfReady(app, pdfs[0].hash, t);
    result.interactions.openPdfFirstPageMs = reader.ms;
    await stage("onePdf");
    result.interactions.pdfScroll = {};
    for (const rate of RATES) {
      const cdp = await throttle(reader.page, rate);
      result.interactions.pdfScroll[`${rate}x`] = await scrollProbe(reader.page, ".pdfjs-scroll", { steps: 120, stepPx: 160 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach().catch(() => {});
      await reader.page.evaluate(() => (document.querySelector(".pdfjs-scroll").scrollTop = 0));
    }
    result.interactions.pdfScript = await scriptMetrics(reader.page);
    // Three PDFs, a note, a browser tab.
    const opens = [];
    for (const s of pdfs.slice(1)) {
      t = Date.now();
      await shell.evaluate((s) => window.key.openSource(s), s);
      opens.push((await pdfReady(app, s.hash, t)).ms);
    }
    result.interactions.openPdfMoreMs = opens;
    t = Date.now();
    const note = await shell.evaluate((id) => window.key.invoke("store_note_save", { id: null, sourceId: null, title: "Bench note", body: "Some text\n\n- a list\n- of items" }, id), ws.id);
    await shell.evaluate(({ id, note }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId: note.id, title: note.title }), { id: ws.id, note });
    result.interactions.openNoteMs = await until(shell, () => document.querySelector(".ProseMirror"), null, t);
    t = Date.now();
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), webUrl);
    for (;;) {
      if (app.windows().some((p) => p.url() === webUrl)) break;
      if (Date.now() - t > 30000) break;
      await delay(16);
    }
    const web = app.windows().find((p) => p.url() === webUrl);
    if (web) await web.waitForLoadState("load");
    result.interactions.openBrowserTabMs = Date.now() - t;
    await stage("threePdfsNoteWeb", 4000);
    // Tab switch: cycle through the tabs, time to the shell reflecting the new active tab.
    {
      const state = await shell.evaluate(() => window.key.tabs());
      const ids = state.tabs.map((x) => x.id);
      const times = [];
      for (let i = 0; i < Math.min(8, ids.length * 2); i++) {
        const id = ids[i % ids.length];
        if (id === (await shell.evaluate(() => window.key.tabs())).activeTabId) continue;
        t = Date.now();
        await shell.evaluate((id) => window.key.tabAction("activate", { tabId: id }), id);
        times.push(await until(shell, (id) => document.querySelector(`[data-tab-id="${id}"][aria-selected="true"]`), id, t, 5000).catch(() => null));
        await delay(250);
      }
      result.interactions.tabSwitchMs = { median: median(times), all: times };
    }
    result.threePdfsCpu = await cpuOver(app, mainPid, 10000);
    // Close everything and check what memory comes back.
    {
      const state = await shell.evaluate(() => window.key.tabs());
      for (const tab of state.tabs) await shell.evaluate((id) => window.key.tabAction("close", { tabId: id }), tab.id).catch(() => {});
      await shell.evaluate(() => window.key.tabAction("open-home"));
    }
    await stage("afterClose", 8000);
    // Long idle with background indexing finished.
    console.error(`[bench] idling ${IDLE_MS / 1000}s`);
    await delay(IDLE_MS);
    await stage("afterIdle", 0);
    result.idleLongCpu = await cpuOver(app, mainPid, QUICK ? 10000 : 30000);
    await close(app);
  } finally {
    server.close();
  }
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(table(result));
  console.log(`\nJSON: ${out}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function table(r) {
  const lines = [];
  const row = (k, v) => lines.push(`${k.padEnd(44)} ${v}`);
  lines.push(`Key benchmark ${r.label} ${r.date}${r.quick ? " (quick)" : ""}`);
  lines.push("— startup (median ms from launch) —");
  for (const kind of ["fresh", "warm"]) {
    const m = r.startup[kind].median;
    row(`${kind}: first paint / interactive`, `${m.firstPaintMs} / ${m.interactiveMs}  (main ready +${m.spawnToMainMs}, renderer +${m.mainToRendererMs})`);
  }
  row("shell reload to interactive 1× / throttled", `${r.startup.unthrottledShellReload} / ${Object.entries(r.startup.throttledShellReload).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const w = r.startup.shellLoadWork ?? {};
  row("shell load: script / task / layout / style ms", `${w.scriptMs} / ${w.taskMs} / ${w.layoutMs} / ${w.styleMs}  (JS heap ${w.jsHeapMiB} MiB)`);
  lines.push("— memory (MiB footprint / RSS) —");
  for (const [name, s] of Object.entries(r.stages)) {
    row(name, `${s.totalFootprintMiB} / ${s.totalRssMiB}`);
    for (const p of s.processes) row(`   ${p.role}`, `${p.footprintMiB} / ${p.rssMiB}`);
  }
  lines.push("— CPU (% of one core, total) —");
  for (const k of ["idleHomeCpu", "libraryIdleCpu", "libraryScrollCpu", "threePdfsCpu", "idleLongCpu"])
    if (r[k]) row(k, `${r[k].totalPct}%  ${r[k].processes.map((p) => `${p.role} ${p.cpuPct}%${p.wakeupsPerSec != null ? ` (${p.wakeupsPerSec} wakeups/s)` : ""}`).join(", ")}`);
  lines.push("— interactions (ms) —");
  for (const [rate, i] of Object.entries(r.interactions)) {
    if (!/x$/.test(rate)) continue;
    row(`${rate} open library / type-to-search / after last key`, `${i.openLibraryMs} / ${i.typeToSearchMs} / ${i.searchAfterLastKeyMs}`);
    row(`${rate} palette / settings / tag manager (suggestions)`, `${i.openPaletteMs} / ${i.openSettingsMs} / ${i.openTagManagerMs} (${i.tagManagerSuggestionsMs})`);
    row(`${rate} library scroll fps / p95 / max frame / long tasks`, `${i.libraryScroll.fps} / ${i.libraryScroll.p95FrameMs} / ${i.libraryScroll.maxFrameMs} / ${i.libraryScroll.longTasks} (${i.libraryScroll.longTaskMs} ms)`);
  }
  const i = r.interactions;
  row("open PDF to first page / more PDFs", `${i.openPdfFirstPageMs} / ${(i.openPdfMoreMs ?? []).join(", ")}`);
  for (const [rate, s] of Object.entries(i.pdfScroll ?? {})) row(`${rate} PDF scroll fps / p95 / max / long tasks`, `${s.fps} / ${s.p95FrameMs} / ${s.maxFrameMs} / ${s.longTasks} (${s.longTaskMs} ms)`);
  row("open note / browser tab / tab switch median", `${i.openNoteMs} / ${i.openBrowserTabMs} / ${i.tabSwitchMs?.median}`);
  lines.push("— bundle (kB raw / gzip) —");
  for (const f of r.bundle.files.slice(0, 12)) row(`   ${f.name}`, `${f.kB} / ${f.gzipKB}`);
  row("shell index.html loads", r.bundle.shellHtmlRefs.join(" "));
  return lines.join("\n");
}
