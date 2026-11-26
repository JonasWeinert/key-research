// The visual query builder: concepts side by side (combined with AND), each a card of synonym
// chips (combined with OR), and the terms to leave out below (NOT). Chips drag between cards
// (or move with ⌥← / ⌥→), open an editor for phrase, truncation, field and proximity, and the
// field under a card takes a word, a pasted list, or a database's own boolean query.
// Reusable: it knows nothing of the page around it, only the query and what the chosen
// databases can do.
import { Fragment, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { addConcept, addTerms, EXCLUDE, findTerm, looksBoolean, makeTerm, moveTerm, removeConcept, removeTerm, renameConcept, setBlockField, setFilters, splitTerms, termLabel, updateTerm, type Block } from "./db-query";
import { DOC_TYPES, FIELD_LABEL, LANGUAGES, TERM_FIELDS, type DbConnector, type DbQuery, type QueryTerm, type TermField, type TermSuggestion } from "./db-search-api";
import { ChoiceMenu, countText, Popover } from "./db-ui";
import { Explain } from "./explain";
import { Icon } from "./icons";

const DRAG_TYPE = "application/x-key-db-term";
const FIELD_SHORT: Record<TermField, string> = { all: "Any", title: "Ti", title_abstract: "Ti/Ab", abstract: "Ab", keywords: "Kw", subject: "MeSH", fulltext: "Full", author: "Au", journal: "Jnl", affiliation: "Affil", identifier: "Id" };

export interface QueryBuilderProps {
  query: DbQuery;
  onChange: (next: DbQuery) => void;
  /** The databases chosen: what they can search decides the hints shown. */
  connectors?: DbConnector[];
  /** Each concept's count alone, in the database the counts are read from. */
  conceptCounts?: (number | null)[];
  countsFrom?: string;
  /** Synonym suggestions for what is typed (your tags, MeSH). */
  suggest?: (text: string) => Promise<TermSuggestion[]>;
  /** A pasted boolean query: read it into blocks (or keep it as a database's own). */
  onPasteQuery?: (text: string) => void;
  /** The field new terms get. */
  defaultField?: TermField;
}

export function QueryBuilder({ query, onChange, connectors = [], conceptCounts, countsFrom, suggest, onPasteQuery, defaultField = "title_abstract" }: QueryBuilderProps) {
  const [dropAt, setDropAt] = useState<{ block: Block; index: number }>();
  const [focusId, setFocusId] = useState<string>();
  const subjectName = connectors.some((c) => c.id === "pubmed" || c.id === "europepmc") ? "MeSH" : "subject headings";
  const supported = (field: TermField) => !connectors.length || connectors.some((c) => c.supports.fields.includes(field));
  const proximity = connectors.some((c) => c.supports.proximity);
  const counted = (conceptCounts ?? []).filter((n): n is number => typeof n === "number");
  // The concept that finds fewest alone, when they differ.
  const narrowest = counted.length > 1 && Math.min(...counted) < Math.max(...counted) ? (conceptCounts ?? []).indexOf(Math.min(...counted)) : -1;

  const move = (id: string, block: Block, index?: number) => {
    onChange(moveTerm(query, id, block, index));
    setFocusId(id);
  };
  const moveBy = (id: string, step: number) => {
    const found = findTerm(query, id);
    if (!found) return;
    const blocks = [...query.concepts.map((c) => c.id), EXCLUDE];
    const at = blocks.indexOf(found.block) + step;
    if (at >= 0 && at < blocks.length) move(id, blocks[at]);
  };
  const dropProps = (block: Block, count: number) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const chips = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-term-chip]")];
      const index = chips.findIndex((chip) => {
        const r = chip.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2 || (e.clientY < r.bottom && e.clientX < r.left + r.width / 2);
      });
      setDropAt({ block, index: index < 0 ? count : index });
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropAt(undefined);
    },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      move(id, block, dropAt?.block === block ? dropAt.index : undefined);
      setDropAt(undefined);
    },
  });

  const renderTerms = (block: Block, terms: QueryTerm[], joiner: string) =>
    terms.map((term, i) => (
      <Fragment key={term.id}>
        {i > 0 && <span className="kx-db-or" aria-hidden="true">{joiner}</span>}
        {dropAt?.block === block && dropAt.index === i && <span className="kx-db-drop-mark" aria-hidden="true" />}
        <TermChip
          term={term}
          focus={focusId === term.id}
          onFocused={() => setFocusId(undefined)}
          onChange={(patch) => onChange(updateTerm(query, term.id, patch))}
          onRemove={() => onChange(removeTerm(query, term.id))}
          onMove={(step) => moveBy(term.id, step)}
          supported={supported}
          subjectName={subjectName}
          proximity={proximity}
          excluded={block === EXCLUDE}
        />
      </Fragment>
    ));

  return (
    <div className="kx-db-builder">
      <div className="kx-db-concepts" role="list" aria-label="Concepts: works must match every concept">
        {query.concepts.map((concept, index) => (
          <Fragment key={concept.id}>
            {index > 0 && (
              <span className="kx-db-and" aria-label="and">
                AND
              </span>
            )}
            <section className="kx-db-concept" role="listitem" aria-label={concept.label || `Concept ${index + 1}`} data-drop={dropAt?.block === concept.id || undefined} {...dropProps(concept.id, concept.terms.length)}>
              <header className="kx-db-concept-head">
                <input
                  className="kx-db-concept-name"
                  aria-label={`Name of concept ${index + 1}`}
                  placeholder={`Concept ${index + 1}`}
                  value={concept.label ?? ""}
                  onChange={(e) => onChange(renameConcept(query, concept.id, e.target.value))}
                />
                {conceptCounts?.[index] !== undefined && (
                  <span className="kx-db-concept-count" data-narrowest={index === narrowest || undefined} title={`${countsFrom ? `In ${countsFrom}: ` : ""}works matching this concept alone${index === narrowest ? ". The narrowest concept: it limits the search most." : ""}`}>
                    {countText(conceptCounts[index], false)}
                  </span>
                )}
                <ConceptMenu
                  onField={(field) => onChange(setBlockField(query, concept.id, field))}
                  onRemove={() => onChange(removeConcept(query, concept.id))}
                  supported={supported}
                  subjectName={subjectName}
                  removable={query.concepts.length > 1 || concept.terms.length > 0}
                />
              </header>
              <div className="kx-db-terms">
                {renderTerms(concept.id, concept.terms, "or")}
                {dropAt?.block === concept.id && dropAt.index >= concept.terms.length && <span className="kx-db-drop-mark" aria-hidden="true" />}
              </div>
              <TermInput
                placeholder={concept.terms.length ? "Add a synonym" : index === 0 ? "Type a word or phrase" : "Add a term"}
                label={`Add a term to ${concept.label || `concept ${index + 1}`}`}
                defaultField={defaultField}
                suggest={suggest}
                onAdd={(terms) => onChange(addTerms(query, concept.id, terms))}
                onPasteQuery={onPasteQuery}
                onBackspaceEmpty={() => concept.terms.length && setFocusId(concept.terms[concept.terms.length - 1].id)}
              />
            </section>
          </Fragment>
        ))}
        <button type="button" className="kx-db-add-concept" onClick={() => onChange(addConcept(query))} title="Another idea every result must be about (AND)">
          <Icon name="plus" size={12} />
          <span>Add concept</span>
        </button>
      </div>

      <section className="kx-db-exclude" aria-label="Leave out works about" data-drop={dropAt?.block === EXCLUDE || undefined} {...dropProps(EXCLUDE, query.exclude.length)}>
        <span className="kx-db-not">NOT</span>
        <div className="kx-db-terms">
          {renderTerms(EXCLUDE, query.exclude, "or")}
          {dropAt?.block === EXCLUDE && dropAt.index >= query.exclude.length && <span className="kx-db-drop-mark" aria-hidden="true" />}
          <TermInput inline placeholder={query.exclude.length ? "Add" : "Leave out works about…"} label="Add a term to leave out" defaultField={defaultField} onAdd={(terms) => onChange(addTerms(query, EXCLUDE, terms))} />
        </div>
        <Explain help="dbsearch.exclude" />
      </section>

      <QueryFilterBar query={query} onChange={onChange} connectors={connectors} />
    </div>
  );
}

