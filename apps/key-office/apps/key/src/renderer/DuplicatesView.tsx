// The library's "Duplicates" view: groups of sources that look like one work (the surest
// first), each reviewed in a sheet that sets the sources side by side with a choice per
// differing field, like the people merge review (MergeReview.tsx). A merge keeps the
// union of tags, collections, notes, highlights and links, and the merged-away ids keep
// resolving; it is journaled, so ⌘Z brings the sources back. A preprint and its published
// version are offered as "versions" to link rather than duplicates to merge.
import { useCallback, useEffect, useMemo, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { libraryChanged } from "./library-nav";
import { itemTypeLabel, shortCreators, type Collection, type Invoke, type Source } from "./library-api";
import { valueText, type DuplicateGroup, type DuplicateReport, type MergePreview, type Operation } from "./library-hygiene";
import "./entity.css";
import "./hygiene.css";

const KIND_LABEL = { exact: "Same identifier", likely: "Likely duplicate", version: "Preprint and published" } as const;

function byline(source: Source) {
  return [shortCreators(source.creators), source.year, source.containerShort || source.containerTitle, itemTypeLabel(source.itemType)].filter(Boolean).join(" · ");
}

function MemberRow({ source }: { source: Source }) {
  return (
    <li className="kx-dup-member">
      <Icon name={source.filePath ? "filePdf" : "doc"} size={13} />
      <span>
        <strong>{source.title || "Untitled"}</strong>
        <small>
          {byline(source)}
          {source.doi && ` · ${source.doi}`}
          {source.noteCount + source.annotationCount > 0 && ` · ${source.noteCount + source.annotationCount} notes and highlights`}
        </small>
      </span>
    </li>
  );
}

export function DuplicatesView({ invoke, workspaceId, onChanged, onToast }: { invoke: Invoke; workspaceId: string; onChanged: () => void; onToast: (text: string) => void }) {
  const [report, setReport] = useState<DuplicateReport>();
  const [review, setReview] = useState<string[]>();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void invoke<DuplicateReport>("store_duplicates", { withSources: true }, workspaceId)
      .then(setReport)
      .catch(() => setReport({ groups: [], count: 0, exactGroups: 0, exactRemovable: 0 }));
  }, [invoke, workspaceId]);
  useEffect(load, [load]);
  const done = (op: Operation | { entry: Operation["entry"] }) => {
    if (op.entry) onToast(op.entry.label);
    libraryChanged();
    onChanged();
    load();
  };
  const decide = async (group: DuplicateGroup, command: "store_mark_distinct" | "store_link_versions") => {
    const op = await invoke<Operation>(command, { ids: group.ids }, workspaceId);
    done(op);
  };
  const mergeAll = async () => {
    setBusy(true);
    try {
      done(await invoke<Operation>("store_merge_exact", {}, workspaceId));
      setConfirmAll(false);
    } finally {
      setBusy(false);
    }
  };
  if (!report) return <div className="kx-dup-view" aria-busy="true" />;
  return (
    <div className="kx-dup-view" aria-label="Duplicates">
      <div className="kx-dup-head">
        <p>
          {report.count
            ? `${report.count.toLocaleString()} possible ${report.count === 1 ? "duplicate" : "duplicates"}`
            : "No duplicates found"}
          {report.groups.length > report.count && ` · ${report.groups.length - report.count} preprint and published ${report.groups.length - report.count === 1 ? "pair" : "pairs"}`}
          . Nothing is merged unless you choose to.
        </p>
        {report.exactGroups > 0 && (
          <button className="kx-page-action" onClick={() => setConfirmAll(true)}>
            Merge all exact duplicates…
          </button>
        )}
      </div>
      {report.groups.length === 0 ? (
        <div className="kx-merge-empty">
          <Icon name="check" size={18} />
          <span>Every source looks like a work of its own.</span>
        </div>
      ) : (
        <ul className="kx-dup-groups">
          {report.groups.map((group) => (
            <li key={group.id} className="kx-dup-group" data-kind={group.kind}>
              <div className="kx-dup-group-head">
                <span className="kx-dup-kind" data-kind={group.kind}>
                  {KIND_LABEL[group.kind]}
                </span>
                <span className="kx-dup-reason">
                  {group.reason}
                  {group.kind === "likely" && ` · ${Math.round(group.score * 100)}% alike`}
                </span>
                <span className="kx-spacer" />
                {group.kind === "version" ? (
                  <>
                    <button className="kx-page-action" onClick={() => void decide(group, "store_mark_distinct")}>
                      Not related
                    </button>
                    <button className="kx-page-action" onClick={() => setReview(group.ids)}>
                      Merge…
                    </button>
                    <button className="kx-page-action kx-page-action-primary" onClick={() => void decide(group, "store_link_versions")}>
                      Link as versions
                    </button>
                  </>
                ) : (
                  <>
                    <button className="kx-page-action" onClick={() => void decide(group, "store_mark_distinct")}>
                      Not duplicates
                    </button>
                    <button className="kx-page-action kx-page-action-primary" onClick={() => setReview(group.ids)}>
                      Review…
                    </button>
                  </>
                )}
              </div>
              <ul className="kx-dup-members">
                {group.sources.map((s) => (
                  <MemberRow key={s.id} source={s} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {review && (
        <SourceMergeSheet
          invoke={invoke}
          workspaceId={workspaceId}
          ids={review}
          onClose={() => setReview(undefined)}
          onDone={(op) => {
            setReview(undefined);
            done(op);
          }}
        />
      )}
      {confirmAll && (
        <GlobalDrawer onClose={() => setConfirmAll(false)} presentation="sheet" label="Merge exact duplicates">
          <div className="key-property-editor kx-confirm-sheet" role="dialog" aria-label="Merge exact duplicates">
            <header>
              <h2>Merge exact duplicates?</h2>
              <p>
                {report.exactRemovable.toLocaleString()} {report.exactRemovable === 1 ? "source shares" : "sources share"} a DOI, PMID, ISBN, arXiv ID or file with another, in{" "}
                {report.exactGroups.toLocaleString()} {report.exactGroups === 1 ? "group" : "groups"}. Each group becomes its most complete source, with every tag, collection, note and
                highlight kept. Groups with two different files are left for you to review. You can undo this.
              </p>
            </header>
            <footer className="kx-merge-actions">
              <span className="kx-spacer" />
              <button className="kx-page-action" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
              <button className="kx-page-action kx-page-action-primary" disabled={busy} onClick={() => void mergeAll()}>
                Merge {report.exactRemovable.toLocaleString()}
              </button>
            </footer>
          </div>
        </GlobalDrawer>
      )}
    </div>
  );
}

/** Side-by-side review of sources to merge: pick the one to keep and, per field that
 *  differs, the value to keep (the most complete or hand-edited one is chosen first). */
export function SourceMergeSheet({ invoke, workspaceId, ids, onClose, onDone }: { invoke: Invoke; workspaceId: string; ids: string[]; onClose: () => void; onDone: (op: Operation) => void }) {
  const [keep, setKeep] = useState<string>();
  const [preview, setPreview] = useState<MergePreview>();
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void invoke<MergePreview>("store_merge_preview", { ids, keep: keep ?? null }, workspaceId)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setChoices(Object.fromEntries(p.fields.map((f) => [f.field, f.choice])));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, ids, keep]);
  useEffect(() => {
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
  }, [invoke, workspaceId]);
  const names = useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections]);
  const run = async (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      onDone(await invoke<Operation>(command, args, workspaceId));
    } catch (e) {
      setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
    } finally {
      setBusy(false);
    }
  };
  const merge = () => {
    if (!preview) return;
    const [kept, ...others] = preview.sources;
    const fields = Object.fromEntries(preview.fields.map((f) => [f.field, f.values[choices[f.field] ?? f.choice] ?? null]));
    void run("store_merge_sources", { request: { keep: kept.id, others: others.map((o) => o.id), fields } });
  };
  const sources = preview?.sources ?? [];
  return (
    <GlobalDrawer onClose={onClose} presentation="sheet" label="Merge sources">
      <div className="key-property-editor kx-merge-review kx-source-merge" role="dialog" aria-label="Merge sources">
        <header>
          <h2>Merge {ids.length} sources</h2>
          <p>Click the one to keep. Its id stays; the others point to it, so links in notes, canvases and Zotero keep working. You can undo a merge.</p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          {!preview ? (
            error ? <p className="kx-inline-error">{error}</p> : <div className="kx-skeleton-line" />
          ) : (
            <>
              <div className="kx-merge-pair kx-source-merge-cards" style={{ gridTemplateColumns: `repeat(${sources.length}, minmax(0, 1fr))` }}>
                {sources.map((s, i) => (
                  <button key={s.id} type="button" className="kx-merge-card" aria-pressed={i === 0} onClick={() => setKeep(s.id)} title={i === 0 ? "This one is kept" : "Keep this one"}>
                    <span className="kx-merge-keep">{i === 0 ? <><Icon name="check" size={11} /> Keep</> : "Keep this one"}</span>
                    <strong className="kx-merge-name">{s.title || "Untitled"}</strong>
                    <span className="kx-merge-sub">{byline(s)}</span>
                    <dl className="kx-merge-facts">
                      {(
                        [
                          ["File", s.filePath ? s.filePath.split("/").pop() : undefined],
                          ["Notes", s.noteCount + s.annotationCount ? `${s.noteCount} notes, ${s.annotationCount} highlights` : undefined],
                          ["Tags", s.tags.length ? s.tags.join(", ") : undefined],
                          ["In", s.collections.length ? s.collections.map((c) => names.get(c) ?? "Collection").join(", ") : undefined],
                          ["Added", new Date(s.addedAt).toLocaleDateString()],
                        ] as [string, string | undefined][]
                      )
                        .filter(([, v]) => v)
                        .map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                    </dl>
                  </button>
                ))}
              </div>
              {preview.blocked && (
                <div className="kx-banner kx-banner-warning" role="alert">
                  <Icon name="warning" size={13} />
                  <span>{preview.blocked}</span>
                </div>
              )}
              {preview.fields.length > 0 && (
                <table className="kx-merge-fields" aria-label="Fields that differ">
                  <thead>
                    <tr>
                      <th>Field</th>
                      {sources.map((s, i) => (
                        <th key={s.id}>{i === 0 ? "Kept" : `Other${sources.length > 2 ? ` ${i}` : ""}`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.fields.map((f) => (
                      <tr key={f.field}>
                        <th scope="row">{f.label[0].toUpperCase() + f.label.slice(1)}</th>
                        {f.values.map((v, i) => {
                          const text = valueText(v);
                          return (
                            <td key={i}>
                              <label className="kx-merge-choice" data-empty={!text || undefined}>
                                <input type="radio" name={`merge-${f.field}`} checked={(choices[f.field] ?? f.choice) === i} disabled={!text} onChange={() => setChoices({ ...choices, [f.field]: i })} />
                                <span title={text}>{text || "—"}</span>
                                {f.edited[i] && <small title="Set by hand">edited</small>}
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="kx-merge-explain">
                The merged source keeps {preview.tags.length ? `${preview.tags.length} ${preview.tags.length === 1 ? "tag" : "tags"}` : "no tags"},{" "}
                {preview.collections.length} {preview.collections.length === 1 ? "collection" : "collections"}, {preview.notes} {preview.notes === 1 ? "note" : "notes"} and {preview.annotations}{" "}
                {preview.annotations === 1 ? "highlight" : "highlights"}
                {preview.files === 1 ? ", and the file" : ""}.
              </p>
              {error && <p className="kx-inline-error">{error}</p>}
            </>
          )}
        </div>
        <footer className="kx-merge-actions">
          <button className="kx-page-action" disabled={busy} onClick={() => void run("store_mark_distinct", { ids })} title="Never suggest these as duplicates again">
            Not duplicates
          </button>
          <button className="kx-page-action" disabled={busy} onClick={() => void run("store_link_versions", { ids })} title="Keep both, linked as versions of one work">
            Link as versions
          </button>
          <span className="kx-spacer" />
          <button className="kx-page-action" onClick={onClose}>
            Cancel
          </button>
          <button className="kx-page-action kx-page-action-primary" disabled={busy || !preview || !!preview.blocked} onClick={merge}>
            Merge
          </button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}
