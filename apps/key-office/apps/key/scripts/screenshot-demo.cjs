// The invented demo library behind record-screenshots.cjs. Every person, institution, journal,
// title, abstract and DOI here is made up (DOIs use Crossref's 10.5555 test prefix); the PDFs
// and web pages are written below and rendered by the app itself. Nothing comes from a real
// paper or a real user's library.

const PEOPLE = {
  A1: ["Amara", "Okafor", "I1"],
  A2: ["Lukas", "Brenner", "I2"],
  A3: ["Mei", "Tanaka", "I1"],
  A4: ["Sofia", "Marques", "I3"],
  A5: ["Daniel", "Whitfield", "I4"],
  A6: ["Priya", "Raman", "I2"],
  A7: ["Henrik", "Lund", "I5"],
  A8: ["Elena", "Varga", "I3"],
  A9: ["Tomás", "Ruiz", "I4"],
  A10: ["Grace", "Liu", "I5"],
  A11: ["Noah", "Petersen", "I1"],
  A12: ["Fatima", "Haddad", "I2"],
};
const INSTITUTIONS = {
  I1: "University of Northbridge",
  I2: "Lindholm University",
  I3: "Calder Institute for Social Research",
  I4: "Westmere College",
  I5: "Harbour Bay University",
};
const VENUES = {
  S1: "Journal of Open Research Practice",
  S2: "Metascience Letters",
  S3: "Methods in Behavioural Science",
  S4: "Scholarly Communication Review",
  S5: "Computational Research Notes",
};
const TOPICS = {
  T1: ["Reproducibility in Science", "S3312", "Sociology and Political Science", "F33", "Social Sciences"],
  T2: ["Open Access Publishing", "S1804", "Library and Information Sciences", "F33", "Social Sciences"],
  T3: ["Research Data Management", "S1804", "Library and Information Sciences", "F33", "Social Sciences"],
  T4: ["Peer Review Processes", "S3312", "Sociology and Political Science", "F33", "Social Sciences"],
  T5: ["Citation Analysis and Bibliometrics", "S1804", "Library and Information Sciences", "F33", "Social Sciences"],
  T6: ["Scientific Software Development", "S1712", "Software", "F17", "Computer Science"],
};

