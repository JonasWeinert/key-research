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
- **Sources**: import batches (file drop: RIS, BibTeX, EndNote XML, PubMed .nbib, CSV; library
  selection, collection or smart filter; database search runs with their strategies and counts;
  other methods: citation searching, registers, websites, organisations, manual). Each batch can
  be inspected or removed. De-duplication: exact duplicates are removed on import (counted), likely
  ones wait in a pair review (keep both / mark duplicate).
- **Title & abstract**: one record at a time, keyboard first (I include, E exclude, M maybe,
  1–9 the failed criterion, N note, ⌘Z undo, J/K or arrows next / previous), keyword highlighting, rule and AI
  suggestions, progress. A list mode with filters (undecided, mine, conflicts, maybe, keyword,
  suggested, re-screen, label) and batch decisions. A conflicts view to resolve.
- **Full text**: queue (awaiting full text, to assess, conflicts, done); the PDF in Key's reader
  beside the decision panel; the failed criterion per the rules; highlights from the reader can be
  attached as evidence. Retrieval tracking: find PDF, mark "not retrieved" with a reason.
- **Extraction**: form builder (sections; text, long text, number, choice, multi-choice, date,
  yes/no, table / repeating group; guidance, required, quote required), templates (study
  characteristics, dichotomous / continuous / generic outcomes, RoB 2-style, ROBINS-I-style,
  Newcastle–Ottawa-style — Key's own wording), dual extraction with comparison and consensus,
  AI pre-fill as suggestions with source passages. Export: wide CSV, an outcome table for RevMan-style entry (not a RevMan import file), tidy
  long CSV for R.
- **Analysis**: pick an outcome; effect measure (RR, OR, RD, MD, SMD/Hedges' g, generic inverse
  variance); fixed and random effects (DerSimonian–Laird, REML; Hartung–Knapp); heterogeneity (Q,
  I², τ², prediction interval); subgroups; leave-one-out; Egger's test; forest and funnel plots
  (`src/renderer/charts/`), exportable.

## Performance

Records are rows in SQLite with an index per review; screening loads one record at a time and the
queue (ids in order) once. Derived state for 20,000 records with two reviewers rebuilds in well
under a second (`perf` test in `key-review`).

## Not yet

Sync and web sharing (designed in `docs/review-sync.md`), study-level grouping of several reports
beyond a simple "same study as" link.
