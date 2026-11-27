<p align="center">
  <img src="assets/readme/key-logo.svg" alt="Key" width="260"/>
</p>

<h1 align="center">Read, annotate and connect the literature you work with</h1>

<p align="center">
  An open-source reference manager, PDF reader and notes app for macOS.<br/>
  Your papers, highlights, notes and canvases live in one local library, searchable by words and by meaning.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#key-and-zotero">Key and Zotero</a> ·
  <a href="#install">Install</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#what-key-does-not-do-yet">Not yet</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active_development-6F9B4B?style=flat-square" alt="Status: active development"/>
  <img src="https://img.shields.io/badge/platform-macOS_Apple_silicon-16161D?style=flat-square" alt="Platform: macOS on Apple silicon"/>
  <img src="https://img.shields.io/badge/release-build_from_source-8A8A8A?style=flat-square" alt="Release: build from source"/>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT_(Key_code)-DCD7BA?style=flat-square&labelColor=16161D" alt="License: MIT for Key's own code"/></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/key-library-dark.png"/>
    <img src="assets/readme/key-library.png" alt="The Key library: sources in a table with authors, year and journal, collections and notes in the sidebar, and the selected paper's details beside the list" width="100%"/>
  </picture>
</p>

> Key is in active development. There is no packaged release yet: you build it from source, and the result is an unsigned app for Macs with Apple silicon.

## Features

- **A PDF reader built for papers.** Highlights and comments are anchored to the text, so they survive zoom and reopening, and each one gets a marker in the margin. Hover an in-text citation to see the work it cites; the reference list sits beside the paper, with what is already in your library marked and the rest one click from being added.
- **Notes that point back to the source.** Copy a passage as a quote and paste it into a note: the quote links to the exact place in the PDF or web page. Cite a source by typing `@`, or several at once with page numbers from the citation picker, add a bibliography block in the citation style you chose, and let the reference checker flag cited works that are retracted, lack details, or have a published version of a cited preprint in your library.
- **One search for everything.** Titles, metadata, the full text of every PDF, web page and note, and on-device semantic search. Filters work as tokens: author, journal, topic, tag, collection, year, reading status, citation count. Database search builds one Boolean query from blocks and runs it, translated, on PubMed, OpenAlex and other databases.
- **Metadata from OpenAlex.** PDFs are identified by the DOI they carry (or by title and authors), and references by DOI, PMID or OpenAlex id. Key fills in authors and institutions, the journal, topics, funders, open-access status and citation counts, and warns when a work has been retracted. People, journals and topics get pages of their own, with relation maps of what goes together.
- **Find and save papers.** Search OpenAlex and Semantic Scholar from inside Key, and Google Scholar too with your own SerpApi key. The built-in browser saves PDFs and web pages as sources you can annotate, and goes through your library's EZproxy or OpenAthens login. Find PDF looks for an open-access copy of references that have none.
- **Works with Zotero.** Import a Zotero library once, or keep following it through the Key Sync plugin for Zotero.
- **Citations and bibliographies.** CSL styles (any `.csl` file or a style from the CSL repository) for Copy Reference and Copy In-Text Citation. BibTeX, BibLaTeX, RIS, CSL-JSON and CSV import and export with stable citation keys, and `.bib` files that update themselves when the library changes.
- **Properties and formulas.** Add your own typed properties, work values out with formulas built from blocks or typed as text, group the library by any of them, and let Fill with AI read each source and propose a value with the passage it came from, for you to accept.
- **A tidy library.** Duplicate detection and merging, metadata refresh with a field-by-field review, retraction alerts, batch editing with undo, a tag manager that suggests merges and hierarchies, and file naming rules with an optional readable mirror folder.
- **Keep up and keep notes elsewhere.** Follow journals, feeds, authors and searches in an Inbox. Reading status follows what you open. Highlights export to Markdown files (for Obsidian or any other vault) without overwriting what you wrote there.
- **Local by default.** Each workspace is a folder on your Mac with its own SQLite library. Canvases, tabs, splits and several windows let you lay out what you are working on.

### Reading

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/key-reader-dark.png"/>
    <img src="assets/readme/key-reader.png" alt="The PDF reader: highlighted passages with margin markers, a citation card showing the cited work's abstract, and the paper's references beside it, marked In library or Add to library" width="100%"/>
  </picture>
</p>

The reader draws pages with PDF.js; a native Rust service built on PDFium supplies the exact text, its geometry, search, outlines and links. An on-device layout model recovers headings, reading order and the bibliography, so in-text citations work even in PDFs that do not link them. The rail on the reader's edge shows chapters or page thumbnails, with your highlights marked.