// n, title, year, authors, venue, topics, tags, references (n of earlier works), collections, cited, abstract
const WORKS = [
  [1, "Preregistration and the shrinking effect: evidence from 412 psychology studies", 2023, ["A1", "A2", "A3"], "S1", ["T1", "T4"], ["preregistration", "replication", "status: to read"], [2, 3, 5, 7, 9, 12], ["thesis", "ch2"], 41,
    "We compared effect sizes in 412 preregistered and non-preregistered studies published between 2012 and 2021. Preregistered studies reported effects about half as large, and the gap was widest where analysis plans were most specific."],
  [2, "What a registered report changes: a survey of authors and reviewers", 2019, ["A4", "A8"], "S4", ["T4", "T1"], ["peer review", "registered reports"], [], ["thesis"], 118,
    "A survey of 1,140 authors and reviewers of registered reports. Most said the format changed which studies they proposed, not only how they reported them."],
  [3, "Analytic flexibility in published behavioural research", 2018, ["A2", "A6"], "S3", ["T1"], ["methods", "replication"], [], ["thesis", "ch2"], 264,
    "Re-analysing 60 data sets with every defensible analysis path, we find that reasonable choices move a typical estimate by a third of its size."],
  [4, "Open data badges and what happens to the data afterwards", 2020, ["A5", "A9"], "S1", ["T3", "T1"], ["open data", "badges"], [3], ["reading"], 57,
    "Of 300 articles with an open data badge, 71 percent still pointed to usable data four years later. Repositories with persistent identifiers fared best."],
  [5, "Replication in the many-labs era: a quantitative review", 2021, ["A1", "A7"], "S2", ["T1"], ["replication", "meta-analysis"], [3], ["thesis", "ch2"], 89,
    "A review of 28 multi-site replication projects. Original effects replicated in roughly half of cases, with replication effects averaging 0.4 of the original."],
  [6, "Article processing charges and who pays them", 2022, ["A8", "A12"], "S4", ["T2"], ["open access", "policy"], [], [], 36,
    "Using invoices from 41 institutions, we trace who pays article processing charges and how payment arrangements shape where authors publish."],
  [7, "Sample size planning in preregistrations", 2020, ["A3", "A11"], "S3", ["T1"], ["preregistration", "methods", "status: read"], [3], ["thesis", "ch2"], 47,
    "Most preregistrations we coded justified their sample size, but only a third did so with a power analysis tied to a plausible effect."],
  [8, "Version control for the rest of us: research software habits", 2021, ["A10", "A7"], "S5", ["T6"], ["research software", "teaching"], [], ["reading"], 22,
    "Interviews with 48 researchers who write code show version control is common but rarely tied to the analyses reported in papers."],
  [9, "Publication bias corrections compared on simulated literatures", 2019, ["A6", "A2"], "S2", ["T5", "T1"], ["meta-analysis", "methods"], [3], ["thesis"], 133,
    "Seven bias-correction methods were applied to 10,000 simulated literatures. None recovered the true effect when bias and heterogeneity were both large."],
  [10, "FAIR data in the long tail of science", 2022, ["A9", "A5"], "S1", ["T3"], ["open data", "FAIR"], [4], ["reading"], 31,
    "Small labs hold most research data. We describe what makes their data findable and reusable, and what it costs them."],
  [11, "Citation advantage of open access articles revisited", 2021, ["A12", "A4"], "S4", ["T2", "T5"], ["open access", "bibliometrics"], [6], [], 72,
    "Matching open and closed articles on journal, field and year, the citation advantage of open access shrinks to about 8 percent."],
  [12, "Specification curves for the working scientist", 2022, ["A2", "A3", "A6"], "S3", ["T1", "T6"], ["methods", "research software"], [3, 9], ["thesis", "ch2"], 58,
    "A short guide to specification curve analysis, with a small package that turns a list of analysis choices into a curve and a summary test."],
  [13, "Open peer review at scale: two years of signed reports", 2023, ["A8", "A4"], "S4", ["T4"], ["peer review", "Open-Access"], [2], [], 19,
    "Two years of signed, published reviews at four journals. Signed reports were longer and more constructive; decline rates rose slightly."],
  [14, "Teaching reproducible workflows to first-year students", 2024, ["A10", "A11"], "S5", ["T6", "T1"], ["teaching", "research software"], [8, 12], ["reading"], 6,
    "A first-year course built on notebooks and version control. Students' final projects could be re-run by a peer in 83 percent of cases."],
  [15, "A rapid test for reviewer bias", 2017, ["A7"], "S2", ["T4"], ["peer review"], [], [], 12,
    "A short instrument for measuring reviewer bias from the text of review reports."],
  [16, "Preregistration and the Shrinking Effect: Evidence from 412 Psychology Studies.", 2023, ["A1", "A2", "A3"], "S1", ["T1"], ["OA", "preregistration"], [], [], 0, ""],
];
// Not in the library: cited by the main paper, so its reference list has works to add.
const CITED_ELSEWHERE = [
  [91, "Forking paths in everyday data analysis", 2014, ["A6", "A9"], "S3", ["T1"], 512, "How many analyses a data set allows, and why a single significant result says less than it seems."],
  [92, "Hidden moderators and the replication debate", 2016, ["A5", "A12"], "S2", ["T1"], 203, "When replications fail, are the original populations, settings or measures to blame? A review of the claims."],
];

const wid = (n) => `W77${String(n).padStart(5, "0")}`;
const doi = (n) => `10.5555/key-demo.${n}`;
const aid = (a) => `A77${String(a.slice(1)).padStart(5, "0")}`;
const name = (a) => `${PEOPLE[a][0]} ${PEOPLE[a][1]}`;
const words = (text) => {
  const index = {};
  text.split(/\s+/).forEach((w, i) => (index[w] ??= []).push(i));
  return index;
};

