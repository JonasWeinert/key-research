// A small systematic review from start to finish in the real app, with invented records:
// create it from the sidebar, import a RIS file (one duplicate), set criteria and keywords,
// screen titles and abstracts with the keyboard (including an undo and a rule suggestion),
// assess full texts with reasons, extract outcome data, run the meta-analysis and look at the
// PRISMA diagram and forest plot. Screenshots (light and dark) go to the printed temp folder.
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
const ris = STUDIES.map(([title, author, year, doi, abstract]) => ["TY  - JOUR", `TI  - ${title}`, `AU  - ${author}`, `PY  - ${year}`, doi && `DO  - ${doi}`, `AB  - ${abstract}`, "JO  - Journal of Invented Examples", "ER  - "].filter(Boolean).join("\n")).join("\n");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-"));
  const file = path.join(temp, "pubmed-search.ris");
  await writeFile(file, ris);
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
    await page.locator(".kx-rv-sources input[type=file]").setInputFiles(file);
    const importSheet = page.getByRole("dialog", { name: "Import records" });
    await importSheet.getByText("11 records", { exact: true }).waitFor();
    assert.equal(await importSheet.getByRole("textbox", { name: "Database" }).inputValue(), "PubMed");
    await importSheet.getByRole("textbox", { name: "Search strategy" }).fill("(exercise OR walking OR yoga) AND (randomised OR randomized)");
    await shot(page, "03-import-sheet");
    await importSheet.getByRole("button", { name: /Import 11 records/ }).click();
    await page.getByText(/1 duplicate removed/).first().waitFor();
    let s = await summary();
    assert.equal(s.records, 11);
    assert.equal(s.active, 10);
    await shot(page, "04-sources");
    report.import = { records: s.records, active: s.active, duplicates: s.duplicates };

    // Setup: the question, keywords and a criterion checked from the year (through the host),
    // then criteria added from the suggestions in the editor (one click each).
    const protocol = s.protocol;
    protocol.question.parts = { p: "adults of any age", i: "a supervised exercise programme", c: "usual care", o: "pain or blood pressure" };
    protocol.keywords = { include: ["randomi*", "trial"], exclude: ["rats", "editorial", "survey"] };
    protocol.criteria = [
      { id: "c-year", element: "other", label: "Published 2000 or later", reason: "Published before 2000", guidance: "", stages: ["ta"], link: { conditions: [{ field: "year", op: "ge", value: 2000 }], all: true, effect: "suggest" } },
    ];
    protocol.forms.push((await call("review_form_templates")).find((f) => f.id === "f-outcomes"));
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
    const titles = [];
    for (let i = 0; i < 10; i++) {
      const title = await page.locator(".kx-rv-record-title").textContent();
      titles.push(title);
      if (/survey of gym/.test(title)) {
        // The rule suggests excluding the 1987 record.
        await page.locator(".kx-rv-suggestion").getByText("Not met: Year is 2000 or later").waitFor();
        await shot(page, "07-screen-suggestion");
      }
      const key = /rats|Editorial|survey|Cycling/.test(title) ? "e" : /Pilates/.test(title) ? "m" : "i";
      await decide(key);
      if (i === 2) {
        // Undo brings the last record back.
        await page.keyboard.press("Meta+z");
        await page.locator(".kx-rv-notice", { hasText: "Took back" }).waitFor();
        await page.waitForFunction((t) => document.querySelector(".kx-rv-record-title")?.textContent === t, title);
        await decide(key);
      }
    }
    await page.locator(".kx-rv-done").waitFor();
    await shot(page, "08-screen-done");
    s = await summary();
    report.ta = s.stages.ta;
    assert.equal(s.stages.ta.done, 10);
    assert.equal(s.stages.ta.excluded, 4);

    // The list view.
    await page.getByRole("radio", { name: "List" }).click();
    await page.getByRole("combobox", { name: "Show" }).selectOption("all");
    await page.locator(".kx-rv-list-row .kx-rv-list-title").first().waitFor();
    await shot(page, "09-list");

    // Full text: the first record gets a PDF from the library; it opens in the reader beside.
    const pdf = path.resolve(__dirname, "../../../../../tests/fixtures/scientific-unlinked.pdf");
    const info = await call("library_import_file", { path: pdf });
    const source = await call("store_source", { id: info.id });
    assert(source?.id, "the PDF is in the library");
    await page.getByRole("tab", { name: /Full text/ }).click();
    await page.locator(".kx-rv-record-title").waitFor();
    const firstFt = (await call("review_queue", { reviewId, stage: "ft", viewer: s.team[0].id, filter: "" }))[0];
    await call("review_fulltext", { reviewId, recordId: firstFt, sourceId: source.id, actor: s.team[0].id });
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("tab", { name: /Full text/ }).click();
    await page.getByRole("button", { name: "Open full text beside" }).click();
    for (let i = 0; i < 100 && !app.windows().some((w) => w.url().endsWith("/pdf.html")); i++) await page.waitForTimeout(100);
    assert(app.windows().some((w) => w.url().endsWith("/pdf.html")), "the reader opened");
    const groups = await page.evaluate(() => window.key.tabs().then((t) => t.groups?.length ?? 0));
    report.readerBeside = groups;
    await page.waitForTimeout(1500);
    await shot(page, "10-fulltext");
    // Back to the review (the reader took the focus).
    await page.locator(".kx-rv-decide-head").click();
    for (let i = 0; i < 12 && !(await page.locator(".kx-rv-done").count()); i++) {
      // The reader beside may hold the keyboard: give it back to the review.
      await page.locator(".kx-rv-decide-head").click();
      const title = await page.locator(".kx-rv-record-title").textContent();
      if (/Pilates/.test(title)) {
        await page.keyboard.press("e");
        await page.locator(".kx-rv-criteria-pick[data-picking]").waitFor();
        await shot(page, "11-fulltext-reasons");
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        await shot(page, "11-fulltext-reasons-dark");
        await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
        const before = title;
        // The criteria are the choices: 1 is the population criterion (the first at full text).
        await page.keyboard.press("1");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), before);
      } else await decide("i");
      if (await page.locator(".kx-rv-done").count()) break;
    }
    // Close the reader: the rest is looked at full width.
    await page.evaluate((id) => window.key.tabAction("close-view", { viewId: id }), `pdf:${ws.id}:${info.hash}`);
    await page.waitForFunction(() => window.key.tabs().then((t) => (t.groups?.length ?? 1) === 1));
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
    await call("review_decide", { reviewId, recordIds: [fresh], stage: "ta", value: "exclude", reasons: [], note: "Not an exercise intervention", actor: second.id });
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