<table>
<tr>
<td width="50%"><img src="assets/readme/key-reading-mode.png" alt="Reading mode: a paper reflowed as plain text with its title, authors, abstract and first section"/></td>
<td width="50%"><img src="assets/readme/key-tab-switcher.png" alt="The tab switcher over the search tab, listing six open tabs, most recent first, with their numbers"/></td>
</tr>
<tr>
<td valign="top"><strong>Reading mode</strong><br/>The paper as reflowed text in your choice of type, built from its layout. Highlights show on their words and your place is kept both ways.</td>
<td valign="top"><strong>Tab switcher</strong><br/>Hold Control and press Tab to go through your tabs, most recent first; a quick tap goes back to the last one.</td>
</tr>
</table>

### Notes and canvases

<p align="center">
  <img src="assets/readme/key-note.png" alt="A note beside the paper it quotes: citations in APA style, a quote that links back to its passage, and a generated reference list" width="100%"/>
</p>

Notes are Markdown with blocks, quotes from highlights, media, and `@` links to any source, highlight, person, journal, note or canvas. Backlinks show where each item is mentioned. Canvases lay out sources, notes and highlights as cards with connectors.

<table>
<tr>
<td width="50%"><img src="assets/readme/key-canvas.png" alt="A canvas with source cards in a frame, a note card and connectors between them"/></td>
<td width="50%"><img src="assets/readme/key-web-page.png" alt="A saved web page in Key's reader with three highlights, one commented, and the highlights panel beside it"/></td>
</tr>
<tr>
<td valign="top"><strong>Canvases</strong><br/>Sources show their abstract or preview; notes show their text.</td>
<td valign="top"><strong>Saved web pages</strong><br/>Read offline, highlighted and searchable like a PDF.</td>
</tr>
</table>

### Citations

<p align="center">
  <img src="assets/readme/key-settings-citations.png" alt="Settings › Citations: the citation style and language, a live preview of an in-text citation and a bibliography entry, and installing more CSL styles" width="80%"/>
</p>

Pick any CSL style and language once; Copy Reference (⌘⇧C), Copy In-Text Citation (⌘⇧A), quotes from the reader and the bibliography blocks in notes all follow it. Citation keys, BibTeX and the other export formats are under Citation keys & export.

### Search

<table>
<tr>
<td width="50%"><img src="assets/readme/key-search.png" alt="Search results for 'analysis plan' filtered to one author, with matches marked in titles, abstracts and the text"/></td>
<td width="50%"><img src="assets/readme/key-web-search.png" alt="Web results from OpenAlex and Semantic Scholar, works already in the library marked, and one result's details beside the list"/></td>
</tr>
<tr>
<td valign="top"><strong>The library</strong><br/>Matches grouped by item and marked in titles, details and passages.</td>
<td valign="top"><strong>The web</strong><br/>OpenAlex and Semantic Scholar in the same search, with "In library" where you have the work.</td>
</tr>
</table>

Semantic search runs EmbeddingGemma through llama.cpp on your Mac. A search of your library stays on it; only the Web results send the query out.

<p align="center">
  <img src="assets/readme/key-database-search.png" alt="Database search: two concepts joined by AND, the second nesting (replication OR reproducib*) NOT protocol, a plain-language reading of the query, and the query as PubMed and OpenAlex will run it with their counts" width="100%"/>
</p>

Database search builds a query from concepts and their synonyms, with AND, OR, NOT and brackets as blocks or typed as text, shows how each database will run it and how many works each part finds, and keeps the results, de-duplicated, for the library, the Inbox or a review. The image uses the built-in sample data.

### Properties, formulas and AI fill

<table>
<tr>
<td width="50%"><img src="assets/readme/key-formula.png" alt="The formula builder: an if() made of blocks that labels works after 2020 Recent, its preview on the library's sources, and the function reference beside it"/></td>
<td width="50%"><img src="assets/readme/key-ai-fill.png" alt="Fill with AI: a study design proposed for four sources, each with its confidence, Accept, Edit and Reject, and the passage one answer came from"/></td>
</tr>
<tr>
<td valign="top"><strong>Formulas</strong><br/>Built from blocks or typed, with examples, a reference and a live preview on your own sources. Values are stored, so you can sort, filter and group by them.</td>
<td valign="top"><strong>Fill with AI</strong><br/>A property filled from each source's metadata, abstract or PDF, tested on a few sources first. Nothing is saved until you accept it, and a value you typed is never proposed over.</td>
</tr>
</table>

