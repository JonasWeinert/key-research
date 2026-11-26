// The citation picker: search the library, pick one or more sources, and say where in each
// (a page, chapter, …), what goes before and after it, and whether the author is named in
// the sentence already. Opens for a new citation (the "Cite a source" block, ⌃⌘C) and
// when a citation is clicked, to change or remove it.
import { useEffect, useRef, useState } from "react";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "../icons";
import { usePopoverPosition } from "./SuggestionMenu";
import type { NoteCiteItem, SourceRef } from "./types";

export const LOCATOR_LABELS = ["page", "chapter", "section", "paragraph", "figure", "table", "line", "volume", "note"] as const;

interface Picked extends NoteCiteItem {
  title: string;
  detail?: string;
  flag?: string;
}

export interface CitationPickerProps {
  rect: DOMRect | null;
  /** The citation being edited; empty for a new one. */
  initial: NoteCiteItem[];
  search(query: string): Promise<SourceRef[]>;
  resolve(id: string): Promise<SourceRef | null>;
  onSubmit(items: NoteCiteItem[]): void;
  onRemove?(): void;
  onOpen?(id: string): void;
  onClose(): void;
}

export function CitationPicker({ rect, initial, search, resolve, onSubmit, onRemove, onOpen, onClose }: CitationPickerProps) {
  const editing = initial.length > 0;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SourceRef[]>([]);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Picked[]>(() => initial.map((i) => ({ ...i, title: "" })));
  const [open, setOpen] = useState<string | null>(initial.length === 1 ? initial[0].id : null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { ref, style } = usePopoverPosition(rect, [picked.length, results.length, open]);
  // A form, not a menu: scrolling the note behind it leaves it open.
  useDismiss(true, { refs: [ref], scroll: false, onDismiss: onClose });
  useEffect(() => inputRef.current?.focus(), []);

  // Titles of the works already cited.
  useEffect(() => {
    let live = true;
    for (const item of initial)
      void resolve(item.id).then((ref) => live && ref && setPicked((list) => list.map((p) => (p.id === item.id ? { ...p, title: ref.title, detail: ref.detail, flag: ref.flag } : p))));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () =>
        void search(query)
          .then((found) => {
            if (!live) return;
            setResults(found.filter((r) => (r.itemKind ?? "source") === "source" && !r.anchor).slice(0, 6));
            setActive(0);
          })
          .catch(() => live && setResults([])),
      query ? 120 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const add = (ref: SourceRef) => {
    if (!picked.some((p) => p.id === ref.id)) setPicked((list) => [...list, { id: ref.id, title: ref.title, detail: ref.detail, flag: ref.flag }]);
    setOpen(ref.id);
    setQuery("");
    inputRef.current?.focus();
  };
  const update = (id: string, patch: Partial<NoteCiteItem>) => setPicked((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const submit = () => {
    if (!picked.length) return;
    onClose();
    onSubmit(picked.map(({ title: _t, detail: _d, flag: _f, ...item }) => item));
  };

  return (
    <div ref={ref} className="ne-popover ne-cite-picker" style={style} role="dialog" aria-label={editing ? "Edit citation" : "Cite sources"}>
      <div className="ne-cite-search">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          value={query}
          aria-label="Search the library"
          placeholder={picked.length ? "Add another source…" : "Search the library…"}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (results.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if ((e.metaKey || !query) && picked.length) submit();
              else if (results[active]) add(results[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      {(query || !picked.length) && (
        <div className="ne-cite-results" role="listbox" aria-label="Sources">
          {results.length ? (
            results.map((r, i) => {
              const chosen = picked.some((p) => p.id === r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`ne-menu-item${i === active ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(r)}
                >
                  <span className="ne-menu-icon">
                    <Icon name={chosen ? "check" : "doc"} size={14} />
                  </span>
                  <span className="ne-menu-text">
                    <span className="ne-menu-label">{r.title}</span>
                    {r.detail && <span className="ne-menu-hint">{r.detail}</span>}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="ne-menu-empty">{query ? "No sources match" : "Your library is empty"}</div>
          )}
        </div>
      )}
      {picked.length > 0 && (
        <ul className="ne-cite-picked" aria-label="Cited sources">
          {picked.map((p) => (
            <li key={p.id} className="ne-cite-picked-item" data-open={open === p.id || undefined}>
              <div className="ne-cite-picked-head">
                <button type="button" className="ne-cite-picked-title" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <Icon name={open === p.id ? "chevronDown" : "chevronRight"} size={12} />
                  <span>
                    {p.title || "Loading…"}
                    {(p.locator || p.prefix || p.suffix || p.suppressAuthor) && open !== p.id && <span className="ne-cite-picked-summary">{summary(p)}</span>}
                  </span>
                </button>
                {p.flag && (
                  <span className="ne-cite-flag" title={p.flag}>
                    <Icon name="warning" size={12} />
                  </span>
                )}
                {onOpen && (
                  <button type="button" className="ne-cite-icon" aria-label={`Open ${p.title}`} title="Open source" onClick={() => onOpen(p.id)}>
                    <Icon name="external" size={12} />
                  </button>
                )}
                <button type="button" className="ne-cite-icon" aria-label={`Remove ${p.title || "source"}`} title="Remove from citation" onClick={() => setPicked((list) => list.filter((x) => x.id !== p.id))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              {open === p.id && (
                <div className="ne-cite-fields">
                  <select aria-label="Locator type" value={p.label ?? "page"} onChange={(e) => update(p.id, { label: e.target.value })}>
                    {LOCATOR_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l[0].toUpperCase() + l.slice(1)}
                      </option>
                    ))}
                  </select>
                  <input aria-label="Locator" placeholder="12–14" value={p.locator ?? ""} onChange={(e) => update(p.id, { locator: e.target.value })} />
                  <input aria-label="Prefix" placeholder="Prefix, e.g. see" value={p.prefix ?? ""} onChange={(e) => update(p.id, { prefix: e.target.value })} />
                  <input aria-label="Suffix" placeholder="Suffix" value={p.suffix ?? ""} onChange={(e) => update(p.id, { suffix: e.target.value })} />
                  <label className="ne-cite-check">
                    <input type="checkbox" checked={!!p.suppressAuthor} onChange={(e) => update(p.id, { suppressAuthor: e.target.checked })} />
                    Leave out the author (named in the text)
                  </label>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="ne-cite-actions">
        {editing && onRemove && (
          <button
            type="button"
            className="ne-cite-remove"
            onClick={() => {
              onClose();
              onRemove();
            }}
          >
            Remove citation
          </button>
        )}
        <span className="ne-cite-spacer" />
        <button type="button" className="ne-cite-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ne-url-submit" disabled={!picked.length} onClick={submit}>
          {editing ? "Update" : picked.length > 1 ? `Cite ${picked.length}` : "Cite"}
        </button>
      </div>
    </div>
  );
}

function summary(p: NoteCiteItem) {
  const parts = [p.prefix, p.locator && `${p.label && p.label !== "page" ? p.label : "p."} ${p.locator}`, p.suffix, p.suppressAuthor && "no author"].filter(Boolean);
  return ` · ${parts.join(", ")}`;
}
