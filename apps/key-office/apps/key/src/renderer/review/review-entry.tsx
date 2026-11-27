// Ways into systematic reviews: the sidebar's "Reviews" row (each review under it), the commands
// "New systematic review…" and "Open review file…", and the library's "Send to review…" for a
// selection of sources. A review opens as an ordinary tab (section "review").
import { useEffect, useState } from "react";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { bridge, type Invoke } from "../library-api";
import { registerSelectionAction } from "../selection-actions";
import { toast } from "../item-actions";
import { createReview, importReviewFile, listReviews, plural, reviewApi, savedViewer, saveViewer } from "./review-api";
import { Btn, errorText } from "./review-ui";
import "./review.css";

const OPEN = "key:review-sheet";
const CHANGED = "key:reviews-changed";

export function openReview(workspaceId: string, reviewId: string, title = "Systematic review") {
  return bridge().tabAction("open-content", { section: "review", workspaceId, entityId: reviewId, title });
}

type Sheet = { kind: "new"; workspaceId: string } | { kind: "send"; workspaceId: string; sourceIds: string[] };
/** Opens "New systematic review…". */
export const newReview = (workspaceId: string) => window.dispatchEvent(new CustomEvent<Sheet>(OPEN, { detail: { kind: "new", workspaceId } }));
/** Opens "Send to review…" for library sources. */
export const sendToReview = (workspaceId: string, sourceIds: string[]) => window.dispatchEvent(new CustomEvent<Sheet>(OPEN, { detail: { kind: "send", workspaceId, sourceIds } }));
const changed = () => window.dispatchEvent(new Event(CHANGED));

/** Imports a review file (a merge when the review is here already) and opens it. */
export function openReviewFile(invoke: Invoke, workspaceId: string) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f)
      return;
    void f
      .text()
      .then((t) => importReviewFile(invoke, workspaceId, t))
      .then((r) => {
        changed();
        toast(r.added ? `Added ${plural(r.added, "change")} from the review file` : "This review is up to date");
        return openReview(workspaceId, r.reviewId);
      })
      .catch((e) => toast(errorText(e)));
  };
  input.click();
}

// The library's selection panel and context menu offer it.
registerSelectionAction({ id: "review.send", label: "Send to review…", icon: "checklist", group: "organise", title: "Add these sources to a systematic review for screening", run: ({ workspaceId, sourceIds }) => void sendToReview(workspaceId, sourceIds) });

/** Mounted once by the shell: the new-review and send-to-review sheets. */
export function ReviewSheetsHost({ invoke }: { invoke: Invoke }) {
  const [sheet, setSheet] = useState<Sheet>();
  useEffect(() => {
    const listener = (e: Event) => setSheet((e as CustomEvent<Sheet>).detail);
    window.addEventListener(OPEN, listener);
    return () => window.removeEventListener(OPEN, listener);
  }, []);
  if (!sheet) return null;
  return sheet.kind === "new" ? <NewReviewSheet invoke={invoke} workspaceId={sheet.workspaceId} onClose={() => setSheet(undefined)} /> : <SendSheet invoke={invoke} workspaceId={sheet.workspaceId} sourceIds={sheet.sourceIds} onClose={() => setSheet(undefined)} />;
}

