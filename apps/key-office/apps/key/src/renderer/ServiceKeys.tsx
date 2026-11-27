// Settings → Services & API keys: a key for each scholarly service that takes one (the list
// comes from main/services/registry.ts), how it is used and how often. The page never sees a
// key: main answers whether one is set and its last four characters.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { Group, Row } from "./Settings";
import { Explain, Hint } from "./explain";
import { HELP, type ExplainId } from "./help-content";
import "./service-keys.css";

type Mode = "fallback" | "always";
interface Usage {
  today: number;
  thisMonth: number;
  total: number;
  lastUsedAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  remaining?: number;
  remainingLabel?: string;
  remainingAt?: number;
  validity?: "valid" | "invalid";
}
interface Service {
  id: string;
  name: string;
  via?: string;
  summary: string;
  usedFor: string;
  keyUrlLabel: string;
  keyRequired: boolean;
  /** A general web search engine; testing its key may use one search. */
  engine?: boolean;
  checkUsesQuota?: boolean;
  key: { set: boolean; hint?: string; updatedAt?: number };
  mode: Mode;
  usage: Usage;
}
interface Storage {
  backend: "keychain" | "local";
  reason: string;
  locked: boolean;
  error?: string;
}
interface Listing {
  storage: Storage;
  services: Service[];
}

