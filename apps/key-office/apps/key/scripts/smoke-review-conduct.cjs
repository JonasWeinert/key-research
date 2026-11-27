// std-B's review standards in the real app, fully mocked (no network): citation searching from
// two included studies against recorded OpenAlex answers (KEY_OPENALEX_FIXTURES, written here),
// counted before import and added as "Citation searching" under PRISMA's other methods; AI
// screening suggestions from a local OpenAI-compatible mock, accepted and rejected, a blind
// audit sample, the agreement table and the AI-use statement; the Overview's Conduct panel
// with a warning dismissed with a reason; an extraction pilot whose agreement report records
// "forms piloted"; a contact with the authors. Screenshots (light and dark) go to the printed folder.
const { electron } = require("./lib/launch.cjs");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const STUDIES = [
  ["Walking groups and blood pressure in older adults: a randomised trial", "Rivera, Ana", 2016, "10.9999/walk.1", "Adults over 65 were randomised to weekly walking groups."],
  ["Stretching breaks at work: a cluster randomised trial", "Okafor, Ben", 2019, "", "Offices were randomised to stretching breaks."],
  ["Cycling to school and fitness in children", "Haas, Dev", 2021, "10.9999/cycle.4", "A cohort of children who cycled to school."],
  ["Yoga for chronic low back pain: a randomised trial", "Moreau, Eli", 2018, "10.9999/yoga.5", "Adults with back pain were randomised to yoga or a booklet."],
  ["Tai chi and balance in older people: randomised controlled trial", "Ito, Fay", 2017, "10.9999/taichi.6", "Older people were randomised to tai chi or stretching."],
  ["A survey of gym membership", "Berg, Gus", 1987, "", "A survey of gym members about their habits."],
  ["Pilates versus usual care for neck pain: a randomised trial", "Silva, Hana", 2020, "10.9999/pilates.8", "Adults with neck pain were randomised to pilates."],
];
const ris = STUDIES.map(([t, a, y, d, ab]) => ["TY  - JOUR", `TI  - ${t}`, `AU  - ${a}`, `PY  - ${y}`, d && `DO  - ${d}`, `AB  - ${ab}`, "JO  - Journal of Invented Examples", "ER  - "].filter(Boolean).join("\n")).join("\n");

