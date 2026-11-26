// Duplicates, merging, metadata updates and retractions against recorded OpenAlex and
// Crossref answers (KEY_OPENALEX_FIXTURES, written to a temp folder):
//  - the Duplicates view lists a likely pair, an exact pair and a preprint/published pair;
//  - reviewing the likely pair and merging keeps the other's fields and tags, its id resolves
//    to the kept one, ⌘Z brings it back and ⇧⌘Z merges again;
//  - "Merge all exact duplicates…" asks first, then merges the exact pair;
//  - the preprint and published version are linked as versions;
//  - a retraction check flags a work: "Retracted" tab, row badge, status-bar notice, the
//    banner with the notice link on its page, and Dismiss;
//  - "Update metadata…" shows old → new per field and applies the ticked ones.
// Screenshots light and dark go to the printed temp folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

async function fixtures(dir) {
  await mkdir(dir, { recursive: true });
  const work = (id, doi, title, extra) => ({ id: `https://openalex.org/${id}`, doi: `https://doi.org/${doi}`, display_name: title, publication_year: 2006, is_retracted: false, ...extra });
  await writeFile(
    path.join(dir, "W901.json"),
    JSON.stringify(
      work("W901", "10.5555/pt.2006", "Poverty traps and growth", {
        biblio: { volume: "21", issue: "2", first_page: "5", last_page: "30" },
        primary_location: { source: { display_name: "Journal of Growth" } },
        authorships: [{ author: { display_name: "Costas Azariadis" } }],
      }),
    ),
  );
  await writeFile(path.join(dir, "W902.json"), JSON.stringify(work("W902", "10.5555/retracted.2010", "A retracted study of vaccines", { publication_year: 2010, is_retracted: true })));
  await writeFile(
    path.join(dir, "crossref-updates.json"),
    JSON.stringify({
      message: { items: [{ DOI: "10.5555/notice.2012", "update-to": [{ DOI: "10.5555/retracted.2010", type: "retraction", source: "retraction-watch", updated: { "date-time": "2012-05-01T00:00:00Z" } }] }] },
    }),
  );
  await writeFile(path.join(dir, "crossref-works.json"), JSON.stringify({ message: { items: [] } }));
}

