// The search window (⌘P Open Quickly, ⌘⇧F Search, ⌘K Commands): sized to the app window,
// results grouped by kind on the left and the highlighted one in full on the right. It
// uses the library's own search field (search-suggest.tsx), so typed filters, suggested
// filter chips and the filter builder behave as everywhere. Web results are asked for only
// with the Web pill on or from the "Search the web for …" row; otherwise nothing leaves
// the Mac. Keyboard first: ↑↓ move, ⇥ applies a suggested filter or jumps to the next
// group, ⌘1–9 jump to a group, ↩ open, ⌥↩ or ⌘↩ beside, ⌘Y (or Space in the list) quick look.
import { DatabasesPill, openDatabaseSearch } from "./db-search-entry";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { GlobalDialog } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import type { Invoke } from "./library-api";
import { filterTerms, queryPattern, Highlight } from "./search-highlight";
import { KIND_LABEL, kindOf, useFind, type FindKind, type FindState } from "./global-search";
import { KindChips } from "./SearchPage";
import SearchField from "./search-suggest";
import { FoundHit, byItem, type ItemGroup } from "./search-results";
import type { Found } from "./unified-search";
import type { Command } from "./Palette";
import { fuzzyScore } from "./note-editor/fuzzy";
import { openItemAt, toast } from "./item-actions";
import { quickLook, useItemInfo, ItemHeader, ItemBody } from "./item-ui";
import { useWebSearch, openWebLink, errorText, type WebHit, type WebSearchState } from "./web-search";
import { useWebAdd, WebAddButton, type WebAdd } from "./WebAddButton";
import { WebPill, copyCitation, webLink } from "./WebResults";
import { shortAuthors, snippetOf } from "../shared/web-search";
import { Snippet } from "./search-highlight";
import "./palette.css";
import "./search-popup.css";

type Row =
  | { type: "command"; key: string; command: Command }
  | { type: "item"; key: string; group: ItemGroup }
  | { type: "web"; key: string; hit: WebHit }
  | { type: "ask-web"; key: string }
  | { type: "recent"; key: string; text: string };
interface Group {
  id: string;
  label: string;
  icon: IconName;
  rows: Row[];
  note?: ReactNode;
}

const GROUP_ICON: Record<FindKind, IconName> = { source: "book", note: "note", highlight: "highlight", record: "doc", canvas: "canvas" };
// Sources, then what the user wrote, then the rest.
const KIND_ORDER: FindKind[] = ["source", "note", "highlight", "record", "canvas"];
const OTHER_LABEL: Record<string, string> = { person: "People", venue: "Journals", topic: "Topics", tag: "Tags", journal: "Journals" };

// ── Recents (per workspace, this Mac only) ───────────────────────────────────

interface Recents {
  searches: string[];
  opened: Found[];
}
const RECENTS = (workspaceId: string) => `key.popup.recents:${workspaceId}`;
function readRecents(workspaceId: string): Recents {
  try {
    const value = JSON.parse(localStorage.getItem(RECENTS(workspaceId)) ?? "{}");
    return { searches: Array.isArray(value.searches) ? value.searches.slice(0, 6) : [], opened: Array.isArray(value.opened) ? value.opened.slice(0, 8) : [] };
  } catch {
    return { searches: [], opened: [] };
  }
}
function remember(workspaceId: string, text: string, item?: Found) {
  const recents = readRecents(workspaceId);
  const q = text.trim();
  if (q) recents.searches = [q, ...recents.searches.filter((s) => s !== q)].slice(0, 6);
  if (item) {
    const plain: Found = { kind: item.kind, id: item.id, title: item.title, anchor: item.anchor, byline: item.byline, sourceKind: item.sourceKind } as Found;
    recents.opened = [plain, ...recents.opened.filter((o) => !(o.kind === item.kind && o.id === item.id && o.anchor === item.anchor))].slice(0, 8);
  }
  try {
    localStorage.setItem(RECENTS(workspaceId), JSON.stringify(recents));
  } catch {}
}

