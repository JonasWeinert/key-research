// Full texts for the records at full-text screening: which have one, finding them in bulk
// (in the background, with progress), many PDFs dropped at once and matched to records by DOI,
// title, authors and year (confident, uncertain, unmatched, each changeable), and a CSV of the
// records still needing one: fill in its filename column, upload it with the files, and each row
// is matched by file name with a plain error where it does not fit. Files are kept with the
// review, not added to the library (a record whose PDF the library has already is linked).
// Matching and CSV reading are in Rust (key-review/src/records.rs).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { bridge } from "../library-api";
import { downloadText } from "../db-ui";
import { GlobalDialog } from "../GlobalDrawer";
import { plural, type CsvRow, type DroppedFile, type FullTextRow, type MatchProposal, type ReviewApi } from "./review-api";
import { Btn, errorText } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import { onFullTextChanged, requestBrowse } from "./review-browser";

/** Attaches files to records: each file's path on disk goes to the host, which keeps a copy. */
export async function attachFiles(api: ReviewApi, viewer: string, items: { record: string; file?: File; path?: string; name?: string }[], origin: string) {
  let done = 0;
  for (const it of items) {
    const path = it.path ?? (it.file ? bridge().pathForFile(it.file) : "");
    if (!path) throw Error(`Could not read “${it.name ?? it.file?.name ?? "the file"}” from disk`);
    await api.attach(it.record, path, it.name ?? it.file?.name ?? "", origin, viewer);
    done++;
  }
  return done;
}

/** What a dropped file says about itself: PDF title, DOI and opening text (read here, matched
 * in Rust). */
