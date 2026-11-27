// The visual query builder for full Boolean logic. The top level is a row of cards (usually
// concepts: groups of synonyms joined by OR), joined by AND; any card holds terms and nested
// groups to any depth, drawn as boxes inside boxes. The word between two items (AND, OR, NOT)
// is a button: click it (or focus it and press A, O or N) to change it. Chips and boxes drag
// into any group; ⌘-click picks several to put in a group of their own; each chip opens an
// editor for phrase, endings, field, proximity and NOT. Typing in a group's field and pressing
// Enter or a comma adds a term to that group.
// Reusable: it knows nothing of the page around it, only the query and what the chosen
// databases can do.
import { Fragment, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { addConcept, addTerms, canUngroup, findNode, group as newGroup, joinerAt, looksBoolean, makeTerm, moveNode, removeNode, setFilters, setGroupField, setJoiner, splitTerms, termLabel, terms as termsOf, ungroup, updateNode, wrapNodes, type Joiner } from "./db-query";
import { DOC_TYPES, FIELD_LABEL, LANGUAGES, TERM_FIELDS, type DbConnector, type DbQuery, type QGroup, type QNode, type QTerm, type TermField, type TermSuggestion } from "./db-search-api";
import { ChoiceMenu, countText, Popover } from "./db-ui";
import { Explain } from "./explain";
import { Icon } from "./icons";

const DRAG_TYPE = "application/x-key-db-node";
const FIELD_SHORT: Record<TermField, string> = { all: "Any", title: "Ti", title_abstract: "Ti/Ab", abstract: "Ab", keywords: "Kw", subject: "MeSH", fulltext: "Full", author: "Au", journal: "Jnl", affiliation: "Affil", identifier: "Id", year: "Year", type: "Type", language: "Lang" };
const JOINER_HELP: Record<Joiner, string> = { and: "Both must match", or: "Either may match", not: "Leave out what matches the next item" };

export interface QueryBuilderProps {
  query: DbQuery;
  onChange: (next: DbQuery) => void;
  /** The databases chosen: what they can search decides the hints shown. */
  connectors?: DbConnector[];
  /** Each top-level item's count alone (items with terms, in order). */
  conceptCounts?: (number | null)[];
  countsFrom?: string;
  /** Synonym suggestions for what is typed (your tags, MeSH). */
  suggest?: (text: string) => Promise<TermSuggestion[]>;
  /** A pasted boolean query: read it into blocks (or keep it as a database's own). */
  onPasteQuery?: (text: string) => void;
  /** The field new terms get. */
  defaultField?: TermField;
}

interface Ctx {
  query: DbQuery;
  onChange: (next: DbQuery) => void;
  supported: (f: TermField) => boolean;
  subjectName: string;
  proximity: boolean;
  defaultField: TermField;
  suggest?: (text: string) => Promise<TermSuggestion[]>;
  onPasteQuery?: (text: string) => void;
  selected: string[];
  select: (id: string, e: ReactMouseEvent) => boolean;
  dropAt?: { group: string; index: number };
  setDropAt: (d?: { group: string; index: number }) => void;
  focusId?: string;
  setFocusId: (id?: string) => void;
}

export function QueryBuilder({ query, onChange, connectors = [], conceptCounts, countsFrom, suggest, onPasteQuery, defaultField = "title_abstract" }: QueryBuilderProps) {
  const [dropAt, setDropAt] = useState<{ group: string; index: number }>();
  const [focusId, setFocusId] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const subjectName = connectors.some((c) => c.id === "pubmed" || c.id === "europepmc") ? "MeSH" : "subject headings";
  const supported = (field: TermField) => !connectors.length || ["year", "type", "language"].includes(field) || connectors.some((c) => c.supports.fields.includes(field));
  const proximity = connectors.some((c) => c.supports.proximity);
  // Picked items must stay siblings: picking one in another group starts over.
  const select = (id: string, e: ReactMouseEvent) => {
    if (!(e.metaKey || e.ctrlKey || e.shiftKey)) return false;
    setSelected((now) => {
      if (now.includes(id)) return now.filter((x) => x !== id);
      const parent = findNode(query.expr, id)?.parent?.id;
      const same = now.filter((x) => findNode(query.expr, x)?.parent?.id === parent);
      return [...same, id];
    });
    return true;
  };
  useEffect(() => setSelected((now) => now.filter((id) => findNode(query.expr, id))), [query.expr]);
  const ctx: Ctx = { query, onChange, supported, subjectName, proximity, defaultField, suggest, onPasteQuery, selected, select, dropAt, setDropAt, focusId, setFocusId };
  const counted = (conceptCounts ?? []).filter((n): n is number => typeof n === "number");
  const narrowest = counted.length > 1 && Math.min(...counted) < Math.max(...counted) ? (conceptCounts ?? []).indexOf(Math.min(...counted)) : -1;
  let counter = 0;
  const root = query.expr;
  const negatedEmpty = () => onChange(addTerms(query, root.id, [newGroup("or", [], { not: true })]));

  return (
    <div className="kx-db-builder" onKeyDown={(e) => e.key === "Escape" && selected.length && setSelected([])}>
      {selected.length > 0 && (
        <div className="kx-db-selection" role="toolbar" aria-label="Selected items">
          <span>{selected.length === 1 ? "1 item selected" : `${selected.length} items selected`}</span>
          <button type="button" className="kx-page-action" onClick={() => (onChange(wrapNodes(query, selected)), setSelected([]))} title="Put the selected items in brackets of their own (⌘G)">
            <Icon name="group" size={12} /> Group
          </button>
          <button type="button" className="kx-db-icon-button" aria-label="Clear the selection" onClick={() => setSelected([])}>
            <Icon name="close" size={11} />
          </button>
        </div>
      )}
      <div
        className="kx-db-concepts"
        role="list"
        aria-label="Search blocks"
        data-drop-group={root.id}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g" && selected.length) {
            e.preventDefault();
            onChange(wrapNodes(query, selected));
            setSelected([]);
          }
        }}
        {...dropProps(ctx, root, ".kx-db-concepts > [data-node]")}
      >
        {root.items.map((item, index) => {
          const hasTerms = termsOf(item).some((t) => t.text.trim());
          const at = hasTerms ? counter++ : -1;
          return (
            <Fragment key={item.id}>
              {index > 0 && <JoinerButton ctx={ctx} group={root} index={index} />}
              {ctx.dropAt?.group === root.id && ctx.dropAt.index === index && <span className="kx-db-drop-mark" data-tall aria-hidden="true" />}
              <Card ctx={ctx} node={item} index={index} count={at >= 0 ? conceptCounts?.[at] : undefined} narrowest={at >= 0 && at === narrowest} countsFrom={countsFrom} />
            </Fragment>
          );
        })}
        {ctx.dropAt?.group === root.id && ctx.dropAt.index >= root.items.length && <span className="kx-db-drop-mark" data-tall aria-hidden="true" />}
        <div className="kx-db-add-stack">
          <button type="button" className="kx-db-add-concept" onClick={() => onChange(addConcept(query))} title="Another idea every result must be about (AND)">
            <Icon name="plus" size={12} />
            <span>Add concept</span>
          </button>
          <button type="button" className="kx-db-add-concept" data-not onClick={negatedEmpty} title="Works about any of these terms are left out (NOT)">
            <Icon name="minus" size={12} />
            <span>Leave out…</span>
          </button>
        </div>
      </div>
      <QueryFilterBar query={query} onChange={onChange} connectors={connectors} />
    </div>
  );
}

