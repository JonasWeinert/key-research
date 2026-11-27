// The library search field: free text plus filter tokens, with suggestions as you type
// (people, journals, tags, collections, years, property values, then "… contains")
// in the manner of Apple Mail. Tokens all apply; free text then searches within them.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "./icons";
import type { Invoke } from "./library-api";
import { Highlight, prefixPattern } from "./search-highlight";
import { useDismiss } from "@key-reader/ui/dismiss";
import { parseQuery, type DetectedKind, type Detection } from "./smart-query";
import { fieldNamed, fieldsStarting, useFilterFields, type FilterField } from "./filter-fields";
import FilterBuilder, { FilterBuilderButton } from "./filter-builder";
import "./search-filters.css";

export interface SearchFilter {
  /** creator | container | title | notes | fulltext | tag | collection | year | property */
  field: string;
  /** For a tag, `is` includes the tags under it in the tag tree; `exact` is that tag only. */
  op?: "is" | "exact" | "contains" | "gt" | "gte" | "lt" | "lte" | "between" | "empty" | "notEmpty";
  value: string;
  /** The property name, for `field = "property"`; a creator's role for `creator`. */
  key?: string;
  /** What the token shows, e.g. a collection's name rather than its id. */
  label: string;
  /** What the token says before its label ("Rating", "Added"); empty when the label says it all. */
  scope?: string;
  /** Turned around: what does not match. */
  negate?: boolean;
  /** `field = "any"`: at least one of these. */
  any?: SearchFilter[];
  /** A property's type as read (number | date | boolean). */
  valueType?: string;
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
  /** A reading of the query: what remains as text, kinds to show, and the text it read
   *  (the parser answers asynchronously, so the field may hold more by the time it is picked). */
  detected?: { rest: string; kinds?: DetectedKind[]; read: string };
  /** Picked, it does this instead of adding tokens ("Add … to library"). */
  action?: () => void;
}

const ID_NAME: Record<string, string> = { doi: "DOI", arxiv: "arXiv", pmid: "PMID", pmcid: "PMCID", isbn: "ISBN" };

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
  // Typed-out filters (field_query.rs).
  any: { label: "Any of", icon: "filter" },
  volume: { label: "Volume", icon: "book" },
  issue: { label: "Issue", icon: "book" },
  pages: { label: "Pages", icon: "doc" },
  pageCount: { label: "Pages", icon: "doc" },
  added: { label: "Added", icon: "clock" },
  modified: { label: "Modified", icon: "clock" },
  read: { label: "Last read", icon: "readHalf" },
  status: { label: "Reading", icon: "readHalf" },
  citationKey: { label: "Citation key", icon: "quote" },
  starred: { label: "Starred", icon: "star" },
  hasPdf: { label: "PDF", icon: "filePdf" },
  hasFile: { label: "File", icon: "doc" },
  zotero: { label: "Zotero", icon: "zotero" },
  duplicate: { label: "Duplicate", icon: "copy" },
  openAccess: { label: "Open access", icon: "globe" },
  notesCount: { label: "Notes", icon: "note" },
  highlightsCount: { label: "Highlights", icon: "highlight" },
  commentsCount: { label: "Comments", icon: "comment" },
  cites: { label: "Cites", icon: "relations" },
  citedBy: { label: "Cited by", icon: "relations" },
  related: { label: "Related to", icon: "relations" },
  publisherName: { label: "Publisher", icon: "book" },
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

export const filterKey = (f: Pick<SearchFilter, "field" | "op" | "value" | "key" | "negate" | "any">): string =>
  `${f.negate ? "-" : ""}${f.field}:${f.op ?? "contains"}:${f.key ?? ""}:${f.value.toLowerCase()}${f.any?.length ? `(${f.any.map(filterKey).join("|")})` : ""}`;
