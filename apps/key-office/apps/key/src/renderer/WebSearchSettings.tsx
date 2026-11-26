// Settings → Web & browser → Web search: each provider from the registry in the main
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
    <Group title="Web search" help="settings.web.search" footer="Asked only when you search the web, with only what you type.">
      {providers.map((p) => {
        const entry = entries[p.id] ?? {};
        return (
          <Fragment key={p.id}>
            <Row label={p.label} detail={p.id === "openalex" ? "Uses your OpenAlex email and key." : p.keyRequired && !p.apiKey ? p.keyHelp : undefined}>
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
