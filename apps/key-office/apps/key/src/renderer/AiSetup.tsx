// Key Settings › AI assistant: three steps. Choose a provider, connect it (paste a key, or
// for a model on this Mac check that it runs), and pick the default model. Keys live in the
// secret store in the main process (main/ai/service.ts); this page only sees whether one is
// set and its last four characters.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { Group, Row } from "./Settings";
import { Explain, Hint } from "./explain";
import "./ai-setup.css";

interface ModelInfo {
  id: string;
  label: string;
  summary: string;
  price?: [number, number];
  recommended?: boolean;
}
export interface AiProvider {
  id: string;
  name: string;
  summary: string;
  local?: boolean;
  editableUrl?: boolean;
  keyRequired: boolean;
  keyUrl?: string;
  keyUrlLabel?: string;
  keySteps?: string[];
  baseUrl: string;
  defaultBaseUrl: string;
  model: string;
  models: ModelInfo[];
  key: { set: boolean; hint?: string };
}
export interface AiListing {
  current: string | null;
  status: { configured: boolean; provider?: string; providerName?: string; model?: string; local?: boolean; reason?: string };
  storage?: { backend: string; locked: boolean };
  providers: AiProvider[];
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^Error: /, "");

const cost = (price?: [number, number]) => {
  if (!price) return "";
  if (price[0] === 0 && price[1] === 0) return "Free";
  // A typical fill request: about 2,000 tokens in, 100 out.
  const per = (2000 * price[0] + 100 * price[1]) / 1_000_000;
  return per < 0.001 ? "Under $0.10 per 100 sources" : `About $${(per * 100).toFixed(per * 100 < 1 ? 2 : 1)} per 100 sources`;
};

export default function AiSetup({ invoke }: { invoke: Invoke }) {
  const [listing, setListing] = useState<AiListing>();
  const load = useCallback(() => void invoke<AiListing>("ai_providers", {}).then(setListing).catch(() => undefined), [invoke]);
  useEffect(load, [load]);
  if (!listing) return <p className="kx-settings-loading">Loading…</p>;
  const provider = listing.providers.find((p) => p.id === listing.current);
  const connected = !!provider && (!provider.keyRequired || provider.key.set) && !!provider.baseUrl;
  return (
    <>
      <div className="kx-settings-intro">
        <Hint help="settings.ai.intro" />
        <Explain help="settings.ai.provider" label="What is sent?" />
      </div>
      <Group title="1. Choose a provider" help="settings.ai.choose">
        <div className="kx-ai-providers" role="radiogroup" aria-label="AI provider">
          {listing.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === listing.current}
              className="kx-ai-provider"
              data-provider={p.id}
              onClick={() => void invoke<AiListing>("ai_choose", { provider: p.id }).then(setListing)}
            >
              <span className="kx-ai-provider-icon" data-local={p.local || undefined}>
                <Icon name={p.local ? "chip" : p.id === "custom" ? "link" : "sparkle"} size={14} />
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>{p.summary}</small>
              </span>
              {p.key.set && <Icon name="key" size={11} className="kx-ai-provider-key" />}
            </button>
          ))}
        </div>
      </Group>
      {provider && <Connect key={provider.id} provider={provider} invoke={invoke} onChange={setListing} />}
      {provider && connected && <Models key={`m-${provider.id}`} provider={provider} invoke={invoke} onChange={setListing} />}
      <Group title="Status">
        <Row
          label={listing.status.configured ? `${listing.status.providerName} · ${listing.status.model}` : "Not set up yet"}
          detail={listing.status.configured ? (listing.status.local ? "Ready. Runs on this Mac: nothing leaves it." : "Ready. Used only when you start an AI task.") : listing.status.reason}
        >
          {listing.status.configured && (
            <span className="kx-settings-ok" data-ai-ready>
              <Icon name="check" size={12} /> Ready
            </span>
          )}
        </Row>
      </Group>
      <Group title="What leaves this Mac" help="settings.ai.privacy">
        <Row label="Nothing, until you ask" detail="Key never sends your library in the background. A fill run or a drafted formula is something you start." />
        <Row label="Only what a task needs" detail="A fill recipe sends the parts you chose (metadata, abstract, sections, notes or highlights) for each source, and shows you which before it runs." />
        <Row label="To the provider you chose" detail={provider?.local ? `${provider.name} runs on this Mac, so the text stays here.` : provider ? `${provider.name} receives it under its own terms. Your key is sent only to it.` : "Choose a provider above."} />
      </Group>
    </>
  );
}

