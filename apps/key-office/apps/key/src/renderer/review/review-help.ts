// The systematic review's explanations (spread into help-content.ts's HELP), for people who have
// never done a systematic review as much as for experienced teams. Same voice and budgets.
import type { HelpEntry } from "../help-content";
// std-D: advanced synthesis and exports.
import { SYNTHESIS_HELP } from "./review-synthesis-help";

export const REVIEW_HELP = {
  "review.what": {
    kind: "explain",
    title: "What is a systematic review?",
    body: [
      "A systematic review answers a question from all the studies on it, found and chosen by rules written down beforehand, so another team would choose the same ones.",
      "In Key you import what your searches found, screen titles and abstracts, read the full texts of what is left, extract data from the included studies and, if they are alike enough, pool their results in a meta-analysis.",
      "Key counts everything as you go and draws the PRISMA 2020 flow diagram journals ask for.",
    ],
    steps: ["Setup: write the question and the criteria", "Sources: import the records your searches found", "Title & abstract: include, exclude or maybe", "Full text: read and decide, naming the criterion it fails", "Extraction and Analysis: collect the data and pool it"],
    links: [{ label: "PRISMA 2020 statement", url: "https://www.prisma-statement.org/prisma-2020" }],
  },
  "review.screening": {
    kind: "explain",
    title: "Screening titles and abstracts",
    body: [
      "Decide from the title and abstract whether a record could meet your criteria. When unsure, keep it with Maybe: the full text settles it.",
      "Press I to include, E to exclude, M for maybe. When the rules ask for the criterion not met, E opens the criteria: press its number, or 0 for Other. Or press the number first, then E.",
      "Label keys such as B and L mark a record without moving on. ⌘Z takes back your last decision. With two reviewers, disagreements become conflicts to resolve.",
    ],
  },
  "review.fulltext": {
    kind: "explain",
    title: "Full-text screening",
    body: [
      "Read each report that passed title and abstract screening and check it against every criterion. Excluding names the criterion it does not meet, which PRISMA reports.",
      "The full text opens inside the review. Select a passage to mark a criterion as not met, with its place. Files you attach stay with the review unless you add them to the library.",
      "In the selection menu a criterion's key marks the passage not met, Shift and the key met. The passage is kept as evidence and marked in the text; Enter then excludes and goes to the next record, and ⌘Z takes the mark back.",
    ],
  },
  "review.evidence": { kind: "hint", text: "Select a passage in the full text and press a criterion's key: not met, or with Shift met. It is kept with its place." },
  "review.question": {
    kind: "explain",
    title: "The review question",
    body: [
      "PICO (population, intervention, comparison, outcome) suits questions about effects of treatments; PECO swaps intervention for exposure; SPIDER suits qualitative evidence.",
      "Write each part plainly. Your criteria usually follow them, one or more per part.",
    ],
    example: "Population: adults with chronic low back pain. Intervention: supervised exercise. Comparison: usual care. Outcome: pain at 12 weeks.",
  },
  "review.team": {
    kind: "explain",
    title: "Team and roles",
    body: [
      "Reviewers screen and extract. A tie-breaker resolves conflicts when the rules say a third person decides. Owners can change everything.",
      "Choose who is screening at the top of the review: decisions are recorded under that person.",
    ],
  },
  "review.team.local": { kind: "hint", text: "People are local profiles on this Mac for now; working together across Macs comes with sync. Export and import the review file meanwhile." },
  "review.rules": {
    kind: "explain",
    title: "Screening rules",
    body: [
      "Cochrane reviews have two people screen each record independently, without seeing each other's decisions (blind), and settle disagreements by discussion or a third person.",
      "A solo review can start with one reviewer and tighten the rules later. Rule changes after decisions make a new protocol version.",
    ],
  },
  "review.criteria": {
    kind: "explain",
    title: "Eligibility criteria",
    body: [
      "A criterion is a rule a study must meet. When you exclude a study you pick the criterion it fails; that is the reason PRISMA reports.",
      "Criteria are grouped by the parts of your question. Start from the suggestions, rewrite them in your own words, and give guidance for borderline cases. Each has short wording for reports when it is not met, such as Wrong population.",
      "The order matters: when a study fails several criteria, PRISMA reports the first. Changing criteria after screening started makes a new version and can flag earlier decisions for another look.",
    ],
  },
  "review.criteria.hint": { kind: "hint", text: "One list: each criterion is a rule to meet, and failing it is the reason for excluding. The first failed, top to bottom, is reported." },
  "review.criteria.link": {
    kind: "explain",
    title: "Criteria linked to metadata",
    body: [
      "Some criteria can be read from a record's details: publication year, document type, language, whether it has an abstract, a custom property of its library source, or a Key formula.",
      "A linked criterion a record fails suggests excluding it, with the criterion as the reason. Exclude automatically applies it to undecided records as a labelled, undoable decision by Rules, which PRISMA counts as marked ineligible by automation tools.",
    ],
    example: "Met when: Year is at least 2000; Language is one of en, de; Formula: {hasAbstract}",
  },
  "review.keywords": {
    kind: "explain",
    title: "Highlighted words",
    body: ["Words you list are marked in titles and abstracts while you screen: green for words that speak for inclusion, red for words that speak against. They speed reading; they never decide."],
    example: "randomi* marks randomised, randomized and randomly.",
  },
  "review.pilot": {
    kind: "explain",
    title: "Pilot rounds",
    body: [
      "Before the main round, every reviewer screens the same random sample. Comparing decisions shows where the criteria are unclear.",
      "Agreement is the share of records decided alike; Cohen's kappa corrects it for agreement by chance. Above 0.6 is usually good enough to go on; below, discuss the disagreements and sharpen the guidance.",
    ],
  },
  "review.assign": {
    kind: "explain",
    title: "Who screens what",
    body: [
      "By default every reviewer can screen every record until the rules' number of reviewers have. To share the work, split the records by percentage, and have a share of them screened twice to check agreement.",
      "The split is random but reproducible. Records imported later follow the same rule.",
    ],
  },
  "review.kappa": {
    kind: "explain",
    title: "Agreement and kappa",
    body: ["Cohen's kappa is 1 when two reviewers always agree and 0 when they agree no more than chance would. Landis and Koch's bands: up to 0.2 slight, 0.4 fair, 0.6 moderate, 0.8 substantial, above almost perfect. With three or more reviewers Key uses Fleiss' kappa."],
  },
  "review.versions": {
    kind: "explain",
    title: "Protocol versions",
    body: [
      "Once decisions exist, every change to the rules or criteria makes a new version with a note saying what changed. Each decision records the version it was made under.",
      "Reviews report deviations from their protocol; the notes here are that record.",
    ],
  },
  "review.audit": { kind: "hint", text: "Every decision, note and change, with who made it and when. Nothing is overwritten: an undo is a new entry." },
  "review.sources": {
    kind: "explain",
    title: "Where records come from",
    body: [
      "PRISMA 2020 reports records by how they were found: databases (PubMed, Embase …), registers (ClinicalTrials.gov …) and other methods (citation searching, websites, organisations).",
      "Export each database's results as RIS, BibTeX, EndNote XML, PubMed .nbib or CSV and import them here, or run a Database search in Key, which keeps the strategy and each database's count.",
    ],
  },
  "review.sources.selection": { kind: "hint", text: "To add a selection from your library, select the sources there and choose Send to review." },
  "review.import.dedup": { kind: "hint", text: "Records with the same DOI or PubMed ID as one already here are removed as duplicates and counted; look-alikes wait for you to compare." },
  "review.prisma": {
    kind: "explain",
    title: "The PRISMA flow diagram",
    body: [
      "PRISMA 2020 asks reviews to show how many records were found, removed as duplicates, screened, excluded, sought, assessed and included, with reasons for full-text exclusions.",
      "Key draws it from the review's own data, so it is always current. Export it as SVG or PNG for the manuscript, or the numbers as CSV.",
    ],
    links: [{ label: "PRISMA 2020 flow diagram", url: "https://www.prisma-statement.org/prisma-2020-flow-diagram" }],
  },
  "review.extraction": {
    kind: "explain",
    title: "Data extraction",
    body: [
      "For each included study, fill in forms: study characteristics, outcome data for meta-analysis, and risk of bias. Build your own or start from a template, and change any field.",
      "Select a passage in the full text: the menu offers the fields it fits, the focused one first. Enter fills it and keeps the passage as its source (⌥Enter adds only the source), and focus moves to the next empty field. A field's pick button (⌥P) takes the next selection with no menu; ⌘Z takes a fill back. Questions can be shown only for some answers.",
      "With two extractors, each fills the forms on their own; values that differ show side by side until one is agreed.",
    ],
  },
  "review.extraction.quotes": { kind: "hint", text: "Select a passage in the full text and press Enter: the focused field takes it, with the passage kept as its source." },
  "review.outcomes.table": { kind: "hint", text: "Not a RevMan import file: one row per study and outcome, laid out for typing into RevMan or another tool." },
  "review.forms": { kind: "hint", text: "Risk of bias has its own stage with dual assessment, plots and use in analyses." },
  "review.meta": {
    kind: "explain",
    title: "Meta-analysis",
    body: [
      "A meta-analysis pools studies' effects, weighting each by its precision. A fixed effect assumes one true effect; random effects allow it to differ between studies, which is usually more realistic.",
      "I² is the share of variation due to real differences rather than chance; the prediction interval shows where a new study's effect would likely fall. Hartung–Knapp gives wider, more honest intervals with few studies.",
    ],
    privacy: "Calculated on this Mac. Results match R's metafor package on its published examples.",
  },
  "review.egger.few": { kind: "hint", text: "Egger's test needs at least three studies; with fewer than ten, read the funnel plot with care." },
  "empty.review.screen": { kind: "empty", title: "No records to screen yet", what: "Records your searches found are screened here, one at a time.", todo: "Import a file of search results, or add records from your library." },
  "empty.review.fulltext": { kind: "empty", title: "Nothing at full text yet", what: "Records included or kept as maybe at title and abstract come here to be read in full.", todo: "Screen titles and abstracts first." },
  "empty.review.sources": { kind: "empty", title: "No records yet", what: "Each import is listed here with its source and counts for PRISMA.", todo: "Drop a RIS, BibTeX, EndNote XML, PubMed or CSV file on this page." },
  "empty.review.extraction": { kind: "empty", title: "No included studies yet", what: "Studies included at full text are listed here for data extraction.", todo: "Include studies at full-text screening." },
  // std-B: citation searching, conduct checks, AI use and audit, extraction pilots.
  "review.chase": {
    kind: "explain",
    title: "Citation searching",
    body: [
      "Studies you include point to others: the works they cite (backward) and the works citing them (forward). Cochrane requires checking reference lists; TARCiS recommends both directions.",
      "Key looks the studies up in OpenAlex, removes what the review already has and shows the counts before adding anything. Repeat on newly included studies until a round finds nothing new.",
    ],
    privacy: "Sends the studies' DOIs, OpenAlex ids or titles to OpenAlex. Nothing else leaves this Mac.",
  },
  "review.conduct": {
    kind: "explain",
    title: "Conduct checks",
    body: [
      "Soft reminders of what Cochrane's conduct standards (MECIR) and the Campbell standards expect of a review like yours, in Key's own words with a link to each standard.",
      "They never block. If one does not apply, dismiss it with the reason: the reason is kept for the methods section. The review type in Setup changes which checks apply.",
    ],
  },
  "review.ai.audit": {
    kind: "explain",
    title: "Reporting AI use",
    body: [
      "Journals and the Cochrane, Campbell and JBI position on AI ask which tool and version was used, for what, with which prompts, and how well it agreed with people.",
      "Key logs every suggestion with the model, its version, the date and the prompt, compares it with the reviewers' final decisions, and drafts the statement. A blind audit sample measures how many includes the AI would have missed.",
    ],
  },
  "review.xpilot": {
    kind: "explain",
    title: "Piloting the extraction forms",
    body: [
      "Before the main extraction, everyone who extracts fills in the same few studies on their own. Fields with low agreement need clearer wording or guidance.",
      "Agreement is the share of studies with the same value; kappa corrects choices for chance, and the ICC does the same for numbers. Closing the pilot records the date and number of studies for the methods.",
    ],
  },
  "empty.review.analysis": { kind: "empty", title: "Nothing to analyse yet", what: "Outcome data extracted from included studies is pooled here.", todo: "Include studies, then extract their outcome data." },
  "empty.review.outcomes": { kind: "empty", title: "No outcome data yet", what: "Add the Outcome data form in Setup › Extraction forms, then fill it in for each study.", todo: "Rows need an outcome name and events, means or an estimate." },
  // std-A: reporting (PRISMA checklist, protocol, search report)
  "review.checklist": {
    kind: "explain",
    title: "The PRISMA checklist",
    body: [
      "Journals ask for a filled PRISMA 2020 checklist with a systematic review: one line per item saying where the manuscript reports it. Key reads each item from the review itself and says whether its data show it, which rule decided, and the one thing that would close a gap.",
      "Items only the manuscript can show (the title, the discussion) count once you note where they are. Drafts are sentences written from the review's numbers: copy them, check them, adjust them.",
    ],
    steps: ["Open Needs attention and work down the gaps", "Copy a draft into your manuscript", "Note where each item is reported", "Export the filled checklist for the journal"],
    links: [{ label: "PRISMA 2020 checklist", url: "https://www.prisma-statement.org/prisma-2020-checklist" }],
  },
  "review.protocol": {
    kind: "explain",
    title: "Writing and registering the protocol",
    body: [
      "A protocol says before the review starts what it will do: the question, how studies are found and chosen, what data are taken, how they are combined. Registering it shows readers the methods were not chosen after seeing the results.",
      "Key fills in what it knows from Setup and lists the rest in PRISMA-P's order. Once you record the registration, every change to the protocol is kept as a dated amendment with its reason, which the final report lists as deviations.",
    ],
    steps: ["Choose the review type", "Write the fields Key cannot know (rationale, funding, outcomes)", "Register with PROSPERO or OSF using the copy sheet", "Record the registration here"],
    links: [{ label: "PRISMA-P", url: "https://www.prisma-statement.org/extensions" }, { label: "PROSPERO", url: "https://www.crd.york.ac.uk/prospero/" }, { label: "OSF Registries", url: "https://osf.io/registries" }],
  },
  "review.searchreport": {
    kind: "explain",
    title: "Reporting the search",
    body: [
      "PRISMA-S asks for enough about each search that someone else could run it again: the database and its platform, the date, the strategy exactly as run, any limits and filters with their reasons, other ways studies were found, and how duplicates were removed.",
      "Searches run with Key's Database search fill most of this from their log. For a file exported from another platform, add the platform, the date and the strategy you ran.",
    ],
    links: [{ label: "PRISMA-S", url: "https://www.prisma-statement.org/extensions" }],
  },
  // std-C: risk of bias and certainty of evidence.
  "review.rob": {
    kind: "explain",
    title: "Risk of bias",
    body: [
      "Risk of bias asks whether a study's design or conduct could have pushed its result away from the truth. Each tool splits this into domains, such as how groups were formed or how outcomes were measured.",
      "For RoB 2, ROBINS-I, ROBINS-E, Newcastle–Ottawa and QUADAS-2, Key provides the assessment structure; the questions are in the official tool. Answer them there, then record each domain's judgement, its basis and supporting passages here. RoB 2 and ROBINS-I judge each result, so one study can be rated per outcome.",
      "Key's own basic checklist has questions of its own, and Key suggests a judgement from them; a judgement that differs needs a reason.",
    ],
    links: [{ label: "RoB 2 and ROBINS tools", url: "https://www.riskofbias.info" }, { label: "Cochrane Handbook, chapter 8", url: "https://training.cochrane.org/handbook/current/chapter-08" }],
  },
  "review.rob.dual": {
    kind: "explain",
    title: "Two assessors, independently",
    body: [
      "Cochrane expects two people to assess risk of bias independently. With blind on, neither sees the other's answers until both have marked theirs complete.",
      "Then judgements that differ are conflicts, listed under Conflicts. Agree on each one together, or let the tie-breaker decide, as the review's rules say.",
    ],
  },
  "review.rob.plots": {
    kind: "explain",
    title: "Traffic-light and summary plots",
    body: [
      "The traffic-light plot shows each study's agreed judgement per domain, as a colour and a symbol, so it reads in print and without colour.",
      "The summary plot shows, per domain, the share of studies at each level. Choose a result to also see it weighted by each study's weight in that outcome's analysis, which says more about how much the pooled result depends on studies at risk.",
    ],
  },
  "review.rob.keys": { kind: "hint", text: "↑ ↓ move, a number answers, Enter takes the suggestion, ⌥S uses the selection as support, ⌘↩ completes, ⌥↓ goes on." },
  "review.rob.weighted": { kind: "hint", text: "Choose a result with outcome data to weight the summary by each study's weight in its analysis." },
  "review.rob.licence": { kind: "hint", text: "Key ships the official tools' structure only; their questions stay with their authors. Build a tool, or import one you may use." },
  "review.rob.import": { kind: "hint", text: "Import tool definition (JSON): a tool file you or your institution may use, with its questions; it stays in this review." },
  "review.rob.analysis": { kind: "hint", text: "Risk of bias from the Risk of bias stage: leave out studies at high risk, or compare studies by their overall judgement." },
  "empty.review.rob": { kind: "empty", title: "No included studies yet", what: "Studies included at full text are assessed for risk of bias here.", todo: "Include studies at full-text screening." },
  "empty.review.rob.conflicts": { kind: "empty", title: "No conflicts", what: "When assessors' judgements differ once both are done, the domain is listed here to settle.", todo: "Nothing to do here for now." },
  "empty.review.rob.plots": { kind: "empty", title: "No agreed judgements yet", what: "The plots show judgements that the assessors agreed or settled.", todo: "Finish assessments in Assess." },
  "review.grade": {
    kind: "explain",
    title: "Certainty of the evidence (GRADE)",
    body: [
      "GRADE rates how sure you can be about each outcome's pooled result: high, moderate, low or very low. Evidence from randomised trials starts high, from non-randomised studies low.",
      "Rate down for risk of bias, inconsistency, indirectness, imprecision or publication bias; non-randomised evidence can also be rated up. Key suggests each judgement from the data with its reasons, and never applies one for you.",
      "Each judgement that rates down or up needs a footnote: it explains the Summary of findings table.",
    ],
    links: [{ label: "GRADE handbook", url: "https://gdt.gradepro.org/app/handbook/handbook.html" }, { label: "Cochrane Handbook, chapter 14", url: "https://training.cochrane.org/handbook/current/chapter-14" }],
  },
  "review.grade.statement": { kind: "hint", text: "Key words the statement from the size of the effect and its certainty: “probably” for moderate, “may” for low." },
  "review.grade.levels": { kind: "hint", text: "High: the true effect is close to the estimate. Moderate: probably close. Low: may differ a lot. Very low: likely to differ a lot." },
  "review.grade.gradepro": { kind: "hint", text: "GRADEpro has no public import format for this table; it imports RevMan data packages. Export for Word, Markdown or CSV." },
  "empty.review.sof": { kind: "empty", title: "No outcomes rated yet", what: "Each outcome you rate in Rate outcomes becomes a row of the Summary of findings table.", todo: "Rate the certainty of an outcome first." },
  // end std-C
  // std-D: advanced synthesis and exports.
  ...SYNTHESIS_HELP,
} satisfies Record<string, HelpEntry>;
