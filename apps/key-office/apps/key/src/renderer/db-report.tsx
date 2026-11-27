// The run report: what was searched, where, when, with which exact query, and how many works
// each database gave and how many duplicates were removed. The record a PRISMA flow diagram
// and a methods section need, exported as Markdown, CSV (the works, from the host) or JSON,
// copied, or put into a new note.
import { useEffect, useState } from "react";
import { describeQuery } from "./db-query";
import type { DbConnector, DbQuery, DbSearchApi, RunPage } from "./db-search-api";
import { CopyButton, countText, downloadText } from "./db-ui";
import { Explain } from "./explain";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { bridge, type Invoke, type Note } from "./library-api";
import { notesChanged } from "./note-events";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The report as Markdown, from the run's own progress (the host's when it writes one). */
export function reportMarkdown(page: RunPage, connectors: DbConnector[], query: DbQuery, name: string) {
  const when = new Date(page.startedAt);
  const name_ = (id: string) => connectors.find((c) => c.id === id)?.name ?? id;
  const version = (id: string) => connectors.find((c) => c.id === id)?.version;
  const lines = [
    `## Database search: ${name}`,
    "",
    `Searched on ${when.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} at ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} with Key.`,
    "",
    describeQuery(query),
    "",
    "| Database | Query | Found | Fetched |",
    "| --- | --- | ---: | ---: |",
    ...page.progress.map((p) => `| ${cell(name_(p.connector))}${version(p.connector) ? ` (${version(p.connector)})` : ""} | \`${cell(p.native || "—")}\` | ${p.total ?? "—"} | ${p.state === "skipped" ? `not searched${p.error ? `: ${cell(p.error)}` : ""}` : p.fetched} |`),
    "",
    `Records fetched: ${page.fetched}. Duplicates removed: ${page.duplicatesRemoved}. Works after de-duplication: ${page.total}.`,
    page.state === "cancelled" ? "\nThe search was stopped before every database had answered." : "",
  ];
  return lines.join("\n").trim() + "\n";
}

export function ReportSheet({ api, invoke, workspaceId, runId, page, connectors, query, name, onClose, onStrategy }: { api: DbSearchApi; invoke: Invoke; workspaceId: string; runId: string; page: RunPage; connectors: DbConnector[]; query: DbQuery; name: string; onClose: () => void; onStrategy?: () => void }) {
  const [markdown, setMarkdown] = useState(() => reportMarkdown(page, connectors, query, name));
  useEffect(() => {
    let live = true;
    void api.report(runId, "markdown").then(
      (file) => live && file.content.trim() && setMarkdown(file.content),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, runId]);
  const stamp = new Date(page.startedAt).toISOString().slice(0, 10);
  const base = `${name.replace(/[^\w\- ]+/g, "").trim() || "Database search"} ${stamp}`;
  const exportFile = async (format: "csv" | "json") => {
    try {
      const file = await api.report(runId, format);
      downloadText(`${base}.${format}`, file.content, file.mime);
    } catch (e) {
      toast(`Couldn’t export: ${String((e as Error)?.message ?? e).replace(/^.*?Error: /, "")}`);
    }
  };
  const toNote = async () => {
    const note = await invoke<Note>("store_note_save", { id: null, sourceId: null, title: `Search report: ${name}`, body: markdown.replace(/^## .*\n+/, "") }, workspaceId);
    notesChanged();
    onClose();
    void bridge().tabAction("open-content", { section: "note", workspaceId, noteId: note.id, title: note.title });
  };
  const name_ = (id: string) => connectors.find((c) => c.id === id)?.name ?? id;
  return (
    <GlobalDrawer presentation="sheet" label="Search report" onClose={onClose}>
      <div className="key-property-editor kx-db-report" data-modal-view="report">
        <header>
          <h2>Search report</h2>
          <p>
            What was searched, where and when, for your methods section and PRISMA flow diagram. <Explain help="dbsearch.report" />
          </p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          <dl className="kx-db-report-sum">
            <div>
              <dt>Records fetched</dt>
              <dd>{countText(page.fetched)}</dd>
            </div>
            <div>
              <dt>Duplicates removed</dt>
              <dd>{countText(page.duplicatesRemoved)}</dd>
            </div>
            <div>
              <dt>Works to screen</dt>
              <dd>{countText(page.total)}</dd>
            </div>
          </dl>
          <table className="kx-db-report-table">
            <thead>
              <tr>
                <th>Database</th>
                <th>Query sent</th>
                <th>Found</th>
                <th>Fetched</th>
              </tr>
            </thead>
            <tbody>
              {page.progress.map((p) => (
                <tr key={p.connector}>
                  <td>{name_(p.connector)}</td>
                  <td>
                    <code>{p.native || "—"}</code>
                  </td>
                  <td>{countText(p.total)}</td>
                  <td>{p.state === "skipped" ? "Not searched" : countText(p.fetched)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="kx-db-muted">Searched {new Date(page.startedAt).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" })}. {describeQuery(query)}</p>
        </div>
        <footer className="kx-merge-actions">
          <CopyButton text={markdown} label="Copy the report as Markdown" />
          <button type="button" className="kx-page-action" onClick={() => downloadText(`${base}.md`, markdown, "text/markdown")}>
            Markdown
          </button>
          <button type="button" className="kx-page-action" onClick={() => void exportFile("csv")} title="Every work found, with the databases that found it">
            CSV
          </button>
          <button type="button" className="kx-page-action" onClick={() => void exportFile("json")} title="The full run log, with each record's provenance">
            JSON
          </button>
          {onStrategy && (
            <button type="button" className="kx-page-action" onClick={onStrategy} title="Each database's exact strings, the queries Key split them into, and how the results were combined">
              Search strategy…
            </button>
          )}
          <span className="kx-spacer" />
          <button type="button" className="kx-page-action kx-page-action-primary" onClick={() => void toNote()}>
            <Icon name="note" size={12} /> New note with report
          </button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}