function Connect({ provider, invoke, onChange }: { provider: AiProvider; invoke: Invoke; onChange: (l: AiListing) => void }) {
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState(provider.baseUrl);
  const [busy, setBusy] = useState<"test" | "save">();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const test = async (key?: string) => {
    setBusy("test");
    setResult(undefined);
    try {
      setResult(await invoke<{ ok: boolean; message: string }>("ai_test", { provider: provider.id, key }));
    } catch (error) {
      setResult({ ok: false, message: errorText(error) });
    } finally {
      setBusy(undefined);
    }
  };
  const saveKey = async () => {
    if (!draft.trim()) return;
    setBusy("save");
    try {
      onChange(await invoke<AiListing>("ai_set_key", { provider: provider.id, key: draft }));
      setDraft("");
      await test();
    } catch (error) {
      setResult({ ok: false, message: errorText(error) });
      setBusy(undefined);
    }
  };
  const saveUrl = async () => {
    try {
      onChange(await invoke<AiListing>("ai_set_base_url", { provider: provider.id, baseUrl: url }));
      await test();
    } catch (error) {
      setResult({ ok: false, message: errorText(error) });
    }
  };
  const needsKey = provider.keyRequired || provider.id === "custom";
  return (
    <Group title={provider.local ? "2. Start it on this Mac" : "2. Connect your account"} help={provider.local ? "settings.ai.local" : "settings.ai.key"}>
      {provider.keySteps && (
        <ol className="kx-ai-steps">
          {provider.keySteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {provider.editableUrl && (
        <div className="kx-settings-row kx-service-edit">
          <input
            className="kx-settings-select kx-service-input"
            aria-label="Server address"
            spellCheck={false}
            placeholder={provider.defaultBaseUrl || "https://api.example.com/v1"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveUrl()}
          />
          <button className="kx-settings-button kx-service-primary" disabled={!url.trim() || !!busy} onClick={() => void saveUrl()}>
            {provider.local ? "Check" : "Save address"}
          </button>
        </div>
      )}
      {needsKey && (
        <div className="kx-settings-row kx-service-head" data-service={`ai-${provider.id}`}>
          <span className="kx-service-glyph" data-state={provider.key.set ? "set" : undefined}>
            <Icon name="key" size={14} />
          </span>
          <div>
            <span>API key</span>
            <small>{provider.key.set ? "Saved on this Mac" : provider.keyRequired ? `Needed · from ${provider.keyUrlLabel}` : "Optional for most local servers"}</small>
          </div>
          <span className="kx-service-status" data-state={provider.key.set ? (result?.ok ? "valid" : result ? "invalid" : "set") : "none"}>
            {provider.key.set ? <code>••••{provider.key.hint}</code> : "No key"}
          </span>
          {provider.key.set && (
            <div className="kx-settings-control">
              <button className="kx-settings-button" disabled={!!busy} onClick={() => void test()}>
                {busy === "test" ? "Testing…" : "Test"}
              </button>
              <button className="kx-settings-button" onClick={() => void invoke<AiListing>("ai_remove_key", { provider: provider.id }).then(onChange)}>
                Remove
              </button>
            </div>
          )}
        </div>
      )}
      {needsKey && !provider.key.set && (
        <div className="kx-settings-row kx-service-edit">
          <input
            className="kx-settings-select kx-service-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${provider.name} API key`}
            placeholder={`Paste your ${provider.name} key`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setResult(undefined);
            }}
            onKeyDown={(e) => e.key === "Enter" && void saveKey()}
          />
          <button className="kx-settings-button" disabled={!draft.trim() || !!busy} onClick={() => void test(draft)}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          <button className="kx-settings-button kx-service-primary" disabled={!draft.trim() || !!busy} onClick={() => void saveKey()}>
            Save
          </button>
          {provider.keyUrl && (
            <button className="kx-service-link" onClick={() => void invoke("ai_open_key_page", { provider: provider.id })}>
              Get a key
              <Icon name="external" size={10} />
            </button>
          )}
        </div>
      )}
      {provider.local && !needsKey && (
        <Row label={provider.name} detail="No key needed: it runs on this Mac.">
          <button className="kx-settings-button" disabled={!!busy} onClick={() => void test()}>
            {busy === "test" ? "Checking…" : "Test"}
          </button>
          {provider.keyUrl && (
            <button className="kx-service-link" onClick={() => void invoke("ai_open_key_page", { provider: provider.id })}>
              Get {provider.name.split(" ")[0]}
              <Icon name="external" size={10} />
            </button>
          )}
        </Row>
      )}
      {result && (
        <div className="kx-settings-row kx-service-result" data-ok={result.ok || undefined} role="status" data-ai-test>
          <Icon name={result.ok ? "check" : "warning"} size={12} />
          <span>{result.message}</span>
        </div>
      )}
    </Group>
  );
}

function Models({ provider, invoke, onChange }: { provider: AiProvider; invoke: Invoke; onChange: (l: AiListing) => void }) {
  const [live, setLive] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [other, setOther] = useState("");
  useEffect(() => {
    void invoke<{ live: string[]; error?: string }>("ai_models", { provider: provider.id })
      .then((r) => {
        setLive(r.live ?? []);
        setError(r.error ?? "");
      })
      .catch((e) => setError(errorText(e)));
  }, [invoke, provider.id]);
  const choose = (model: string) => void invoke<AiListing>("ai_set_model", { provider: provider.id, model }).then(onChange);
  const suggested = provider.models.filter((m) => !live.length || live.includes(m.id) || !provider.local);
  const extra = live.filter((id) => !provider.models.some((m) => m.id === id));
  return (
    <Group title="3. Pick a default model" help="settings.ai.model" footer="Costs are rough estimates for a typical fill request; your provider's bill is what counts.">
      <div className="kx-ai-models" role="radiogroup" aria-label="Default model">
        {suggested.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={provider.model === m.id} className="kx-ai-model" data-model={m.id} onClick={() => choose(m.id)}>
            <span className="kx-ai-radio" aria-hidden="true" />
            <span>
              <strong>
                {m.label}
                {m.recommended && <em className="kx-service-badge">Recommended</em>}
              </strong>
              <small>{m.summary}</small>
            </span>
            <small className="kx-ai-cost">{cost(m.price)}</small>
          </button>
        ))}
        {(extra.length > 0 || !suggested.some((m) => m.id === provider.model)) && (
          <div className="kx-ai-model" data-other>
            <span className="kx-ai-radio" aria-hidden="true" data-on={!suggested.some((m) => m.id === provider.model) || undefined} />
            <span>
              <strong>{extra.length ? "Another model" : "Model"}</strong>
              <small>{extra.length ? `${extra.length} more offered by ${provider.name}` : "Type the model's name as the provider lists it"}</small>
            </span>
            {extra.length ? (
              <select className="kx-settings-select" aria-label="Another model" value={extra.includes(provider.model) ? provider.model : ""} onChange={(e) => e.target.value && choose(e.target.value)}>
                <option value="">Choose…</option>
                {extra.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            ) : (
              <input
                className="kx-settings-select"
                aria-label="Model name"
                placeholder={provider.model || "model-name"}
                value={other}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && other.trim() && choose(other.trim())}
                onBlur={() => other.trim() && choose(other.trim())}
              />
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="kx-settings-row kx-service-result" role="status">
          <Icon name="warning" size={12} />
          <span>{error}</span>
        </div>
      )}
    </Group>
  );
}
