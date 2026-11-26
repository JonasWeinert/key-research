import { useEffect, useState } from "react";
import { Group, Row } from "./Settings";
import LibraryAccess from "./LibraryAccess";
import type { AppSettings } from "./library-api";
import { hintText } from "./help-content";

interface SignInInfo {
  defaultBrowser: string;
  touchId: "on" | "unsigned" | "unsupported";
}
const bridge = () => (window as unknown as { key: { clearBrowsingData?(): Promise<void>; signInInfo?(): Promise<SignInInfo | undefined> } }).key;

const SIGN_IN_BROWSERS: Array<[NonNullable<AppSettings["signInBrowser"]>, string]> = [
  ["chrome", "Google Chrome"],
  ["safari", "Safari"],
  ["firefox", "Firefox"],
  ["edge", "Microsoft Edge"],
  ["arc", "Arc"],
  ["brave", "Brave"],
  ["vivaldi", "Vivaldi"],
  ["chromium", "Chromium"],
];
const TOUCH_ID: Record<SignInInfo["touchId"], string> = {
  on: "On. Passkeys you create in Key’s browser stay on this Mac and open with Touch ID.",
  unsigned: "Needs a copy of Key signed by its developer. Security keys work in this copy.",
  unsupported: "Not available on this computer.",
};

/** Passkey sign-ins: the bar's notice, and the browser a sign-in is finished in. */
function SignInSettings({ settings, onSettings }: { settings: AppSettings; onSettings(patch: Partial<AppSettings>): void }) {
  const [info, setInfo] = useState<SignInInfo>();
  useEffect(() => {
    void bridge().signInInfo?.().then(setInfo, () => undefined);
  }, []);
  return (
    <Group title="Sign-in" help="settings.web.signin">
      <Row label="Say when a sign-in waits for a passkey" detail="The bar offers to continue in your browser, or to stop waiting so the site shows its other ways to sign in.">
        <input
          type="checkbox"
          className="kx-switch"
          aria-label="Say when a sign-in waits for a passkey"
          checked={settings.signInNotice !== false}
          onChange={(e) => onSettings({ signInNotice: e.target.checked })}
        />
      </Row>
      <Row label="Finish sign-ins in" detail={hintText("settings.web.signin-browser")}>
        <select
          className="kx-settings-select"
          aria-label="Finish sign-ins in"
          value={settings.signInBrowser ?? "default"}
          onChange={(e) => onSettings({ signInBrowser: e.target.value as AppSettings["signInBrowser"] })}
        >
          <option value="default">{info ? `Default browser (${info.defaultBrowser})` : "Default browser"}</option>
          {SIGN_IN_BROWSERS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
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
