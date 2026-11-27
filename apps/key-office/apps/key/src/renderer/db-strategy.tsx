// "Copy / Export search strategy": for a methods section or PRISMA-style reporting, every
// database's exact strings, when they ran, the counts per query, the limits, and where Key split
// a search or checked it on the results, the reconstruction written out with the full Boolean
// search and any "approximate" notes. Written by the host (db_strategy); here it is previewed,
// copied as text or Markdown, or saved as .md, .json (re-importable) or .csv.
import { useEffect, useState } from "react";
import type { DbQuery, DbSearchApi, ReportFile } from "./db-search-api";
import { downloadText } from "./db-ui";
import { Explain } from "./explain";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { toast } from "./item-actions";

export type StrategySource = { runId: string; label?: string } | { query: DbQuery; connectors: string[]; overrides?: Record<string, string>; label?: string };

const fail = (e: unknown) => String((e as Error)?.message ?? e).replace(/^.*?Error: /, "");

export function StrategySheet({ api, source, onClose }: { api: DbSearchApi; source: StrategySource; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string>();
  const [error, setError] = useState<string>();
  const ran = "runId" in source;
  useEffect(() => {
    let live = true;
    void api.strategy(source, "markdown").then(
      (f) => live && setMarkdown(f.content),
      (e) => live && setError(fail(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const get = async (format: "markdown" | "text" | "json" | "csv"): Promise<ReportFile | undefined> => {
    try {
      return await api.strategy(source, format);
    } catch (e) {
      toast(`Couldn’t export the strategy: ${fail(e)}`);
      return undefined;
    }
  };
  const copy = async (format: "markdown" | "text") => {
    const f = await get(format);
    if (!f) return;
    await navigator.clipboard.writeText(f.content);
    toast(format === "text" ? "Copied the search strategy as text" : "Copied the search strategy as Markdown");
  };
  const save = async (format: "markdown" | "json" | "csv") => {
    const f = await get(format);
    if (!f) return;
    const name = source.label?.replace(/[^\w\- ]+/g, "").trim();
    downloadText(name ? f.filename.replace(/^search-strategy/, `${name} strategy`) : f.filename, f.content, f.mime);
  };
  return (
    <GlobalDrawer presentation="sheet" label="Search strategy" onClose={onClose}>
      <div className="key-property-editor kx-db-report kx-db-strategy" data-modal-view="strategy">
        <header>
          <h2>Search strategy</h2>
          <p>
            {ran ? "Exactly what each database was sent, when, and what came back" : "Exactly what each database will be sent"}, with how Key combined the results. <Explain help="dbsearch.strategy" />
          </p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          {error ? <p className="kx-inline-error">{error}</p> : markdown === undefined ? <p className="kx-db-muted">Writing the strategy…</p> : <pre className="kx-db-strategy-text" aria-label="The search strategy">{markdown}</pre>}
        </div>
        <footer className="kx-merge-actions">
          <button type="button" className="kx-page-action" disabled={!markdown} onClick={() => void copy("text")}>
            <Icon name="copy" size={12} /> Copy as text
          </button>
          <button type="button" className="kx-page-action" disabled={!markdown} onClick={() => void copy("markdown")}>
            Copy as Markdown
          </button>
          <span className="kx-spacer" />
          <button type="button" className="kx-page-action" disabled={!markdown} onClick={() => void save("markdown")} title="A Markdown file for your methods section">
            <Icon name="download" size={12} /> .md
          </button>
          <button type="button" className="kx-page-action" disabled={!markdown} onClick={() => void save("json")} title="Machine-readable; Import query… in Key runs it again">
            .json
          </button>
          <button type="button" className="kx-page-action" disabled={!markdown} onClick={() => void save("csv")} title="A table: database, string, count">
            .csv
          </button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}
