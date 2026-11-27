// Feeds and alerts in the shell: the types the host's `feeds_*` commands answer with, the
// Inbox's quiet counts (sidebar and status bar), and "Follow" / "Alert me" buttons for the
// places where following is natural (a person's, journal's or topic's page, a web search, a
// source page, a collection). The host (feeds/) does the fetching, matching and storing.
import { useEffect, useState } from "react";
import type { StatusItem } from "../shared/status-items";
import { Icon, type IconName } from "./icons";
import { toast } from "./item-actions";
import type { Invoke } from "./library-api";

export type FeedKind = "rss" | "openalex" | "author" | "venue" | "topic" | "citing" | "pubmed";
export interface Subscription {
  id: string;
  kind: FeedKind;
  title: string;
  config: Record<string, unknown>;
  intervalMinutes: number;
  paused: boolean;
  createdAt: number;
  checkedAt?: number | null;
  nextAt?: number | null;
  failures: number;
  lastError?: string | null;
  unread: number;
  total: number;
  /** When it last brought something new. */
  lastItemAt?: number | null;
  /** What a failure means: limited | unreachable | gone | blocked | not-a-feed | nothing-to-follow | other. */
  problem?: string | null;
}
/** A work as web search describes it. */
export interface FeedWork {
  title: string;
  authors?: string[];
  year?: number | null;
  venue?: string | null;
  abstract?: string | null;
  doi?: string | null;
  ids?: { openalex?: string; arxiv?: string; pmid?: string };
  landingUrl?: string | null;
  pdfUrl?: string | null;
  type?: string | null;
  published?: string | null;
}
export interface FeedItem {
  id: string;
  work: FeedWork;
  published?: string | null;
  foundAt: number;
  read: boolean;
  saved: boolean;
  dismissed: boolean;
  sourceId?: string | null;
  added: boolean;
  inLibrary?: string | null;
  subscriptions: string[];
  subscriptionIds: string[];
  /** Saved by the user from somewhere (not brought by a feed). */
  origin?: { kind: string; label?: string | null; query?: string | null; sourceId?: string | null; url?: string | null; at?: number } | null;
}
export interface ItemPage {
  items: FeedItem[];
  total: number;
  nextOffset: number | null;
  unread: number;
  saved: number;
}

export const KIND_LABEL: Record<FeedKind, string> = {
  rss: "Feed",
  openalex: "Search alert",
  author: "Author",
  venue: "Journal",
  topic: "Topic",
  citing: "Citation alert",
  pubmed: "PubMed search",
};
/** Headings for the list of what is followed, grouped by kind. */
export const KIND_GROUP: Record<FeedKind, string> = {
  venue: "Journals",
  author: "People",
  topic: "Topics",
  openalex: "Search alerts",
  pubmed: "PubMed searches",
  citing: "Citation alerts",
  rss: "Feeds and listings",
};
export const KIND_ORDER: FeedKind[] = ["venue", "author", "topic", "openalex", "pubmed", "citing", "rss"];
export const FEED_KIND_ICON: Record<FeedKind, IconName> = {
  rss: "feed",
  openalex: "search",
  author: "person",
  venue: "journal",
  topic: "topic",
  citing: "quote",
  pubmed: "search",
};