const WEB = (workspaceId: string) => `key.popup.web:${workspaceId}`;
const readWeb = (workspaceId: string) => {
  try {
    return localStorage.getItem(WEB(workspaceId)) === "on";
  } catch {
    return false;
  }
};

/** Wide enough for the results and the preview side by side (the popup's own width). */
function useWide(min = 760) {
  const [wide, setWide] = useState(() => Math.min(1100, window.innerWidth * 0.8) >= min);
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= min));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, min]);
  return [wide, setNode] as const;
}

export interface SearchPopupProps {
  invoke: Invoke;
  workspaceId: string;
  label: string;
  placeholder: string;
  /** Kinds and filters it starts with. */
  start: Omit<FindState, "text">;
  commands?: Command[];
  /** Commands lead (⌘K); otherwise they show only when they match. */
  commandsFirst?: boolean;
  onClose: () => void;
  /** Opens the search as a tab (⌘⇧↩). */
  onExpand?: (state: FindState) => void;
}

export default function SearchPopup({ invoke, workspaceId, label, placeholder, start, commands = [], commandsFirst, onClose, onExpand }: SearchPopupProps) {
  const [state, setState] = useState<FindState>({ ...start, text: "" });
  const result = useFind(invoke, workspaceId, state, 12);
  const [webOn, setWebOnState] = useState(() => readWeb(workspaceId));
  const setWebOn = (on: boolean) => {
    setWebOnState(on);
    try {
      localStorage.setItem(WEB(workspaceId), on ? "on" : "off");
    } catch {}
  };
  // "Search the web for …": this query only, without turning the pill on.
  const [webOnce, setWebOnce] = useState<string>();
  const q = state.text.trim();
  const webActive = webOn || (!!webOnce && webOnce === q);
  const web = useWebSearch(invoke, workspaceId, state.text, webActive, state.filters);
  const collectionId = state.filters.find((f) => f.field === "collection")?.value;
  const adder = useWebAdd(web, invoke, workspaceId, collectionId);
  const [recents] = useState(() => readRecents(workspaceId));
  const [active, setActive] = useState(0);
  const [focusList, setFocusList] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [wide, measure] = useWide();
  const terms = filterTerms(state.filters);
  const pattern = useMemo(() => queryPattern(state.text, terms), [state.text, terms]);
  const empty = !q && !state.filters.length;

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    const scored = q
      ? commands
          .map((c) => [c, fuzzyScore(q, `${c.label} ${c.keywords ?? ""}`)] as const)
          .filter(([, s]) => s > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([c]) => c)
      : commandsFirst
        ? commands
        : [];
    const shownCommands = scored.slice(0, commandsFirst ? 14 : 4);
    if (shownCommands.length) out.push({ id: "commands", label: "Commands", icon: "gear", rows: shownCommands.map((command) => ({ type: "command", key: `command:${command.id}`, command })) });
    if (empty && !commandsFirst) {
      if (recents.searches.length) out.push({ id: "recent-searches", label: "Recent searches", icon: "clock", rows: recents.searches.map((text) => ({ type: "recent", key: `recent:${text}`, text })) });
      if (recents.opened.length) out.push({ id: "recent-opened", label: "Recently opened", icon: "clock", rows: byItem(recents.opened).map((group) => ({ type: "item", key: `opened:${group.key}`, group })) });
      return out;
    }
    const all = [...result.found.titles, ...result.found.text, ...result.found.meaning];
    const kinds = [...KIND_ORDER, ...new Set(all.map((f) => kindOf(f)).filter((k) => !KIND_ORDER.includes(k)))];
    for (const kind of kinds) {
      const entries = all.filter((f) => kindOf(f) === kind);
      if (!entries.length) continue;
      out.push({
        id: kind,
        label: KIND_LABEL[kind] ?? OTHER_LABEL[kind] ?? kind,
        icon: GROUP_ICON[kind] ?? "doc",
        rows: byItem(entries)
          .slice(0, kind === "source" ? 12 : 8)
          .map((group) => ({ type: "item", key: group.key, group })),
      });
    }
    if (webActive && q) {
      const loading = web.providers.some((p) => p.status === "loading");
      out.push({
        id: "web",
        label: "On the web",
        icon: "globe",
        rows: web.hits.slice(0, 12).map((hit) => ({ type: "web", key: `web:${hit.key}`, hit })),
        note: loading ? "Searching…" : web.none ? "No web catalogue is on (Settings › Search)" : !web.hits.length ? "Nothing found on the web" : web.providers.map((p) => p.info.label).join(", "),
      });
    } else if (q) {
      out.push({ id: "web", label: "On the web", icon: "globe", rows: [{ type: "ask-web", key: "ask-web" }] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, commands, q, empty, webActive, web.hits, web.providers, commandsFirst]);

  const rows = groups.flatMap((g) => g.rows);
  const groupStarts = groups.reduce<number[]>((starts, g, i) => [...starts, i ? starts[i - 1] + groups[i - 1].rows.length : 0], []);
  const current = rows[Math.min(active, rows.length - 1)];
  useEffect(() => setActive(0), [q, JSON.stringify(state.filters), state.kinds.join()]);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const expand = onExpand && (() => (onClose(), onExpand(state)));
  const openFound = (found: Found, beside: boolean) => {
    remember(workspaceId, state.text, found);
    onClose();
    openItemAt(found, beside ? "split" : "tab", found.title, workspaceId, invoke);
  };
  const activate = (row: Row | undefined, how: { beside?: boolean } = {}) => {
    if (!row) return;
    if (row.type === "command") {
      onClose();
      return row.command.run();
    }
    if (row.type === "item") return openFound(row.group.item, !!how.beside);
    if (row.type === "recent") return setState((s) => ({ ...s, text: row.text }));
    if (row.type === "ask-web") return setWebOnce(q);
    // A web work: open it when it is in the library, otherwise add it.
    if (web.inLibrary[row.hit.key]) {
      remember(workspaceId, state.text);
      onClose();
      return adder.openSource(row.hit, !how.beside);
    }
    void adder.add(row.hit);
  };
  const look = (row: Row | undefined) => row?.type === "item" && quickLook(row.group.item);
  const moveGroup = (step: number) => {
    if (!groups.length) return;
    const at = groupStarts.reduce((found, s, i) => (s <= active ? i : found), 0);
    const next = (at + step + groups.length) % groups.length;
    setActive(groupStarts[next]);
  };
  // Keys from the field (and from the list when it has focus).
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const n = rows.length;
    if (e.key === "ArrowDown" && n) return setActive((i) => (i + 1) % n), true;
    if (e.key === "ArrowUp" && n) return setActive((i) => (i - 1 + n) % n), true;
    if (e.key === "Tab") return moveGroup(e.shiftKey ? -1 : 1), true;
    if (e.metaKey && /^[1-9]$/.test(e.key)) {
      const at = groupStarts[Number(e.key) - 1];
      if (at !== undefined) setActive(at);
      return true;
    }
    if (e.key === "Enter" && e.metaKey && e.shiftKey && expand) return expand(), true;
    if (e.key === "Enter") return activate(current, { beside: e.altKey || e.metaKey }), true;
    if ((e.key === "y" && e.metaKey) || (e.key === " " && (focusList || !state.text))) return look(current), true;
    if (e.key === "Escape") return onClose(), true;
    return false;
  };

  return (
    <GlobalDialog label={label} onClose={onClose}>
      <div ref={measure} className="kx-palette kx-spot" data-wide={wide || undefined} data-modal-view="search-popup" data-no-preview>
        <div className="kx-spot-field">
          <SearchField
            invoke={invoke}
            workspaceId={workspaceId}
            view={{}}
            text={state.text}
            onText={(text) => setState((s) => ({ ...s, text }))}
            filters={state.filters}
            onFilters={(filters) => setState((s) => ({ ...s, filters }))}
            onKinds={(kinds) => setState((s) => ({ ...s, kinds }))}
            busy={result.found.pending}
            inputRef={input}
            label={placeholder}
            placeholder={placeholder}
            menu="inline"
            onSubmit={() => activate(current)}
            onArrowIntoResults={() => setActive(0)}
            onFieldKey={(e) => {
              setFocusList(false);
              const handled = onKey(e);
              if (handled) e.preventDefault();
              return handled;
            }}
          />
        </div>
        <div className="kx-spot-chips">
          <KindChips result={result} kinds={state.kinds} onKinds={(kinds) => setState((s) => ({ ...s, kinds }))} />
          <WebPill pressed={webOn} onClick={() => setWebOn(!webOn)} />
          <DatabasesPill onClick={() => (onClose(), openDatabaseSearch(workspaceId, state.text))} />
          <span className="kx-spacer" />
          {expand && (
            <button type="button" className="kx-palette-expand" title="Open this search in its own tab (⌘⇧↩)" onMouseDown={(e) => e.preventDefault()} onClick={expand}>
              <Icon name="detach" size={12} /> Open in tab
            </button>
          )}
        </div>
        <div className="kx-spot-body">
          <div
            ref={list}
            className="kx-spot-list"
            role="listbox"
            aria-label="Results"
            tabIndex={-1}
            onFocus={() => setFocusList(true)}
            onBlur={() => setFocusList(false)}
            onKeyDown={(e) => {
              if (onKey(e)) e.preventDefault();
              else if (e.key.length === 1 && !e.metaKey) input.current?.focus();
            }}
          >
            {groups.map((group, g) => (
              <section key={group.id} className="kx-spot-group" data-group={group.id} aria-label={group.label}>
                <header className="kx-spot-head">
                  <Icon name={group.icon} size={11} />
                  <span>{group.label}</span>
                  {g < 9 && <kbd>⌘{g + 1}</kbd>}
                  {group.note && <span className="kx-spot-note">{group.note}</span>}
                </header>
                {group.rows.map((row, i) => {
                  const index = groupStarts[g] + i;
                  return (
                    <RowView
                      key={row.key}
                      row={row}
                      index={index}
                      selected={index === active}
                      onActive={setActive}
                      onPick={(beside) => activate(row, { beside })}
                      pattern={pattern}
                      query={q}
                      web={web}
                      adder={adder}
                    />
                  );
                })}
              </section>
            ))}
            {!groups.length && <p className="kx-found-empty">{empty ? "Type to search notes, sources, highlights, canvases and pages" : result.found.pending ? "Searching…" : `Nothing matches “${q}”`}</p>}
          </div>
          {wide && (
            <aside className="kx-spot-preview" aria-label="Preview">
              <Preview row={current} invoke={invoke} workspaceId={workspaceId} pattern={pattern} web={web} adder={adder} query={q} onOpen={(beside) => activate(current, { beside })} />
            </aside>
          )}
        </div>
        <footer className="kx-palette-foot">
          <span>
            <kbd>↩</kbd> open · <kbd>⌥↩</kbd> beside · <kbd>⇥</kbd> {document.activeElement === input.current ? "filter or next group" : "next group"} · <kbd>⌘Y</kbd> quick look
            {expand && (
              <>
                {" "}
                · <kbd>⌘⇧↩</kbd> open as tab
              </>
            )}
          </span>
        </footer>
      </div>
    </GlobalDialog>
  );
}

