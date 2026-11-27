# Systematic reviews and meta-analysis in Key

A *review* is a first-class object of a workspace: a PRISMA 2020 / Cochrane-style systematic
review with screening, full-text assessment, data extraction and meta-analysis. A workspace can
hold several. It opens as an ordinary tab (sidebar "Reviews", the command "New systematic
review…", the library's "Send to review…" selection action, and the Sources stage's "From a
database search").

All logic is Rust (`crates/key-review`), exposed by the host as `review_*` commands
(`crates/key-desktop-host/src/review_commands.rs`). The renderer (`src/renderer/review/`) draws.

## Principles

- **A solo reviewer starts screening within a minute.** A new review has sensible defaults: one
  reviewer per stage, a "Maybe" choice, the failed criterion named at full text only, and
  suggested criteria for the question's parts, added in one click. Import a file or a library
  collection and press Title & abstract.
- **A Cochrane team can tighten every rule.** Two or more independent reviewers per stage, blind
  mode, conflicts resolved by consensus or by a third reviewer, failed criteria named at both stages ("one",
  "all that apply" or "none"), quotes required for extracted values, pilot rounds with agreement
  statistics before the main round.
- **Nothing silent.** Rules linked to metadata pre-suggest a decision with the rule shown as the
  reason. Auto-applying them is a per-criterion opt-in; an auto-applied decision is an event like
  any other, labelled as automatic, counted in PRISMA as "marked ineligible by automation tools",
  and undoable.
- **AI is a suggestion.** Off by default; never counts as a reviewer; shown with its rationale.

## Data model: events first

Every change is an append-only **event**; everything else is derived.

```
events(review_id, id TEXT PRIMARY KEY   -- UUIDv7: time-ordered, globally unique
       seq INTEGER                      -- local insertion order (not shared)
       at INTEGER                       -- ms since epoch (wall clock of the device)
       actor TEXT                       -- reviewer profile id ("system" for imports)
       device TEXT                      -- device id, for sync
       kind TEXT                        -- see below
       version TEXT                     -- protocol version (event id) in force when made
       record_id TEXT NULL
       payload JSON)
```

Order is `(at, id)`; with UUIDv7 ids this is the same on every device, so replaying a merged log
gives the same state everywhere. Concurrent edits of the same slot resolve last-writer-wins on
that order; independent slots (each reviewer's own decision) never collide.

Event kinds (payload fields in `docs/review-sync.md`):

| kind | what |
|---|---|
| `review.create`, `review.rename`, `review.archive` | the review itself |
| `protocol.set` | the whole protocol (question, rules, criteria, forms, keywords) with a change note; a new version unless `amend` (allowed while no decision was made under the current version) |
| `criteria.alias` | old exclusion reason ids → the criteria they became (reviews from before criteria and reasons were one list) |
| `team.set` | reviewer profiles and roles (owner, reviewer, tie-breaker) |
| `batch.add`, `batch.remove` | an import: where from (library, file, database run, other method), PRISMA group, strategy, counts |
| `records.add` | up to 500 records of a batch (metadata snapshot) |
| `dedup.set` | a record is a duplicate of another (auto exact, or a reviewer's choice), or `distinct` |
| `decision` | one reviewer's include / exclude / maybe at a stage, the criteria it fails (`reasons`), note, evidence, `auto` rule |
| `decision.retract` | undo of a decision event |
| `resolve` | the final decision of a conflict (consensus or tie-breaker) |
| `note`, `labels` | a reviewer's note, labels on a record |
| `fulltext.set` | retrieval: sought / retrieved / not retrieved (reason), linked library source |
| `assign` | which reviewers screen which records at a stage (splits) |
| `pilot.set` | a calibration round: sample, reviewers, stage, open / closed |
| `rescreen.flag` | records to look at again after a protocol change |
| `extract.value` | one reviewer's value for one field (and row) of a form, quote, page |
| `extract.final` | the consensus value after dual extraction |
| `ai.suggest` | an AI suggestion (never a decision) |
| `analysis.set` | a saved meta-analysis setup |
| `chase.round` | a citation-searching round: direction, seeds, service, date, found / already in the review / new, its batch |
| `ai.prompt`, `ai.audit` | an AI prompt template's text once per version (id, version, SHA-256); a blind audit sample |
| `conduct.dismiss`, `conduct.retractions` | a conduct check dismissed with its reason; a retraction check of the included studies |
| `xpilot.set`, `form.piloted` | an extraction pilot round; forms recorded as piloted (date, studies, agreement, form hashes) |
| `contact.log` | a contact with a study's authors: date, who, how, what was asked, reply, data received |
| `protocol.register` | the protocol's registration (registry, id, date, address), or its withdrawal |
| `checklist.note` | where the manuscript reports a checklist item, and notes |
| `search.source`, `search.peer_review`, `search.prior` | PRISMA-S details of a source, a peer review of the strategies, reused prior work |
| `rob.tool`, `rob.setup`, `rob.study` | risk-of-bias tools of the review, assessors and blind mode, a study's tool and results |
| `rob.answer`, `rob.evidence`, `rob.complete`, `rob.final` | one assessor's answers, judgements and supporting passages; done; the agreed judgement |
| `grade.set`, `grade.order` | an outcome's certainty rating (GRADE); the Summary of findings order |

**Derived state** (`derive.rs`) is a fold over events: current decision per (record, stage,
reviewer), each record's status per stage (undecided, needs another reviewer, conflict, included,
excluded, maybe), PRISMA counts, agreement statistics, extraction tables. It is kept in memory per
open review and updated as events are appended; a merged import replays from scratch.
`records` is also materialised in SQLite (metadata columns, indexed) so lists of 20,000 records
page and filter in SQL.

**Blind mode** is enforced in the read path: a reviewer's queries do not return other reviewers'
decisions, reasons or notes on a record until the record leaves "needs another reviewer" (all
required reviewers decided) — and then only conflicts are shown, to people who may resolve them.

## Protocol and versioning

The protocol is one JSON document: question (PICO, PECO, SPIDER or free text), registration id
and notes, rules per stage, criteria (ordered: the first failed criterion is the reason PRISMA
reports), highlight keywords, extraction forms. Every saved change makes
a new version with a note; decisions record the version they were made under. Saving a change to
criteria offers to flag earlier decisions made under older versions for re-screening (only
decisions that a changed or removed criterion could have affected; reviewers see a
"Re-screen" filter).

**Criteria are the reasons.** There is one list. A criterion is a rule a study must meet, stated
once ("Adults with type 2 diabetes"); excluding a study means choosing the criterion (or
criteria, per the stage's rule: one, all that apply, none) it fails, and that criterion is the
reason PRISMA reports. Each has the part of the question it belongs to (population,
intervention or exposure, comparator, outcome, study design; sample, phenomenon, evaluation,
research type for SPIDER; other: language, dates, publication type, duplicates, full text), a
short reason wording for reports ("Wrong population", derived from the statement unless
edited), guidance, the stages it is checked at, and an optional **metadata link**: conditions on
document type, year, language, has abstract / full text / DOI, any field, any custom property of
the linked library source, or a Key formula, saying when it is met. A record that fails a linked
criterion gets the *effect*: `suggest` (default; "Suggested: exclude — Not met: Year is 2000 or
later") or `auto` (applied as a decision by the "rules" actor, visible and undoable). Setup
offers suggested criteria for each part of the question, with the question's own words as their
guidance.

Two reviewers who both exclude, for different criteria, are not in conflict: the record is
excluded either way and PRISMA reports the criterion highest in the list. Full-text screening
shows the difference so whoever may resolve can settle the reason.

Reviews from before criteria and reasons were one list are migrated when first opened: a reason
a criterion named collapses into it, other reasons become criteria (Key's defaults under their
part of the question, the rest under Other), exclusion criteria are restated as what a study must
meet, and the old reasons' order stays the hierarchy. The log is not rewritten: a
`criteria.alias` event records which old reason id became which criterion, and an amended
`protocol.set` the protocol as it now reads, so old decisions resolve to criteria.

## Splits: pilots and assignment

- **Pilot round**: a random sample (size or percent, seeded, reproducible) that every chosen
  reviewer screens. While a pilot is open its records come first. Its panel shows percent
  agreement and Cohen's kappa (two reviewers) or Fleiss' kappa (three or more), per pair and
  overall, and the disagreements to discuss. Closing it lets the main round start.
- **Assignment** of the rest: everyone screens everything (default), or split randomly, balanced,
  or by percentages across reviewers, with a double-screened proportion (e.g. 20 % by two people).

## Stages (screens)

Top bar: **Overview** · Setup · Sources · Title & abstract · Full text · Extraction · Analysis,
with live counts. A reviewer switcher ("Screening as …") sits at the right.

- **Overview**: the PRISMA 2020 flow diagram from real numbers (export SVG/PNG/CSV), stage
  progress, what to do next, agreement.
- **Setup**: question, team and rules, criteria (by part of the question, with suggestions), keywords, versions (with notes)
  and the audit trail. Template save/load (JSON).
- **Sources**: four views. *Records*: every record in one virtualised table (chosen columns,
  sorting, filters by import, PRISMA group, stage status, abstract, full text; status chips: no
  abstract, no DOI, no full text, duplicate, report; multi-select with a bulk panel). A record
  opens beside the table with every field edited in place (`record.edit`), "Look up" by DOI,
  PMID or title with a field-by-field comparison to accept (`record.enrich`, noting the source),
  its full text attached, replaced or removed by drop or picker, where it was found
  (`record.origin`), removed by hand or restored (`record.remove`: PRISMA "removed for other
  reasons"), or marked as another report of a study (`study.link`: PRISMA counts reports and
  studies apart). "Complete metadata" does the lookup for the selection (or everything shown),
  then shows every difference to accept. *Database searches*: Database search's own builder,
  picker and per-database preview embedded, started from the question's parts; "Search and
  import" runs it and imports the run as a batch (strategy, per-database counts, registers apart,
  de-duplicated); searches belong to the review (`search.set`, `search.ran`) and "Update search"
  imports only records not already there, as a dated batch noting how many were left out. "Find missing abstracts" fills abstracts, DOI, PMID, year and journal from the
  record's duplicates in other imports first (the longest abstract), then the same work in the
  library, then, when asked, OpenAlex/Crossref/PubMed through Key's own lookup; every value is a
  `record.enrich` event noting where it came from, shown beside it. *Duplicates*: the pairs to
  check, then every duplicate decision (automatic and by hand) with the record kept, why they
  matched, who and when; "Not duplicates" splits them, "Merge these…" joins records missed.
  *Imports*: batches (file drop: RIS, BibTeX, EndNote XML, PubMed .nbib, CSV; library selection,
  collection or smart filter; database search runs with their strategies and counts, registers in
  a run counted as registers from the connector's `prisma` kind; other methods), inspected or
  removed.
- **Title & abstract**: one record at a time, keyboard first. Per stage and per choice the rules
  say whether a decision names the criterion not met: no, the first one, or all that apply
  (`reasons` for Exclude, `maybeReasons` for Maybe). Two routes: E (or M) opens the criteria
  step, a number picks (and records it when the rule wants the first one and auto-advance is on),
  Enter records, Esc backs out; or numbers first, then E or M. 0 is "Other…": a text in the
  reviewer's words, stored on the decision (`other`), reported by PRISMA under "Other" with its
  words, and offered in Setup as a criterion once it recurs. Label keys (B background, L check
  later, editable) toggle labels without moving on. N note, ⌘Z/U undo, J/K next / previous. The
  counter walks the session's own list (`review-session.ts`): "2 of 120" after the first
  decision, consistent through back, forward and undo. Labels have counts, tabs in the list and a
  queue of their own; labelled records go to the library from the list. A list mode with filters
  and batch decisions; a conflicts view to resolve.
- **Full text**: the record's PDF (or saved page) is the main panel inside the review tab
  (PdfJsBenchmarkApp embedded, bytes from `review_fulltext_bytes`), a compact header above, the
  decision in the right sidebar. The reader's selection toolbar carries the review's actions
  through its `selectionActions` prop: "Does not meet…" / "Meets…" (criterion picker, numbers),
  "Evidence for include", "Note". A passage marked not met is kept with page and position as
  evidence (listed beside, a click shows the place) and offers "Exclude and go to next". *Full
  texts* view: status per record; find in bulk (background, progress); drop many PDFs, matched to
  records by DOI, title, first author and year (confident / uncertain / unmatched, each
  changeable); a CSV of records still needing one with an empty filename column, uploaded back
  with the files and matched by file name with an error per row; the record's page saved as its
  full text. Files are kept with the review (`reviews/<id>/files/<hash>.<ext>`, `fulltext.set`
  with a `file`), linked instead when the library has the same file, and added to the library
  only on "Also add to library". Not retrieved stays a status with a reason.
- **Extraction**: the study's full text as the main panel, its forms in the sidebar. A selection
  goes into a field ("Use for ‹field›…": the field last focused, else a picker with type-ahead and
  numbers); numbers are read the way papers write them (`logic::parse_selection`: mean (SD), n =,
  %, estimate with CI, events/total) and offered with a confirmation; a table row can be filled
  from one selection. Every value keeps its source (`sourcePos`: page, boxes, quoted text) as a
  chip that brings the place back. Per field and as a default: source position not needed /
  encouraged / required, checked with required answers, quotes and cross-field checks when a form
  is completed (`extract.complete`), only for the fields shown. "Show when…" rules on fields and
  sections (is, is not, one of, yes/no, number comparisons, answered / not; all or any), nested to
  any depth, inside tables on the same row; hidden answers are kept but inactive, not required,
  blank in exports; circles are refused in plain words. The builder shows a follow-up under its
  question with the rule as a sentence, adds follow-ups from a choice's option, nests by dragging,
  and previews which questions sample answers bring up (`review_form_preview`). Exports carry a
  source column per field and a data dictionary (field, type, options, show-when, checks). Form
  builder (sections; text, long text, number, choice, multi-choice, date,
  yes/no, table / repeating group; guidance, required, quote required), templates (study
  characteristics, dichotomous / continuous / generic outcomes; risk of bias has its own
  stage), dual extraction with comparison and consensus,
  AI pre-fill as suggestions with source passages. Export: wide CSV, an outcome table for RevMan-style entry (not a RevMan import file), tidy
  long CSV for R.
- **Analysis**: pick an outcome; effect measure (RR, OR, RD, MD, SMD/Hedges' g, generic inverse
  variance); fixed and random effects (DerSimonian–Laird, REML; Hartung–Knapp); heterogeneity (Q,
  I², τ², prediction interval); subgroups; leave-one-out; Egger's test; forest and funnel plots
  (`src/renderer/charts/`), exportable. More effect sizes: correlations (r, Fisher's z), partial
  correlations from t and df (metafor's variance or the economics SE), response ratio, incidence
  rate ratio, proportions (logit, Freeman–Tukey with Miller's back-transformation), standardised
  mean change, hazard ratios.
- **More analyses** (`synthesis.rs`, UI `review-synthesis.tsx`): several estimates per study
  (correlated and hierarchical effects with CR2 robust SEs and Satterthwaite df, a three-level
  REML model, or aggregation; `dependence.rs`, `multilevel.rs`); meta-regression with continuous
  and categorical moderators, REML, Knapp–Hartung, R², permutation test and bubble plot
  (`metareg.rs`); FAT-PET, PEESE and the conditional rule (robust SEs with several estimates),
  UWLS/WAAP, trim and fill (L0/R0), the three-parameter selection model and a contour-enhanced
  funnel (`pubbias.rs`); influence diagnostics, Baujat plot, cumulative analysis and a model
  comparison (`sensitivity.rs`). Each is tested against metafor 5.2-1 (run locally), R's lm, or
  clubSandwich results printed in metafor's documentation; no R at runtime. A risk-of-bias
  moderator comes from `rob::covariates` when assessments exist.
- **Conversions** (`conversions.rs`, UI `review-convert.tsx`): the helper on an outcome row
  computes SE/CI/p/t, SDs from SE/CI/IQR/range, mean and SD from medians (Luo/Wan/Shi, as
  conv.fivenum, with the skewness check), change-score SDs, combined groups, events from
  percentages, split shared groups and cluster effective sample sizes, and stores method, formula
  and source on the row (`_conversions`).
- **Exports others import** (`interop.rs`, `rscript.rs`, `revman.rs`, `migrate.rs`): per saved
  analysis an R script with its data that checks every number against Key's (`all.equal`), a
  Stata do-file for the basic model; RevMan Web's study information, arms and results CSVs plus a
  RIS with NS = Study ID, with a validator for its documented import rules; included and excluded
  studies as RIS/BibTeX/CSV; a replication bundle (zip with README, manifest and SHA-256 sums,
  optional anonymised reviewers); and an import of records and decisions from Covidence, Rayyan
  or any CSV with a column mapping.
- **Risk of bias** (`rob.rs`, `certainty.rs`, `review-rob.tsx`): an assessment belongs to a study
  and, for result-level tools (RoB 2, ROBINS-I, ROBINS-E), to one result: an outcome and time
  point of the outcome tables ("whole study" otherwise, and the fallback for a result without
  its own). A tool is data (`crates/key-review/rob-tools/*.json`, editable per review, exported
  and imported as JSON, built from scratch in the tool builder): judgement levels (colour,
  symbol, what they count as in analyses), domains, points to consider with response options,
  and a suggestion rule per domain (the answer raising most concern, or stars) and overall (the
  least favourable domain, or none). Shipped: Key's own basic checklist (its own questions and
  suggestion rule), and the structure only of RoB 2, ROBINS-I v2, ROBINS-E, Newcastle–Ottawa and
  QUADAS-2: Key's neutral domain labels, the judgement scale, a worst-domain overall default and
  a link per domain. Their questions and algorithms stay in the official tools (RoB 2 and the
  ROBINS tools are CC BY-NC-ND; the others state no licence; see LICENSES.md): the assessor
  answers there and records each judgement, its basis and supporting passages in Key. Anyone
  holding the rights to a fuller version imports it as a tool definition (JSON) into their
  review. A judgement that differs from a suggestion needs a reason. The reader is the main
  panel, the assessment the sidebar; a selection becomes support for the domain in focus with
  its page and boxes. Two (or more) assessors work independently; blind until all have
  finished; then differing domains are conflicts (a queue) agreed by consensus or a
  tie-breaker. Answers in old RoB extraction forms are brought in on request ("Bring them in",
  once per study and form). Plots: traffic light (studies × domains) and summary bars, unweighted
  and weighted by an outcome's analysis, light and dark on screen, print palette in SVG/PNG.
  In Analysis: the per-domain judgements beside the forest plot, a flag for studies without an
  assessment, the analysis without the studies at high risk, and subgroups by overall risk.
  Other analyses read `rob::covariates` (or the `rob-covariates` export).
- **Certainty** (`grade.rs`, `review-grade.tsx`): GRADE per outcome, linked to that outcome's
  analysis (measure and model). Start high (randomised) or low (non-randomised; high when rated
  with ROBINS-I); five domains to rate down, three to rate up for non-randomised evidence; each
  judgement other than "not serious", or other than Key's suggestion, needs a footnote. Key
  suggests from the data and says why, never applying it: risk of bias from the share of
  weight at high (or some) risk and the estimate without those studies; inconsistency from I²,
  the prediction interval and overlap of intervals; imprecision from the interval against no
  effect and the smallest important difference (per 1,000 for dichotomous outcomes) and the
  optimal information size; publication bias from Egger's test with ten or more studies;
  indirectness by hand. The Summary of findings: outcomes in the reviewer's order with
  importance, assumed risk (studies' median control risk, or entered), risk with the
  intervention and the difference per 1,000 with intervals (odds ratios converted through the
  odds), relative effect, participants and studies, certainty with GRADE's circles and
  footnotes, and a plain-language statement ("probably", "may"). Export for Word (HTML),
  Markdown, CSV. GRADEpro has no public import format for such a table (it imports RevMan
  data packages), so Key writes none.

## Standards in conduct (citation searching, AI use, conduct checks, pilots)

- **Citation searching** (Sources › Citation searching; `chasing.rs`): from the included studies
  not chased yet (or any chosen), backward (reference lists) and forward (citing works) through
  OpenAlex as a background job with progress and Stop; requests are batched (50 ids or DOIs
  each, citing works by cursor) and cached for a day. A seed without a DOI is found by title,
  year and first author with the review's duplicate matcher; one OpenAlex does not know uses the
  reference list Key read from its full text. The counts come first (found, already in the
  review, new), then the new records go in as one batch under PRISMA's other methods, "Citation
  searching", with the strategy line PRISMA-S reads, most linked to the seeds first when chosen
  (co-citation and bibliographic coupling). A round that finds nothing new is the hint to stop.
- **AI use** (Overview › Conduct › AI use; `ai_audit.rs`): every AI suggestion's event carries the
  provider, the model asked for and as reported, the prompt template id, version and SHA-256 (the
  text kept once per version), the request's hash, settings and the fields read. What the person
  did (accepted, changed, rejected) is read from their own later events. Agreement with the final
  decisions (2×2 table, sensitivity, specificity, false-negative rate, Cohen's κ; per field for
  extraction), a blind audit sample (MAER-Net 2026: the larger of 10 % or 100 records, of 10 % or
  20 studies for coding; the AI's suggestion is hidden from the auditor until they decide), and a
  statement for the methods with the prompts as an appendix (export "AI use statement").
- **Conduct checks** (`conduct.rs`): soft warnings in Key's words with a link to MECIR, Campbell,
  MAER-Net or TARCiS, per the review type in Setup (systematic, scoping, rapid, living): single
  screening or extraction, no calibration round, fewer than two databases, no register, grey
  literature or citation searching, searches over 12 months old once data are extracted,
  retractions not checked (one click checks Crossref and OpenAlex and records it), full-text
  exclusions without reasons, no or single risk-of-bias assessment, outcomes the protocol's plan
  does not name, open conflicts, records awaiting classification, AI not audited. Dismissed with a
  reason, kept in the log. `conduct::reporting_facts(state)` is what the PRISMA checklist reads.
- **Extraction pilots and contacts** (Extraction toolbar; `xpilot.rs`): a seeded sample of included
  studies every chosen extractor fills in; agreement per field (percent; Cohen's or Fleiss' κ for
  choices; ICC(2,1) and mean absolute difference for numbers); "Forms piloted" records the date,
  studies and agreement, and later changes to a piloted form show with their protocol versions. The
  contact log feeds the missing-data reporting and exports (CSV).

## Reporting (PRISMA checklist, protocol, search report)

- **Overview › PRISMA checklist** (`checklist.rs`): PRISMA 2020's 42 rows and its 12 abstract
  items, PRISMA-S's 16, PRISMA-ScR's 22 for a scoping review and two PRISMA-LSR additions for a
  living one, each with a status computed from the review (evidenced, partly, missing, not
  applicable, not recorded yet), the rule that decided it, links to where it shows (a Setup
  section, a Sources view, the search report, an export), the one action that closes a gap, a
  draft sentence from the data, and where the manuscript reports it (`checklist.note`).
  "Generate methods section" drafts Methods and the Results flow paragraph (deterministic text,
  no model). Exports: Markdown, HTML for Word, CSV, in the official order with attribution
  (CC BY 4.0; descriptions are Key's paraphrases). Parts other review modules supply (AI use,
  risk of bias, certainty, analysis and sharing statements) come through
  `reporting_hooks::facts`.
- **Setup › Protocol** (`protocol_doc.rs`): the protocol in PRISMA-P 2015's order. What Key knows
  is written in (question, criteria, rules, forms, searches); the rest is `Protocol::plan`
  (text fields, authors with guarantor and contact, outcomes with priority, planned subgroup and
  sensitivity analyses, review type), versioned with the protocol. A completeness meter counts
  the required fields. `protocol.register` records the registration (registry, id, date,
  address); from then on any change the protocol states is a new version that needs a reason,
  and the versions after the registered one are the **deviations from protocol** (PRISMA 24c,
  exported as CSV or Markdown). Exports: a PRISMA-P protocol (Markdown, HTML), a PROSPERO copy
  sheet (fields in the form's order, the review's stage derived from the log; the 2025 form's
  labels come from a secondary description, as PROSPERO needs an account) and an OSF outline.
  Nothing is submitted anywhere.
- **Overview › Search report** (`search_report.rs`): PRISMA-S for the whole review. Database
  search runs give platform, dates, every query as sent with its counts and Key's
  reconstruction from their log (`db_strategy`); file imports are completed by the reviewer
  (`search.source`: platform, coverage, date, strategy as run, limits with reasons, cited
  filters, notes) with what is missing named per source; other methods with dates and counts;
  update searches; prior work (`search.prior`); peer review of the strategies (`search.peer_review`,
  PRESS 2015 by default); totals before and after de-duplication with the method described.
  Exports: an appendix (Markdown, HTML), a CSV and the machine-readable JSON.

## PRISMA counts

- "Records screened" counts finished title/abstract decisions; what is still to screen is shown
  apart ("75 of 315", "240 still to screen", muted) and never in the exported figure, which warns
  before exporting while anything is unfinished. The same for "Reports assessed".
- Every box adds up (tested): identified − removed before screening = screened + still to screen;
  screened − excluded = sought; sought − not retrieved = assessed + still to assess; assessed −
  excluded = included, every exclusion with its reason.
- Imports say where their records came from: a named database or register (left column,
  screened) or one of PRISMA 2020's other methods (citation searching, websites, organisations,
  contact with authors or experts, hand searching, other). A library or file import with no
  answer counts as "Databases — source not specified" and asks to be named. Origins are editable
  per import (`batch.set`) and per record (`record.origin`); older reviews' "Manual" imports are
  flagged with a one-click fix.
- Records from other methods follow PRISMA 2020's right-hand path (sought → assessed →
  included). Key screens them at title and abstract like every record; those excluded there are
  reported in the right column's "Records identified" box ("Excluded on title and abstract"), an
  adaptation the PRISMA 2020 statement allows, so no record leaves the flow unaccounted for.

## Performance

Records are rows in SQLite with an index per review; screening loads one record at a time and the
queue (ids in order) once. Derived state for 20,000 records with two reviewers rebuilds in well
under a second (`perf` test in `key-review`).

## Not yet

Sync and web sharing (designed in `docs/review-sync.md`). Extraction stays per report when
several reports form one study (PRISMA counts studies and reports apart). Saved web pages show as
saved, without the reading mode's selection actions until that reader takes them (an iframe with
its own small toolbar meanwhile). RevMan Web's risk-of-bias CSV (its RoB 2 header is not public) and a check against Cochrane's own Excel templates.
