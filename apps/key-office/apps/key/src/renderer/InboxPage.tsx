// The Inbox: what the user's feeds and alerts brought in, and works the user saved with Add to
// Inbox, newest first, in the shared source row. Triage from the keyboard: j/k or the arrows
// move, a adds to the library (asking where, as every add does, then Find PDF when that is
// on), e or ⌫ dismisses, s saves for later, u marks unread, o opens the work's page beside
// the Inbox, x picks rows (⇧-click a range, ⌘-click one) so s, e and u act on all of them.
// Filters pick a feed, a kind or what the user saved; items group by day or by where they
// came from, and each says why it is here. "Feeds & alerts…" manages what is followed.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { ContextMenu } from "./DatabaseView";
import { FeedsSheet } from "./FeedsManager";
import { FEED_KIND_ICON, KIND_LABEL, feedsChanged, markInboxSeen, onFeedsChanged, whyHere, type FeedItem, type FeedKind, type ItemPage, type Subscription } from "./feeds-ui";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { bridge, type Invoke, type Source } from "./library-api";
import { addFromSource } from "./add-from-source";
import { onLibraryChanged } from "./library-nav";
import { SourceListItem, type ListWork } from "./source-list";
import "./inbox.css";
import { EmptyState, Explain, FirstUseTip, Hint } from "./explain";

type View = "unread" | "all" | "saved";
type Grouping = "none" | "day" | "from";
type Filter = { subscriptionId?: string; kind?: FeedKind; savedByYou?: boolean };
const PAGE = 100;
const GROUP_LABEL: Record<Grouping, string> = { none: "No grouping", day: "By day", from: "By where it came from" };

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
function dayOf(at: number) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
  return day.toLocaleDateString(undefined, { day: "numeric", month: "long", year: days > 300 ? "numeric" : undefined });
}
const fromOf = (item: FeedItem) => (item.origin ? "Saved by you" : (item.subscriptions[0] ?? "Elsewhere"));
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
const readGrouping = (): Grouping => {
  try {
    const v = localStorage.getItem("key.inbox.group");
    return v === "day" || v === "from" ? v : "none";
  } catch {
    return "none";
  }
};

