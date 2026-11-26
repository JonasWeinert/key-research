import type { CSSProperties } from "react";
import { Icon } from "./icons";
import { WEB_BAR_HEIGHT } from "../shared/browser-layout";
import "./browser.css";

/** What a browser tab's bar shows (main's view summary). */
export interface WebBarState {
  host: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** The slim bar above a browser tab's page: back, forward, and which site it is. The page
 * itself is a native view below it; there is no address field by design. */
export function BrowserBar({ state, style, onStep }: { state: WebBarState; style?: CSSProperties; onStep(step: -1 | 1): void }) {
  return (
    <nav className="key-web-bar" aria-label="Browser" style={{ ...style, height: WEB_BAR_HEIGHT }} data-loading={state.loading || undefined}>
      <button type="button" disabled={!state.canGoBack} aria-label="Back" title="Back (⌘[)" onClick={() => onStep(-1)}>
        <Icon name="chevronRight" size={13} style={{ transform: "scaleX(-1)" }} />
      </button>
      <button type="button" disabled={!state.canGoForward} aria-label="Forward" title="Forward (⌘])" onClick={() => onStep(1)}>
        <Icon name="chevronRight" size={13} />
      </button>
      <span className="key-web-site" title={state.url}>
        {state.url.startsWith("https:") ? <Icon name="lock" size={11} aria-label="Secure connection" /> : null}
        <span>{state.host}</span>
      </span>
      {state.loading && <span className="key-web-progress" role="progressbar" aria-label="Loading" />}
    </nav>
  );
}
