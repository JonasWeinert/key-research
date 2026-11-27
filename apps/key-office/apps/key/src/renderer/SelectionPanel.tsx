// The library's details panel when several sources are selected: "N sources selected", an
// overview of them (types, years, authors, journals, what they share and what they lack,
// duplicates among them; `store_selection_overview` in Rust) and every bulk control in one
// place: tags and collections (on all / on some), reading status and star, any field or
// property for all ("Mixed" where they differ), find PDFs, metadata, look-ups, citations,
// export, open, Inbox, Trash and merge, plus what other features register
// (selection-actions.ts). Every edit is one journaled host command, so ⌘Z takes it back;
// progress and results show in the panel.
//
// `mode="inbox"` is the same panel for works in the Inbox that are not in the library yet
// (selection-inbox.tsx): their overview and the Inbox's bulk actions, in the same frame
// (selection-frame.tsx).
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { ITEM_TYPES, type Collection, type Facet, type Invoke, type Source } from "./library-api";
import type { PropertyDefinition } from "./PropertySheets";
import { stepJournal, type BatchEdit, type Operation } from "./library-hygiene";
import { ReadingStatusControl, type ReadingStatus } from "./reading-ui";
import { libraryChanged, onLibraryChanged } from "./library-nav";
import { findPdfs, useFindPdfRun, cancelFindPdfs } from "./find-pdf";
import { copyCitation, copyInTextCitation } from "./item-actions";
import { openBibExport } from "./BiblioSheets";
import { selectionActionsFor, useSelectionActions, type SelectionGroup } from "./selection-actions";
import { ActionButton, SelectionCharts, SelectionFacts, SelectionFrame, errorText, plural, useNotice, useOverview, type Count, type Fact, type OverviewYears } from "./selection-frame";
import { InboxSelection, type InboxSelectionProps } from "./selection-inbox";

interface Shared {
  mixed: boolean;
  value: unknown;
  filled: number;
}
export interface SelectionOverview {
  total: number;
  trashed: number;
  kinds: Count[];
  itemTypes: Count[];
  years: OverviewYears;
  authors: Count[];
  authorCount: number;
  journals: Count[];
  journalCount: number;
  tags: Count[];
  collections: { id: string; name: string; count: number }[];
  withFile: number;
  withPdf: number;
  unread: number;
  reading: number;
  read: number;
  starred: number;
  retracted: number;
  missingDoi: number;
  missingAbstract: number;
  fields: Record<string, Shared>;
  duplicates: string[][];
}

const FIELDS: [string, string, "number"?][] = [
  ["containerTitle", "Published in"],
  ["publisher", "Publisher"],
  ["year", "Year", "number"],
  ["date", "Date"],
  ["volume", "Volume"],
  ["issue", "Issue"],
  ["edition", "Edition"],
  ["series", "Series"],
  ["place", "Place"],
  ["institution", "Institution"],
  ["language", "Language"],
  ["rights", "Rights"],
  ["extra", "Extra"],
];
export const TYPE_LABEL = new Map(ITEM_TYPES);
const asText = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** The overview of `ids`, read again when the selection or the library changes. */
export function useSelectionOverview(invoke: Invoke, workspaceId: string, ids: string[]) {
  const [version, setVersion] = useState(0);
  useEffect(() => onLibraryChanged(() => setVersion((v) => v + 1)), []);
  return { ...useOverview<SelectionOverview>(invoke, workspaceId, "store_selection_overview", ids, version), reload: () => setVersion((v) => v + 1) };
}

type LibraryProps = Parameters<typeof LibrarySelection>[0] & { mode?: "library" };

/** Library sources (default), or Inbox works with `mode="inbox"`. */
export default function SelectionPanel(props: LibraryProps | InboxSelectionProps) {
  return props.mode === "inbox" ? <InboxSelection {...props} /> : <LibrarySelection {...props} />;
}

