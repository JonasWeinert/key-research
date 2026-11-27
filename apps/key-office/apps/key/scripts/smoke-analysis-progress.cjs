// Run serially: native windows and focus are shared with other GUI checks.
// Analysis progress is granular wherever it shows: the host reports layout analysis page by
// page (and which pass), the source page's file card and the library row show the stage
// and counts, reference lookups show "N of M" with a bar, the status bar's work item and
// its popover name the lookup, and the reader's References line says which step it is on.
// Needs a host built from this branch (KEY_HOST_EXECUTABLE) for the per-page layout counts.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
// The layout model, from the dev cache (node tools/models/fetch.mjs); never downloaded here.
const { devCache } = require("../../../../../tools/models/models.cjs");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-analysis-progress-"));
  const fixture = path.join(temp, "Paper.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/PUBMED_16226083.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_MODEL_DIR: process.env.KEY_MODEL_DIR ?? devCache(), KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const until = async (what, test, seconds = 180, every = 250) => {
      for (let i = 0; i < (seconds * 1000) / every; i++) {
        const value = await test();
        if (value) return value;
        await page.waitForTimeout(every);
      }
      throw Error(`Timed out waiting for ${what}`);
    };
    const theme = async (name) => {
      await page.emulateMedia({ colorScheme: name });
      await page.evaluate((theme) => window.key.setAppSettings({ theme }), name);
      await page.waitForTimeout(300);
    };

    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    // The source page, in its own tab, while the paper is read.
    await page.evaluate(({ workspaceId, sourceId }) => window.key.tabAction("open-source-page", { workspaceId, sourceId, title: "Paper", read: false }), {
      workspaceId: ws.id,
      sourceId: created.id,
    });
    const card = page.locator(".key-content-pane:not([hidden]) .kx-file-card");
    // Watch the host's job and the card together until the references are looked up.
    const stages = new Set();
    const cardLines = new Set();
    let shotLayout = false;
    let shotLookup = false;
    await until(
      "analysis to finish",
      async () => {
        const r = await call("store_analysis", { id: created.id });
        if (r.job) stages.add(`${r.job.stage}${r.job.phase ? `:${r.job.phase}` : ""}${r.job.total ? ":counted" : ""}`);
        const text = (await page.evaluate(() => [".kx-page-details-summary", ".kx-file-card"].map((s) => document.querySelector(`.key-content-pane:not([hidden]) ${s}`)?.innerText ?? "").join("\n"))).split("\n").filter((l) => /·|…/.test(l));
        for (const line of text) cardLines.add(line);
        if (!shotLayout && r.job?.stage === "analysing" && r.job.total) {
          shotLayout = true;
          await shot(page, "source-layout-folded-light");
          await page.locator(".key-content-pane:not([hidden]) .kx-page-details-toggle").click();
          await page.waitForTimeout(150);
          await shot(page, "source-layout-light");
        }
        if (!shotLookup && r.analysis?.referencesStatus === "resolving" && r.analysis.referencesDone > 0) {
          shotLookup = true;
          await shot(page, "source-lookup-light");
          // The status bar's work item names the lookup; its popover lists it.
          const work = page.locator(".kx-status-work");
          if (await work.count()) {
            const label = await work.innerText();
            cardLines.add(`status: ${label}`);
            await work.click();
            await page.waitForTimeout(250);
            await shot(page, "status-popover-light");
            await theme("dark");
            await shot(page, "status-popover-dark");
            await page.keyboard.press("Escape");
            await theme("light");
          }
        }
        return ["done", "none", "failed"].includes(r.analysis?.referencesStatus ?? "") && r;
      },
      300,
      120,
    );
    console.log("stages", [...stages]);
    console.log("card", [...cardLines]);
    assert.ok([...stages].some((s) => s.startsWith("analysing:layout") && s.endsWith(":counted")), "layout analysis reports pages");
    assert.ok([...cardLines].some((l) => /Reading layout · page \d+ of \d+|Recognising layout · page \d+ of \d+/.test(l)), "the file card shows the layout page");
    // Done: the card sums up the references.
    await until("summary", async () => /references? ·|reference list|\d+ references?/.test(await card.innerText()));
    await shot(page, "source-done-light");
    await theme("dark");
    await shot(page, "source-done-dark");
    await theme("light");

    // The reader's References line during a re-run: step, stage and counts.
    await page.locator(".key-content-pane:not([hidden]) .kx-source-page").getByRole("button", { name: "Read" }).first().click();
    let reader;
    await until("reader", async () => (reader = app.windows().find((w) => w.url().endsWith("/pdf.html"))));
    await reader.waitForFunction(() => window.__PDFJS_READY__ === true);
    const panelRefs = page.locator(".key-reader-panel").getByRole("tab", { name: /References/ });
    if (await panelRefs.count()) await panelRefs.first().click();
    else await reader.locator(".key-pdf-toolbar").getByRole("button", { name: "References" }).click();
    const status = page.locator(".key-pdf-analysis").first();
    await status.waitFor();
    await status.getByRole("button", { name: "Re-run" }).click();
    const lines = new Set();
    let shotReader = false;
    await until(
      "re-run",
      async () => {
        const text = await status.innerText().catch(() => "");
        if (text) lines.add(text.replace(/\n/g, " | "));
        if (!shotReader && /Step [13] of 3/.test(text) && /page \d+ of \d+|\d+ of \d+/.test(text)) {
          shotReader = true;
          await shot(page, "reader-step-light");
          await theme("dark");
          await shot(page, "reader-step-dark");
          await theme("light");
        }
        const r = await call("store_analysis", { id: created.id });
        return r.analysis?.engine && ["done", "none", "failed"].includes(r.analysis.referencesStatus) && !(await status.getAttribute("data-working"));
      },
      300,
      150,
    );
    console.log("reader", [...lines]);
    assert.ok([...lines].some((l) => /Step 1 of 3/.test(l)), "the reader names the reading step");
    await shot(page, "reader-done-light");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