function RowView({ row, index, selected, onActive, onPick, pattern, query, web, adder }: { row: Row; index: number; selected: boolean; onActive: (i: number) => void; onPick: (beside: boolean) => void; pattern?: RegExp; query: string; web: WebSearchState; adder: WebAdd }) {
  const common = { "data-row": index, "aria-selected": selected, role: "option", onMouseMove: () => !selected && onActive(index) } as const;
  if (row.type === "item")
    return (
      <div data-row={index} className="kx-spot-row kx-spot-row--item">
        <FoundHit group={row.group} index={index} selected={selected} onActive={onActive} compact pattern={pattern} onPick={(_, e) => onPick(e.altKey || e.metaKey)} />
      </div>
    );
  if (row.type === "command")
    return (
      <button type="button" {...common} className="kx-spot-row" onClick={() => onPick(false)}>
        <Icon name={row.command.icon} size={15} />
        <span className="kx-spot-title">{row.command.label}</span>
        {row.command.shortcut && <kbd className="kx-palette-kbd">{row.command.shortcut}</kbd>}
      </button>
    );
  if (row.type === "recent")
    return (
      <button type="button" {...common} className="kx-spot-row" onClick={() => onPick(false)}>
        <Icon name="search" size={14} />
        <span className="kx-spot-title">{row.text}</span>
      </button>
    );
  if (row.type === "ask-web")
    return (
      <button type="button" {...common} className="kx-spot-row" onClick={() => onPick(false)}>
        <Icon name="globe" size={14} />
        <span className="kx-spot-title">
          <span className="kx-spot-name">Search the web for “{query}”</span>
          <span className="kx-spot-sub"> in scholarly catalogues such as OpenAlex. Only the words and filters are sent.</span>
        </span>
      </button>
    );
  const hit = row.hit;
  const inLibrary = !!web.inLibrary[hit.key];
  const possible = !inLibrary && !!web.possible[hit.key];
  return (
    <div {...common} className="kx-spot-row kx-spot-row--web" data-web-key={hit.key} onClick={(e) => (e.target as HTMLElement).closest("button") || onPick(e.altKey)}>
      <Icon name="globe" size={14} />
      <span className="kx-spot-title">
        <span className="kx-spot-name">
          <Highlight text={hit.title} pattern={pattern} />
        </span>
        <span className="kx-spot-sub">{[shortAuthors(hit.authors), hit.venue, hit.year].filter(Boolean).join(" · ")}</span>
      </span>
      {inLibrary ? <span className="kx-spot-badge" data-state="in">In library</span> : possible ? <span className="kx-spot-badge" data-state="possible">Possibly in library</span> : null}
      {!inLibrary && selected && <WebAddButton hit={hit} web={web} adder={adder} />}
    </div>
  );
}