function LibrarySelection({
  invoke,
  workspaceId,
  ids,
  loaded,
  collections,
  tagSuggestions,
  definitions,
  trashed,
  onEdited,
  onClear,
  onMetadata,
  onMerge,
  onTrash,
  onDelete,
  onOpen,
  onFill,
  onRetractionsChecked,
  onNewProperty,
}: {
  invoke: Invoke;
  workspaceId: string;
  /** Every selected source's id. */
  ids: string[];
  /** The selected sources the list has loaded (a large selection may not all be). */
  loaded: Source[];
  collections: Collection[];
  tagSuggestions: Facet[];
  definitions: PropertyDefinition[];
  /** The selection is in the Trash: restore and delete instead of edits. */
  trashed: boolean;
  onEdited: () => void;
  onClear: () => void;
  onMetadata: (ids: string[]) => void;
  onMerge: (ids: string[]) => void;
  onTrash: (ids: string[], trashed: boolean) => void;
  onDelete: (ids: string[]) => void;
  onOpen: (sources: Source[]) => void;
  /** The AI fill sheet, for when no feature registers its own action. */
  onFill: (targets: Source[]) => void;
  onRetractionsChecked: () => void;
  /** The property sheet, creating a property with a value for all of them. */
  onNewProperty: () => void;
}) {
  const { overview, stale } = useSelectionOverview(invoke, workspaceId, ids);
  const { notice, setNotice, say, attempt } = useNotice();
  const [newTag, setNewTag] = useState("");
  const pdfRun = useFindPdfRun();
  useSelectionActions();
  const n = ids.length;
  const total = overview?.total ?? n;
  const ctx = { workspaceId, kind: "library" as const, sourceIds: ids };

  const edit = async (batch: BatchEdit, label?: string) => {
    setNotice({ text: "Saving…", tone: "busy" });
    try {
      const op = await invoke<Operation>("store_edit", { ids, edit: batch, ...(label ? { label } : {}) }, workspaceId);
      say(op.entry ? op.entry.label : "Nothing changed", "done", op.entry ? undo : undefined);
      libraryChanged();
      onEdited();
    } catch (e) {
      say(errorText(e), "error");
    }
  };
  function undo() {
    void stepJournal(invoke, workspaceId, true)
      .then((text) => {
        say(text ?? "Undone");
        libraryChanged();
        onEdited();
      })
      .catch((e) => say(errorText(e), "error"));
  }

  // Find PDFs reports its progress here while it runs for this panel.
  const findingHere = useRef(false);
  useEffect(() => {
    if (findingHere.current && pdfRun?.running) setNotice({ text: `Finding PDFs ${pdfRun.done} of ${pdfRun.total} · ${pdfRun.found} found`, tone: "busy", stop: cancelFindPdfs });
  }, [pdfRun]);
  const findPdfsHere = async () => {
    findingHere.current = true;
    try {
      const result = await findPdfs(invoke, workspaceId, loaded);
      if (result) say(`Found ${plural(result.found, "PDF")} for ${plural(result.total, "source")}`);
      else setNotice(undefined);
    } catch (e) {
      say(errorText(e), "error");
    } finally {
      findingHere.current = false;
    }
  };

  const names = useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections]);
  const field = (name: string): Shared => overview?.fields[name] ?? { mixed: false, value: null, filled: 0 };
  const allStarred = !!overview && overview.starred === total;
  const status: ReadingStatus | undefined = overview ? (overview.unread === total ? "unread" : overview.reading === total ? "reading" : overview.read === total ? "read" : undefined) : undefined;
  const editable = definitions.filter((d) => d.type === "text" || d.type === "number" || d.type === "select" || d.type === "boolean");
  const withoutFile = overview ? total - overview.withFile : loaded.filter((s) => !s.filePath).length;
  const registered = (group: SelectionGroup) => selectionActionsFor(ctx, group);
  const actionButtons = (group: SelectionGroup) =>
    registered(group).map((a) => (
      <ActionButton key={a.id} icon={a.icon ?? "sparkle"} label={a.label} title={a.title} onClick={() => void attempt(`${a.label.replace(/…$/, "")}…`, async () => void (await a.run(ctx)))} />
    ));

  const sendToInbox = () =>
    void attempt("Sending to Inbox…", async () => {
      const inbox =
        collections.find((c) => !c.parentId && c.name === "Inbox")?.id ??
        (await invoke<{ id: string }>("store_collection_create", { name: "Inbox", parentId: null }, workspaceId)).id;
      const op = await invoke<Operation>("store_edit", { ids, edit: { collectionsAdd: [inbox] }, label: `Send ${plural(n, "source")} to Inbox` }, workspaceId);
      libraryChanged();
      onEdited();
      setNotice({ text: op.entry?.label ?? "Already in the Inbox", tone: "done", undo: op.entry ? undo : undefined });
    });

  const types = overview?.itemTypes ?? [];
  const tagsAll = overview?.tags.filter((t) => t.count === total) ?? [];
  const tagsSome = overview?.tags.filter((t) => t.count < total) ?? [];
  const filed = overview?.collections ?? [];
  const facts: Fact[] = overview
    ? [
        ["With a PDF", overview.withPdf, "filePdf"],
        ["Unread", overview.unread, "book"],
        ["Starred", overview.starred, "star"],
        ["Retracted", overview.retracted, "warning", overview.retracted ? "warn" : "muted"],
        ["Missing DOI", overview.missingDoi, "link", overview.missingDoi ? undefined : "muted"],
        ["Missing abstract", overview.missingAbstract, "text", overview.missingAbstract ? undefined : "muted"],
      ]
    : [];
  const duplicates = overview?.duplicates ?? [];

  return (
    <SelectionFrame
      count={n}
      noun="source"
      label={`${n} sources selected`}
      summary={
        types.length
          ? types
              .slice(0, 3)
              .map((t) => plural(t.count, (TYPE_LABEL.get(t.value) ?? t.value ?? "Document").toLowerCase()))
              .join(", ") + (types.length > 3 ? `, ${types.length - 3} more types` : "")
          : ""
      }
      controls={
        !trashed &&
        overview && (
          <>
            <ReadingStatusControl invoke={invoke} workspaceId={workspaceId} ids={ids} status={status} mixed={!status} />
            <button
              className="kx-icon-button"
              data-active={allStarred}
              aria-pressed={allStarred}
              title={allStarred ? "Unstar all" : "Star all"}
              aria-label={allStarred ? "Unstar all" : "Star all"}
              onClick={() => void edit({ patch: { starred: !allStarred } }, `${allStarred ? "Unstar" : "Star"} ${plural(n, "source")}`)}
            >
              <Icon name="star" size={14} filled={allStarred} />
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
            {duplicates.length > 0 && (
              <div className="kx-selection-dupes">
                <Icon name="layers" size={13} />
                <span>
                  {duplicates.length === 1
                    ? `${duplicates[0].length} of these look like the same work`
                    : `${duplicates.length} groups look like the same work (${duplicates.reduce((a, g) => a + g.length, 0)} sources)`}
                </span>
                <button onClick={() => onMerge(duplicates[0])}>{duplicates.length === 1 ? "Merge…" : "Merge first…"}</button>
              </div>
            )}
            <SelectionCharts
              years={overview.years}
              types={types.map((t) => ({ label: TYPE_LABEL.get(t.value) ?? t.value ?? "Document", value: t.count }))}
              authors={overview.authors}
              authorCount={overview.authorCount}
              journals={overview.journals}
              journalCount={overview.journalCount}
              total={total}
              noun="sources"
            />
          </>
        )
      }
      footer={
        <>
          {trashed ? (
            <>
              <ActionButton icon="retry" label="Restore" onClick={() => onTrash(ids, false)} />
              <ActionButton icon="trash" label="Delete permanently…" danger onClick={() => onDelete(ids)} />
            </>
          ) : (
            <ActionButton icon="trash" label="Move to Trash" danger onClick={() => onTrash(ids, true)} />
          )}
          <span className="kx-selection-hint">⌘Z undoes</span>
        </>
      }
    >

        {!trashed && (
          <>
            <section className="kx-selection-section" aria-label="Tags">
              <h3>
                Tags
                {overview && overview.tags.length > 0 && <span>{[tagsAll.length && `${tagsAll.length} on all`, tagsSome.length && `${tagsSome.length} on some`].filter(Boolean).join(" · ")}</span>}
              </h3>
              <div className="kx-chips">
                {[...tagsAll, ...tagsSome.slice(0, 40)].map((t) => (
                  <TriChip key={t.value} label={t.value} icon="tag" count={t.count} total={total} onAdd={() => void edit({ tagsAdd: [t.value] })} onRemove={() => void edit({ tagsRemove: [t.value] })} />
                ))}
                {tagsSome.length > 40 && <span className="kx-selection-more">{tagsSome.length - 40} more on some</span>}
                <input
                  className="kx-chip-input"
                  list="kx-selection-tags"
                  aria-label="Add a tag to all"
                  placeholder="Add tag to all…"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTag.trim()) {
                      void edit({ tagsAdd: [newTag.trim()] });
                      setNewTag("");
                    }
                  }}
                />
                <datalist id="kx-selection-tags">
                  {tagSuggestions.slice(0, 200).map((t) => (
                    <option key={t.value} value={t.value} />
                  ))}
                </datalist>
              </div>
            </section>

            <section className="kx-selection-section" aria-label="Collections">
              <h3>Collections</h3>
              <div className="kx-chips">
                {filed.map((c) => (
                  <TriChip
                    key={c.id}
                    label={names.get(c.id) ?? c.name}
                    icon="folder"
                    count={c.count}
                    total={total}
                    onAdd={() => void edit({ collectionsAdd: [c.id] })}
                    onRemove={() => void edit({ collectionsRemove: [c.id] })}
                  />
                ))}
                <select className="kx-chip-add" aria-label="Add all to collection" value="" onChange={(e) => e.target.value && void edit({ collectionsAdd: [e.target.value] })}>
                  <option value="">Add all to…</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className="kx-selection-section kx-selection-actions" aria-label="Actions">
              <h3>Find and update</h3>
              <div className="kx-selection-buttons">
                <ActionButton
                  icon="filePdf"
                  label={withoutFile ? `Find PDFs (${withoutFile.toLocaleString()})` : "Find PDFs"}
                  title={withoutFile ? `Look for open-access PDFs for the ${plural(withoutFile, "source")} without a file` : "Every selected source has its file"}
                  disabled={!withoutFile || !!pdfRun?.running}
                  onClick={() => void findPdfsHere()}
                />
                <ActionButton icon="sync" label="Refresh metadata…" title="Compare with the sources' identifiers and choose what to update" onClick={() => onMetadata(ids)} />
                <ActionButton
                  icon="globe"
                  label="Look up"
                  title="Look the selection up in OpenAlex: authors, journal, topics, funding and citations"
                  onClick={() =>
                    void attempt("Looking up…", async () => {
                      const count = await invoke<number>("store_enrich", { ids }, workspaceId);
                      return `Looking up ${plural(count, "source")} in OpenAlex`;
                    })
                  }
                />
                <ActionButton
                  icon="warning"
                  label="Check retractions"
                  onClick={() =>
                    void attempt("Checking for retractions…", async () => {
                      const r = await invoke<{ checked: number; flagged: number }>("store_retraction_check", { ids }, workspaceId);
                      onRetractionsChecked();
                      return r.flagged ? `${r.flagged} of ${r.checked} flagged as retracted` : `Checked ${r.checked}: no retractions`;
                    })
                  }
                />
                {actionButtons("metadata")}
              </div>
              <h3>AI</h3>
              <div className="kx-selection-buttons">
                {registered("ai").length ? actionButtons("ai") : <ActionButton icon="sparkle" label="Fill with AI…" title="Fill a property with AI or a rule" onClick={() => onFill(loaded)} />}
              </div>
              <h3>Cite and export</h3>
              <div className="kx-selection-buttons">
                <ActionButton icon="quote" label="Copy references" onClick={() => void copyCitation(invoke, workspaceId, ids.map((id) => ({ kind: "source", id })))} />
                <ActionButton icon="quote" label="Copy in-text citation" onClick={() => void copyInTextCitation(invoke, workspaceId, ids.map((id) => ({ kind: "source", id })))} />
                <ActionButton
                  icon="copy"
                  label="Copy BibTeX"
                  onClick={() =>
                    void attempt("Copying BibTeX…", async () => {
                      await navigator.clipboard.writeText(await invoke<string>("store_biblio_copy", { ids, format: "bibtex" }, workspaceId));
                      return `Copied BibTeX for ${plural(n, "source")}`;
                    })
                  }
                />
                <ActionButton icon="upload" label="Export…" onClick={() => openBibExport({ workspaceId, ids })} />
                {actionButtons("cite")}
              </div>
              <h3>Organise</h3>
              <div className="kx-selection-buttons">
                <ActionButton
                  icon="arrowRight"
                  label={`Open ${n > 1 ? "all" : ""}`.trim()}
                  title={loaded.length < n ? `Opens the ${loaded.length} loaded` : "Each in its own tab"}
                  onClick={() => {
                    if (loaded.length > 12 && !window.confirm(`Open ${loaded.length} tabs?`)) return;
                    onOpen(loaded);
                  }}
                />
                <ActionButton icon="inbox" label="Send to Inbox" onClick={sendToInbox} />
                {duplicates.length === 0 && n >= 2 && n <= 8 && <ActionButton icon="layers" label="Merge…" title="Merge these into one source" onClick={() => onMerge(ids)} />}
                {actionButtons("organise")}
                {actionButtons("open")}
                {actionButtons("other")}
              </div>
            </section>
            <section className="kx-selection-section" aria-label="Edit all">
              <h3>
                Edit all<span>Mixed values differ between sources</span>
              </h3>
              <div className="kx-page-properties kx-batch-fields kx-selection-fields">
                <label className="kx-field-row" data-mixed={field("itemType").mixed || undefined}>
                  <span>Item type</span>
                  <select
                    className="kx-batch-select"
                    value={field("itemType").mixed ? "" : asText(field("itemType").value) || "document"}
                    onChange={(e) => e.target.value && void edit({ patch: { itemType: e.target.value } })}
                  >
                    {field("itemType").mixed && <option value="">Mixed</option>}
                    {ITEM_TYPES.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {FIELDS.map(([key, label, kind]) => (
                  <BatchField
                    key={key}
                    label={label}
                    number={kind === "number"}
                    state={field(key)}
                    onCommit={(value) => void edit({ patch: { [key]: kind === "number" ? (value.trim() === "" ? null : Number(value)) : value } })}
                  />
                ))}
                {editable.map((d) => {
                  const state = field(`property:${d.name}`);
                  return d.type === "select" || d.type === "boolean" ? (
                    <label className="kx-field-row" key={d.name} data-mixed={state.mixed || undefined}>
                      <span>{d.name}</span>
                      <select
                        className="kx-batch-select"
                        value={state.mixed ? "\u0000" : asText(state.value)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const value = raw === "" ? null : d.type === "boolean" ? raw === "true" : raw;
                          void edit({ patch: { properties: { [d.name]: value } } });
                        }}
                      >
                        {state.mixed && <option value={"\u0000"}>Mixed</option>}
                        <option value="">—</option>
                        {(d.type === "boolean" ? ["true", "false"] : (d.options ?? [])).map((o) => (
                          <option key={o} value={o}>
                            {d.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <BatchField
                      key={d.name}
                      label={d.name}
                      number={d.type === "number"}
                      state={state}
                      onCommit={(value) => void edit({ patch: { properties: { [d.name]: value.trim() === "" ? null : d.type === "number" ? Number(value) : value } } })}
                    />
                  );
                })}
              </div>
              <div className="kx-selection-buttons">
                <ActionButton icon="plus" label="New property…" title="Define a property and set its value on all of them" onClick={onNewProperty} />
              </div>
            </section>
          </>
        )}

    </SelectionFrame>
  );
}


