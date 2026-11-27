import type { CSSProperties, MouseEvent } from "react";
import { Icon } from "./icons";
import { Explain } from "./explain";
import { FIND_PDF_BANNER_HEIGHT } from "../shared/browser-layout";
import "./find-pdf-banner.css";

/** Main's banner state for a tab Find PDF opened on a publisher's page (main/find-pdf-pages.ts). */
export interface FindPdfBannerState {
  title: string;
  stage: "looking" | "landed" | "saving" | "attached" | "saved";
  links: { url: string; label: string }[];
  /** The page's own PDF link Key points at on the page. */
  pointer?: { label: string };
  wall: boolean;
  signIn?: string;
  proxy?: string;
  abstractOnly: boolean;
  snapshot: boolean;
  busy?: "saving";
  error?: string;
}
export type FindPdfBannerOp = "open" | "show" | "more" | "proxy" | "sign-in" | "save" | "unavailable" | "dismiss" | "source";

/** Below the bar of that tab while the person gets the PDF there. Its job is the nudge: open the
 * PDF on the page yourself (Key points at the page's own link), and Key saves it to the source.
 * The quieter ways on (save the page, not available) wait in More. */
export function FindPdfBanner({ state, style, onOp }: { state: FindPdfBannerState; style?: CSSProperties; onOp(op: FindPdfBannerOp, url?: string, at?: { x: number; y: number }): void }) {
  const title = <b className="kx-fpb-title">{state.title}</b>;
  const box = { ...style, height: FIND_PDF_BANNER_HEIGHT };
  const close = (
    <button type="button" className="kx-fpb-close" aria-label="Hide" title="Hide this banner" onClick={() => onOp("dismiss")}>
      <Icon name="close" size={10} />
    </button>
  );
  if (state.stage === "attached" || state.stage === "saved")
    return (
      <section className="kx-find-pdf-banner" data-stage={state.stage} style={box} aria-label="Find PDF" role="status">
        <span className="kx-fpb-icon" data-done>
          <Icon name="check" size={14} />
        </span>
        <div className="kx-fpb-text">
          <p className="kx-fpb-lead">{state.stage === "attached" ? <>The PDF is saved to {title}.</> : <>This page is saved as the full text of {title}.</>}</p>
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
  if (state.stage === "saving")
    return (
      <section className="kx-find-pdf-banner" data-stage="saving" style={box} aria-label="Find PDF" role="status">
        <span className="kx-fpb-icon">
          <span className="kx-search-spinner" aria-hidden="true" />
        </span>
        <div className="kx-fpb-text">
          <p className="kx-fpb-lead">Saving the PDF to {title}…</p>
          <p className="kx-fpb-quiet">Key keeps the PDF you opened and lays it out with this page’s headings.</p>
        </div>
      </section>
    );
  const more = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onOp("more", undefined, { x: r.left, y: r.bottom + 4 });
  };
  const pointing = !!state.pointer;
  // No link to point at: the one most likely next step, if there is one.
  const next = pointing ? undefined : state.wall ? "sign-in" : state.proxy ? "proxy" : undefined;
  const lead = state.stage === "looking" ? "Opening the publisher’s page…" : pointing ? "Click the highlighted PDF link on this page" : "Look for a PDF or Download button on this page";
  const quiet =
    state.error ??
    (pointing
      ? <>Key couldn’t download it directly. The PDF you open here is saved to {title}.</>
      : state.stage === "looking"
        ? <>Key couldn’t download the PDF for {title} directly.</>
        : <>Key couldn’t download the PDF for {title} directly. Open it here and Key saves it to this source.</>);
  return (
    <section className="kx-find-pdf-banner" data-stage={state.stage} data-pointing={pointing || undefined} style={box} aria-label="Find PDF">
      <span className="kx-fpb-icon">
        <Icon name={pointing ? "cursor" : "filePdf"} size={14} />
      </span>
      <div className="kx-fpb-text">
        <p className="kx-fpb-lead">
          {lead}
          <Explain help="browser.find-pdf.banner" />
        </p>
        <p className="kx-fpb-quiet" data-error={state.error ? true : undefined}>
          {quiet}
        </p>
      </div>
      <div className="kx-fpb-actions">
        {pointing && (
          <button type="button" className="kx-button-primary" title="Scroll to the PDF link on the page" onClick={() => onOp("show")}>
            Show me
          </button>
        )}
        {next === "sign-in" && (
          <button type="button" className="kx-button-primary" title="Go to the site’s sign-in. Key never signs in for you." onClick={() => onOp("sign-in")}>
            <Icon name="key" size={12} />
            Sign in
          </button>
        )}
        {next === "proxy" && (
          <button type="button" className="kx-button-primary" title={`Open this page through ${state.proxy}, your library’s proxy`} onClick={() => onOp("proxy")}>
            <Icon name="institution" size={12} />
            Try through my library
          </button>
        )}
        {state.stage === "landed" && (
          <button type="button" className="kx-fpb-more" aria-label="More" aria-haspopup="menu" title="Save this page instead, or say the PDF isn’t available" onClick={more}>
            More
            <Icon name="chevronDown" size={10} />
          </button>
        )}
        {close}
      </div>
    </section>
  );
}
