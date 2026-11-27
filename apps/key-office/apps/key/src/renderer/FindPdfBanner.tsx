import type { CSSProperties } from "react";
import { Icon } from "./icons";
import { Explain } from "./explain";
import { hintText } from "./help-content";
import { FIND_PDF_BANNER_HEIGHT } from "../shared/browser-layout";
import "./find-pdf-banner.css";

/** Main's banner state for a tab Find PDF opened on a publisher's page (main/find-pdf-pages.ts). */
export interface FindPdfBannerState {
  title: string;
  stage: "looking" | "landed" | "attached" | "saved";
  links: { url: string; label: string }[];
  wall: boolean;
  signIn?: string;
  proxy?: string;
  abstractOnly: boolean;
  snapshot: boolean;
  busy?: "saving";
  error?: string;
}
export type FindPdfBannerOp = "open" | "proxy" | "sign-in" | "save" | "unavailable" | "dismiss" | "source";

/** Below the bar of that tab, while the person looks for the PDF there: what happened, the PDF
 * links the page has, and the ways on. The PDF opened here is saved to the source by itself. */
export function FindPdfBanner({ state, style, onOp }: { state: FindPdfBannerState; style?: CSSProperties; onOp(op: FindPdfBannerOp, url?: string): void }) {
  const title = <b className="kx-fpb-title">{state.title}</b>;
  const close = (
    <button type="button" className="kx-fpb-close" aria-label="Dismiss" title="Hide this banner" onClick={() => onOp("dismiss")}>
      <Icon name="close" size={10} />
    </button>
  );
  if (state.stage === "attached" || state.stage === "saved")
    return (
      <section className="kx-find-pdf-banner" data-stage={state.stage} style={{ ...style, height: FIND_PDF_BANNER_HEIGHT }} aria-label="Find PDF" role="status">
        <span className="kx-fpb-icon" data-done>
          <Icon name="check" size={14} />
        </span>
        <div className="kx-fpb-text">
          <p className="kx-fpb-lead">
            {state.stage === "attached" ? <>The PDF is saved to {title}.</> : <>This page is saved as the full text of {title}.</>}
          </p>
          <p className="kx-fpb-quiet">
            {state.stage === "attached"
              ? "Key used this page’s headings, captions and references to lay out the PDF."
              : state.abstractOnly
                ? "This page seems to contain only the abstract. Find PDF can still look for the PDF later."
                : "You can read, search and highlight it like a PDF."}
          </p>
        </div>
        <div className="kx-fpb-actions">
          <button type="button" className="kx-button-primary" onClick={() => onOp("source")}>
            Back to source
          </button>
          {close}
        </div>
      </section>
    );
  const [first, ...more] = state.links;
  return (
    <section className="kx-find-pdf-banner" data-stage={state.stage} style={{ ...style, height: FIND_PDF_BANNER_HEIGHT }} aria-label="Find PDF">
      <span className="kx-fpb-icon">
        <Icon name="filePdf" size={14} />
      </span>
      <div className="kx-fpb-text">
        <p className="kx-fpb-lead">
          Key couldn’t download the PDF for {title} directly.
          <Explain help="browser.find-pdf.banner" />
        </p>
        <p className="kx-fpb-quiet">
          {state.error ??
            (state.stage === "looking"
              ? "Opening the publisher’s page…"
              : "This is the publisher’s page — if you can open the PDF here (you may need to sign in), Key will save it to this source.")}
        </p>
      </div>
      <div className="kx-fpb-actions">
        {first && (
          <button type="button" className="kx-button-primary" title={`Open ${first.label === "PDF" ? "the PDF" : `“${first.label}”`} (${first.url})`} onClick={() => onOp("open", first.url)}>
            Open PDF
          </button>
        )}
        {more.slice(0, 1).map((link) => (
          <button key={link.url} type="button" className="kx-settings-button" title={link.url} onClick={() => onOp("open", link.url)}>
            Other PDF link
          </button>
        ))}
        {state.proxy && (
          <button type="button" className="kx-settings-button" title={`Open this page through ${state.proxy}, your library’s proxy`} onClick={() => onOp("proxy")}>
            <Icon name="institution" size={12} />
            Try through my library
          </button>
        )}
        {state.wall && (
          <button type="button" className="kx-settings-button" title="Go to the site’s sign-in. Key never signs in for you." onClick={() => onOp("sign-in")}>
            <Icon name="key" size={12} />
            Sign in
          </button>
        )}
        <button
          type="button"
          className="kx-settings-button"
          disabled={state.busy === "saving" || state.stage === "looking"}
          title={state.abstractOnly ? "This page seems to contain only the abstract. You can still keep it as the source’s full text." : hintText("browser.find-pdf.save")}
          onClick={() => onOp("save")}
        >
          {state.busy === "saving" ? "Saving…" : "Save this page instead"}
        </button>
        <button type="button" className="kx-fpb-link" title={hintText("browser.find-pdf.unavailable")} onClick={() => onOp("unavailable")}>
          Not available
        </button>
        {close}
      </div>
    </section>
  );
}
