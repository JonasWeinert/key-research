// Settings → Web & browser → Web search: the scholarly catalogues (asked side by side), on or
// off; and the general web search engines (Tavily, Firecrawl …), each turned on by the user,
// in an order they drag, with what happens when one fails or runs out of credits. Engines'
// keys live under Services & API keys; queries go only to the engines turned on here.
import { Fragment, useCallback, useEffect, useState } from "react";
import type { WebProviderInfo } from "../shared/web-search";
import type { WebFilterKey } from "../shared/web-filters";
import { Icon } from "./icons";
import type { AppSettings, Invoke } from "./library-api";
import { Group, Row } from "./Settings";
import { FILTER_NAME } from "./WebResults";
import "./web-engines.css";

type Engines = NonNullable<AppSettings["webEngines"]>;
const DEFAULT_ENGINES: Engines = { order: [], fallback: "next", scholarly: false };
/** The filters that tell engines apart (the others are checked on every result). */
const ENGINE_FILTERS: WebFilterKey[] = ["year", "site", "language"];

export default function WebSearchSettings({ invoke, settings, onSettings, onOpenServices }: { invoke: Invoke; settings: AppSettings; onSettings: (patch: Partial<AppSettings>) => void; onOpenServices?: () => void }) {
  const [providers, setProviders] = useState<WebProviderInfo[]>([]);
  const entries = settings.webProviders ?? {};
  const reload = useCallback(() => {
    void invoke<WebProviderInfo[]>("web_providers", {})
      .then(setProviders)
      .catch(() => setProviders([]));
  }, [invoke]);
  // Read again when the settings change (the host has been told by then) and every few
  // seconds, so a key added under Services & API keys shows here.
  const settingsKey = JSON.stringify([settings.webProviders, settings.webEngines]);
  useEffect(() => {
    const first = setTimeout(reload, 150);
    const timer = setInterval(reload, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [reload, settingsKey]);
  const change = (id: string, patch: { enabled?: boolean; apiKey?: string; baseUrl?: string }) => onSettings({ webProviders: { ...entries, [id]: { ...entries[id], ...patch } } });
  if (!providers.length) return null;
  const catalogues = providers.filter((p) => (p.kind ?? "catalogue") === "catalogue");
  return (
    <>
      <Group title="Web search" help="settings.web.search" footer="Asked only when you search the web, with only what you type.">
        {catalogues.map((p) => {
          const entry = entries[p.id] ?? {};
          return (
            <Fragment key={p.id}>
              <Row label={p.label} detail={p.id === "openalex" ? "Uses your OpenAlex email and key." : p.keyRequired && !p.apiKey ? p.keyHelp : undefined}>
                <input type="checkbox" className="kx-switch" aria-label={`Search ${p.label}`} checked={entry.enabled ?? p.enabled} onChange={(e) => change(p.id, { enabled: e.target.checked })} />
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
      <EngineSettings invoke={invoke} providers={providers} settings={settings} onSettings={onSettings} onChange={change} onOpenServices={onOpenServices} />
    </>
  );
}

function EngineSettings({
  invoke,
  providers,
  settings,
  onSettings,
  onChange,
  onOpenServices,
}: {
  invoke: Invoke;
  providers: WebProviderInfo[];
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onChange: (id: string, patch: { enabled?: boolean; baseUrl?: string }) => void;
  onOpenServices?: () => void;
}) {
  const engines = settings.webEngines ?? DEFAULT_ENGINES;
  const chain = providers.find((p) => p.kind === "chain")?.chain;
  const byId = new Map(providers.filter((p) => p.kind === "engine").map((p) => [p.id, p]));
  const at = (id: string) => (engines.order.includes(id) ? engines.order.indexOf(id) : Number.MAX_SAFE_INTEGER);
  // The order as just changed here (the host hears of it a moment later).
  const order = (chain?.order ?? [...byId.keys()]).map((id) => byId.get(id)).filter((p): p is WebProviderInfo => !!p).sort((a, b) => at(a.id) - at(b.id));
  const switchedOn = (p: WebProviderInfo) => settings.webProviders?.[p.id]?.enabled ?? !!p.engine?.turnedOn;
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; side: "before" | "after" }>();
  if (!order.length) return null;
  const setEngines = (patch: Partial<Engines>) => onSettings({ webEngines: { ...engines, ...patch } });
  const move = (id: string, to: number) => {
    const ids = order.map((p) => p.id).filter((i) => i !== id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    setEngines({ order: ids });
  };
  const ready = (p: WebProviderInfo) => (p.engine?.needsBaseUrl ? !!(settings.webProviders?.[p.id]?.baseUrl ?? p.engine.baseUrl) : !!p.engine?.hasKey);
  const on = order.filter((p) => switchedOn(p) && ready(p));
  const rank = (id: string) => on.findIndex((p) => p.id === id);
  return (
    <Group
      title="Web search engines"
      help="settings.web.engines"
      intro="settings.web.engines-intro"
      footer="Your search goes only to the engines turned on here, one at a time in this order. Drag to change the order."
    >
      {order.map((p, index) => {
        const engine = p.engine!;
        const isReady = ready(p);
        const turnedOn = switchedOn(p) && isReady;
        const position = rank(p.id);
        const detail = !isReady ? (
          engine.needsBaseUrl ? (
            "Runs on a server you choose: give its address below"
          ) : (
            <>
              Needs a {p.label} key ·{" "}
              <button type="button" className="kx-engine-link" onClick={onOpenServices}>
                Add it in Services &amp; API keys
              </button>
            </>
          )
        ) : turnedOn ? (
          position === 0 ? "Asked first" : `Asked when the ones above fail${engines.fallback === "stop" ? " (off: Stop at the first failure)" : ""}`
        ) : (
          "Off: never asked"
        );
        return (
          <Fragment key={p.id}>
            <div
              className="kx-settings-row kx-engine-row"
              data-engine={p.id}
              data-dragging={dragging === p.id || undefined}
              data-drop={drop?.id === p.id ? drop.side : undefined}
              draggable
              onDragStart={(e) => {
                setDragging(p.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", p.id);
              }}
              onDragEnd={() => {
                setDragging(undefined);
                setDrop(undefined);
              }}
              onDragOver={(e) => {
                if (!dragging || dragging === p.id) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                setDrop({ id: p.id, side: e.clientY < box.top + box.height / 2 ? "before" : "after" });
              }}
              onDragLeave={() => setDrop((d) => (d?.id === p.id ? undefined : d))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && drop) {
                  const ids = order.map((o) => o.id).filter((i) => i !== dragging);
                  const at = ids.indexOf(drop.id) + (drop.side === "after" ? 1 : 0);
                  move(dragging, at);
                }
                setDragging(undefined);
                setDrop(undefined);
              }}
            >
              <span
                className="kx-engine-grip"
                role="button"
                tabIndex={0}
                aria-label={`Move ${p.label} (arrow keys)`}
                title="Drag to reorder, or use the arrow keys"
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" && index > 0) (e.preventDefault(), move(p.id, index - 1));
                  if (e.key === "ArrowDown" && index < order.length - 1) (e.preventDefault(), move(p.id, index + 1));
                }}
              >
                <Icon name="grip" size={12} />
              </span>
              <div className="kx-engine-text">
                <span>
                  {turnedOn && position >= 0 && <span className="kx-engine-rank">{position + 1}.</span>}
                  {p.label}
                </span>
                <small>{detail}</small>
                <span className="kx-engine-filters" aria-label={`What ${p.label} can do`}>
                  {ENGINE_FILTERS.map((k) => (
                    <span key={k} className="kx-engine-filter" data-on={(p.filters ?? []).includes(k)} title={(p.filters ?? []).includes(k) ? `Filters by ${FILTER_NAME[k]}` : `Cannot filter by ${FILTER_NAME[k]}: passed over when you do`}>
                      {FILTER_NAME[k]}
                    </span>
                  ))}
                  <span className="kx-engine-filter" data-on={engine.scholarly} title={engine.scholarly ? "Can keep to scholarly sources" : "Cannot keep to scholarly sources"}>
                    scholarly
                  </span>
                  {engine.reader && (
                    <span className="kx-engine-filter" data-on title="Can read a page for saving, when Key cannot open it">
                      saves pages
                    </span>
                  )}
                  <span className="kx-engine-filter" title="Most results per search">
                    up to {engine.maxResults}
                  </span>
                </span>
              </div>
              <div className="kx-engine-controls">
                {engine.service && (
                  <button type="button" className="kx-engine-link" title={`Prices and the free allowance on ${p.label}’s site`} onClick={() => void invoke("services_open_pricing", { id: engine.service })}>
                    Pricing
                  </button>
                )}
                <input
                  type="checkbox"
                  className="kx-switch"
                  aria-label={`Search with ${p.label}`}
                  disabled={!isReady}
                  checked={turnedOn}
                  onChange={(e) => onChange(p.id, { enabled: e.target.checked })}
                />
              </div>
            </div>
            {engine.needsBaseUrl && (
              <Row label={`${p.label} address`} detail="Your own instance, with JSON output turned on. On this Mac (localhost) or an https:// address.">
                <input
                  className="kx-settings-select kx-engine-url"
                  type="url"
                  spellCheck={false}
                  placeholder="https://search.example.org"
                  aria-label={`${p.label} address`}
                  defaultValue={engine.baseUrl ?? ""}
                  onBlur={(e) => {
                    const value = e.target.value.trim().replace(/\/+$/, "");
                    if (value !== (engine.baseUrl ?? "")) onChange(p.id, { baseUrl: value });
                  }}
                />
              </Row>
            )}
          </Fragment>
        );
      })}
      <Row label="When an engine fails or runs out" detail={engines.fallback === "stop" ? "The search stops and says why." : "The next engine that is on is asked instead."}>
        <select className="kx-settings-select" aria-label="When an engine fails or runs out" value={engines.fallback} onChange={(e) => setEngines({ fallback: e.target.value === "stop" ? "stop" : "next" })}>
          <option value="next">Try the next engine</option>
          <option value="stop">Stop and say why</option>
        </select>
      </Row>
      <Row label="Scholarly sources only" detail="Where an engine can (Firecrawl, Exa, SearXNG), it keeps to papers and research pages.">
        <input type="checkbox" className="kx-switch" aria-label="Scholarly sources only" checked={engines.scholarly} onChange={(e) => setEngines({ scholarly: e.target.checked })} />
      </Row>
    </Group>
  );
}
