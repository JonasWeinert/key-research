// What the Inbox follows, and how: add a feed by its address (or a page's, whose feed is
// found), change how often each is checked, pause, remove; OPML in and out; how long items
// are kept. Shown as a sheet from the Inbox and as Workspace Settings › Feeds & alerts.
import { useCallback, useEffect, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { FEED_KIND_ICON, INTERVALS, KIND_LABEL, feedsChanged, intervalLabel, onFeedsChanged, type Subscription } from "./feeds-ui";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { bridge, relativeDate, type Invoke } from "./library-api";
import "./inbox.css";

interface Retention {
  unreadDays: number;
  readDays: number;
  dismissedDays: number;
}
const message = (e: unknown) => String(e).replace(/^Error: /, "").replace(/^Error invoking remote method '[^']+': /, "").replace(/^Error: /, "");

function ago(at?: number | null) {
  if (!at) return "not checked yet";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  if (minutes < 24 * 60) return `checked ${Math.round(minutes / 60)} h ago`;
  return `checked ${relativeDate(at).toLowerCase()}`;
}

export function FeedsManager({ invoke, workspaceId }: { invoke: Invoke; workspaceId: string }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>();
  const [address, setAddress] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [retention, setRetention] = useState<Retention>();
  const load = useCallback(
    () =>
      void Promise.all([invoke<Subscription[]>("feeds_subscriptions", {}, workspaceId), invoke<Retention>("feeds_retention", {}, workspaceId)])
        .then(([s, r]) => {
          setSubscriptions(s);
          setRetention(r);
        })
        .catch((e) => setError(message(e))),
    [invoke, workspaceId],
  );
  useEffect(load, [load]);
  useEffect(() => onFeedsChanged(load), [load]);

  const add = () => {
    if (!address.trim()) return;
    setAdding(true);
    setError("");
    void invoke<{ subscription: Subscription; added: number; existed: boolean }>("feeds_subscribe", { kind: "rss", config: { url: address.trim() } }, workspaceId)
      .then((out) => {
        setAddress("");
        feedsChanged();
        toast(out.existed ? `Already following ${out.subscription.title}` : `Following ${out.subscription.title}${out.added ? `: ${out.added} items` : ""}`);
      })
      .catch((e) => setError(message(e)))
      .finally(() => setAdding(false));
  };
  const update = (s: Subscription, patch: Partial<Pick<Subscription, "intervalMinutes" | "paused" | "title">>) =>
    void invoke("feeds_update", { id: s.id, ...patch }, workspaceId)
      .then(() => feedsChanged())
      .catch((e) => setError(message(e)));
  const remove = (s: Subscription) =>
    void invoke("feeds_unsubscribe", { id: s.id }, workspaceId)
      .then(() => {
        feedsChanged();
        toast(`Stopped following ${s.title}`);
      })
      .catch((e) => setError(message(e)));
  const importOpml = async () => {
    const path = await bridge().choosePath({ mode: "open", title: "Import feeds from OPML", extensions: ["opml", "xml"] });
    if (!path) return;
    try {
      const out = await invoke<{ added: number; existing: number }>("feeds_opml_import", { path }, workspaceId);
      feedsChanged();
      toast(`Imported ${out.added} ${out.added === 1 ? "feed" : "feeds"}${out.existing ? `; ${out.existing} already followed` : ""}`);
    } catch (e) {
      setError(message(e));
    }
  };
  const exportOpml = async () => {
    const path = await bridge().choosePath({ mode: "save", title: "Export feeds as OPML", defaultPath: "Key feeds.opml", extensions: ["opml"] });
    if (!path) return;
    try {
      const out = await invoke<{ count: number }>("feeds_opml_export", { path }, workspaceId);
      toast(`Exported ${out.count} ${out.count === 1 ? "feed" : "feeds"}`);
    } catch (e) {
      setError(message(e));
    }
  };
  const keep = (patch: Partial<Retention>) => {
    if (!retention) return;
    const next = { ...retention, ...patch };
    setRetention(next);
    void invoke("feeds_retention", { set: next }, workspaceId).catch((e) => setError(message(e)));
  };

  return (
    <div className="kx-feeds-manager">
      <section className="kx-settings-group">
        <h3>Add a feed</h3>
        <div className="kx-settings-rows">
          <div className="kx-settings-row kx-feeds-add">
            <div>
              <span>Address</span>
              <small>A feed, or the page that links to one</small>
            </div>
            <form
              className="kx-settings-control kx-feeds-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <input className="kx-feeds-input" value={address} placeholder="https://journal.example.org/rss" aria-label="Feed or page address" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
              <button type="submit" className="kx-settings-button" disabled={adding || !address.trim()}>
                {adding ? "Finding…" : "Follow"}
              </button>
            </form>
          </div>
        </div>
        {error && <p className="kx-inline-error">{error}</p>}
        <p className="kx-settings-footnote">A journal’s table of contents, an arXiv listing or a blog. Authors, journals and topics are followed from their pages; “Alert me” on a web search, a source or a collection follows new results and citations.</p>
      </section>
      <section className="kx-settings-group">
        <h3>Following</h3>
        <div className="kx-settings-rows kx-feeds-list" aria-label="Feeds and alerts">
          {subscriptions && !subscriptions.length && <p className="kx-feeds-none">Nothing yet.</p>}
          {subscriptions?.map((s) => (
            <div key={s.id} className="kx-settings-row kx-feeds-row" data-paused={s.paused || undefined} data-failing={s.failures > 0 || undefined}>
              <span className="kx-feeds-kind" title={KIND_LABEL[s.kind]}>
                <Icon name={FEED_KIND_ICON[s.kind]} size={13} />
              </span>
              <div>
                <span className="kx-feeds-title">{s.title}</span>
                <small>
                  {[KIND_LABEL[s.kind], s.paused ? "Paused" : ago(s.checkedAt), s.unread ? `${s.unread} unread` : ""].filter(Boolean).join(" · ")}
                  {s.failures > 0 && s.lastError && <span className="kx-feeds-error"> · {s.lastError}</span>}
                </small>
              </div>
              <div className="kx-settings-control">
                <select className="kx-settings-select" aria-label={`How often to check ${s.title}`} value={s.intervalMinutes} onChange={(e) => update(s, { intervalMinutes: Number(e.target.value) })}>
                  {[...new Set([...INTERVALS, s.intervalMinutes])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>
                      {intervalLabel(m)}
                    </option>
                  ))}
                </select>
                <button className="kx-settings-button" onClick={() => update(s, { paused: !s.paused })}>
                  {s.paused ? "Resume" : "Pause"}
                </button>
                <button className="kx-feeds-remove" aria-label={`Stop following ${s.title}`} title="Stop following" onClick={() => remove(s)}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="kx-feeds-opml">
          <button className="kx-settings-button" onClick={() => void importOpml()}>
            <Icon name="download" size={12} /> Import OPML…
          </button>
          <button className="kx-settings-button" disabled={!subscriptions?.length} onClick={() => void exportOpml()}>
            <Icon name="upload" size={12} /> Export OPML…
          </button>
        </div>
      </section>
      {retention && (
        <section className="kx-settings-group">
          <h3>Keeping items</h3>
          <div className="kx-settings-rows">
            {(
              [
                ["unreadDays", "Unread items", "Removed after this long unread"],
                ["readDays", "Read items", "Saved and added items always stay"],
                ["dismissedDays", "Dismissed items", "They never come back from the same feed"],
              ] as const
            ).map(([key, label, detail]) => (
              <div key={key} className="kx-settings-row">
                <div>
                  <span>{label}</span>
                  <small>{detail}</small>
                </div>
                <div className="kx-settings-control">
                  <select className="kx-settings-select" aria-label={label} value={retention[key]} onChange={(e) => keep({ [key]: Number(e.target.value) })}>
                    {[...new Set([1, 7, 30, 90, 365, 0, retention[key]])].map((d) => (
                      <option key={d} value={d}>
                        {d === 0 ? "Keep" : d === 1 ? "1 day" : `${d} days`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
          <p className="kx-settings-footnote">Feeds are checked only while Key is open, and not while the Mac is offline or saving power.</p>
        </section>
      )}
    </div>
  );
}

/** The manager as a sheet over the window (from the Inbox). */
export function FeedsSheet({ invoke, workspaceId, onClose }: { invoke: Invoke; workspaceId: string; onClose: () => void }) {
  return (
    <GlobalDrawer onClose={onClose} presentation="sheet" label="Feeds and alerts">
      <div className="key-property-editor kx-feeds-sheet" data-modal-view="feeds">
        <header>
          <h2>Feeds &amp; alerts</h2>
          <p>What your Inbox follows.</p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          <FeedsManager invoke={invoke} workspaceId={workspaceId} />
        </div>
      </div>
    </GlobalDrawer>
  );
}
