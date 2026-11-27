// Add to library from the reader: a cited work's card offers Add to library (Adding… → In
// library, which opens it) and the work lands in the collection of the PDF being read; the
// References tab beside the PDF offers the same per reference, and its loading and empty
// states. OpenAlex lookups by DOI point at a dead port so adding takes the card's own
// metadata (the card's metadata itself comes from the host's scholarly lookups, which reach
// the network). Screenshots land in the temp dir printed at the end (light and dark).
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-reader-add-library-"));
  await mkdir(path.join(temp, "profile"));
  const shots = [];
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_WEB_OPENALEX_URL: "http://127.0.0.1:9",
    },
  });
  const shot = async (page, name) => {
    const file = path.join(temp, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const fixture = path.resolve(__dirname, "../../../../../tests/fixtures", process.env.KEY_SMOKE_PDF || "PUBMED_33599681.pdf");
    const opened = await shell.evaluate(async (input) => {
      const [w] = await window.key.workspaces();
      const info = await window.key.invoke("library_import_file", { path: input }, w.id);
      const collection = await window.key.invoke("store_collection_create", { name: "Thesis" }, w.id);
      const found = await window.key.invoke("store_sources", { ids: [info.hash], limit: 1, scope: "all" }, w.id);
      await window.key.invoke("store_membership", { collectionId: collection.id, ids: [found.items[0].id] }, w.id);
      const source = { ...info, documentHash: info.hash, workspaceId: w.id };
      await window.key.openSource(source);
      return { source, workspaceId: w.id, collectionId: collection.id, sourceId: found.items[0].id };
    }, fixture);
    let pdf;
    for (let i = 0; i < 100 && !pdf; i++) {
      pdf = app.windows().find((p) => p.url().endsWith("/pdf.html"));
      if (!pdf) await new Promise((r) => setTimeout(r, 100));
    }
    if (!pdf) throw Error("PDF view not created");
    pdf.on("pageerror", (e) => console.error("PDF ERROR", e));
    await pdf.getByRole("button", { name: "Zoom in", exact: true }).waitFor({ timeout: 30000 });
    await pdf.waitForFunction(() => document.querySelectorAll("canvas").length > 0, { timeout: 30000 });
    await pdf.waitForTimeout(800);
    const result = {};
    const themes = async (page, name, body) => {
      for (const scheme of ["light", "dark"]) {
        await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
        await pdf.emulateMedia({ colorScheme: scheme });
        await shell.emulateMedia({ colorScheme: scheme });
        await pdf.waitForTimeout(300);
        if (body) await body(scheme);
        await shot(page, `${name}-${scheme}`);
      }
      await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
      await pdf.emulateMedia({ colorScheme: "light" });
      await shell.emulateMedia({ colorScheme: "light" });
    };
    const scrollTo = (top) => pdf.evaluate((top) => document.querySelector(".pdfjs-scroll").scrollTo({ top, behavior: "instant" }), top);
    const card = pdf.locator(".pdfjs-cite-card");
    const hoverCitation = async (id) => {
      const box = await pdf.locator(`.pdfjs-link-overlay.citation[data-id="${id}"]`).first().boundingBox();
      if (!box) return false;
      await pdf.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2 + 2, { steps: 3 });
      await pdf.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
      return true;
    };
    const libraryCount = () =>
      shell.evaluate((w) => window.key.invoke("store_sources", { limit: 200, scope: "all" }, w).then((p) => p.items.length), opened.workspaceId);

    // 1. A single cited work whose card knows the work: Add to library is on it.
    const add = pdf.locator(".pdfjs-cite-card .key-work-add[data-state=absent]");
    let found;
    const height = await pdf.evaluate(() => document.querySelector(".pdfjs-scroll").scrollHeight);
    const seen = new Set();
    for (let top = 0; top < height && !found; top += 500) {
      await scrollTo(top);
      await pdf.waitForTimeout(250);
      const ids = await pdf.evaluate(() =>
        [...document.querySelectorAll(".pdfjs-link-overlay.citation[data-id]")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.top > 90 && r.bottom < innerHeight - 260 && r.width > 2;
          })
          .map((e) => e.dataset.id),
      );
      for (const id of ids) {
        if (seen.has(id) || seen.size > 24) continue;
        seen.add(id);
        await pdf.mouse.move(5, 5);
        await pdf.waitForTimeout(260);
        if (!(await hoverCitation(id))) continue;
        await card.waitFor({ timeout: 2000 }).catch(() => {});
        await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: 20000 }).catch(() => {});
        await pdf.waitForTimeout(200);
        const chips = await pdf.locator(".pdfjs-cite-chips [role=tab]").count();
        if (chips === 0 && (await add.isVisible().catch(() => false))) {
          found = { id, top };
          break;
        }
      }
    }
    if (!found) throw Error("No citation card offered Add to library");
    const show = async () => {
      await scrollTo(found.top);
      await pdf.waitForTimeout(300);
      await pdf.mouse.move(5, 5);
      await pdf.waitForTimeout(300);
      await hoverCitation(found.id);
      await card.waitFor({ timeout: 3000 });
      await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: 20000 }).catch(() => {});
      await pdf.waitForTimeout(250);
    };
    await themes(pdf, "card-add", show);
    await show();
    const title = (await pdf.locator(".pdfjs-cite-card h2").first().innerText()).trim();
    const before = await libraryCount();
    // Clicked: the card stays (pinned) while the work is added.
    const box = await pdf.locator(`.pdfjs-link-overlay.citation[data-id="${found.id}"]`).first().boundingBox();
    await pdf.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await card.waitFor({ timeout: 3000 });
    await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: 20000 }).catch(() => {});
    // Add asks which collections in the window's shared chooser (the PDF's own by default);
    // Cancel leaves the work as it was.
    const chooser = shell.locator(".kx-add-chooser");
    await pdf.locator(".pdfjs-cite-card .key-work-add[data-state=absent]").click();
    await chooser.waitFor({ timeout: 10000 });
    await chooser.getByRole("button", { name: "Cancel" }).click();
    await chooser.waitFor({ state: "detached" });
    if ((await libraryCount()) !== before) throw Error("Cancelling the chooser still added the work");
    // The card closes while the window's chooser is up: pin it again.
    const pinAgain = async () => {
      if (await card.isVisible().catch(() => false)) return;
      await show();
      const again = await pdf.locator(`.pdfjs-link-overlay.citation[data-id="${found.id}"]`).first().boundingBox();
      await pdf.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
      await card.waitFor({ timeout: 3000 });
    };
    await pinAgain();
    await pdf.locator(".pdfjs-cite-card .key-work-add[data-state=absent]").waitFor({ timeout: 5000 });
    await pdf.locator(".pdfjs-cite-card .key-work-add[data-state=absent]").click();
    await chooser.waitFor({ timeout: 10000 });
    const thesis = chooser.locator("label", { hasText: "Thesis" }).locator("input[type=checkbox]");
    if (!(await thesis.isChecked())) throw Error("The chooser does not default to the PDF's collection");
    await shot(shell, "card-chooser-light");
    await chooser.locator(".kx-add-chooser-primary").click();
    for (let i = 0; i < 80 && (await libraryCount()) === before; i++) await pdf.waitForTimeout(250);
    await pinAgain();
    await pdf.locator(".pdfjs-cite-card .key-work-add[data-state=present]").waitFor({ timeout: 20000 });
    await themes(pdf, "card-in-library");
    const after = await libraryCount();
    if (after !== before + 1) throw Error(`Adding did not create one source: ${before} → ${after}`);
    const added = await shell.evaluate(
      ({ w, title }) => window.key.invoke("store_sources", { text: title.slice(0, 120), limit: 8, scope: "all" }, w).then((p) => p.items.map((s) => ({ id: s.id, title: s.title, kind: s.kind, collections: s.collections }))),
      { w: opened.workspaceId, title },
    );
    const work = added.find((s) => s.title === title);
    if (!work) throw Error(`The added work is not in the library: ${title} ${JSON.stringify(added)}`);
    if (!work.collections.includes(opened.collectionId)) throw Error("The added work is not in the reading source's collection");
    result.card = { title, collections: work.collections };

    // 2. The expanded card says In library too; In library opens the source page.
    const details = pdf.locator(".pdfjs-cite-card [aria-label='Show details']");
    if (await details.isVisible().catch(() => false)) {
      await details.click();
      await pdf.locator(".pdfjs-cite-card[data-expanded] .key-work-add[data-state=present]").waitFor({ timeout: 3000 });
      await themes(pdf, "card-expanded-in-library");
    }
    await pdf.locator(".pdfjs-cite-card .key-work-add[data-state=present]").click();
    await shell.waitForFunction((t) => document.body.innerText.includes(t.slice(0, 30)), title, { timeout: 10000 });
    await shot(shell, "opened-source-light");
    result.opened = true;

    // 3. The References tab beside the PDF: each looked-up reference offers Add to library.
    await shell.evaluate((s) => window.key.openSource(s), opened.source);
    await pdf.waitForTimeout(800);
    await pdf.evaluate(() => window.key.readerNotes("references"));
    const panel = shell.locator(".key-reader-panel");
    await panel.waitFor({ timeout: 10000 });
    await shot(shell, "references-early-light");
    // The library looks the references up in the background; give it time.
    const rowAdd = panel.locator(".key-ref-aside .key-work-add[data-state=absent]");
    await rowAdd.first().waitFor({ timeout: Number(process.env.KEY_SMOKE_LOOKUP_MS || 120000) });
    await shell.waitForTimeout(600);
    await themes(shell, "references");
    const inLibraryRows = await panel.locator(".key-ref-aside .key-work-add[data-state=present]").count();
    const rowBefore = await libraryCount();
    await rowAdd.first().click();
    await shell.locator(".kx-add-chooser .kx-add-chooser-primary").click({ timeout: 10000 });
    await panel.locator(".key-ref-aside .key-work-add[data-state=present]").nth(inLibraryRows).waitFor({ timeout: 20000 });
    if ((await libraryCount()) !== rowBefore + 1) throw Error("Adding from the References tab did not create a source");
    await shot(shell, "references-added-light");
    result.references = { inLibraryRows };

    console.log(JSON.stringify({ ok: true, result, temp, shots }, null, 1));
  } catch (error) {
    for (const page of app.windows()) {
      const name = page.url().endsWith("/pdf.html") ? "failure-pdf" : `failure-${app.windows().indexOf(page)}`;
      await page.screenshot({ path: path.join(temp, `${name}.png`) }).catch(() => {});
    }
    console.error("Screenshots in", temp);
    throw error;
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