function NewReviewSheet({ invoke, workspaceId, onClose, then }: { invoke: Invoke; workspaceId: string; onClose: () => void; then?: (reviewId: string, actor: string) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(() => {
    try {
      return localStorage.getItem("key.review.ownerName") ?? "";
    } catch {
      return "";
    }
  });
  const [template, setTemplate] = useState<{ name: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <GlobalDialog label="New systematic review" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          try {
            localStorage.setItem("key.review.ownerName", owner.trim());
          } catch {}
          createReview(invoke, workspaceId, name.trim() || "Untitled review", owner.trim(), template?.text)
            .then(async ({ reviewId, actor }) => {
              saveViewer(reviewId, actor);
              if (then) await then(reviewId, actor);
              changed();
              onClose();
              await openReview(workspaceId, reviewId, name.trim() || "Untitled review");
            })
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>New systematic review</h2>
        <p>Screen titles and abstracts, then full texts, extract data and pool it, with a PRISMA 2020 flow diagram kept up to date. Start with sensible defaults and tighten the rules in Setup.</p>
        <div className="kx-rv-form">
          <label className="kx-rv-field" data-wide>
            <span>Review name</span>
            <input className="kx-rv-input" autoFocus placeholder="e.g. Exercise for low back pain" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="kx-rv-field" data-wide>
            <span>Your name</span>
            <input className="kx-rv-input" placeholder="Shown on your decisions" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </label>
          <div className="kx-rv-field" data-wide>
            <span>Start from</span>
            <span className="kx-rv-inline">
              <span className="kx-rv-muted">{template ? template.name : "Key’s defaults: one reviewer, Maybe at title and abstract, a reason at full text"}</span>
              <Btn
                small
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = ".json";
                  input.onchange = () => {
                    const f = input.files?.[0];
                    if (f) void f.text().then((text) => setTemplate({ name: f.name, text }));
                  };
                  input.click();
                }}
              >
                {template ? "Other template…" : "A template…"}
              </Btn>
              {template && (
                <Btn small quiet onClick={() => setTemplate(undefined)}>
                  Use defaults
                </Btn>
              )}
            </span>
          </div>
        </div>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={busy}>
            {busy ? "Creating…" : "Create review"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function SendSheet({ invoke, workspaceId, sourceIds, onClose }: { invoke: Invoke; workspaceId: string; sourceIds: string[]; onClose: () => void }) {
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof listReviews>>>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void listReviews(invoke, workspaceId)
      .then((r) => {
        setReviews(r.filter((x) => !x.archived));
        if (!r.length) setCreating(true);
      })
      .catch((e) => setError(errorText(e)));
  }, [invoke, workspaceId]);
  const send = async (reviewId: string, actor?: string) => {
    const api = reviewApi(invoke, workspaceId, reviewId);
    const who = actor ?? savedViewer(reviewId) ?? (await api.summary("")).team.find((m) => m.roles.includes("owner"))?.id ?? "";
    const { report } = await api.importLibrary({ ids: sourceIds }, { group: "other", name: "Manual" }, who);
    toast(`${plural(report.added, "source")} sent to the review${report.duplicates ? ` (${report.duplicates} already there)` : ""}`);
  };
  if (creating) return <NewReviewSheet invoke={invoke} workspaceId={workspaceId} onClose={onClose} then={(id, actor) => send(id, actor)} />;
  return (
    <GlobalDialog label="Send to review" onClose={onClose} busy={busy}>
      <div className="kx-rv-dialog">
        <h2>Send {plural(sourceIds.length, "source")} to a review</h2>
        <p>They join the review’s records as “other methods: manual”, linked to the library. Duplicates of records already there are removed.</p>
        <ul className="kx-rv-pick">
          {reviews?.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  send(r.id)
                    .then(() => {
                      changed();
                      onClose();
                      return openReview(workspaceId, r.id, r.name);
                    })
                    .catch((e) => setError(errorText(e)))
                    .finally(() => setBusy(false));
                }}
              >
                <Icon name="checklist" size={14} />
                <span>
                  <strong>{r.name}</strong>
                  <small>
                    {plural(r.records, "record")} · {plural(r.included, "study", "studies")} included
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn icon="plus" onClick={() => setCreating(true)}>
            New review…
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

/** The sidebar's "Reviews" row: opens each review; "+" starts one. Hidden until there is one, unless asked. */
export function ReviewsRow({ invoke, workspaceId, currentId }: { invoke: Invoke; workspaceId: string; currentId?: string }) {
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof listReviews>>>([]);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("key.reviews.open") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const load = () => void listReviews(invoke, workspaceId).then(setReviews).catch(() => setReviews([]));
    load();
    window.addEventListener(CHANGED, load);
    const off = bridge().on?.("library-changed", load);
    const timer = setInterval(load, 15000);
    return () => {
      window.removeEventListener(CHANGED, load);
      off?.();
      clearInterval(timer);
    };
  }, [invoke, workspaceId]);
  const shown = reviews.filter((r) => !r.archived || r.id === currentId);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem("key.reviews.open", open ? "0" : "1");
    } catch {}
  };
  return (
    <nav className="kx-tree kx-rv-tree" aria-label="Systematic reviews">
      <div className="kx-tree-row" style={{ paddingLeft: "min(2px, 40%)" }}>
        {shown.length > 0 ? (
          <button type="button" className="kx-tree-disclosure" aria-label={open ? "Collapse reviews" : "Expand reviews"} aria-expanded={open} onClick={toggle}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
          </button>
        ) : (
          <span className="kx-tree-disclosure" aria-hidden="true" />
        )}
        <button type="button" className="kx-tree-label" title="Systematic reviews: screening, extraction and meta-analysis" onClick={() => (shown.length ? toggle() : newReview(workspaceId))}>
          <Icon name="checklist" />
          <span>Reviews</span>
          <small>{shown.length ? shown.length : ""}</small>
        </button>
        <button type="button" className="kx-rv-tree-add" aria-label="New systematic review" title="New systematic review…" onClick={() => newReview(workspaceId)}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {open &&
        shown.map((r) => (
          <div key={r.id} className="kx-tree-row" data-current={r.id === currentId || undefined} style={{ paddingLeft: 18 }}>
            <span className="kx-tree-disclosure" aria-hidden="true" />
            <button type="button" className="kx-tree-label" aria-current={r.id === currentId ? "page" : undefined} title={`${r.records} records · ${r.taDone} of ${r.taEligible} screened · ${r.included} included`} onClick={() => void openReview(workspaceId, r.id, r.name)}>
              <span>{r.name}</span>
              <small>{r.taEligible ? `${Math.round((r.taDone / r.taEligible) * 100)}%` : ""}</small>
            </button>
          </div>
        ))}
    </nav>
  );
}
