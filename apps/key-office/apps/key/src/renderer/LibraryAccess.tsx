// Settings › Library access: the library proxies the in-app browser sends sites through
// (EZproxy, OpenAthens, a library's link prefix), how it uses them, and Zotero's to import.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Group, Row } from "./Settings";
import { Icon } from "./icons";
import "./library-access.css";

type Kind = "ezproxy" | "openathens" | "redirect" | "custom";
type Source = "manual" | "detected" | "zotero" | "connector";
export interface LibraryProxy {
  id: string;
  name: string;
  kind: Kind;
  scheme: string;
  properScheme?: string;
  hosts: string[];
  autoAssociate: boolean;
  dotsToHyphens: boolean;
  enabled: boolean;
  source: Source;
}
interface ProxyPrefs {
  transparent: boolean;
  autoRecognize: boolean;
  excluded: string[];
  followZotero: boolean;
}
interface ProxyData {
  prefs: ProxyPrefs;
  proxies: LibraryProxy[];
}
interface ImportReport {
  found: { label: string; count: number }[];
  added: number;
  updated: number;
  data: ProxyData;
}
const api = () => (window as unknown as { key: { proxies?(action: string, payload?: unknown): Promise<any>; on(event: string, cb: (v: unknown) => void): () => void } }).key;

const SOURCE_LABEL: Record<Source, string> = { manual: "Added by you", detected: "Recognised", zotero: "From Zotero", connector: "From Zotero Connector" };
const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "");

type Preset = "ezproxy-login" | "ezproxy-host" | "openathens" | "prefix";
const PRESETS: { id: Preset; label: string; hint: string; placeholder: string }[] = [
  { id: "ezproxy-login", label: "EZproxy login", hint: "Your library’s EZproxy server, as in login.ezproxy.uni.edu. Sites go through its login page, then load as www-site-com.ezproxy.uni.edu.", placeholder: "login.ezproxy.uni.edu" },
  { id: "ezproxy-host", label: "EZproxy host", hint: "The part after the site in a proxied address, as in ezproxy.uni.edu for www-jstor-org.ezproxy.uni.edu.", placeholder: "ezproxy.uni.edu" },
  { id: "openathens", label: "OpenAthens", hint: "Your institution’s OpenAthens domain, as in uni.ac.uk. Sites go through go.openathens.net and you sign in once.", placeholder: "uni.ac.uk" },
  { id: "prefix", label: "Link prefix", hint: "Any address with {url} where the page’s link goes, such as a link resolver or LibKey: https://resolver.uni.edu/?url={url}", placeholder: "https://resolver.uni.edu/?url={url}" },
];
const bareHost = (value: string) => value.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
function fromPreset(preset: Preset, value: string): Partial<LibraryProxy> {
  const host = bareHost(value);
  if (preset === "ezproxy-login") return { kind: "ezproxy", scheme: `https://${host}/login?qurl=%u`, properScheme: `https://%h.${host.replace(/^login\./, "")}/%p`, dotsToHyphens: true, name: host.replace(/^login\./, "") };
  if (preset === "ezproxy-host") return { kind: "ezproxy", scheme: `https://%h.${host}/%p`, properScheme: undefined, dotsToHyphens: true, name: host };
  if (preset === "openathens") return { kind: "openathens", scheme: `https://go.openathens.net/redirector/${host}?url=%u`, properScheme: undefined, dotsToHyphens: false, name: `OpenAthens (${host})` };
  const prefix = value.trim();
  let name = "";
  try {
    name = new URL(prefix.replace(/\{url\}|%u/gi, "x")).hostname;
  } catch {
    /* not yet an address */
  }
  return { kind: "redirect", scheme: prefix.includes("{url}") || prefix.includes("%u") ? prefix : prefix ? `${prefix}%u` : "", properScheme: undefined, dotsToHyphens: false, name };
}
const presetOf = (p: LibraryProxy): Preset => (p.kind === "openathens" ? "openathens" : p.kind === "ezproxy" ? (p.scheme.includes("%u") ? "ezproxy-login" : "ezproxy-host") : "prefix");