// The scholarly graph as OpenAlex would answer: the two seeds, what they cite, what cites them.
const oa = (id, doi, title, year, author, refs = []) => ({
  id: `https://openalex.org/${id}`,
  doi: doi ? `https://doi.org/${doi}` : null,
  display_name: title,
  publication_year: year,
  type: "article",
  authorships: [{ author: { display_name: author } }],
  primary_location: { source: { display_name: "Journal of Invented Examples" } },
  referenced_works: refs.map((r) => `https://openalex.org/${r}`),
  abstract_inverted_index: { An: [0], invented: [1], abstract: [2] },
});
const GRAPH = [
  oa("W501", "10.9999/walk.1", "Walking groups and blood pressure in older adults: a randomised trial", 2016, "Ana Rivera", ["W510", "W511", "W503"]),
  oa("W502", null, "Stretching breaks at work: a cluster randomised trial", 2019, "Ben Okafor", ["W511", "W512"]),
  oa("W503", "10.9999/cycle.4", "Cycling to school and fitness in children", 2021, "Dev Haas"),
  oa("W510", "10.9999/ref.10", "Pedometers and daily step counts in older adults", 2010, "Jo Kim"),
  oa("W511", "10.9999/ref.11", "Physical activity guidelines for adults revisited", 2012, "Mo Lund"),
  oa("W512", null, "Desk breaks and back pain in office workers", 2014, "Lu Pires"),
  oa("W520", "10.9999/cite.20", "Workplace and community exercise programmes: a review", 2022, "Sam Ito", ["W501", "W502"]),
  oa("W521", "10.9999/cite.21", "Group walking for hypertension: a pragmatic trial", 2023, "Rae Diaz", ["W501"]),
];

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-conduct-"));
  const fixtures = path.join(temp, "openalex");
  await mkdir(fixtures);
  for (const w of GRAPH) await writeFile(path.join(fixtures, `${w.id.split("/").pop()}.json`), JSON.stringify(w));
  // Crossref has no notice for the included studies.
  await writeFile(path.join(fixtures, "crossref-updates.json"), JSON.stringify({ message: { items: [] } }));
  const file = path.join(temp, "search.ris");
  await writeFile(file, ris);
  // The AI provider: includes what mentions "randomised", excludes the rest.
  const asked = [];
  const ai = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "mock-screener" }] }));
      const parsed = JSON.parse(body || "{}");
      const prompt = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      asked.push(prompt);
      const include = /randomi[sz]ed/i.test(prompt);
      const answer = { decision: include ? "include" : "exclude", relevance: include ? 0.8 : 0.2, rationale: include ? "A randomised trial of exercise." : "Not a trial." };
      res.end(JSON.stringify({ model: "mock-screener-2026-10-01", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 300, completion_tokens: 20 } }));
    });
  });
  await new Promise((resolve) => ai.listen(0, "127.0.0.1", resolve));
  const aiBase = `http://localhost:${ai.address().port}/v1`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_OPENALEX_FIXTURES: fixtures, KEY_OPENALEX_ENABLED: "0" },
  });
  const report = {};
  const shot = async (page, name) => {
    await page.waitForTimeout(350);
    for (const notice of await page.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
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

    // AI assistant: the local mock.
    await call("ai_choose", { provider: "custom" });
    await call("ai_set_base_url", { provider: "custom", baseUrl: aiBase });
    await call("ai_set_model", { provider: "custom", model: "mock-screener" });

    // A review: two reviewers, AI on, the RIS imported, two studies included.
    const { reviewId, actor: ana } = await call("review_create", { name: "Movement and health (conduct smoke)", ownerName: "Ana Example" });
    await call("review_team_save", { reviewId, actor: ana, members: [{ id: ana, name: "Ana Example", roles: ["owner", "reviewer"], initials: "AE" }, { id: "ben", name: "Ben Second", roles: ["reviewer"], initials: "BS" }] });
    let s = await call("review_get", { reviewId, viewer: ana });
    const protocol = { ...s.protocol, rules: { ...s.protocol.rules, aiAssist: true } };
    await call("review_protocol_save", { reviewId, protocol, note: "", actor: ana, rescreen: false });
    const { readFile } = require("node:fs/promises");
    await call("review_import_file", { reviewId, text: await readFile(file, "utf8"), fileName: "search.ris", batch: { group: "databases", name: "PubMed", searchedAt: "2026-11-01" }, actor: ana });
    const rows = (await call("review_records", { reviewId, viewer: ana, query: { stage: "ta", filter: "all", scope: "sources", limit: 50 } })).rows;
    const id = (re) => rows.find((r) => re.test(r.title)).id;
    const seeds = [id(/^Walking/), id(/^Stretching/)];
    await call("review_decide", { reviewId, recordIds: seeds, stage: "ta", value: "include", reasons: [], note: "", actor: ana });
    await call("review_decide", { reviewId, recordIds: seeds, stage: "ft", value: "include", reasons: [], note: "", actor: ana });

    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Movement and health" }), { ws: ws.id, id: reviewId });
    await page.getByRole("heading", { name: "Movement and health (conduct smoke)" }).waitFor();

    // 1. Citation searching from the two included studies.
    await page.getByRole("tab", { name: /Sources/ }).click();
    await page.getByRole("radio", { name: /Citation searching/ }).click();
    const chase = page.locator(".kx-sb-chase");
    await chase.getByRole("list", { name: "Studies to start from" }).getByRole("checkbox").first().waitFor();
    assert.equal(await chase.getByRole("list", { name: "Studies to start from" }).getByRole("checkbox", { checked: true }).count(), 2, "both included studies are chosen");
    await shot(page, "01-chase-seeds");
    await chase.getByRole("button", { name: "Search citations" }).click();
    const tiles = chase.locator(".kx-sb-tiles");
    await tiles.waitFor();
    const tile = async (n) => Number((await tiles.locator("div").nth(n).locator("strong").innerText()).replace(/\D/g, ""));
    report.chase = { found: await tile(0), inReview: await tile(1), new: await tile(2) };
    assert.deepEqual(report.chase, { found: 6, inReview: 1, new: 5 }, "cycling is in the review already");
    await chase.locator(".kx-sb-seed-outcomes li", { hasText: "found by title" }).waitFor();
    await shot(page, "02-chase-found");
    await chase.getByRole("button", { name: "Add 5 new records" }).click();
    await chase.getByRole("table").getByRole("cell", { name: "5", exact: true }).first().waitFor();
    const prisma = await call("review_prisma", { reviewId });
    report.otherMethods = prisma.otherMethods;
    assert.deepEqual(prisma.otherMethods, [{ name: "Citation searching", count: 5 }]);
    s = await call("review_get", { reviewId, viewer: ana });
    const batch = s.batches.find((b) => b.batch.name === "Citation searching").batch;
    assert.equal(batch.group, "other");
    assert.match(batch.strategy, /OpenAlex/);
    await shot(page, "03-chase-round");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "03b-chase-round-dark");
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

    // 2. AI suggestions on four undecided records, a blind audit, decisions, agreement.
    const undecided = (await call("review_queue", { reviewId, stage: "ta", viewer: ana, filter: "" })).slice(0, 4);
    for (const r of undecided) await call("review_ai_suggest", { reviewId, recordId: r, stage: "ta" });
    const audit = await call("review_ai_audit_draw", { reviewId, task: "screening", stage: "ta", actor: ana });
    assert.equal(audit.records.length, 4, "max(10 %, 100) of 4 is all of them");
    const blind = await call("review_record", { reviewId, recordId: undecided[0], stage: "ta", viewer: ana });
    assert.equal(blind.ai, null, "hidden while in the blind audit");
    for (const [i, r] of undecided.entries()) {
      const view = await call("review_record", { reviewId, recordId: r, stage: "ta", viewer: "ben" });
      const ai = (await call("review_ai_use", { reviewId })).log.find((l) => l.log.recordId === r).log.output;
      // Accept the first two suggestions, reject the others.
      const value = i < 2 ? ai : ai === "include" ? "exclude" : "include";
      await call("review_decide", { reviewId, recordIds: [r], stage: "ta", value, reasons: [], other: value === "exclude" ? "Not relevant" : "", note: "", actor: ana });
      assert.ok(view);
    }
    const use = await call("review_ai_use", { reviewId });
    report.aiOutcomes = use.outcomes;
    assert.equal(use.outcomes.accepted, 2);
    assert.equal(use.outcomes.rejected, 2);
    assert.equal(use.log[0].log.modelReported, "mock-screener-2026-10-01");
    assert.equal(use.log[0].log.promptId, "screening");
    assert.equal(use.screening[0].agreement.n, 4);
    await call("review_ai_audit_close", { reviewId, auditId: audit.id, actor: ana });
    const statement = await call("review_export", { reviewId, kind: "ai-statement", viewer: ana });
    assert.match(statement.content, /never made a decision/);
    assert.match(statement.content, /Appendix: prompts/);
    assert.match(statement.content, /mock-screener/);

    // 3. Overview: the Conduct panel; dismiss a warning with a reason; AI use details.
    await page.getByRole("tab", { name: "Overview" }).click();
    const conduct = page.getByRole("region", { name: "Conduct" });
    await conduct.waitFor();
    const registers = conduct.locator('[data-check="registers"]');
    await conduct.locator(".kx-sb-warnings li").first().waitFor();
    await shot(page, "04-overview-conduct");
    // Quiet: four at first, the rest behind "more"; a row opens to say why and what to do.
    assert.ok((await conduct.locator(".kx-sb-warnings li").count()) <= 4);
    if (await conduct.getByRole("button", { name: /\d+ more$/ }).count()) await conduct.getByRole("button", { name: /\d+ more$/ }).click();
    await registers.waitFor();
    assert.equal(await conduct.locator('[data-check="citation-searching"]').count(), 0, "citations were searched");
    await registers.getByRole("button", { name: /No trial register searched/ }).click();
    await shot(page, "04b-conduct-open");
    await registers.getByRole("button", { name: /Not for this review/ }).click();
    const dismiss = page.getByRole("dialog", { name: "Dismiss a conduct check" });
    await dismiss.getByRole("textbox", { name: "Reason" }).fill("No trials are registered for this kind of intervention");
    await shot(page, "05-dismiss-sheet");
    await dismiss.getByRole("button", { name: "Dismiss", exact: true }).click();
    await conduct.getByRole("button", { name: /Show 1 dismissed check/ }).waitFor();
    assert.equal(await conduct.locator('ul:not([data-dismissed]) [data-check="registers"]').count(), 0);
    const c = await call("review_conduct", { reviewId });
    assert.equal(c.warnings.find((w) => w.id === "registers").dismissed.reason, "No trials are registered for this kind of intervention");
    // The retraction check from the panel.
    await conduct.locator('[data-check="retractions"]').getByRole("button", { name: /Retractions and errata/ }).click();
    await conduct.locator('[data-check="retractions"]').getByRole("button", { name: "Check now" }).click();
    await conduct.getByText(/Retractions checked/).waitFor();
    await conduct.getByRole("button", { name: "Details" }).click();
    const aiSheet = page.getByRole("dialog", { name: "AI use" });
    await aiSheet.getByRole("table", { name: "AI against the reviewers" }).waitFor();
    await shot(page, "06-ai-use");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "06b-ai-use-dark");
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await aiSheet.getByRole("button", { name: "Done" }).click();
    await aiSheet.waitFor({ state: "detached" });

    // 4. An extraction pilot with both reviewers on the two studies.
    await page.getByRole("tab", { name: /Extraction/ }).click();
    await page.getByRole("button", { name: "Pilot round" }).click();
    const pilotSheet = page.getByRole("dialog", { name: "Extraction pilot" });
    await pilotSheet.getByRole("button", { name: "Start the pilot" }).click();
    await pilotSheet.getByRole("button", { name: "Forms piloted" }).waitFor();
    const pilot = (await call("review_xpilots", { reviewId })).pilots[0].pilot;
    const designs = { [ana]: ["Randomised controlled trial", "Cluster randomised trial"], ben: ["Randomised controlled trial", "Randomised controlled trial"] };
    for (const who of [ana, "ben"])
      for (const [i, r] of pilot.records.entries()) {
        await call("review_extract", { reviewId, recordId: r, formId: "f-characteristics", fieldId: "design", value: designs[who][i], actor: who });
        await call("review_extract", { reviewId, recordId: r, formId: "f-characteristics", fieldId: "n_total", value: who === "ben" && i ? 210 : 200, actor: who });
      }
    await pilotSheet.getByRole("cell", { name: "Study design" }).waitFor();
    await shot(page, "07-pilot-report");
    await pilotSheet.getByRole("button", { name: "Forms piloted" }).click();
    await pilotSheet.locator(".kx-sb-statement-line", { hasText: "piloted on" }).waitFor();
    const piloted = await call("review_xpilots", { reviewId });
    report.pilot = { piloted: piloted.piloted.length, percent: piloted.pilots[0].percent };
    assert.equal(piloted.piloted.length, 1);
    assert.match(piloted.facts.statement, /with 2 studies by 2 extractors/);
    const design = piloted.pilots[0].fields.find((f) => f.fieldId === "design");
    assert.equal(design.percent, 50);
    await pilotSheet.getByRole("button", { name: "Done" }).click();

    // 5. A contact with the authors of the current study.
    await page.getByRole("button", { name: "Contact authors" }).click();
    const contact = page.getByRole("dialog", { name: "Contact with authors" });
    await contact.getByRole("textbox", { name: "Who" }).fill("Corresponding author");
    await contact.getByRole("textbox", { name: "What was asked" }).fill("Standard deviations at 12 months");
    await contact.getByRole("button", { name: "Save" }).click();
    await contact.getByRole("button", { name: /Corresponding author/ }).waitFor();
    await shot(page, "08-contact");
    await contact.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Contacts (1)" }).waitFor();
    const facts = await call("review_contacts", { reviewId });
    assert.equal(facts.contacts.length, 1);
    await shot(page, "09-extraction-tools");

    assert.deepEqual(errors, [], "no page errors");
    report.screenshots = temp;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
    ai.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
