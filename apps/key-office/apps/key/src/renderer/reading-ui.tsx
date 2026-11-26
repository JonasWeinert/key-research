// Reading status in the shell: a small control (unread, in progress, read, or back to
// automatic) for rows, the source page and the reader, and the related-sources section of a
// source page. The host keeps status and history (key-store reading.rs): opening a source
// moves it to "in progress" and reaching its last page to "read", never past a status chosen
// here. Status stays in Key (Zotero sync does not carry it).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "@key-reader/ui/dismiss";
import { ContextMenu } from "./DatabaseView";
import { Icon, type IconName } from "./icons";
import { toast } from "./item-actions";
import { hasItemDrag, readItemDrag } from "./item-links";
import { relativeDate, shortCreators, type Invoke, type Source, type SourcePage } from "./library-api";
import { libraryChanged, onLibraryChanged } from "./library-nav";
import { stepJournal } from "./library-hygiene";
import { SourceListItem } from "./source-list";
import "./entity.css";
import "./reading.css";
import { hintText } from "./help-content";

export type ReadingStatus = "unread" | "reading" | "read";
export const STATUS_LABEL: Record<ReadingStatus, string> = { unread: "Unread", reading: "In progress", read: "Read" };
export const STATUS_ICON: Record<ReadingStatus, IconName> = { unread: "circle", reading: "readHalf", read: "check" };
export const statusOf = (source: Pick<Source, "readState">): ReadingStatus =>
  source.readState === "reading" || source.readState === "read" ? source.readState : "unread";

export interface Reading {
  status: ReadingStatus;
  manual: boolean;
  openedAt?: number | null;
  readAt?: number | null;
  finishedAt?: number | null;
  page?: number | null;
  pagesRead: number;
  pageCount?: number | null;
}

/** Sets (or, with null, gives back to the reader) the status of these sources; undoable. */
export async function setReadingStatus(invoke: Invoke, workspaceId: string, ids: string[], status: ReadingStatus | null) {
  await invoke("store_set_reading_status", { ids, status }, workspaceId);
  libraryChanged();
  const what = ids.length === 1 ? "" : ` ${ids.length} sources`;
  toast(status ? `Marked${what} as ${STATUS_LABEL[status].toLowerCase()}` : `Reading status${what} follows reading again`, () =>
    void stepJournal(invoke, workspaceId, true).then(() => libraryChanged()),
  );
}

/** One source's reading state, read again when the library changes. */
export function useReading(invoke: Invoke, workspaceId: string, id?: string | null) {
  const [reading, setReading] = useState<Reading>();
  const load = useCallback(() => {
    if (!id) return;
    void invoke<Reading>("store_reading", { id }, workspaceId)
      .then(setReading)
      .catch(() => {});
  }, [invoke, workspaceId, id]);
  useEffect(load, [load]);
  useEffect(() => onLibraryChanged(load), [load]);
  return reading;
}

/** The status as a small button with a menu: Unread, In progress, Read, Automatic. */
export function ReadingStatusControl({
  invoke,
  workspaceId,
  ids,
  status,
  manual,
  compact,
  mixed,
}: {
  invoke: Invoke;
  workspaceId: string;
  ids: string[];
  status?: ReadingStatus;
  manual?: boolean;
  /** Only the icon (table rows). */
  compact?: boolean;
  /** Several sources with different statuses (batch edit). */
  mixed?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const label = mixed || !status ? "Mixed" : STATUS_LABEL[status];
  return (
    <>
      <button
        className="kx-reading-status"
        data-status={mixed ? "mixed" : status}
        data-compact={compact || undefined}
        aria-haspopup="menu"
        aria-label={`Reading status: ${label}`}
        title={`${label}${manual ? " (set by you)" : mixed ? "" : " · follows your reading"}. ${hintText("reading.status")} Click to change.`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon name={mixed ? "minus" : STATUS_ICON[status ?? "unread"]} size={12} />
        {!compact && <span>{label}</span>}
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label="Reading status" onClose={() => setMenu(undefined)}>
          {(close) => [
            ...(["unread", "reading", "read"] as ReadingStatus[]).map((s) => (
              <button
                key={s}
                role="menuitemradio"
                aria-checked={!mixed && status === s && !!manual}
                onClick={() => {
                  close();
                  void setReadingStatus(invoke, workspaceId, ids, s).catch((e) => toast(String(e)));
                }}
              >
                <Icon name={STATUS_ICON[s]} size={13} /> {STATUS_LABEL[s]}
              </button>
            )),
            <hr key="rule" />,
            <button
              key="auto"
              role="menuitemradio"
              aria-checked={!mixed && !manual}
              onClick={() => {
                close();
                void setReadingStatus(invoke, workspaceId, ids, null).catch((e) => toast(String(e)));
              }}
            >
              <Icon name="sync" size={13} /> Follow my reading
            </button>,
          ]}
        </ContextMenu>
      )}
    </>
  );
}

/** "Read · last read yesterday · 12 of 20 pages" for a source page. */
export function readingSummary(reading?: Reading) {
  if (!reading) return "";
  const parts: string[] = [];
  if (reading.readAt) parts.push(`last read ${relativeDate(reading.readAt).toLowerCase()}`);
  else if (reading.openedAt) parts.push(`opened ${relativeDate(reading.openedAt).toLowerCase()}`);
  if (reading.pagesRead && reading.pageCount) parts.push(`${Math.min(reading.pagesRead, reading.pageCount)} of ${reading.pageCount} pages seen`);
  return parts.join(" · ");
}

