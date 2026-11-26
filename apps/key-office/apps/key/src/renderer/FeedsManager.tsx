// What the Inbox follows, and how. "Follow something" finds journals, people, topics and
// searches by name (feeds-follow.tsx) and previews them before following; below, what is
// followed, grouped by kind, each with how it is doing in plain words (last checked, last new
// item, what went wrong and how to fix it), how often it is checked, pause, "also add to a
// collection" and remove; OPML in and out; how long items are kept. Shown as a sheet from the
// Inbox and as Workspace Settings › Feeds & alerts.
import { useCallback, useEffect, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { FEED_KIND_ICON, INTERVALS, KIND_GROUP, KIND_ORDER, feedsChanged, intervalLabel, onFeedsChanged, type Subscription } from "./feeds-ui";
import { FollowFinder, errorText } from "./feeds-follow";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { bridge, relativeDate, type Collection, type Invoke } from "./library-api";
import "./inbox.css";
import "./feeds.css";
import { EmptyState, Explain, Hint } from "./explain";
import { hintText } from "./help-content";

interface Retention {
  unreadDays: number;
  readDays: number;
  dismissedDays: number;
}

function ago(at?: number | null) {
  if (!at) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return relativeDate(at).toLowerCase();
}

/** What went wrong, and what to do about it. */
function problemText(code?: string | null) {
  switch (code) {
    case "limited":
      return hintText("feeds.problem.limited");
    case "unreachable":
      return hintText("feeds.problem.unreachable");
    case "gone":
      return hintText("feeds.problem.gone");
    case "blocked":
      return hintText("feeds.problem.blocked");
    case "not-a-feed":
      return hintText("feeds.problem.not-a-feed");
    case "nothing-to-follow":
      return hintText("feeds.problem.nothing-to-follow");
    default:
      return hintText("feeds.problem.other");
  }
}

function status(s: Subscription) {
  if (s.paused) return "Paused";
  const parts = [s.checkedAt ? `Checked ${ago(s.checkedAt)}` : "Not checked yet", s.lastItemAt ? `last new item ${ago(s.lastItemAt)}` : s.checkedAt ? "nothing new yet" : "", s.unread ? `${s.unread} unread` : ""];
  return parts.filter(Boolean).join(" · ");
}

function Row({ s, collections, update, remove, refresh }: { s: Subscription; collections: Collection[]; update: (s: Subscription, patch: Record<string, unknown>) => void; remove: (s: Subscription) => void; refresh: (s: Subscription) => void }) {
  const auto = typeof s.config.autoCollection === "string" ? s.config.autoCollection : "";
  const failing = s.failures > 0 && !!s.lastError;
  return (
    <div className="kx-settings-row kx-feeds-row" data-paused={s.paused || undefined} data-failing={failing || undefined}>
      <span className="kx-feeds-kind" aria-hidden="true">
        <Icon name={FEED_KIND_ICON[s.kind]} size={13} />
      </span>
      <div>
        <span className="kx-feeds-title">{s.title}</span>
        <small>{status(s)}</small>
        {failing && (
          <small className="kx-feeds-problem" title={s.lastError ?? undefined}>
            <Icon name="warning" size={11} /> {problemText(s.problem)}{" "}
            <button type="button" className="kx-work-retry" onClick={() => refresh(s)}>
              Try again
            </button>
          </small>
        )}
      </div>
      <div className="kx-settings-control kx-feeds-controls">
        <select className="kx-settings-select" aria-label={`How often to check ${s.title}`} title="How often Key checks, while it is open" value={s.intervalMinutes} onChange={(e) => update(s, { intervalMinutes: Number(e.target.value) })}>
          {[...new Set([...INTERVALS, s.intervalMinutes])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {intervalLabel(m)}
            </option>
          ))}
        </select>
        <select
          className="kx-settings-select kx-feeds-auto"
          aria-label={`Also add new items from ${s.title} to a collection`}
          title={hintText("feeds.auto-collection")}
          value={auto}
          onChange={(e) => {
            const config = { ...s.config };
            if (e.target.value) config.autoCollection = e.target.value;
            else delete config.autoCollection;
            update(s, { config });
          }}
        >
          <option value="">Inbox only</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              Also into {c.name}
            </option>
          ))}
        </select>
        <button className="kx-settings-button" aria-label={s.paused ? `Resume ${s.title}` : `Pause ${s.title}`} title={s.paused ? "Check it again" : "Stop checking for now; nothing is removed"} onClick={() => update(s, { paused: !s.paused })}>
          <Icon name={s.paused ? "play" : "pause"} size={11} /> {s.paused ? "Resume" : "Pause"}
        </button>
        <button className="kx-feeds-remove" aria-label={`Stop following ${s.title}`} title="Stop following" onClick={() => remove(s)}>
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  );
}