function Preview({ row, invoke, workspaceId, pattern, web, adder, query, onOpen }: { row: Row | undefined; invoke: Invoke; workspaceId: string; pattern?: RegExp; web: WebSearchState; adder: WebAdd; query: string; onOpen: (beside: boolean) => void }) {
  if (!row) return <p className="kx-spot-preview-empty">Nothing selected</p>;
  if (row.type === "item") return <ItemPreview group={row.group} invoke={invoke} workspaceId={workspaceId} pattern={pattern} onOpen={onOpen} />;
  if (row.type === "web") return <WebDetail hit={row.hit} invoke={invoke} workspaceId={workspaceId} web={web} adder={adder} pattern={pattern} query={query} />;
  if (row.type === "command")
    return (
      <div className="kx-spot-preview-plain">
        <Icon name={row.command.icon} size={22} />
        <h2>{row.command.label}</h2>
        {row.command.shortcut && <p>Shortcut: {row.command.shortcut}</p>}
      </div>
    );
  if (row.type === "ask-web")
    return (
      <div className="kx-spot-preview-plain">
        <Icon name="globe" size={22} />
        <h2>Search the web</h2>
        <p>Looks for works you do not have yet in OpenAlex, Semantic Scholar and the other catalogues on in Settings. Turn on Web to search it every time.</p>
      </div>
    );
  return (
    <div className="kx-spot-preview-plain">
      <Icon name="clock" size={22} />
      <h2>{row.text}</h2>
      <p>Press ↩ to search for it again.</p>
    </div>
  );
}

