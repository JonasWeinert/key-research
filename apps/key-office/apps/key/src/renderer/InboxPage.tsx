// The Inbox: what the user's feeds and alerts brought in, newest first, in the shared source
// row. Triage from the keyboard: j/k or the arrows move, a adds to the library (asking where,
// as every add does, then Find PDF when that is on), e or ⌫ dismisses, s saves for later,
// u marks unread, o opens the work's page beside the Inbox. Filters pick a feed or a kind;
// "Mark all read" clears what is shown. "Feeds & alerts…" manages what is followed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { ContextMenu } from "./DatabaseView";
import { FeedsSheet } from "./FeedsManager";
import { FEED_KIND_ICON, KIND_LABEL, feedsChanged, markInboxSeen, onFeedsChanged, type FeedItem, type FeedKind, type ItemPage, type Subscription } from "./feeds-ui";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { bridge, type Invoke, type Source } from "./library-api";
import { addFromSource } from "./add-from-source";
import { onLibraryChanged } from "./library-nav";
import { SourceListItem, type ListWork } from "./source-list";
import "./inbox.css";

type View = "unread" | "all" | "saved";
const PAGE = 100;

function byline(authors?: string[]) {
  const list = (authors ?? []).filter(Boolean);
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} et al.`;
}
function when(item: FeedItem) {
  const date = item.published ?? item.work.published;
  if (!date) return "";
  const at = Date.parse(date);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: Date.now() - at > 300 * 86_400_000 ? "numeric" : undefined });
}
const listWork = (item: FeedItem): ListWork => ({
  title: item.work.title,
  byline: byline(item.work.authors),
  year: item.work.year ?? null,
  container: item.work.venue ?? null,
  doi: item.work.doi ?? null,
  openalexId: item.work.ids?.openalex ?? null,
  matchedSourceId: item.inLibrary ? (item.sourceId ?? null) : null,
  text: null,
  abstract: item.work.abstract ?? null,
  url: item.work.landingUrl ?? null,
  authors: item.work.authors ?? null,
});

export default function InboxPage({ invoke, workspaceId, viewId, active }: { invoke: Invoke; workspaceId: string; viewId?: string; active?: boolean }) {
  const [view, setView] = useState<View>("unread");
  const [filter, setFilter] = useState<{ subscriptionId?: string; kind?: FeedKind }>({});
  const [page, setPage] = useState<ItemPage>();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [cursor, setCursor] = useState(0);
  const [managing, setManaging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef(active);
  shown.current = active;
  // Items acted on stay where they are until the list is read again (the cursor keeps its place).
  const [gone, setGone] = useState<Set<string>>(new Set());

  // Read while shown: they stay in the Unread view until another view or filter is chosen.
  const readHere = useRef(new Set<string>());
  useEffect(() => {
    readHere.current = new Set();
  }, [view, filter]);
  const load = useCallback(async () => {
    const [items, subs] = await Promise.all([
      invoke<ItemPage>("feeds_items", { view, subscriptionId: filter.subscriptionId ?? null, kind: filter.kind ?? null, limit: PAGE, keep: [...readHere.current] }, workspaceId),
      invoke<Subscription[]>("feeds_subscriptions", {}, workspaceId),
    ]);
    setPage(items);
    setSubscriptions(subs);
    setGone(new Set());
    // What is shown while the Inbox is in front has been seen.
    if (shown.current) markInboxSeen(workspaceId);
  }, [invoke, workspaceId, view, filter]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => onFeedsChanged(() => void load().catch(() => {})), [load]);
  // A work added elsewhere (or trashed) changes what is "In library".
  useEffect(() => onLibraryChanged(() => void load().catch(() => {})), [load]);
  useEffect(() => {
    if (active) markInboxSeen(workspaceId);
  }, [active, workspaceId]);

  const items = useMemo(() => (page?.items ?? []).filter((i) => !gone.has(i.id)), [page, gone]);
  const current = items[Math.min(cursor, items.length - 1)];
  const patch = (id: string, change: Partial<FeedItem>) => setPage((p) => p && { ...p, items: p.items.map((i) => (i.id === id ? { ...i, ...change } : i)) });

  const set = useCallback(
    (ids: string[], change: { read?: boolean; saved?: boolean; dismissed?: boolean }) => {
      if (change.read || change.saved) ids.forEach((id) => readHere.current.add(id));
      return invoke("feeds_set", { ids, ...change }, workspaceId).then(() => feedsChanged());
    },
    [invoke, workspaceId],
  );
  // Looking at an item a moment reads it.
  useEffect(() => {
    if (!current || current.read) return;
    const timer = setTimeout(() => {
      patch(current.id, { read: true });
      void set([current.id], { read: true }).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [current, set]);

  const move = (by: number) => {
    setCursor((at) => Math.max(0, Math.min(items.length - 1, at + by)));
  };
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, items.length]);

  const dismiss = (item: FeedItem) => {
    setGone((g) => new Set(g).add(item.id));
    void set([item.id], { dismissed: true })
      .then(() => toast("Dismissed", () => void set([item.id], { dismissed: false }).then(load)))
      .catch((e) => toast(String(e)));
  };
  const save = (item: FeedItem) => {
    patch(item.id, { saved: !item.saved, read: true });
    void set([item.id], { saved: !item.saved, read: true }).then(() => toast(item.saved ? "No longer saved" : "Saved for later"));
    if (view === "saved" && item.saved) setGone((g) => new Set(g).add(item.id));
  };
  const added = (item: FeedItem, source: Source) => {
    readHere.current.add(item.id);
    patch(item.id, { added: true, read: true, sourceId: source.id, inLibrary: "added" });
    void invoke("feeds_added", { id: item.id, sourceId: source.id }, workspaceId).then(() => feedsChanged());
  };
  const add = (item: FeedItem, anchor?: Element | null) => {
    if (item.inLibrary) return toast("Already in your library");
    void addFromSource(invoke, { workspaceId }, { ...listWork(item), url: item.work.landingUrl ?? null, authors: item.work.authors ?? null }, anchor)
      .then((source) => source && added(item, source))
      .catch((e) => toast(String(e).replace(/^Error: /, "")));
  };
  const open = (item: FeedItem) => {
    const url = item.work.landingUrl || (item.work.doi ? `https://doi.org/${item.work.doi}` : "");
    if (!url) return toast("This item has no page to open");
    patch(item.id, { read: true });
    void set([item.id], { read: true }).catch(() => {});
    void bridge().tabAction("open-url", { url, placement: "split", fromViewId: viewId });
  };
  const markAllRead = () =>
    items.forEach((i) => readHere.current.add(i.id)) ||
    void invoke<number>("feeds_mark_read", { subscriptionId: filter.subscriptionId ?? null, kind: filter.kind ?? null }, workspaceId).then((n) => {
      feedsChanged();
      toast(n ? `Marked ${n} as read` : "Nothing unread here");
    });
  const refresh = () => {
    setRefreshing(true);
    void invoke<{ added: number; errors: { title: string; error: string }[] }>("feeds_refresh", { id: filter.subscriptionId ?? null }, workspaceId)
      .then((r) => {
        feedsChanged();
        toast(r.errors.length ? `${r.errors[0].title}: ${r.errors[0].error}` : r.added ? `${r.added} new ${r.added === 1 ? "item" : "items"}` : "No new items");
      })
      .catch((e) => toast(String(e)))
      .finally(() => setRefreshing(false));
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
    const item = current;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        move(1);
        break;
      case "k":
      case "ArrowUp":
        move(-1);
        break;
      case "a":
        if (item) add(item, list.current?.querySelector('[data-selected="true"] .kx-work-head'));
        break;
      case "e":
      case "Backspace":
      case "Delete":
        if (item) dismiss(item);
        break;
      case "s":
        if (item) save(item);
        break;
      case "u":
        if (item) {
          patch(item.id, { read: !item.read });
          void set([item.id], { read: !item.read });
        }
        break;
      case "o":
        if (item) open(item);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const chosen = filter.subscriptionId ? subscriptions.find((s) => s.id === filter.subscriptionId) : undefined;
  const filterLabel = chosen ? chosen.title : filter.kind ? `${KIND_LABEL[filter.kind]}s` : "All feeds and alerts";
  const kinds = [...new Set(subscriptions.map((s) => s.kind))];
  const empty = page && !items.length;
  return (
    <section className="kx-inbox" data-modal-view="inbox">
      <header className="kx-inbox-head">
        <div className="kx-inbox-title">
          <h1>Inbox</h1>
          {page && <span className="kx-inbox-count">{page.unread ? `${page.unread.toLocaleString()} unread` : "All read"}</span>}
        </div>
        <div className="kx-inbox-tools">
          <button className="kx-page-action" onClick={refresh} disabled={refreshing || !subscriptions.length} title="Check every feed now">
            <Icon name="retry" size={12} /> {refreshing ? "Checking…" : "Check now"}
          </button>
          <button className="kx-page-action" onClick={markAllRead} disabled={!page?.unread}>
            <Icon name="check" size={12} /> Mark all read
          </button>
          <button className="kx-page-action" onClick={() => setManaging(true)}>
            <Icon name="feed" size={12} /> Feeds &amp; alerts…
          </button>
        </div>
      </header>
      <div className="kx-inbox-bar">
        <SegmentedTabs
          label="Inbox views"
          size="small"
          value={view}
          onChange={(v) => {
            setView(v as View);
            setCursor(0);
          }}
          tabs={[
            { id: "unread", label: "Unread", badge: page?.unread ? page.unread.toLocaleString() : undefined },
            { id: "all", label: "All" },
            { id: "saved", label: "Saved", badge: page?.saved ? page.saved.toLocaleString() : undefined },
          ]}
        />
        <button
          className="kx-inbox-filter"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          disabled={!subscriptions.length}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          {chosen ? <Icon name={FEED_KIND_ICON[chosen.kind]} size={12} /> : <Icon name="filter" size={12} />}
          <span>{filterLabel}</span>
          <Icon name="chevronDown" size={10} />
        </button>
        <span className="kx-inbox-keys" aria-hidden="true">
          <kbd>j</kbd>
          <kbd>k</kbd> move · <kbd>a</kbd> add · <kbd>e</kbd> dismiss · <kbd>s</kbd> save · <kbd>o</kbd> open
        </span>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label="Show items from" onClose={() => setMenu(undefined)}>
          {(close) => {
            const pick = (next: typeof filter) => () => {
              close();
              setFilter(next);
              setCursor(0);
            };
            return [
              <button key="all" role="menuitemradio" aria-checked={!filter.subscriptionId && !filter.kind} onClick={pick({})}>
                <Icon name="inbox" size={13} /> All feeds and alerts
              </button>,
              kinds.length > 1 && <hr key="r1" />,
              ...(kinds.length > 1
                ? kinds.map((k) => (
                    <button key={`k:${k}`} role="menuitemradio" aria-checked={filter.kind === k && !filter.subscriptionId} onClick={pick({ kind: k })}>
                      <Icon name={FEED_KIND_ICON[k]} size={13} /> {KIND_LABEL[k]}s
                    </button>
                  ))
                : []),
              <hr key="r2" />,
              ...subscriptions.map((s) => (
                <button key={s.id} role="menuitemradio" aria-checked={filter.subscriptionId === s.id} onClick={pick({ subscriptionId: s.id })}>
                  <Icon name={FEED_KIND_ICON[s.kind]} size={13} /> <span className="kx-inbox-menu-title">{s.title}</span>
                  {s.unread > 0 && <small>{s.unread}</small>}
                </button>
              )),
            ];
          }}
        </ContextMenu>
      )}
      {!subscriptions.length && page && (
        <div className="kx-inbox-empty">
          <Icon name="inbox" size={28} />
          <h2>Nothing followed yet</h2>
          <p>Follow a journal’s table of contents, an arXiv listing or a blog by its address, or follow authors, journals and topics from their pages. Alerts from a web search or a source’s citations land here too.</p>
          <button className="kx-button-primary" onClick={() => setManaging(true)}>
            <Icon name="plus" size={12} /> Add a feed…
          </button>
        </div>
      )}
      {!!subscriptions.length && empty && (
        <div className="kx-inbox-empty">
          <Icon name="check" size={24} />
          <h2>{view === "unread" ? "All caught up" : view === "saved" ? "Nothing saved" : "No items"}</h2>
          <p>{view === "unread" ? "New items appear here as your feeds bring them." : view === "saved" ? "Press s on an item to keep it for later." : "Items your feeds bring in appear here."}</p>
        </div>
      )}
      {!!items.length && (
        <ul ref={list} className="kx-work-list kx-inbox-list" tabIndex={0} aria-label="Inbox items" onKeyDown={keys} autoFocus>
          {items.map((item, i) => (
            <SourceListItem
              key={item.id}
              invoke={invoke}
              workspaceId={workspaceId}
              work={listWork(item)}
              selected={i === Math.min(cursor, items.length - 1)}
              onSelect={() => setCursor(i)}
              onAdded={(source) => added(item, source)}
              aside={
                <span className="kx-inbox-aside">
                  {!item.read && <span className="kx-inbox-dot" aria-label="Unread" title="Unread" />}
                  {item.saved && <Icon name="bookmark" size={11} aria-label="Saved" />}
                  <small title={item.subscriptions.join(", ")}>{[when(item), item.subscriptions[0]].filter(Boolean).join(" · ")}</small>
                </span>
              }
              actions={
                <>
                  {item.work.landingUrl && (
                    <button className="kx-page-action" onClick={() => open(item)} title="Open its page beside the Inbox (o)">
                      <Icon name="globe" size={12} /> Open page
                    </button>
                  )}
                  <button className="kx-page-action" onClick={() => save(item)} title="Save for later (s)">
                    <Icon name="bookmark" size={12} /> {item.saved ? "Saved" : "Save"}
                  </button>
                  <button className="kx-page-action" onClick={() => dismiss(item)} title="Dismiss (e)">
                    <Icon name="close" size={12} /> Dismiss
                  </button>
                </>
              }
            />
          ))}
        </ul>
      )}
      {page && page.nextOffset !== null && <p className="kx-inbox-more">Showing the newest {items.length} of {page.total.toLocaleString()}.</p>}
      {managing && <FeedsSheet invoke={invoke} workspaceId={workspaceId} onClose={() => (setManaging(false), void load())} />}
    </section>
  );
}