function topic(id, n) {
  const [label, sub, subName, field, fieldName] = TOPICS[id];
  return {
    id: `https://openalex.org/${id}`,
    display_name: label,
    score: 0.98 - n * 0.1,
    subfield: { id: `https://openalex.org/subfields/${sub.slice(1)}`, display_name: subName },
    field: { id: `https://openalex.org/fields/${field.slice(1)}`, display_name: fieldName },
    domain: { id: "https://openalex.org/domains/2", display_name: "Social Sciences" },
  };
}

function openalexWork(row) {
  const [n, title, year, authors, venue, topics, , refs = [], , cited, abstract] = row.length === 8 ? [row[0], row[1], row[2], row[3], row[4], row[5], [], [], [], row[6], row[7]] : row;
  const retracted = n === 15;
  return {
    id: `https://openalex.org/${wid(n)}`,
    doi: `https://doi.org/${doi(n)}`,
    display_name: title,
    title,
    publication_year: year,
    publication_date: `${year}-0${(n % 9) + 1}-1${n % 9}`,
    ids: { openalex: `https://openalex.org/${wid(n)}`, doi: `https://doi.org/${doi(n)}` },
    language: "en",
    primary_location: {
      landing_page_url: `https://doi.org/${doi(n)}`,
      source: { id: `https://openalex.org/${venue}`, display_name: VENUES[venue], issn_l: null, issn: [], type: "journal", is_oa: n % 3 !== 0, is_in_doaj: false, host_organization_name: "Demo Academic Press" },
    },
    type: "article",
    open_access: { is_oa: n % 3 !== 0, oa_status: n % 3 !== 0 ? "gold" : "closed" },
    authorships: authors.map((a, i) => ({
      author_position: i ? (i === authors.length - 1 ? "last" : "middle") : "first",
      author: { id: `https://openalex.org/${aid(a)}`, display_name: name(a), orcid: null },
      institutions: [{ id: `https://openalex.org/${PEOPLE[a][2]}`, display_name: INSTITUTIONS[PEOPLE[a][2]], country_code: "GB", type: "education" }],
      raw_author_name: name(a),
    })),
    biblio: { volume: String(4 + (n % 7)), issue: String((n % 4) + 1), first_page: String(100 + n * 13), last_page: String(112 + n * 13) },
    is_retracted: retracted,
    cited_by_count: cited,
    fwci: Math.round((cited / 30) * 100) / 100,
    primary_topic: topic(topics[0], 0),
    topics: topics.map(topic),
    keywords: [],
    funders: n % 4 === 1 ? [{ id: "https://openalex.org/F7700001", display_name: "Northbridge Research Council" }] : [],
    awards: [],
    referenced_works: refs.map((r) => `https://openalex.org/${wid(r)}`),
    abstract_inverted_index: abstract ? words(abstract) : null,
  };
}

function openalexAuthor(a) {
  const works = WORKS.filter((w) => w[3].includes(a));
  return {
    id: `https://openalex.org/${aid(a)}`,
    orcid: null,
    display_name: name(a),
    works_count: 20 + works.length * 9,
    cited_by_count: works.reduce((s, w) => s + w[9], 0) * 4,
    summary_stats: { "2yr_mean_citedness": 2.1, h_index: 8 + works.length * 2, i10_index: 10 + works.length },
    ids: { openalex: `https://openalex.org/${aid(a)}` },
    affiliations: [{ institution: { id: `https://openalex.org/${PEOPLE[a][2]}`, display_name: INSTITUTIONS[PEOPLE[a][2]], country_code: "GB", type: "education" }, years: [2024, 2023, 2022] }],
  };
}

/** Recorded-answer folder for KEY_OPENALEX_FIXTURES. */
function openalexFixtures() {
  const files = {};
  for (const w of WORKS) if (w[0] !== 16) files[`${wid(w[0])}.json`] = openalexWork(w);
  for (const w of CITED_ELSEWHERE) files[`${wid(w[0])}.json`] = openalexWork(w);
  for (const a of Object.keys(PEOPLE)) files[`${aid(a)}.json`] = openalexAuthor(a);
  files["crossref-works.json"] = { message: { items: [] } };
  files["crossref-updates.json"] = {
    message: { items: [{ DOI: "10.5555/key-demo.notice-15", "update-to": [{ DOI: doi(15), type: "retraction", source: "retraction-watch", updated: { "date-time": "2024-02-01T00:00:00Z" } }] }] },
  };
  return files;
}

