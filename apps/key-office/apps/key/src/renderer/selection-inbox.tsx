// The selection panel for Inbox works (SelectionPanel mode="inbox"): works the feeds and
// alerts brought, or the user saved, that are not library sources yet. Their overview
// (`inbox_selection_overview` in Rust: types, years, authors, journals, which feeds found
// them, how many the library has or possibly has, open access, PDF links, retractions) and
// what the Inbox does with many at once: add them to the library (asking where, in batches,
// skipping what the library has; Undo moves the new sources to the Trash), save them for
// later, mark them read or unread, copy their references or BibTeX, open their pages, dismiss
// them, plus what other features register for Inbox works (selection-actions.ts).
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { bridge } from "./library-api";
import { chooseCollections } from "./add-from-source";
import { cancelFindPdfs, findPdfs, useFindPdfRun } from "./find-pdf";
import { feedsChanged, type FeedItem } from "./feeds-ui";
import { libraryChanged } from "./library-nav";
import { renderCitations, writeRichClipboard } from "./cite";
import { workspaceSettings } from "./workspace-settings-api";
import { selectionActionsFor, useSelectionActions, type SelectionContext, type SelectionGroup } from "./selection-actions";
import { ActionButton, SelectionCharts, SelectionFacts, SelectionFrame, errorText, plural, useNotice, useOverview, type Count, type Fact, type OverviewYears } from "./selection-frame";
import { ITEM_TYPES } from "./library-api";

export interface InboxOverview {
  total: number;
  itemTypes: Count[];
  years: OverviewYears;
  authors: Count[];
  authorCount: number;
  journals: Count[];
  journalCount: number;
  feeds: { id: string; title: string; kind: string; count: number }[];
  savedByYou: number;
  inLibrary: number;
  possiblyInLibrary: number;
  openAccess: number;
  withPdfLink: number;
  retracted: number;
  missingDoi: number;
  missingAbstract: number;
  unread: number;
  saved: number;
  inLibraryIds: string[];
  possibleIds: string[];
}
type Added = { itemId: string; sourceId: string };
type AddAnswer = { added: Added[]; skipped: { itemId: string; sourceId?: string | null; reason: "added" | "library" | "gone" }[] };
export type Triage = { read?: boolean; saved?: boolean; dismissed?: boolean };

export interface InboxSelectionProps {
  mode: "inbox";
  invoke: Invoke;
  workspaceId: string;
  /** Every selected item's id. */
  ids: string[];
  /** The selected items the list has loaded. */
  loaded: FeedItem[];
  /** Changes read, saved or dismissed, keeping the Inbox's list in step. */
  onTriage: (ids: string[], change: Triage) => Promise<unknown>;
  /** Dismisses them (the Inbox hides them and offers Undo). */
  onDismiss: (items: FeedItem[]) => void;
  /** Items became sources (or stopped being, after Undo: `sourceId` null). */
  onAdded: (changes: { itemId: string; sourceId: string | null }[]) => void;
  onOpen: (items: FeedItem[]) => void;
  onClear: () => void;
  /** Filled with the panel's Add to library, for the list's context menu. */
  actions?: MutableRefObject<{ add?: () => void } | undefined>;
}

/** One add call's size: the first is a click's, the rest run as background and give way. */
const BATCH = 25;
const TYPE_LABEL = new Map(ITEM_TYPES);

