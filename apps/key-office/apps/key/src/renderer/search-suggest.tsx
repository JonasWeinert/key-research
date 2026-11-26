// The library search field: free text plus filter tokens, with suggestions as you type
// (people, journals, tags, collections, years, property values, then "… contains")
// in the manner of Apple Mail. Tokens all apply; free text then searches within them.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "./icons";
import type { Invoke } from "./library-api";
import { Highlight, prefixPattern } from "./search-highlight";
import { useDismiss } from "@key-reader/ui/dismiss";
import { parseQuery, type DetectedKind, type Detection } from "./smart-query";

export interface SearchFilter {
  /** creator | container | title | notes | fulltext | tag | collection | year | property */
  field: string;
  op?: "is" | "contains" | "gt" | "gte" | "lt" | "lte";
  value: string;
  /** The property name, for `field = "property"`. */
  key?: string;
  /** What the token shows, e.g. a collection's name rather than its id. */
  label: string;
}
interface Suggestion {
  filter: Omit<SearchFilter, "label">;
  label: string;
  count: number;
}
interface MenuItem {
  key: string;
  filters: SearchFilter[];
  icon: IconName;
  content: ReactNode;
  count?: number;
  /** A reading of the query (smart-query.ts): the text left to search, and kinds to show. */
  detected?: { rest: string; kinds?: DetectedKind[] };
}

const FIELD: Record<string, { label: string; icon: IconName }> = {
  creator: { label: "Author", icon: "user" },
  container: { label: "Journal", icon: "book" },
  title: { label: "Title", icon: "doc" },
  notes: { label: "Notes", icon: "note" },
  fulltext: { label: "Full text", icon: "search" },
  tag: { label: "Tag", icon: "tag" },
  collection: { label: "Collection", icon: "folder" },
  year: { label: "Year", icon: "clock" },
  property: { label: "Property", icon: "list" },
  itemType: { label: "Item type", icon: "doc" },
  kind: { label: "Kind", icon: "doc" },
  abstract: { label: "Abstract", icon: "doc" },
  person: { label: "Author", icon: "user" },
  venue: { label: "Journal", icon: "book" },
  publisher: { label: "Publisher", icon: "book" },
  institution: { label: "Institution", icon: "home" },
  topic: { label: "Topic", icon: "tag" },
  keyword: { label: "Keyword", icon: "tag" },
  funder: { label: "Funder", icon: "star" },
  citations: { label: "Citations", icon: "quote" },
  retracted: { label: "Retracted", icon: "info" },
  oaStatus: { label: "Open access", icon: "globe" },
  workType: { label: "Work type", icon: "doc" },
  language: { label: "Language", icon: "globe" },
  // "Only in" one note, canvas, page or source (the search tab's sidebar picks).
  item: { label: "Only in", icon: "pin" },
  // Identifiers, read from a pasted DOI, link or number (smart-query.ts).
  doi: { label: "DOI", icon: "link" },
  arxiv: { label: "arXiv", icon: "link" },
  pmid: { label: "PubMed", icon: "link" },
  pmcid: { label: "PMC", icon: "link" },
  isbn: { label: "ISBN", icon: "book" },
  url: { label: "Link", icon: "globe" },
};
const KIND_NAME: Record<DetectedKind, string> = { source: "Sources", note: "Notes", record: "Pages", canvas: "Canvases", highlight: "Highlights" };
// Specific matches come first, in this order; a typed year leads.
const ORDER = ["year", "citations", "creator", "container", "topic", "keyword", "tag", "collection", "funder", "property"];
const CONTAINS: [string, string][] = [
  ["creator", "Author contains"],
  ["title", "Title contains"],
  ["container", "Journal contains"],
  ["notes", "Notes contain"],
  ["fulltext", "Full text contains"],
];

export const filterKey = (f: Pick<SearchFilter, "field" | "op" | "value" | "key">) => `${f.field}:${f.op ?? "contains"}:${f.key ?? ""}:${f.value.toLowerCase()}`;
/** Filters as the store takes them (no display label, no search-tab item picks). */
export const storeFilters = (filters: SearchFilter[]) => filters.filter((f) => f.field !== "item").map(({ field, op, value, key }) => ({ field, op, value, key }));

