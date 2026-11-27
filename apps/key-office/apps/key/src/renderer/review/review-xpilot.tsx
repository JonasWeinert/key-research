// Extraction's pilot round and contact log (std-B). A pilot: a few included studies every chosen
// extractor fills in on their own; agreement per field (percent, kappa for choices, ICC and mean
// absolute difference for numbers) and, on closing, "forms piloted on ‹date› with ‹n› studies".
// Contacts: per study, who was asked what, when, and what came back. Logic in key-review xpilot.rs.
import { useEffect, useMemo, useState } from "react";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { GlobalDrawer, GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { plural } from "./review-api";
import { conductApi, fixed, type Contact } from "./review-conduct-api";
import { takeExtractSheet } from "./review-conduct";
import { Btn, errorText, formatDate, useLoad } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import "./review-std-b.css";

export function ExtractionTools(props: StageProps & { studyId?: string; onPick: (id: string) => void }) {
  const { invoke, workspaceId, reviewId, summary, studyId } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const pilots = useLoad(() => api.xpilots(), [api, summary.events]);
  const contacts = useLoad(() => api.contacts(studyId), [api, studyId, summary.events]);
  const [sheet, setSheet] = useState<"pilot" | "contacts">();
  useEffect(() => {
    const want = takeExtractSheet();
    if (want === "pilot") setSheet("pilot");
  }, []);
  const open = pilots.value?.pilots.find((p) => p.pilot.open);
  const n = contacts.value?.contacts.length ?? 0;
  return (
    <>
      <Btn small icon="person" onClick={() => setSheet("pilot")} title="Try the forms on a few studies with every extractor, and see where they disagree">
        {open ? `Pilot: ${open.done} of ${open.pilot.records.length}` : "Pilot round"}
      </Btn>
      {studyId && (
        <Btn small icon="comment" onClick={() => setSheet("contacts")} title="Keep a record of asking this study's authors for missing data">
          {n ? `Contacts (${n})` : "Contact authors"}
        </Btn>
      )}
      {sheet === "pilot" && pilots.value && <PilotSheet {...props} data={pilots.value} reload={pilots.reload} onClose={() => setSheet(undefined)} />}
      {sheet === "contacts" && studyId && <ContactSheet {...props} recordId={studyId} list={contacts.value?.contacts.map((c) => c.contact) ?? []} reload={contacts.reload} onClose={() => setSheet(undefined)} />}
    </>
  );
}

function PilotSheet(props: StageProps & { data: Awaited<ReturnType<ReturnType<typeof conductApi>["xpilots"]>>; reload: () => void; onClose: () => void; onPick: (id: string) => void }) {
  const { invoke, workspaceId, reviewId, summary, viewer, notify, onChanged, data, reload, onClose, onPick } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const people = summary.team.filter((m) => m.roles.some((r) => r === "reviewer" || r === "owner"));
  const [size, setSize] = useState(Math.min(5, Math.max(1, data.included)));
  const [who, setWho] = useState<Set<string>>(new Set(people.slice(0, 2).map((m) => m.id)));
  const [busy, setBusy] = useState(false);
  const exportReport = () =>
    props.api
      .exportFile("extraction-pilot", viewer)
      .then((f) => downloadText(f.filename, f.content, f.mime))
      .catch((e) => notify(errorText(e), "error"));
  const open = data.pilots.find((p) => p.pilot.open);
  const done = () => {
    reload();
    onChanged();
  };
  return (
    <GlobalDrawer presentation="window" label="Extraction pilot" onClose={onClose}>
      <div className="kx-sb-sheet" data-modal-view="pilot">
        <header className="kx-sb-sheet-head">
          <h2>Extraction pilot</h2>
          <Explain help="review.xpilot" />
          <div className="kx-sb-sheet-tools">
            {data.pilots.length > 0 && (
              <Btn small icon="download" onClick={() => void exportReport()}>
                Calibration report
              </Btn>
            )}
            <Btn small onClick={onClose}>
              Done
            </Btn>
          </div>
        </header>
        <p className="kx-rv-muted">Everyone who extracts fills in the same few studies on their own. Fields where they disagree show what to clarify in the form before the main extraction; the agreement goes in the methods.</p>
        {data.facts && <p className="kx-sb-statement-line">{data.facts.statement}</p>}
        {!open && (
          <section className="kx-sb-pilot-new" aria-label="New pilot">
            <h3>New pilot round</h3>
            <label className="kx-sb-inline">
              <input type="number" min={1} max={data.included} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Studies in the pilot" />
              <span>of {plural(data.included, "included study", "included studies")}, drawn at random, extracted by</span>
            </label>
            <div className="kx-sb-people">
              {people.map((m) => (
                <label key={m.id} className="kx-sb-check">
                  <input
                    type="checkbox"
                    checked={who.has(m.id)}
                    onChange={() => {
                      const next = new Set(who);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      setWho(next);
                    }}
                  />
                  <span>{m.name}</span>
                </label>
              ))}
            </div>
            {people.length < 2 && <p className="kx-rv-muted">Add a second person in Setup › Team first: a pilot compares extractors.</p>}
            <Btn
              primary
              small
              disabled={busy || who.size < 2 || !data.included}
              onClick={() => {
                setBusy(true);
                api
                  .xpilotCreate(size, [...who], [], viewer)
                  .then((p) => {
                    notify(`${plural(p.records.length, "study", "studies")} in the pilot: each extractor fills them in`, "ok");
                    done();
                  })
                  .catch((e) => notify(errorText(e), "error"))
                  .finally(() => setBusy(false));
              }}
            >
              Start the pilot
            </Btn>
          </section>
        )}
        {data.pilots
          .slice()
          .reverse()
          .map((p) => (
            <section key={p.pilot.id} className="kx-sb-pilot" data-open={p.pilot.open || undefined} aria-label={p.pilot.name}>
              <div className="kx-sb-row-head">
                <h3>{p.pilot.name}</h3>
                <span className="kx-rv-muted">
                  {formatDate(p.pilot.at)} · {p.extractorNames.join(", ")} · {p.done} of {plural(p.pilot.records.length, "study", "studies")} complete
                </span>
                {p.pilot.open && (
                  <>
                    <Btn small onClick={() => void api.xpilotClose(p.pilot.id, false, viewer).then(done).catch((e) => notify(errorText(e), "error"))}>
                      Close without recording
                    </Btn>
                    <Btn primary small onClick={() => void api.xpilotClose(p.pilot.id, true, viewer).then(() => (notify("Recorded: forms piloted", "ok"), done())).catch((e) => notify(errorText(e), "error"))}>
                      Forms piloted
                    </Btn>
                  </>
                )}
              </div>
              {p.pilot.open && (
                <ul className="kx-sb-pilot-studies">
                  {p.studies.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="kx-sb-link" onClick={() => (onPick(s.id), onClose())}>
                        {s.label}
                      </button>
                      <span className="kx-rv-muted">{s.title}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="kx-sb-tiles" data-small>
                <div>
                  <strong>{p.percent == null ? "–" : `${p.percent.toFixed(0)} %`}</strong>
                  <span>agreement across fields</span>
                </div>
                <div>
                  <strong>{fixed(p.kappa)}</strong>
                  <span>κ for choices (pooled)</span>
                </div>
              </div>
              <table className="kx-sb-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Studies</th>
                    <th>Same</th>
                    <th>κ</th>
                    <th>ICC</th>
                    <th>Mean difference</th>
                  </tr>
                </thead>
                <tbody>
                  {p.fields
                    .filter((f) => f.n > 0 || f.missing > 0)
                    .map((f) => (
                      <tr key={`${f.formId}/${f.fieldId}`} data-low={(f.percent ?? 100) < 80 || undefined}>
                        <td>{f.label}</td>
                        <td>
                          {f.n}
                          {f.missing ? <span className="kx-rv-muted"> (+{f.missing} partly)</span> : null}
                        </td>
                        <td>{f.percent == null ? "–" : `${f.percent.toFixed(0)} %`}</td>
                        <td>{fixed(f.kappa)}</td>
                        <td>{fixed(f.icc)}</td>
                        <td>{fixed(f.meanAbsDiff)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {p.changedSince.length > 0 && (
                <p className="kx-sb-hint">
                  <Icon name="info" size={13} />
                  Changed after this pilot: {p.changedSince.map((c) => `${c.name}${c.versions.length ? ` (protocol version ${c.versions.map((v) => v.number).join(", ")})` : ""}`).join("; ")}.
                </p>
              )}
            </section>
          ))}
      </div>
    </GlobalDrawer>
  );
}

const STATUS: Record<string, string> = { waiting: "Waiting for a reply", replied: "Replied", noReply: "No reply" };
const today = () => new Date().toISOString().slice(0, 10);

function ContactSheet(props: StageProps & { recordId: string; list: Contact[]; reload: () => void; onClose: () => void }) {
  const { invoke, workspaceId, reviewId, viewer, notify, onChanged, recordId, list, reload, onClose } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const blank: Contact = { recordId, date: today(), person: "", method: "email", asked: "", reply: "", replyDate: "", status: "waiting", dataReceived: false };
  const [edit, setEdit] = useState<Contact>(list.length ? list[list.length - 1] : blank);
  const [error, setError] = useState("");
  const set = (patch: Partial<Contact>) => setEdit({ ...edit, ...patch });
  const save = (c: Contact) =>
    api
      .contactSave(c, viewer)
      .then((saved) => {
        notify(c.deleted ? "Contact removed" : "Contact saved", "ok");
        reload();
        onChanged();
        setEdit(c.deleted ? blank : saved);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  return (
    <GlobalDialog label="Contact with authors" onClose={onClose}>
      <form
        className="kx-rv-dialog kx-sb-contact"
        onSubmit={(e) => {
          e.preventDefault();
          void save(edit);
        }}
      >
        <h2>Contact with the authors</h2>
        <p>Asking authors for missing or unclear data is part of the methods: what was asked, when, and what came back is reported.</p>
        {list.length > 0 && (
          <ul className="kx-sb-contacts">
            {list.map((c) => (
              <li key={c.id} data-current={c.id === edit.id || undefined}>
                <button type="button" className="kx-sb-link" onClick={() => setEdit(c)}>
                  {c.date} · {c.person}
                </button>
                <span className="kx-rv-muted">
                  {STATUS[c.status] ?? c.status}
                  {c.dataReceived ? " · data received" : ""}
                </span>
              </li>
            ))}
            <li>
              <button type="button" className="kx-sb-link" onClick={() => setEdit(blank)}>
                New contact…
              </button>
            </li>
          </ul>
        )}
        <div className="kx-sb-form-grid">
          <label className="kx-rv-field">
            <span>Contacted on</span>
            <input type="date" value={edit.date} onChange={(e) => set({ date: e.target.value })} />
          </label>
          <label className="kx-rv-field">
            <span>Who</span>
            <input value={edit.person} onChange={(e) => set({ person: e.target.value })} placeholder="Corresponding author" />
          </label>
          <label className="kx-rv-field">
            <span>How</span>
            <select className="kx-rv-select" value={edit.method} onChange={(e) => set({ method: e.target.value })}>
              <option value="email">Email</option>
              <option value="form">Contact form</option>
              <option value="phone">Phone</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="kx-rv-field">
            <span>Status</span>
            <select className="kx-rv-select" value={edit.status || "waiting"} onChange={(e) => set({ status: e.target.value as Contact["status"] })}>
              <option value="waiting">Waiting for a reply</option>
              <option value="replied">Replied</option>
              <option value="noReply">No reply</option>
            </select>
          </label>
        </div>
        <label className="kx-rv-field" data-wide>
          <span>What was asked</span>
          <textarea rows={2} value={edit.asked} onChange={(e) => set({ asked: e.target.value })} placeholder="Standard deviations for the 12-month outcome" />
        </label>
        <label className="kx-rv-field" data-wide>
          <span>Reply</span>
          <textarea rows={2} value={edit.reply} onChange={(e) => set({ reply: e.target.value })} />
        </label>
        <div className="kx-sb-form-grid">
          <label className="kx-rv-field">
            <span>Replied on</span>
            <input type="date" value={edit.replyDate} onChange={(e) => set({ replyDate: e.target.value })} />
          </label>
          <label className="kx-sb-check">
            <input type="checkbox" checked={edit.dataReceived} onChange={(e) => set({ dataReceived: e.target.checked })} />
            <span>Data received</span>
          </label>
        </div>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          {edit.id ? (
            <Btn danger onClick={() => void save({ ...edit, deleted: true })}>
              Remove
            </Btn>
          ) : (
            <span />
          )}
          <Btn onClick={onClose}>Close</Btn>
          <button type="submit" className="kx-rv-btn" data-primary>
            Save
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}
