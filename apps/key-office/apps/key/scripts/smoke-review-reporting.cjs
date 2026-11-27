// std-A: a review's reporting in the real app, with invented records: fill a few protocol
// fields in Setup › Protocol, record the registration, change a criterion (an amendment with
// its reason, logged as a deviation), open Overview › PRISMA checklist (evidenced and missing
// items, a link that opens where an item is evidenced), generate the methods section (the
// review's numbers in it), and complete a file import's PRISMA-S details in the search report,
// whose export then carries each source's strategy and dates. No network. Screenshots (light
// and dark) go to the printed temp folder.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const STUDIES = [
  ["Walking groups and blood pressure in older adults", "Rivera, Ana", 2016, "10.9999/walk.1"],
  ["Walking groups and blood pressure in older adults", "Rivera, Ana", 2016, "10.9999/walk.1"],
  ["Stretching breaks at work", "Okafor, Ben", 2019, "10.9999/stretch.2"],
  ["Cycling to school and fitness", "Haas, Dev", 2021, "10.9999/cycle.4"],
  ["Yoga for chronic low back pain", "Moreau, Eli", 2018, "10.9999/yoga.5"],
  ["Tai chi and balance in older people", "Ito, Fay", 2017, "10.9999/taichi.6"],
];
const ris = STUDIES.map(([t, a, y, d]) => ["TY  - JOUR", `TI  - ${t}`, `AU  - ${a}`, `PY  - ${y}`, `DO  - ${d}`, "AB  - An invented abstract.", "ER  - "].join("\n")).join("\n");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-reporting-"));
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_DB_SEARCH_MOCK: "0" },
  });
  const shot = async (page, name) => {
    await page.waitForTimeout(300);
    for (const n of await page.locator(".kx-rv-notice").all()) await n.click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.screenshot({ path: path.join(temp, `${name}.png`) });
  };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    await page.getByRole("navigation", { name: "Systematic reviews" }).getByRole("button", { name: "Reviews", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "New systematic review" });
    await sheet.getByRole("textbox", { name: "Review name" }).fill("Walking and blood pressure (smoke)");
    await sheet.getByRole("textbox", { name: "Your name" }).fill("Ana Example");
    await sheet.getByRole("button", { name: "Create review" }).click();
    await page.getByRole("heading", { name: "Walking and blood pressure (smoke)" }).waitFor();
    const [review] = await call("review_list");
    const reviewId = review.id;
    const summary = () => call("review_get", { reviewId, viewer: "" });
    let s = await summary();
    const ana = s.team[0].id;

    // A protocol to start from: question, criteria, two screeners; records from a file import
    // (no platform, date or strategy yet) and from citation searching.
    const protocol = s.protocol;
    protocol.question = { framework: "pico", text: "Do walking groups lower blood pressure in older adults?", parts: { p: "older adults", i: "walking groups", c: "usual care", o: "systolic blood pressure" } };
    protocol.criteria = (await call("review_criteria_suggestions", { reviewId, question: protocol.question })).criteria;
    await call("review_protocol_save", { reviewId, protocol, note: "", actor: ana, rescreen: false });
    await call("review_team_save", { reviewId, actor: ana, members: [...s.team, { id: "ben", name: "Ben Example", roles: ["reviewer"], initials: "BE" }] });
    const imported = await call("review_import_file", { reviewId, text: ris, fileName: "embase.ris", actor: ana, batch: { name: "Embase", group: "databases" } });
    assert.equal(imported.report.duplicates, 1);
    await call("review_import_records", { reviewId, actor: ana, batch: { kind: "other", group: "other", name: "Citation searching", strategy: "Reference lists of included studies, checked by hand" }, records: [{ title: "Nordic walking and blood pressure", authors: ["Berg, Gus"], year: 2020 }] });

    // Setup › Protocol: write the rationale and funding; they save as typed (no decisions yet).
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("navigation", { name: "Setup sections" }).getByRole("button", { name: "Protocol", exact: true }).click();
    const builder = page.getByTestId("protocol-builder");
    await builder.waitFor();
    const before = await builder.getByTestId("protocol-completeness").textContent();
    await builder.getByRole("textbox", { name: "Rationale", exact: true }).fill("High blood pressure is common in older adults, and walking groups are cheap to run.");
    await builder.getByRole("textbox", { name: "Funding and other support", exact: true }).fill("None.");
    await builder.getByRole("textbox", { name: "Competing interests", exact: true }).fill("None declared.");
    for (let i = 0; i < 60 && !(await summary()).protocol.plan?.text?.conflicts; i++) await page.waitForTimeout(100);
    s = await summary();
    assert.equal(s.protocol.plan.text.rationale.startsWith("High blood pressure"), true);
    await builder.getByTestId("protocol-completeness").filter({ hasNotText: before }).waitFor();
    // Key's own text for the selection process, from the rules.
    await builder.getByText(/Titles and abstracts are screened by one reviewer/).waitFor();
    await shot(page, "01-protocol");

    // Register: the protocol locks.
    await builder.getByRole("button", { name: "Record registration…" }).click();
    const reg = page.getByRole("dialog", { name: "Protocol registration" });
    await reg.getByRole("radio", { name: "OSF" }).click();
    await reg.getByRole("textbox", { name: "Registration number" }).fill("osf.io/abcde");
    await reg.getByRole("textbox", { name: "Address" }).fill("https://osf.io/abcde");
    await shot(page, "02-register-sheet");
    await reg.getByRole("button", { name: "Register and lock" }).click();
    await builder.getByTestId("registered").waitFor();
    s = await summary();
    assert.equal(s.reporting.locked, true);

    // Change a criterion: Setup asks for the reason and saves an amendment.
    await page.getByRole("navigation", { name: "Setup sections" }).getByRole("button", { name: /^Criteria/ }).click();
    const first = page.getByRole("textbox", { name: "Criterion" }).first();
    await first.fill("Adults aged 60 or over");
    const bar = page.getByRole("region", { name: "Save protocol changes" });
    await bar.getByText(/The protocol is registered/).waitFor();
    assert.equal(await bar.getByRole("button", { name: /^Save version/ }).isDisabled(), true);
    await bar.getByRole("textbox", { name: "Change note" }).fill("Older adults defined as 60 or over, as in national guidance");
    await shot(page, "03-amendment-bar");
    await bar.getByRole("button", { name: /^Save version/ }).click();
    await bar.waitFor({ state: "detached" });
    await page.getByRole("navigation", { name: "Setup sections" }).getByRole("button", { name: "Protocol", exact: true }).click();
    const deviations = page.getByTestId("deviations");
    await deviations.getByText(/Criterion reworded/).waitFor();
    await deviations.getByText("Older adults defined as 60 or over, as in national guidance").waitFor();
    await shot(page, "04-deviations");

    // Screening: two reviewers on four records, then full text for the included one.
    const rows = (await call("review_records", { reviewId, viewer: ana, query: { stage: "ta", filter: "undecided" } })).rows;
    assert.equal(rows.length, 6, "5 from Embase after de-duplication, 1 from citation searching");
    const decide = (recordIds, stage, value, actor) => call("review_decide", { reviewId, recordIds, stage, value, reasons: [], note: "", evidence: [], actor });
    const yoga = rows.find((r) => r.title.startsWith("Yoga")).id;
    for (const r of rows) await decide([r.id], "ta", r.id === yoga ? "include" : "exclude", ana);
    await decide([yoga], "ft", "include", ana);

    // Overview › PRISMA checklist.
    await page.getByRole("tab", { name: /Overview/ }).click();
    await page.getByRole("radio", { name: "PRISMA checklist" }).click();
    const checklist = page.getByTestId("prisma-checklist");
    await checklist.waitFor();
    const item = (id) => checklist.locator(`[data-item="prisma2020:${id}"]`);
    assert.equal(await item("3").getAttribute("data-status"), "evidenced");
    assert.equal(await item("24a").getAttribute("data-status"), "evidenced");
    assert.equal(await item("24c").getAttribute("data-status"), "evidenced");
    assert.equal(await item("14").getAttribute("data-status"), "missing");
    assert.equal(await item("22").getAttribute("data-status"), "notRecorded");
    await item("24c").getByRole("button").first().click();
    await item("24c").getByText(/amended once after registration/).waitFor();
    await shot(page, "05-checklist");
    // A missing manuscript item becomes evidenced with its location.
    await item("1").getByRole("button").first().click();
    await item("1").getByRole("textbox", { name: "Where item 1 is reported" }).fill("Title page");
    await item("1").getByRole("textbox", { name: "Where item 1 is reported" }).press("Enter");
    await checklist.locator('[data-item="prisma2020:1"][data-status="evidenced"]').waitFor();
    // Its link opens where it is evidenced: Setup › Protocol.
    await item("24c").getByRole("button", { name: /Setup › Protocol › Deviations from protocol/ }).click();
    await page.getByTestId("protocol-builder").waitFor();
    await page.getByRole("tab", { name: /Overview/ }).click();
    await page.getByRole("radio", { name: "PRISMA checklist" }).click();
    await checklist.waitFor();

    // Methods section: the review's numbers.
    await checklist.getByRole("button", { name: "Generate methods section" }).click();
    const methods = page.getByTestId("methods-draft");
    await methods.waitFor();
    const text = await methods.textContent();
    // 6 from Embase, 1 duplicate, 5 screened (4 excluded), 1 included; 1 from citation searching.
    for (const want of ["identified 6 records", "removing 1 duplicate,", "5 records were screened", "4 excluded", "1 study (1 report)", "registered with OSF (osf.io/abcde)", "Embase", "Key v"]) assert.ok(text.includes(want), `methods draft lacks “${want}”: ${text}`);
    await shot(page, "06-methods");
    await page.getByRole("button", { name: "Done" }).click();

    // Search report: the file import needs its platform, date and strategy; complete them.
    await page.getByRole("radio", { name: "Search report" }).click();
    const report = page.getByTestId("search-report");
    await report.locator('tr[data-source="Embase"]').getByText(/Needs/).waitFor();
    await shot(page, "07-search-report");
    await report.locator('tr[data-source="Embase"]').getByRole("button", { name: "Complete…" }).click();
    const details = page.getByRole("dialog", { name: "Details of Embase" });
    await details.getByRole("textbox", { name: "Platform" }).fill("Ovid");
    await details.getByRole("textbox", { name: "Coverage" }).fill("1974 to 2026 week 40");
    await details.getByLabel("Date searched").fill("2026-10-02");
    await details.getByRole("textbox", { name: "Strategy as run" }).fill("1 exp walking/\n2 exp blood pressure/\n3 1 and 2");
    await details.getByRole("checkbox", { name: "No limits were used" }).check();
    await shot(page, "08-source-sheet");
    await details.getByRole("button", { name: "Save" }).click();
    await report.locator('tr[data-source="Embase"]').getByText("Complete").waitFor();
    await report.getByRole("button", { name: "Record…" }).click();
    const press = page.getByRole("dialog", { name: "Peer review of the search" });
    await press.getByRole("textbox", { name: "Reviewed by" }).fill("Cara Example (librarian)");
    await press.getByLabel("Date of the peer review").fill("2026-09-30");
    await press.getByRole("button", { name: "Save" }).click();
    await report.getByText("Cara Example (librarian), 2026-09-30 (PRESS 2015)").waitFor();
    const exported = await call("review_report_export", { reviewId, kind: "search-report" });
    for (const want of ["### Embase", "Platform: Ovid", "Coverage: 1974 to 2026 week 40", "Date searched: 2026-10-02", "1 exp walking/", "Citation searching", "Cara Example (librarian) on 2026-09-30"]) assert.ok(exported.content.includes(want), `search report lacks “${want}”`);
    const csv = await call("review_report_export", { reviewId, kind: "search-report-csv" });
    assert.ok(csv.content.includes("Ovid") && csv.content.includes("2026-10-02"));
    const json = JSON.parse((await call("review_report_export", { reviewId, kind: "search-report-json" })).content);
    assert.equal(json.format, "key-prisma-s");
    await shot(page, "09-search-report-complete");
    const checklistMd = (await call("review_report_export", { reviewId, kind: "prisma-checklist" })).content;
    assert.ok(checklistMd.includes("Title page") && checklistMd.includes("CC BY 4.0"));

    // Dark mode.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "10-search-report-dark");
    await page.getByRole("radio", { name: "PRISMA checklist" }).click();
    await checklist.waitFor();
    await item("8").getByRole("button").first().click();
    await shot(page, "11-checklist-dark");
    await page.getByRole("tab", { name: /Setup/ }).click();
    await page.getByRole("navigation", { name: "Setup sections" }).getByRole("button", { name: "Protocol", exact: true }).click();
    await page.getByTestId("protocol-builder").waitFor();
    await shot(page, "12-protocol-dark");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: temp }));
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
