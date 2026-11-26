// Add by identifier: one or many DOIs, ISBNs, PMIDs, PMCIDs and arXiv IDs pasted at once (one
// per line, or separated by commas), looked up and added by the library host
// (`web_add_identifiers`, web_search/identifiers.rs), with what became of each listed. An
// article link (no identifier) is looked up on its own as before.
import { useEffect, useRef, useState } from "react";
import { GlobalDialog } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { openItemAt } from "./item-actions";
import type { Invoke, Source } from "./library-api";
import "./identifier-sheet.css";

type Kind = "doi" | "arxiv" | "pmid" | "pmcid" | "isbn";
interface Pasted {
  text: string;
  identifier: { kind: Kind; value: string } | null;
}
interface Outcome {
  text: string;
  kind?: Kind;
  value?: string;
  status: "added" | "exists" | "notFound" | "invalid" | "failed";
  sourceId?: string;
  title?: string;
  message?: string;
  pdf?: boolean;
}

const KIND: Record<Kind, [string, string]> = { doi: ["DOI", "DOIs"], arxiv: ["arXiv ID", "arXiv IDs"], pmid: ["PMID", "PMIDs"], pmcid: ["PMCID", "PMCIDs"], isbn: ["ISBN", "ISBNs"] };
const STATUS: Record<Outcome["status"], { label: string; icon: IconName; tone: string }> = {
  added: { label: "Added", icon: "check", tone: "ok" },
  exists: { label: "Already in library", icon: "book", tone: "info" },
  notFound: { label: "Not found", icon: "info", tone: "muted" },
  invalid: { label: "Not an identifier", icon: "warning", tone: "muted" },
  failed: { label: "Couldn’t look it up", icon: "warning", tone: "warn" },
};

/** "3 DOIs, 1 ISBN" for what was pasted. */
function summary(list: Pasted[]) {
  const counts = new Map<Kind, number>();
  for (const p of list) if (p.identifier) counts.set(p.identifier.kind, (counts.get(p.identifier.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${n} ${KIND[kind][n === 1 ? 0 : 1]}`);
  const invalid = list.filter((p) => !p.identifier).length;
  if (invalid) parts.push(`${invalid} not recognised`);
  return parts.join(", ");
}

const looksLikeLink = (text: string) => /^https?:\/\/\S+$/i.test(text.trim());

/** Looks up identifiers and adds them as references (with their open-access PDFs when asked). */
export function IdentifierSheet({
  invoke,
  workspaceId,
  collectionId,
  initialText = "",
  onClose,
  onAdded,
}: {
  invoke: Invoke;
  workspaceId: string;
  collectionId?: string;
  /** Prefilled (the library search's "Add … to library"). */
  initialText?: string;
  onClose: () => void;
  onAdded: (source: Source) => void;
}) {
  const [text, setText] = useState(initialText);
  const [pasted, setPasted] = useState<Pasted[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Outcome[]>();
  const [findPdf, setFindPdf] = useState(true);
  // What the text holds, read by the host as it is typed.
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    if (!text.trim()) return setPasted([]);
    const timer = setTimeout(() => {
      void invoke<Pasted[]>("web_read_identifiers", { text }, workspaceId)
        .then((list) => n === asked.current && setPasted(list ?? []))
        .catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [text, invoke, workspaceId]);
  const valid = pasted.filter((p) => p.identifier).length;
  const link = !valid && pasted.length === 1 && looksLikeLink(text);

  const add = async () => {
    setBusy(true);
    setError("");
    setResults(undefined);
    try {
      if (link) return await addLink();
      const outcome = await invoke<Outcome[]>("web_add_identifiers", { text, collectionId: collectionId ?? null, findPdf }, workspaceId);
      setResults(outcome);
      const first = outcome.find((o) => o.status === "added" && o.sourceId);
      if (first?.sourceId) {
        const source = await invoke<Source | null>("store_source", { id: first.sourceId }, workspaceId).catch(() => null);
        if (source) onAdded(source);
      }
      // A single work, added: nothing more to say.
      if (outcome.length === 1 && outcome[0].status === "added") onClose();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  // An article link: the scholarly lookup finds its DOI and metadata, as the sheet always did.
  const addLink = async () => {
    const found = await invoke<{ doi?: string | null }>("scholarly_lookup_resource", { resource: text.trim() }, workspaceId);
    if (!found.doi) throw Error("No DOI was found for that link. Paste the article’s DOI instead.");
    const outcome = await invoke<Outcome[]>("web_add_identifiers", { text: found.doi, collectionId: collectionId ?? null, findPdf }, workspaceId);
    setResults(outcome.map((o) => ({ ...o, text: text.trim() })));
    const added = outcome.find((o) => o.status === "added" && o.sourceId);
    if (added?.sourceId) {
      const source = await invoke<Source | null>("store_source", { id: added.sourceId }, workspaceId).catch(() => null);
      if (source) onAdded(source);
      onClose();
    }
  };

  const counts = results && {
    added: results.filter((r) => r.status === "added").length,
    exists: results.filter((r) => r.status === "exists").length,
    missing: results.filter((r) => r.status !== "added" && r.status !== "exists").length,
  };
  return (
    <GlobalDialog label="Add by identifier" onClose={onClose}>
      <form
        className="key-shell-dialog kx-identifier-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && (valid || link)) void add();
        }}
      >
        <h2>Add by identifier</h2>
        <p>Paste DOIs, ISBNs, PubMed or PMC IDs, or arXiv IDs: one, or many on separate lines or separated by commas. An article link works too.</p>
        <textarea
          autoFocus
          className="kx-identifier-text"
          aria-label="Identifiers"
          placeholder={"10.1371/journal.pone.0266237\n978-0-262-03384-8\nPMID 33599681\narXiv:1706.03762"}
          rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setResults(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <section className="kx-identifier-meta">
          <span role="status">{text.trim() ? (link ? "An article link" : summary(pasted) || "Reading…") : ""}</span>
          <label className="kx-check">
            <input type="checkbox" checked={findPdf} onChange={(e) => setFindPdf(e.target.checked)} />
            Find open-access PDFs
          </label>
        </section>
        {results && counts && (
          <section className="kx-identifier-results" aria-label="Results">
            <p className="kx-identifier-tally">
              {[counts.added && `${counts.added} added`, counts.exists && `${counts.exists} already in library`, counts.missing && `${counts.missing} not added`].filter(Boolean).join(" · ")}
            </p>
            <ul>
              {results.map((r, i) => {
                const status = STATUS[r.status];
                return (
                  <li key={`${i}:${r.text}`} data-status={r.status} data-tone={status.tone}>
                    <Icon name={status.icon} size={13} />
                    <span className="kx-identifier-row-text">
                      <strong>{r.title || r.text}</strong>
                      <small>
                        {[r.kind ? `${KIND[r.kind][0]} ${r.value}` : r.text, r.status === "failed" ? r.message : status.label, r.status === "added" && r.pdf ? "with PDF" : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                    {r.sourceId && (
                      <button type="button" className="kx-identifier-open" onClick={() => openItemAt({ kind: "source", id: r.sourceId! }, "tab", r.title || r.text)}>
                        Open
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {error && <p className="kx-inline-error">{error}</p>}
        <div>
          {results ? (
            <button type="button" className="kx-button-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="kx-button-primary" disabled={busy || !(valid || link)}>
                {busy ? (valid > 1 ? `Adding ${valid}…` : "Adding…") : valid > 1 ? `Add ${valid}` : "Add to library"}
              </button>
            </>
          )}
        </div>
      </form>
    </GlobalDialog>
  );
}