/** Drag-over and drop for a group: the drop index follows the pointer among its items. */
function dropProps(ctx: Ctx, g: QGroup, itemSelector: string) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const el = e.currentTarget as HTMLElement;
      const items = [...el.querySelectorAll<HTMLElement>(itemSelector)].filter((x) => x.closest("[data-drop-group]") === el || x.parentElement?.closest("[data-drop-group]") === el);
      const index = items.findIndex((item) => {
        const r = item.getBoundingClientRect();
        return e.clientY < r.top || (e.clientY < r.bottom && e.clientX < r.left + r.width / 2);
      });
      const next = { group: g.id, index: index < 0 ? g.items.length : index };
      if (ctx.dropAt?.group !== next.group || ctx.dropAt.index !== next.index) ctx.setDropAt(next);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) ctx.setDropAt(undefined);
    },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.onChange(moveNode(ctx.query, id, g.id, ctx.dropAt?.group === g.id ? ctx.dropAt.index : undefined));
      ctx.setDropAt(undefined);
      ctx.setFocusId(id);
    },
  };
}

const dragStart = (node: QNode) => (e: DragEvent) => {
  e.stopPropagation();
  e.dataTransfer.setData(DRAG_TYPE, node.id);
  e.dataTransfer.setData("text/plain", node.type === "term" ? termLabel(node) : "group");
  e.dataTransfer.effectAllowed = "move";
};

