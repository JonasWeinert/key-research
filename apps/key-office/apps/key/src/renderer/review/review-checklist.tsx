// std-A: Overview › PRISMA checklist. Every item of PRISMA 2020 (or PRISMA-ScR for a scoping
// review), its abstracts checklist and PRISMA-S, with the status the host computed from the
// review, the rule that decided it, links to where the review shows it, the one action that
// closes a gap, a draft sentence to copy or adjust, and where the manuscript reports it.
// "Generate methods section" drafts Methods and the Results flow paragraph from the data.
import { useEffect, useMemo, useState } from "react";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { Btn, MenuButton, errorText, useLoad } from "./review-ui";
import { STATUS_TEXT, STATUS_TONE, copyText, reportingApi, setFocus, type ChecklistItem, type ChecklistList, type ItemStatus, type ReportLink } from "./review-reporting-api";
import type { StageId, StageProps } from "./ReviewPage";
import "./review-reporting.css";

/** Stages a link may open (a part of Key not in this build shows as plain text). */
export const KNOWN_STAGES = ["overview", "setup", "sources", "ta", "ft", "extract", "analysis", /* std-C */ "rob", "certainty"];

export type OverviewView = "flow" | "checklist" | "search";

/** Opens where an item is evidenced: a stage and its section, an overview view, or an export. */
export function useGoTo(props: StageProps, onView?: (view: string) => void) {
  return (link: ReportLink) => {
    if (link.stage === "export" && link.view) {
      void props.api
        .exportFile(link.view, props.viewer)
        .then((f) => downloadText(f.filename, f.content, f.mime))
        .catch((e) => props.notify(errorText(e), "error"));
      return;
    }
    if (link.stage === "overview" && onView) return onView(link.view ?? "flow");
    setFocus(props.reviewId, link.view);
    props.go(link.stage as StageId);
  };
}

export function LinkChip({ link, go }: { link: ReportLink; go: (l: ReportLink) => void }) {
  const known = KNOWN_STAGES.includes(link.stage) || link.stage === "export";
  return known ? (
    <button type="button" className="kx-rp-link" onClick={() => go(link)}>
      {link.label}
      <Icon name="arrowRight" size={10} />
    </button>
  ) : (
    <span className="kx-rp-link" data-disabled="true" title="This part of Key is not in this build yet">
      {link.label}
    </span>
  );
}

export function StatusPill({ status }: { status: ItemStatus }) {
  return (
    <span className="kx-rv-pill kx-rp-status" data-tone={STATUS_TONE[status]} data-status={status}>
      {STATUS_TEXT[status]}
    </span>
  );
}

