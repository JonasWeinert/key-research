// The note's library: a quiet button at the top of a note opens a panel docked on its left
// with the workspace search (the search tab's field, kind chips and result rows, compact),
// listing every reference when nothing is typed. A click or Enter puts the result in at the
// cursor: a source as a citation, a highlight or a passage as a quote, anything else as a
// link. Rows drag into the note too. The panel stays open while you insert several.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EMPTY_FIND, kindOf, useFind, type FindKind, type FindResult, type FindState } from "./global-search";
import { Icon } from "./icons";
import { describeItem, openItemAt } from "./item-actions";
import { shortCreators, type Invoke, type Source, type SourcePage } from "./library-api";
import { CITE_DRAG_TYPE, QUOTE_DRAG_TYPE, setItemDrag, type DraggedItem, type NoteEditorHandle, type QuoteInsert, type SourceRef } from "./note-editor";
import { filterTerms, queryPattern } from "./search-highlight";
import { FoundHit, byItem, type ItemGroup } from "./search-results";
import SearchField from "./search-suggest";
import { KindChips } from "./SearchPage";
import type { Found } from "./unified-search";
import "./search-page.css";
import "./note-library.css";

/** ⇧⌘L: opens the panel (or goes back to it), and closes it from inside. */
export const LIBRARY_SHORTCUT = "⇧⌘L";
export const isLibraryShortcut = (e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "l";

const KINDS: FindKind[] = ["source", "highlight", "note"];
const START: FindState = { ...EMPTY_FIND, kinds: ["source"] };
const WIDTH = "key.note.library.width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

const byline = (source: Pick<Source, "creators" | "year">) => [shortCreators(source.creators), source.year].filter(Boolean).join(" · ") || undefined;
const sourceGroup = (source: Source): ItemGroup => ({
  key: `source:${source.id}`,
  item: { kind: "source", id: source.id, title: source.title || "Untitled", sourceKind: source.kind, detail: source.kind, group: "titles", byline: byline(source) },
  matches: [],
});

/** Every reference in the workspace, newest first, loaded a page at a time. */
function useLibrary(invoke: Invoke, workspaceId: string, active: boolean) {
  const [sources, setSources] = useState<Source[]>();
  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      const all: Source[] = [];
      let offset: number | null = 0;
      while (offset !== null && current) {
        const page: SourcePage = await invoke<SourcePage>("store_sources", { limit: 400, offset, sort: "added", descending: true }, workspaceId).catch(() => ({ items: [], total: 0, nextOffset: null }) as unknown as SourcePage);
        all.push(...page.items);
        if (current) setSources([...all]);
        offset = page.nextOffset;
      }
    })();
    return () => {
      current = false;
    };
  }, [invoke, workspaceId, active]);
  return sources;
}

