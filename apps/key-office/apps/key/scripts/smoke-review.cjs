// A small systematic review from start to finish in the real app, with invented records:
// create it from the sidebar, import a RIS file (one duplicate), set criteria and keywords,
// screen titles and abstracts with the keyboard (including an undo and a rule suggestion),
// assess full texts with reasons, extract outcome data, run the meta-analysis and look at the
// PRISMA diagram and forest plot. Screenshots (light and dark) go to the printed temp folder.
const { _electron: electron } = require("playwright-core");
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

    // Setup: keywords and a linked criterion through the host (the editor is checked by eye).
    const protocol = s.protocol;
    protocol.keywords = { include: ["randomi*", "trial"], exclude: ["rats", "editorial", "survey"] };
    protocol.criteria = [
      { id: "c-rct", kind: "include", label: "Randomised controlled trial", guidance: "Individually or cluster randomised.", stages: ["ta", "ft"], reasonId: "r-design", link: null },
      { id: "c-year", kind: "include", label: "Published 2000 or later", guidance: "", stages: ["ta"], reasonId: "r-publication", link: { conditions: [{ field: "year", op: "ge", value: 2000 }], all: true, effect: "suggest" } },
      { id: "c-animal", kind: "exclude", label: "Animal studies", guidance: "", stages: ["ta", "ft"], reasonId: "r-population", link: null },
    ];
    protocol.forms.push((await call("review_form_templates")).find((f) => f.id === "f-outcomes"));
    await call("review_protocol_save", { reviewId, protocol, note: "", actor: s.team[0].id, rescreen: false });
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("button", { name: "Criteria", exact: false }).first().click();
    await page.locator(".kx-rv-criterion").nth(2).waitFor();
    assert.equal(await page.locator(".kx-rv-criterion-label").nth(1).inputValue(), "Published 2000 or later");
    await page.locator(".kx-rv-criterion").nth(1).getByRole("button", { name: "Show details" }).click();
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

    // Full text: exclude one with a reason (E then 1), include the rest.
    await page.getByRole("tab", { name: /Full text/ }).click();
    await page.locator(".kx-rv-record-title").waitFor();
    await shot(page, "10-fulltext");
    for (let i = 0; i < 6; i++) {
      const title = await page.locator(".kx-rv-record-title").textContent();
      if (/Pilates/.test(title)) {
        await page.keyboard.press("e");
        await page.locator(".kx-rv-reasons[data-picking]").waitFor();
        await shot(page, "11-fulltext-reasons");
        const before = title;
        await page.keyboard.press("2");
        await page.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), before);
      } else await decide("i");
      if (await page.locator(".kx-rv-done").count()) break;
    }
    s = await summary();
    report.ft = s.stages.ft;
    assert.equal(s.included, 5);

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
    await page.getByRole("tab", { name: /Extraction/ }).click();
    await page.locator(".kx-rv-xform").first().waitFor();
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

    // Dark mode.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "16-overview-dark");
    await page.getByRole("tab", { name: /Title & abstract/ }).click();
    await page.getByRole("radio", { name: "List" }).click();
    await shot(page, "17-list-dark");
    await page.getByRole("tab", { name: /Analysis/ }).click();
    await page.locator(".kx-forest").waitFor();
    await shot(page, "18-analysis-dark");
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