function ItemPreview({ group, invoke, workspaceId, pattern, onOpen }: { group: ItemGroup; invoke: Invoke; workspaceId: string; pattern?: RegExp; onOpen: (beside: boolean) => void }) {
  const info = useItemInfo(invoke, workspaceId, group.item);
  return (
    <div className="kx-spot-item" data-preview-kind={kindOf(group.item)}>
      {info ? (
        <>
          <ItemHeader info={info} />
          <div className="kx-spot-actions">
            <button type="button" className="kx-web-preview-button" onClick={() => onOpen(false)}>
              <Icon name="external" size={12} /> Open
            </button>
            <button type="button" className="kx-web-preview-button" title="Open beside (⌥↩)" onClick={() => onOpen(true)}>
              <Icon name="split" size={12} /> Beside
            </button>
            <button type="button" className="kx-web-preview-button" title="Quick look (⌘Y)" onClick={() => quickLook(group.item)}>
              <Icon name="search" size={12} /> Quick look
            </button>
          </div>
          {group.matches.length > 0 && (
            <ul className="kx-spot-matches">
              {group.matches.slice(0, 6).map((m, i) => (
                <li key={`${m.anchor ?? ""}:${m.passageId ?? i}`}>
                  {m.where && <span className="kx-match-where">{m.where}</span>}
                  {m.snippet && <Snippet snippet={m.snippet} pattern={pattern} />}
                </li>
              ))}
            </ul>
          )}
          <ItemBody info={info} invoke={invoke} workspaceId={workspaceId} size="large" />
        </>
      ) : (
        <p className="kx-spot-preview-empty">Loading…</p>
      )}
    </div>
  );
}