/** Authors · year for sources a title search found (it only knows their titles). */
function useBylines(invoke: Invoke, workspaceId: string, ids: string[]) {
  const [known, setKnown] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const key = ids.join();
  useEffect(() => {
    for (const id of ids) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void invoke<Source | null>("store_source", { id }, workspaceId)
        .then((source) => source && setKnown((k) => ({ ...k, [id]: byline(source) ?? "" })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, invoke, workspaceId]);
  return known;
}

/** The sentence of a passage that holds the match (with the next one when it is short). */
export function quoteText(found: Pick<Found, "passageText" | "snippet">): string {
  const snippet = (found.snippet ?? "").replace(/\[\[|\]\]/g, "").replace(/^…\s*|\s*…$/g, "").trim();
  const text = found.passageText?.replace(/\s+/g, " ").trim();
  if (!text) return snippet;
  const term = /\[\[(.+?)\]\]/.exec(found.snippet ?? "")?.[1]?.toLowerCase();
  const sentences = text.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const at = term ? sentences.findIndex((s) => s.toLowerCase().includes(term)) : -1;
  if (at < 0) return snippet || sentences[0];
  let quote = sentences[at];
  if (quote.length < 90 && sentences[at + 1]) quote += ` ${sentences[at + 1]}`;
  return quote.length > 700 ? `${quote.slice(0, 697).trimEnd()}…` : quote;
}

const pageOf = (found: Found) => (found.anchor?.startsWith("page:") ? Number(found.anchor.slice(5)) : undefined);
const isPassage = (found: Found) => found.kind === "source" && !!(found.passageId || found.snippet) && !found.anchor?.startsWith("highlight:") && found.group !== "titles";

export function NoteLibraryPanel({
  invoke,
  workspaceId,
  editor,
  onClose,
  searchRef,
}: {
  invoke: Invoke;
  workspaceId: string;
  editor: RefObject<NoteEditorHandle | null>;
  onClose: () => void;
  searchRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [state, setState] = useState<FindState>(START);
  const browsing = !state.text.trim() && !state.filters.length && state.kinds.length === 1 && state.kinds[0] === "source";
  const library = useLibrary(invoke, workspaceId, true);
  const result = useFind(invoke, workspaceId, state, 30);
  const terms = filterTerms(state.filters);
  const pattern = useMemo(() => queryPattern(state.text, terms), [state.text, terms]);
  const [current, setCurrent] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    try {
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(localStorage.getItem(WIDTH)) || 300));
    } catch {
      return 300;
    }
  });

  const groups: ItemGroup[] = useMemo(
    () => (browsing ? (library ?? []).map(sourceGroup) : byItem([...result.found.titles, ...result.found.text, ...result.found.meaning])),
    [browsing, library, result],
  );
  const missing = groups.filter((g) => g.item.kind === "source" && !g.item.anchor && !g.item.byline).map((g) => g.item.id);
  const bylines = useBylines(invoke, workspaceId, missing);
  // The chips count the whole library while it is listed.
  const chips: FindResult = browsing && library ? { ...result, counts: { ...result.counts, source: library.length } } : result;

  useEffect(() => setCurrent(-1), [state.text, state.kinds.join(), JSON.stringify(state.filters)]);
  useEffect(() => {
    if (current >= groups.length) setCurrent(groups.length - 1);
  }, [groups.length, current]);

  const virtual = useVirtualizer({
    count: groups.length,
    getScrollElement: () => list.current,
    estimateSize: (i) => (groups[i]?.matches.length ? 104 : 52),
    overscan: 8,
    getItemKey: (i) => groups[i]?.key ?? i,
  });
  useEffect(() => {
    if (current >= 0) virtual.scrollToIndex(current, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  /** Puts `entry` in the note: a source cites, a highlight or a passage quotes, the rest link. */
  const insert = async (entry: Found, stay = false) => {
    const handle = editor.current;
    if (!handle) return;
    const highlight = entry.anchor?.startsWith("highlight:");
    if (highlight) {
      const info = await describeItem(invoke, workspaceId, { kind: "source", id: entry.id, anchor: entry.anchor }).catch(() => undefined);
      handle.insertQuote({ source: entry.id, page: info?.highlight?.page ?? null, color: info?.highlight?.color ?? entry.color ?? null, text: info?.highlight?.text || entry.title });
    } else if (isPassage(entry)) {
      handle.insertQuote({ source: entry.id, page: pageOf(entry) ?? null, text: quoteText(entry) });
    } else if (entry.kind === "source") {
      const detail = entry.byline ?? bylines[entry.id];
      const ref: SourceRef = { id: entry.id, title: entry.title, detail: detail?.replace(" · ", " "), kind: entry.sourceKind };
      handle.insertReference(ref, "cite");
    } else {
      handle.insertReference({ id: entry.id, title: entry.title, itemKind: entry.kind, anchor: entry.anchor, color: entry.color }, "link");
    }
    // Shift-Enter keeps going in the list; otherwise the cursor is back in the note, after it.
    if (stay) requestAnimationFrame(() => list.current?.focus());
  };
  const openInTab = (entry: Found) => openItemAt(entry, "tab", entry.title, workspaceId, invoke);
  // As in the search tab, a row found by its text stands for the passage found.
  const pick = (group: ItemGroup | undefined, stay = false) => group && void insert(group.matches.find(isPassage) ?? group.item, stay);

  const dragItem = (entry: Found): DraggedItem => ({ kind: entry.kind, id: entry.id, anchor: entry.anchor, title: entry.title, detail: entry.anchor?.startsWith("highlight:") ? entry.detail : entry.sourceKind, color: entry.color });

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setCurrent((i) => Math.min(groups.length - 1, i + 1));
    else if (e.key === "ArrowUp") {
      if (current <= 0) {
        setCurrent(-1);
        searchRef.current?.focus();
      } else setCurrent((i) => i - 1);
    } else if (e.key === "Home") setCurrent(groups.length ? 0 : -1);
    else if (e.key === "End") setCurrent(groups.length - 1);
    else if (e.key === "Enter" && groups[current]) {
      if (e.metaKey || e.ctrlKey) openInTab(groups[current].item);
      else pick(groups[current], e.shiftKey);
    } else return;
    e.preventDefault();
  };

  // Drag the right edge to resize; the width is remembered.
  const resize = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const from = width;
    let next = from;
    const move = (m: PointerEvent) => {
      next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, from + m.clientX - start));
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(WIDTH, String(next));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useLayoutEffect(() => {
    searchRef.current?.focus();
  }, [searchRef]);

  const empty = browsing ? (library ? (library.length ? null : "No references yet. Add PDFs, links or a Zotero library.") : null) : !groups.length && !result.found.pending ? "Nothing matches" : null;
  const active = groups[current];

  return (
    <aside
      id="kx-note-library"
      className="kx-note-library"
      aria-label="Library"
      style={{ "--kx-library-width": `${width}px` } as CSSProperties}
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape") return;
        // The search field clears itself first; an empty one (or anywhere else) closes the panel.
        const inField = e.target === searchRef.current && (state.text || state.filters.length);
        if (inField) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="kx-note-library-head">
        <span className="kx-note-library-title">
          <Icon name="books" size={14} />
          Library
        </span>
        <button type="button" className="kx-icon-button" aria-label="Close the library" title={`Close (Esc or ${LIBRARY_SHORTCUT})`} onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </header>
      <div className="kx-note-library-search">
        <SearchField
          invoke={invoke}
          workspaceId={workspaceId}
          view={{}}
          text={state.text}
          onText={(text) => setState((s) => ({ ...s, text }))}
          filters={state.filters}
          onFilters={(filters) => setState((s) => ({ ...s, filters }))}
          busy={!browsing && result.found.pending}
          inputRef={searchRef}
          label="Search the library"
          placeholder="Search references, highlights, notes"
          onSubmit={() => pick(groups[Math.max(0, current)])}
          onArrowIntoResults={() => {
            if (!groups.length) return;
            setCurrent(0);
            list.current?.focus();
          }}
        />
        <div className="kx-note-library-chips">
          <KindChips result={chips} kinds={state.kinds} only={KINDS} onKinds={(kinds) => setState((s) => ({ ...s, kinds }))} />
        </div>
      </div>
      <div
        ref={list}
        className="kx-note-library-results"
        role="listbox"
        aria-label={browsing ? "References" : "Results"}
        aria-activedescendant={active ? `kx-note-library-${current}` : undefined}
        tabIndex={-1}
        onKeyDown={onListKey}
        onFocus={() => current < 0 && groups.length && setCurrent(0)}
      >
        {empty ? (
          <p className="kx-found-empty">{empty}</p>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((row) => {
              const group = groups[row.index];
              const entry = group.item;
              const quoteDrag = (match: Found, e: React.DragEvent) => {
                const quote: QuoteInsert = { source: match.id, page: pageOf(match) ?? null, text: quoteText(match) };
                setItemDrag(e.dataTransfer, [dragItem({ ...match, title: entry.title })]);
                e.dataTransfer.setData(QUOTE_DRAG_TYPE, JSON.stringify(quote));
                e.dataTransfer.effectAllowed = "copy";
              };
              return (
                <div key={row.key} role="presentation" data-index={row.index} ref={virtual.measureElement} className="kx-note-library-row" style={{ transform: `translateY(${row.start}px)` }}>
                  <FoundHit
                    id={`kx-note-library-${row.index}`}
                    group={group}
                    index={row.index}
                    selected={row.index === current}
                    onActive={setCurrent}
                    compact
                    pattern={pattern}
                    byline={entry.byline ?? bylines[entry.id] ?? (entry.anchor?.startsWith("highlight:") ? entry.where : entry.kind !== "source" ? entry.where : undefined)}
                    titleHint={kindOf(entry) === "source" ? "Insert a citation (⌘-click: open in a tab)" : kindOf(entry) === "highlight" ? "Insert as a quote (⌘-click: open in a tab)" : "Insert a link (⌘-click: open in a tab)"}
                    onPick={(found, e) => (e.metaKey || e.ctrlKey ? openInTab(found) : void insert(found === entry ? entry : found, e.shiftKey))}
                    onDragStart={(e) => {
                      setItemDrag(e.dataTransfer, [dragItem(entry)]);
                      if (entry.kind === "source") e.dataTransfer.setData(CITE_DRAG_TYPE, "1");
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onMatchDragStart={(match, e) => (isPassage(match) ? quoteDrag(match, e) : setItemDrag(e.dataTransfer, [dragItem(match)]))}
                    actions={
                      <button type="button" className="kx-note-library-open" tabIndex={-1} aria-label={`Open ${entry.title} in a tab`} title="Open in a tab (⌘↩)" onClick={() => openInTab(entry)}>
                        <Icon name="external" size={12} />
                      </button>
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <footer className="kx-note-library-foot">↩ insert · ⇧↩ insert and stay · ⌘↩ open</footer>
      <div className="kx-note-library-resize" role="separator" aria-orientation="vertical" aria-label="Resize the library" onPointerDown={resize} />
    </aside>
  );
}

/** The button at the top left of a note: there while you look for it, faded while you write. */
export function LibraryButton({ open, awake, onToggle, buttonRef }: { open: boolean; awake: boolean; onToggle: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="kx-library-fab"
      data-awake={awake || open}
      aria-label="Library"
      aria-expanded={open}
      aria-controls={open ? "kx-note-library" : undefined}
      aria-keyshortcuts="Meta+Shift+L"
      title={`${open ? "Close the library" : "Find and insert references"} (${LIBRARY_SHORTCUT})`}
      onClick={onToggle}
    >
      <Icon name="books" size={15} />
    </button>
  );
}

/** Wakes the button when the pointer comes near it and lets it fade while you type or rest. */
export function useFadingButton(buttonRef: RefObject<HTMLButtonElement | null>, open: boolean) {
  const [awake, setAwake] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rest = (delay = 2400) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwake(false), delay);
  };
  useEffect(() => {
    rest();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!open) rest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return {
    awake,
    onPointerMove: (e: React.PointerEvent) => {
      const box = buttonRef.current?.getBoundingClientRect();
      if (!box) return;
      const near = Math.hypot(Math.max(box.left - e.clientX, 0, e.clientX - box.right), Math.max(box.top - e.clientY, 0, e.clientY - box.bottom)) < 140;
      if (!near) return;
      setAwake(true);
      rest();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      // Typing in the note puts it to rest at once.
      if ((e.target as HTMLElement).closest?.(".ProseMirror, .kx-note-title") && !e.metaKey && !e.ctrlKey) {
        clearTimeout(timer.current);
        setAwake(false);
      }
    },
  };
}