function BatchField({ label, state, number, onCommit }: { label: string; state: Shared; number?: boolean; onCommit: (value: string) => void }) {
  const value = state.mixed ? "" : asText(state.value);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, state.mixed]);
  return (
    <label className="kx-field-row" data-mixed={state.mixed || undefined}>
      <span>{label}</span>
      <input
        value={draft}
        inputMode={number ? "numeric" : undefined}
        placeholder={state.mixed ? "Mixed" : "—"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** A chip on all or some of the sources: a partial one adds to all when clicked; × takes it off all. */
function TriChip({ label, icon, count, total, onAdd, onRemove }: { label: string; icon: "tag" | "folder"; count: number; total: number; onAdd: () => void; onRemove: () => void }) {
  const partial = count < total;
  return (
    <span className="kx-chip kx-tri-chip" data-partial={partial || undefined} title={partial ? `On ${count} of ${total} · click to add to all` : `On all ${total}`}>
      <button className="kx-tri-chip-label" onClick={partial ? onAdd : undefined} aria-label={partial ? `Add ${label} to all` : label}>
        <Icon name={partial ? "minus" : icon} size={11} />
        {label}
        {partial && <small>{count}</small>}
      </button>
      <button aria-label={`Remove ${label} from all`} onClick={onRemove}>
        <Icon name="close" size={9} />
      </button>
    </span>
  );
}