export function InboxSelection({ invoke, workspaceId, ids, loaded, onTriage, onDismiss, onAdded, onOpen, onClear, actions }: InboxSelectionProps) {
  const [version, setVersion] = useState(0);
  const { overview, stale } = useOverview<InboxOverview>(invoke, workspaceId, "inbox_selection_overview", ids, version);
  const { notice, setNotice, say, attempt } = useNotice();
  const [findAfter, setFindAfter] = useState(false);
  const pdfRun = useFindPdfRun();
  const stopped = useRef(false);
  const findingHere = useRef(false);
  const addButton = useRef<HTMLDivElement>(null);
  useSelectionActions();
  useEffect(() => {
    void workspaceSettings(invoke, workspaceId)
      .then((r) => setFindAfter(!!r.effective?.findPdfOnAdd))
      .catch(() => {});
  }, [invoke, workspaceId]);
  useEffect(() => {
    if (findingHere.current && pdfRun?.running) setNotice({ text: `Finding PDFs ${pdfRun.done} of ${pdfRun.total} · ${pdfRun.found} found`, tone: "busy", stop: cancelFindPdfs });
  }, [pdfRun]);

  const n = ids.length;
  const total = overview?.total ?? n;
  const reload = () => setVersion((v) => v + 1);
  const inLibrary = useMemo(() => new Set(overview?.inLibraryIds ?? []), [overview]);
  // Sources some of them already are: what library actions (Find PDFs, a review) act on.
  const sources = loaded.filter((i) => i.inLibrary && i.sourceId).map((i) => ({ id: i.sourceId!, title: i.work.title }));
  const toAdd = overview ? ids.filter((id) => !inLibrary.has(id)) : [];
  const allSaved = !!overview && overview.saved === total;
  const allRead = !!overview && overview.unread === 0;
  const ctx: SelectionContext = { workspaceId, kind: "inbox", sourceIds: sources.map((s) => s.id), itemIds: ids };
  const actionButtons = (group: SelectionGroup) =>
    selectionActionsFor(ctx, group).map((a) => (
      <ActionButton key={a.id} icon={a.icon ?? "sparkle"} label={a.label} title={a.title} onClick={() => void attempt(`${a.label.replace(/…$/, "")}…`, async () => void (await a.run(ctx)))} />
    ));

  /** Read / saved for all, with Undo putting back what each one was. */
  const triage = async (change: { read?: boolean; saved?: boolean }, done: string) => {
    const key = "read" in change ? "read" : "saved";
    const to = change[key]!;
    const changed = loaded.filter((i) => i[key] !== to).map((i) => i.id);
    const targets = loaded.length < n ? ids : changed;
    setNotice({ text: "Saving…", tone: "busy" });
    try {
      await onTriage(targets, change);
      reload();
      say(done, "done", () =>
        void onTriage(changed, { [key]: !to })
          .then(() => {
            reload();
            say("Undone");
          })
          .catch((e) => say(errorText(e), "error")),
      );
    } catch (e) {
      say(errorText(e), "error");
    }
  };

  const addAll = async () => {
    if (!toAdd.length) return say(n === 1 ? "It is in your library already" : "All of these are in your library already");
    const anchor = addButton.current?.querySelector("button");
    const where = await chooseCollections(invoke, { workspaceId }, { title: plural(toAdd.length, "work"), byline: "From the Inbox" }, anchor).catch((e) => {
      say(errorText(e), "error");
      return null;
    });
    if (!where) return;
    stopped.current = false;
    const added: Added[] = [];
    let skipped = n - toAdd.length;
    let done = 0;
    const progress = () => setNotice({ text: `Adding ${done.toLocaleString()} of ${plural(toAdd.length, "work")}…`, tone: "busy", stop: () => void (stopped.current = true) });
    progress();
    try {
      for (let at = 0; at < toAdd.length && !stopped.current; at += BATCH) {
        const chunk = toAdd.slice(at, at + BATCH);
        // The first batch answers the click; the rest yield to whatever the user does next.
        const answer = await addBatch(invoke, workspaceId, chunk, where.collections, at > 0);
        done += chunk.length;
        added.push(...answer.added);
        skipped += answer.skipped.filter((s) => s.reason !== "gone").length;
        onAdded([...answer.added, ...answer.skipped.filter((s) => s.sourceId).map((s) => ({ itemId: s.itemId, sourceId: s.sourceId! }))]);
        progress();
      }
    } catch (e) {
      if (!added.length) return say(errorText(e), "error");
    } finally {
      if (added.length) {
        libraryChanged();
        feedsChanged();
      }
      reload();
    }
    const into = where.names.length ? ` to ${where.names.length === 1 ? where.names[0] : plural(where.names.length, "collection")}` : " to the library";
    const text = `Added ${plural(added.length, "work")}${into}${skipped ? ` · ${skipped.toLocaleString()} already in the library, skipped` : ""}${stopped.current ? " · stopped" : ""}`;
    const undo = added.length
      ? () =>
          void invoke<number>("inbox_add_undo", { added }, workspaceId)
            .then((trashed) => {
              onAdded(added.map((a) => ({ itemId: a.itemId, sourceId: null })));
              libraryChanged();
              feedsChanged();
              reload();
              say(`Took the add back: ${plural(trashed, "source")} moved to the Trash`);
            })
            .catch((e) => say(errorText(e), "error"))
      : undefined;
    say(text, "done", undo);
    if (findAfter && added.length) {
      findingHere.current = true;
      try {
        const byItem = new Map(loaded.map((i) => [i.id, i.work.title]));
        const result = await findPdfs(invoke, workspaceId, added.map((a) => ({ id: a.sourceId, title: byItem.get(a.itemId) ?? "", filePath: undefined })));
        if (result) say(`${text} · found ${plural(result.found, "PDF")}`, "done", undo);
      } catch (e) {
        say(errorText(e), "error");
      } finally {
        findingHere.current = false;
      }
    }
  };

  const findPdfsHere = async () => {
    findingHere.current = true;
    try {
      const result = await findPdfs(invoke, workspaceId, sources.map((s) => ({ ...s, filePath: undefined })));
      if (result) say(`Found ${plural(result.found, "PDF")} for ${plural(result.total, "work")}`);
      else setNotice(undefined);
    } catch (e) {
      say(errorText(e), "error");
    } finally {
      findingHere.current = false;
    }
  };

  const copyReferences = () => void attempt("Copying references…", () => copyWorkReferences(invoke, workspaceId, ids));
  const copyBibtex = () => void attempt("Copying BibTeX…", () => copyWorkBibtex(invoke, workspaceId, ids));
  if (actions) actions.current = { add: () => void addAll() };
  const withPage = loaded.filter((i) => i.work.landingUrl || i.work.doi);

  const types = overview?.itemTypes ?? [];
  const facts: Fact[] = overview
    ? [
        ["In library", overview.inLibrary, "books", overview.inLibrary ? undefined : "muted"],
        ["Possibly in library", overview.possiblyInLibrary, "layers", overview.possiblyInLibrary ? undefined : "muted"],
        ["Open access", overview.openAccess, "unlock", overview.openAccess ? undefined : "muted"],
        ["With a PDF link", overview.withPdfLink, "filePdf", overview.withPdfLink ? undefined : "muted"],
        ["Unread", overview.unread, "book", overview.unread ? undefined : "muted"],
        ["Retracted", overview.retracted, "warning", overview.retracted ? "warn" : "muted"],
        ["Missing DOI", overview.missingDoi, "link", overview.missingDoi ? undefined : "muted"],
        ["Missing abstract", overview.missingAbstract, "text", overview.missingAbstract ? undefined : "muted"],
      ]
    : [];
  const found = overview ? [...overview.feeds.map((f) => ({ label: f.title, value: f.count })), ...(overview.savedByYou ? [{ label: "Saved by you", value: overview.savedByYou }] : [])] : [];

  return (
    <SelectionFrame
      count={n}
      noun="work"
      label={`${n} works selected`}
      summary={
        types.length
          ? types
              .slice(0, 3)
              .map((t) => plural(t.count, (TYPE_LABEL.get(t.value) ?? t.value).toLowerCase()))
              .join(", ") + (types.length > 3 ? `, ${types.length - 3} more types` : "")
          : ""
      }
      controls={
        overview && (
          <>
            <button
              className="kx-icon-button"
              data-active={allRead}
              aria-pressed={allRead}
              title={allRead ? "Mark all unread" : "Mark all read"}
              aria-label={allRead ? "Mark all unread" : "Mark all read"}
              onClick={() => void triage({ read: !allRead }, allRead ? `Marked ${plural(n, "work")} unread` : `Marked ${plural(n, "work")} read`)}
            >
              <Icon name="readHalf" size={14} />
            </button>
            <button
              className="kx-icon-button"
              data-active={allSaved}
              aria-pressed={allSaved}
              title={allSaved ? "Unsave all" : "Save all for later"}
              aria-label={allSaved ? "Unsave all" : "Save all for later"}
              onClick={() => void triage({ saved: !allSaved }, allSaved ? `No longer saving ${plural(n, "work")}` : `Saved ${plural(n, "work")} for later`)}
            >
              <Icon name="bookmark" size={14} filled={allSaved} />
            </button>
          </>
        )
      }
      notice={notice}
      onNotice={setNotice}
      onClear={onClear}
      stale={stale}
      overview={
        overview && (
          <>
            <SelectionFacts facts={facts} />
            <SelectionCharts
              years={overview.years}
              types={types.map((t) => ({ label: TYPE_LABEL.get(t.value) ?? t.value, value: t.count }))}
              authors={overview.authors}
              authorCount={overview.authorCount}
              journals={overview.journals}
              journalCount={overview.journalCount}
              total={total}
              noun="works"
            >
              {found.length > 0 && (
                <div className="kx-selection-chart">
                  <h3>
                    Found by<span>{plural(overview.feeds.length, "feed or alert", "feeds and alerts")}</span>
                  </h3>
                  <FoundBy items={found} total={total} />
                </div>
              )}
            </SelectionCharts>
          </>
        )
      }
      footer={
        <>
          <ActionButton icon="close" label="Dismiss" danger title="Take them out of the Inbox (Undo brings them back)" onClick={() => onDismiss(loaded)} />
          <span className="kx-selection-hint">Undo shows here after each action</span>
        </>
      }
    >
      <section className="kx-selection-section kx-selection-actions" aria-label="Add to library">
        <h3>
          Add to library
          {overview && overview.inLibrary > 0 && <span>{overview.inLibrary.toLocaleString()} in your library already</span>}
        </h3>
        <div className="kx-selection-buttons" ref={addButton}>
          <ActionButton
            icon="plus"
            primary
            label={overview ? (toAdd.length ? `Add ${toAdd.length.toLocaleString()} to library…` : "All in your library") : "Add to library…"}
            title={toAdd.length < n ? `Those your library has already are skipped` : "Asks which collections, as every add does"}
            disabled={!overview || !toAdd.length || notice?.tone === "busy"}
            onClick={() => void addAll()}
          />
          <ActionButton
            icon="filePdf"
            label={sources.length ? `Find PDFs (${sources.length.toLocaleString()})` : "Find PDFs"}
            title={sources.length ? "Look for open-access PDFs for those in your library" : "Add them to the library first"}
            disabled={!sources.length || !!pdfRun?.running}
            onClick={() => void findPdfsHere()}
          />
        </div>
        <label className="kx-selection-check">
          <input type="checkbox" checked={findAfter} onChange={(e) => setFindAfter(e.target.checked)} />
          Find PDFs after adding
        </label>
        {overview && overview.possiblyInLibrary > 0 && (
          <p className="kx-selection-note">
            {plural(overview.possiblyInLibrary, "work")} {overview.possiblyInLibrary === 1 ? "looks" : "look"} like something in your library by title, year and author; {overview.possiblyInLibrary === 1 ? "it is" : "they are"} added too.
          </p>
        )}
        {selectionActionsFor(ctx, "metadata").length > 0 && <div className="kx-selection-buttons">{actionButtons("metadata")}</div>}
        <h3>Cite and export</h3>
        <div className="kx-selection-buttons">
          <ActionButton icon="quote" label="Copy references" onClick={copyReferences} />
          <ActionButton icon="copy" label="Copy BibTeX" onClick={copyBibtex} />
          {actionButtons("cite")}
        </div>
        <h3>Organise</h3>
        <div className="kx-selection-buttons">
          <ActionButton
            icon="globe"
            label="Open all in the browser"
            title={withPage.length ? `Opens the ${plural(withPage.length, "page")} in tabs` : "None of these has a page to open"}
            disabled={!withPage.length}
            onClick={() => {
              if (withPage.length > 12 && !window.confirm(`Open ${withPage.length} tabs?`)) return;
              onOpen(withPage);
            }}
          />
          {actionButtons("organise")}
          {actionButtons("open")}
          {actionButtons("ai")}
          {actionButtons("other")}
        </div>
      </section>
    </SelectionFrame>
  );
}

