// Review records and the library source they are linked to (the same work), kept in step
// (review_commands/library_sync.rs, review-link-sync.tsx). Invented works, no network:
//   - an abstract edited in the library shows at once as "1 field differs" on the open review
//     record; "Take from library" in the comparison sheet updates the record;
//   - a work the library has under a shorter title is suggested ("Possibly in your library"),
//     confirmed side by side, and the review's PDF becomes the library source's file;
//   - the file replaced in the library: the open review reader switches to it, saying so;
//   - a title taken from the review on the source's page is undone by the library's undo, on
//     both sides at once;
//   - a highlight on a full text kept only with the review survives a restart, is listed as
//     "My highlights" and is in the review's export.
const { electron } = require("./lib/launch.cjs");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(200);
  }
}

const WALK = "Walking groups and blood pressure in older adults";
const STRETCH = "Stretching breaks at work: a cluster trial on neck pain";
const YOGA = "Chair yoga for older office workers";
const prose = (topic, n) => Array.from({ length: n }, (_, i) => `${topic} paragraph ${i}: the participants were followed for twelve weeks and their measures compared with care.`).join(" ");
const pdfHtml = (title, extra = "") => `<!doctype html><html><head><title>${title}</title><style>body{font:11pt Times,serif;margin:0} .p{page-break-after:always}</style></head><body>
<div class="p"><h1>${title}</h1><p>Ada Example${extra}</p><p>${prose(title.split(" ")[0], 14)}</p></div><div><h2>Results</h2><p>${prose("Results", 10)}</p></div></body></html>`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-link-"));
  const env = { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") };
  const report = {};
  let app = await electron.launch({ args: [path.resolve(__dirname, "..")], env });
  let shell;
  const errors = [];
  const consoleErrors = [];
  const start = async () => {
    shell = await app.firstWindow();
    shell.setDefaultTimeout(20000);
    shell.on("pageerror", (e) => errors.push(String(e)));
    shell.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
    // A restarted window brings back its tabs (the review), not Home.
    await until(() => shell.evaluate(() => window.key?.workspaces?.().then((w) => w.length > 0)), "the window");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    return ws;
  };
  try {
    let ws = await start();
    const call = (command, args = {}) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const shot = async (name) => {
      await wait(400);
      for (const scheme of ["light", "dark"]) {
        await shell.emulateMedia({ colorScheme: scheme });
        await wait(150);
        await shell.screenshot({ path: path.join(temp, `${name}-${scheme}.png`) });
      }
      await shell.emulateMedia({ colorScheme: "light" });
    };
    const print = (html) =>
      app.evaluate(async ({ BrowserWindow }, html) => {
        const w = new BrowserWindow({ show: false, width: 800, height: 1000 });
        try {
          await w.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`);
          return (await w.webContents.printToPDF({ pageSize: "A4" })).toString("base64");
        } finally {
          w.destroy();
        }
      }, html);
    const files = {};
    for (const [name, html] of [["stretch", pdfHtml(STRETCH)], ["stretch2", pdfHtml(STRETCH, " (corrected version)")], ["yoga", pdfHtml(YOGA)]]) {
      const dir = path.join(temp, `pdf-${name}`);
      await mkdir(dir);
      files[name] = path.join(dir, `${name}.pdf`);
      await writeFile(files[name], Buffer.from(await print(html), "base64"));
    }

    // The library: the walking trial (same DOI), the stretching study under a shorter title.
    const source = (fields) => call("store_create", { source: { kind: "reference", itemType: "journalArticle", indexStatus: "skipped", ...fields } });
    const walk = await source({ title: WALK, doi: "10.5555/walk", date: "2016", containerTitle: "Journal of Examples", abstract: "Walking groups in four towns lowered blood pressure.", creators: [{ family: "Rivera", given: "Ana", role: "author" }] });
    const stretch = await source({ title: "Stretching breaks at work", date: "2019", creators: [{ family: "Okafor", given: "Ben", role: "author" }] });
    // The review: three records, all through title and abstract.
    const reviewId = (await call("review_create", { name: "Movement review (smoke)", ownerName: "Ana Example" })).reviewId;
    const ana = (await call("review_get", { reviewId, viewer: "" })).team[0].id;
    await shell.evaluate((id) => localStorage.setItem(`key.review.viewer:${id.r}`, id.a), { r: reviewId, a: ana });
    await call("review_import_records", {
      reviewId,
      records: [
        { title: WALK, authors: ["Rivera, Ana"], year: 2016, doi: "10.5555/walk", journal: "Journal of Examples", abstractText: "Walking groups in four towns lowered blood pressure.", itemType: "journalArticle" },
        { title: STRETCH, authors: ["Okafor, Ben"], year: 2019, abstractText: "Office workers took stretching breaks.", itemType: "journalArticle" },
        { title: YOGA, authors: ["Moreau, Eli"], year: 2020, abstractText: "Chair yoga in offices.", itemType: "journalArticle" },
      ],
      batch: { group: "databases", name: "Mock" },
      actor: ana,
    });
    const all = (await call("review_records", { reviewId, viewer: ana, query: { stage: "ta", filter: "all", text: "" } })).rows;
    const idOf = (re) => all.find((r) => re.test(r.title)).id;
    await call("review_decide", { reviewId, recordIds: all.map((r) => r.id), stage: "ta", value: "include", reasons: [], note: "", actor: ana });
    // The walking trial is the library's (same DOI): linked. The others keep files of their own.
    await call("review_link_confirm", { reviewId, recordId: idOf(/Walking/), sourceId: walk.id, actor: ana });
    await call("review_fulltext_attach", { reviewId, recordId: idOf(/Stretching/), path: files.stretch, name: "stretch.pdf", origin: "upload", ownedTemp: false, actor: ana });
    await call("review_fulltext_attach", { reviewId, recordId: idOf(/yoga/), path: files.yoga, name: "yoga.pdf", origin: "upload", ownedTemp: false, actor: ana });

    await shell.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Movement review (smoke)" }), { ws: ws.id, id: reviewId });
    await shell.getByRole("heading", { name: "Movement review (smoke)" }).waitFor();
    await shell.getByRole("tab", { name: /Sources/ }).click();
    await shell.getByRole("radio", { name: /^Records/ }).click();
    await shell.locator(".kx-rv-record-row .kx-rv-list-main", { hasText: WALK }).click();
    const panel = shell.locator(".kx-rv-record-panel");
    await panel.locator("[data-linked]").waitFor();
    const first = await call("review_link_diff", { reviewId, recordId: idOf(/Walking/) });
    assert.equal(first.diff.pending, 0, `nothing differs yet: ${JSON.stringify(first.diff.fields)}`);

    // 1. The abstract edited in the library: the open record shows the difference at once.
    await call("store_update", { id: walk.id, patch: { abstract: "Walking groups in five towns lowered blood pressure." }, byHand: true });
    const chip = panel.locator(".kx-link-diff-chip");
    await chip.waitFor({ timeout: 15000 });
    assert.match(await chip.innerText(), /1 field differs/);
    await shell.locator(".kx-rv-record-row [data-differ]", { hasText: "1 field differs" }).waitFor();
    await shot("record-differs");
    await chip.click();
    const sheet = shell.locator("[data-link-diff]");
    await sheet.locator(".kx-link-diff-row[data-field=abstractText]").waitFor();
    await shot("diff-sheet");
    await sheet.locator(".kx-link-diff-row[data-field=abstractText]").getByRole("radio", { name: "Library" }).click();
    await sheet.getByRole("button", { name: "Apply" }).click();
    await sheet.waitFor({ state: "detached" });
    await until(async () => (await call("review_record", { reviewId, recordId: idOf(/Walking/), viewer: ana, stage: "ta" })).meta.abstractText.includes("five towns"), "the library's abstract in the record");
    await chip.waitFor({ state: "detached" });
    report.abstractFollowed = true;

    // 2. The stretching study: possibly in the library (a shorter title), confirmed.
    const possible = shell.locator("[data-possible-chip]");
    await possible.waitFor();
    assert.match(await possible.innerText(), /Possibly in your library \(1\)/);
    await shot("possible-chip");
    await possible.click();
    const matches = shell.locator("[data-possible-matches]");
    await matches.locator(".kx-rv-pair", { hasText: "Stretching breaks at work" }).waitFor();
    await shot("possible-match");
    await matches.getByRole("button", { name: "Same work — link" }).click();
    await matches.getByText("No more possible matches.").waitFor();
    await matches.getByRole("button", { name: "Done" }).click();
    const shared = await until(async () => (await call("store_source", { id: stretch.id }))?.filePath, "the review's PDF as the library source's file");
    assert.ok(shared);
    const stretchRow = (await call("review_fulltexts", { reviewId })).rows.find((r) => r.id === idOf(/Stretching/));
    assert.equal(stretchRow.file, null, "one file, the library's");
    report.matchConfirmed = true;

    // 3. The file replaced in the library: the open review reader follows it.
    await shell.getByRole("tab", { name: /Full text/ }).click();
    await shell.getByRole("radio", { name: /Full texts/ }).click();
    await shell.getByRole("radio", { name: "All at full text" }).click().catch(() => {});
    await shell.locator(".kx-rv-fulltext-table button", { hasText: STRETCH }).click();
    await shell.locator(".kx-rv-compact .kx-rv-record-title", { hasText: STRETCH }).waitFor();
    await shell.locator(".kx-rv-reader[data-kind=pdf]").waitFor({ timeout: 40000 });
    const before = (await call("review_fulltext_info", { reviewId, recordId: idOf(/Stretching/) })).hash;
    await call("store_attach_file", { id: stretch.id, path: files.stretch2 });
    const notice = shell.locator("[data-reader-notice]");
    await notice.waitFor({ timeout: 20000 });
    assert.match(await notice.innerText(), /replaced/);
    await shell.locator(".kx-rv-reader[data-kind=pdf]").waitFor({ timeout: 40000 });
    const after = (await call("review_fulltext_info", { reviewId, recordId: idOf(/Stretching/) })).hash;
    assert.notEqual(before, after);
    await shot("reader-replaced");
    report.readerFollowed = true;

    // 4. On the source's page: the title taken from the review; the library's undo, both sides.
    await call("store_update", { id: walk.id, patch: { title: "Walking groups and blood pressure" } });
    await shell.evaluate(({ ws, id }) => window.key.tabAction("open-source-page", { workspaceId: ws, sourceId: id }), { ws: ws.id, id: walk.id });
    const libChip = shell.locator(".kx-review-link-item .kx-link-diff-chip");
    await libChip.waitFor();
    await shot("source-page-differs");
    await libChip.click();
    const libSheet = shell.locator("[data-link-diff]");
    await libSheet.locator(".kx-link-diff-row[data-field=title]").getByRole("radio", { name: "Review" }).click();
    await libSheet.getByRole("button", { name: "Apply" }).click();
    await libSheet.waitFor({ state: "detached" });
    await until(async () => (await call("store_source", { id: walk.id }))?.title === WALK, "the review's title in the library");
    const pending = async () => (await call("review_link_diff", { reviewId, recordId: idOf(/Walking/) })).diff.pending;
    assert.equal(await pending(), 0);
    await call("store_undo", {});
    assert.equal((await call("store_source", { id: walk.id })).title, "Walking groups and blood pressure");
    assert.equal(await pending(), 1, "the review's remembered choice went back too");
    await call("store_redo", {});
    assert.equal((await call("store_source", { id: walk.id })).title, WALK);
    assert.equal(await pending(), 0);
    report.libraryUndo = true;

    // 5. A highlight on the yoga PDF, kept only with the review (as its reader saves it).
    const highlight = { id: "smoke-h1", documentId: "yoga", text: "Chair yoga for older office workers", color: "yellow", comment: "Main question", range: { start: { page: 0, index: 0 }, end: { page: 0, index: 35 } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await call("review_highlights_apply", { reviewId, recordId: idOf(/yoga/), upserts: [highlight], deleted: [], actor: ana });
    await app.close();
    app = await electron.launch({ args: [path.resolve(__dirname, "..")], env });
    ws = await start();
    const kept = await call("review_highlights", { reviewId, recordId: idOf(/yoga/) });
    assert.equal(kept.length, 1);
    assert.equal(kept[0].comment, "Main question");
    const csv = (await call("review_export", { reviewId, kind: "highlights", viewer: ana })).content;
    assert.match(csv, /Chair yoga for older office workers,Main question/);
    const file = (await call("review_export", { reviewId, kind: "review", viewer: ana })).content;
    assert.ok(file.includes('"highlight.set"'), "in the review file's events");
    await shell.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Movement review (smoke)" }), { ws: ws.id, id: reviewId });
    await shell.getByRole("heading", { name: "Movement review (smoke)" }).waitFor();
    await shell.getByRole("tab", { name: /Full text/ }).click();
    await shell.getByRole("radio", { name: /Full texts/ }).click();
    await shell.getByRole("radio", { name: "All at full text" }).click().catch(() => {});
    await shell.locator(".kx-rv-fulltext-table button", { hasText: YOGA }).click();
    await shell.locator(".kx-rv-reader[data-kind=pdf]").waitFor({ timeout: 40000 });
    await shell.locator("[data-my-highlights]", { hasText: "Main question" }).waitFor({ timeout: 30000 });
    await shot("my-highlights");
    report.highlightKept = true;

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
  } catch (e) {
    console.error("CONSOLE", JSON.stringify(consoleErrors.slice(-8)), JSON.stringify(errors.slice(-4)));
    await shell?.screenshot({ path: path.join(temp, "failure-shell.png") }).catch(() => {});
    console.error("Artifacts", temp, JSON.stringify(report));
    throw e;
  } finally {
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