/** Years, document types, languages and open access: limits applied to every concept. */
export function QueryFilterBar({ query, onChange, connectors }: { query: DbQuery; onChange: (q: DbQuery) => void; connectors: DbConnector[] }) {
  const f = query.filters;
  const year = (v: string) => (/^\d{4}$/.test(v.trim()) ? Number(v) : undefined);
  const missing = (filter: string) => connectors.filter((c) => !c.manual && !c.supports.filters.includes(filter)).map((c) => c.name);
  const note = (filter: string) => {
    const names = missing(filter);
    return names.length ? `Not applied by ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}` : undefined;
  };
  return (
    <div className="kx-db-filters" role="group" aria-label="Limits">
      <label className="kx-db-years">
        <span>Published</span>
        <YearInput label="From year" value={f.yearFrom} onChange={(v) => onChange(setFilters(query, { yearFrom: year(v) }))} />
        <span aria-hidden="true">–</span>
        <YearInput label="To year" value={f.yearTo} onChange={(v) => onChange(setFilters(query, { yearTo: year(v) }))} />
      </label>
      <span title={note("types")}>
        <ChoiceMenu label="Any type" choices={DOC_TYPES} value={f.types ?? []} summary={f.types?.length === 1 ? DOC_TYPES.find(([k]) => k === f.types![0])?.[1] : `${f.types?.length} types`} onChange={(types) => onChange(setFilters(query, { types }))} />
      </span>
      <span title={note("languages")}>
        <ChoiceMenu label="Any language" choices={LANGUAGES} value={f.languages ?? []} summary={f.languages?.map((l) => LANGUAGES.find(([k]) => k === l)?.[1] ?? l).join(", ")} onChange={(languages) => onChange(setFilters(query, { languages }))} />
      </span>
      <label className="kx-db-toggle" title={note("openAccess")}>
        <input type="checkbox" checked={!!f.openAccess} onChange={(e) => onChange(setFilters(query, { openAccess: e.target.checked }))} />
        Open access only
      </label>
    </div>
  );
}