/** What the reader's citation cards would fetch (seeded into the workspace's lookup cache). */
function scholarly(row) {
  const [n, title, year, authors, venue] = row;
  const abstract = row.length === 8 ? row[7] : row[10];
  return {
    source: "OpenAlex",
    sources: ["OpenAlex"],
    title,
    abstractText: abstract || null,
    tldrText: null,
    authors: authors.map(name),
    year,
    journal: VENUES[venue],
    journalShort: null,
    journalUrl: null,
    doi: doi(n),
    openAccess: n % 3 !== 0,
    fullTextUrl: null,
    landingUrl: `https://doi.org/${doi(n)}`,
    certainty: "exact",
  };
}

// ── The main paper, as a PDF the app renders from HTML ───────────────────

const byN = (n) => WORKS.find((w) => w[0] === n) ?? CITED_ELSEWHERE.find((w) => w[0] === n);
const authorList = (n) => {
  const list = byN(n)[3].map((a) => `${PEOPLE[a][1]}, ${PEOPLE[a][0][0]}.`);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} & ${list.at(-1)}` : list[0];
};
const MAIN_REFS = [3, 91, 9, 2, 7, 5, 92, 12];
const cite = (...ns) => `[${ns.map((n) => `<a href="#r${MAIN_REFS.indexOf(n) + 1}">${MAIN_REFS.indexOf(n) + 1}</a>`).join(", ")}]`;

function mainPaperHtml() {
  const w = byN(1);
  const refs = MAIN_REFS.map((n, i) => {
    const r = byN(n);
    return `<li id="r${i + 1}"><span class="n">[${i + 1}]</span> ${authorList(n)} (${r[2]}). ${r[1]}. <i>${VENUES[r[4]]}</i>, ${4 + (n % 7)}(${(n % 4) + 1}), ${100 + n * 13}–${112 + n * 13}. https://doi.org/${doi(n)}</li>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${w[1]}</title><style>
  @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
  body { font: 9.6pt/1.42 "Charter", "Georgia", serif; color: #1b1b1b; margin: 0; }
  .journal { font: 600 8pt "Helvetica Neue", Arial, sans-serif; letter-spacing: .04em; color: #3d5a80; border-bottom: 1.2pt solid #3d5a80; padding-bottom: 4pt; display: flex; justify-content: space-between; }
  h1 { font: 600 18pt/1.2 "Charter", Georgia, serif; margin: 14pt 0 8pt; }
  .authors { font: 10pt "Helvetica Neue", Arial, sans-serif; margin-bottom: 3pt; }
  .affil { font: 7.6pt "Helvetica Neue", Arial, sans-serif; color: #555; margin-bottom: 10pt; }
  .abstract { background: #f2f5f9; padding: 8pt 10pt; font-size: 9pt; margin-bottom: 6pt; }
  .abstract b { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #3d5a80; }
  .kw { font: 8pt "Helvetica Neue", Arial, sans-serif; color: #444; margin-bottom: 12pt; }
  .cols { column-count: 2; column-gap: 16pt; text-align: justify; }
  h2 { font: 600 10.5pt "Helvetica Neue", Arial, sans-serif; color: #3d5a80; margin: 10pt 0 4pt; break-after: avoid; }
  p { margin: 0 0 5pt; text-indent: 10pt; } h2 + p { text-indent: 0; }
  a { color: #3d5a80; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; font: 7.8pt "Helvetica Neue", Arial, sans-serif; margin: 6pt 0 8pt; break-inside: avoid; }
  th, td { border-bottom: .5pt solid #bbb; padding: 2.5pt 3pt; text-align: left; } th { border-bottom: 1pt solid #333; }
  caption { caption-side: top; text-align: left; font-weight: 600; padding-bottom: 3pt; }
  ol.refs { list-style: none; padding: 0; margin: 0; font-size: 8pt; text-align: left; }
  ol.refs li { break-inside: avoid; margin-bottom: 4pt; padding-left: 16pt; text-indent: -16pt; } .n { color: #3d5a80; }
  .doi { font: 7.6pt "Helvetica Neue", Arial, sans-serif; color: #555; margin-top: 8pt; }
  </style></head><body>
  <div class="journal"><span>${VENUES.S1.toUpperCase()}</span><span>Vol. 12 · 2023 · https://doi.org/${doi(1)}</span></div>
  <h1>${w[1]}</h1>
  <div class="authors">Amara Okafor<sup>1</sup>, Lukas Brenner<sup>2</sup> and Mei Tanaka<sup>1</sup></div>
  <div class="affil"><sup>1</sup> Department of Psychology, ${INSTITUTIONS.I1} · <sup>2</sup> Centre for Research Methods, ${INSTITUTIONS.I2}</div>
  <div class="abstract"><b>Abstract</b><br>${w[10]} We discuss what the difference means for meta-analyses that pool both kinds of study, and suggest how readers can weigh a result by how firmly its analysis was fixed in advance.</div>
  <div class="kw"><b>Keywords:</b> preregistration · effect sizes · replication · meta-science · research practice</div>
  <div class="cols">
  <h2>1. Introduction</h2>
  <p>A study's analysis can be shaped by its data in many small ways: which participants are excluded, which covariates enter a model, which of several outcomes is reported ${cite(3, 91)}. Each choice is defensible on its own, yet together they let a researcher find an effect that the data only weakly support. Simulations suggest that such flexibility can double the rate of false positives in a literature, and that bias-correction methods recover the true effect only when heterogeneity is small ${cite(9)}.</p>
  <p>Preregistration answers this by fixing the analysis before the data are seen. Registered reports go further and decide publication on the plan alone ${cite(2)}. Whether this changes the results that reach print is an empirical question. Earlier comparisons were small or limited to one journal, and many preregistrations left room for flexibility themselves, for instance in how the sample size was set ${cite(7)}.</p>
  <p>Here we compare 412 studies, matched on topic, design and journal, of which 206 were preregistered. We ask whether preregistered studies report smaller effects, and whether the difference depends on how specific the plan was.</p>
  <h2>2. Methods</h2>
  <p>We searched six journals for studies published between 2012 and 2021 that reported a focal test of a between-subjects effect. Each preregistered study was matched to a non-preregistered study on subfield, design and year. Two coders rated the specificity of each plan on a five-point scale, covering hypotheses, exclusions, model and outcome; disagreements were resolved by discussion.</p>
  <p>Effect sizes were converted to Hedges' <i>g</i>. We fitted a random-effects model with preregistration status and plan specificity as moderators, and checked the result against a specification curve over 64 reasonable alternatives ${cite(12)}.</p>
  <table><caption>Table 1. Effect sizes by preregistration status</caption>
  <tr><th>Group</th><th>Studies</th><th>Median <i>g</i></th><th>95% CI</th></tr>
  <tr><td>Not preregistered</td><td>206</td><td>0.48</td><td>0.43–0.53</td></tr>
  <tr><td>Preregistered</td><td>206</td><td>0.24</td><td>0.20–0.29</td></tr>
  <tr><td>Registered reports</td><td>58</td><td>0.17</td><td>0.10–0.25</td></tr></table>
  <h2>3. Results</h2>
  <p>Preregistered studies reported a median effect of <i>g</i> = 0.24, against 0.48 for their matched counterparts. The difference held in every subfield and in 61 of the 64 specifications. Registered reports showed the smallest effects of all, in line with multi-site replications of the same paradigms ${cite(5)}.</p>
  <p>Plan specificity mattered. Studies whose plans fixed exclusions, model and outcome reported effects about 40 percent smaller than studies whose plans named only a hypothesis. Vague plans behaved much like no plan at all.</p>
  <h2>4. Discussion</h2>
  <p>The shrinking effect is not proof that non-preregistered results are wrong. Preregistered studies may tackle harder questions, and contextual differences between samples are often proposed as an explanation when results diverge ${cite(92)}. But the dependence on plan specificity is hard to explain without analytic flexibility. Meta-analyses that pool both kinds of study should report them separately, and readers can reasonably give more weight to results whose analysis was fixed in advance.</p>
  <h2>References</h2>
  <ol class="refs">${refs}</ol>
  </div></body></html>`;
}

/** A short one-page paper for other library items with a PDF. */
function shortPaperHtml(n) {
  const w = byN(n);
  const people = w[3].map(name).join(", ");
  const para = (s) => `<p>${s}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 20mm 18mm; } body { font: 10pt/1.45 Georgia, serif; color: #1b1b1b; }
  .j { font: 600 8pt Arial, sans-serif; color: #7a4f2a; border-bottom: 1pt solid #7a4f2a; padding-bottom: 4pt; }
  h1 { font: 600 17pt/1.2 Georgia, serif; margin: 14pt 0 6pt; } .a { font: 10pt Arial, sans-serif; margin-bottom: 12pt; }
  h2 { font: 600 10.5pt Arial, sans-serif; margin: 12pt 0 4pt; color: #7a4f2a; } .cols { column-count: 2; column-gap: 16pt; text-align: justify; }
  </style></head><body><div class="j">${VENUES[w[4]].toUpperCase()} · ${w[2]} · https://doi.org/${doi(n)}</div>
  <h1>${w[1]}</h1><div class="a">${people}</div>
  <div class="cols"><h2>Abstract</h2>${para(w.length === 8 ? w[7] : w[10])}
  <h2>1. Background</h2>${para("Questions about how research is done have moved from editorials into data. This paper adds a careful, modest piece of evidence to that literature and describes its limits plainly.")}
  ${para("We describe the sample, the coding scheme and the analysis in turn, and give every material needed to repeat the work.")}
  <h2>2. Approach</h2>${para("Two coders worked independently on a random half of the material and agreed on 91 percent of judgements before discussion. The remaining cases were settled by a third reader.")}
  <h2>3. Findings</h2>${para("The main pattern is robust to the choices we could reasonably have made differently, though its size depends on how the sample is defined.")}
  <h2>4. Conclusion</h2>${para("The result is a step, not an answer. We hope others will extend it to fields we could not cover.")}</div></body></html>`;
}

// ── Web pages for the in-app browser ─────────────────────────────────────

const ARTICLE_HOST = "www.jorp.example";
function articleHtml({ title, n, authors, date, abstract, body, pdf = true }) {
  const meta = [
    `<meta name="citation_title" content="${title}">`,
    ...authors.map((a) => `<meta name="citation_author" content="${a}">`),
    `<meta name="citation_publication_date" content="${date}">`,
    `<meta name="citation_journal_title" content="${VENUES.S1}">`,
    `<meta name="citation_doi" content="${doi(n)}">`,
    pdf ? `<meta name="citation_pdf_url" content="/articles/${n}.pdf">` : "",
    `<meta property="og:site_name" content="${VENUES.S1}">`,
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | ${VENUES.S1}</title>${meta}<style>
  body { margin: 0; font: 16px/1.6 Georgia, serif; color: #222; background: #fff; }
  header { background: #23395b; color: #fff; padding: 14px 40px; font: 600 15px "Helvetica Neue", Arial, sans-serif; display: flex; gap: 28px; align-items: center; }
  header nav { font-weight: 400; opacity: .85; display: flex; gap: 20px; font-size: 14px; } header .brand { letter-spacing: .02em; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 40px 60px; }
  .kicker { font: 600 12px Arial, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #3d5a80; }
  h1 { font-size: 34px; line-height: 1.2; margin: 10px 0 14px; } .by { font: 15px Arial, sans-serif; color: #444; }
  .meta { font: 13px Arial, sans-serif; color: #666; margin: 6px 0 22px; } .btn { display: inline-block; background: #3d5a80; color: #fff; font: 600 13px Arial, sans-serif; padding: 8px 14px; border-radius: 4px; text-decoration: none; margin-right: 8px; }
  .abstract { background: #f3f6fa; border-left: 3px solid #3d5a80; padding: 14px 18px; margin: 22px 0; } h2 { font: 600 20px Arial, sans-serif; margin-top: 28px; }
  </style></head><body><header><span class="brand">${VENUES.S1}</span><nav><span>Current issue</span><span>Archive</span><span>Submit</span><span>About</span></nav></header>
  <main><div class="kicker">Research article · Open access</div><h1>${title}</h1><div class="by">${authors.map((a) => a.split(", ").reverse().join(" ")).join(", ")}</div>
  <div class="meta">Published ${date.replace(/\//g, "-")} · https://doi.org/${doi(n)}</div>
  ${pdf ? `<a class="btn" href="/articles/${n}.pdf">Download PDF</a>` : ""}<a class="btn" style="background:#eef2f7;color:#23395b" href="#">Cite</a>
  <div class="abstract"><b>Abstract.</b> ${abstract}</div>${body}</main></body></html>`;
}

const SAVED_PAGE = {
  title: "Why vague preregistrations behave like no plan at all",
  site: "Methods Notebook",
  authors: ["Raman, Priya"],
  date: "2024-03-12",
  doi: "10.5555/key-demo.blog-1",
  paragraphs: [
    "A preregistration is a promise about the analysis you will run. Like any promise, it is worth only as much as it is specific. “We will test whether the training improves recall” rules out very little; “we will exclude participants who fail two of three attention checks, fit a mixed model with random intercepts for items, and test the condition coefficient one-sided” rules out a great deal.",
    "Recent comparisons of preregistered and non-preregistered studies find that the benefits of preregistration depend almost entirely on this specificity. Plans that fixed exclusions, model and outcome were followed by much smaller effects; plans that named only a hypothesis looked no different from studies with no plan.",
    "None of this means vague plans are useless. Writing one forces a team to agree on a hypothesis before the data arrive, and it leaves a date-stamped record. But readers should not treat the word “preregistered” as a quality badge on its own. The useful question is how many of the analysis choices the plan actually fixed.",
    "Three habits make plans more specific with little extra work: write the analysis code before collecting data and run it on simulated data; list every exclusion rule as a line of code rather than a sentence; and say in advance which of several outcomes is the primary one.",
  ],
};

function savedPageHtml() {
  const p = SAVED_PAGE;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${p.title} | ${p.site}</title>
  <meta name="citation_title" content="${p.title}"><meta name="citation_author" content="${p.authors[0]}"><meta name="citation_publication_date" content="${p.date}">
  <meta property="og:site_name" content="${p.site}"><meta name="description" content="On the specificity of analysis plans.">
  <style>body{margin:0;font:18px/1.65 Georgia,serif;color:#262626;background:#fffdf8} .top{border-bottom:1px solid #e8e2d4;padding:16px 0;text-align:center;font:600 14px "Helvetica Neue",Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7a4f2a}
  article{max-width:680px;margin:0 auto;padding:36px 28px 80px} h1{font-size:36px;line-height:1.18;margin:0 0 12px} .by{font:15px "Helvetica Neue",Arial,sans-serif;color:#6b6457;margin-bottom:28px}</style></head>
  <body><div class="top">${p.site}</div><article><h1>${p.title}</h1><div class="by">By Priya Raman · 12 March 2024 · 6 min read</div>
  ${p.paragraphs.map((t, i) => `<p id="p${i + 1}">${t}</p>`).join("")}</article></body></html>`;
}

module.exports = {
  PEOPLE, INSTITUTIONS, VENUES, TOPICS, WORKS, CITED_ELSEWHERE, MAIN_REFS, ARTICLE_HOST, SAVED_PAGE,
  wid, doi, aid, name, byN, openalexWork, openalexFixtures, scholarly, mainPaperHtml, shortPaperHtml, articleHtml, savedPageHtml,
};