type StoreFilter = Pick<SearchFilter, "field" | "op" | "value" | "key" | "negate" | "valueType"> & { any?: StoreFilter[] };
const storeFilter = ({ field, op, value, key, negate, any, valueType }: SearchFilter): StoreFilter => ({ field, op, value, key, negate, valueType, any: any?.map(storeFilter) });
/** Filters as the store takes them (no display label, no search-tab item picks). */
export const storeFilters = (filters: SearchFilter[]) => filters.filter((f) => f.field !== "item").map(storeFilter);

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
  onAddIdentifier,
  menu = "dropdown",
  onFieldKey,
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
  /** The query field: a one-line text area that wraps onto more lines as the query grows. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
  onArrowIntoResults: () => void;
  label?: string;
  placeholder?: string;
  /** Where kinds of items can be shown (the search tab): "notes" etc. are read as kinds. */
  onKinds?: (kinds: DetectedKind[]) => void;
  /** Why a token is not applied right now (the search tab while only the web is searched);
   *  it stays in the query, shown greyed. */
  tokenNote?: (filter: SearchFilter) => string | undefined;
  /** A pasted identifier alone: offer "Add <identifier> to library" (the library). */
  onAddIdentifier?: (identifier: NonNullable<Detection["add"]>) => void;
  /** "inline": suggestions as a row of chips under the field (the search window), ⇥ applies
   *  the first; the arrow keys stay with the results. */
  menu?: "dropdown" | "inline";
  /** Keys the field does not use itself; return true when handled. */
  onFieldKey?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}) {
  const fields = useFilterFields(invoke, workspaceId);
  const [building, setBuilding] = useState(false);
  const buildButton = useRef<HTMLButtonElement>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [index, setIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  // A newer keystroke's lookup replaces this box's older one still waiting for the host.
  const supersede = useRef(`suggest:${Math.random().toString(36).slice(2)}`);
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
      void invoke<Suggestion[]>("store_suggest", { ...view, text: typed, perGroup: 4, filters: storeFilters(filters), $supersede: supersede.current }, workspaceId)
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
          detected: { rest: d.rest, kinds: d.kinds, read: parsed.text },
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
    // "rat" → "rating:" (and its values once the colon is typed): the field's name goes into the text.
    const lastWord = text.match(/(?:^|\s)(-?)("?[^\s:"<>=!]*"?)(:?)([^\s]*)$/);
    const completions: MenuItem[] = [];
    if (lastWord && fields.length) {
      const [, minus, name, colon, after] = lastWord;
      const head = text.slice(0, text.length - (name.length + colon.length + after.length + minus.length));
      const put = (typedText: string) => () => {
        onText(`${head}${minus}${typedText}`);
        inputRef.current?.focus();
      };
      if (!colon) {
        for (const f of fieldsStarting(fields, name.replace(/"/g, ""), 3)) {
          completions.push({
            key: `field:${f.id}`,
            filters: [],
            icon: (FIELD[f.field] ?? FIELD.property).icon,
            action: put(`${f.id}:`),
            content: <FieldHint field={f} />,
          });
        }
      } else {
        const f = fieldNamed(fields, name.replace(/"/g, ""));
        const values = f?.type === "boolean" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : (f?.options ?? []);
        for (const option of values.filter((o) => !after || o.label.toLowerCase().startsWith(after.toLowerCase().replace(/"/g, ""))).slice(0, 6)) {
          const v = /^[\p{L}\p{N}_.\-/]+$/u.test(option.value) ? option.value : `"${option.value}"`;
          completions.push({
            key: `value:${f!.id}:${option.value}`,
            filters: [],
            icon: (FIELD[f!.field] ?? FIELD.property).icon,
            action: put(`${f!.id}:${v} `),
            content: (
              <>
                <span className="kx-suggest-scope">{f!.label}: </span>
                <span className="kx-suggest-value">{option.label}</span>
              </>
            ),
          });
        }
      }
    }
    const seen = new Set<string>();
    const adds: MenuItem[] = onAddIdentifier
      ? detections.flatMap((d) =>
          d.add
            ? [
                {
                  key: `add:${d.add.kind}:${d.add.value}`,
                  filters: [],
                  icon: "plus" as IconName,
                  action: () => onAddIdentifier(d.add!),
                  content: (
                    <>
                      Add <span className="kx-suggest-value">{ID_NAME[d.add.kind] ?? ""} {d.add.value}</span> to library
                    </>
                  ),
                },
              ]
            : [],
        )
      : [];
    return [...detected, ...adds, ...completions, ...specific, ...(menu === "inline" ? [] : generic)].filter((item) => !seen.has(item.key) && !!seen.add(item.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, detections, typed, filters, pattern, !!onAddIdentifier, fields, menu]);
  useEffect(() => setIndex(-1), [typed]);
  const inline = menu === "inline";
  const showMenu = !inline && open && items.length > 0;
  const strip = inline ? items.slice(0, 6) : [];
  // The list closes on blur already; scrolling away or a press in another view closes it
  // too. The field handles Escape itself.
  const formRef = useRef<HTMLFormElement>(null);
  useDismiss(showMenu, { refs: [formRef], kind: "passive", escape: false, anchor: formRef, onDismiss: () => setOpen(false) });

  const pick = (item: MenuItem) => {
    if (item.action) {
      setOpen(false);
      setIndex(-1);
      return item.action();
    }
    if (item.filters.length) onFilters([...filters, ...item.filters]);
    if (item.detected?.kinds?.length) onKinds?.(item.detected.kinds);
    onText(item.detected ? restAfterPick(item.detected.rest ?? "", item.detected.read, text) : "");
    setIndex(-1);
    inputRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The search window: ⇥ applies the first suggestion; everything else goes to the results.
    if (inline && e.key === "Tab" && !e.shiftKey && strip.length && strip[0].detected) {
      e.preventDefault();
      return pick(strip[0]);
    }
    // Escape closes the search window at once, as Spotlight does.
    if (inline && e.key === "Escape") return void onFieldKey?.(e);
    if (inline && e.key !== "Escape" && e.key !== "Backspace" && onFieldKey?.(e)) return;
    if (!inline && !showMenu && onFieldKey?.(e)) return;
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
    } else if (e.key === "Enter") {
      // One line of query, however it wraps: Enter submits as it did in a text field.
      e.preventDefault();
      if (!e.nativeEvent.isComposing) formRef.current?.requestSubmit();
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

  const stripRow = inline && strip.length > 0 && (
    <div className="kx-suggest-strip" role="listbox" aria-label="Filters read from the search">
      {strip.map((item, i) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={i === 0 && !!item.detected}
          className="kx-suggest-chip"
          data-detected={item.detected ? true : undefined}
          title={item.detected ? `${detections.find((d) => item.key.startsWith(`detected:${d.id}:`))?.explain ?? "Apply these filters"}${i === 0 ? " (⇥)" : ""}` : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(item)}
        >
          <Icon name={item.icon} size={12} />
          <span className="kx-suggest-text">{item.content}</span>
          {i === 0 && item.detected && <kbd>⇥</kbd>}
        </button>
      ))}
    </div>
  );
  return (
    <>
    <form
      ref={formRef}
      className="kx-search"
      role="search"
      data-builder
      data-inline={inline || undefined}
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
          <span key={filterKey(f)} className="kx-token" data-field={f.field} data-value={f.value} data-negate={f.negate || undefined} data-inactive={note ? true : undefined} title={note ? `${tokenScope(f)} ${f.label}: ${note}` : `${tokenScope(f)} ${f.label}`}>
            <Icon name={(FIELD[f.field] ?? FIELD.property).icon} size={11} />
            {f.field === "tag" ? (
              <button
                type="button"
                className="kx-token-scope kx-token-scope-toggle"
                title={f.op === "exact" ? "Only this tag. Click to include the tags under it" : "This tag and the tags under it. Click for this tag only"}
                onClick={() => onFilters(filters.map((other) => (other === f ? { ...f, op: f.op === "exact" ? "is" : "exact" } : other)))}
              >
                {tokenScope(f)}
              </button>
            ) : (
              <span className="kx-token-scope">{tokenScope(f)}</span>
            )}
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
        <textarea
          ref={inputRef}
          rows={1}
          spellCheck={false}
          className="kx-search-input"
          data-empty={!text || undefined}
          data-autofocus
          aria-label={label}
          aria-expanded={showMenu}
          aria-controls="kx-suggest"
          aria-activedescendant={index >= 0 ? `kx-suggest-${index}` : undefined}
          role="combobox"
          placeholder={filters.length ? "Search within these filters" : placeholder}
          value={text}
          onChange={(e) => {
            onText(e.target.value.replace(/[\r\n]+/g, " "));
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {busy ? <span className="kx-search-spinner" aria-label="Searching" /> : !text && !filters.length && !inline && <kbd aria-hidden="true">⌘F</kbd>}
      <FilterBuilderButton open={building} buttonRef={buildButton} onClick={() => setBuilding((b) => !b)} />
      {building && (
        <FilterBuilder
          invoke={invoke}
          workspaceId={workspaceId}
          anchor={buildButton}
          onAdd={(added) => onFilters([...filters, ...added.filter((a) => !filters.some((f) => filterKey(f) === filterKey(a)))])}
          onInsert={(example) => {
            onText(`${text.trim() ? `${text.trim()} ` : ""}${example}`);
            setTimeout(() => inputRef.current?.focus());
          }}
          onClose={() => setBuilding(false)}
        />
      )}
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
    {stripRow}
    </>
  );
}

/** A field's name in the suggestions: what it filters and an example. */
function FieldHint({ field }: { field: FilterField }) {
  return (
    <>
      <span className="kx-suggest-value">{field.id}:</span>
      <span className="kx-suggest-scope">
        {" "}
        {field.label} · {field.help}
        {field.examples[0] && <> · e.g. {field.examples[0]}</>}
      </span>
    </>
  );
}

/** The text left after picking a reading of `read`: its rest plus whatever was typed since. */
export function restAfterPick(rest: string, read: string, current: string) {
  const now = current.trim();
  if (!read || now === read || !now.startsWith(read)) return rest;
  return (rest + now.slice(read.length)).trimStart();
}

/** "Author", "Status" or "Title contains" in front of the token's value. */
function tokenScope(f: SearchFilter) {
  if (f.field === "item") return FIELD.item.label;
  // Typed-out filters say it themselves: scope "Rating", label "more than 3".
  if (f.scope !== undefined) return f.scope;
  // The label says it all: "Cited more than 100 times", "Retracted".
  if (f.field === "citations" || f.field === "retracted") return "";
  const field = f.field === "property" ? (f.key ?? "Property") : (FIELD[f.field]?.label ?? f.field);
  if (f.field === "tag" && f.op === "exact") return `${field} only`;
  return !f.op || f.op === "contains" ? `${field} contains` : field;
}
