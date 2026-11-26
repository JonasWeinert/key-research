import type { CSSProperties } from "react";
import { Icon } from "./icons";
import { WebSaveButton } from "./WebSaveButton";
import { WEB_BAR_HEIGHT } from "../shared/browser-layout";
import "./browser.css";
import { FirstUseTip } from "./explain";
import { hintText } from "./help-content";
import { AddToInboxButton } from "./inbox-save";
import { shellContext } from "./item-actions";

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
  article?: { title?: string; doi?: string; inLibrary?: boolean; possiblyInLibrary?: boolean; busy?: boolean };
  /** Library proxies: the page came through one (just sent by Key: Undo is offered), loaded
   * directly where it could have, wants a sign-in the proxy may give, or one was noticed. */
  proxy?: {
    via?: { name: string; host: string; redirected?: boolean; why?: "network" | "signin" | "always" | "user"; reason?: string };
    direct?: { name: string; host: string; why: "network" | "domain" | "site" | "bounce" };
    suggest?: { name: string; host: string; reason: string };
    offer?: { name: string; host: string };
  };
}
export type WebPageOp = "reload" | "add-article" | "open-article" | "proxy-undo" | "proxy-off" | "proxy-remember" | "proxy-not-now" | "proxy-dismiss" | "proxy-use";

const DIRECT_TEXT: Record<NonNullable<NonNullable<WebBarState["proxy"]>["direct"]>["why"], (name: string) => string> = {
  network: () => "Loaded directly — you seem to be on your library’s network",
  bounce: () => "Loaded directly — you seem to be on your library’s network",
  domain: (name) => `Loaded directly — this network is set to skip ${name}`,
  site: () => "Loaded directly — this site let you in without the proxy",
};
const VIA_TEXT = (via: NonNullable<NonNullable<WebBarState["proxy"]>["via"]>) =>
  via.why === "signin" ? `Via ${via.name} — the site asked you to sign in` : via.why === "network" ? `Via ${via.name} — this network needs it` : `Via ${via.name}`;

/** A quiet line in the bar about library proxies (never a dialog). */
function ProxyNotice({ proxy, onPage }: { proxy: NonNullable<WebBarState["proxy"]>; onPage?(op: WebPageOp): void }) {
  const close = (
    <button type="button" className="key-web-proxy-close" aria-label="Dismiss" onClick={() => onPage?.("proxy-dismiss")}>
      <Icon name="close" size={10} />
    </button>
  );
  if (proxy.offer)
    return (
      <span className="key-web-proxy" role="status" data-offer title="A library proxy is your library’s sign-in page. Remembering it opens articles on this site with your library’s access.">
        <Icon name="institution" size={12} />
        <span className="key-web-proxy-text">Use {proxy.offer.name} for library access?</span>
        <FirstUseTip help="tip.proxies" anchor=".key-web-proxy[data-offer]" />
        <button type="button" onClick={() => onPage?.("proxy-remember")} title={`Keep ${proxy.offer.name} and send ${proxy.offer.host || "sites"} through it`}>
          Remember
        </button>
        <button type="button" onClick={() => onPage?.("proxy-not-now")}>
          Not now
        </button>
      </span>
    );
  if (proxy.direct)
    return (
      <span className="key-web-proxy" role="status" data-direct title={hintText("browser.proxy.direct")}>
        <Icon name="institution" size={12} />
        <span className="key-web-proxy-text">{DIRECT_TEXT[proxy.direct.why](proxy.direct.name)}</span>
        <button type="button" title={`Open ${proxy.direct.host} through ${proxy.direct.name}, and keep doing so on this network`} onClick={() => onPage?.("proxy-use")}>
          Use proxy
        </button>
        {close}
      </span>
    );
  if (proxy.suggest)
    return (
      <span className="key-web-proxy" role="status" data-suggest title={hintText("browser.proxy.suggest")}>
        <Icon name="institution" size={12} />
        <span className="key-web-proxy-text">This site asks you to sign in</span>
        <button type="button" title={`Open ${proxy.suggest.host} through ${proxy.suggest.name}, and keep doing so on this network`} onClick={() => onPage?.("proxy-use")}>
          Open via {proxy.suggest.name}
        </button>
        {close}
      </span>
    );
  const via = proxy.via;
  if (!via) return null;
  if (!via.redirected)
    return (
      <span className="key-web-proxy" data-quiet title={`Opened through ${via.name}, your library’s proxy, so you see ${via.host} with your library’s access. If it asks you to sign in, use your library account.`}>
        <Icon name="institution" size={12} />
        <span className="key-web-proxy-text">Via {via.name}</span>
      </span>
    );
  return (
    <span className="key-web-proxy" role="status" data-why={via.why} title={via.why === "signin" ? hintText("browser.proxy.signin") : via.why === "network" ? hintText("browser.proxy.network") : `Key sent ${via.host} through ${via.name}, your library’s proxy, so you see it with your library’s access.`}>
      <Icon name="institution" size={12} />
      <span className="key-web-proxy-text">{VIA_TEXT(via)}</span>
      <button type="button" title={`Open ${via.host} without the proxy, and keep doing so on this network`} onClick={() => onPage?.("proxy-undo")}>
        Undo
      </button>
      <button type="button" title={`Never send ${via.host} through a library proxy`} onClick={() => onPage?.("proxy-off")}>
        Don’t proxy this site
      </button>
      {close}
    </span>
  );
}

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
        {state.proxy ? <ProxyNotice proxy={state.proxy} onPage={onPage} /> : null}
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
            <>
            {article.possiblyInLibrary && !article.busy && (
              <button type="button" className="key-web-article" data-possible title="A source with this title is in your library: open it" onClick={() => onPage?.("open-article")}>
                Possibly in library
              </button>
            )}
            <button
              type="button"
              className="key-web-article"
              disabled={article.busy}
              title={article.doi ? `Add the article this page is about (${article.doi}) as a reference, with its PDF when one is open to you` : "Add the article this page is about as a reference"}
              onClick={() => onPage?.("add-article")}
            >
              <Icon name="plus" size={12} />
              {article.busy ? "Adding…" : article.possiblyInLibrary ? "Add anyway" : "Add to library"}
            </button>
            {shellContext().invoke && article.title && !article.busy && (
              <AddToInboxButton
                invoke={shellContext().invoke!}
                workspaceId={shellContext().workspaceId}
                work={{ title: article.title, doi: article.doi ?? null, landingUrl: state.url }}
                origin={{ kind: "browser", label: state.host, url: state.url }}
                className="key-web-article key-web-article-inbox"
              />
            )}
            </>
          )
        ) : null}
      </span>
      {viewId && <WebSaveButton viewId={viewId} url={state.url} loading={state.loading} doi={article?.doi} />}
      {state.loading && <span className="key-web-progress" role="progressbar" aria-label="Loading" />}
    </nav>
  );
}
