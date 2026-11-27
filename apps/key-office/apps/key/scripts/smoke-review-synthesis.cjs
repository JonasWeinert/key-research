// The advanced synthesis in the real app (hidden test mode), with invented studies: a median
// and IQR converted in Extraction with the helper (the method is stored with the row), several
// estimates per study through the robust and three-level models, a meta-regression on one
// moderator, PET-PEESE shown, and the exports others import: the R script, RevMan Web's CSVs and
// the replication bundle (their zips are opened and their files checked). Screenshots (light
// and dark) go to the printed temp folder.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const assert = require("node:assert/strict");

/** File names and contents of a zip (deflate or stored), from its central directory. */
function unzip(b64) {
  const buf = Buffer.from(b64, "base64");
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Invented trials of a "programme" against usual care: dose (sessions per week), mean change
// in a symptom score. Two studies report two estimates (two scales); one reports a median and
// IQR for the programme arm.
const STUDIES = [
  ["Avery", 2012, 1, [[-4.1, 6.2, 40, -1.9, 6.0, 41]]],
  ["Brook", 2013, 2, [[-5.0, 5.8, 55, -2.2, 6.1, 52], [-4.4, 6.4, 55, -2.0, 6.3, 52]]],
  ["Carver", 2014, 2, [[-3.2, 7.0, 30, -2.8, 6.9, 31]]],
  ["Dalton", 2015, 3, [[-6.1, 6.5, 70, -2.5, 6.2, 69]]],
  ["Ellis", 2016, 3, [[-5.4, 5.9, 48, -1.7, 6.0, 50], [-5.9, 6.1, 48, -2.1, 5.8, 50]]],
  ["Foster", 2016, 1, [[-2.6, 6.8, 36, -2.0, 6.6, 35]]],
  ["Garner", 2017, 4, [[-7.2, 6.0, 62, -2.4, 6.4, 60]]],
  ["Hale", 2018, 2, [[-4.0, 6.3, 44, -2.6, 6.1, 45]]],
  ["Irwin", 2019, 4, [[-6.8, 5.7, 58, -2.2, 6.2, 57]]],
  ["Jarvis", 2020, 3, [[null, null, 64, -2.3, 6.0, 63]]],
  ["Keller", 2021, 5, [[-7.9, 6.1, 80, -2.0, 6.3, 82]]],
  ["Lowe", 2022, 1, [[-3.0, 6.9, 33, -2.7, 6.7, 34]]],
];

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-synthesis-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  const shot = async (page, name, top) => {
    if (top) await top.evaluate((e) => e.scrollIntoView({ block: "start" }));
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // A review with an outcome form and a dose field, set up through the host.
    const { reviewId, actor } = await call("review_create", { name: "Programme trials (synthesis smoke)", ownerName: "Ana Example" });
    let s = await call("review_get", { reviewId, viewer: actor });
    const templates = await call("review_form_templates");
    const outcomes = templates.find((f) => f.kind === "outcomes");
    const protocol = { ...s.protocol, rules: { ...s.protocol.rules, ta: { ...s.protocol.rules.ta, reviewers: 1 }, ft: { ...s.protocol.rules.ft, reviewers: 1 } } };
    protocol.forms = [
      ...protocol.forms,
      outcomes,
      { id: "f-chars", name: "Study characteristics", kind: "custom", sections: [{ id: "s-c", title: "Programme", guidance: "", fields: [{ id: "dose", label: "Sessions per week", kind: "number", guidance: "", required: false, quote: false, options: [], unit: "", columns: [], role: "", source: "none" }] }] },
    ];
    await call("review_protocol_save", { reviewId, protocol, note: "", actor, rescreen: false });
    await call("review_import_records", { reviewId, records: STUDIES.map(([name, year]) => ({ title: `Invented programme trial (${name})`, authors: [`${name}, A.`], year, doi: `10.9999/prog.${name.toLowerCase()}` })), batch: { group: "databases", name: "PubMed" }, actor });
    const rows = (await call("review_records", { reviewId, viewer: actor, query: { stage: "ta", filter: "all", text: "", scope: "sources" } })).rows;
    const ids = rows.map((r) => r.id);
    await call("review_decide", { reviewId, recordIds: ids, stage: "ta", value: "include", reasons: [], note: "", actor });
    await call("review_decide", { reviewId, recordIds: ids, stage: "ft", value: "include", reasons: [], note: "", actor });
    const idOf = (name) => rows.find((r) => r.title.includes(`(${name})`)).id;
    for (const [name, , dose, ests] of STUDIES) {
      const value = ests.map(([m1, sd1, n1, m2, sd2, n2], i) => ({ outcome: "Symptom score", timepoint: "12 weeks", type: "Continuous", group1: "Programme", group2: "Usual care", unit: i ? "Scale B" : "Scale A", m1, sd1, n1, m2, sd2, n2, measure: "MD" }));
      await call("review_extract", { reviewId, recordId: idOf(name), formId: "f-outcomes", fieldId: "outcomes", value, quote: "Table 2", page: 4, actor });
      await call("review_extract", { reviewId, recordId: idOf(name), formId: "f-chars", fieldId: "dose", value: dose, actor });
    }

    // Open the review and convert Jarvis's median and IQR in Extraction.
    await page.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id }), { ws: ws.id, id: reviewId });
    await page.getByRole("heading", { name: "Programme trials (synthesis smoke)" }).waitFor();
    await page.getByRole("tab", { name: /Extraction/ }).click();
    const pick = page.locator("select.kx-rv-study-pick");
    await pick.waitFor();
    const jarvis = await pick.locator("option", { hasText: "Jarvis" }).getAttribute("value");
    await pick.selectOption(jarvis);
    await page.getByRole("button", { name: "Convert reported statistics" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Convert reported statistics" });
    await sheet.waitFor();
    await sheet.getByRole("combobox", { name: "Conversion" }).selectOption("mean-sd-from-median-iqr");
    await sheet.getByRole("textbox", { name: "Median" }).fill("-5");
    await sheet.getByRole("textbox", { name: "First quartile (Q1)" }).fill("-9");
    await sheet.getByRole("textbox", { name: "Third quartile (Q3)" }).fill("-1");
    await sheet.getByRole("textbox", { name: "Participants (n)" }).fill("64");
    await sheet.getByText("Luo et al. 2018").first().waitFor();
    await shot(page, "01-convert-median-iqr");
    await sheet.getByRole("button", { name: "Fill the row" }).click();
    await sheet.waitFor({ state: "detached" });
    let row;
    for (let i = 0; i < 50; i++) {
      const view = await call("review_extraction", { reviewId, recordId: jarvis, viewer: actor });
      row = view.values["f-outcomes/outcomes"]?.mine?.value?.[0];
      if (row?._conversions?.length) break;
      await page.waitForTimeout(100);
    }
    assert.ok(row?._conversions?.length, "the conversion is stored with the row");
    assert.match(row._conversions[0].citation, /Wan et al\. 2014/);
    // Luo et al. (mean) and Wan et al. (SD) for q1 = −9, median = −5, q3 = −1, n = 64.
    assert.ok(Math.abs(row.m1 - -5) < 1e-9 && Math.abs(row.sd1 - 6.0674) < 1e-3, JSON.stringify(row));
    await page.locator(".kx-rv-converted").first().waitFor();
    await shot(page, "02-extraction-converted");
    report.conversion = { m1: row.m1, sd1: row.sd1, method: row._conversions[0].method };

    // Analysis: several estimates per study, then the robust and three-level models.
    await page.getByRole("tab", { name: /Analysis/ }).click();
    await page.locator(".kx-forest").waitFor();
    await page.getByRole("combobox", { name: "Effect measure" }).selectOption("MD");
    const more = page.getByRole("region", { name: "More analyses" });
    await more.getByText("PET-PEESE", { exact: true }).first().waitFor();
    await more.getByRole("radio", { name: "Several estimates (14 in 12)" }).waitFor();
    await shot(page, "03-small-study-effects", more);
    await more.getByRole("radio", { name: /Several estimates/ }).click();
    await more.getByText(/Correlated and hierarchical effects/).first().waitFor();
    await more.getByText(/robust CR2/).first().waitFor();
    await shot(page, "04-several-estimates-robust", more);
    await more.getByRole("radio", { name: "Three-level" }).click();
    await more.getByText("Three-level random-effects model (REML)").first().waitFor();
    await more.getByRole("radio", { name: "Ignore" }).click();
    // Meta-regression with one moderator.
    await more.getByRole("radio", { name: "Meta-regression" }).click();
    await more.getByRole("checkbox", { name: /Sessions per week/ }).check();
    await more.getByRole("cell", { name: "Sessions per week", exact: true }).waitFor();
    await more.getByText(/R² \(between-study variance explained\)/).waitFor();
    await more.locator(".kx-scatter").waitFor();
    await shot(page, "05-meta-regression", more);
    await more.getByRole("radio", { name: "Sensitivity" }).click();
    await more.getByText("Baujat plot").first().waitFor();
    await shot(page, "06-sensitivity", more);

    // The same results through the host, and the exports.
    const base = { outcome: "Symptom score", timepoint: "12 weeks", options: { measure: "MD", method: "reml", hartungKnapp: false, level: 0.95 }, subgroups: false };
    const mods = await call("review_moderators", { reviewId });
    const dose = mods.find((m) => m.field === "dose");
    assert.equal(dose.kind, "continuous");
    const advanced = { moderators: [dose], metareg: { method: "reml", knappHartung: true, permutations: 0 }, dependence: { model: "three-level", rho: 0.6, robust: true }, bias: { petPeese: true, oneSided: false, trimFill: "", selection: false, uwls: true }, sensitivity: null };
    const out = await call("review_synthesis", { reviewId, request: { ...base, ...advanced } });
    assert.equal(out.multipleEstimates, true);
    assert.equal(out.k, 14);
    assert.equal(out.dependence.coefficients.length, 2, "the moderator is fitted in the three-level model");
    assert.ok(out.bias.petPeese.pet.seType === "CR2");
    report.synthesis = { k: out.k, studies: out.studies, slope: out.dependence.coefficients[1].estimate, pet: out.bias.petPeese.estimate.estimate };
    const spec = { id: "smoke", name: "Programme dose", request: base, advanced };
    await call("review_analysis_save", { reviewId, analysis: spec, actor });
    const r = unzip((await call("review_export_r", { reviewId, spec })).content);
    const script = r["programme-dose-r/analysis.R"];
    assert.ok(script && r["programme-dose-r/data.csv"], Object.keys(r).join(", "));
    assert.match(script, /rma\.mv\(yi, vi, mods = ~ mod_1, random = ~ 1 \| record_id\/esid/);
    assert.match(script, /check\("Pooled estimate, SE, CI"/);
    assert.match(script, /sessionInfo\(\)/);
    const revman = await call("review_revman_export", { reviewId });
    const rm = unzip(revman.content);
    for (const f of ["study-information.csv", "study-arms.csv", "study-results.csv", "references.ris", "README.txt"]) assert.ok(rm[`programme-trials-synthesis-smoke-revman/${f}`], `RevMan ${f}`);
    assert.deepEqual(revman.problems.filter((p) => p.severity === "error"), []);
    assert.match(rm["programme-trials-synthesis-smoke-revman/study-results.csv"], /Symptom score - 12 weeks,Arm Level,MD,Programme,FALSE,64,,-5,/);
    const bundle = unzip((await call("review_bundle", { reviewId, viewer: actor, plots: { "forest.svg": "<svg/>" }, current: null, anonymise: true })).content);
    const root = "programme-trials-synthesis-smoke-replication/";
    for (const f of ["README.md", "manifest.json", "SHA256SUMS", "screening/screening-decisions.csv", "extraction/extraction-long.csv", "extraction/conversions.csv", "revman/study-results.csv", "analyses/programme-dose/analysis.R", "analyses/plots/forest.svg", "audit/audit-trail.csv", "studies/included.ris"]) assert.ok(bundle[root + f] !== undefined, `bundle ${f}`);
    assert.match(bundle[root + "extraction/conversions.csv"], /Mean and SD from the median/);
    assert.ok(!Object.values(bundle).some((t) => t.includes("Ana Example")), "anonymised");
    report.bundle = Object.keys(bundle).length;

    // The export menu in the app (files are saved by the browser; no error notice appears).
    await more.getByRole("button", { name: "Export for others" }).click();
    await page.getByRole("menuitem", { name: /RevMan Web import files/ }).click();
    const rmSheet = page.getByRole("dialog", { name: "RevMan Web files" });
    await rmSheet.waitFor();
    await shot(page, "07-revman-check");
    await rmSheet.getByRole("button", { name: "Done" }).click();
    await more.getByRole("button", { name: "Export for others" }).click();
    await page.getByRole("menuitem", { name: /Replication bundle/ }).click();
    const bSheet = page.getByRole("dialog", { name: "Replication bundle" });
    await bSheet.waitFor();
    await shot(page, "08-bundle-sheet");
    await bSheet.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await page.locator(".kx-inline-error").count(), 0);

    // Dark mode.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await more.getByRole("radio", { name: "Small-study effects" }).click();
    await more.getByText("PET-PEESE", { exact: true }).first().waitFor();
    await shot(page, "09-small-study-effects-dark", more);
    await more.getByRole("radio", { name: "Meta-regression" }).click();
    await more.locator(".kx-scatter").waitFor();
    await shot(page, "10-meta-regression-dark", more);
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