export function FeedsManager({ invoke, workspaceId }: { invoke: Invoke; workspaceId: string }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState("");
  const [retention, setRetention] = useState<Retention>();
  const load = useCallback(
    () =>
      void Promise.all([invoke<Subscription[]>("feeds_subscriptions", {}, workspaceId), invoke<Retention>("feeds_retention", {}, workspaceId), invoke<Collection[]>("store_collections", {}, workspaceId).catch(() => [] as Collection[])])
        .then(([s, r, c]) => {
          setSubscriptions(s);
          setRetention(r);
          setCollections(c);
        })
        .catch((e) => setError(errorText(e))),
    [invoke, workspaceId],
  );
  useEffect(load, [load]);
  useEffect(() => onFeedsChanged(load), [load]);

  const update = (s: Subscription, patch: Record<string, unknown>) =>
    void invoke("feeds_update", { id: s.id, ...patch }, workspaceId)
      .then(() => feedsChanged())
      .catch((e) => setError(errorText(e)));
  const remove = (s: Subscription) =>
    void invoke("feeds_unsubscribe", { id: s.id }, workspaceId)
      .then(() => {
        feedsChanged();
        toast(`Stopped following ${s.title}`);
      })
      .catch((e) => setError(errorText(e)));
  const refresh = (s: Subscription) =>
    void invoke<{ added: number; errors: { error: string }[] }>("feeds_refresh", { id: s.id }, workspaceId)
      .then((r) => {
        feedsChanged();
        toast(r.errors.length ? `Still failing: ${r.errors[0].error}` : r.added ? `${r.added} new in the Inbox` : "Working again; nothing new");
      })
      .catch((e) => setError(errorText(e)));
  const importOpml = async () => {
    const path = await bridge().choosePath({ mode: "open", title: "Import feeds from OPML", extensions: ["opml", "xml"] });
    if (!path) return;
    try {
      const out = await invoke<{ added: number; existing: number }>("feeds_opml_import", { path }, workspaceId);
      feedsChanged();
      toast(`Imported ${out.added} ${out.added === 1 ? "feed" : "feeds"}${out.existing ? `; ${out.existing} already followed` : ""}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const exportOpml = async () => {
    const path = await bridge().choosePath({ mode: "save", title: "Export feeds as OPML", defaultPath: "Key feeds.opml", extensions: ["opml"] });
    if (!path) return;
    try {
      const out = await invoke<{ count: number }>("feeds_opml_export", { path }, workspaceId);
      toast(`Exported ${out.count} ${out.count === 1 ? "feed" : "feeds"}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const keep = (patch: Partial<Retention>) => {
    if (!retention) return;
    const next = { ...retention, ...patch };
    setRetention(next);
    void invoke("feeds_retention", { set: next }, workspaceId).catch((e) => setError(errorText(e)));
  };
  const groups = KIND_ORDER.map((kind) => ({ kind, items: (subscriptions ?? []).filter((s) => s.kind === kind) })).filter((g) => g.items.length);

  return (
    <div className="kx-feeds-manager">
      <div className="kx-settings-intro">
        <Hint help="feeds.intro" />
        <Explain help="feeds.what" label="What are feeds and alerts?" />
      </div>
      <section className="kx-settings-group">
        <h3>Follow something new</h3>
        <FollowFinder invoke={invoke} workspaceId={workspaceId} onImportOpml={() => void importOpml()} />
      </section>
      {error && <p className="kx-inline-error">{error}</p>}
      <section className="kx-settings-group">
        <h3>
          Following
          <Explain help="feeds.kinds" />
        </h3>
        {subscriptions && !subscriptions.length && <EmptyState help="empty.feeds" icon="feed" compact />}
        {groups.map((g) => (
          <div key={g.kind} className="kx-feeds-kind-group">
            <h4>
              {KIND_GROUP[g.kind]} <small>{g.items.length}</small>
            </h4>
            <div className="kx-settings-rows kx-feeds-list" aria-label={KIND_GROUP[g.kind]}>
              {g.items.map((s) => (
                <Row key={s.id} s={s} collections={collections} update={update} remove={remove} refresh={refresh} />
              ))}
            </div>
          </div>
        ))}
        <div className="kx-feeds-opml">
          <Explain help="feeds.opml-what" />
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
          <Hint help="feeds.keeping" />
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
          <p className="kx-settings-footnote">{hintText("feeds.when")}</p>
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
          <p>The journals, people, topics and searches your Inbox follows.</p>
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