### Finding and collecting

<table>
<tr>
<td width="50%"><img src="assets/readme/key-browser.png" alt="The in-app browser on a journal article reached through a library proxy, with the proxy notice and Add to library in its bar"/></td>
<td width="50%"><img src="assets/readme/key-inbox.png" alt="The Inbox with new articles from a followed journal"/></td>
</tr>
<tr>
<td valign="top"><strong>The browser</strong><br/>Article pages are recognised; Add to library brings the PDF along, through your library's proxy if needed.</td>
<td valign="top"><strong>Inbox</strong><br/>New work from journals, feeds, authors and saved searches, checked against your library.</td>
</tr>
<tr>
<td width="50%"><img src="assets/readme/key-relation-map.png" alt="A topic page: what the library holds on the topic, and a relation map of its people, journals, tags and related topics"/></td>
<td width="50%"><img src="assets/readme/key-tags.png" alt="The tag manager suggesting a merge of tag variants, a hierarchy and a conversion to a property"/></td>
</tr>
<tr>
<td valign="top"><strong>Topics, people and journals</strong><br/>Pages built from OpenAlex metadata, with a relation map.</td>
<td valign="top"><strong>Tag manager</strong><br/>Merge variants, nest tags and turn status tags into a property, with undo.</td>
</tr>
<tr>
<td width="50%"><img src="assets/readme/key-duplicates.png" alt="Two records of the same paper side by side, with a choice per field before merging"/></td>
<td width="50%"><img src="assets/readme/key-batch-edit.png" alt="Four sources selected: an overview of their years, authors and journals beside the table, and tags and collections on some or all of them"/></td>
</tr>
<tr>
<td valign="top"><strong>Duplicates</strong><br/>Exact and likely duplicates, merged field by field. Links, notes and Zotero identities follow the kept record.</td>
<td valign="top"><strong>Batch editing</strong><br/>Select several sources for an overview of them, and change fields and tags for all at once; ⌘Z undoes it.</td>
</tr>
</table>

### Systematic reviews

