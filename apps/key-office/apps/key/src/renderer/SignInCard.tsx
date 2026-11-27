import type { CSSProperties } from "react";
import { Icon, type IconName } from "./icons";
import { Explain } from "./explain";
import type { WebBarState, WebPageOp } from "./BrowserBar";
import "./sign-in-card.css";

type Card = NonNullable<NonNullable<WebBarState["signin"]>["card"]>;

function Steps({ steps }: { steps: Array<[IconName, string]> }) {
  return (
    <ol className="kx-signin-steps">
      {steps.map(([icon, text]) => (
        <li key={text}>
          <span className="kx-signin-step-icon">
            <Icon name={icon} size={13} />
          </span>
          <span>{text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Over a browser tab's page (the page is hidden meanwhile) when its sign-in needs a passkey
 * Key's browser cannot offer: what is happening, in plain words, and the one way on. */
export function SignInCard({ card, style, onPage }: { card: Card; style?: CSSProperties; onPage(op: WebPageOp, url?: string): void }) {
  const site = card.site || "This site";
  const browser = card.browser;
  const service = card.host || "this sign-in service";
  let body;
  if (card.stage === "open")
    body = (
      <>
        <div className="kx-signin-icon" data-busy>
          <Icon name="phone" size={22} />
        </div>
        <h2>{card.auto ? `Signing in in ${browser}…` : `Finish signing in in ${browser}`}</h2>
        <p>
          A small {browser} window has opened for {site}. Sign in there as usual. To use your phone, choose <b>Use a phone or tablet</b> and scan the QR code.
        </p>
        <p className="kx-signin-quiet">Key brings the sign-in back here by itself and closes the window.</p>
        <div className="kx-signin-actions">
          <button type="button" className="kx-button-primary" data-primary onClick={() => onPage("signin-focus")}>
            Show window
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-done")} title={`Bring the sign-in back from ${browser} now`}>
            I’m signed in
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-cancel")}>
            Cancel
          </button>
        </div>
        {card.auto && (
          <p className="kx-signin-foot">
            Key opens this window for {service} because it asked for a passkey before.{" "}
            <button type="button" className="kx-signin-link" onClick={() => onPage("signin-key-instead")} title={`Sign in here from now on for ${service} (changeable in Settings › Web & browser)`}>
              Use Key’s browser instead
            </button>
          </p>
        )}
      </>
    );
  else if (card.stage === "arrival")
    body = (
      <>
        <div className="kx-signin-icon">
          <Icon name="key" size={22} />
        </div>
        <h2>Sign in to {site}</h2>
        <p>
          If you sign in with a passkey or your phone, use a small {browser} window: Key’s built-in browser can’t show the passkey window. With a password, you can sign in right here.
        </p>
        <div className="kx-signin-actions">
          <button type="button" className="kx-button-primary" data-primary onClick={() => onPage("signin-window")}>
            Sign in with {browser}
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-here")}>
            Continue here
          </button>
        </div>
        <p className="kx-signin-foot">Key remembers your choice for {service}. You can change it in Settings › Web &amp; browser.</p>
      </>
    );
  else if (card.stage === "where")
    body = (
      <>
        <div className="kx-signin-icon">
          <Icon name="globe" size={22} />
        </div>
        <h2>Where were you signing in to?</h2>
        <p>
          Key starts the {browser} window on the site you were going to, so that site asks for a fresh sign-in there. {card.entries?.length ? "Choose it:" : "Open the site you wanted in this tab first, then sign in from there."}
        </p>
        {card.entries?.length ? (
          <div className="kx-signin-entries">
            {card.entries.map((e) => (
              <button key={e.url} type="button" className="kx-signin-entry" onClick={() => onPage("signin-pick", e.url)} title={e.url}>
                <Icon name="globe" size={13} />
                <span>{e.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="kx-signin-actions">
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-dismiss")}>
            Not now
          </button>
        </div>
      </>
    );
  else if (card.stage === "loop")
    body = (
      <>
        <div className="kx-signin-icon" data-warn>
          <Icon name="warning" size={22} />
        </div>
        <h2>{site} didn’t accept the sign-in here</h2>
        <p>
          The sign-in worked in the {browser} window, but {site} sent Key’s browser back to the sign-in page. Some sites tie a sign-in to the browser it was made in.
        </p>
        {card.failed?.length ? <p className="kx-signin-quiet">Could not be brought over: {card.failed.join(", ")}.</p> : null}
        <div className="kx-signin-actions">
          <button type="button" className="kx-button-primary" data-primary onClick={() => onPage("signin-keep")}>
            Use the {browser} window for this site
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-dismiss")}>
            Not now
          </button>
        </div>
      </>
    );
  else if (card.stage === "failed")
    body = (
      <>
        <div className="kx-signin-icon" data-warn>
          <Icon name="warning" size={22} />
        </div>
        <h2>The sign-in didn’t come back</h2>
        <p>{card.problem || `The ${browser} window closed before the sign-in was finished.`}</p>
        <div className="kx-signin-actions">
          <button type="button" className="kx-button-primary" data-primary onClick={() => onPage("signin-window")}>
            Try again
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-dismiss")}>
            Not now
          </button>
        </div>
      </>
    );
  else if (card.way === "handoff")
    body = (
      <>
        <div className="kx-signin-icon">
          <Icon name="key" size={22} />
        </div>
        <h2>Sign in with your phone or a passkey</h2>
        <p>
          {site} is asking for a passkey, but Key’s built-in browser can’t show the passkey window, and there is no Chrome, Edge or Brave on this Mac for Key to open a small sign-in window with.
        </p>
        <Steps
          steps={[
            ["external", `Sign in in ${browser}, with your phone or a saved passkey`],
            ["retry", "Come back to Key and choose Bring sign-in over"],
            ["check", "Key copies just this sign-in, after showing you which sites"],
          ]}
        />
        <div className="kx-signin-actions">
          <button type="button" className="kx-button-primary" data-primary onClick={() => onPage("signin-browser")}>
            Continue in {browser}
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-not-now")}>
            Not now
          </button>
        </div>
        <p className="kx-signin-foot">
          With Google Chrome or Microsoft Edge installed, Key signs you in without this step.{" "}
          <button type="button" className="kx-signin-link" onClick={() => onPage("signin-get-browser")}>
            Get Google Chrome
          </button>
        </p>
      </>
    );
  else
    body = (
      <>
        <div className="kx-signin-icon">
          <Icon name="key" size={22} />
        </div>
        <h2>Sign in with your phone or a passkey</h2>
        <p>
          {site} is asking for a passkey, but Key’s built-in browser can’t show the passkey window. Sign in in a small {browser} window instead: there you can scan the QR code with your phone, or use a saved passkey.
        </p>
        <Steps
          steps={[
            ["phone", `Sign in in the ${browser} window`],
            ["key", "Choose Use a phone or tablet, or a saved passkey"],
            ["check", "Key brings the sign-in back here by itself"],
          ]}
        />
        <div className="kx-signin-actions">
          <button type="button" className="kx-button-primary" data-primary onClick={() => onPage("signin-window")}>
            Sign in with {browser}
          </button>
          <button type="button" className="kx-settings-button" onClick={() => onPage("signin-not-now")}>
            Not now
          </button>
        </div>
        <p className="kx-signin-foot">
          Using a security key? Touch it now.{" "}
          <button type="button" className="kx-signin-link" onClick={() => onPage("signin-stop")} title="Stop waiting for a passkey: the site then offers its other ways to sign in">
            Sign in another way
          </button>
        </p>
      </>
    );
  return (
    <section className="kx-signin-card-layer" style={style} data-stage={card.stage} data-way={card.way} aria-label="Passkey sign-in">
      <div className="kx-signin-card" role="dialog" aria-live="polite">
        {body}
        <Explain help="browser.signin.window" label="How does this work?" className="kx-signin-explain" />
      </div>
    </section>
  );
}
