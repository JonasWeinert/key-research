// Performance budget smoke: generous limits on startup, idle CPU, idle memory, opening a
// 2,000-source library and what the shell and main process load at startup, so a
// regression (an eager import of the editors, a new poller, a leak at idle) fails loudly.
// Budgets are about 2-3× what a recent Apple-silicon Mac measures; KEY_PERF_SLACK scales
// the time budgets (e.g. 2 on a slow CI machine).
//
//   node scripts/perf-budget.cjs
const assert = require("node:assert/strict");
const { mkdtemp, readFile, stat } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { launch, close, processes, cpuOver, until, delay } = require("./perf-lib.cjs");

const SLACK = Number(process.env.KEY_PERF_SLACK) || 1;
const BUDGET = {
  freshInteractiveMs: 2500 * SLACK,
  warmInteractiveMs: 2000 * SLACK,
  idleCpuPct: 3,
  idleFootprintMiB: 700,
  openLibrary2kMs: 1500 * SLACK,
  mainBundleKB: 2000,
  shellInitialJsKB: 2600,
  pdfInitialJsKB: 2300,
};

async function initialJs(html) {
  const dir = path.resolve(__dirname, "../out/renderer");
  const text = await readFile(path.join(dir, html), "utf8");
  let total = 0;
  for (const ref of new Set(text.match(/assets\/[^"]+\.js/g) ?? [])) total += (await stat(path.join(dir, ref))).size;
  return Math.round(total / 1024);
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-perf-budget-"));
  const fixtures = await mkdtemp(path.join(tmpdir(), "key-perf-budget-fx-"));
  const options = { profile: path.join(temp, "profile"), workspaces: path.join(temp, "ws"), env: { KEY_OPENALEX_FIXTURES: fixtures } };
  const measured = {};
  measured.mainBundleKB = Math.round((await stat(path.resolve(__dirname, "../out/main/index.js"))).size / 1024);
  measured.shellInitialJsKB = await initialJs("index.html");
  measured.pdfInitialJsKB = await initialJs("pdf.html");

  let { app, shell, timings } = await launch(options);
  measured.freshInteractiveMs = timings.interactiveMs;
  const [ws] = await shell.evaluate(() => window.key.workspaces());
  await shell.evaluate(async (id) => {
    for (let i = 0; i < 2000; i += 50)
      await Promise.all(
        Array.from({ length: 50 }, (_, j) =>
          window.key.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `Budget source ${i + j}`, year: 1990 + ((i + j) % 30), tags: [`tag ${i + j}`] } }, id),
        ),
      );
  }, ws.id);
  await close(app);

  let mainPid;
  ({ app, shell, timings, mainPid } = await launch(options));
  try {
    measured.warmInteractiveMs = timings.interactiveMs;
    // Idle Home once background work on the seeded library has settled.
    await delay(12000);
    const idle = await cpuOver(app, mainPid, 10000);
    measured.idleCpuPct = idle.totalPct;
    measured.idleCpuBy = idle.processes.map((p) => `${p.role} ${p.cpuPct}%`).join(", ");
    measured.idleFootprintMiB = (await processes(app, mainPid)).totalFootprintMiB;
    const t = Date.now();
    await shell.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    measured.openLibrary2kMs = await until(shell, () => document.querySelectorAll(".kx-row").length > 5, null, t);
  } finally {
    await close(app);
  }
  console.log(JSON.stringify({ measured, budget: BUDGET, temp }, null, 1));
  for (const [key, limit] of Object.entries(BUDGET)) assert.ok(measured[key] <= limit, `${key}: ${measured[key]} exceeds the budget of ${limit}`);
  console.log("perf budget ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
