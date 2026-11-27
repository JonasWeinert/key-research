// Ways into database search: the "Databases" pill beside "Web" (the search tab, the popup
// search), the "Search databases…" command, and openDatabaseSearch, which opens (or brings
// forward) the workspace's Database search tab with the typed words as a first concept.
import type { MouseEvent } from "react";
import { bridge } from "./library-api";
import { Icon } from "./icons";

const pending = new Map<string, string>();
const listeners = new Set<(workspaceId: string) => void>();

/** Opens the workspace's Database search tab; `text` (the search field's words) starts the query. */
export function openDatabaseSearch(workspaceId: string, text = "") {
  if (text.trim()) {
    pending.set(workspaceId, text.trim());
    listeners.forEach((listener) => listener(workspaceId));
  }
  void bridge().tabAction("open-content", { section: "databases", workspaceId });
}
/** The words a new Database search tab starts with, once. */
export function takePendingDatabaseText(workspaceId: string) {
  const text = pending.get(workspaceId);
  pending.delete(workspaceId);
  return text;
}
/** An open Database search tab takes words sent to it later. */
export function onPendingDatabaseText(workspaceId: string, apply: (text: string) => void) {
  const listener = (id: string) => {
    const text = id === workspaceId ? takePendingDatabaseText(id) : undefined;
    if (text) apply(text);
  };
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pill beside "Web": searches PubMed, Scopus, OpenAlex … with what is typed, in its own tab. */
export function DatabasesPill({ onClick, pressed = false }: { onClick: (e: MouseEvent) => void; pressed?: boolean }) {
  return (
    <div className="kx-kind-chips kx-web-pill" role="group" aria-label="Search databases">
      <button
        type="button"
        data-kind="databases"
        aria-pressed={pressed}
        title="Search PubMed, Scopus, OpenAlex and other databases with these words, in the Database search tab"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        <Icon name="database" size={12} />
        Databases
      </button>
    </div>
  );
}
