// The sidebar's Inbox row, under Library: opens the Inbox, with a quiet count of unread items.
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { useFeedCounts } from "./feeds-ui";
import "./inbox.css";

export function InboxRow({ invoke, workspaceId, current, onOpen }: { invoke: Invoke; workspaceId: string; current: boolean; onOpen: () => void }) {
  const counts = useFeedCounts(invoke, workspaceId);
  const unread = counts?.unread ?? 0;
  return (
    <nav className="kx-tree kx-inbox-tree" aria-label="Inbox">
      <div className="kx-tree-row kx-inbox-row" data-current={current} style={{ paddingLeft: "min(2px, 40%)" }}>
        <span className="kx-tree-disclosure" aria-hidden="true" />
        <button className="kx-tree-label" aria-current={current ? "page" : undefined} title="New works from the feeds and alerts you follow" onClick={onOpen}>
          <Icon name="inbox" />
          <span>Inbox</span>
          <small aria-label={unread ? `${unread} unread` : undefined}>{unread ? unread.toLocaleString() : ""}</small>
        </button>
      </div>
    </nav>
  );
}
