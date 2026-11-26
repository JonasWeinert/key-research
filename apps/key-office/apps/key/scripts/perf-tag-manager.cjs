// Times the tag manager on a synthetic 5,000-tag / 5,000-item library: the host calls an
// apply makes (apply, tag index, re-analysis, journal) and, in the UI, Apply on a card until
// the card has gone and until the manager has settled. Prints JSON.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tag-perf-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_OPENALEX_ENABLED: "0", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const out = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(60000);
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const t0 = Date.now();
    await page.evaluate(async (id) => {
      const words = ["learning", "health", "policy", "methods", "survey", "growth", "trade", "climate", "labour", "education"];
      const tag = (n) => (n % 50 === 0 ? `topic ${n >> 1}` : n % 7 === 0 ? `area: ${words[n % 10]} ${n}` : `Topic ${n} ${words[n % 10]}`);
      const jobs = [];
      for (let i = 0; i < 5000; i++) {
        const tags = [tag(i), tag((i * 7 + 3) % 5000), tag((i * 13 + 11) % 5000), words[i % 10]];
        jobs.push(window.key.invoke("store_create", { source: { kind: "reference", itemType: "article", title: `Work ${i}`, tags } }, id));
        if (jobs.length >= 50) await Promise.all(jobs.splice(0));
      }
      await Promise.all(jobs);
    }, ws.id);
    out.seedMs = Date.now() - t0;
    const time = (command, args = {}) =>
      page.evaluate(
        async ({ command, args, id }) => {
          const t = performance.now();
          const r = await window.key.invoke(command, args, id);
          return { ms: Math.round(performance.now() - t), bytes: JSON.stringify(r).length, tags: r?.tags?.length ?? r?.index?.tags?.length, n: Array.isArray(r) ? r.length : undefined };
        },
        { command, args, id: ws.id },
      );
    out.index = await time("store_tag_index");
    out.suggestions = await time("store_tag_suggestions", {});
    out.journal = await time("store_journal", { limit: 100 });
    const plan = await page.evaluate((id) => window.key.invoke("store_tag_plan", { plan: { type: "nest", parent: "learning", children: ["Topic 1 health", "Topic 11 health"] } }, id), ws.id);
    out.apply = await time("store_tag_apply_many", { operations: [plan.operation], label: plan.label });
    out.applyWithIndex = await time("store_tag_apply_many", { operations: [plan.operation], label: plan.label, withIndex: true });

    // In the UI.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    const opened = Date.now();
    await page.locator(".kx-tag-picker > summary").click();
    await page.getByRole("button", { name: /Manage, merge and clean up tags/ }).click();
    const manager = page.getByRole("dialog", { name: "Manage tags" });
    await manager.locator(".kx-tm-card").first().waitFor();
    out.uiOpenToSuggestionsMs = Date.now() - opened;
    const ui = [];
    for (let i = 0; i < 3; i++) {
      const card = manager.locator(".kx-tm-card:not([data-leaving])").first();
      const id = await card.getAttribute("data-suggestion");
      const t = Date.now();
      await card.getByRole("button", { name: "Apply", exact: true }).click();
      await card.locator(".kx-tm-apply[data-pending]").waitFor().catch(() => {});
      const feedback = Date.now() - t;
      await manager.locator(`.kx-tm-card[data-suggestion="${id}"]:not([data-leaving])`).waitFor({ state: "detached" });
      const gone = Date.now() - t;
      // Settled: no apply in flight and the suggestions re-read.
      await page.waitForFunction(() => !document.querySelector(".kx-tag-manager [data-applying], .kx-tag-manager [data-analysing]") && !document.querySelector(".kx-sheet-close:disabled"));
      ui.push({ feedbackMs: feedback, cardGoneMs: gone, settledMs: Date.now() - t });
      await page.waitForTimeout(300);
    }
    out.ui = ui;
    out.applyTimings = await page.evaluate(() => window.keyTagTimings);
    console.log(JSON.stringify({ ok: true, temp, ...out }, null, 1));
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