function YearInput({ label, value, onChange }: { label: string; value?: number; onChange: (v: string) => void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  return (
    <input
      className="kx-db-year"
      aria-label={label}
      inputMode="numeric"
      placeholder="Any"
      maxLength={4}
      value={text}
      onChange={(e) => {
        const next = e.target.value.replace(/\D/g, "");
        setText(next);
        if (!next || next.length === 4) onChange(next);
      }}
    />
  );
}

function ConceptMenu({ onField, onRemove, supported, subjectName, removable }: { onField: (f: TermField) => void; onRemove: () => void; supported: (f: TermField) => boolean; subjectName: string; removable: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect>();
  return (
    <>
      <button type="button" className="kx-db-icon-button" aria-label="Concept options" aria-haspopup="menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        <Icon name="more" size={13} />
      </button>
      {anchor && (
        <Popover anchor={anchor} label="Concept options" width={230} onClose={() => setAnchor(undefined)}>
          <div className="kx-db-menu-label">Search every term in</div>
          {TERM_FIELDS.filter((f) => f !== "identifier").map((f) => (
            <button key={f} type="button" disabled={!supported(f)} onClick={() => (onField(f), setAnchor(undefined))}>
              {f === "subject" ? `Subject headings (${subjectName})` : FIELD_LABEL[f]}
            </button>
          ))}
          <hr />
          <button type="button" data-danger disabled={!removable} onClick={() => (onRemove(), setAnchor(undefined))}>
            <Icon name="trash" size={12} /> Remove concept
          </button>
        </Popover>
      )}
    </>
  );
}

function TermChip({
  term,
  focus,
  onFocused,
  onChange,
  onRemove,
  onMove,
  supported,
  subjectName,
  proximity,
  excluded,
}: {
  term: QueryTerm;
  focus: boolean;
  onFocused: () => void;
  onChange: (patch: Partial<QueryTerm>) => void;
  onRemove: () => void;
  onMove: (step: number) => void;
  supported: (f: TermField) => boolean;
  subjectName: string;
  proximity: boolean;
  excluded: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect>();
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    onFocused();
  }, [focus, onFocused]);
  const unsupported = !supported(term.field);
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const chips = () => [...(e.currentTarget.closest(".kx-db-builder")?.querySelectorAll<HTMLElement>("[data-term-chip]") ?? [])];
    if (e.key === "Backspace" || e.key === "Delete") {
      const list = chips();
      const at = list.indexOf(e.currentTarget);
      (list[at + 1] ?? list[at - 1])?.focus();
      onRemove();
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) onMove(e.key === "ArrowLeft" ? -1 : 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const list = chips();
      list[list.indexOf(e.currentTarget) + (e.key === "ArrowLeft" ? -1 : 1)]?.focus();
    } else return;
    e.preventDefault();
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="kx-db-chip"
        data-term-chip
        data-excluded={excluded || undefined}
        data-unsupported={unsupported || undefined}
        draggable
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        title={`${termLabel(term)} in ${FIELD_LABEL[term.field].toLowerCase()}${unsupported ? " (no chosen database searches this field)" : ""}. Click to edit; drag to another concept, or ⌥← ⌥→; Delete removes it.`}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, term.id);
          e.dataTransfer.setData("text/plain", termLabel(term));
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget.getBoundingClientRect())}
        onKeyDown={keys}
      >
        <span className="kx-db-chip-text">{termLabel(term)}</span>
        {term.field !== "title_abstract" && <span className="kx-db-chip-field">{term.field === "subject" ? subjectName.split(" ")[0] : FIELD_SHORT[term.field]}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} label={`Edit ${term.text}`} width={290} onClose={() => setAnchor(undefined)} className="kx-db-term-editor">
          <TermEditor term={term} onChange={onChange} supported={supported} subjectName={subjectName} proximity={proximity} onRemove={() => (onRemove(), setAnchor(undefined))} onDone={() => setAnchor(undefined)} />
        </Popover>
      )}
    </>
  );
}

