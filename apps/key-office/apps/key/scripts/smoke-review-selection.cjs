// The review's selection menu in the full text (hidden test mode). Full-text screening: a passage
// selected in the PDF opens the criteria; `3` marks criterion 3 not met (the chip in the sidebar,
// the mark in the page), a click on the mark opens it again, ⌘Z takes it back, reading mode marks
// one too, then `2` and Enter exclude and go on. A saved page's passage does the same. Extraction:
// with a numeric field focused, "12.3 (4.5)" and Enter fill the mean and the SD with their source,
// focus moves on, the source chip brings the passage back, and a field's pick takes the next
// selection without a menu. At 300, 380 and 520 px reader widths no two controls of the menu
// overlap and none is clipped. Screenshots (light and dark) go to the printed temp folder.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

/** A one-page PDF with these lines of text (Helvetica). */
function pdfWith(lines) {
  const text = lines.map((l, i) => `BT /F1 13 Tf 72 ${720 - i * 22} Td (${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** In the page: the menu's controls, none overlapping another, none clipped by the menu or cut short. */
const menuGeometry = () => {
  const menu = document.querySelector(".ksm");
  if (!menu) return { error: "no menu" };
  const m = menu.getBoundingClientRect();
  const reader = document.querySelector(".kx-rv-reader")?.getBoundingClientRect();
  const boxes = [...menu.querySelectorAll("button, input, .ksm-row-label, .ksm-row-detail")]
    .filter((el) => el.getClientRects().length && !el.closest("[hidden]"))
    .map((el) => ({ el, r: el.getBoundingClientRect(), name: (el.getAttribute("aria-label") || el.textContent || el.className).trim().slice(0, 40) }));
  const problems = [];
  const controls = boxes.filter((b) => b.el.matches("button, input"));
  for (let i = 0; i < controls.length; i++) {
    const a = controls[i];
    for (let j = i + 1; j < controls.length; j++) {
      const b = controls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const overlap = a.r.left + 0.5 < b.r.right && b.r.left + 0.5 < a.r.right && a.r.top + 0.5 < b.r.bottom && b.r.top + 0.5 < a.r.bottom;
      if (overlap) problems.push(`overlap: ${a.name} / ${b.name}`);
    }
  }
  const list = menu.querySelector(".ksm-list");
  const l = list?.getBoundingClientRect();
  for (const b of boxes) {
    // Inside the menu across; down, inside the menu or its scrolling list.
    if (b.r.left < m.left - 0.5 || b.r.right > m.right + 0.5) problems.push(`clipped across: ${b.name}`);
    const scrolled = l && list.contains(b.el);
    if (!scrolled && (b.r.top < m.top - 0.5 || b.r.bottom > m.bottom + 0.5)) problems.push(`clipped down: ${b.name}`);
    if (b.el.matches(".ksm-row-label, .ksm-pill, .ksm-chip > span") && b.el.scrollWidth > b.el.clientWidth + 1) problems.push(`cut short: ${b.name}`);
  }
  if (reader && (m.left < reader.left - 0.5 || m.right > reader.right + 0.5)) problems.push(`menu outside the reader: ${JSON.stringify([m.left, m.right, reader.left, reader.right])}`);
  if (m.right > innerWidth || m.bottom > innerHeight || m.left < 0 || m.top < 0) problems.push("menu off screen");
  return { problems, controls: controls.length, width: Math.round(m.width), mode: menu.getAttribute("data-mode") };
};

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-selection-"));
  const pilatesPdf = path.join(temp, "silva-2020.pdf");
  await writeFile(pilatesPdf, pdfWith(["Pilates versus usual care for neck pain: a randomised trial", "Participants were adolescents aged 12 to 16 at one school.", "Pupils were allocated by class, not at random.", "Neck pain was measured at twelve weeks."]));
  const yogaPdf = path.join(temp, "moreau-2018.pdf");
  await writeFile(yogaPdf, pdfWith(["Yoga for chronic low back pain: a randomised trial", "Participants were recruited in Norway from four clinics.", "Pain at baseline, mean (SD):", "12.3 (4.5)", "Randomised:", "n = 120", "Recruitment ran from March 2015 to June 2016.", "This was a cluster-randomised trial."]));
  const taichiHtml = path.join(temp, "taichi.html");
  await writeFile(taichiHtml, "<!doctype html><html><head><meta charset=utf-8><title>Tai chi</title></head><body style='font:16px Georgia;padding:24px'><h1>Tai chi and balance in older people</h1><p>Residents of two care homes took part.</p><p>Participants were children in a school sports club.</p></body></html>");
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  const shot = async (page, name) => {
    await page.waitForTimeout(300);
    for (const notice of await page.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.screenshot({ path: path.join(temp, `${name}.png`) });
  };
  const themed = async (page, name) => {
    await shot(page, name);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, `${name}-dark`);
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const until = async (check, what, tries = 300) => {
      for (let i = 0; i < tries; i++) {
        const v = await check();
        if (v) return v;
        await page.waitForTimeout(200);
      }
      throw Error(`Timed out waiting for ${what}`);
    };

    // A review with three full-text criteria (the first not met excludes) and a form with a
    // mean, its SD and a count; three records past title and abstract.
    const { reviewId } = await call("review_create", { name: "Selection (smoke)", ownerName: "Ana Example" });
    let s = await call("review_get", { reviewId, viewer: "" });
    const me = s.team[0].id;
    const protocol = s.protocol;
    protocol.criteria = [
      { id: "c-design", element: "design", label: "Randomised controlled trial", reason: "Wrong study design", guidance: "", stages: ["ft"] },
      { id: "c-population", element: "population", label: "Adults aged 18 or over", reason: "Wrong population", guidance: "", stages: ["ft"] },
      { id: "c-setting", element: "other", label: "Community or clinic setting", reason: "Wrong setting", guidance: "", stages: ["ft"] },
    ];
    protocol.rules.ft.reasons = "first";
    const num = (id, label) => ({ id, label, kind: "number", guidance: "", required: false, quote: false, options: [], unit: "", columns: [], role: "", source: "encouraged" });
    protocol.forms = [
      {
        id: "f-pain",
        name: "Pain",
        kind: "custom",
        sections: [{ id: "s-pain", title: "Pain at baseline", guidance: "", fields: [num("mean_pain", "Mean pain score"), num("sd_pain", "SD pain score"), num("n_total", "Participants randomised"), { ...num("country", "Country"), kind: "text" }] },
          { id: "s-design", title: "Design", guidance: "", fields: [{ ...num("start", "Start of recruitment"), kind: "date" }, { ...num("end", "End of recruitment"), kind: "date" }, { ...num("design", "Design"), kind: "choice", options: ["Randomised controlled trial", "Cluster randomised trial", "Cohort study"] }] },
        ],
      },
    ];
    await call("review_protocol_save", { reviewId, protocol, note: "", actor: me, rescreen: false });
    const titles = ["Pilates versus usual care for neck pain", "Yoga for chronic low back pain", "Tai chi and balance in older people"];
    await call("review_import_records", { reviewId, records: titles.map((title, i) => ({ title, authors: [`Author${i}, A.`], year: 2018 + i, abstractText: "Invented." })), batch: { group: "databases", name: "PubMed" }, actor: me });
    const rows = (await call("review_records", { reviewId, viewer: me, query: { stage: "ta", filter: "all", text: "" } })).rows;
    const idOf = (re) => rows.find((r) => re.test(r.title)).id;
    await call("review_decide", { reviewId, recordIds: rows.map((r) => r.id), stage: "ta", value: "include", reasons: [], note: "", actor: me });
    // Pilates' PDF is a library source (reading mode reads its structure); Yoga's PDF and Tai chi's
    // saved page are kept with the review.
    const pilates = await call("library_import_file", { path: pilatesPdf });
    await call("review_fulltext", { reviewId, recordId: idOf(/Pilates/), status: "retrieved", sourceId: pilates.id, actor: me });
    await call("review_fulltext_attach", { reviewId, recordId: idOf(/Yoga/), path: yogaPdf, name: "moreau-2018.pdf", origin: "smoke", actor: me });
    await call("review_fulltext_attach", { reviewId, recordId: idOf(/Tai chi/), path: taichiHtml, name: "taichi.html", origin: "smoke", actor: me });
    const reflow = await until(async () => {
      const r = await call("store_reflow_document", { hash: pilates.hash }).catch(() => null);
      return r?.status === "ready" ? r : null;
    }, "the Pilates PDF's structure").catch(() => null);
    report.readingModeReady = !!reflow;

    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Selection (smoke)" }), { ws: ws.id, id: reviewId });
    await page.getByRole("heading", { name: "Selection (smoke)" }).waitFor();
    await page.getByRole("tab", { name: /Full text/ }).click();
    await page.getByRole("radio", { name: "Screen" }).click();
    await page.locator(".kx-rv-compact .kx-rv-record-title").waitFor();

    const selectSpan = async (text) => {
      const span = page.locator(".kx-rv-reader .pdfjs-text-layer span", { hasText: text }).first();
      await span.waitFor();
      await span.scrollIntoViewIfNeeded();
      const box = await span.boundingBox();
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    const geometry = async (what) => {
      const g = await page.evaluate(menuGeometry);
      assert(!g.error, `${what}: ${g.error}`);
      assert.deepEqual(g.problems, [], `${what}: ${g.problems.join("; ")}`);
      return g;
    };
    const chip = (criterion, kind) => page.locator(`[data-criterion="${criterion}"] .kx-rv-evidence-chip[data-kind="${kind}"]`);
    const titleNow = () => page.locator(".kx-rv-compact .kx-rv-record-title").textContent();

    for (let i = 0; i < 4 && !(await page.locator(".kx-rv-done").count()); i++) {
      const title = await titleNow();
      if (/Pilates/.test(title)) {
        // The menu fits beside the sidebar at narrow reader widths, light and dark.
        report.widths = {};
        for (const w of [300, 380, 520]) {
          await page.evaluate((w) => (document.querySelector(".kx-rv-single").style.gridTemplateColumns = `${w}px minmax(0, 340px)`), w);
          await page.waitForTimeout(500);
          await selectSpan("adolescents");
          await page.locator(".ksm[data-mode=screen]").waitFor();
          report.widths[w] = await geometry(`reader ${w}px`);
          if (w === 380) await themed(page, `01-screen-menu-${w}`);
          await page.keyboard.press("Escape");
          await page.locator(".ksm").waitFor({ state: "detached" });
        }
        await page.evaluate(() => (document.querySelector(".kx-rv-single").style.gridTemplateColumns = ""));
        await page.waitForTimeout(500);
        // `3`: criterion 3 not met — evidence chip, mark in the page, the follow-up.
        await selectSpan("adolescents");
        await page.locator(".ksm[data-mode=screen]").waitFor();
        await themed(page, "02-screen-menu");
        await page.keyboard.press("3");
        await chip("c-setting", "notMet").waitFor();
        await page.locator(".kx-rv-reader .pdfjs-host-mark.tone-notMet").first().waitFor();
        await page.locator(".ksm[data-mode=follow]").getByRole("button", { name: /Exclude and go to next/ }).waitFor();
        await geometry("the follow-up");
        await themed(page, "03-screen-marked");
        await page.keyboard.press("Escape");
        await page.locator(".ksm").waitFor({ state: "detached" });
        // A click on the mark opens the same menu for it.
        const mark = await page.locator(".kx-rv-reader .pdfjs-host-mark.tone-notMet").first().boundingBox();
        await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
        await page.locator(".ksm[data-mode=screen-mark]").waitFor();
        await page.locator(".ksm").getByRole("menuitem", { name: /Remove this mark/ }).waitFor();
        await geometry("a mark's menu");
        await themed(page, "04-screen-mark-menu");
        await page.keyboard.press("Escape");
        await page.locator(".ksm").waitFor({ state: "detached" });
        // ⌘Z takes the mark back.
        await page.locator(".kx-rv-decide-head").click();
        await page.keyboard.press("Meta+z");
        await chip("c-setting", "notMet").waitFor({ state: "detached" });
        await page.locator(".kx-rv-reader .pdfjs-host-mark").first().waitFor({ state: "detached" });
        // Reading mode: the same menu over the reflowed text; the mark is placed in the PDF.
        if (report.readingModeReady) {
          await page.getByRole("button", { name: "Reading mode", exact: true }).click();
          await page.locator(".kx-reading-article").waitFor();
          await page.waitForTimeout(400);
          await page.evaluate(() => {
            const host = document.querySelector(".kx-reading-article");
            const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const i = n.data.indexOf("adolescents aged 12 to 16");
              if (i < 0) continue;
              document.getSelection().setBaseAndExtent(n, i, n, i + "adolescents aged 12 to 16".length);
              host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
              return;
            }
            throw Error("no text in reading mode");
          });
          await page.locator(".ksm.kx-reading-selection[data-mode=screen]").waitFor();
          await geometry("reading mode");
          await themed(page, "05-reading-mode-menu");
          await page.keyboard.press("1");
          await chip("c-design", "notMet").waitFor();
          await page.locator(".ksm[data-mode=follow]").waitFor();
          await page.keyboard.press("Escape");
          await until(() => page.evaluate(() => CSS.highlights.has("ksm-notMet")), "the mark in reading mode");
          await themed(page, "06-reading-mode-marked");
          report.readingMode = true;
          await page.getByRole("button", { name: "Reading mode", exact: true }).click();
          await page.locator(".kx-reading").waitFor({ state: "detached" });
        }
        // `2`, then Enter: excluded for criterion 2, on to the next record.
        await selectSpan("adolescents");
        await page.locator(".ksm[data-mode=screen]").waitFor();
        await page.keyboard.press("2");
        await chip("c-population", "notMet").waitFor();
        await page.locator(".kx-rv-reader .pdfjs-host-mark.tone-notMet").first().waitFor();
        await page.locator(".ksm[data-mode=follow]").waitFor();
        await page.keyboard.press("Enter");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-compact .kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), title);
        const v = await call("review_record", { reviewId, recordId: idOf(/Pilates/), stage: "ft", viewer: me });
        assert.equal(v.mine.value, "exclude");
        assert.deepEqual(v.mine.reasons, ["c-population"]);
        const ev = v.mine.evidence.find((e) => e.criterion === "c-population");
        assert(ev && ev.kind === "notMet" && ev.page === 0 && ev.rects.length > 0, `the evidence keeps its place: ${JSON.stringify(v.mine.evidence)}`);
        if (report.readingMode) {
          const fromReading = v.mine.evidence.find((e) => e.criterion === "c-design");
          assert(fromReading && fromReading.page === 0 && fromReading.rects.length > 0, `reading mode's evidence is placed in the PDF: ${JSON.stringify(fromReading)}`);
        }
        report.screening = v.mine.evidence.length;
      } else if (/Tai chi/.test(title)) {
        // A saved page: the same menu; its passage has no page or boxes.
        const frame = page.frameLocator(".kx-rv-reader-page");
        await frame.locator("p", { hasText: "children" }).waitFor();
        await page.waitForTimeout(300);
        await page.locator(".kx-rv-reader-page").evaluate((f) => {
          const doc = f.contentDocument;
          const p = [...doc.querySelectorAll("p")].find((x) => x.textContent.includes("children"));
          doc.getSelection().selectAllChildren(p);
          doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        await page.locator(".ksm[data-mode=screen]").waitFor();
        await geometry("a saved page");
        await shot(page, "07-saved-page-menu");
        await page.keyboard.press("2");
        await chip("c-population", "notMet").waitFor();
        await until(() => page.locator(".kx-rv-reader-page").evaluate((f) => f.contentWindow.CSS.highlights.has("ksm-notMet")), "the mark on the saved page");
        await shot(page, "08-saved-page-marked");
        await page.keyboard.press("Enter");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-compact .kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), title);
        const v = await call("review_record", { reviewId, recordId: idOf(/Tai chi/), stage: "ft", viewer: me });
        assert.equal(v.mine.value, "exclude");
        assert.equal(v.mine.evidence[0].page, -1);
        report.savedPage = true;
      } else {
        await page.locator(".kx-rv-decide-head").click();
        await page.keyboard.press("i");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-compact .kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), title);
      }
    }
    await page.locator(".kx-rv-done").waitFor();

    // Extraction: focus the mean, select "12.3 (4.5)", Enter: mean and SD with their source.
    await page.getByRole("tab", { name: /Extraction/ }).click();
    await page.locator(".kx-rv-xform").first().waitFor();
    await page.locator(".kx-rv-reader .pdfjs-text-layer span", { hasText: "Norway" }).first().waitFor();
    await page.locator('.kx-rv-xfield[data-field="mean_pain"] input').click();
    await selectSpan("12.3 (4.5)");
    await page.locator(".ksm[data-mode=extract] .ksm-row").first().waitFor();
    const first = page.locator(".ksm[data-mode=extract] .ksm-row").first();
    assert.match(await first.textContent(), /Mean pain score/);
    assert.match(await first.textContent(), /12\.3/);
    assert.match(await first.textContent(), /SD pain score 4\.5/);
    const noModal = async (what) => assert.equal(await page.locator(".kx-rv-dialog, .key-global-drawer.key-modal, [role=dialog][aria-modal=true]").count(), 0, `no dialog: ${what}`);
    await noModal("the extraction menu");
    await geometry("extraction");
    await themed(page, "09-extract-menu");
    await page.keyboard.press("Enter");
    await page.locator('.kx-rv-xfield[data-field="sd_pain"] .kx-rv-source-chip[data-placed]').waitFor();
    const yogaId = idOf(/Yoga/);
    const xv = await call("review_extraction", { reviewId, recordId: yogaId, viewer: me });
    const mean = xv.values["f-pain/mean_pain"].mine;
    const sd = xv.values["f-pain/sd_pain"].mine;
    assert.equal(mean.value, 12.3);
    assert.equal(sd.value, 4.5);
    assert(mean.sourcePos?.page === 0 && mean.sourcePos.rects.length > 0 && mean.sourcePos.text === "12.3 (4.5)", JSON.stringify(mean));
    assert.deepEqual(sd.sourcePos, mean.sourcePos);
    // Focus went on to the next empty field.
    await until(() => page.evaluate(() => document.activeElement?.closest(".kx-rv-xfield")?.getAttribute("data-field") === "n_total"), "focus on the next empty field");
    await page.locator(".kx-rv-reader .pdfjs-host-mark.tone-source").first().waitFor();
    await themed(page, "10-extract-filled");
    // The source chip brings the passage back and lights it.
    await page.locator('.kx-rv-xfield[data-field="mean_pain"] .kx-rv-source-chip').click();
    await page.locator(".kx-rv-reader .pdfjs-host-mark.flash").first().waitFor();
    // A pick: the next selection fills the field with no menu.
    await page.locator('.kx-rv-xfield[data-field="n_total"]').hover();
    await page.getByRole("button", { name: "Pick Participants randomised from the text" }).click();
    await page.locator(".kx-rv-pick-banner").waitFor();
    await shot(page, "11-extract-pick");
    await selectSpan("n = 120");
    await until(async () => (await call("review_extraction", { reviewId, recordId: yogaId, viewer: me })).values["f-pain/n_total"]?.mine?.value === 120, "the picked value");
    assert.equal(await page.locator(".ksm[data-mode=extract]").count(), 0, "no menu for a pick");
    // ⌘Z takes the last fill back.
    await page.locator(".kx-rv-xform-head").first().click();
    await page.keyboard.press("Meta+z");
    await until(async () => !(await call("review_extraction", { reviewId, recordId: yogaId, viewer: me })).values["f-pain/n_total"]?.mine?.value, "the fill taken back");
    report.extraction = true;

    // Each kind of passage: words, a date range, a choice; nothing modal, and a date field is
    // offered for a date only (else under "Other fields: as source only").
    const extractMenu = async (text, name) => {
      for (const notice of await page.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
      await page.locator(".kx-rv-notice").first().waitFor({ state: "detached" }).catch(() => {});
      await selectSpan(text);
      await page.locator(".ksm[data-mode=extract] .ksm-row").first().waitFor();
      const rows = await page.locator(".ksm[data-mode=extract] .ksm-row").allTextContents();
      await geometry(name);
      await noModal(name);
      await themed(page, name);
      await page.keyboard.press("Escape");
      await page.locator(".ksm").waitFor({ state: "detached" });
      return rows;
    };
    const textRows = await extractMenu("Norway", "14-extract-text");
    assert(textRows.slice(0, 2).some((r) => /Country/.test(r)), `words go to the text field: ${textRows}`);
    assert(!textRows.some((r) => /Start of recruitment/.test(r)), `a date field is not offered for words: ${textRows}`);
    assert.equal(await page.locator(".ksm").count(), 0);
    const dateRows = await extractMenu("March 2015", "15-extract-date");
    const start = dateRows.find((r) => /Start of recruitment/.test(r));
    assert(start && /2015-03/.test(start) && /2016-06/.test(start), `the range fills both ends: ${dateRows}`);
    const choiceRows = await extractMenu("cluster-randomised", "16-extract-choice");
    // (The focused field comes first; the choice field shows its closest option.)
    assert(choiceRows.slice(0, 2).some((r) => /^Design/.test(r) && /Cluster randomised trial/.test(r)), `the closest option: ${choiceRows}`);

    // The reader's own comments inside the review: the editor from the menu, then the card on
    // clicking the highlight; readable, nothing overlapping or clipped, above the sidebar.
    const cardGeometry = (selector) =>
      page.evaluate((selector) => {
        const card = document.querySelector(selector);
        if (!card) return { error: `no ${selector}` };
        const c = card.getBoundingClientRect();
        const problems = [];
        const controls = [...card.querySelectorAll("button, textarea, [contenteditable=true], input")].filter((el) => el.getClientRects().length).map((el) => ({ r: el.getBoundingClientRect(), name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30) }));
        for (let i = 0; i < controls.length; i++)
          for (let j = i + 1; j < controls.length; j++) {
            const [a, b] = [controls[i], controls[j]];
            if (a.r.left + 0.5 < b.r.right && b.r.left + 0.5 < a.r.right && a.r.top + 0.5 < b.r.bottom && b.r.top + 0.5 < a.r.bottom) problems.push(`overlap: ${a.name} / ${b.name}`);
          }
        for (const x of controls) if (x.r.left < c.left - 0.5 || x.r.right > c.right + 0.5 || x.r.bottom > c.bottom + 0.5) problems.push(`clipped: ${x.name}`);
        if (c.left < 0 || c.top < 0 || c.right > innerWidth || c.bottom > innerHeight) problems.push("card off screen");
        const hit = document.elementFromPoint(c.left + c.width / 2, c.top + Math.min(20, c.height / 2));
        if (!card.contains(hit)) problems.push(`covered by ${hit?.className}`);
        return { problems };
      }, selector);
    await selectSpan("Randomised:");
    await page.locator(".ksm[data-mode=extract]").waitFor();
    await page.locator(".ksm .ksm-more").click();
    await page.locator(".ksm").getByRole("button", { name: "Add note" }).click();
    await page.locator(".pdfjs-comment-anchor-card .pdfjs-comment-editor").waitFor();
    await page.keyboard.type("Randomised by class, so check the clustering in the analysis before trusting this number.");
    const editor = await cardGeometry(".pdfjs-comment-anchor-card");
    assert.deepEqual(editor.problems, [], `the comment editor: ${editor.problems}`);
    await themed(page, "12-comment-editor");
    // (The screenshots closed a notice; back into the editor, then ⌘↩ saves.)
    await page.locator(".pdfjs-comment-anchor-card [contenteditable=true]").click();
    await page.keyboard.press("Meta+Enter");
    await page.locator(".pdfjs-comment-anchor-card").waitFor({ state: "detached" });
    const hl = await page.locator(".kx-rv-reader .pdfjs-highlight").first().boundingBox();
    await page.mouse.click(hl.x + hl.width / 2, hl.y + hl.height / 2);
    await page.locator(".key-highlight-info").waitFor();
    const info = await cardGeometry(".key-highlight-info");
    assert.deepEqual(info.problems, [], `the highlight card: ${info.problems}`);
    await themed(page, "13-highlight-card");
    report.comments = true;

    // Many criteria: letters after 9 (none clashing with the view's keys), one column for labels.
    const many = (await call("review_create", { name: "Keys (smoke)", ownerName: "Ana Example" })).reviewId;
    const k = await call("review_get", { reviewId: many, viewer: "" });
    const elements = ["population", "intervention", "comparator", "outcome", "design", "other"];
    k.protocol.criteria = Array.from({ length: 14 }, (_, i) => ({ id: `c${i + 1}`, element: elements[i % elements.length], label: i === 11 ? "A criterion with a long label that has to wrap onto a second line in the sidebar" : `Criterion ${i + 1}`, reason: "", guidance: "", stages: ["ta"] }));
    await call("review_protocol_save", { reviewId: many, protocol: k.protocol, note: "", actor: k.team[0].id, rescreen: false });
    await call("review_import_records", { reviewId: many, records: [{ title: "A record to screen", authors: ["A, B."], year: 2020, abstractText: "Invented." }], batch: { group: "databases", name: "PubMed" }, actor: k.team[0].id });
    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Keys (smoke)" }), { ws: ws.id, id: many });
    await page.getByRole("heading", { name: "Keys (smoke)" }).waitFor();
    await page.getByRole("tab", { name: /Title & abstract/ }).click();
    await page.locator(".kx-rv-criteria-pick label").nth(13).waitFor();
    const keys = await page.locator(".kx-rv-criteria-pick label").evaluateAll((ls) => ls.map((l) => l.querySelector("kbd")?.textContent ?? ""));
    assert.deepEqual(keys.slice(9), ["A", "C", "D", "F", "G"], `letters after 9: ${keys}`);
    const lefts = await page.locator(".kx-rv-criteria-pick label > span:not(.kx-rv-kbd-space)").evaluateAll((ls) => ls.map((l) => Math.round(l.getBoundingClientRect().left)));
    assert.equal(new Set(lefts).size, 1, `every label starts at one x: ${lefts}`);
    await page.locator(".kx-rv-decide-head").click();
    await page.keyboard.press("c");
    await page.locator(".kx-rv-criteria-pick label[data-on]", { hasText: "Criterion 11" }).waitFor();
    assert.equal(await page.locator(".kx-rv-record-title:visible").textContent(), "A record to screen", "a letter marks, it does not decide");
    await themed(page, "17-criteria-letters");
    report.criteriaKeys = keys.slice(9).join("");

    assert.deepEqual(errors, []);
    report.ok = true;
  } catch (e) {
    const [page] = app.windows();
    await page?.screenshot({ path: path.join(temp, "zz-failure.png") }).catch(() => {});
    throw e;
  } finally {
    console.log(JSON.stringify({ temp, ...report }, null, 2));
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
