// What the user does stays fast while the host is saturated with background work: with 24
// PDFs being indexed (layout analysis), lookups queued for every source and duplicate
// recounts running, "Add to library" from a web result shows its row in the library at once,
// and the commands behind clicks answer within budget, also with the renderer's CPU
// throttled 4× and 6× (a low-end machine). KEY_PERF_SLACK scales the budgets.
//
//   node scripts/smoke-priority.cjs
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { launch, close, throttle, delay, FIXTURES } = require("./perf-lib.cjs");

const SLACK = Number(process.env.KEY_PERF_SLACK) || 1;
const BUDGET = { addVisibleMs: 150 * SLACK, interactiveP95Ms: 100 * SLACK };
// The renderer's own work grows with throttling; the host's answers do not.
const THROTTLED = { 4: 2.5, 6: 3.5 };

async function pdfCopies(dir, count) {
  const names = (await readdir(FIXTURES)).filter((n) => /^PUBMED_.*\.pdf$/.test(n));
  const files = [];
  for (let i = 0; i < count; i++) {
    const bytes = await readFile(path.join(FIXTURES, names[i % names.length]));
    const file = path.join(dir, `busy-${i}.pdf`);
    await writeFile(file, Buffer.concat([bytes, Buffer.from(`\n%key-smoke ${i} ${Math.random()}\n`)]));
    files.push(file);
  }
  return files;
}

const median = (times) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
const p95 = (times) => [...times].sort((a, b) => a - b)[Math.min(times.length - 1, Math.floor(times.length * 0.95))];

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-smoke-priority-"));
  const fixtures = await mkdtemp(path.join(tmpdir(), "key-smoke-priority-fx-"));
  const { app, shell } = await launch({
    profile: path.join(temp, "profile"),
    workspaces: path.join(temp, "ws"),
    env: { KEY_OPENALEX_FIXTURES: fixtures, KEY_WEB_OPENALEX_URL: "http://127.0.0.1:9" },
  });
  const results = {};
  try {
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const ids = await shell.evaluate(async (id) => {
      const out = [];
      for (let i = 0; i < 1500; i += 50)
        out.push(
          ...(await Promise.all(
            Array.from({ length: 50 }, (_, j) =>
              window.key.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `Seeded study ${i + j}`, doi: `10.5555/seed.${i + j}`, year: 1990 + ((i + j) % 30), tags: [`tag ${(i + j) % 200}`], indexStatus: "skipped" } }, id),
            ),
          )),
        );
      return out.map((s) => s.id);
    }, ws.id);
    const [opened] = await shell.evaluate(([id, paths]) => window.key.invoke("store_import_files", { paths }, id), [ws.id, await pdfCopies(temp, 1)]);
    // Saturate: bulk indexing, lookups for every source, duplicate recounts.
    const busy = await pdfCopies(temp, 24);
    await shell.evaluate(
      ([id, paths, ids]) => {
        window.__keyBusy = true;
        void window.key.invoke("store_import_files", { paths, $background: true }, id).catch(() => {});
        void window.key.invoke("store_enrich", { ids, $background: true }, id).catch(() => {});
        void (async () => {
          while (window.__keyBusy) await window.key.invoke("store_duplicates", { withSources: false, $background: true }, id).catch(() => delay(200));
        })();
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      },
      [ws.id, busy, ids],
    );
    for (let i = 0; i < 120; i++) {
      const s = await shell.evaluate((id) => window.key.invoke("store_status", {}, id), ws.id);
      if (s.busy && s.counts?.indexing > 5) break;
      await delay(500);
    }
    await shell.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await shell.locator(".kx-row").nth(1).waitFor({ timeout: 30000 });

    for (const rate of [1, 4, 6]) {
      const cdp = await throttle(shell, rate);
      try {
        // Add to library from a web result: until its row is in the library list.
        const added = [];
        const returned = [];
        for (let n = 0; n < 6; n++) {
          const title = `Added while busy ${rate}x ${n} ${Math.random().toString(36).slice(2, 7)}`;
          // Timed in the page: the call, then each frame until the row is drawn.
          const [answer, visible] = await shell.evaluate(
            async ([id, title, n, rate]) => {
              const t0 = performance.now();
              await window.key.invoke("web_add_to_library", { work: { provider: "openalex", title, doi: `10.5555/busy.${rate}.${n}.${Date.now()}`, year: 2024, authors: ["Ada Lovelace"] }, lookup: true }, id);
              const t1 = performance.now();
              for (;;) {
                if ([...document.querySelectorAll(".kx-row")].some((r) => r.textContent.includes(title))) return [t1 - t0, performance.now() - t0];
                if (performance.now() - t0 > 15000) throw Error(`${title} never appeared`);
                await new Promise((r) => requestAnimationFrame(r));
              }
            },
            [ws.id, title, n, rate],
          );
          // The first add warms the list's code paths; it is not counted.
          if (n > 0) added.push(visible), returned.push(answer);
          await delay(200);
        }
        // The commands behind clicks and keystrokes, timed in the renderer.
        const times = await shell.evaluate(
          async ([id, ids, sourceId]) => {
            const out = [];
            const pick = () => ids[Math.floor(Math.random() * ids.length)];
            const calls = [
              () => window.key.invoke("store_source", { id: pick() }, id),
              () => window.key.invoke("store_sources", { offset: 0, limit: 100 }, id),
              () => window.key.invoke("store_bulk_tag", { ids: [pick()], add: ["busy"], remove: [] }, id),
              () => window.key.invoke("store_note_save", { id: null, sourceId, title: "Busy", body: `Edited ${Math.random()}` }, id),
              () => window.key.invoke("store_search", { text: "seeded", limit: 30, mode: "keyword", passagesPerSource: 1, scope: "all", filters: [] }, id),
              () => window.key.invoke("store_undo", {}, id).catch(() => {}),
            ];
            for (let round = 0; round < 6; round++)
              for (const call of calls) {
                const t = performance.now();
                await call();
                out.push(performance.now() - t);
                await new Promise((r) => setTimeout(r, 20));
              }
            return out;
          },
          [ws.id, ids, opened.id],
        );
        const status = await shell.evaluate((id) => window.key.invoke("store_status", {}, id), ws.id);
        results[`${rate}x`] = { addVisibleMs: Math.round(median(added)), addVisibleMaxMs: Math.round(Math.max(...added)), addReturnedMs: Math.round(median(returned)), interactiveP95Ms: Math.round(p95(times)), interactiveMaxMs: Math.round(Math.max(...times)), indexing: status.counts?.indexing, busy: status.busy };
        if (rate === 1) await shell.screenshot({ path: path.join(temp, "library-while-busy.png") });
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
    }
    await shell.evaluate(() => (window.__keyBusy = false));
    console.log(JSON.stringify(results, null, 1));
    for (const [rate, r] of Object.entries(results)) {
      const scale = THROTTLED[parseInt(rate)] ?? 1;
      assert.ok(r.busy, `${rate}: the host was not busy while measured`);
      assert.ok(r.addVisibleMs <= BUDGET.addVisibleMs * scale, `${rate}: add to library visible after ${r.addVisibleMs} ms (budget ${BUDGET.addVisibleMs * scale})`);
      assert.ok(r.interactiveP95Ms <= BUDGET.interactiveP95Ms * scale, `${rate}: interactive p95 ${r.interactiveP95Ms} ms (budget ${BUDGET.interactiveP95Ms * scale})`);
    }
    console.log(`Priority smoke passed; screenshot in ${temp}`);
  } finally {
    await close(app);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
