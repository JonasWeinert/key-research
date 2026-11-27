// Risk of bias and certainty of evidence in the real app, with invented studies: two assessors
// assess studies for one outcome (blind), differ on a domain → a conflict → agreed in the
// domain; the reader's selection becomes support with its place; the traffic-light and
// summary plots render (light and dark); the analysis without the studies at high risk changes
// the pooled estimate and the forest plot carries the risk-of-bias columns; GRADE suggestions
// appear, the reviewer rates down with a footnote; the Summary of findings shows absolute
// effects and certainty, and its export contains them. No network. Screenshots go to the
// printed temp folder.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

// Invented trials of a made-up balance programme: two large ones at low risk, two small ones at
// high risk with bigger effects.
const STUDIES = [
  ["Balance classes and falls in a coastal town: a randomised trial", "Quill, Ada", 2014, [30, 300, 40, 300]],
  ["Home balance training for falls: a randomised trial", "Rowe, Bea", 2016, [28, 280, 36, 280]],
  ["A small trial of balance boards", "Sato, Cy", 2018, [5, 60, 20, 60]],
  ["Balance games for older adults: a pilot trial", "Tran, Di", 2020, [4, 50, 18, 50]],
];

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

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-certainty-"));
  const pdf = path.join(temp, "quill-2014.pdf");
  await writeFile(pdf, pdfWith([STUDIES[0][0], "Ada Quill", "Allocation used sealed opaque envelopes prepared by a statistician.", "Falls were counted from diaries over twelve months."]));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = async (page, name) => {
    await page.waitForTimeout(350);
    for (const notice of await page.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.screenshot({ path: path.join(temp, `${name}.png`) });
  };
  const both = async (page, name) => {
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    await page.getByRole("navigation", { name: "Systematic reviews" }).getByRole("button", { name: "Reviews", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "New systematic review" });
    await sheet.getByRole("textbox", { name: "Review name" }).fill("Balance training and falls (smoke)");
    await sheet.getByRole("textbox", { name: "Your name" }).fill("Ana Example");
    await sheet.getByRole("button", { name: "Create review" }).click();
    await page.getByRole("heading", { name: "Balance training and falls (smoke)" }).waitFor();
    const [review] = await call("review_list");
    const reviewId = review.id;
    let s = await call("review_get", { reviewId, viewer: "" });
    const ana = s.team[0].id;
    const ben = "m-ben";
    await call("review_team_save", { reviewId, members: [...s.team, { id: ben, name: "Ben Example", roles: ["reviewer"], initials: "BE" }], actor: ana });
    const protocol = s.protocol;
    protocol.rules.ta.reviewers = 1;
    protocol.rules.ft.reviewers = 1;
    protocol.rules.extractors = 2;
    protocol.question.parts = { ...(protocol.question.parts ?? {}), i: "balance training" };
    protocol.forms.push((await call("review_form_templates")).find((f) => f.id === "f-outcomes"));
    await call("review_protocol_save", { reviewId, protocol, note: "", actor: ana, rescreen: false });
    await call("review_import_records", { reviewId, records: STUDIES.map(([title, author, year]) => ({ title, authors: [author], year, abstractText: `${title}. Invented for a test.` })), batch: { group: "databases", name: "Example database" }, actor: ana });
    const ids = (await call("review_records", { reviewId, viewer: ana, query: { stage: "ta", filter: "all", scope: "sources" } })).rows.map((r) => r.id);
    const byTitle = {};
    for (const id of ids) byTitle[(await call("review_record", { reviewId, recordId: id, stage: "ta", viewer: ana })).meta.title] = id;
    const study = STUDIES.map(([t]) => byTitle[t]);
    for (const [i, id] of study.entries()) {
      await call("review_decide", { reviewId, recordIds: [id], stage: "ta", value: "include", reasons: [], note: "", actor: ana });
      await call("review_decide", { reviewId, recordIds: [id], stage: "ft", value: "include", reasons: [], note: "", actor: ana });
      const [e1, n1, e2, n2] = STUDIES[i][3];
      await call("review_extract", { reviewId, recordId: id, formId: "f-outcomes", fieldId: "outcomes", value: [{ outcome: "Falls", timepoint: "12 months", type: "Dichotomous", e1, n1, e2, n2 }], quote: "Table 2", page: 3, final: true, actor: ana });
    }
    await call("review_fulltext_attach", { reviewId, recordId: study[0], path: pdf, name: "quill-2014.pdf", origin: "upload", actor: ana });
    const RESULT = "Falls|12 months";
    const tool = (await call("review_rob_tools", { reviewId })).tools.find((t) => t.id === "rob2");
    // Answers that make Key suggest `level` in every domain, then each suggestion taken.
    // RoB 2 ships as structure only (its questions are in the official tool): each domain's
    // judgement is recorded with its basis; the overall takes Key's worst-domain default.
    const assess = async (id, who, level, except = {}) => {
      for (const d of tool.domains) {
        const value = except[d.id] ?? level;
        await call("review_rob_answer", { reviewId, studyId: id, result: RESULT, domain: d.id, question: null, value, support: "From the official tool's questions", actor: who });
      }
      const view = await call("review_rob_assessment", { reviewId, studyId: id, result: RESULT, viewer: who });
      await call("review_rob_answer", { reviewId, studyId: id, result: RESULT, domain: "overall", question: null, value: view.suggestions.overall.level, actor: who });
      await call("review_rob_complete", { reviewId, studyId: id, result: RESULT, complete: true, actor: who });
    };
    for (const [i, id] of study.entries()) if (i > 0) for (const who of [ana, ben]) await assess(id, who, i < 2 ? "low" : "high");

    // Ana assesses the first study in the app, with the full text beside.
    await page.getByRole("tab", { name: /Risk of bias/ }).click();
    const side = page.getByRole("complementary", { name: "Risk-of-bias assessment" });
    await side.waitFor();
    await page.getByRole("combobox", { name: "Study and result" }).selectOption({ label: `Quill (2014) · Falls · 12 months` }).catch(async () => {
      const value = await page.getByRole("combobox", { name: "Study and result" }).locator("option", { hasText: "Quill" }).first().getAttribute("value");
      await page.getByRole("combobox", { name: "Study and result" }).selectOption(value);
    });
    await side.getByRole("heading", { name: /Quill/ }).waitFor();
    await side.getByText("Key provides the assessment structure; the questions are in the official tool.").waitFor();
    const d1 = side.locator("fieldset", { hasText: "Randomisation" }).first();
    assert.equal(await d1.getByRole("link", { name: /Open the official tool/ }).getAttribute("href"), "https://www.riskofbias.info/welcome/rob-2-0-tool");
    await d1.getByRole("radio", { name: /Low risk/ }).click();
    await d1.getByRole("radio", { name: /Low risk/ }).and(page.locator("[aria-checked=true]")).waitFor();
    await d1.getByPlaceholder(/Basis for the judgement/).fill("Sequence and concealment both adequate per the official tool");
    await d1.locator(".kx-rob-judge-head > span").first().click();
    // A passage selected in the reader is kept as support for the domain in focus.
    const span = page.locator(".kx-rv-reader .pdfjs-text-layer span", { hasText: "sealed opaque envelopes" }).first();
    await span.waitFor({ timeout: 30000 });
    await d1.locator(".kx-rob-judge-head > span").first().click();
    const box = await span.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    // The selection menu offers the domain in focus first (S), every other by its number.
    await page.locator(".ksm[data-mode=rob] [data-action=rob-support]").waitFor();
    await page.keyboard.press("s");
    await d1.locator(".kx-rob-evidence .kx-rv-source-chip").waitFor();
    // The passage is a mark in the page.
    await page.locator(".kx-rv-reader .pdfjs-host-mark.tone-evidence").first().waitFor();
    await both(page, "01-rob-assess");
    // The rest through the host, the same way; then Ben, who judges D1 differently.
    await assess(study[0], ana, "low");
    const evidence = (await call("review_rob_assessment", { reviewId, studyId: study[0], result: RESULT, viewer: ana })).mine.evidence;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].page, 0);
    assert.ok(evidence[0].rects.length > 0, "the passage keeps its place");
    const blind = await call("review_rob_assessment", { reviewId, studyId: study[0], result: RESULT, viewer: ben });
    assert.equal(blind.canSeeOthers, false);
    await assess(study[0], ben, "low", { d1: "some" });
    const overview = await call("review_rob_overview", { reviewId, viewer: ana });
    assert.equal(overview.totals.conflicts, 1);
    assert.deepEqual(overview.conflicts[0].domains, ["Randomisation", "Overall"]);

    // The conflict, then settled in the domain.
    await page.getByRole("radio", { name: /Conflicts \(1\)/ }).click();
    await page.getByRole("button", { name: "Settle" }).click();
    await side.locator("fieldset[data-conflict]").first().waitFor();
    await both(page, "02-rob-conflict");
    await side.getByRole("button", { name: "Agree on a judgement" }).first().click();
    await page.getByRole("menuitemcheckbox", { name: "Some concerns" }).click();
    await side.getByText("Agreed:").first().waitFor();
    await side.locator("fieldset", { hasText: "Overall judgement" }).getByRole("button", { name: "Agree on a judgement" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Some concerns" }).click();
    for (let i = 0; i < 50 && (await call("review_rob_overview", { reviewId, viewer: ana })).totals.done < 4; i++) await page.waitForTimeout(100);
    assert.equal((await call("review_rob_overview", { reviewId, viewer: ana })).totals.done, 4);

    // Plots for the outcome, light and dark.
    await page.getByRole("radio", { name: "Plots" }).click();
    await page.getByRole("combobox", { name: "Result" }).selectOption(RESULT);
    await page.locator("svg.kx-traffic g[data-symbol=cross]").first().waitFor();
    assert.equal(await page.locator("svg.kx-traffic g[data-symbol]").count() > 20, true);
    assert.equal(await page.locator("svg.kx-rob-summary").count(), 2);
    await both(page, "03-rob-plots");
    const plots = await call("review_rob_plots", { reviewId, toolId: "rob2", result: RESULT, options: { measure: "RR", method: "reml", hartungKnapp: false, level: 0.95 } });
    assert.equal(plots.rows.length, 4);
    assert.ok(plots.weighted);
    // Tools and set-up: the shipped tools, and the builder for a custom one.
    await page.getByRole("radio", { name: "Tools and set-up" }).click();
    await page.getByRole("cell", { name: /Diagnostic accuracy studies/ }).first().waitFor();
    await shot(page, "03b-rob-tools");
    await page.getByRole("button", { name: "New tool" }).click();
    const editor = page.locator(".kx-rob-editor");
    await editor.waitFor();
    await shot(page, "03c-rob-tool-builder");
    await editor.getByRole("button", { name: "Cancel" }).click();
    await editor.waitFor({ state: "detached" });

    // Analysis: the forest plot's risk-of-bias columns, and the estimate without high risk.
    await page.getByRole("tab", { name: /^Analysis/ }).click();
    await page.locator("svg.kx-forest g[data-symbol]").first().waitFor();
    const headline = () => page.locator(".kx-rv-headline strong").textContent();
    const all = await headline();
    await shot(page, "04-analysis-rob-columns");
    await page.getByRole("radio", { name: "Without high risk" }).click();
    await page.waitForFunction((before) => document.querySelector(".kx-rv-headline strong")?.textContent !== before, all);
    const low = await headline();
    assert.notEqual(low, all);
    await page.getByText(/Left out at high risk of bias/).waitFor();
    await both(page, "05-analysis-without-high-risk");
    const opts = { measure: "RR", method: "reml", hartungKnapp: false, level: 0.95 };
    const ra = await call("review_rob_analyse", { reviewId, outcome: "Falls", timepoint: "12 months", options: opts, subgroups: false, mode: "excludeHigh" });
    assert.equal(ra.analysis.main.k, 2);
    assert.ok(ra.analysis.main.estimate > ra.rob.all.estimate, "without the high-risk trials the effect shrinks");

    // Certainty: from the analysis, suggestions appear; rate down for risk of bias with a footnote.
    await page.getByRole("radio", { name: "All studies" }).click();
    await page.getByRole("button", { name: "Rate certainty…" }).click();
    await page.getByRole("heading", { name: "Falls · 12 months" }).waitFor();
    await page.locator(".kx-gr-domain[data-domain=riskOfBias] .kx-gr-suggest", { hasText: "Key suggests" }).waitFor();
    await page.locator(".kx-gr-domain[data-domain=imprecision] .kx-gr-suggest", { hasText: "Key suggests" }).waitFor();
    const rob = page.locator(".kx-gr-domain[data-domain=riskOfBias]");
    await rob.getByRole("radio", { name: "Serious (−1)" }).click();
    await page.getByRole("button", { name: "Save rating" }).click();
    await page.locator(".kx-gr-main .kx-inline-error", { hasText: "footnote" }).waitFor();
    await rob.getByRole("textbox", { name: "Risk of bias footnote" }).fill("Two small trials without concealed allocation carry larger effects");
    for (const id of ["inconsistency", "indirectness", "imprecision", "publicationBias"]) {
      const d = page.locator(`.kx-gr-domain[data-domain=${id}]`);
      const use = d.getByRole("button", { name: "Use" });
      if (await use.count()) await use.click();
      else await d.getByRole("radio", { name: "Not serious" }).click();
      const note = d.getByRole("textbox");
      if (await note.count()) await note.fill(`Explained for ${id}`);
    }
    await both(page, "06-certainty-outcome");
    await page.getByRole("button", { name: "Save rating" }).click();
    await page.getByRole("button", { name: "Save changes" }).waitFor();
    const outcome = await call("review_grade_outcome", { reviewId, key: RESULT });
    assert.equal(outcome.rating.domains.riskOfBias.judgement, "serious");
    assert.ok(outcome.rating.domains.riskOfBias.suggested, "Key's suggestion is kept beside the judgement");
    // The Summary of findings, and its export.
    await page.getByRole("radio", { name: /Summary of findings/ }).click();
    await page.locator(".kx-gr-sof tbody tr").first().waitFor();
    const row = await page.locator(".kx-gr-sof tbody tr").first().textContent();
    assert.match(row, /fewer per 1,000/);
    assert.match(row, /(Moderate|Low|Very low)/);
    await both(page, "07-summary-of-findings");
    const md = (await call("review_export", { reviewId, kind: "sof-md", viewer: ana })).content;
    assert.match(md, /fewer per 1,000/);
    assert.match(md, /Two small trials without concealed allocation/);
    assert.match(md, /⊕/);
    const html = (await call("review_export", { reviewId, kind: "sof-html", viewer: ana })).content;
    assert.match(html, /<table>/);
    const csv = (await call("review_export", { reviewId, kind: "rob-csv", viewer: ana })).content;
    assert.match(csv, /sealed opaque envelopes/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, all, withoutHigh: low, certainty: outcome.certainty.label, screenshots: temp }, null, 2));
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