/** Which feeds and alerts found them, as bars (each work may come from several). */
function FoundBy({ items, total }: { items: { label: string; value: number }[]; total: number }) {
  return (
    <ul className="kx-selection-found">
      {items.slice(0, 6).map((f) => (
        <li key={f.label}>
          <Icon name="feed" size={11} />
          <span title={f.label}>{f.label}</span>
          <i style={{ width: `${Math.max(4, Math.round((f.value / Math.max(1, total)) * 100))}%` }} aria-hidden="true" />
          <small>{f.value.toLocaleString()}</small>
        </li>
      ))}
      {items.length > 6 && <li className="kx-selection-more">{items.length - 6} more</li>}
    </ul>
  );
}

/** Copies the works' references in the citation style (as rich text); answers what it did. */
export async function copyWorkReferences(invoke: Invoke, workspaceId: string, ids: string[]) {
  const works = await invoke<unknown[]>("inbox_works", { ids }, workspaceId);
  const out = await renderCitations(invoke, workspaceId, { sources: works, ids, bibliography: true });
  const entries = out.bibliography?.entries ?? [];
  if (!entries.length) throw new Error("There is nothing to cite in these works");
  await writeRichClipboard({ text: entries.map((e) => e.text).join("\n\n"), html: entries.map((e) => `<div class="csl-entry">${e.html}</div>`).join("") });
  return entries.length === 1 ? "Copied the reference" : `Copied ${plural(entries.length, "reference")}`;
}