interface Related {
  manual: Source[];
  cites: Source[];
  citedBy: Source[];
  versions: Source[];
}

/** A source page's related sources: linked by hand (add with the picker, or drop a source
 *  here), and those the library knows of: what it cites, what cites it, other versions. */
export function RelatedSources({ invoke, workspaceId, source }: { invoke: Invoke; workspaceId: string; source: Source }) {
  const [picking, setPicking] = useState<DOMRect>();
  const [related, setRelated] = useState<Related>();
  const [dropping, setDropping] = useState(false);
  const load = useCallback(() => {
    void invoke<Related>("store_related", { id: source.id }, workspaceId)
      .then(setRelated)
      .catch(() => {});
  }, [invoke, workspaceId, source.id]);
  useEffect(load, [load]);
  useEffect(() => onLibraryChanged(load), [load]);
  const link = async (other: string, linked = true) => {
    if (other === source.id) return;
    await invoke("store_link_related", { a: source.id, b: other, linked }, workspaceId);
    libraryChanged();
    toast(linked ? "Linked as related" : "No longer related", () => void stepJournal(invoke, workspaceId, true).then(() => libraryChanged()));
  };
  const group = (title: string, list: Source[] | undefined, removable = false, empty?: ReactNode) =>
    (list?.length || empty) && (
      <div className="kx-related-group" key={title}>
        <h3>
          {title}
          {list?.length ? <small>{list.length}</small> : null}
        </h3>
        {list?.length ? (
          <ul className="kx-work-list">
            {list.slice(0, 50).map((s) => (
              <SourceListItem
                key={s.id}
                source={s}
                invoke={invoke}
                workspaceId={workspaceId}
                actions={
                  removable ? (
                    <button className="kx-page-action" onClick={() => void link(s.id, false).catch((e) => toast(String(e)))}>
                      <Icon name="close" size={12} /> Unlink
                    </button>
                  ) : undefined
                }
              />
            ))}
          </ul>
        ) : (
          empty
        )}
      </div>
    );
  return (
    <section
      className="kx-related"
      data-dropping={dropping || undefined}
      aria-label="Related sources"
      onDragOver={(e) => {
        if (hasItemDrag(e.dataTransfer)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const ids = readItemDrag(e.dataTransfer).filter((i) => i.kind === "source" && i.id !== source.id).map((i) => i.id);
        if (!ids.length) return;
        e.preventDefault();
        void Promise.all(ids.map((id) => link(id))).catch((err) => toast(String(err)));
      }}
    >
      <header className="kx-related-head">
        <h2>Related</h2>
        <button className="kx-page-action" aria-expanded={!!picking} onClick={(e) => setPicking(e.currentTarget.getBoundingClientRect())}>
          <Icon name="plus" size={12} /> Add related…
        </button>
      </header>
      {picking && (
        <SourcePicker
          invoke={invoke}
          workspaceId={workspaceId}
          anchor={picking}
          exclude={[source.id, ...(related?.manual.map((s) => s.id) ?? [])]}
          onPick={(id) => {
            setPicking(undefined);
            void link(id).catch((e) => toast(String(e)));
          }}
          onClose={() => setPicking(undefined)}
        />
      )}
      {group("Linked by you", related?.manual, true, <p className="kx-related-hint">Drop a source here, or use Add related…, to link it both ways.</p>)}
      {group("Cites, in your library", related?.cites)}
      {group("Cited by, in your library", related?.citedBy)}
      {group("Other versions", related?.versions)}
    </section>
  );
}

/** Finds a source by its title, authors or identifiers, as you type. */
function SourcePicker({ invoke, workspaceId, anchor, exclude, onPick, onClose }: { invoke: Invoke; workspaceId: string; anchor: DOMRect; exclude: string[]; onPick: (id: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState<Source[]>([]);
  const [at, setAt] = useState(0);
  useDismiss(true, { refs: [box], onDismiss: onClose });
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void invoke<SourcePage>("store_sources", { text: text.trim() || null, limit: 12, sort: text.trim() ? "title" : "updated", descending: !text.trim() }, workspaceId)
          .then((page) => {
            if (!live) return;
            setFound(page.items.filter((s) => !exclude.includes(s.id)).slice(0, 8));
            setAt(0);
          })
          .catch(() => {}),
      120,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, text]);
  return createPortal(
    <div ref={box} className="kx-menu-popover kx-related-picker" role="dialog" aria-label="Add a related source" style={{ left: Math.max(8, Math.min(anchor.left, innerWidth - 368)), top: anchor.bottom + 4 }}>
      <input
        autoFocus
        className="kx-related-picker-field"
        placeholder="Find a source"
        aria-label="Find a source"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setAt((i) => Math.min(found.length - 1, i + 1));
          else if (e.key === "ArrowUp") setAt((i) => Math.max(0, i - 1));
          else if (e.key === "Enter" && found[at]) onPick(found[at].id);
          else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
        }}
      />
      {found.map((s, i) => (
        <button key={s.id} role="option" aria-selected={i === at} onMouseEnter={() => setAt(i)} onClick={() => onPick(s.id)}>
          <span className="kx-related-picker-title">{s.title || "Untitled"}</span>
          <small>{[shortCreators(s.creators), s.year].filter(Boolean).join(" · ")}</small>
        </button>
      ))}
      {!found.length && <p className="kx-related-picker-empty">No sources found</p>}
    </div>,
    document.body,
  );
}
