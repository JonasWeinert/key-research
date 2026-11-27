// What a bulk Find PDFs run left for the person: the sources whose publisher's page it ended on
// (no tabs were opened for them), each to open (the tab then shows the Find PDF banner) or to
// keep as a saved page for its full text.
import { useState } from "react";
import { Icon } from "./icons";
import { browseForPdf, clearFindPdfResults, settleFindPdfRow, useFindPdfResults } from "./find-pdf";
import { saveSourceWebPage } from "./source-web-page";
import { hintText } from "./help-content";
import type { Invoke } from "./library-api";
import "./find-pdf.css";

export function FindPdfResultsList({ invoke, workspaceId }: { invoke: Invoke; workspaceId: string }) {
  const results = useFindPdfResults();
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!results || results.workspaceId !== workspaceId || (!results.pages.length && !results.savedPages)) return null;
  const save = async (id: string) => {
    setBusy(id);
    try {
      // The copy kept when the page was opened from here, else the page loaded again.
      await invoke("find_pdf_page_save", { sourceId: id }, workspaceId).catch(() => saveSourceWebPage(invoke, workspaceId, id));
      settleFindPdfRow(id);
    } catch (e) {
      setErrors((all) => ({ ...all, [id]: String(e).replace(/^Error: /, "") }));
    } finally {
      setBusy("");
    }
  };
  const n = results.pages.length;
  return (
    <section className="kx-find-pdf-results" aria-label="Find PDFs results">
      <header>
        <span>
          {n ? `${n === 1 ? "One source" : `${n} sources`} landed on the publisher’s page` : "No more pages to open"}
          {results.savedPages ? <small> · {results.savedPages} keep{results.savedPages === 1 ? "s" : ""} a saved page as full text</small> : null}
        </span>
        <button type="button" className="kx-icon-button" aria-label="Dismiss" title="Hide these results" onClick={clearFindPdfResults}>
          <Icon name="close" size={11} />
        </button>
      </header>
      {n > 0 && <p className="kx-find-pdf-results-hint">Open each page to get its PDF there; Key saves it to the source.</p>}
      <ul>
        {results.pages.map((row) => (
          <li key={row.id} data-source={row.id}>
            <Icon name="globe" size={12} />
            <span className="kx-find-pdf-results-title" title={row.url}>
              {row.title}
              {errors[row.id] && <small className="kx-inline-error">{errors[row.id]}</small>}
            </span>
            <button type="button" className="kx-find-pdf-results-action" onClick={() => void browseForPdf(row.url, workspaceId, { id: row.id, title: row.title })}>
              Open page
            </button>
            {!row.savedPage && (
              <button type="button" className="kx-find-pdf-results-action" disabled={busy === row.id} title={hintText("browser.find-pdf.save")} onClick={() => void save(row.id)}>
                {busy === row.id ? "Saving…" : "Save page as full text"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
