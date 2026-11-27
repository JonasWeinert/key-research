// A small systematic review from start to finish in the real app, with invented records:
// create it from the sidebar, import a RIS file (one duplicate), look at the Sources table and
// the duplicate decisions, set criteria and keywords, screen titles and abstracts with the
// keyboard by both routes (E then the criterion's number; the number then E), Other…, a label
// key and the counter, gather full texts (dropped PDFs matched by DOI, a CSV of file names),
// screen a full text in the embedded reader and exclude it from a selected passage, extract a
// value from a selection with its required source, a conditional form (Qualitative brings the
// method question; Quantitative hides it and it is not required), run the meta-analysis and
// look at the PRISMA diagram and forest plot. Screenshots (light and dark) go to the printed
// temp folder.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const STUDIES = [
  ["Walking groups and blood pressure in older adults: a randomised trial", "Rivera, Ana", 2016, "10.9999/walk.1", "We randomised 240 adults aged over 65 to weekly walking groups or usual care. Systolic blood pressure fell more with walking."],
  ["Walking groups and blood pressure in older adults: a randomised trial", "Rivera, Ana", 2016, "10.9999/walk.1", "Duplicate of the first record from a second database."],
  ["Stretching breaks at work: a cluster randomised trial", "Okafor, Ben", 2019, "10.9999/stretch.2", "Offices were randomised to stretching breaks. Back pain at six months was lower in stretching offices."],
  ["Exercise habits in rats fed a high-salt diet", "Lind, Cara", 2015, "10.9999/rats.3", "Rats exercised on wheels; blood pressure was measured weekly."],
  ["Cycling to school and fitness in children", "Haas, Dev", 2021, "10.9999/cycle.4", "A cohort of children who cycled to school had higher fitness scores."],
  ["Yoga for chronic low back pain: a randomised trial", "Moreau, Eli", 2018, "10.9999/yoga.5", "Adults with chronic low back pain were randomised to yoga or a booklet. Pain improved more with yoga."],
  ["Tai chi and balance in older people: randomised controlled trial", "Ito, Fay", 2017, "10.9999/taichi.6", "Older people were randomised to tai chi or stretching. Falls were fewer with tai chi."],
  ["A survey of gym membership", "Berg, Gus", 1987, "", "A survey of 400 gym members about their habits."],
  ["Pilates versus usual care for neck pain: a randomised trial", "Silva, Hana", 2020, "10.9999/pilates.8", "Adults with neck pain were randomised to pilates or usual care."],
  ["Editorial: why we should all walk more", "Kerr, Ian", 2022, "10.9999/ed.9", "An editorial on walking."],
  ["Aquatic exercise for knee osteoarthritis: a randomised trial", "Novak, Jon", 2019, "10.9999/aqua.10", "Adults with knee osteoarthritis were randomised to pool exercise or education."],
];
/** A one-page PDF with these lines of text (Helvetica), for full texts in the smoke. */
function pdfWith(lines) {
  const text = lines.map((l, i) => `BT /F1 13 Tf 72 ${720 - i * 22} Td (${l.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
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

const ris = STUDIES.map(([title, author, year, doi, abstract]) => ["TY  - JOUR", `TI  - ${title}`, `AU  - ${author}`, `PY  - ${year}`, doi && `DO  - ${doi}`, `AB  - ${abstract}`, "JO  - Journal of Invented Examples", "ER  - "].filter(Boolean).join("\n")).join("\n");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-"));
  const file = path.join(temp, "pubmed-search.ris");
  await writeFile(file, ris);
  const yogaPdf = path.join(temp, "moreau-2018.pdf");
  await writeFile(yogaPdf, pdfWith(["Yoga for chronic low back pain: a randomised trial", "Eli Moreau", "doi: 10.9999/yoga.5", "Participants were recruited in Norway from four clinics.", "Pain improved more with yoga than with the booklet."]));
  const notesPdf = path.join(temp, "meeting-notes.pdf");
  await writeFile(notesPdf, pdfWith(["Notes from a team meeting about room bookings"]));
  const pilatesPdf = path.join(temp, "silva-2020.pdf");
  await writeFile(pilatesPdf, pdfWith(["Pilates versus usual care for neck pain: a randomised trial", "Participants were adolescents aged 12 to 16 at one school.", "Neck pain was measured at twelve weeks."]));
  const taichiPdf = path.join(temp, "taichi.pdf");
  await writeFile(taichiPdf, pdfWith(["Tai chi and balance in older people", "Falls were fewer with tai chi."]));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  const shot = async (page, name) => {
    await page.waitForTimeout(350);
    // Notices close themselves after a few seconds; for the pictures, close them now.
    for (const notice of await page.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.screenshot({ path: path.join(temp, `${name}.png`) });
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

    // Create from the sidebar's Reviews row.
    await page.getByRole("navigation", { name: "Systematic reviews" }).getByRole("button", { name: "Reviews", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "New systematic review" });
    await sheet.waitFor();
    await sheet.getByRole("textbox", { name: "Review name" }).fill("Exercise and health (smoke)");
    await sheet.getByRole("textbox", { name: "Your name" }).fill("Ana Example");
    await shot(page, "01-new-review");
    await sheet.getByRole("button", { name: "Create review" }).click();
    await page.getByRole("heading", { name: "Exercise and health (smoke)" }).waitFor();
    await page.getByRole("heading", { name: "Add the records you found" }).waitFor();
    await shot(page, "02-overview-empty");
    const [review] = await call("review_list");
    const reviewId = review.id;
    const summary = () => call("review_get", { reviewId, viewer: "" });

    // Sources: import the RIS file through the file chooser.
    await page.getByRole("tab", { name: /Sources/ }).click();
    await page.locator(".kx-rv-sources input[type=file]").first().setInputFiles(file);
    const importSheet = page.getByRole("dialog", { name: "Import records" });
    await importSheet.getByText("11 records", { exact: true }).waitFor();
    assert.equal(await importSheet.getByRole("combobox", { name: "Database" }).inputValue(), "PubMed");
    await importSheet.getByRole("textbox", { name: "Search strategy" }).fill("(exercise OR walking OR yoga) AND (randomised OR randomized)");
    await shot(page, "03-import-sheet");
    await importSheet.getByRole("button", { name: /Import 11 records/ }).click();
    await page.getByText(/1 duplicate removed/).first().waitFor();
    let s = await summary();
    assert.equal(s.records, 11);
    assert.equal(s.active, 10);
    await shot(page, "04-sources");
    report.import = { records: s.records, active: s.active, duplicates: s.duplicates };
    // Records: every record in one table; one without an abstract, filtered.
    await page.getByRole("radio", { name: /^Records/ }).click();
    await page.locator(".kx-rv-record-row .kx-rv-list-title").first().waitFor();
    assert.equal(await page.locator(".kx-rv-records .kx-rv-muted", { hasText: /^11 records$/ }).count(), 1);
    await page.getByRole("combobox", { name: "Status" }).selectOption("active");
    await page.locator(".kx-rv-records .kx-rv-muted", { hasText: /^10 records$/ }).waitFor();
    await shot(page, "04b-sources-records");
    // A record removed by hand leaves screening (PRISMA: removed for other reasons), then comes back.
    await page.locator(".kx-rv-record-row .kx-rv-list-main", { hasText: "Editorial" }).click();
    const recordSheet = page.getByRole("complementary", { name: "Record" });
    // Fields are edited in place, beside the table.
    await recordSheet.getByRole("textbox", { name: "Volume" }).fill("12");
    await recordSheet.getByRole("textbox", { name: "Volume" }).press("Enter");
    for (let i = 0; i < 50; i++) {
      const rows = (await call("review_records", { reviewId, viewer: "", query: { stage: "ta", filter: "all", text: "Editorial", scope: "sources" } })).rows;
      if ((await call("review_record", { reviewId, recordId: rows[0].id, stage: "ta", viewer: "" })).meta.volume === "12") break;
      await page.waitForTimeout(100);
    }
    // A full text dropped on (or chosen for) the record is kept with the review.
    await recordSheet.locator("input[type=file]").setInputFiles(taichiPdf);
    await recordSheet.getByText("kept with the review").waitFor();
    await recordSheet.getByRole("button", { name: "Remove", exact: true }).click();
    await recordSheet.getByText("None yet").waitFor();
    await shot(page, "04a-sources-record-panel");
    await recordSheet.getByRole("button", { name: "Remove…" }).click();
    await page.getByRole("button", { name: "Remove record" }).click();
    await page.locator(".kx-rv-records .kx-rv-muted", { hasText: /^9 records$/ }).waitFor();
    assert.equal((await call("review_prisma", { reviewId })).removedOther, 1);
    await page.locator(".kx-rv-notice button", { hasText: "Undo" }).click();
    await page.locator(".kx-rv-records .kx-rv-muted", { hasText: /^10 records$/ }).waitFor();
    assert.equal((await call("review_prisma", { reviewId })).removedOther, 0);
    // Duplicates: the automatic decision, with why; split, then merged again.
    await page.getByRole("radio", { name: /^Duplicates/ }).click();
    const dupGroup = page.locator(".kx-rv-dup-groups > li").first();
    await dupGroup.getByText("Automatically").waitFor();
    await shot(page, "04c-sources-duplicates");
    await dupGroup.getByRole("button", { name: "Not duplicates" }).click();
    for (let i = 0; i < 50 && (await summary()).active !== 11; i++) await page.waitForTimeout(100);
    assert.equal((await summary()).active, 11);
    await page.locator(".kx-rv-notice button", { hasText: "Undo" }).click();
    for (let i = 0; i < 50 && (await summary()).active !== 10; i++) await page.waitForTimeout(100);
    s = await summary();
    assert.equal(s.active, 10);
    assert.equal((await call("review_prisma", { reviewId })).duplicates, 1);

    // Setup: the question, keywords and a criterion checked from the year (through the host),
    // then criteria added from the suggestions in the editor (one click each).
    const protocol = s.protocol;
    protocol.question.parts = { p: "adults of any age", i: "a supervised exercise programme", c: "usual care", o: "pain or blood pressure" };
    protocol.keywords = { include: ["randomi*", "trial"], exclude: ["rats", "editorial", "survey"] };
    protocol.criteria = [
      { id: "c-year", element: "other", label: "Published 2000 or later", reason: "Published before 2000", guidance: "", stages: ["ta"], link: { conditions: [{ field: "year", op: "ge", value: 2000 }], all: true, effect: "suggest" } },
    ];
    protocol.forms.push((await call("review_form_templates")).find((f) => f.id === "f-outcomes"));
    // Excluding at title and abstract asks for the first criterion not met.
    protocol.rules.ta.reasons = "first";
    // The country needs its place in the document; a conditional form for the design.
        protocol.forms.find((f) => f.id === "f-characteristics").sections.forEach((sec) => sec.fields.forEach((f) => f.id === "country" && (f.source = "required")));
    protocol.forms.push({
      id: "f-design",
      name: "Design",
      kind: "custom",
      sections: [
        {
          id: "s-design",
          title: "Design",
          guidance: "",
          fields: [
            { id: "study_type", label: "Study type", kind: "choice", guidance: "", required: true, quote: false, options: ["Quantitative", "Qualitative"], unit: "", columns: [], role: "", source: "none" },
            { id: "method", label: "Method", kind: "choice", guidance: "", required: true, quote: false, options: ["Interviews", "Focus groups", "Ethnography"], unit: "", columns: [], role: "", source: "none", showWhen: { conditions: [{ field: "study_type", op: "is", value: "Qualitative" }], all: true } },
          ],
        },
      ],
    });

    await call("review_protocol_save", { reviewId, protocol, note: "", actor: s.team[0].id, rescreen: false });
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("button", { name: "Criteria", exact: false }).first().click();
    // The criterion saved through the host shows before any edit (the editor starts from it).
    await page.locator('.kx-rv-criterion input[value="Published 2000 or later"]').waitFor();
    for (const chip of ["Wrong population", "Wrong intervention", "Wrong study design", "Not in an included language"]) {
      await page.locator(".kx-rv-chip", { hasText: chip }).click();
      await page.locator(".kx-rv-chip", { hasText: chip }).waitFor({ state: "detached" });
    }
    // The question's words became the guidance of the population criterion.
    // Saved as they are made (an amendment: nothing was decided yet).
    for (let i = 0; i < 50 && (await summary()).protocol.criteria.length !== 5; i++) await page.waitForTimeout(200);
    s = await summary();
    assert.equal(s.protocol.criteria.find((c) => c.id === "c-population")?.guidance, "Include: adults of any age");
    assert(!("reasons" in s.protocol), "no separate list of reasons");
    await page.locator(".kx-rv-criterion", { has: page.locator('input[value="Published 2000 or later"]') }).getByRole("button", { name: "Show details" }).click();
    await shot(page, "05-setup-criteria");

    // Title and abstract: keyboard screening.
    await page.getByRole("tab", { name: /Title & abstract/ }).click();
    await page.locator(".kx-rv-record-title").waitFor();
    await shot(page, "06-screen-first");
    const decide = async (key) => {
      const before = await page.locator(".kx-rv-record-title").textContent();
      await page.keyboard.press(key);
      await page.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), before);
      return before;
    };
    const taCriteria = s.protocol.criteria.filter((c) => !c.stages.length || c.stages.includes("ta"));
    const num = (id) => String(taCriteria.findIndex((c) => c.id === id) + 1);
    const counterText = () => page.locator(".kx-rv-counter").textContent();
    assert.equal(await counterText(), "1 of 10");
    const titles = [];
    for (let i = 0; i < 10; i++) {
      const title = await page.locator(".kx-rv-record-title").textContent();
      titles.push(title);
      if (/survey of gym/.test(title)) {
        // The rule suggests excluding the 1987 record.
        await page.locator(".kx-rv-suggestion").getByText("Not met: Year is 2000 or later").waitFor();
        await shot(page, "07-screen-suggestion");
        // Other…: E opens the criteria step, 0 the text field, Enter records and goes on.
        await page.keyboard.press("e");
        await page.locator(".kx-rv-criteria-pick[data-picking]").waitFor();
        await page.keyboard.press("0");
        await page.getByRole("textbox", { name: "Other reason" }).fill("A survey of members, not a trial");
        await shot(page, "07b-screen-other");
        await page.keyboard.press("Enter");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b, title);
      } else if (/rats|Cycling/.test(title)) {
        // Route a: E, then the criterion's number (the first one: that records it).
        await page.keyboard.press("e");
        await page.locator(".kx-rv-criteria-pick[data-picking]").waitFor();
        if (/rats/.test(title)) await shot(page, "07c-screen-criteria-step");
        await page.keyboard.press(num("c-population"));
        await page.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b, title);
      } else if (/Editorial/.test(title)) {
        // Route b: the number first, then E.
        await page.keyboard.press(num("c-design"));
        await page.locator(".kx-rv-criteria-pick label[data-on]").waitFor();
        await decide("e");
      } else if (/Tai chi/.test(title)) {
        // A label key toggles the label and stays on the record.
        await page.keyboard.press("l");
        await page.locator(".kx-rv-label[aria-pressed=true]", { hasText: "Check later" }).waitFor();
        assert.equal(await page.locator(".kx-rv-record-title").textContent(), title);
        await decide("i");
      } else await decide(/Pilates/.test(title) ? "m" : "i");
      if (i === 0) assert.equal(await counterText(), "2 of 10", "the counter moves on through the session");
      if (i === 1) {
        // Undo brings the last record back, in its place.
        await page.keyboard.press("Meta+z");
        await page.locator(".kx-rv-notice", { hasText: "Took back" }).waitFor();
        await page.waitForFunction((t) => document.querySelector(".kx-rv-record-title")?.textContent === t, title);
        assert.equal(await counterText(), "2 of 10");
        await decide("i");
      }
    }
    await page.locator(".kx-rv-done").waitFor();
    await shot(page, "08-screen-done");
    s = await summary();
    report.ta = s.stages.ta;
    assert.equal(s.stages.ta.done, 10);
    assert.equal(s.stages.ta.excluded, 4);
    assert.equal(s.labelCounts["Check later"], 1);
    const survey = (await call("review_records", { reviewId, viewer: s.team[0].id, query: { stage: "ta", filter: "excluded", text: "gym" } })).rows[0];
    assert.equal((await call("review_record", { reviewId, recordId: survey.id, stage: "ta", viewer: s.team[0].id })).mine.other, "A survey of members, not a trial");

    // The list view.
    await page.getByRole("radio", { name: "List" }).click();
    await page.getByRole("combobox", { name: "Show" }).selectOption("all");
    await page.locator(".kx-rv-list-row .kx-rv-list-title").first().waitFor();
    await page.locator(".kx-rv-label-tabs [role=tab]", { hasText: "Check later" }).getByText("1").waitFor();
    await shot(page, "09-list");

    // Full texts: the Pilates record gets its PDF from the library (linked); dropped files are
    // matched by DOI (Yoga) and an unrelated one stays unmatched; a CSV names Tai chi's file.
    const pilatesInfo = await call("library_import_file", { path: pilatesPdf });
    const source = await call("store_source", { id: pilatesInfo.id });
    assert(source?.id, "the PDF is in the library");
    const ftRows = async () => (await call("review_fulltexts", { reviewId })).rows;
    const recordOf = async (re) => (await ftRows()).find((r) => re.test(r.title)).id;
    await call("review_fulltext", { reviewId, recordId: await recordOf(/Pilates/), status: "retrieved", sourceId: source.id, actor: s.team[0].id });
    const librarySources = (await call("store_sources", { limit: 50 })).items.length;
    await page.getByRole("tab", { name: /Full text/ }).click();
    await page.getByRole("radio", { name: /Full texts/ }).click();
    await page.locator(".kx-rv-fulltext-table tbody tr").first().waitFor();
    await page.locator(".kx-rv-fulltexts input[type=file]").first().setInputFiles([yogaPdf, notesPdf]);
    const matchSheet = page.getByRole("dialog", { name: "Match files to records" });
    await matchSheet.locator("li[data-level=confident]", { hasText: "moreau-2018.pdf" }).waitFor();
    await matchSheet.locator("li[data-level=unmatched]", { hasText: "meeting-notes.pdf" }).waitFor();
    await shot(page, "10a-fulltexts-match");
    await matchSheet.getByRole("button", { name: "Attach 1" }).click();
    await matchSheet.waitFor({ state: "detached" });
    const yogaId = await recordOf(/Yoga/);
    const yoga = (await ftRows()).find((r) => r.id === yogaId);
    assert.equal(yoga.state, "have");
    assert.equal(yoga.sourceId, null, "kept with the review, not a library source");
    assert.equal((await call("store_sources", { limit: 50 })).items.length, librarySources, "no library source was made");
    const sheetCsv = (await call("review_export", { reviewId, kind: "fulltext-csv", viewer: s.team[0].id })).content;
    const taichiId = await recordOf(/Tai chi/);
    const filled = sheetCsv
      .trim()
      .split("\n")
      .map((line, n) => (n === 0 ? line : line.startsWith(taichiId) ? `${line}taichi.pdf` : /Aquatic/.test(line) ? `${line}missing.pdf` : line))
      .join("\n");
    const csvFile = path.join(temp, "full-texts.csv");
    await writeFile(csvFile, filled);
    await page.locator(".kx-rv-fulltexts input[type=file]").nth(1).setInputFiles([csvFile, taichiPdf]);
    const csvSheet = page.getByRole("dialog", { name: "Full texts from the CSV" });
    await csvSheet.getByText("“missing.pdf” was not among the files uploaded").waitFor();
    await shot(page, "10b-fulltexts-csv");
    await csvSheet.getByRole("button", { name: "Attach 1" }).click();
    await csvSheet.waitFor({ state: "detached" });
    assert.equal((await ftRows()).find((r) => r.id === taichiId).state, "have");
    report.fulltexts = (await call("review_fulltexts", { reviewId })).have;

    // Screen at full text: the PDF is the main panel inside the review tab, the decision beside.
    await page.getByRole("radio", { name: "Screen" }).click();
    await page.locator(".kx-rv-record-title").first().waitFor();
    for (let i = 0; i < 12 && !(await page.locator(".kx-rv-done").count()); i++) {
      const title = await page.locator(".kx-rv-compact .kx-rv-record-title").textContent();
      if (/Pilates/.test(title)) {
        // The PDF renders in the review layout; a passage selected there shows the population
        // criterion is not met, and the record is excluded from it.
        const span = page.locator(".kx-rv-reader .pdfjs-text-layer span", { hasText: "adolescents" }).first();
        await span.waitFor();
        assert.equal(await page.locator(".kx-rv-single[data-layout=reader] .kx-rv-reader[data-kind=pdf]").count(), 1);
        await shot(page, "10-fulltext-reader");
        const box = await span.boundingBox();
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.locator(".pdfjs-selection-host[data-action=review-not-met]").click();
        const pick = page.getByRole("dialog", { name: "Does not meet" });
        await pick.waitFor();
        await shot(page, "11-fulltext-not-met");
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        await shot(page, "11-fulltext-not-met-dark");
        await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
        await page.keyboard.press("1");
        await pick.waitFor({ state: "detached" });
        await page.locator(".kx-rv-evidence-list li[data-kind=notMet]").waitFor();
        await page.getByRole("button", { name: "Exclude and go to next" }).click();
        await page.waitForFunction((b) => document.querySelector(".kx-rv-compact .kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), title);
      } else {
        await page.locator(".kx-rv-decide-head").click();
        const before = title;
        await page.keyboard.press("i");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-compact .kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), before);
      }
      if (await page.locator(".kx-rv-done").count()) break;
    }
    await page.locator(".kx-rv-done").waitFor();
    const pilatesId = (await call("review_records", { reviewId, viewer: s.team[0].id, query: { stage: "ft", filter: "excluded", text: "Pilates" } })).rows[0].id;
    const pilates = await call("review_record", { reviewId, recordId: pilatesId, stage: "ft", viewer: s.team[0].id });
    assert.equal(pilates.mine.evidence[0].kind, "notMet");
    assert.equal(pilates.mine.evidence[0].page, 0);
    assert(pilates.mine.evidence[0].rects.length > 0, "the passage keeps its place");
    s = await summary();
    report.ft = s.stages.ft;
    assert.equal(s.included, 5);
    // PRISMA counts the exclusion under the criterion's reason.
    assert.deepEqual((await call("review_prisma", { reviewId })).main.excludedReasons, [{ name: "Wrong population", count: 1 }]);

    // Extraction: outcome data for each included study (through the host), then the form.
    const studies = (await call("review_studies", { reviewId, viewer: s.team[0].id })).studies;
    const data = [
      [12, 120, 20, 118],
      [8, 60, 15, 62],
      [30, 150, 41, 149],
      [5, 40, 9, 42],
      [14, 98, 19, 101],
    ];
    for (const [i, st] of studies.entries()) {
      const [e1, n1, e2, n2] = data[i];
      await call("review_extract", { reviewId, recordId: st.id, formId: "f-outcomes", fieldId: "outcomes", value: [{ outcome: "Pain persisting", type: "Dichotomous", e1, n1, e2, n2 }], quote: "Table 2", page: 5, actor: s.team[0].id });
      await call("review_extract", { reviewId, recordId: st.id, formId: "f-characteristics", fieldId: "design", value: i % 2 ? "Cluster randomised trial" : "Randomised controlled trial", actor: s.team[0].id });
    }
    // AI pre-fill through the host, with a canned answer (no provider in a smoke): the request
    // carries the study's text, the answer becomes a suggestion with its quote checked.
    const first = studies[0];
    const aiRequest = await call("review_ai_extract_request", { reviewId, recordId: first.id, formId: "f-characteristics" });
    assert(aiRequest.request.prompt.includes("We randomised 240 adults"), "the abstract is in the request");
    const answer = JSON.stringify({ values: [{ fieldId: "country", value: "Norway", quote: "randomised 240 adults", passage: "P1" }, { fieldId: "n_total", value: 240, quote: "made up words", passage: "P1" }] });
    const ai = await call("review_ai_extract_answer", { reviewId, recordId: first.id, formId: "f-characteristics", content: answer, model: "smoke" });
    assert.equal(ai.suggested, 2);
    await page.getByRole("tab", { name: /Extraction/ }).click();
    await page.locator(".kx-rv-xform").first().waitFor();
    await page.locator(".kx-rv-xsuggestion", { hasText: "Norway" }).waitFor();
    await shot(page, "12-extraction");
    // Yoga's study: its PDF in the reader; "Norway" taken from a selection with its place.
    await page.getByRole("combobox", { name: "Study", exact: true }).selectOption(yogaId);
    const norway = page.locator(".kx-rv-reader .pdfjs-text-layer span", { hasText: "Norway" }).first();
    await norway.waitFor();
    // Typed without its place, the country stops the form from being completed.
    await call("review_extract", { reviewId, recordId: yogaId, formId: "f-characteristics", fieldId: "country", value: "Norway", actor: s.team[0].id });
    const before = await call("review_complete_form", { reviewId, recordId: yogaId, formId: "f-characteristics", actor: s.team[0].id }).then(() => "", (e) => String(e));
    assert(/Country or countries: pick it from the document/.test(before), before);
    const nb = await norway.boundingBox();
    await page.mouse.move(nb.x + 2, nb.y + nb.height / 2);
    await page.mouse.down();
    await page.mouse.move(nb.x + nb.width - 2, nb.y + nb.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.locator(".pdfjs-selection-host[data-action=review-use]").click();
    const use = page.getByRole("dialog", { name: "Use the passage" });
    await use.getByRole("textbox").fill("Country");
    await page.keyboard.press("Enter");
    await use.getByRole("heading", { name: "Use for Country or countries" }).waitFor();
    await shot(page, "12b-extraction-use");
    await use.getByRole("button", { name: "The passage" }).click();
    await use.waitFor({ state: "detached" });
    const xv = await call("review_extraction", { reviewId, recordId: yogaId, viewer: s.team[0].id });
    const country = xv.values["f-characteristics/country"].mine;
    assert(/Norway/.test(country.value) && country.sourcePos?.page === 0 && country.sourcePos.rects.length > 0, "the value keeps its place");
    const after = await call("review_complete_form", { reviewId, recordId: yogaId, formId: "f-characteristics", actor: s.team[0].id }).then(() => "", (e) => String(e));
    assert(!/Country or countries/.test(after), after);
    await page.locator(".kx-rv-xfield[data-field=country] .kx-rv-source-chip[data-placed]").waitFor();
    // The conditional form: Qualitative brings the method question; Quantitative hides it.
    const design = page.locator(".kx-rv-xform", { has: page.getByRole("heading", { name: "Design" }) });
    await design.getByRole("combobox", { name: "Study type" }).selectOption("Qualitative");
    await design.locator(".kx-rv-xfield[data-field=method]").waitFor();
    await shot(page, "12c-extraction-conditional");
    await design.getByRole("combobox", { name: "Study type" }).selectOption("Quantitative");
    await design.locator(".kx-rv-xfield[data-field=method]").waitFor({ state: "detached" });
    await design.getByRole("button", { name: "Complete form" }).click();
    await design.locator(".kx-rv-pill", { hasText: "Complete" }).waitFor();

    // Analysis: forest plot of the pooled risk ratio.
    await page.getByRole("tab", { name: /Analysis/ }).click();
    await page.locator(".kx-forest").waitFor();
    const headline = await page.locator(".kx-rv-headline strong").textContent();
    report.pooled = headline;
    const ma = await call("review_analyse", { reviewId, request: { outcome: "Pain persisting", options: { measure: "RR", method: "reml", hartungKnapp: false, level: 0.95 }, subgroups: false } });
    assert.equal(ma.analysis.studies.length, 5);
    await shot(page, "13-analysis");
    await page.locator(".kx-rv-analysis").evaluate((el) => el.closest(".kx-rv-body").scrollTo(0, 10000));
    await shot(page, "14-analysis-funnel");

    // Overview with the PRISMA diagram.
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("img", { name: "PRISMA 2020 flow diagram" }).waitFor();
    const prisma = await call("review_prisma", { reviewId });
    report.prisma = { identified: prisma.identified, duplicates: prisma.duplicates, screened: prisma.screened, excluded: prisma.screeningExcluded, assessed: prisma.main.assessed, included: prisma.studiesIncluded };
    assert.deepEqual(report.prisma, { identified: 11, duplicates: 1, screened: 10, excluded: 4, assessed: 6, included: 5 });
    await shot(page, "15-overview-prisma");

    // Team, a stricter rule after decisions (a new version, flagged records), pilot, audit.
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("button", { name: "Team & rules" }).click();
    await page.getByRole("button", { name: "Add a person" }).click();
    await page.locator(".kx-rv-team tr").nth(1).waitFor();
    await page.getByRole("radiogroup", { name: "Title & abstract reviewers" }).getByRole("radio", { name: "2" }).click();
    const bar = page.getByRole("region", { name: "Save protocol changes" });
    await bar.waitFor();
    await shot(page, "19-setup-rules-savebar");
    await bar.getByRole("textbox", { name: "Change note" }).fill("Two reviewers per record from now on");
    await bar.getByRole("button", { name: "Save version 2" }).click();
    await bar.waitFor({ state: "detached" });
    s = await summary();
    assert.equal(s.versionNumber, 2);
    await page.getByRole("button", { name: "Pilot & assignment" }).click();
    await page.getByRole("heading", { name: "Pilot rounds" }).waitFor();
    await shot(page, "20-setup-pilot");
    await page.getByRole("button", { name: "Versions & audit" }).click();
    await page.getByRole("heading", { name: "Audit trail" }).waitFor();
    await shot(page, "21-setup-history");

    // A conflict under the two-reviewer rule: Ana includes, Reviewer 2 excludes; Ana resolves.
    const [ana, second] = s.team;
    await call("review_import_records", { reviewId, records: [{ title: "Dance classes and mood in care homes: a randomised trial", authors: ["Ross, Kim"], year: 2023, abstractText: "Care home residents were randomised to weekly dance classes." }], batch: { group: "other", name: "Citation searching" }, actor: ana.id });
    const fresh = (await call("review_queue", { reviewId, stage: "ta", viewer: ana.id, filter: "" }))[0];
    await call("review_decide", { reviewId, recordIds: [fresh], stage: "ta", value: "include", reasons: [], note: "", actor: ana.id });
    const blind = await call("review_record", { reviewId, recordId: fresh, stage: "ta", viewer: second.id });
    assert.deepEqual(blind.others, [], "blind: the second reviewer does not see the first decision");
    await call("review_decide", { reviewId, recordIds: [fresh], stage: "ta", value: "exclude", reasons: [], other: "Not an exercise intervention", note: "", actor: second.id });
    await page.getByRole("tab", { name: /Title & abstract/ }).click();
    await page.getByRole("radio", { name: /Conflicts/ }).click();
    await page.locator(".kx-rv-resolve-note").waitFor();
    await shot(page, "22-conflict");
    await page.keyboard.press("i");
    await page.locator(".kx-rv-done").waitFor();
    assert.equal((await call("review_record", { reviewId, recordId: fresh, stage: "ta", viewer: ana.id })).status.name, "included");

    // The library's "Send to review…" (its selection action opens this sheet).
    await page.evaluate(({ ws, id }) => window.dispatchEvent(new CustomEvent("key:review-sheet", { detail: { kind: "send", workspaceId: ws, sourceIds: [id] } })), { ws: ws.id, id: source.id });
    const send = page.getByRole("dialog", { name: "Send to review" });
    await send.getByRole("button", { name: /Exercise and health \(smoke\)/ }).click();
    await send.waitFor({ state: "detached" });
    s = await summary();
    assert(s.batches.some((b) => b.batch.kind === "library"), "the library source arrived as an import");

    // A review file from before criteria and reasons were one list: its reasons are criteria now.
    const legacyId = "0190a000-0000-7000-8000-00000000aaaa";
    const legacyEvent = (n, kind, payload, record) => ({ id: `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`, reviewId: legacyId, at: 1700000000000 + n, actor: "m1", device: "old", kind, version: "", recordId: record ?? null, payload });
    const legacy = {
      format: "key-review",
      version: 1,
      events: [
        legacyEvent(1, "review.create", { name: "An older review" }),
        legacyEvent(2, "team.set", { members: [{ id: "m1", name: "Ana Example", roles: ["owner", "reviewer"] }] }),
        legacyEvent(3, "protocol.set", { note: "Created", protocol: { criteria: [{ id: "c-animal", kind: "exclude", label: "Animal studies", stages: ["ta", "ft"], reasonId: "r-population" }], reasons: [{ id: "r-design", label: "Wrong study design" }, { id: "r-population", label: "Wrong population" }, { id: "r-other", label: "Other" }] } }),
      ],
    };
    await call("review_import_review", { text: JSON.stringify(legacy) });
    const migrated = await call("review_get", { reviewId: legacyId, viewer: "m1" });
    assert.deepEqual(migrated.protocol.criteria.map((c) => c.id), ["c-design", "c-animal", "c-other"]);
    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "An older review" }), { ws: ws.id, id: legacyId });
    await page.getByRole("heading", { name: "An older review" }).waitFor();
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("button", { name: "Criteria", exact: false }).first().click();
    await page.locator(".kx-rv-criterion").nth(2).waitFor();
    await shot(page, "23-setup-migrated");
    await page.getByRole("button", { name: "Versions & audit" }).click();
    await page.getByText("Merged the exclusion reasons into the criteria").waitFor();
    // The owner's counts: 315 from a PubMed run, 3,402 from the library that an older Key put
    // under "other methods: Manual", 75 screened (70 excluded). The diagram says 75 of 315,
    // the old import is offered a fix, and once named it moves to the left column.
    const counts = (await call("review_create", { name: "Counts (smoke)", ownerName: "Ana Example" })).reviewId;
    const owner = (await call("review_get", { reviewId: counts, viewer: "" })).team[0].id;
    const invented = (n, tag) => Array.from({ length: n }, (_, i) => ({ title: `${tag} study ${i} of walking and outcome ${(i * 7919) % 100003}`, authors: [`Author${i}, A.`], year: 2000 + (i % 24), doi: `10.9999/${tag}.${i}`, abstractText: "Invented." }));
    await call("review_import_records", { reviewId: counts, records: invented(315, "pubmed"), batch: { group: "databases", name: "PubMed" }, actor: owner });
    await call("review_import_records", { reviewId: counts, records: invented(3402, "library"), batch: { group: "other", name: "Manual" }, actor: owner });
    const pubmedIds = (await call("review_records", { reviewId: counts, viewer: owner, query: { stage: "ta", filter: "all", text: "pubmed", limit: 1000 } })).rows.map((r) => r.id).slice(0, 75);
    await call("review_decide", { reviewId: counts, recordIds: pubmedIds.slice(0, 70), stage: "ta", value: "exclude", reasons: [], note: "", actor: owner });
    await call("review_decide", { reviewId: counts, recordIds: pubmedIds.slice(70), stage: "ta", value: "include", reasons: [], note: "", actor: owner });
    let pc = await call("review_prisma", { reviewId: counts });
    assert.deepEqual([pc.identified, pc.screened, pc.screeningPending, pc.screeningExcluded, pc.main.sought, pc.complete], [315, 75, 240, 70, 5, false]);
    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Counts (smoke)" }), { ws: ws.id, id: counts });
    await page.getByRole("heading", { name: "Counts (smoke)" }).waitFor();
    await page.getByRole("tab", { name: "Overview" }).click();
    const diagram = page.locator(".kx-rv-prisma-card .kx-prisma").first();
    await diagram.getByText("Records screened (n = 75 of 315)").waitFor();
    await diagram.getByText("240 still to screen").waitFor();
    await shot(page, "25-prisma-in-progress");
    await page.getByRole("button", { name: "Where did these come from?" }).click();
    const originSheet = page.getByRole("dialog", { name: "Where the records came from" });
    await originSheet.getByRole("radio", { name: "Database" }).click();
    await originSheet.getByRole("combobox").last().fill("Scopus");
    await originSheet.getByRole("button", { name: "Save" }).click();
    await originSheet.waitFor({ state: "detached" });
    await diagram.getByText("Scopus (n = 3,402)").waitFor();
    pc = await call("review_prisma", { reviewId: counts });
    assert.deepEqual([pc.identified, pc.screened, pc.screeningPending, pc.otherMethods.length], [3717, 75, 3642, 0]);
    await shot(page, "26-prisma-origin-fixed");

    // Back to the first review (its tab comes forward).
    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id }), { ws: ws.id, id: reviewId });
    await page.getByRole("heading", { name: "Exercise and health (smoke)" }).waitFor();

    // Dark mode.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "16-overview-dark");
    await page.getByRole("tab", { name: /Title & abstract/ }).click();
    await page.getByRole("radio", { name: "List" }).click();
    await shot(page, "17-list-dark");
    await page.getByRole("tab", { name: /Analysis/ }).click();
    await page.locator(".kx-forest").waitFor();
    await shot(page, "18-analysis-dark");
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("button", { name: "Criteria", exact: false }).first().click();
    await page.locator(".kx-rv-criterion").first().waitFor();
    await shot(page, "24-setup-criteria-dark");

    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

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
