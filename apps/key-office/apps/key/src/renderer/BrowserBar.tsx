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
  /** Find PDF opened this tab on a publisher's page: the banner below the bar (FindPdfBanner). */
  findPdf?: import("./FindPdfBanner").FindPdfBannerState;
  /** Passkey sign-ins (main/browser/sign-in.ts): the card over the page (SignInCard), a page
   * waiting for one, a sign-in page (the sign-in window is at hand), a sign-in handed to
   * another browser, or one just brought back. */
  signin?: {
    card?: { stage: "offer" | "open" | "failed"; site: string; way: "window" | "handoff"; browser: string; problem?: string };
    waiting?: { site: string; kind: "get" | "create"; browser?: string; way?: "window" | "handoff" };
    offer?: { browser: string };
    handoff?: { browser: string; site: string };
    imported?: { browser: string; sites: number; names?: string[] };
  };
}
type SignInOp =
  | "signin-stop"
  | "signin-window"
  | "signin-done"
  | "signin-focus"
  | "signin-not-now"
  | "signin-get-browser"
  | "signin-browser"
  | "signin-import"
  | "signin-cancel"
  | "signin-dismiss";
export type WebPageOp = "reload" | "add-article" | "open-article" | "proxy-undo" | "proxy-off" | "proxy-remember" | "proxy-not-now" | "proxy-dismiss" | "proxy-use" | SignInOp;

/** A sign-in that needs a passkey Key's browser cannot offer: what is happening and the way on. */
function SignInNotice({ signin, onPage }: { signin: NonNullable<WebBarState["signin"]>; onPage?(op: WebPageOp): void }) {
  const close = (op: SignInOp) => (
    <button type="button" className="key-web-proxy-close" aria-label="Dismiss" onClick={() => onPage?.(op)}>
      <Icon name="close" size={10} />
    </button>
  );
  if (signin.handoff)
    return (
      <span className="key-web-proxy key-web-signin" role="status" data-handoff title={hintText("browser.signin.handoff")}>
        <Icon name="key" size={12} />
        <span className="key-web-proxy-text">Finish in {signin.handoff.browser}, then</span>
        <button type="button" data-primary onClick={() => onPage?.("signin-import")} title={`Copy this sign-in from ${signin.handoff.browser} into Key’s browser (you see which sites first)`}>
          Bring sign-in over
        </button>
        {close("signin-cancel")}
      </span>
    );
  if (signin.imported) {
    const names = signin.imported.names ?? [];
    return (
      <span className="key-web-proxy key-web-signin" role="status" data-imported title={names.length ? `Brought over from ${signin.imported.browser} for: ${names.join(", ")}` : undefined}>
        <Icon name="check" size={12} />
        <span className="key-web-proxy-text">
          Signed in — brought over for {names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` and ${names.length - 2} more` : "") : `${signin.imported.sites} sites`}
        </span>
        {close("signin-dismiss")}
      </span>
    );
  }
  if (signin.offer && !signin.waiting)
    return (
      <span className="key-web-proxy key-web-signin" data-quiet data-offer-window title={hintText("browser.signin.offer")}>
        <button type="button" onClick={() => onPage?.("signin-window")}>
          <Icon name="key" size={11} />
          Sign in with passkey…
        </button>
      </span>
    );
  const waiting = signin.waiting;
  if (!waiting) return null;
  const window = waiting.way !== "handoff";
  return (
    <span className="key-web-proxy key-web-signin" role="status" data-waiting title={hintText("browser.signin.waiting")}>
      <Icon name="key" size={12} />
      <span className="key-web-proxy-text">{waiting.kind === "create" ? "This site wants to save a passkey" : `${waiting.site || "This site"} is waiting for a passkey`}</span>
      <FirstUseTip help="tip.passkey" anchor=".key-web-signin[data-waiting]" />
      <button
        type="button"
        data-primary
        onClick={() => onPage?.(window ? "signin-window" : "signin-browser")}
        title={window ? `Sign in in a small ${waiting.browser ?? "Chrome"} window, where your phone and saved passkeys work` : `Open this sign-in in ${waiting.browser ?? "your browser"}, where your phone and saved passkeys work`}
      >
        {window ? `Sign in with ${waiting.browser ?? "Chrome"}…` : `Continue in ${waiting.browser ?? "browser"}`}
      </button>
      <button type="button" onClick={() => onPage?.("signin-stop")} title="Stop waiting: the site then offers its other ways to sign in">
        Stop waiting
      </button>
    </span>
  );
}

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
        {state.signin ? <SignInNotice signin={state.signin} onPage={onPage} /> : state.proxy ? <ProxyNotice proxy={state.proxy} onPage={onPage} /> : null}
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