export default function SearchField({
  invoke,
  workspaceId,
  view,
  text,
  onText,
  filters,
  onFilters,
  busy,
  inputRef,
  onSubmit,
  onArrowIntoResults,
  label = "Search the library",
  placeholder = "Search titles, authors, notes and full text",
  onKinds,
  tokenNote,
}: {
  invoke: Invoke;
  workspaceId: string;
  /** The current scope, collection, kind and tag, so counts match what the user sees. */
  view: Record<string, unknown>;
  text: string;
  onText: (text: string) => void;
  filters: SearchFilter[];
  onFilters: (filters: SearchFilter[]) => void;
  busy?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onArrowIntoResults: () => void;
  label?: string;
  placeholder?: string;
  /** Where kinds of items can be shown (the search tab): "notes" etc. are read as kinds. */
  onKinds?: (kinds: DetectedKind[]) => void;
  /** Why a token is not applied right now (the search tab while only the web is searched);
   *  it stays in the query, shown greyed. */
  tokenNote?: (filter: SearchFilter) => string | undefined;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [index, setIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const typed = text.trim();

  // The host's reading of the query (identifiers, years, citations, kinds, the workspace's
  // tag and collection names). A short debounce: it answers in a millisecond or two.
  const [parsed, setParsed] = useState<{ text: string; detections: Detection[] }>({ text: "", detections: [] });
  const wantsKinds = !!onKinds;
  useEffect(() => {
    if (typed.length < 3) return setParsed({ text: typed, detections: [] });
    let live = true;
    const t = setTimeout(() => {
      void parseQuery(invoke, workspaceId, typed, wantsKinds)
        .catch(() => [])
        .then((detections) => live && setParsed({ text: typed, detections }));
    }, 30);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [typed, wantsKinds, invoke, workspaceId]);
  // A reading of older text stays shown only while it still starts the query.
  const detections = parsed.text === typed || typed.startsWith(parsed.text) ? parsed.detections : [];

  useEffect(() => {
    const id = ++request.current;
    if (typed.length < 2) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      void invoke<Suggestion[]>("store_suggest", { ...view, text: typed, perGroup: 4, filters: storeFilters(filters) }, workspaceId)
        .then((found) => id === request.current && setSuggestions(found))
        .catch(() => id === request.current && setSuggestions([]));
    }, 110);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, workspaceId, JSON.stringify(view), filters]);

  const pattern = useMemo(() => prefixPattern(typed), [typed]);
  const items = useMemo<MenuItem[]>(() => {
    if (!typed) return [];
    const taken = new Set(filters.map(filterKey));
    // Readings of the query lead, shown as the tokens they would add; nothing applies until picked.
    const detected = detections
      .map((d) => ({ ...d, filters: d.filters.filter((f) => !taken.has(filterKey(f))) }))
      .filter((d) => d.filters.length || d.kinds?.length)
      .map(
        (d): MenuItem => ({
          key: `detected:${d.id}:${d.filters.map(filterKey).join("|")}:${d.kinds?.join() ?? ""}`,
          filters: d.filters,
          icon: d.filters.length ? (FIELD[d.filters[0].field] ?? FIELD.property).icon : "filter",
          detected: { rest: d.rest, kinds: d.kinds },
          content: (
            <>
              {d.filters.map((f) => (
                <span key={filterKey(f)} className="kx-suggest-token" data-field={f.field}>
                  {tokenScope(f) && <span className="kx-suggest-token-scope">{tokenScope(f)}</span>}
                  {f.label}
                </span>
              ))}
              {d.kinds?.map((k) => (
                <span key={k} className="kx-suggest-token" data-kind={k}>
                  <span className="kx-suggest-token-scope">Show</span>
                  {KIND_NAME[k]}
                </span>
              ))}
              {d.rest && (
                <span className="kx-suggest-scope">
                  {" "}
                  and search <span className="kx-suggest-value">{d.rest}</span>
                </span>
              )}
            </>
          ),
        }),
      );
    const offered = new Set(detected.flatMap((d) => d.filters.map(filterKey)));
    const specific = [...suggestions]
      .sort((a, b) => ORDER.indexOf(a.filter.field) - ORDER.indexOf(b.filter.field))
      .filter((s) => !taken.has(filterKey(s.filter)) && !(detected.length && offered.has(filterKey(s.filter))))
      .slice(0, 8)
      .map((s): MenuItem => {
        const field = FIELD[s.filter.field] ?? FIELD.property;
        const filter: SearchFilter = { ...s.filter, op: s.filter.op ?? "is", label: s.label };
        return {
          key: filterKey(filter),
          filters: [filter],
          icon: field.icon,
          count: s.count,
          content: (
            <>
              <span className="kx-suggest-value">
                {s.filter.field === "property" && <span className="kx-suggest-scope">{s.filter.key}: </span>}
                <Highlight text={s.label} pattern={pattern} />
              </span>
              {s.filter.field !== "creator" && s.filter.field !== "citations" && <span className="kx-suggest-scope"> — {field.label}</span>}
            </>
          ),
        };
      });
    const generic = CONTAINS.map(([field, phrase]): MenuItem => {
      const filter: SearchFilter = { field, op: "contains", value: typed, label: typed };
      return {
        key: filterKey(filter),
        filters: [filter],
        icon: FIELD[field].icon,
        content: (
          <>
            <span className="kx-suggest-scope">{phrase}: </span>
            <span className="kx-suggest-value">{typed}</span>
          </>
        ),
      };
    }).filter((item) => !taken.has(item.key));
    const seen = new Set<string>();
    return [...detected, ...specific, ...generic].filter((item) => !seen.has(item.key) && !!seen.add(item.key));
  }, [suggestions, detections, typed, filters, pattern]);
  useEffect(() => setIndex(-1), [typed]);
  const showMenu = open && items.length > 0;
  // The list closes on blur already; scrolling away or a press in another view closes it
  // too. The field handles Escape itself.
  const formRef = useRef<HTMLFormElement>(null);
  useDismiss(showMenu, { refs: [formRef], kind: "passive", escape: false, anchor: formRef, onDismiss: () => setOpen(false) });

  const pick = (item: MenuItem) => {
    if (item.filters.length) onFilters([...filters, ...item.filters]);
    if (item.detected?.kinds?.length) onKinds?.(item.detected.kinds);
    onText(item.detected?.rest ?? "");
    setIndex(-1);
    inputRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (showMenu) setIndex((i) => Math.min(items.length - 1, i + 1));
      else onArrowIntoResults();
    } else if (e.key === "ArrowUp" && showMenu) {
      e.preventDefault();
      setIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter" && showMenu && index >= 0) {
      e.preventDefault();
      pick(items[index]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (showMenu) setOpen(false);
      else if (text) onText("");
      else if (filters.length) onFilters([]);
    } else if (e.key === "Backspace" && !text && filters.length && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      onFilters(filters.slice(0, -1));
    } else setOpen(true);
  };

  return (
    <form
      ref={formRef}
      className="kx-search"
      role="search"
      data-tokens={filters.length > 0}
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        onSubmit();
      }}
    >
      <Icon name="search" size={14} />
      <div className="kx-search-field" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), inputRef.current?.focus())}>
        {filters.map((f) => {
          const note = tokenNote?.(f);
          return (
          <span key={filterKey(f)} className="kx-token" data-field={f.field} data-value={f.value} data-inactive={note ? true : undefined} title={note ? `${tokenScope(f)} ${f.label}: ${note}` : `${tokenScope(f)} ${f.label}`}>
            <Icon name={(FIELD[f.field] ?? FIELD.property).icon} size={11} />
            <span className="kx-token-scope">{tokenScope(f)}</span>
            <span className="kx-token-value">{f.label}</span>
            <button
              type="button"
              aria-label={`Remove filter ${tokenScope(f)} ${f.label}`}
              onClick={() => onFilters(filters.filter((other) => other !== f))}
            >
              <Icon name="close" size={8} />
            </button>
          </span>
          );
        })}
        <input
          ref={inputRef}
          className="kx-search-input"
          aria-label={label}
          aria-expanded={showMenu}
          aria-controls="kx-suggest"
          aria-activedescendant={index >= 0 ? `kx-suggest-${index}` : undefined}
          role="combobox"
          placeholder={filters.length ? "Search within these filters" : placeholder}
          value={text}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {busy ? <span className="kx-search-spinner" aria-label="Searching" /> : !text && !filters.length && <kbd aria-hidden="true">⌘F</kbd>}
      {(text || filters.length > 0) && (
        <button
          type="button"
          className="kx-search-clear"
          aria-label="Clear search"
          onClick={() => {
            onText("");
            onFilters([]);
          }}
        >
          <Icon name="close" size={10} />
        </button>
      )}
      {showMenu && (
        <div id="kx-suggest" className="kx-suggest" role="listbox" aria-label="Search suggestions">
          {items.map((item, i) => (
            <div
              key={item.key}
              id={`kx-suggest-${i}`}
              role="option"
              aria-selected={i === index}
              className="kx-suggest-item"
              data-detected={item.detected ? true : undefined}
              // Keep the field focused while choosing.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
              onMouseMove={() => i !== index && setIndex(i)}
            >
              <Icon name={item.icon} size={14} />
              <span className="kx-suggest-text">{item.content}</span>
              {item.count !== undefined && <span className="kx-suggest-count">{item.count.toLocaleString()}</span>}
            </div>
          ))}
        </div>
      )}
    </form>
  );
}

/** "Author", "Status" or "Title contains" in front of the token's value. */
function tokenScope(f: SearchFilter) {
  if (f.field === "item") return FIELD.item.label;
  // The label says it all: "Cited more than 100 times", "Retracted".
  if (f.field === "citations" || f.field === "retracted") return "";
  const field = f.field === "property" ? (f.key ?? "Property") : (FIELD[f.field]?.label ?? f.field);
  return !f.op || f.op === "contains" ? `${field} contains` : field;
}