async function describe(file: File): Promise<DroppedFile> {
  const path = bridge().pathForFile(file);
  const base: DroppedFile = { name: file.name, path };
  try {
    if (/\.html?$/i.test(file.name)) {
      const html = await file.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const meta = (n: string) => doc.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? "";
      return { ...base, title: meta("citation_title") || doc.title, doi: meta("citation_doi") || meta("dc.identifier"), text: (doc.body?.textContent ?? "").slice(0, 8000) };
    }
    const { pdfFirstPages } = await import("@key-reader/pdfjs/pdf-first-pages");
    const { title, text } = await pdfFirstPages(await file.arrayBuffer());
    const doi = /\b10\.\d{4,9}\/[^\s"<>]+/.exec(text)?.[0]?.replace(/[.,;)\]]+$/, "") ?? "";
    return { ...base, title, doi, text };
  } catch {
    return base;
  }
}

export function FullTexts(props: StageProps & { onOpen: (id: string) => void }) {
  const { api, viewer, notify, onChanged } = props;
  const [data, setData] = useState<{ rows: FullTextRow[]; have: number; need: number; notRetrievable: number }>();
  const [show, setShow] = useState<"need" | "all">("need");
  const [matching, setMatching] = useState<{ proposals: MatchProposal[]; files: Map<string, File> }>();
  const [csv, setCsv] = useState<{ rows: CsvRow[] }>();
  const [finding, setFinding] = useState<{ done: number; total: number; found: number; stop: boolean }>();
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const csvPick = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => {
    api
      .fulltexts()
      .then(setData)
      .catch((e) => notify(errorText(e), "error"));
  }, [api, notify]);
  useEffect(reload, [reload]);
  useEffect(() => onFullTextChanged(reload), [reload]);
  const stopRef = useRef(false);
  // Pages the bulk run ended on (no tabs opened): each opens in the record's browser.
  const [pages, setPages] = useState<Record<string, string>>({});
  const pageOf = (r: FullTextRow) => pages[r.id] ?? (r.doi ? `https://doi.org/${r.doi}` : "");
  const openPage = (r: FullTextRow) => {
    const list = (data?.rows ?? []).filter((x) => x.state === "need" && pageOf(x)).map((x) => ({ id: x.id, url: pageOf(x) }));
    requestBrowse({ recordId: r.id, url: pageOf(r), fromList: true }, props.onOpen, list);
    props.onOpen(r.id);
  };

  const dropped = async (files: File[]) => {
    const pdfs = files.filter((f) => /\.(pdf|html?)$/i.test(f.name));
    if (!pdfs.length) return notify("Drop PDF files (or saved .html pages)", "error");
    notify(`Reading ${plural(pdfs.length, "file")}…`);
    const described = await Promise.all(pdfs.map(describe));
    const proposals = await api.matchFiles(described);
    setMatching({ proposals, files: new Map(pdfs.map((f) => [f.name, f])) });
  };

  const findAll = async () => {
    const need = (data?.rows ?? []).filter((r) => r.state === "need");
    if (!need.length) return;
    stopRef.current = false;
    let found = 0;
    setFinding({ done: 0, total: need.length, found: 0, stop: false });
    for (let i = 0; i < need.length && !stopRef.current; i++) {
      const r = need[i];
      try {
        // Find PDF without making a library source (Key's browser chain); a temp file we own.
        const res = await props.invoke<{ status: string; path?: string; url?: string }>("web_find_pdf_for", { doi: r.doi ?? undefined, title: r.title ?? undefined }, props.workspaceId);
        if (res.status === "downloaded" && res.path) {
          await api.attach(r.id, res.path, `${(r.title ?? "full text").slice(0, 60)}.pdf`, "find", viewer, true);
          found++;
        } else {
          await api.fulltext(r.id, { status: "sought" }, viewer);
          if (res.status === "browser" && res.url) setPages((all) => ({ ...all, [r.id]: res.url! }));
        }
      } catch (e) {
        if (/Unknown Key command/.test(errorText(e))) {
          notify("Finding in bulk needs a newer Key: open each record's Full text and use Find full text", "error");
          break;
        }
      }
      setFinding({ done: i + 1, total: need.length, found, stop: false });
    }
    setFinding(undefined);
    notify(`Found ${plural(found, "full text")} of ${need.length}`, found ? "ok" : undefined);
    reload();
    onChanged();
  };

  const rows = (data?.rows ?? []).filter((r) => show === "all" || r.state === "need");
  return (
    <div
      className="kx-rv-fulltexts"
      data-over={over || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void dropped([...e.dataTransfer.files]).catch((err) => notify(errorText(err), "error"));
      }}
    >
      <div className="kx-rv-fulltexts-head">
        <div className="kx-rv-fulltexts-counts">
          <strong>{(data?.have ?? 0).toLocaleString()}</strong> with a full text · <strong>{(data?.need ?? 0).toLocaleString()}</strong> still needed
          {data?.notRetrievable ? ` · ${data.notRetrievable.toLocaleString()} not retrieved` : ""}
        </div>
        <div className="kx-rv-fulltexts-actions">
          {finding ? (
            <span className="kx-rv-finding" role="status">
              Finding {finding.done}/{finding.total} · {finding.found} found
              <Btn small quiet onClick={() => (stopRef.current = true)}>
                Stop
              </Btn>
            </span>
          ) : (
            <Btn primary icon="search" disabled={!data?.need} onClick={() => void findAll()} title="Looks for each record's PDF (open access, then the publisher) in the background">
              Find automatically
            </Btn>
          )}
          <Btn icon="link" onClick={() => pick.current?.click()}>
            Add files…
          </Btn>
          <Btn
            icon="download"
            disabled={!data?.need}
            title="The records still needing a full text, with an empty filename column to fill in"
            onClick={() =>
              void api
                .exportFile("fulltext-csv", viewer)
                .then((f) => downloadText(f.filename, f.content, f.mime))
                .catch((e) => notify(errorText(e), "error"))
            }
          >
            Download a CSV
          </Btn>
          <Btn icon="upload" onClick={() => csvPick.current?.click()} title="The CSV with its filename column filled in, and the files it names">
            Upload CSV and files…
          </Btn>
        </div>
      </div>
      <p className="kx-rv-muted kx-rv-drop-hint">
        <Icon name="upload" size={12} /> Drop many PDFs here: each is matched to its record by DOI, title, authors and year, and you check the matches before anything is attached.
      </p>
      <div className="kx-rv-seg" role="radiogroup" aria-label="Show">
        {(
          [
            ["need", "Still needed"],
            ["all", "All at full text"],
          ] as const
        ).map(([id, l]) => (
          <button key={id} type="button" role="radio" aria-checked={show === id} onClick={() => setShow(id)}>
            {l}
          </button>
        ))}
      </div>
      <table className="kx-rv-table kx-rv-fulltext-table">
        <thead>
          <tr>
            <th>Record</th>
            <th>Full text</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-state={r.state}>
              <td>
                <button type="button" className="kx-link-button" onClick={() => props.onOpen(r.id)}>
                  {r.title || "Untitled"}
                </button>
                <small>{r.byline}</small>
              </td>
              <td>
                {r.state === "have" ? (r.file ? <span title={`Kept with the review (${r.file.origin})`}>{r.file.name}</span> : "In the library") : r.state === "notRetrievable" ? `Not retrieved: ${r.reason}` : <span className="kx-rv-muted">Needed</span>}
              </td>
              <td className="kx-rv-row-actions">
                {r.state === "need" && pageOf(r) && (
                  <Btn small quiet icon="globe" onClick={() => openPage(r)} title="Opens the record with Key's browser on its page; the PDF you open there is attached to it">
                    Open page
                  </Btn>
                )}
                {r.state === "have" && (
                  <Btn small quiet onClick={() => void api.detach(r.id, viewer).then(() => (reload(), onChanged()))}>
                    Remove
                  </Btn>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={3} className="kx-rv-muted">
                {show === "need" ? "Every record at full text has its full text, or was marked not retrieved." : "No records at full text yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <input
        ref={pick}
        type="file"
        multiple
        hidden
        accept=".pdf,.html,.htm"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) void dropped(files).catch((err) => notify(errorText(err), "error"));
        }}
      />
      <input
        ref={csvPick}
        type="file"
        multiple
        hidden
        accept=".csv,.pdf,.html,.htm"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          const sheet = files.find((f) => /\.csv$/i.test(f.name));
          if (!sheet) return notify("Choose the filled-in CSV together with the files it names", "error");
          const rest = files.filter((f) => f !== sheet).map((f) => ({ name: f.name, path: bridge().pathForFile(f) }));
          void sheet
            .text()
            .then((text) => api.readCsv(text, rest))
            .then((rows) => setCsv({ rows }))
            .catch((err) => notify(errorText(err), "error"));
        }}
      />
      {matching && (
        <MatchSheet
          {...props}
          proposals={matching.proposals}
          candidates={(data?.rows ?? []).filter((r) => r.state === "need")}
          onClose={() => setMatching(undefined)}
          onAttach={async (chosen) => {
            const n = await attachFiles(api, viewer, chosen.map((c) => ({ record: c.record, file: matching.files.get(c.file), name: c.file })), "match");
            notify(`Attached ${plural(n, "full text")}`, "ok");
            setMatching(undefined);
            reload();
            onChanged();
          }}
        />
      )}
      {csv && (
        <CsvSheet
          rows={csv.rows}
          onClose={() => setCsv(undefined)}
          onAttach={async () => {
            const ok = csv.rows.filter((r) => r.state === "ok" && r.path);
            const n = await attachFiles(api, viewer, ok.map((r) => ({ record: r.record, path: r.path!, name: r.file })), "csv");
            notify(`Attached ${plural(n, "full text")}`, "ok");
            setCsv(undefined);
            reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

const LEVEL: Record<MatchProposal["level"], string> = { confident: "Confident", uncertain: "Check", unmatched: "No match" };

function MatchSheet({ proposals, candidates, onClose, onAttach }: StageProps & { proposals: MatchProposal[]; candidates: FullTextRow[]; onClose: () => void; onAttach: (chosen: { file: string; record: string }[]) => Promise<void> }) {
  // Confident matches are ticked; uncertain ones wait for a look; unmatched pick a record by hand.
  const [choice, setChoice] = useState<Record<string, { record: string; on: boolean }>>(() => Object.fromEntries(proposals.map((p) => [p.file, { record: p.record ?? "", on: p.level === "confident" }])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const titles = useMemo(() => new Map(candidates.map((c) => [c.id, c.title ?? "Untitled"])), [candidates]);
  const chosen = Object.entries(choice).filter(([, c]) => c.on && c.record);
  return (
    <GlobalDialog label="Match files to records" onClose={onClose}>
      <div className="kx-rv-dialog kx-rv-match">
        <h2>Match {plural(proposals.length, "file")} to records</h2>
        <p className="kx-rv-muted">Confident matches are ticked. Check the others, or choose the record by hand.</p>
        <ul className="kx-rv-match-list">
          {proposals.map((p) => {
            const c = choice[p.file];
            return (
              <li key={p.file} data-level={p.level}>
                <label className="kx-rv-match-on">
                  <input type="checkbox" checked={c.on} disabled={!c.record} onChange={() => setChoice({ ...choice, [p.file]: { ...c, on: !c.on } })} aria-label={`Attach ${p.file}`} />
                </label>
                <div>
                  <strong>{p.file}</strong>
                  <span className="kx-rv-pill" data-tone={p.level === "confident" ? "green" : p.level === "uncertain" ? "amber" : "muted"}>
                    {LEVEL[p.level]}
                  </span>
                  <small>{p.why}</small>
                  <select className="kx-rv-select" value={c.record} onChange={(e) => setChoice({ ...choice, [p.file]: { record: e.target.value, on: !!e.target.value } })} aria-label={`Record for ${p.file}`}>
                    <option value="">Choose a record…</option>
                    {p.record && !titles.has(p.record) && <option value={p.record}>{p.record}</option>}
                    {candidates.map((r) => (
                      <option key={r.id} value={r.id}>
                        {(r.title ?? "Untitled").slice(0, 90)}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            );
          })}
        </ul>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            primary
            disabled={!chosen.length || busy}
            onClick={() => {
              setBusy(true);
              onAttach(chosen.map(([file, c]) => ({ file, record: c.record })))
                .catch((e) => setError(errorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            Attach {chosen.length}
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

function CsvSheet({ rows, onClose, onAttach }: { rows: CsvRow[]; onClose: () => void; onAttach: () => Promise<void> }) {
  const [error, setError] = useState("");
  const ok = rows.filter((r) => r.state === "ok").length;
  const bad = rows.filter((r) => r.state === "error").length;
  return (
    <GlobalDialog label="Full texts from the CSV" onClose={onClose}>
      <div className="kx-rv-dialog kx-rv-csv">
        <h2>Full texts from the CSV</h2>
        <p>
          {plural(ok, "row")} ready{bad ? `, ${plural(bad, "row")} with a problem` : ""}
          {rows.length - ok - bad ? `, ${rows.length - ok - bad} left blank` : ""}.
        </p>
        <table className="kx-rv-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>File</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line} data-state={r.state}>
                <td>{r.line}</td>
                <td>{r.file || <span className="kx-rv-muted">—</span>}</td>
                <td>{r.state === "error" ? <span className="kx-inline-error">{r.message}</span> : <span className="kx-rv-muted">{r.message}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary disabled={!ok} onClick={() => void onAttach().catch((e) => setError(errorText(e)))}>
            Attach {ok}
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}
