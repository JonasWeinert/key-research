import { useEffect, useState } from "react";
import { Group, Row } from "./Settings";
import LibraryAccess from "./LibraryAccess";

const bridge = () => (window as unknown as { key: { clearBrowsingData?(): Promise<void> } }).key;

/** The in-app browser keeps one profile (logins, cookies, cache) for as long as it can; this
 * is the only way to wipe it. A second press confirms. */
export default function BrowserSettings() {
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
    <Group title="Browser" footer={error || "Links open in Key’s own browser, which stays signed in to sites between sessions."}>
      <Row label="Browsing data" detail="Cookies, sign-ins, site data and cached pages, and PDFs kept from the web that are not open.">
        <button className="kx-settings-button" disabled={state === "clearing"} onClick={press}>
          {state === "confirm" ? "Clear everything" : state === "clearing" ? "Clearing…" : state === "done" ? "Cleared" : "Clear browsing data…"}
        </button>
      </Row>
    </Group>
    <LibraryAccess />
    </>
  );
}
