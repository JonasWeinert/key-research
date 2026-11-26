// Settings → Search & indexing → Web search: each provider from the registry in the main
// process, on or off, with its API key when it takes one.
import { Fragment, useEffect, useState } from "react";
import type { WebProviderInfo } from "../shared/web-search";
import type { AppSettings, Invoke } from "./library-api";
import { Group, Row } from "./Settings";

export default function WebSearchSettings({ invoke, settings, onSettings }: { invoke: Invoke; settings: AppSettings; onSettings: (patch: Partial<AppSettings>) => void }) {
  const [providers, setProviders] = useState<WebProviderInfo[]>([]);
  const entries = settings.webProviders ?? {};
  useEffect(() => {
    void invoke<WebProviderInfo[]>("web_providers", {})
      .then(setProviders)
      .catch(() => setProviders([]));
  }, [invoke]);
  const change = (id: string, patch: { enabled?: boolean; apiKey?: string }) => onSettings({ webProviders: { ...entries, [id]: { ...entries[id], ...patch } } });
  if (!providers.length) return null;
  return (
    <Group
      title="Web search"
      footer="The Web pill on the search page asks these catalogues; nothing is sent until you choose it, and then only what you type. Works you add become references in the library, with the open-access PDF when there is one."
    >
      {providers.map((p) => {
        const entry = entries[p.id] ?? {};
        return (
          <Fragment key={p.id}>
            <Row label={p.label} detail={p.id === "openalex" ? "Uses the contact email and API key above." : p.keyRequired && !p.apiKey ? p.keyHelp : undefined}>
              <input
                type="checkbox"
                className="kx-switch"
                aria-label={`Search ${p.label}`}
                checked={entry.enabled ?? p.enabled}
                onChange={(e) => change(p.id, { enabled: e.target.checked })}
              />
            </Row>
            {p.apiKey && (
              <Row label={`${p.label} API key`} detail={p.keyHelp}>
                <input
                  className="kx-settings-select"
                  type="password"
                  aria-label={`${p.label} API key`}
                  defaultValue={entry.apiKey ?? ""}
                  onBlur={(e) => e.target.value.trim() !== (entry.apiKey ?? "") && change(p.id, { apiKey: e.target.value.trim() })}
                />
              </Row>
            )}
          </Fragment>
        );
      })}
    </Group>
  );
}