export default function InboxPage({ invoke, workspaceId, viewId, active }: { invoke: Invoke; workspaceId: string; viewId?: string; active?: boolean }) {
  const [view, setView] = useState<View>("unread");
  const [filter, setFilter] = useState<Filter>({});
  const [grouping, setGrouping] = useState<Grouping>(readGrouping);
  const [page, setPage] = useState<ItemPage>();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [managing, setManaging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; which: "filter" | "group" }>();
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef(active);
  shown.current = active;
  // Items acted on stay where they are until the list is read again (the cursor keeps its place).
  const [gone, setGone] = useState<Set<string>>(new Set());

  // Read while shown: they stay in the Unread view until another view or filter is chosen.
  const readHere = useRef(new Set<string>());
  useEffect(() => {
    readHere.current = new Set();
    setPicked(new Set());
  }, [view, filter]);
  const load = useCallback(async () => {
    const [items, subs] = await Promise.all([
      invoke<ItemPage>(
        "feeds_items",
        { view, subscriptionId: filter.subscriptionId ?? null, kind: filter.kind ?? null, savedByYou: !!filter.savedByYou, limit: PAGE, keep: [...readHere.current] },
        workspaceId,
      ),
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

  // Grouped (by day or by where it came from), in the order the groups first appear.
  const { items, heads } = useMemo(() => {
    const live = (page?.items ?? []).filter((i) => !gone.has(i.id));
    if (grouping === "none") return { items: live, heads: new Map<string, string>() };
    const key = grouping === "day" ? (i: FeedItem) => dayOf(i.origin?.at ?? i.foundAt) : fromOf;
    const groups = new Map<string, FeedItem[]>();
    for (const item of live) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    const heads = new Map<string, string>();
    for (const [label, members] of groups) heads.set(members[0].id, `${label} · ${members.length}`);
    return { items: [...groups.values()].flat(), heads };
  }, [page, gone, grouping]);
  const current = items[Math.min(cursor, items.length - 1)];
  const patch = (ids: string[], change: Partial<FeedItem>) => setPage((p) => p && { ...p, items: p.items.map((i) => (ids.includes(i.id) ? { ...i, ...change } : i)) });

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
      patch([current.id], { read: true });
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

  /** The rows an action applies to: those picked, else the one the keyboard is on. */
  const targets = (item?: FeedItem) => (picked.size ? items.filter((i) => picked.has(i.id)) : item ? [item] : []);
  const dismiss = (chosen: FeedItem[]) => {
    if (!chosen.length) return;
    const ids = chosen.map((i) => i.id);
    setGone((g) => new Set([...g, ...ids]));
    setPicked(new Set());
    void set(ids, { dismissed: true })
      .then(() => toast(ids.length > 1 ? `Dismissed ${ids.length}` : "Dismissed", () => void set(ids, { dismissed: false }).then(load)))
      .catch((e) => toast(String(e)));
  };
  const save = (chosen: FeedItem[]) => {
    if (!chosen.length) return;
    const on = chosen.some((i) => !i.saved);
    const ids = chosen.map((i) => i.id);
    patch(ids, { saved: on, read: true });
    void set(ids, { saved: on, read: true }).then(() => toast(on ? (ids.length > 1 ? `Saved ${ids.length} for later` : "Saved for later") : "No longer saved"));
    if (view === "saved" && !on) setGone((g) => new Set([...g, ...ids]));
    setPicked(new Set());
  };
  const toggleRead = (chosen: FeedItem[]) => {
    if (!chosen.length) return;
    const read = chosen.some((i) => !i.read);
    const ids = chosen.map((i) => i.id);
    patch(ids, { read });
    void set(ids, { read });
    setPicked(new Set());
  };
  const added = (item: FeedItem, source: Source) => {
    readHere.current.add(item.id);
    patch([item.id], { added: true, read: true, sourceId: source.id, inLibrary: "added" });
    void invoke("feeds_added", { id: item.id, sourceId: source.id }, workspaceId).then(() => feedsChanged());
  };
  const add = (item: FeedItem, anchor?: Element | null) => {
    if (item.inLibrary) return toast("Already in your library");
    // Saved from a source's references: its collections are offered first.
    void addFromSource(invoke, { workspaceId, sourceId: item.origin?.sourceId ?? null }, { ...listWork(item), url: item.work.landingUrl ?? null, authors: item.work.authors ?? null }, anchor)
      .then((source) => source && added(item, source))
      .catch((e) => toast(String(e).replace(/^Error: /, "")));
  };
  const open = (item: FeedItem) => {
    const url = item.work.landingUrl || (item.work.doi ? `https://doi.org/${item.work.doi}` : "");
    if (!url) return toast("This item has no page to open");
    patch([item.id], { read: true });
    void set([item.id], { read: true }).catch(() => {});
    void bridge().tabAction("open-url", { url, placement: "split", fromViewId: viewId });
  };
  const pick = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const select = (i: number, e: MouseEvent) => {
    if (e.shiftKey && (e.target as HTMLElement).closest(".kx-work-head")) {
      e.preventDefault();
      const [a, b] = [Math.min(cursor, i), Math.max(cursor, i)];
      setPicked((p) => new Set([...p, ...items.slice(a, b + 1).map((x) => x.id)]));
    } else if (e.metaKey && (e.target as HTMLElement).closest(".kx-work-head")) {
      e.preventDefault();
      pick(items[i].id);
    }
    setCursor(i);
  };
  const markAllRead = () => {
    items.forEach((i) => readHere.current.add(i.id));
    markRead();
  };
  const markRead = () =>
    void invoke<number>("feeds_mark_read", { subscriptionId: filter.subscriptionId ?? null, kind: filter.kind ?? null, savedByYou: !!filter.savedByYou }, workspaceId).then((n) => {
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
      case "x":
        if (item) pick(item.id);
        break;
      case "a":
        if (item) add(item, list.current?.querySelector('[data-selected="true"] .kx-work-head'));
        break;
      case "e":
      case "Backspace":
      case "Delete":
        dismiss(targets(item));
        break;
      case "s":
        save(targets(item));
        break;
      case "u":
        toggleRead(targets(item));
        break;
      case "o":
        if (item) open(item);
        break;
      case "Escape":
        if (!picked.size) return;
        setPicked(new Set());
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const chosen = filter.subscriptionId ? subscriptions.find((s) => s.id === filter.subscriptionId) : undefined;
  const filterLabel = chosen ? chosen.title : filter.savedByYou ? "Saved by you" : filter.kind ? `${KIND_LABEL[filter.kind]}s` : "Everything";
  const kinds = [...new Set(subscriptions.map((s) => s.kind))];
  const empty = page && !items.length;
  const nothingAtAll = !subscriptions.length && page && !page.total && view !== "saved" && !filter.savedByYou;
  const pickedItems = items.filter((i) => picked.has(i.id));
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
          aria-label={`Show: ${filterLabel}`}
          aria-expanded={menu?.which === "filter"}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4, which: "filter" });
          }}
        >
          {chosen ? <Icon name={FEED_KIND_ICON[chosen.kind]} size={12} /> : <Icon name="filter" size={12} />}
          <span>{filterLabel}</span>
          <Icon name="chevronDown" size={10} />
        </button>
        <button
          className="kx-inbox-filter"
          aria-haspopup="menu"
          aria-label={`Group: ${GROUP_LABEL[grouping]}`}
          aria-expanded={menu?.which === "group"}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4, which: "group" });
          }}
        >
          <Icon name="layers" size={12} />
          <span>{GROUP_LABEL[grouping]}</span>
          <Icon name="chevronDown" size={10} />
        </button>
        <span className="kx-inbox-keys" aria-hidden="true">
          <kbd>j</kbd>
          <kbd>k</kbd> move · <kbd>a</kbd> add · <kbd>s</kbd> save · <kbd>e</kbd> dismiss · <kbd>o</kbd> open · <kbd>x</kbd> select
        </span>
        <Explain help="inbox.triage" />
      </div>
      {menu?.which === "filter" && (
        <ContextMenu x={menu.x} y={menu.y} label="Show items from" onClose={() => setMenu(undefined)}>
          {(close) => {
            const choose = (next: Filter) => () => {
              close();
              setFilter(next);
              setCursor(0);
            };
            return [
              <button key="all" role="menuitemradio" aria-checked={!filter.subscriptionId && !filter.kind && !filter.savedByYou} onClick={choose({})}>
                <Icon name="inbox" size={13} /> Everything
              </button>,
              <button key="mine" role="menuitemradio" aria-checked={!!filter.savedByYou} onClick={choose({ savedByYou: true })}>
                <Icon name="bookmark" size={13} /> Saved by you
              </button>,
              kinds.length > 1 && <hr key="r1" />,
              ...(kinds.length > 1
                ? kinds.map((k) => (
                    <button key={`k:${k}`} role="menuitemradio" aria-checked={filter.kind === k && !filter.subscriptionId} onClick={choose({ kind: k })}>
                      <Icon name={FEED_KIND_ICON[k]} size={13} /> {KIND_LABEL[k]}s
                    </button>
                  ))
                : []),
              subscriptions.length > 0 && <hr key="r2" />,
              ...subscriptions.map((s) => (
                <button key={s.id} role="menuitemradio" aria-checked={filter.subscriptionId === s.id} onClick={choose({ subscriptionId: s.id })}>
                  <Icon name={FEED_KIND_ICON[s.kind]} size={13} /> <span className="kx-inbox-menu-title">{s.title}</span>
                  {s.unread > 0 && <small>{s.unread}</small>}
                </button>
              )),
            ];
          }}
        </ContextMenu>
      )}
      {menu?.which === "group" && (
        <ContextMenu x={menu.x} y={menu.y} label="Group items" onClose={() => setMenu(undefined)}>
          {(close) =>
            (Object.keys(GROUP_LABEL) as Grouping[]).map((g) => (
              <button
                key={g}
                role="menuitemradio"
                aria-checked={grouping === g}
                onClick={() => {
                  close();
                  setGrouping(g);
                  setCursor(0);
                  try {
                    localStorage.setItem("key.inbox.group", g);
                  } catch {
                    /* per-viewer convenience only */
                  }
                }}
              >
                {GROUP_LABEL[g]}
              </button>
            ))
          }
        </ContextMenu>
      )}
      {(view === "saved" || filter.savedByYou) && !empty && <Hint help="inbox.saved-by-you" />}
      {picked.size > 0 && (
        <div className="kx-inbox-bulk" role="toolbar" aria-label="Selected items">
          <strong>{picked.size} selected</strong>
          <button className="kx-page-action" onClick={() => toggleRead(pickedItems)}>
            <Icon name="readHalf" size={12} /> {pickedItems.some((i) => !i.read) ? "Mark read" : "Mark unread"}
          </button>
          <button className="kx-page-action" onClick={() => save(pickedItems)}>
            <Icon name="bookmark" size={12} /> {pickedItems.some((i) => !i.saved) ? "Save" : "Unsave"}
          </button>
          <button className="kx-page-action" onClick={() => dismiss(pickedItems)}>
            <Icon name="close" size={12} /> Dismiss
          </button>
          <span className="kx-spacer" />
          <button className="kx-page-action" onClick={() => setPicked(new Set(items.map((i) => i.id)))}>
            Select all {items.length}
          </button>
          <button className="kx-page-action" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}
      {nothingAtAll && (
        <EmptyState className="kx-inbox-empty-state" help="empty.inbox" icon="inbox" action={{ label: "Follow something…", icon: "plus", onClick: () => setManaging(true) }} learnMore="feeds.what" />
      )}
      {!nothingAtAll && empty && (
        <EmptyState className="kx-inbox-empty-state" help={view === "unread" && !filter.savedByYou ? "empty.inbox-caught-up" : view === "saved" || filter.savedByYou ? "empty.inbox-saved" : "empty.inbox-none"} icon={view === "saved" || filter.savedByYou ? "bookmark" : "check"} />
      )}
      {!!items.length && <FirstUseTip help="tip.inbox-keys" anchor=".kx-inbox-keys" />}
      {!!items.length && (
        <ul ref={list} className="kx-work-list kx-inbox-list" tabIndex={0} aria-label="Inbox items" aria-multiselectable onKeyDown={keys} autoFocus data-grouped={grouping !== "none" || undefined}>
          {items.map((item, i) => {
            const why = whyHere(item, subscriptions);
            const row = (
              <SourceListItem
                key={item.id}
                invoke={invoke}
                workspaceId={workspaceId}
                work={listWork(item)}
                inbox={false}
                selected={i === Math.min(cursor, items.length - 1)}
                picked={picked.has(item.id)}
                onSelect={(e) => select(i, e)}
                onAdded={(source) => added(item, source)}
                aside={
                  <span className="kx-inbox-aside" title={why}>
                    {picked.has(item.id) && <Icon name="check" size={11} aria-label="Selected" />}
                    {!item.read && <span className="kx-inbox-dot" aria-label="Unread" title="Unread" />}
                    {item.saved && <Icon name="bookmark" size={11} aria-label="Saved" />}
                    <small>{item.origin ? `Saved from ${item.origin.label || "Key"}` : [when(item), grouping === "from" ? "" : item.subscriptions[0]].filter(Boolean).join(" · ")}</small>
                  </span>
                }
                actions={
                  <>
                    {item.work.landingUrl && (
                      <button className="kx-page-action" onClick={() => open(item)} title="Open its page beside the Inbox (o)">
                        <Icon name="globe" size={12} /> Open page
                      </button>
                    )}
                    <button className="kx-page-action" onClick={() => save([item])} title="Save for later (s)">
                      <Icon name="bookmark" size={12} /> {item.saved ? "Saved" : "Save"}
                    </button>
                    <button className="kx-page-action" onClick={() => dismiss([item])} title="Dismiss (e)">
                      <Icon name="close" size={12} /> Dismiss
                    </button>
                    {why && (
                      <p className="kx-inbox-why">
                        <Icon name="info" size={11} /> <span>Why is this here? {why}</span>
                      </p>
                    )}
                  </>
                }
              />
            );
            const head = heads.get(item.id);
            return head ? [<li key={`h:${item.id}`} className="kx-inbox-group" role="presentation">{head}</li>, row] : row;
          })}
        </ul>
      )}
      {page && page.nextOffset !== null && <p className="kx-inbox-more">Showing the newest {items.length} of {page.total.toLocaleString()}.</p>}
      {managing && <FeedsSheet invoke={invoke} workspaceId={workspaceId} onClose={() => (setManaging(false), void load())} />}
    </section>
  );
}
