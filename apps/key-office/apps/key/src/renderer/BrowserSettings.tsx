import { useEffect, useState } from "react";
import { Group, Row } from "./Settings";
import LibraryAccess from "./LibraryAccess";
import type { AppSettings } from "./library-api";
import { hintText } from "./help-content";

interface SignInInfo {
  defaultBrowser: string;
  touchId: "on" | "unsigned" | "unsupported";
  /** Chromium browsers on this Mac the sign-in window can use. */
  installed?: Array<{ id: string; name: string }>;
  /** What happens now: Key's sign-in window in a browser, or a hand-off to one. */
  way?: { kind: "window" | "handoff"; browser: string };
  /** Sign-in services Key remembers a choice for. */
  hosts?: Array<{ host: string; choice?: "window" | "here"; passkey: boolean; automatic: boolean }>;
}
const bridge = () =>
  (window as unknown as { key: { clearBrowsingData?(): Promise<void>; signInInfo?(): Promise<SignInInfo | undefined>; signInForget?(): Promise<void>; signInHost?(host: string, choice: "window" | "here" | null): Promise<SignInInfo | undefined> } }).key;

const HANDOFF_BROWSERS: Array<[NonNullable<AppSettings["signInBrowser"]>, string]> = [
  ["safari", "Safari"],
  ["firefox", "Firefox"],
];
const TOUCH_ID: Record<SignInInfo["touchId"], string> = {
  on: "On. Passkeys you create in Key’s browser stay on this Mac and open with Touch ID.",
  unsigned: "Needs a copy of Key signed by its developer. Security keys work in this copy.",
  unsupported: "Not available on this computer.",
};

/** Passkey sign-ins: whether Key offers help, the browser of the sign-in window, and
 * forgetting that window's sign-ins. */
function SignInSettings({ settings, onSettings }: { settings: AppSettings; onSettings(patch: Partial<AppSettings>): void }) {
  const [info, setInfo] = useState<SignInInfo>();
  const [forget, setForget] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  useEffect(() => {
    void bridge().signInInfo?.().then(setInfo, () => undefined);
  }, [settings.signInBrowser]);
  useEffect(() => {
    if (forget !== "confirm" && forget !== "done") return;
    const timer = setTimeout(() => setForget("idle"), 4000);
    return () => clearTimeout(timer);
  }, [forget]);
  const installed = info?.installed ?? [];
  const choice = settings.signInBrowser ?? "default";
  const known = choice === "default" || installed.some((b) => b.id === choice) || HANDOFF_BROWSERS.some(([id]) => id === choice);
  const status = !info?.way
    ? undefined
    : info.way.kind === "window"
      ? `Sign-ins that need your phone or a saved passkey open in a small ${info.way.browser} window with a profile of Key’s own.`
      : `No Chrome, Edge or Brave on this Mac: you finish such sign-ins in ${info.way.browser} and bring them over.`;
  const pressForget = () => {
    if (forget !== "confirm") return setForget("confirm");
    setForget("busy");
    void bridge()
      .signInForget?.()
      .then(
        () => setForget("done"),
        () => setForget("idle"),
      );
  };
  return (
    <Group title="Sign-in" help="settings.web.signin" footer={status}>
      <Row label="Help when a site asks for a passkey" detail="Key offers a small sign-in window where your phone’s QR code and saved passkeys work.">
        <input
          type="checkbox"
          className="kx-switch"
          aria-label="Help when a site asks for a passkey"
          checked={settings.signInNotice !== false}
          onChange={(e) => onSettings({ signInNotice: e.target.checked })}
        />
      </Row>
      <Row label="Sign in with" detail={hintText("settings.web.signin-browser")}>
        <select
          className="kx-settings-select"
          aria-label="Sign in with"
          value={known ? choice : "default"}
          onChange={(e) => onSettings({ signInBrowser: e.target.value as AppSettings["signInBrowser"] })}
        >
          <option value="default">{info?.way?.kind === "window" && choice === "default" ? `Automatic (${info.way.browser})` : "Automatic"}</option>
          {installed.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} window
            </option>
          ))}
          {HANDOFF_BROWSERS.map(([id, name]) => (
            <option key={id} value={id}>
              {name} (bring sign-in over)
            </option>
          ))}
        </select>
      </Row>
      {(info?.hosts ?? []).map((h) => (
        <Row key={h.host} label={h.host} detail={h.automatic ? (h.choice === "window" ? "Always uses the sign-in window." : "Uses the sign-in window: it asked for a passkey before.") : "Signs in in Key’s browser."}>
          <select
            className="kx-settings-select"
            aria-label={`Sign in to ${h.host}`}
            value={h.automatic ? "window" : "here"}
            onChange={(e) => void bridge().signInHost?.(h.host, e.target.value as "window" | "here").then((next) => next && setInfo(next))}
          >
            <option value="window">Sign-in window</option>
            <option value="here">Key’s browser</option>
          </select>
          <button className="kx-settings-button" title={`Forget the choice for ${h.host}`} onClick={() => void bridge().signInHost?.(h.host, null).then((next) => next && setInfo(next))}>
            Forget
          </button>
        </Row>
      ))}
      <Row label="Sign-in window" detail={hintText("settings.web.signin-forget")}>
        <button className="kx-settings-button" disabled={forget === "busy"} onClick={pressForget}>
          {forget === "confirm" ? "Forget sign-ins" : forget === "busy" ? "Forgetting…" : forget === "done" ? "Forgotten" : "Forget sign-ins…"}
        </button>
      </Row>
      <Row label="Touch ID passkeys" detail={TOUCH_ID[info?.touchId ?? "unsigned"]} />
    </Group>
  );
}

/** The in-app browser keeps one profile (logins, cookies, cache) for as long as it can; this
 * is the only way to wipe it. A second press confirms. */
export default function BrowserSettings({ settings, onSettings }: { settings?: AppSettings; onSettings?(patch: Partial<AppSettings>): void }) {
  const [state, setState] = useState<"idle" | "confirm" | "clearing" | "done">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    if (state !== "confirm" && state !== "done") return;
    const timer = setTimeout(() => setState("idle"), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  const press = () => {
    if (state !== "confirm") return setState("confirm");
    setState("clearing");
    setError("");
    void bridge()
      .clearBrowsingData?.()
      .then(() => setState("done"))
      .catch((e) => {
        setError(String(e));
        setState("idle");
      });
  };
  return (
    <>
    <Group title="Browser" intro="settings.web.browser" footer={error || undefined}>
      <Row label="Browsing data" detail="Cookies, sign-ins, cached pages and downloaded PDFs. Clearing signs you out of every site in Key’s browser.">
        <button className="kx-settings-button" disabled={state === "clearing"} onClick={press}>
          {state === "confirm" ? "Clear everything" : state === "clearing" ? "Clearing…" : state === "done" ? "Cleared" : "Clear browsing data…"}
        </button>
      </Row>
    </Group>
    {settings && onSettings && <SignInSettings settings={settings} onSettings={onSettings} />}
    <LibraryAccess />
    </>
  );
}
