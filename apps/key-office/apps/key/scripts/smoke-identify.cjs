// Run serially: native windows and focus are shared with other GUI checks.
// Added PDFs are identified (recorded OpenAlex responses in tests/fixtures/openalex; no
// network): through every way a PDF enters the library (Add file, a drop, a download by
// URL) the DOI the PDF carries is found and its metadata attached, a PDF for a reference
// already in the library joins that reference, a PDF without a DOI is matched by its title
// only when its authors agree, and a PDF whose only DOIs are in its references gets none.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../tests/fixtures");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-identify-"));
  // The download source: a local server handing out one fixture PDF.
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/pdf" });
    createReadStream(path.join(fixtures, "PUBMED_32285014.pdf")).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: path.join(fixtures, "openalex"),
      // Identification runs before layout analysis; the model only slows the smoke down.
      KEY_LAYOUT_MODEL_ENABLED: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const drop = (files) => page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files });
    const until = async (id, test, what) => {
      let source;
      for (let i = 0; i < 360; i++) {
        source = await call("store_source", { id });
        if (source && test(source)) return source;
        await page.waitForTimeout(250);
      }
      throw Error(`${what}: ${JSON.stringify(source && { title: source.title, doi: source.doi, enrichStatus: source.enrichStatus, enrichError: source.enrichError, indexStatus: source.indexStatus })}`);
    };

    // A reference the user added earlier, without its PDF.
    const reference = await call("store_create", { source: { kind: "reference", itemType: "article", title: "Falls in memory care (to read)", doi: "10.2196/17551" } });

    // Add file: a JAMA article with its DOI under the abstract and DOIs of cited works at the end.
    const jama = await call("library_import_file", { path: path.join(fixtures, "PUBMED_33599681.pdf") });
    // A drop: Nature Medicine, DOI in the document information; and the PDF of that reference.
    const [nature, jmir] = await drop([path.join(fixtures, "PUBMED_34140702.pdf"), path.join(fixtures, "PUBMED_34137723.pdf")]);
    // A download by URL ("Downloaded paper" until it is identified).
    const downloaded = await call("library_download_pdf", { url: `http://127.0.0.1:${server.address().port}/paper.pdf` });
    // A synthetic paper whose only DOIs are in its references.
    const [synthetic] = await drop([path.join(fixtures, "scientific-unlinked.pdf")]);
    // A PDF without any DOI, printed here: found by its title, its author on the page.
    const printed = path.join(temp, "big-data-draft.pdf");
    const pdf = await app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ show: false });
      const html = `<html><head><title>draft</title></head><body style="font-family: Georgia; margin: 60px">
        <p style="font-size: 11px">Commentary</p>
        <h1 style="font-size: 30px; font-weight: 600">Big data, medicines safety and pharmacovigilance</h1>
        <p style="font-size: 12px">Rabia Hussain, School of Pharmaceutical Sciences, 2021</p>
        <p style="font-size: 12px">Big data has the potential to change how the safety of medicines is monitored, and pharmacovigilance systems need to adapt.</p></body></html>`;
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const data = await w.webContents.printToPDF({});
      w.destroy();
      return data.toString("base64");
    });
    await writeFile(printed, Buffer.from(pdf, "base64"));
    const draft = await call("library_import_file", { path: printed });
    // The library is open while the lookups run, so its rows have to follow them.
    await page.locator(".key-sidebar .kx-library-row .kx-tree-label").click();
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();

    // Each is looked up by what it carries; the file-name title gives way to the work's.
    let s = await until(jama.id, (x) => x.enrichStatus === "done", "JAMA by its printed DOI");
    assert.equal(s.doi, "10.1001/jamacardio.2021.0185");
    assert.equal(s.title, "Utility of a Deep-Learning Algorithm to Guide Novices to Acquire Echocardiograms for Limited Diagnostic Use");
    assert.equal(s.creators[0].family, "Narang");
    assert.equal((s.identifiedBy), "page");
    s = await until(nature.id, (x) => x.enrichStatus === "done", "Nature Medicine by its metadata DOI");
    assert.equal(s.doi, "10.1038/s41591-021-01384-9");
    assert.equal(s.title, "Deep learning of HIV field-based rapid tests");
    assert.equal(s.identifiedBy, "metadata");
    s = await until(downloaded.id, (x) => x.enrichStatus === "done", "the download");
    assert.equal(s.doi, "10.1038/s41746-020-0261-3");
    assert.equal(s.title, "Artificial intelligence for the diagnosis of heart failure");

    // The JMIR PDF (its DOI in the "Please cite as" box on its last page) joined the reference.
    s = await until(reference.id, (x) => !!x.fileHash && x.enrichStatus === "done", "the reference gaining its PDF");
    assert.equal(s.kind, "pdf");
    assert.equal(s.title, "Falls in memory care (to read)", "the user's title stays");
    assert.equal(s.openalexId, "W3170686964");
    assert.equal(await call("store_source", { id: jmir.id }), null, "no duplicate");

    // Matched by title, the author on the page agreeing.
    s = await until(draft.id, (x) => x.enrichStatus === "done" || x.enrichStatus === "not_found", "the printed draft");
    assert.equal(s.enrichStatus, "done", s.enrichError);
    assert.equal(s.doi, "10.1186/s40545-021-00329-4");
    assert.equal(s.identifiedBy, "title");
    assert.equal(s.title, "Big data, medicines safety and pharmacovigilance");

    // Older PDFs: in the library with metadata of their own (as from Zotero), so not looked up
    // on arrival; the background pass looks them up once nothing else waits.
    const printPdf = async (file, title, byline) => {
      const data = await app.evaluate(async ({ BrowserWindow }, { title, byline }) => {
        const w = new BrowserWindow({ show: false });
        const html = `<html><head><title>draft</title></head><body style="font-family: Georgia; margin: 60px">
          <h1 style="font-size: 30px; font-weight: 600">${title}</h1><p style="font-size: 12px">${byline}</p>
          <p style="font-size: 12px">An observational account of the matter, written for this check.</p></body></html>`;
        await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const pdf = await w.webContents.printToPDF({});
        w.destroy();
        return pdf.toString("base64");
      }, { title, byline });
      await writeFile(file, Buffer.from(data, "base64"));
      return file;
    };
    const olderBigData = await call("store_create", {
      source: {
        kind: "pdf", title: "Hussain commentary (Zotero)", year: 2021, creators: [{ family: "Hussain", given: "Rabia" }],
        filePath: await printPdf(path.join(temp, "older-big-data.pdf"), "Big data, medicines safety and pharmacovigilance", "Rabia Hussain, 2021"),
      },
    });
    // Only Crossref knows this one: its DOI is attached.
    const olderCrossref = await call("store_create", {
      source: {
        kind: "pdf", title: "Wandering study", year: 2020, creators: [{ family: "Nickels" }],
        filePath: await printPdf(path.join(temp, "older-wandering.pdf"), "Night-time wandering in memory care units: a observational cohort", "Shirley Nickels, 2020"),
      },
    });
    // The pass is counted in the status and follows the indexing pause.
    let status;
    for (let i = 0; i < 240; i++) {
      status = await call("store_status");
      if (status.backfill && status.backfill.identify + status.backfill.lookup > 0) break;
      await page.waitForTimeout(250);
    }
    assert.ok(status.backfill.identify + status.backfill.lookup > 0, "the status counts the background pass");
    await call("store_index_control", { action: "pause" });
    // The status bar's work item says so, and its panel (a popover above it) names the pass.
    const work = page.getByRole("contentinfo", { name: "Status" }).locator('[data-status-item="work"]');
    await work.waitFor({ timeout: 8000 });
    await work.click();
    await page.locator(".kx-status-popover .kx-activity-backfill").waitFor({ timeout: 6000 });
    await page.screenshot({ path: path.join(temp, "backfill.png") });
    await work.click();
    await page.locator(".kx-status-popover").waitFor({ state: "detached" });
    await call("store_index_control", { action: "resume" });
    s = await until(olderBigData.id, (x) => x.enrichStatus === "done", "the older PDF looked up in the background");
    assert.equal(s.doi, "10.1186/s40545-021-00329-4");
    assert.equal(s.title, "Hussain commentary (Zotero)", "the user's title stays");
    assert.equal(s.creators.length, 1, "the user's authors stay");
    s = await until(olderCrossref.id, (x) => !!x.doi, "the older PDF matched in Crossref");
    assert.equal(s.doi, "10.5555/key-smoke-wandering");
    assert.equal(s.identifiedBy, "crossref");
    s = await until(olderCrossref.id, (x) => x.enrichStatus === "not_found", "the Crossref-only work settling");
    let settled;
    for (let i = 0; i < 240; i++) {
      settled = (await call("store_status")).backfill;
      if (settled.identify + settled.lookup === 0) break;
      await page.waitForTimeout(250);
    }
    assert.deepEqual(settled, { identify: 0, lookup: 0 }, "the pass ends; nothing is retried");

    // No DOI of a cited work, no title anyone else wrote.
    s = await until(synthetic.id, (x) => ["not_found", "done", "failed"].includes(x.enrichStatus) || x.indexStatus === "ready", "the synthetic paper");
    s = await until(synthetic.id, (x) => x.enrichStatus !== "pending" && x.indexStatus !== "pending" && x.indexStatus !== "indexing", "the synthetic paper settling");
    assert.equal(s.doi, undefined);
    assert.equal(s.openalexId, undefined);
    assert.equal(s.title, "scientific unlinked");

    // The library's list follows the background lookups.
    await page.locator(".kx-row", { hasText: "Big data, medicines safety and pharmacovigilance" }).first().waitFor({ timeout: 12000 });
    await page.locator(".kx-row", { hasText: "Deep learning of HIV field-based rapid tests" }).first().waitFor({ timeout: 12000 });

    // Fields edited by hand survive a new lookup; "Update metadata…" lists them unticked.
    await call("store_update", { id: jama.id, patch: { title: "My own JAMA title", volume: "" }, byHand: true });
    await call("store_enrich", { ids: [jama.id] });
    s = await until(jama.id, (x) => x.enrichStatus === "done", "the second lookup");
    assert.equal(s.title, "My own JAMA title");
    assert.equal(s.volume, undefined);
    assert.ok(s.editedFields.includes("title"));
    const proposal = (await call("store_refresh_metadata", { ids: [jama.id] }))[0];
    const titleChange = proposal.changes.find((c) => c.field === "title");
    assert.ok(titleChange && titleChange.edited && !titleChange.selected, "a hand-edited title is proposed, not ticked");

    // The source page says how it was identified.
    await page.evaluate(({ workspaceId, sourceId }) => window.key.tabAction("open-source-page", { workspaceId, sourceId, title: "JAMA", read: false }), { workspaceId: ws.id, sourceId: jama.id });
    const sourcePage = page.locator(".kx-source-page[data-side=false]");
    await sourcePage.locator(".kx-page-details-toggle").click();
    await sourcePage.locator('.kx-research-row[data-research="OpenAlex"]', { hasText: "Identified via DOI" }).waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(temp, "identified.png") });
    await page.evaluate(({ workspaceId, sourceId }) => window.key.tabAction("open-source-page", { workspaceId, sourceId, title: "Draft", read: false }), { workspaceId: ws.id, sourceId: draft.id });
    await sourcePage.locator('.kx-research-row[data-research="OpenAlex"]', { hasText: "Matched by title" }).waitFor();
    await page.screenshot({ path: path.join(temp, "matched.png") });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, addFile: true, drop: true, download: true, joined: true, title: true, references: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    server.close();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
