# Key · Electron workspace

Key combines the retained Rust PDF/search backend and reader with the Apache-licensed Gen Office editors. The app lives physically in `apps/key-office/apps/key`; `apps/key-electron` is a convenience symlink so it shares the Office npm workspace dependencies.

## Run

Use Node 22.12 or newer. From `apps/key-office`:

```sh
npm install
npm run build:backend -w @key/electron
npm run build:all
npm run start -w @key/electron
```

For shell development, build the Office modules first, then `npm run dev`. For the unsigned macOS application, run `npm run dist:mac -w @key/electron`. See `PACKAGING.md` for resource and release details.

## Implemented

- Home tabs, Gen Office-style chrome, workspace/project navigation, split/separate/swap and a resizable split divider. An already-open document is focused in its existing owner.
- A full-width table/list source library based on the supplied mock's layout. Bounded source pages, metadata editing, properties/labels, processing controls, trash, and search filters.
- Keyword/semantic passage search uses the retained Rust implementation. Opening a hit retrieves its canonical geometry, navigates to the page and highlights the passage. Back to results preserves the mounted library state.
- Each workspace owns `<workspace>/.key/library.sqlite3`, its managed source files and rebuildable search artifacts. Default workspace: `~/Documents/Key/Personal`. Additional workspace roots are user-selected folders.
- Projects are subfolders with many-to-many item membership in their workspace's database. Linked folders retain their originals; bounded explicit scans import/index PDFs and index other files' metadata. Source records are created automatically when a PDF enters a workspace.
- Notes/pages with revision-checked saves and JSON properties. Saved database views filter canonical records by kind, text and property values. The records view searches notes and linked-file metadata.
- Docs, Sheets, Slides, Markdown and HTML editors. Saved Office files register in the selected workspace's canonical database using stable canonical paths; unsaved-close guards are retained.
- Original Gen Office PDF editor/conversion/Node parsing are excluded. Office PDF export remains. AI attachment PDF extraction delegates to Rust PDFium.

## Processes and memory

Electron owns the shell, Chromium renderers and GPU process. Native editor views have one global owner. At most two PDF renderers remain resident; evicted tabs retain view state, wait for outstanding requests to settle, release native reader resources, and recreate on demand. Dirty Office editors remain alive until their close guard succeeds.

Each used workspace has a supervised Rust host, which retains the interactive PDF process, separate background extraction and embedding services. The framed binary bridge bounds concurrency and queued bytes. Inactive hosts retire only when the backend reports no readers, imports or background work. Content-derived PDF caches retain the existing content-hash identity. Linked-file hashes are streamed.

All-workspace results retain workspace identity and per-workspace rank; local scores are not compared as if they shared one index. Source pagination is bounded in SQL and in the renderer. Filters on project membership enter SQL eligibility before passage top-k retrieval.

## Deliberate limits / roadmap

The supplied design's AI metadata-fill workflows, DOI/BibTeX/RIS acquisition, richer media sources and advanced column controls remain labelled previews. Database formulas, rollups, typed schema editors, relation editors and automatic filesystem watchers are future work. Basic saved filtered views and arbitrary JSON properties are implemented.

Linked-folder scans are explicit and bounded; they report truncation rather than silently claiming a complete scan. Open/attention filters and sorting currently apply to the loaded source page. Workspace records and property-filtered database views are paginated; this is not an arbitrary database-query language.

Existing Tauri libraries are preserved in place; they are not silently moved into the new workspace registry. PDF sources can be imported into a chosen workspace. Office saves may point to a user-selected external file; workspace membership is canonical even when the original lives elsewhere.

This is an unsigned development application, not a qualified cross-platform release. Stress tests measure responsiveness and memory on this Mac; they do not guarantee uninterrupted frame rates. Upstream attribution is preserved in `../../UPSTREAM.md`, LICENSE/NOTICE and packaged third-party notices.

## Performance

Key should feel instant on low-end machines. After `npm run build -w @key/electron` (with `KEY_HOST_EXECUTABLE` and `KEY_OFFICE_APPS_ROOT` set as for the smokes):

- `node scripts/bench-electron.cjs [--quick] [--label name] [--out file.json]` — startup (fresh and warm profile, main-process steps from `src/main/startup-marks.ts`), RSS and macOS footprint per process (main, GPU, shell, each PDF/web view, the Rust host and its workers) at idle Home, a 5,000-source library, one PDF, three PDFs + a note + a web page, after closing them and after 10 minutes idle; idle CPU and wakeups; latencies (open library, type-to-search, palette, Settings, tag manager on 5,000 tags, open PDF, tab switch); scroll frame times and long tasks; bundle sizes. Renderer measurements repeat with Chromium CPU throttling at 4× and 6× to stand in for a slow machine. `KEY_ELECTRON_EXECUTABLE` benchmarks a packaged Key.app; `KEY_BENCH_APP` another build folder.
- `node scripts/bench-host.cjs <host> [<host> …]` — the Rust host alone: startup, library commands on 5,000 sources, indexing three PDFs with peak memory per worker. Compares debug and release builds.
- `node scripts/perf-budget.cjs` — a quick smoke with generous budgets (startup, idle CPU and memory, opening a 2,000-source library, main and renderer bundle sizes). `KEY_PERF_SLACK=2` loosens the time budgets on slow machines.

Startup stays light by loading on first use what most sessions never open: the Office editors' main-process code (`office-editors.ts` → `office-impl.ts`), the note editor (`note-editor/LazyNoteEditor.tsx`), Settings, onboarding, the tag manager, canvas and other rare pages (`lazy.tsx`). Library and model status come from one shared poller per workspace that pauses while the window is hidden (`status-poll.ts`). Live blur is dropped under "Reduce transparency" and on machines with four cores or 4 GB or less (`reduced-effects.ts`).

## Verification

`npm run typecheck -w @key/electron` and `npm test -w @key/electron` validate the shell. Scripts in `scripts/` exercise real Electron windows and real Rust IPC, using isolated temporary workspace/profile directories: library/record persistence, PDF ownership and rendering, canonical search highlights, Office view loading, unsaved-close/save, saved database filters, and repeated PDF interaction. Backend storage tests cover workspace membership, file registration and migration invariants.

Measured stress evidence is in `apps/key/docs/electron-stress-validation-2026-09-12.json`; storage and design decisions are in the adjacent Electron workspace/design documents.