<table>
<tr>
<td width="50%"><img src="assets/readme/key-review-screening.png" alt="Title and abstract screening: a record with highlighted keywords beside Include, Maybe and Exclude, a rule suggesting exclusion and the criteria"/></td>
<td width="50%"><img src="assets/readme/key-review-prisma.png" alt="A review's overview with the next step, progress and a PRISMA 2020 flow diagram from its real numbers"/></td>
</tr>
<tr>
<td valign="top"><strong>Screening</strong><br/>One record at a time with the keyboard (I, E, M, the failed criterion's number, ⌘Z), or a list with filters and batch decisions. Blind dual screening, conflicts, pilot rounds with Cohen's kappa.</td>
<td valign="top"><strong>PRISMA 2020</strong><br/>The flow diagram is drawn from the review's own data and exports as SVG, PNG or CSV.</td>
</tr>
<tr>
<td width="50%"><img src="assets/readme/key-review-setup.png" alt="The criteria editor, one criterion linked to the publication year"/></td>
<td width="50%"><img src="assets/readme/key-review-analysis.png" alt="A random-effects meta-analysis with its forest plot"/></td>
</tr>
<tr>
<td valign="top"><strong>Protocol</strong><br/>Question, rules and criteria, versioned with notes. A criterion is a rule a study must meet; excluding names the one it fails, which is the reason PRISMA reports. Suggestions follow the question's parts. Criteria can be linked to metadata (year, type, language, a custom property or a formula) to suggest, or apply visibly, a decision.</td>
<td valign="top"><strong>Extraction and meta-analysis</strong><br/>Forms with quotes from the reader, dual extraction, risk-of-bias templates; RR, OR, RD, MD and SMD pooled by fixed or random effects (DerSimonian–Laird, REML, Hartung–Knapp), checked against R's metafor.</td>
</tr>
</table>

A review is a tab (sidebar › Reviews, or "New systematic review…" in the command palette). Records come from RIS, BibTeX, EndNote XML, PubMed .nbib and CSV files, the library, Database search runs (with their strategy and counts) or by hand, de-duplicated on import. Every decision is an event in an append-only log, so a review exports as one file and merges back without conflicts; the format and a design for later sync are in `docs/review-sync.md`.

## Key and Zotero

Key reads from Zotero and never writes to it.

- **Import once.** Key reads your Zotero data folder directly and copies items, collections, notes, PDFs and their annotations into a workspace. Zotero does not need to be running and no plugin is needed. You can import everything, chosen collections or chosen papers.
- **Keep in sync.** The Key Sync plugin for Zotero (in [`integrations/zotero-key-sync`](integrations/zotero-key-sync/)) records changes in Zotero, and Key picks them up while it runs: new and edited items, trashed items, collection changes. Edits you make in Key are kept, and Key's own notes are never deleted. Key installs the plugin into Zotero for you from the same sheet.
- **Citing in Word or Google Docs** still goes through Zotero's own plugins. Key has no word-processor plugin of its own yet.

<p align="center">
  <img src="assets/readme/key-zotero.png" alt="The Zotero sheet: Import once or Keep in sync" width="80%"/>
</p>

## Install

There is no download yet. Key builds from source on macOS with Apple silicon.

Requirements: Xcode Command Line Tools, a current stable Rust toolchain, and Node.js 22.12 or newer.

```sh
git clone https://github.com/JonasWeinert/key-research.git
cd key-research/apps/key-office
npm install
npm run build:backend -w @key/electron   # the Rust host (PDFium, search, the library)
npm run build                            # the Key app
npm run start -w @key/electron
```

To build `Key.app` (unsigned, in `apps/key-office/apps/key/release/mac-arm64/`):

```sh
npm run dist:mac -w @key/electron
```

macOS asks before it opens an unsigned app the first time: open it from Finder with Control-click › Open, or allow it in System Settings › Privacy & Security. The [packaging notes](apps/key-office/apps/key/PACKAGING.md) explain what the app bundles.

Workspaces live in `~/Documents/Key` by default. Settings › Citations picks the citation style, and Settings › Services & API keys takes an OpenAlex contact email or key and an optional SerpApi key.

## Privacy

Your PDFs, web pages, notes, highlights and searches stay on your Mac. Key has no account and no telemetry. It sends something over the network only for these:

- **Metadata lookups.** Identifiers (DOI, PMID, OpenAlex id) and, for PDFs without one, a title go to OpenAlex, Crossref and Semantic Scholar to fill in metadata and resolve citations. Find PDF and Add by identifier ask Unpaywall, OpenAlex, Open Library, arXiv and PubMed. Automatic lookups can be turned off in Settings.
- **Web search,** when you choose to search the web: your query and filters go to OpenAlex and Semantic Scholar, and to SerpApi (Google Scholar) only if you added your own key.
- **Feeds and alerts** you follow are fetched from their sites and from OpenAlex.
- **The in-app browser** loads the pages you open, through your library's proxy when you have set one up.
- **Optional keyed services.** API keys you add are stored encrypted on your Mac and sent only to the service they belong to.
- **The optional AI assistant.** If you set it up with a provider (an OpenAI-compatible service, or Ollama or LM Studio on your Mac), what you ask it goes to that provider.

The layout model and the embedding model run on your Mac.

## What Key does not do yet

- **No word-processor plugins.** There is no Word, Google Docs or LibreOffice plugin; cite through Zotero for now.
- **No editing of Word, Excel or PowerPoint files.** They are listed and linked in a workspace, preview with Quick Look and open in their default app.
- **No sync between your devices, no shared libraries and no collaboration.** A workspace is a local folder.
- **No mobile app.**
- **macOS on Apple silicon only.** Windows and Linux builds are not tested, and there is no signed or notarized release.
- **No OCR.** Scanned PDFs without a text layer open, but their text cannot be searched or highlighted.
- **No EPUB** reading.
- **No translation.** It is not planned yet.
- **PDF forms and password-protected PDFs** are not supported.
- **AI features are not the focus.** Search and layout analysis use small on-device models; there is an optional assistant, but Key is not an AI chat or summary tool.

## How it works

| Layer | Responsibility | Technology |
|----|----|----|
| Desktop shell | Windows, tabs and splits, menus, settings, the in-app browser, one host process per workspace | Electron |
| Interface | Library, pages, notes, canvases, search, reader chrome | React, TypeScript |
| Page rendering | Visible pages as bounded tiles | PDF.js |
| Workspace host | Library commands, imports, indexing, citations, metadata, web search, feeds | Rust (`key-desktop-host`) |
| Library store | Sources, people, venues, topics, citations, notes, links; keyword and vector search | SQLite with FTS5 and sqlite-vec (`key-store`) |
| Document services | Canonical text and geometry, search, outlines, links | PDFium (`key-pdfium`, `key-pdf-runtime`) |
| Citations | CSL styles and locales | hayagriva and citationberg (`key-cite`) |
| Layout and embeddings | Reading order, headings, tables, references; passage vectors | ONNX layout model, EmbeddingGemma via llama.cpp |

```mermaid
flowchart LR
    UI["React interface"] -->|"framed IPC, user actions first"| Host["Rust workspace host"]
    Host --> Store["key-store (SQLite, FTS5, vectors)"]
    Host --> PDF["PDFium document service"]
    Host --> Index["Indexer: layout analysis and embeddings"]
    Host --> Net["OpenAlex, Crossref, web search, feeds (paced, cached)"]
    PDFJS["PDF.js tiles"] --> UI
    PDF --> UI
```

- **The logic lives in Rust.** The Electron renderer is the interface; the per-workspace Rust host owns the library, search, parsing, citations and network lookups.
- **Text identity.** PDFium's character order is the durable identity of a passage. Highlights store character ranges and canonical geometry, not screen pixels, so the same anchor resolves at any zoom and in any pane.
- **Background work never blocks you.** Indexing, analysis and lookups run in the background and are paced. Whatever you just did goes ahead of polls and refreshes.

## Development

From `apps/key-office/apps/key`:

| Task | Command |
|----|----|
| Type check | `npx tsc --noEmit -p .` |
| Unit tests | `npx vitest run` |
| Build the interface | `npm run build` |
| Build the Rust host | `node scripts/build-backend.mjs` |
| End-to-end checks | `node scripts/smoke-<name>.cjs` (after `npm run build`), e.g. `smoke-library`, `smoke-reader-ux`, `smoke-search`, `smoke-citations`, `smoke-zotero-sync` |
| README screenshots | `node scripts/record-screenshots.cjs` (after `npm run build`) |
| Benchmarks | `node scripts/bench-electron.cjs`, `node scripts/bench-host.cjs`, `node scripts/perf-budget.cjs` |
| Library store tests | `cargo test -p key-store` (from the repository root) |

The smokes drive the real app with Playwright on temporary profiles, against recorded OpenAlex answers and local mocks of the other services. The screenshots in this README come from the same kind of run: an invented demo library, no network. The [app README](apps/key-office/apps/key/README.md) covers processes, memory and the benchmarks.

Interface colours come only from theme tokens; see [`apps/key-office/CLAUDE.md`](apps/key-office/CLAUDE.md) for the rules, which CI checks.

## Repository map

| Path | Purpose |
|----|----|
| [`apps/key-office/apps/key`](apps/key-office/apps/key/) | The Key app: Electron main process, React interface, smokes |
| [`apps/key-office`](apps/key-office/) | The npm workspace it builds in |
| [`apps/key`](apps/key/) | The PDF reader package (PDF.js workspace) and the earlier Tauri shell |
| [`crates/key-desktop-host`](crates/key-desktop-host/) | The per-workspace host process |
| [`crates/key-store`](crates/key-store/) | The library database: sources, metadata graph, notes, links, search |
| [`crates/key-cite`](crates/key-cite/) | Citation formatting with CSL styles and locales |
| [`crates`](crates/) | PDFium services, indexing, embeddings, Zotero import and the shared runtime |
| [`integrations/zotero-key-sync`](integrations/zotero-key-sync/) | The Key Sync plugin for Zotero |
| [`extensions/key-reference`](extensions/key-reference/) | Scholarly metadata providers and scheduling |
| [`experiments/gpui-pdf-reader`](experiments/gpui-pdf-reader/) | A frozen native GPUI reader, kept as a reference |
| [`tests`](tests/) | Shared fixtures (PDFs, recorded OpenAlex responses) |

### Further reading

| Document | Covers |
|----|----|
| [Reader package](apps/key/README.md) | The PDF.js workspace, benchmarks and renderer entry points |
| [Engine boundary](apps/key/docs/engine-contract.md) | Commands and data between the interface and the PDF services |
| [Text and coordinates](notes/text-layer.md) | Canonical character order, bounds, hit testing |
| [Links and scientific references](notes/links-and-scientific-references.md) | Citation detection, lookup and previews |
| [Testing](notes/testing.md) | Fixtures, deterministic checks and end-to-end coverage |

## Feedback

Reports are most useful with a reproducible PDF, what you expected and what happened. [Open an issue](https://github.com/JonasWeinert/key-research/issues).

## License

Key's own code is released under the [MIT License](LICENSE). Third-party components keep their own licences, among them the CC BY-SA 3.0 citation styles, PDFium, fonts and models. [LICENSES.md](LICENSES.md) lists each one, and the app shows them under Settings › About Key › Acknowledgements.