function TermEditor({ term, onChange, onRemove, onDone, supported, subjectName, proximity }: { term: QueryTerm; onChange: (p: Partial<QueryTerm>) => void; onRemove: () => void; onDone: () => void; supported: (f: TermField) => boolean; subjectName: string; proximity: boolean }) {
  const multiword = /\s/.test(term.text.trim());
  return (
    <div className="kx-db-editor" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && onDone()}>
      <input className="kx-db-editor-text" aria-label="Term" autoFocus value={term.text} onChange={(e) => onChange({ text: e.target.value })} />
      <div className="kx-db-editor-row">
        <span>Match</span>
        <div className="kx-segmented" role="group" aria-label="Match">
          <button type="button" aria-pressed={term.mode === "phrase"} disabled={!multiword} onClick={() => onChange({ mode: "phrase" })} title="These words together, in this order">
            Phrase
          </button>
          <button type="button" aria-pressed={term.mode === "words"} onClick={() => onChange({ mode: "words", proximity: null })} title="Every word, anywhere in the field">
            All words
          </button>
        </div>
      </div>
      <label className="kx-db-editor-row">
        <span>Endings</span>
        <span className="kx-db-toggle">
          <input type="checkbox" checked={term.truncate} onChange={(e) => onChange({ truncate: e.target.checked })} />
          Any ending ({term.text.split(/\s+/).pop() || "word"}*)
        </span>
      </label>
      <label className="kx-db-editor-row">
        <span>Search in</span>
        <select value={term.field} onChange={(e) => onChange({ field: e.target.value as TermField })}>
          {TERM_FIELDS.map((f) => (
            <option key={f} value={f} disabled={!supported(f) && f !== term.field}>
              {f === "subject" ? `Subject headings (${subjectName})` : FIELD_LABEL[f]}
              {!supported(f) ? " — not searchable here" : ""}
            </option>
          ))}
        </select>
      </label>
      {multiword && term.mode === "phrase" && (
        <label className="kx-db-editor-row" title={proximity ? undefined : "None of the chosen databases supports this"}>
          <span>Near</span>
          <span className="kx-db-toggle">
            <input
              type="number"
              min={0}
              max={20}
              className="kx-db-year"
              aria-label="Words apart at most"
              placeholder="—"
              value={term.proximity ?? ""}
              onChange={(e) => onChange({ proximity: Number(e.target.value) > 0 ? Math.min(20, Math.round(Number(e.target.value))) : null })}
            />
            words apart at most
          </span>
        </label>
      )}
      <div className="kx-db-editor-foot">
        <Explain help="dbsearch.term" label="About these options" />
        <span className="kx-spacer" />
        <button type="button" className="kx-page-action" data-danger onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/** The field under a card: Enter adds, a pasted list adds each line, a pasted query is read into blocks. */
function TermInput({
  placeholder,
  label,
  onAdd,
  defaultField,
  suggest,
  onPasteQuery,
  onBackspaceEmpty,
  inline,
}: {
  placeholder: string;
  label: string;
  onAdd: (terms: QueryTerm[]) => void;
  defaultField: TermField;
  suggest?: (text: string) => Promise<TermSuggestion[]>;
  onPasteQuery?: (text: string) => void;
  onBackspaceEmpty?: () => void;
  inline?: boolean;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<TermSuggestion[]>([]);
  const [at, setAt] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const q = text.trim();
    if (!suggest || q.length < 2) return setFound([]);
    let live = true;
    const timer = setTimeout(() => void suggest(q).then((list) => live && (setFound(list.slice(0, 7)), setAt(-1)), () => {}), 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, suggest]);
  const add = (words: string[], field = defaultField) => {
    onAdd(words.map((w) => makeTerm(w, { field })));
    setText("");
    setFound([]);
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (onPasteQuery && looksBoolean(pasted)) {
      e.preventDefault();
      onPasteQuery(pasted);
      return;
    }
    const parts = splitTerms(pasted);
    if (parts.length > 1) {
      e.preventDefault();
      add(parts);
    }
  };
  const rect = input.current?.getBoundingClientRect();
  return (
    <div className="kx-db-term-input" data-inline={inline || undefined}>
      <input
        ref={input}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={paste}
        onBlur={() => setTimeout(() => setFound([]), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && found.length) setAt((i) => Math.min(found.length - 1, i + 1));
          else if (e.key === "ArrowUp" && found.length) setAt((i) => Math.max(-1, i - 1));
          else if (e.key === "Enter" || (e.key === "Tab" && at >= 0)) {
            if (at >= 0 && found[at]) add([found[at].text], found[at].field ?? defaultField);
            else if (text.trim()) add(splitTerms(text).length > 1 && /[;\n]/.test(text) ? splitTerms(text) : [text]);
            else return;
          } else if (e.key === "Escape" && found.length) setFound([]);
          else if (e.key === "Backspace" && !text && onBackspaceEmpty) onBackspaceEmpty();
          else return;
          e.preventDefault();
        }}
      />
      {found.length > 0 && rect && (
        <div className="kx-suggest kx-db-suggest" role="listbox" aria-label="Suggested terms" style={{ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 240) }}>
          {found.map((s, i) => (
            <button
              key={`${s.from}:${s.text}`}
              type="button"
              role="option"
              aria-selected={i === at}
              className="kx-suggest-item"
              data-active={i === at || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add([s.text], s.field ?? defaultField)}
            >
              <Icon name={s.from === "mesh" ? "hash" : "tag"} size={12} />
              <span>{s.text}</span>
              <small>{s.from === "mesh" ? "MeSH heading" : s.count ? `Your tag · ${s.count}` : "Your tag"}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