// Elements inside `root` that scroll (or would clip) sideways: scrollWidth > clientWidth.
async function sideways(page, selector, skip = "") {
  return page.evaluate(([selector, skip]) => {
    const out = [];
    for (const root of document.querySelectorAll(selector)) {
      for (const el of [root, ...root.querySelectorAll("*")]) {
        const style = getComputedStyle(el);
        if (!["auto", "scroll"].includes(style.overflowX) && el !== root) continue;
        if (skip && el.matches(skip)) continue;
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
      }
    }
    const doc = document.scrollingElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push(`document ${doc.scrollWidth}>${doc.clientWidth}`);
    return out;
  }, [selector, skip]);
}
const SIZES = [
  [1440, 900],
  [1200, 800],
];

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-duplicates-"));
  await fixtures(path.join(temp, "openalex"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      // Lookups only when asked, so "Update metadata…" has something to show.
      KEY_OPENALEX_ENABLED: "0",
      KEY_OPENALEX_FIXTURES: path.join(temp, "openalex"),
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  const report = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    await page.evaluate(() => window.key.setAppSettings({ openalex: false }));
    await page.waitForTimeout(300);
    const add = async (fields) => (await call("store_create", { source: { kind: "reference", itemType: "article", ...fields } })).id;
    const azariadis = [{ family: "Azariadis", given: "Costas", role: "author" }];
    const a = await add({ title: "Poverty traps and growth", year: 2006, doi: "10.5555/pt.2006", creators: azariadis, tags: ["growth"] });
    const b = await add({ title: "Poverty Traps and Growth.", year: 2006, creators: azariadis, volume: "12", pages: "1–20", tags: ["traps"] });
    const d = await add({ title: "Microfinance at scale", year: 2012, pmid: "12345", creators: [{ family: "Banerjee", role: "author" }] });
    const e = await add({ title: "Microfinance at scale (accepted manuscript)", pmid: "PMID: 12345", tags: ["rct"] });
    const g = await add({ title: "Attention is all you need", year: 2017, arxivId: "1706.03762v5", itemType: "preprint", creators: [{ family: "Vaswani", role: "author" }] });
    const h = await add({ title: "Attention Is All You Need", year: 2017, doi: "10.5555/attn.2017", containerTitle: "Advances in Neural Information Processing Systems", creators: [{ family: "Vaswani", role: "author" }] });
    const f = await add({ title: "A retracted study of vaccines", year: 2010, doi: "10.5555/retracted.2010" });

    // Fill the other views so the library shows most of its tabs.
    await call("store_update", { id: g, patch: { starred: true } }).catch(() => {});
    await call("store_set_reading_status", { ids: [h], status: "reading" }).catch(() => {});
    await call("store_reading_event", { id: d, kind: "open", page: 1, pageCount: 10 }).catch(() => {});
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    // The background count shows a Duplicates tab and a quiet status-bar item.
    const tabs = page.locator(".kx-scope-tabs");
    await tabs.getByRole("tab", { name: /Duplicates/ }).waitFor({ timeout: 40000 });
    await page.locator(".kx-status-bar, [role=contentinfo]").getByText(/possible duplicates/).first().waitFor();
    await tabs.getByRole("tab", { name: /Duplicates/ }).click();
    const view = page.getByLabel("Duplicates", { exact: true });
    await view.locator(".kx-dup-group").first().waitFor();
    report.groups = await view.locator(".kx-dup-group").evaluateAll((els) => els.map((el) => el.dataset.kind));
    assert.deepEqual(report.groups, ["exact", "likely", "version"]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "duplicates-light.png") });
    // No sideways scrolling at ordinary window sizes, with the sidebar shown or hidden and
    // with the details panel open.
    const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
    const sidebar = () => page.evaluate(() => document.querySelector(".key-sidebar-toggle")?.click());
    report.overflow = {};
    for (const [w, h] of SIZES) {
      await setSize(w, h);
      for (const variant of ["sidebar", "no-sidebar"]) {
        await page.waitForTimeout(350);
        const over = await sideways(page, ".kx-library-main, .kx-dup-view");
        report.overflow[`${w}x${h} ${variant}`] = over;
        if (over.length) await page.screenshot({ path: path.join(temp, `overflow-${w}-${variant}.png`) });
        await sidebar();
      }
    }
    await setSize(1320, 860);

    // Review the likely pair and merge into the one with the DOI.
    await view.locator('.kx-dup-group[data-kind="likely"]').getByRole("button", { name: "Review…" }).click();
    const sheet = page.locator("div[role=dialog][aria-label=\"Merge sources\"]");
    await sheet.locator(".kx-merge-fields").waitFor();
    await sheet.locator(".kx-merge-card", { hasText: "10.5555" }).or(sheet.locator(".kx-merge-card").first()).first().waitFor();
    const kept = await sheet.locator('.kx-merge-card[aria-pressed="true"] .kx-merge-name').textContent();
    const withDoi = sheet.locator(".kx-merge-card").filter({ has: page.locator(".kx-merge-name", { hasText: /^Poverty traps and growth$/ }) });
    if (kept !== "Poverty traps and growth") await withDoi.click();
    await sheet.locator(".kx-merge-card[aria-pressed=true] .kx-merge-name", { hasText: /^Poverty traps and growth$/ }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "merge-sheet.png") });
    for (const [w, h] of SIZES) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
      await page.waitForTimeout(350);
      report.overflow[`sheet ${w}x${h}`] = await sideways(page, 'div[role=dialog][aria-label="Merge sources"]');
      await page.screenshot({ path: path.join(temp, `merge-sheet-${w}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    await sheet.getByRole("button", { name: "Merge", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    const merged = await call("store_source", { id: b });
    assert.equal(merged.id, a, "the merged-away id resolves to the kept source");
    assert.equal(merged.volume, "12");
    assert.deepEqual(merged.tags, ["growth", "traps"]);
    report.merge = true;

    // ⌘Z brings it back; ⇧⌘Z merges again.
    await page.locator(".kx-library-main .kx-page-title h1").click();
    await page.keyboard.press("Meta+z");
    await page.locator(".kx-toast", { hasText: "Undo: Merge 2 sources" }).waitFor();
    assert.equal((await call("store_source", { id: b })).id, b);
    assert.equal((await call("store_source", { id: a })).volume, undefined);
    await page.keyboard.press("Meta+Shift+z");
    await page.locator(".kx-toast", { hasText: "Redo: Merge 2 sources" }).waitFor();
    assert.equal((await call("store_source", { id: b })).id, a);
    report.undoMerge = true;

    // Merge all exact duplicates, behind a confirmation with the count.
    await view.getByRole("button", { name: "Merge all exact duplicates…" }).click();
    const confirm = page.locator("div[role=dialog][aria-label=\"Merge exact duplicates\"]");
    await confirm.getByRole("button", { name: "Merge 1" }).waitFor();
    await page.screenshot({ path: path.join(temp, "merge-all.png") });
    await confirm.getByRole("button", { name: "Merge 1" }).click();
    await confirm.waitFor({ state: "detached" });
    const microfinance = await call("store_source", { id: e });
    assert.ok([d, e].includes(microfinance.id));
    assert.ok(microfinance.tags.includes("rct"));
    report.mergeAll = true;

    // Link the preprint and its published version.
    await view.locator('.kx-dup-group[data-kind="version"]').getByRole("button", { name: "Link as versions" }).click();
    await page.waitForFunction(async ({ id, g }) => (await window.key.invoke("store_versions", { id: g }, id)).length === 1, { id: ws.id, g });
    assert.equal((await call("store_versions", { id: g }))[0].id, h);
    await view.locator(".kx-merge-empty").waitFor();
    report.versions = true;

    // Retractions: a check flags the work.
    const check = await call("store_retraction_check", { ids: [f, a] });
    assert.deepEqual(check, { checked: 2, flagged: 1 });
    await page.keyboard.press("Escape");
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await tabs.getByRole("tab", { name: /Retracted/ }).waitFor({ timeout: 30000 });
    const notice = page.getByText("1 newly retracted");
    await notice.waitFor({ timeout: 30000 });
    await notice.click();
    await page.getByRole("heading", { name: "Retracted", exact: true }).waitFor();
    const row = page.locator(".kx-row", { hasText: "A retracted study of vaccines" });
    await row.locator(".kx-row-retracted").waitFor();
    await row.click();
    const banner = page.locator(".kx-retracted[role=alert]");
    await banner.waitFor();
    assert.equal(await banner.getByRole("link").getAttribute("href"), "https://doi.org/10.5555/notice.2012");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "retracted.png") });
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await page.waitForFunction(async ({ id, f }) => (await window.key.invoke("store_source", { id: f }, id)).retractionDismissed === 1, { id: ws.id, f });
    assert.equal((await call("store_retractions")).flagged, 0);
    report.retraction = true;

    // Update metadata from the source's menu: old → new per field, applied.
    await page.locator(".kx-scope-tabs").getByRole("tab", { name: /^All/ }).click();
    await page.locator(".kx-row", { hasText: "Poverty traps and growth" }).click();
    // The other views, with the details panel open, fit too.
    for (const [w, h] of SIZES) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
      await page.waitForTimeout(350);
      // A list pane under 640px wide (sidebar and details both open) may scroll its tab bar.
      const narrow = await page.locator(".kx-library-main").evaluate((el) => el.clientWidth < 640);
      report.overflow[`all+details ${w}x${h}`] = await sideways(page, ".kx-library-main", narrow ? ".key-segmented-track" : "");
      await page.screenshot({ path: path.join(temp, `all-details-${w}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    assert.deepEqual(Object.entries(report.overflow).filter(([, v]) => v.length), [], "nothing scrolls sideways");
    await page.locator(".kx-inspector .kx-source-more > summary").click();
    await page.getByRole("button", { name: "Update metadata…" }).click();
    const update = page.locator("div[role=dialog][aria-label=\"Update metadata\"]");
    await update.locator(".kx-metadata-changes").waitFor();
    const fields = await update.locator(".kx-metadata-field").allTextContents();
    report.metadataFields = fields;
    assert.ok(fields.some((t) => t.startsWith("Volume")));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "update-metadata.png") });
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(temp, "update-metadata-dark.png") });
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await page.emulateMedia({ colorScheme: "light" });
    await update.getByRole("button", { name: /^Apply/ }).click();
    await update.waitFor({ state: "detached" });
    const updated = await call("store_source", { id: a });
    assert.equal(updated.volume, "21");
    assert.equal(updated.containerTitle, "Journal of Growth");
    report.metadata = true;

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
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