const ago = (at?: number) => {
  if (!at) return "never";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

function storageLine(storage: Storage) {
  if (storage.backend === "keychain") return "Encrypted in your Keychain";
  const why =
    storage.reason === "unsigned"
      ? " (this copy of Key is not signed)"
      : storage.reason === "development"
        ? " (development build)"
        : storage.reason === "unavailable"
          ? " (Keychain unavailable)"
          : "";
  return `Encrypted in Key’s data folder${why}`;
}

export default function ServiceKeys({ invoke }: { invoke: Invoke }) {
  const [listing, setListing] = useState<Listing>();
  const load = useCallback(() => {
    void invoke<Listing>("services_list", {})
      .then(setListing)
      .catch(() => undefined);
  }, [invoke]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);
  if (!listing) return <p className="kx-settings-loading">Loading…</p>;
  const { storage } = listing;
  return (
    <>
      <div className="kx-settings-intro" data-help="settings.services.intro">
        <Hint help="settings.services.intro" />
        <Explain help="settings.services.api-key" label="What is an API key?" />
      </div>
      {listing.services.map((service) => (
        <ServiceGroup key={service.id} service={service} storage={storage} invoke={invoke} onChange={setListing} />
      ))}
      <Group title="Storage" footer="Keys are sent only to the service they belong to, and never reach a page or a log.">
        <Row label={storage.backend === "keychain" ? "Keychain" : "This Mac"} detail={storageLine(storage)}>
          <span className="kx-service-storage" data-backend={storage.backend}>
            <Icon name={storage.backend === "keychain" ? "lock" : "disk"} size={13} />
          </span>
        </Row>
        {storage.locked && (
          <Row
            label="Keys saved by another copy of Key"
            detail={storage.error ?? "Saved in the Keychain by a signed copy. macOS may ask once."}
          >
            <button className="kx-settings-button" onClick={() => void invoke<Listing>("services_unlock", {}).then(setListing)}>
              Unlock…
            </button>
            <button className="kx-settings-button" onClick={() => void invoke<Listing>("services_forget_locked", {}).then(setListing)}>
              Remove
            </button>
          </Row>
        )}
      </Group>
    </>
  );
}

/** The explainer for a service, when help-content has one (new services may not yet). */
const serviceHelp = (id: string) => (`settings.services.${id}` in HELP ? (`settings.services.${id}` as ExplainId) : undefined);

function ServiceGroup({ service, storage, invoke, onChange }: { service: Service; storage: Storage; invoke: Invoke; onChange: (listing: Listing) => void }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"test" | "save">();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const { key, usage } = service;
  const showField = !key.set || editing;
  const validity = result && !draft ? (result.ok ? "valid" : "invalid") : usage.validity;

  const test = async () => {
    setBusy("test");
    setResult(undefined);
    try {
      setResult(await invoke<{ ok: boolean; message: string }>("services_test", { id: service.id, key: draft || undefined }));
      if (!draft) onChange(await invoke<Listing>("services_list", {}));
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "The test did not finish" });
    } finally {
      setBusy(undefined);
    }
  };
  const save = async () => {
    if (!draft.trim()) return;
    setBusy("save");
    try {
      onChange(await invoke<Listing>("services_set_key", { id: service.id, key: draft }));
      setDraft("");
      setEditing(false);
      setResult(undefined);
      // Checked in the background; the row updates when the answer comes.
      setBusy("test");
      const answer = await invoke<{ ok: boolean; message: string }>("services_test", { id: service.id });
      setResult(answer);
      onChange(await invoke<Listing>("services_list", {}));
    } catch (error) {
      setResult({ ok: false, message: "The key could not be saved" });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Group title={service.via ? `${service.name} via ${service.via}` : service.name} help={serviceHelp(service.id)} footer={`Used for ${/^\S+ [a-z]/.test(service.usedFor) ? service.usedFor.charAt(0).toLowerCase() + service.usedFor.slice(1) : service.usedFor}.`}>
      <div className="kx-settings-row kx-service-head" data-service={service.id}>
        <span className="kx-service-glyph" data-state={key.set ? (validity === "invalid" ? "invalid" : "set") : undefined}>
          <Icon name="key" size={14} />
        </span>
        <div>
          <span>
            API key
            {service.via && <em className="kx-service-badge">Third party</em>}
          </span>
          <small>
            {key.set
              ? `${storage.locked ? "Locked in the Keychain" : storage.backend === "keychain" ? "In the Keychain" : "On this Mac"}${service.checkUsesQuota ? " · testing uses one search" : ""}`
              : service.keyRequired
                ? `Needed to use ${service.name} · from ${service.keyUrlLabel}${service.checkUsesQuota ? " · testing uses one search" : ""}`
                : `Optional · works without one · from ${service.keyUrlLabel}`}
          </small>
        </div>
        <span className="kx-service-status" data-state={!key.set ? "none" : validity ?? "set"} aria-label={`${service.name} key status`}>
          {!key.set ? (
            "No key"
          ) : (
            <>
              <code>••••{key.hint}</code>
              {validity === "valid" && <Icon name="check" size={11} />}
              {validity === "invalid" && "Invalid"}
            </>
          )}
        </span>
        {key.set && !editing && (
          <div className="kx-settings-control">
            <button className="kx-settings-button" disabled={!!busy} title={service.checkUsesQuota ? "Testing runs one small search, which uses a little of your allowance" : "Testing runs no search"} onClick={() => void test()}>
              {busy === "test" ? "Testing…" : "Test"}
            </button>
            <button className="kx-settings-button" onClick={() => setEditing(true)}>
              Replace…
            </button>
            <button
              className="kx-settings-button"
              aria-label={`Remove the ${service.name} key`}
              onClick={() =>
                void invoke<Listing>("services_remove", { id: service.id }).then((listing) => {
                  setResult(undefined);
                  onChange(listing);
                })
              }
            >
              Remove
            </button>
          </div>
        )}
      </div>
      {showField ? (
        <div className="kx-settings-row kx-service-edit">
          <input
            className="kx-settings-select kx-service-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${service.name} API key`}
            placeholder={`Paste your ${service.via ?? service.name} key`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setResult(undefined);
            }}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          <button className="kx-settings-button" disabled={!draft.trim() || !!busy} title={service.checkUsesQuota ? "Testing runs one small search, which uses a little of your allowance" : "Testing runs no search"} onClick={() => void test()}>
            {busy === "test" && draft ? "Testing…" : "Test"}
          </button>
          <button className="kx-settings-button kx-service-primary" disabled={!draft.trim() || !!busy} onClick={() => void save()}>
            Save
          </button>
          {editing && (
            <button
              className="kx-settings-button"
              onClick={() => {
                setEditing(false);
                setDraft("");
                setResult(undefined);
              }}
            >
              Cancel
            </button>
          )}
          <button className="kx-service-link" onClick={() => void invoke("services_open_key_page", { id: service.id })}>
            Get a key
            <Icon name="external" size={10} />
          </button>
        </div>
      ) : (
        <Row label="Use the key" detail={service.engine ? "When you search the web and this engine is on under Web search engines." : service.keyRequired ? "When other catalogues find nothing, or always if on under Web search." : service.mode === "always" ? "Every request to the service carries it." : "Only when a request without it is limited or refused, so your own allowance lasts."}>
          {!service.keyRequired && (
            <select
              className="kx-settings-select"
              aria-label={`When to use the ${service.name} key`}
              value={service.mode}
              onChange={(e) => void invoke<Listing>("services_set_mode", { id: service.id, mode: e.target.value }).then(onChange)}
            >
              <option value="fallback">Only when needed</option>
              <option value="always">Always</option>
            </select>
          )}
        </Row>
      )}
      {result && (
        <div className="kx-settings-row kx-service-result" data-ok={result.ok || undefined} role="status">
          <Icon name={result.ok ? "check" : "warning"} size={12} />
          <span>{result.message}</span>
        </div>
      )}
      {key.set && (
        <div className="kx-settings-row kx-service-usage" aria-label={`${service.name} key usage`}>
          <dl>
            <div>
              <dt>Today</dt>
              <dd>{usage.today.toLocaleString()}</dd>
            </div>
            <div>
              <dt>This month</dt>
              <dd>{usage.thisMonth.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Last used</dt>
              <dd>{ago(usage.lastUsedAt)}</dd>
            </div>
            {usage.remaining !== undefined && (
              <div>
                <dt>{usage.remainingLabel ? usage.remainingLabel.charAt(0).toUpperCase() + usage.remainingLabel.slice(1) : "Remaining"}</dt>
                <dd>{usage.remaining.toLocaleString()}</dd>
              </div>
            )}
          </dl>
          {usage.lastError && (
            <small className="kx-service-error">
              <Icon name="warning" size={11} />
              {usage.lastError} · {ago(usage.lastErrorAt)}
            </small>
          )}
        </div>
      )}
    </Group>
  );
}