/** The operator between two items: a button that opens AND / OR / NOT. */
function JoinerButton({ ctx, group, index }: { ctx: Ctx; group: QGroup; index: number }) {
  const [anchor, setAnchor] = useState<DOMRect>();
  const joiner = joinerAt(group, index);
  const set = (to: Joiner) => {
    ctx.onChange(setJoiner(ctx.query, group.id, index, to));
    setAnchor(undefined);
  };
  return (
    <>
      <button
        type="button"
        className="kx-db-joiner"
        data-joiner={joiner}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={`${joiner.toUpperCase()}: change the operator`}
        title={`${JOINER_HELP[joiner]}. Click to change, or press A, O or N.`}
        onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget.getBoundingClientRect())}
        onKeyDown={(e) => {
          const to = ({ a: "and", o: "or", n: "not" } as Record<string, Joiner>)[e.key.toLowerCase()];
          if (!to || e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          set(to);
        }}
      >
        {joiner.toUpperCase()}
      </button>
      {anchor && (
        <Popover anchor={anchor} label="Operator" width={250} onClose={() => setAnchor(undefined)} className="kx-db-joiner-menu">
          {(["and", "or", "not"] as Joiner[]).map((j) => (
            <button key={j} type="button" role="menuitemradio" aria-checked={j === joiner} onClick={() => set(j)}>
              <span className="kx-db-check">{j === joiner && <Icon name="check" size={11} />}</span>
              <span className="kx-db-joiner-choice">
                <b>{j.toUpperCase()}</b>
                <small>{JOINER_HELP[j]}</small>
              </span>
            </button>
          ))}
          {group.items.length > 2 && joiner !== "not" && (
            <>
              <hr />
              <div className="kx-db-menu-note">Read left to right, as in PubMed: what comes before this word is put in brackets.</div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

/** A top-level item: a card (a group with its name and field), or a single term. */
function Card({ ctx, node, index, count, narrowest, countsFrom }: { ctx: Ctx; node: QNode; index: number; count?: number | null; narrowest: boolean; countsFrom?: string }) {
  const { query, onChange } = ctx;
  if (node.type === "term") {
    return (
      <section className="kx-db-concept" data-node={node.id} data-single role="listitem" aria-label={`Term ${termLabel(node)}`} data-not={node.not || undefined}>
        <div className="kx-db-terms">
          <TermChip ctx={ctx} term={node} />
        </div>
      </section>
    );
  }
  const hasTerms = termsOf(node).length > 0;
  const name = node.label || (node.not ? "Leave out" : `Concept ${index + 1}`);
  return (
    <section
      className="kx-db-concept"
      role="listitem"
      aria-label={name}
      data-node={node.id}
      data-not={node.not || undefined}
      data-selected={ctx.selected.includes(node.id) || undefined}
      data-drop={ctx.dropAt?.group === node.id || undefined}
      onClick={(e) => e.target === e.currentTarget && ctx.select(node.id, e)}
    >
      <header className="kx-db-concept-head" draggable onDragStart={dragStart(node)} title="Drag to move this block; ⌘-click its edge to select it">
        <Icon name="grip" size={11} className="kx-db-grip" />
        <input className="kx-db-concept-name" aria-label={`Name of ${node.not ? "the left-out block" : `concept ${index + 1}`}`} placeholder={name} value={node.label ?? ""} onChange={(e) => onChange(updateNode(query, node.id, { label: e.target.value || undefined }))} />
        {count !== undefined && (
          <span className="kx-db-concept-count" data-narrowest={narrowest || undefined} title={`${countsFrom ? `In ${countsFrom}: ` : ""}works matching this block alone${narrowest ? ". The narrowest: it limits the search most." : ""}`}>
            {countText(count, false)}
          </span>
        )}
        {node.not && <Explain help="dbsearch.exclude" />}
        <GroupMenu ctx={ctx} group={node} removable={query.expr.items.length > 1 || hasTerms} />
      </header>
      <GroupItems ctx={ctx} group={node} />
      <TermInput
        placeholder={node.items.length ? (node.op === "or" ? "Add a synonym" : "Add a term") : index === 0 ? "Type a word or phrase" : node.not ? "Leave out works about…" : "Add a term"}
        label={node.not ? "Add a term to leave out" : `Add a term to ${name}`}
        autoFocus={!!node.not && !node.items.length}
        defaultField={ctx.defaultField}
        suggest={ctx.suggest}
        onAdd={(terms) => onChange(addTerms(query, node.id, terms))}
        onPasteQuery={ctx.onPasteQuery}
        onBackspaceEmpty={() => {
          const last = node.items[node.items.length - 1];
          if (last) ctx.setFocusId(last.id);
        }}
      />
    </section>
  );
}

/** A group's items with the operator between each pair; nested groups are boxes. */
function GroupItems({ ctx, group: g }: { ctx: Ctx; group: QGroup }) {
  return (
    <div className="kx-db-terms" data-drop-group={g.id} data-op={g.op} {...dropProps(ctx, g, "[data-node]")}>
      {g.items.map((item, i) => (
        <Fragment key={item.id}>
          {i > 0 && <JoinerButton ctx={ctx} group={g} index={i} />}
          {ctx.dropAt?.group === g.id && ctx.dropAt.index === i && <span className="kx-db-drop-mark" aria-hidden="true" />}
          {i === 0 && item.not && <span className="kx-db-joiner" data-joiner="not" data-static title="Leave out what matches this item">NOT</span>}
          {item.type === "term" ? <TermChip ctx={ctx} term={item} /> : <GroupBox ctx={ctx} group={item} />}
        </Fragment>
      ))}
      {ctx.dropAt?.group === g.id && ctx.dropAt.index >= g.items.length && <span className="kx-db-drop-mark" aria-hidden="true" />}
    </div>
  );
}

/** A nested group: a box drawn like brackets, with its own field to add terms. */
function GroupBox({ ctx, group: g }: { ctx: Ctx; group: QGroup }) {
  const [adding, setAdding] = useState(false);
  return (
    <span
      className="kx-db-group"
      data-node={g.id}
      data-op={g.op}
      data-not={g.not || undefined}
      data-selected={ctx.selected.includes(g.id) || undefined}
      data-drop={ctx.dropAt?.group === g.id || undefined}
      role="group"
      aria-label={`Group: ${g.items.length} items joined by ${g.op.toUpperCase()}${g.not ? ", left out" : ""}`}
      draggable
      onDragStart={dragStart(g)}
      onClick={(e) => {
        if (e.target === e.currentTarget) ctx.select(g.id, e);
      }}
    >
      <GroupItems ctx={ctx} group={g} />
      {adding ? (
        <TermInput
          inline
          autoFocus
          placeholder={g.op === "or" ? "Or…" : "And…"}
          label="Add a term to this group"
          defaultField={ctx.defaultField}
          suggest={ctx.suggest}
          onAdd={(terms) => ctx.onChange(addTerms(ctx.query, g.id, terms))}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="kx-db-group-add" aria-label="Add a term to this group" title="Add a term to this group" onClick={() => setAdding(true)}>
          <Icon name="plus" size={10} />
        </button>
      )}
      <GroupMenu ctx={ctx} group={g} removable compact />
    </span>
  );
}

function GroupMenu({ ctx, group: g, removable, compact }: { ctx: Ctx; group: QGroup; removable: boolean; compact?: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect>();
  const { query, onChange } = ctx;
  const close = () => setAnchor(undefined);
  const isTop = query.expr.items.some((n) => n.id === g.id);
  return (
    <>
      <button type="button" className="kx-db-icon-button" data-compact={compact || undefined} aria-label="Group options" aria-haspopup="menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        <Icon name="more" size={compact ? 11 : 13} />
      </button>
      {anchor && (
        <Popover anchor={anchor} label="Group options" width={250} onClose={close}>
          <div className="kx-db-menu-label">Join its items with</div>
          {(["or", "and"] as const).map((op) => (
            <button key={op} type="button" role="menuitemradio" aria-checked={g.op === op} onClick={() => (onChange(updateNode(query, g.id, { op })), close())}>
              <span className="kx-db-check">{g.op === op && <Icon name="check" size={11} />}</span>
              {op === "or" ? "OR: any of them" : "AND: all of them"}
            </button>
          ))}
          <hr />
          <button type="button" role="menuitemcheckbox" aria-checked={!!g.not} onClick={() => (onChange(updateNode(query, g.id, { not: !g.not })), close())}>
            <span className="kx-db-check">{g.not && <Icon name="check" size={11} />}</span>
            Leave out what this group finds (NOT)
          </button>
          <button type="button" onClick={() => (onChange(addTerms(query, g.id, [newGroup(g.op === "or" ? "and" : "or")])), close())}>
            <span className="kx-db-check" />
            Add a group inside
          </button>
          <button type="button" onClick={() => (onChange(wrapNodes(query, [g.id])), close())}>
            <span className="kx-db-check" />
            Put in brackets with…
          </button>
          <button type="button" disabled={isTop || !canUngroup(query, g.id)} onClick={() => (onChange(ungroup(query, g.id)), close())} title={g.not ? "Turn NOT off first" : undefined}>
            <span className="kx-db-check" />
            Remove the brackets
          </button>
          <hr />
          <div className="kx-db-menu-label">Search every term in</div>
          {TERM_FIELDS.filter((f) => !["identifier", "year", "type", "language"].includes(f)).map((f) => (
            <button key={f} type="button" disabled={!ctx.supported(f)} onClick={() => (onChange(setGroupField(query, g.id, f)), close())}>
              <span className="kx-db-check" />
              {f === "subject" ? `Subject headings (${ctx.subjectName})` : FIELD_LABEL[f]}
            </button>
          ))}
          <hr />
          <button type="button" data-danger disabled={!removable} onClick={() => (onChange(removeNode(query, g.id)), close())}>
            <Icon name="trash" size={12} /> Remove group
          </button>
        </Popover>
      )}
    </>
  );
}

/** Years, document types, languages and open access: limits applied to the whole search. */
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

function TermChip({ ctx, term }: { ctx: Ctx; term: QTerm }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect>();
  const { query, onChange } = ctx;
  useEffect(() => {
    if (ctx.focusId !== term.id) return;
    ref.current?.focus();
    ctx.setFocusId(undefined);
  }, [ctx, term.id]);
  const unsupported = !ctx.supported(term.field);
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const chips = () => [...(e.currentTarget.closest(".kx-db-builder")?.querySelectorAll<HTMLElement>("[data-term-chip]") ?? [])];
    if (e.key === "Backspace" || e.key === "Delete") {
      const list = chips();
      const at = list.indexOf(e.currentTarget);
      (list[at + 1] ?? list[at - 1])?.focus();
      onChange(removeNode(query, term.id));
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      // ⌥← ⌥→ into the previous or next top-level block; with ⇧, one place within its group.
      const found = findNode(query.expr, term.id);
      if (!found?.parent) return;
      const step = e.key === "ArrowLeft" ? -1 : 1;
      const to = found.index + step;
      if (e.shiftKey) {
        if (to >= 0 && to < found.parent.items.length) onChange(moveNode(query, term.id, found.parent.id, to + (step > 0 ? 1 : 0)));
      } else {
        const top = query.expr.items.filter((n): n is QGroup => n.type === "group");
        const here = top.findIndex((g) => g.id === found.parent!.id || findNode(g, term.id));
        const next = top[here + step];
        if (next) onChange(moveNode(query, term.id, next.id));
      }
      ctx.setFocusId(term.id);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const list = chips();
      list[list.indexOf(e.currentTarget) + (e.key === "ArrowLeft" ? -1 : 1)]?.focus();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
      onChange(wrapNodes(query, ctx.selected.length ? ctx.selected : [term.id]));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const fieldTag = term.field === "subject" ? ctx.subjectName.split(" ")[0] : FIELD_SHORT[term.field];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="kx-db-chip"
        data-term-chip
        data-node={term.id}
        data-excluded={term.not || undefined}
        data-unsupported={unsupported || undefined}
        data-selected={ctx.selected.includes(term.id) || undefined}
        draggable
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        aria-pressed={ctx.selected.includes(term.id) || undefined}
        title={`${term.not ? "NOT " : ""}${termLabel(term)} in ${FIELD_LABEL[term.field].toLowerCase()}${unsupported ? " (no chosen database searches this field: Key checks it on the results)" : ""}. Click to edit; ⌘-click to select; drag to move, or ⌥← ⌥→; Delete removes it.`}
        onDragStart={dragStart(term)}
        onClick={(e) => {
          if (ctx.select(term.id, e)) return;
          setAnchor(anchor ? undefined : e.currentTarget.getBoundingClientRect());
        }}
        onKeyDown={keys}
      >
        <span className="kx-db-chip-text">{termLabel(term)}</span>
        {term.field !== "title_abstract" && <span className="kx-db-chip-field">{fieldTag}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} label={`Edit ${term.text}`} width={300} onClose={() => setAnchor(undefined)} className="kx-db-term-editor">
          <TermEditor
            term={term}
            onChange={(patch) => onChange(updateNode(query, term.id, patch))}
            supported={ctx.supported}
            subjectName={ctx.subjectName}
            proximity={ctx.proximity}
            onGroup={() => (onChange(wrapNodes(query, [term.id])), setAnchor(undefined))}
            onRemove={() => (onChange(removeNode(query, term.id)), setAnchor(undefined))}
            onDone={() => setAnchor(undefined)}
          />
        </Popover>
      )}
    </>
  );
}

function TermEditor({ term, onChange, onRemove, onGroup, onDone, supported, subjectName, proximity }: { term: QTerm; onChange: (p: Partial<QTerm>) => void; onRemove: () => void; onGroup: () => void; onDone: () => void; supported: (f: TermField) => boolean; subjectName: string; proximity: boolean }) {
  const multiword = /\s/.test(term.text.trim());
  const special = term.field === "year" || term.field === "type" || term.field === "language";
  return (
    <div className="kx-db-editor" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && onDone()}>
      {term.field === "type" ? (
        <select className="kx-db-editor-text" aria-label="Document type" value={term.text} onChange={(e) => onChange({ text: e.target.value })}>
          {DOC_TYPES.map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      ) : term.field === "language" ? (
        <select className="kx-db-editor-text" aria-label="Language" value={term.text} onChange={(e) => onChange({ text: e.target.value })}>
          {LANGUAGES.map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input className="kx-db-editor-text" aria-label={term.field === "year" ? "Years, for example 2015-2024" : "Term"} autoFocus value={term.text} onChange={(e) => onChange({ text: e.target.value })} />
      )}
      {!special && (
        <>
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
        </>
      )}
      <label className="kx-db-editor-row">
        <span>Search in</span>
        <select
          value={term.field}
          onChange={(e) => {
            const field = e.target.value as TermField;
            const text = field === "type" ? "article" : field === "language" ? "en" : field === "year" && !/^\d{4}/.test(term.text) ? "2015-2025" : term.text;
            onChange({ field, text });
          }}
        >
          {TERM_FIELDS.map((f) => (
            <option key={f} value={f} disabled={!supported(f) && f !== term.field}>
              {f === "subject" ? `Subject headings (${subjectName})` : FIELD_LABEL[f]}
              {!supported(f) ? " — checked by Key" : ""}
            </option>
          ))}
        </select>
      </label>
      {multiword && term.mode === "phrase" && !special && (
        <label className="kx-db-editor-row" title={proximity ? undefined : "None of the chosen databases supports this: Key checks it on the results"}>
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
      <label className="kx-db-editor-row">
        <span>Leave out</span>
        <span className="kx-db-toggle">
          <input type="checkbox" checked={!!term.not} onChange={(e) => onChange({ not: e.target.checked })} />
          NOT: remove works with this term
        </span>
      </label>
      <div className="kx-db-editor-foot">
        <Explain help="dbsearch.term" label="About these options" />
        <span className="kx-spacer" />
        <button type="button" className="kx-page-action" onClick={onGroup} title="Put this term in brackets, to add alternatives or conditions to it">
          Group
        </button>
        <button type="button" className="kx-page-action" data-danger onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/** The field in a group: Enter or a comma adds, a pasted list adds each line, a pasted query is read into blocks. */
function TermInput({
  placeholder,
  label,
  onAdd,
  defaultField,
  suggest,
  onPasteQuery,
  onBackspaceEmpty,
  onDone,
  inline,
  autoFocus,
}: {
  placeholder: string;
  label: string;
  onAdd: (terms: QNode[]) => void;
  defaultField: TermField;
  suggest?: (text: string) => Promise<TermSuggestion[]>;
  onPasteQuery?: (text: string) => void;
  onBackspaceEmpty?: () => void;
  onDone?: () => void;
  inline?: boolean;
  autoFocus?: boolean;
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
    onAdd(words.filter((w) => w.trim()).map((w) => makeTerm(w, { field })));
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
  // A comma ends a term, except inside quotes ("a, b").
  const commaEnds = (value: string) => (value.match(/"/g)?.length ?? 0) % 2 === 0;
  const rect = input.current?.getBoundingClientRect();
  return (
    <div className="kx-db-term-input" data-inline={inline || undefined}>
      <input
        ref={input}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",") && commaEnds(v) && v.slice(0, -1).trim()) add([v.slice(0, -1)]);
          else setText(v);
        }}
        onPaste={paste}
        onBlur={() => {
          setTimeout(() => setFound([]), 150);
          if (onDone && !text.trim()) onDone();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && found.length) setAt((i) => Math.min(found.length - 1, i + 1));
          else if (e.key === "ArrowUp" && found.length) setAt((i) => Math.max(-1, i - 1));
          else if (e.key === "Enter" || (e.key === "Tab" && at >= 0)) {
            if (at >= 0 && found[at]) add([found[at].text], found[at].field ?? defaultField);
            else if (text.trim()) add(splitTerms(text).length > 1 && /[;\n]/.test(text) ? splitTerms(text) : [text]);
            else if (onDone) onDone();
            else return;
          } else if (e.key === "Escape" && found.length) setFound([]);
          else if (e.key === "Escape" && onDone) onDone();
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
