import type { CSSProperties } from "react";
import { Icon } from "./icons";
import { WebSaveButton } from "./WebSaveButton";
import { WEB_BAR_HEIGHT } from "../shared/browser-layout";
import "./browser.css";

/** What a browser tab's bar shows (main's view summary). */
export interface WebBarState {
  host: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** A bot check that has not moved on for a while. */
  stalled?: boolean;
  /** The page is a scholarly article. */
  article?: { title?: string; doi?: string; inLibrary?: boolean; busy?: boolean };
}
export type WebPageOp = "reload" | "add-article" | "open-article";

/** The slim bar above a browser tab's page: back, forward, reload, which site it is, and on
 * an article page Add to library (or In library). The page itself is a native view below
 * it; there is no address field by design. */
export function BrowserBar({ state, style, onStep, onPage, viewId }: { state: WebBarState; style?: CSSProperties; onStep(step: -1 | 1): void; onPage?(op: WebPageOp): void; viewId?: string }) {
  const article = state.article;
  return (
    <nav className="key-web-bar" aria-label="Browser" style={{ ...style, height: WEB_BAR_HEIGHT }} data-loading={state.loading || undefined}>
      <button type="button" disabled={!state.canGoBack} aria-label="Back" title="Back (⌘[)" onClick={() => onStep(-1)}>
        <Icon name="chevronRight" size={13} style={{ transform: "scaleX(-1)" }} />
      </button>
      <button type="button" disabled={!state.canGoForward} aria-label="Forward" title="Forward (⌘])" onClick={() => onStep(1)}>
        <Icon name="chevronRight" size={13} />
      </button>
      <button type="button" aria-label="Reload" title="Reload (⌘R)" onClick={() => onPage?.("reload")}>
        <Icon name="retry" size={12} />
      </button>
      <span className="key-web-site" title={state.url}>
        {state.url.startsWith("https:") ? <Icon name="lock" size={11} aria-label="Secure connection" /> : null}
        <span>{state.host}</span>
      </span>
      <span className="key-web-actions">
        {state.stalled ? (
          <button type="button" className="key-web-stalled" title="The site’s check has not finished. Reloading often helps." onClick={() => onPage?.("reload")}>
            Still checking? Reload
          </button>
        ) : null}
        {article ? (
          article.inLibrary ? (
            <button type="button" className="key-web-article" data-done title="Open it in the library" onClick={() => onPage?.("open-article")}>
              <Icon name="check" size={12} />
              In library
            </button>
          ) : (
            <button
              type="button"
              className="key-web-article"
              disabled={article.busy}
              title={article.doi ? `Add ${article.doi} to the library, with its PDF when one is available` : "Add this article to the library"}
              onClick={() => onPage?.("add-article")}
            >
              <Icon name="plus" size={12} />
              {article.busy ? "Adding…" : "Add to library"}
            </button>
          )
        ) : null}
      </span>
      {viewId && <WebSaveButton viewId={viewId} url={state.url} loading={state.loading} />}
      {state.loading && <span className="key-web-progress" role="progressbar" aria-label="Loading" />}
    </nav>
  );
}