function WebDetail({ hit, invoke, workspaceId, web, adder, pattern, query }: { hit: WebHit; invoke: Invoke; workspaceId: string; web: WebSearchState; adder: WebAdd; pattern?: RegExp; query: string }) {
  const link = webLink(hit);
  const abstract = snippetOf(hit.abstract, 1400);
  const inLibrary = !!web.inLibrary[hit.key];
  return (
    <div className="kx-spot-item kx-spot-web" data-web-key={hit.key}>
      <span className="kx-item-kind">
        <Icon name="globe" size={13} /> On the web
        {inLibrary ? <span className="kx-spot-badge" data-state="in">In library</span> : web.possible[hit.key] ? <span className="kx-spot-badge" data-state="possible">Possibly in library</span> : null}
      </span>
      <h2 className="kx-web-preview-title">
        <Highlight text={hit.title} pattern={pattern} />
      </h2>
      {hit.authors.length > 0 && <p className="kx-spot-authors">{hit.authors.slice(0, 12).join(", ") + (hit.authors.length > 12 ? ` and ${hit.authors.length - 12} more` : "")}</p>}
      <p className="kx-spot-meta">{[hit.venue, hit.year].filter(Boolean).join(" · ")}</p>
      <div className="kx-spot-actions">
        <WebAddButton hit={hit} web={web} adder={adder} large />
        {link && (
          <button type="button" className="kx-web-preview-button" title={`Open ${link} in the browser`} onClick={() => openWebLink(link)}>
            <Icon name="external" size={12} /> Open page
          </button>
        )}
        <button type="button" className="kx-web-preview-button" aria-label="Copy citation" title="Copy citation" onClick={() => void copyCitation(hit)}>
          <Icon name="quote" size={12} />
        </button>
      </div>
      {abstract ? <p className="kx-spot-abstract">{abstract}</p> : <p className="kx-spot-preview-empty">No abstract from the catalogue.</p>}
      {hit.doi && <p className="kx-spot-meta">DOI {hit.doi}</p>}
    </div>
  );
}