/** Copies the works as BibTeX, keyed by the library's citation key pattern. */
export async function copyWorkBibtex(invoke: Invoke, workspaceId: string, ids: string[]) {
  const works = await invoke<unknown[]>("inbox_works", { ids }, workspaceId);
  await writeRichClipboard({ text: await invoke<string>("store_biblio_copy", { sources: works, format: "bibtex" }, workspaceId) });
  return `Copied BibTeX for ${plural(works.length, "work")}`;
}

/** One batch of an add; a background batch waits and asks again when the host's queue is full. */
async function addBatch(invoke: Invoke, workspaceId: string, ids: string[], collections: string[], background: boolean): Promise<AddAnswer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke<AddAnswer>("inbox_add", { ids, collections, ...(background ? { $priority: "background" } : {}) }, workspaceId);
    } catch (e) {
      if (!background || attempt > 20 || !/queued/i.test(String(e))) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Opens works' pages (their landing page, else their DOI) in the in-app browser. */
export function openWorkPages(items: FeedItem[], viewId?: string) {
  for (const item of items) {
    const url = item.work.landingUrl || (item.work.doi ? `https://doi.org/${item.work.doi}` : "");
    if (url) void bridge().tabAction("open-url", { url, placement: "tab", fromViewId: viewId });
  }
}