/** A draft Key wrote: copy it, or adjust it first (the change is not saved). */
export function Draft({ text, notify }: { text: string; notify: StageProps["notify"] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  useEffect(() => setValue(text), [text]);
  return (
    <div className="kx-rp-draft">
      <div className="kx-rp-draft-head">
        <span>Draft from the review</span>
        <Btn small quiet icon="pen" onClick={() => setEditing((e) => !e)}>
          {editing ? "Done" : "Adjust"}
        </Btn>
        <Btn small quiet icon="copy" onClick={() => void copyText(value).then((ok) => notify(ok ? "Copied" : "Could not copy", ok ? "ok" : "error"))}>
          Copy
        </Btn>
      </div>
      {editing ? <textarea className="kx-rv-input" rows={Math.min(10, Math.max(3, Math.ceil(value.length / 90)))} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Draft text" /> : <p>{value}</p>}
    </div>
  );
}

function NoteFields({ item, save }: { item: ChecklistItem; save: (location: string, text: string) => void }) {
  const [location, setLocation] = useState(item.note?.location ?? "");
  const [text, setText] = useState(item.note?.text ?? "");
  useEffect(() => {
    setLocation(item.note?.location ?? "");
    setText(item.note?.text ?? "");
  }, [item.note?.location, item.note?.text]);
  const commit = () => {
    if (location !== (item.note?.location ?? "") || text !== (item.note?.text ?? "")) save(location, text);
  };
  return (
    <div className="kx-rp-note">
      <label>
        <span>Where reported</span>
        <input className="kx-rv-input" placeholder="e.g. Methods, p. 6" value={location} onChange={(e) => setLocation(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} aria-label={`Where item ${item.id} is reported`} />
      </label>
      <label>
        <span>Notes</span>
        <input className="kx-rv-input" placeholder="For the team" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} aria-label={`Notes on item ${item.id}`} />
      </label>
    </div>
  );
}

export function ItemRow({ item, open, toggle, go, notify, save }: { item: ChecklistItem; open: boolean; toggle: () => void; go: (l: ReportLink) => void; notify: StageProps["notify"]; save: (location: string, text: string) => void }) {
  return (
    <li className="kx-rp-item" data-status={item.status} data-open={open || undefined} data-item={`${item.list}:${item.id}`}>
      <button type="button" className="kx-rp-item-head" aria-expanded={open} onClick={toggle}>
        <span className="kx-rp-num">{item.id}</span>
        <span className="kx-rp-topic">
          <strong>{item.topic}</strong>
          <small>{item.note?.location ? `Reported: ${item.note.location}` : item.rule}</small>
        </span>
        <StatusPill status={item.status} />
        <Icon name={open ? "chevronUp" : "chevronDown"} size={11} />
      </button>
      {open && (
        <div className="kx-rp-item-body">
          <p className="kx-rp-asks">{item.text}</p>
          {item.note?.location && (
            <p className="kx-rp-rule">
              <Icon name="info" size={12} />
              <span>{item.rule}</span>
            </p>
          )}
          {item.gap && (
            <div className="kx-rp-gap">
              <span>{item.gap.action}</span>
              {item.gap.link && <LinkChip link={item.gap.link} go={go} />}
            </div>
          )}
          {item.evidence.length > 0 && (
            <div className="kx-rp-evidence">
              <span className="kx-rv-muted">See</span>
              {item.evidence.map((l, i) => (
                <LinkChip key={i} link={l} go={go} />
              ))}
            </div>
          )}
          {item.draft && <Draft text={item.draft} notify={notify} />}
          <NoteFields item={item} save={save} />
        </div>
      )}
    </li>
  );
}

function Counts({ list }: { list: ChecklistList }) {
  const total = list.items.length || 1;
  const order: ItemStatus[] = ["evidenced", "partly", "notRecorded", "missing", "na"];
  return (
    <div className="kx-rp-counts">
      <div className="kx-rp-meter" aria-hidden="true">
        {order.map((s) => (
          <span key={s} data-status={s} style={{ width: `${((list.counts[s] ?? 0) / total) * 100}%` }} />
        ))}
      </div>
      <div className="kx-rp-legend">
        {order
          .filter((s) => list.counts[s])
          .map((s) => (
            <span key={s} data-status={s}>
              <i />
              {list.counts[s]} {STATUS_TEXT[s].toLowerCase()}
            </span>
          ))}
      </div>
    </div>
  );
}

/** The items of one checklist, by section, with their details. */
export function ChecklistItems({ items, go, notify, save, filter }: { items: ChecklistItem[]; go: (l: ReportLink) => void; notify: StageProps["notify"]; save: (item: ChecklistItem, location: string, text: string) => void; filter: "all" | "gaps" }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const shown = items.filter((i) => filter === "all" || ["partly", "missing", "notRecorded"].includes(i.status));
  const sections: [string, ChecklistItem[]][] = [];
  for (const i of shown) {
    const last = sections[sections.length - 1];
    if (last && last[0] === i.section) last[1].push(i);
    else sections.push([i.section, [i]]);
  }
  if (!shown.length) return <p className="kx-rv-muted kx-rp-empty">Nothing needs attention in this checklist.</p>;
  return (
    <div className="kx-rp-sections">
      {sections.map(([section, list], n) => (
        <section key={`${section}-${n}`} className="kx-rp-section">
          <h3>{section}</h3>
          <ul>
            {list.map((i) => {
              const key = `${i.list}:${i.id}`;
              return (
                <ItemRow
                  key={key}
                  item={i}
                  open={open.has(key)}
                  toggle={() =>
                    setOpen((s) => {
                      const next = new Set(s);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  go={go}
                  notify={notify}
                  save={(loc, text) => save(i, loc, text)}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MethodsSheet({ methods, results, onClose, onSave, notify }: { methods: string; results: string; onClose: () => void; onSave: () => void; notify: StageProps["notify"] }) {
  const blocks = methods.split(/^### /m).filter(Boolean).map((b) => {
    const [head, ...rest] = b.split("\n");
    return { head: head.trim(), body: rest.join("\n").trim() };
  });
  const plain = `${blocks.map((b) => `${b.head}\n${b.body}`).join("\n\n")}\n\nStudy selection\n${results}`;
  return (
    <GlobalDialog label="Methods section" onClose={onClose}>
      <div className="kx-rv-dialog kx-rp-methods">
        <h2>Methods section (draft)</h2>
        <p className="kx-rv-muted">Written from the review's own data: the rules, the decisions and their agreement, the sources and their dates. Check every sentence against what the team did, and replace “Supplementary file X”.</p>
        <div className="kx-rp-methods-body" data-testid="methods-draft">
          {blocks.map((b) => (
            <section key={b.head}>
              <h3>{b.head}</h3>
              <p>{b.body}</p>
            </section>
          ))}
          <section>
            <h3>Results: study selection</h3>
            <p>{results || "No records yet."}</p>
          </section>
        </div>
        <div className="kx-rv-dialog-actions">
          <Btn icon="download" onClick={onSave}>
            Save as Markdown…
          </Btn>
          <Btn icon="copy" onClick={() => void copyText(plain).then((ok) => notify(ok ? "Methods copied" : "Could not copy", ok ? "ok" : "error"))}>
            Copy
          </Btn>
          <Btn primary onClick={onClose}>
            Done
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

export function ChecklistPage(props: StageProps & { initialList?: string; onView: (view: string) => void }) {
  const { invoke, workspaceId, reviewId, summary, viewer, notify, onChanged } = props;
  const rapi = useMemo(() => reportingApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const data = useLoad(() => rapi.checklist(), [rapi, summary.events]);
  const [listId, setListId] = useState(props.initialList ?? "");
  const [filter, setFilter] = useState<"all" | "gaps">("all");
  const [methods, setMethods] = useState(false);
  const go = useGoTo(props, (view) => (view.startsWith("checklist:") ? setListId(view.slice(10)) : props.onView(view)));
  const lists = data.value?.lists ?? [];
  const list = lists.find((l) => l.id === listId) ?? lists[0];
  const exportKind = (kind: string) =>
    rapi
      .exportFile(kind)
      .then((f) => downloadText(f.filename, f.content, f.mime))
      .catch((e) => notify(errorText(e), "error"));
  const save = (item: ChecklistItem, location: string, text: string) =>
    void rapi
      .note(item.list, item.id, location, text, viewer)
      .then(() => {
        data.reload();
        onChanged();
      })
      .catch((e) => notify(errorText(e), "error"));
  if (data.error && !data.value) return <p className="kx-inline-error">{data.error}</p>;
  if (!data.value || !list) return <div className="kx-rv-loading" aria-busy="true" />;
  return (
    <div className="kx-rp-page" data-testid="prisma-checklist">
      <div className="kx-rp-head">
        <div className="kx-rv-seg" role="radiogroup" aria-label="Checklist">
          {lists.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={l.id === list.id} onClick={() => setListId(l.id)}>
              {l.name}
              {(l.counts.missing ?? 0) + (l.counts.partly ?? 0) > 0 && <span className="kx-rv-seg-badge">{(l.counts.missing ?? 0) + (l.counts.partly ?? 0)}</span>}
            </button>
          ))}
        </div>
        <Explain help="review.checklist" />
        <span className="kx-rp-spacer" />
        <Btn icon="doc" onClick={() => setMethods(true)}>
          Generate methods section
        </Btn>
        <MenuButton
          label="Export checklist"
          icon="download"
          items={[
            { label: "Filled checklist (Markdown)", icon: "fileMarkdown", run: () => void exportKind("prisma-checklist") },
            { label: "Filled checklist for Word (HTML)", icon: "fileDoc", run: () => void exportKind("prisma-checklist-html") },
            { label: "Filled checklist (CSV)", icon: "table", run: () => void exportKind("prisma-checklist-csv") },
            null,
            { label: "Methods draft (Markdown)", icon: "doc", run: () => void exportKind("methods-draft") },
          ]}
        />
      </div>
      <div className="kx-rp-summary">
        <Counts list={list} />
        <div className="kx-rv-seg" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={filter === "all"} onClick={() => setFilter("all")}>
            All items
          </button>
          <button type="button" role="radio" aria-checked={filter === "gaps"} onClick={() => setFilter("gaps")}>
            Needs attention
          </button>
        </div>
      </div>
      <ChecklistItems items={list.items} go={go} notify={notify} save={save} filter={filter} />
      <p className="kx-rv-muted kx-rp-attribution">{data.value.attribution}</p>
      {methods && <MethodsSheet methods={data.value.methods} results={data.value.results} notify={notify} onClose={() => setMethods(false)} onSave={() => void exportKind("methods-draft")} />}
    </div>
  );
}