export default function LibraryAccess() {
  const [data, setData] = useState<ProxyData>();
  const [editing, setEditing] = useState<LibraryProxy | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const bridge = api();
  const reload = () => void bridge.proxies?.("get").then(setData, (e) => setError(message(e)));
  useEffect(() => {
    reload();
    return bridge.on("proxies-changed", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!bridge.proxies) return null;
  const call = async (action: string, payload?: unknown) => {
    setError("");
    try {
      setData(await bridge.proxies!(action, payload));
    } catch (e) {
      setError(message(e));
      throw e;
    }
  };
  const importNow = async () => {
    setImporting(true);
    setReport("");
    setError("");
    try {
      const done: ImportReport = await bridge.proxies!("import", {});
      setData(done.data);
      const total = done.found.reduce((n, f) => n + f.count, 0);
      setReport(
        !total
          ? "No proxies found in Zotero or the Zotero Connector on this Mac."
          : `Found ${total === 1 ? "1 proxy" : `${total} proxies`} (${done.found.map((f) => f.label).join(", ")}): ${done.added} added, ${done.updated} updated.`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setImporting(false);
    }
  };
  const prefs = data?.prefs;
  const proxies = data?.proxies ?? [];
  return (
    <>
      <Group title="Library access" footer={error || report || "Articles open with your library’s access; saved sources keep their own address."}>
        <Row label="Use library proxies automatically" detail="A proxy’s sites always go through it.">
          <input type="checkbox" className="kx-switch" aria-label="Use library proxies automatically" disabled={!prefs} checked={!!prefs?.transparent} onChange={(e) => void call("prefs", { transparent: e.target.checked })} />
        </Row>
        <Row label="Recognise proxies while browsing" detail="Offers to remember EZproxy and OpenAthens sign-ins.">
          <input type="checkbox" className="kx-switch" aria-label="Recognise proxies while browsing" disabled={!prefs} checked={!!prefs?.autoRecognize} onChange={(e) => void call("prefs", { autoRecognize: e.target.checked })} />
        </Row>
        <Row label="Proxies from Zotero" detail="From Zotero and its browser connectors.">
          <button className="kx-settings-button" disabled={importing} onClick={() => void importNow()}>
            {importing ? "Importing…" : "Import from Zotero"}
          </button>
        </Row>
      </Group>
      <Group title="Library proxies">
        {proxies.map((proxy) => (
          <div className="kx-settings-row kx-proxy-row" key={proxy.id} data-enabled={proxy.enabled || undefined}>
            <span className="kx-proxy-glyph" aria-hidden>
              <Icon name="institution" size={14} />
            </span>
            <div>
              <span>
                {proxy.name}
                <em className="kx-proxy-badge">{SOURCE_LABEL[proxy.source]}</em>
              </span>
              <small title={proxy.scheme}>
                {proxy.hosts.length ? `${proxy.hosts.length === 1 ? "1 site" : `${proxy.hosts.length} sites`} · ${proxy.hosts.slice(0, 3).join(", ")}${proxy.hosts.length > 3 ? "…" : ""}` : "No sites yet"}
              </small>
            </div>
            <div className="kx-settings-control">
              <button className="kx-settings-button" onClick={() => setEditing(proxy)}>
                Edit…
              </button>
              <input type="checkbox" className="kx-switch" aria-label={`Use ${proxy.name}`} checked={proxy.enabled} onChange={(e) => void call("save", { ...proxy, enabled: e.target.checked })} />
            </div>
          </div>
        ))}
        <div className="kx-settings-row kx-proxy-add">
          <div>
            <span>{proxies.length ? "Another proxy" : "No library proxies yet"}</span>
            <small>EZproxy, OpenAthens or a link prefix</small>
          </div>
          <div className="kx-settings-control">
            <button className="kx-settings-button" onClick={() => setEditing("new")}>
              Add proxy…
            </button>
          </div>
        </div>
      </Group>
      {!!prefs?.excluded.length && (
        <Group title="Never through a proxy" footer="Sites you chose “Don’t proxy this site” for.">
          <div className="kx-settings-row kx-settings-row-wide">
            <Chips values={prefs.excluded} onChange={(excluded) => void call("prefs", { excluded })} label="Sites never proxied" />
          </div>
        </Group>
      )}
      {editing && (
        <ProxySheet
          proxy={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (proxy) => {
            await call("save", proxy);
            setEditing(null);
          }}
          onRemove={async (id) => {
            await call("remove", id);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** Host names as removable chips, with a field to add more (Return or comma). */
function Chips({ values, onChange, label, placeholder }: { values: string[]; onChange: (values: string[]) => void; label: string; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const hosts = draft
      .split(/[\s,]+/)
      .map(bareHost)
      .filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !values.includes(h));
    if (hosts.length) onChange([...values, ...hosts]);
    setDraft("");
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
  };
  return (
    <div className="kx-proxy-chips" role="list" aria-label={label}>
      {values.map((host) => (
        <span className="kx-proxy-chip" role="listitem" key={host}>
          {host}
          <button type="button" aria-label={`Remove ${host}`} onClick={() => onChange(values.filter((h) => h !== host))}>
            <Icon name="close" size={8} />
          </button>
        </span>
      ))}
      {placeholder !== undefined && <input value={draft} placeholder={values.length ? "" : placeholder} aria-label={`Add to ${label}`} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} onBlur={add} />}
    </div>
  );
}

/** A sheet over Settings for adding or editing one proxy. */
function ProxySheet({ proxy, onClose, onSave, onRemove }: { proxy?: LibraryProxy; onClose: () => void; onSave: (proxy: Partial<LibraryProxy>) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [preset, setPreset] = useState<Preset>(proxy ? presetOf(proxy) : "ezproxy-login");
  const [address, setAddress] = useState("");
  const [draft, setDraft] = useState<Partial<LibraryProxy>>(proxy ?? { name: "", scheme: "", hosts: [], autoAssociate: true, dotsToHyphens: true, enabled: true, kind: "ezproxy" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (address) setDraft((d) => ({ ...d, ...fromPreset(next, address) }));
  };
  const typeAddress = (value: string) => {
    setAddress(value);
    const filled = fromPreset(preset, value);
    setDraft((d) => ({ ...d, ...filled, name: proxy || (d.name && d.name !== fromPreset(preset, address).name) ? d.name : filled.name }));
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const current = PRESETS.find((p) => p.id === preset)!;
  return (
    <div className="kx-proxy-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kx-proxy-sheet" role="dialog" aria-modal="true" aria-label={proxy ? `Edit ${proxy.name}` : "Add a library proxy"}>
        <header>
          <h2>{proxy ? "Edit library proxy" : "Add a library proxy"}</h2>
          <p>{proxy ? SOURCE_LABEL[proxy.source] : "How your library gives access to journals and databases."}</p>
        </header>
        <div className="kx-proxy-sheet-body">
          <div className="kx-proxy-presets" role="radiogroup" aria-label="Kind of proxy">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} onClick={() => choosePreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="kx-proxy-fields">
            <label>
              <span>{preset === "prefix" ? "Prefix" : preset === "openathens" ? "Domain" : "Server"}</span>
              <input ref={first} value={address} placeholder={proxy ? "Fill in from a new address" : current.placeholder} spellCheck={false} onChange={(e) => typeAddress(e.target.value)} />
            </label>
            <small className="kx-proxy-hint">{current.hint}</small>
            <label>
              <span>Name</span>
              <input value={draft.name ?? ""} placeholder="My library" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              <span>Sends through</span>
              <input value={draft.scheme ?? ""} placeholder="https://login.ezproxy.uni.edu/login?qurl=%u" spellCheck={false} onChange={(e) => setDraft({ ...draft, scheme: e.target.value })} />
            </label>
            {(draft.kind === "ezproxy" || draft.properScheme) && (
              <label>
                <span>Pages look like</span>
                <input value={draft.properScheme ?? ""} placeholder="https://%h.ezproxy.uni.edu/%p" spellCheck={false} onChange={(e) => setDraft({ ...draft, properScheme: e.target.value || undefined })} />
              </label>
            )}
            <small className="kx-proxy-hint">%h is the site, %p the page, %u the whole link ({"{url}"} works too).</small>
          </div>
          <h3>Sites</h3>
          <div className="kx-proxy-group">
            <Chips values={draft.hosts ?? []} onChange={(hosts) => setDraft({ ...draft, hosts })} label="Sites" placeholder="www.jstor.org, www.nature.com" />
          </div>
          <div className="kx-proxy-group">
            <label className="kx-proxy-toggle">
              <span>
                Add sites visited through it
                <small>A site you open through this proxy joins the list.</small>
              </span>
              <input type="checkbox" className="kx-switch" checked={draft.autoAssociate !== false} onChange={(e) => setDraft({ ...draft, autoAssociate: e.target.checked })} />
            </label>
            {draft.kind === "ezproxy" && (
              <label className="kx-proxy-toggle">
                <span>
                  Hyphens for dots
                  <small>Addresses like www-jstor-org.ezproxy.uni.edu (most secure proxies).</small>
                </span>
                <input type="checkbox" className="kx-switch" checked={!!draft.dotsToHyphens} onChange={(e) => setDraft({ ...draft, dotsToHyphens: e.target.checked })} />
              </label>
            )}
            <label className="kx-proxy-toggle">
              <span>Use this proxy</span>
              <input type="checkbox" className="kx-switch" checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            </label>
          </div>
          {error && <p className="kx-inline-error">{error}</p>}
        </div>
        <footer>
          {proxy && (
            <button type="button" className="kx-settings-button kx-proxy-remove" onClick={() => (confirmRemove ? void onRemove(proxy.id) : setConfirmRemove(true))}>
              {confirmRemove ? "Remove proxy" : "Remove…"}
            </button>
          )}
          <span className="kx-proxy-spacer" />
          <button type="button" className="kx-settings-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="kx-settings-button kx-proxy-primary" disabled={busy || !draft.scheme} onClick={() => void save()}>
            {proxy ? "Save" : "Add proxy"}
          </button>
        </footer>
      </div>
    </div>
  );
}