/** Why an item is in the Inbox, in a sentence. */
export function whyHere(item: FeedItem, subscriptions: Subscription[]) {
  if (item.origin) return `You saved it from ${item.origin.label || "elsewhere in Key"}${item.origin.at ? ` on ${new Date(item.origin.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}.`;
  const subs = item.subscriptionIds.map((id) => subscriptions.find((s) => s.id === id)).filter((s): s is Subscription => !!s);
  if (!subs.length) return item.subscriptions.length ? `It came from ${item.subscriptions.join(", ")}.` : "";
  const first = subs[0];
  const reason: Record<FeedKind, string> = {
    venue: `It is new in ${first.title}, a journal you follow`,
    author: `It is new work by ${first.title}, whom you follow`,
    topic: `It is new in the topic ${first.title}, which you follow`,
    openalex: `It is a new result for your search alert “${first.title}”`,
    pubmed: `It is a new result for your ${first.title}`,
    citing: `It cites works in ${first.title.replace(/^Citing /, "")}`,
    rss: `It is new in the feed ${first.title}`,
  };
  const more = subs.length > 1 ? `; ${subs.length - 1} more of what you follow found it too` : "";
  return `${reason[first.kind]}${more}.`;
}

/** Something about feeds changed (a follow, triage): counts and lists read again. */
export const feedsChanged = () => window.dispatchEvent(new Event("key:feeds-changed"));
export function onFeedsChanged(callback: () => void) {
  window.addEventListener("key:feeds-changed", callback);
  return () => window.removeEventListener("key:feeds-changed", callback);
}

const seenKey = (workspaceId: string) => `key.inbox.seen:${workspaceId}`;
function seenAt(workspaceId: string) {
  try {
    return Number(localStorage.getItem(seenKey(workspaceId))) || Date.now();
  } catch {
    return Date.now();
  }
}
/** The Inbox was looked at: the status bar's "new" count starts again. */
export function markInboxSeen(workspaceId: string) {
  try {
    localStorage.setItem(seenKey(workspaceId), String(Date.now()));
  } catch {
    /* per-viewer convenience only */
  }
  window.dispatchEvent(new Event("key:inbox-seen"));
}

export interface FeedCounts {
  unread: number;
  /** Unread and found since the Inbox was last looked at. */
  fresh: number;
  subscriptions: number;
}
/** Unread items and the new ones, read every minute and after any change. */
export function useFeedCounts(invoke: Invoke, workspaceId?: string): FeedCounts | undefined {
  const [counts, setCounts] = useState<FeedCounts>();
  useEffect(() => {
    if (!workspaceId) return setCounts(undefined);
    let live = true;
    // The first time, nothing counts as new.
    try {
      if (!localStorage.getItem(seenKey(workspaceId))) localStorage.setItem(seenKey(workspaceId), String(Date.now()));
    } catch {
      /* ignore */
    }
    const read = () =>
      void invoke<FeedCounts>("feeds_counts", { since: seenAt(workspaceId) }, workspaceId)
        .then((c) => live && setCounts(c))
        .catch(() => {});
    read();
    const timer = setInterval(read, 60_000);
    const off = onFeedsChanged(read);
    window.addEventListener("key:inbox-seen", read);
    return () => {
      live = false;
      clearInterval(timer);
      off();
      window.removeEventListener("key:inbox-seen", read);
    };
  }, [invoke, workspaceId]);
  return counts;
}

/** The status bar says nothing unless new items came in. */
export function inboxStatusItem(counts?: FeedCounts): StatusItem | undefined {
  if (!counts?.fresh) return undefined;
  return { id: "inbox", label: `${counts.fresh} new in Inbox`, icon: "inbox", priority: 35, title: `${counts.fresh} new ${counts.fresh === 1 ? "item" : "items"} from your feeds and alerts. Click to open the Inbox.` };
}

export const openInbox = (workspaceId?: string) => void (window as unknown as { key: { tabAction(a: string, p?: unknown): Promise<unknown> } }).key.tabAction("open-content", { section: "inbox", workspaceId });

/** Follows something; answers the subscription (an existing one when already followed). */
export async function follow(invoke: Invoke, workspaceId: string, kind: FeedKind, title: string, config: Record<string, unknown>) {
  const out = await invoke<{ subscription: Subscription; added: number; existed: boolean; error?: string | null }>("feeds_subscribe", { kind, title, config }, workspaceId);
  feedsChanged();
  const what = out.subscription.title;
  if (out.error) toast(`Following ${what}. ${out.error}`);
  else if (out.existed) toast(`Already following ${what}`);
  else toast(out.added ? `Following ${what}: ${out.added} ${out.added === 1 ? "item" : "items"} in the Inbox` : `Following ${what}`, undefined, { label: "Open Inbox", run: () => openInbox(workspaceId) });
  return out.subscription;
}

/** A "Follow" toggle: follows, or (once following) stops after the user confirms by a second click. */
export function FollowButton({
  invoke,
  workspaceId,
  kind,
  title,
  config,
  label = "Follow",
  following = "Following",
  hint,
}: {
  invoke: Invoke;
  workspaceId: string;
  kind: FeedKind;
  title: string;
  config: Record<string, unknown> | null;
  label?: string;
  following?: string;
  hint?: string;
}) {
  const [current, setCurrent] = useState<Subscription | null>();
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(config);
  useEffect(() => {
    if (!config) return;
    let live = true;
    const read = () =>
      void invoke<Subscription | null>("feeds_find", { kind, config }, workspaceId)
        .then((s) => live && setCurrent(s))
        .catch(() => live && setCurrent(null));
    read();
    const off = onFeedsChanged(read);
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, kind, key]);
  if (!config) return null;
  const on = !!current;
  return (
    <button
      className="kx-page-action kx-follow-button"
      data-following={on || undefined}
      aria-pressed={on}
      disabled={busy || current === undefined}
      title={on ? `In your Inbox's feeds since ${new Date(current!.createdAt).toLocaleDateString()}. Click to stop.` : hint}
      onClick={() => {
        setBusy(true);
        const run = on
          ? invoke("feeds_unsubscribe", { id: current!.id }, workspaceId).then(() => {
              feedsChanged();
              toast(`Stopped following ${current!.title}`);
            })
          : follow(invoke, workspaceId, kind, title, config);
        void run.catch((e) => toast(String(e).replace(/^Error: /, ""))).finally(() => setBusy(false));
      }}
    >
      <Icon name={on ? "check" : "bell"} size={12} /> {on ? following : label}
    </button>
  );
}

/** "3 hours", "1 day": a check interval. */
export function intervalLabel(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? "Once a day" : minutes === 10080 ? "Once a week" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}
/** "about once a day": a check interval in a sentence. */
export const intervalPhrase = (minutes: number) => `about ${intervalLabel(minutes).toLowerCase()}`;
/** The interval a new subscription starts with: feeds change more often than catalogues. */
export const defaultInterval = (kind: FeedKind) => (kind === "rss" ? 180 : 720);

/** "About 4 new items a week": how often something posts, from a preview. */
export function cadence(preview: { perWeek?: number | null; perYear?: number | null; count?: number; items: unknown[] }, noun = "articles") {
  const week = preview.perWeek;
  if (week == null) return preview.items.length ? "" : `No new ${noun} in the last year`;
  if (week >= 1.5) return `About ${Math.round(week)} new ${noun} a week`;
  if (week >= 0.6) return `About one new item a week`;
  const month = week * 52 / 12;
  if (month >= 1.5) return `About ${Math.round(month)} new ${noun} a month`;
  const year = preview.perYear ?? Math.round(week * 52);
  return year ? `About ${year} new ${noun} a year` : `No new ${noun} in the last year`;
}
export const INTERVALS = [60, 180, 360, 720, 1440, 10080];
