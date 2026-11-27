// The selection menu: one component for a text selection in every reader (the PDF page view,
// PDF reading mode, saved web pages and their reading mode). The reader gives its own tools
// (highlight colours, copy, cite, comment …); a host embedding the reader adds its actions.
//
// Host API (stable; readers take it as `selectionActions` / `selectionMode` / `marks`):
//   ReaderSelectionAction   an action on the selected passage
//     id, label, title?        the row; `title` is its tooltip
//     icon?                    a glyph name (ui/glyphs.ts)
//     detail?                  a second line (a preview: "→ mean 12.3, SD 4.5")
//     prefix?, aside?          a muted lead-in before the label (a form section); a value at
//                              the row's end, right-aligned ("12.3", "12 → 12.3")
//     group?                   a heading the row goes under (criteria by PICO part, form sections)
//     key?                     answered while the menu is open and shown on a key cap:
//                              "3", "shift+3", "enter", "n"
//     tone?                    notMet | met | evidence | source | accent | danger (colour only)
//     runLabel?                with a mode: the row's main target as a pill ("Not met")
//     quick?                   more one-click targets on the same row ({ id, label, key?, tone?,
//                              quiet? — shown on the active row only, run })
//     folded?                  with a mode: under a closed "more" group (mode.folded names it)
//     input?                   { placeholder } — the row opens an inline field; `run` gets its text
//     secondary?               with a mode: listed under the main rows, smaller
//     keywords?                extra words the filter matches
//     run(passage, text?)      may return a ReaderFollowUp (or a promise of one): shown in the
//                              menu's place ("Exclude and go to next" ↩ · "Keep reading" esc)
//   ReaderSelectionMode     { id, label, filter?: placeholder, empty?, hint? } — when given, the
//                              host's actions are the menu (first, larger, a vertical list,
//                              type to filter) and the reader's own tools fold into a small row;
//                              keys may carry Shift or Alt ("alt+enter": the active row's)
//   ReaderMark              { id, page, rects, text, tone, label } — the host's marks drawn in the
//                              page (review evidence, extraction sources), not the user's highlights;
//                              a click opens this menu with the host's `markActions(mark)`
//   passage                 { text, page (0-based, -1 on a web page), rects [x, y, w, h] in 0–65535 }
// Without a mode the reader's row looks as before and host actions follow as a second row of
// labelled buttons (wrapping, never overlapping or clipped).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Glyph } from './Glyph';
import type { GlyphName } from './glyphs';
import { clipArea, filterItems, grouped, keyLabel, keyMatches, moveIndex, placeMenu, type Box, type Placement } from './selection-menu-layout';
import './selection-menu.css';

export interface ReaderPassage {
  text: string;
  page: number;
  rects: number[][];
}
export type SelectionTone = 'notMet' | 'met' | 'evidence' | 'source' | 'accent' | 'danger';

export interface ReaderFollowUp {
  message: string;
  tone?: SelectionTone;
  actions: Array<{ id: string; label: string; key?: string; primary?: boolean; run(): void }>;
}
type RunResult = void | ReaderFollowUp | null | undefined;

export interface ReaderSelectionQuick {
  id: string;
  label: string;
  key?: string;
  tone?: SelectionTone;
  title?: string;
  /** Shown on the active (or pointed-at) row only. */
  quiet?: boolean;
  run(passage: ReaderPassage): RunResult | Promise<RunResult>;
}

/** A host's action on the selected passage (see the header). */
export interface ReaderSelectionAction {
  id: string;
  label: string;
  title?: string;
  icon?: GlyphName;
  detail?: string;
  prefix?: string;
  aside?: string;
  group?: string;
  key?: string;
  tone?: SelectionTone;
  runLabel?: string;
  folded?: boolean;
  quick?: ReaderSelectionQuick[];
  input?: { placeholder: string };
  secondary?: boolean;
  keywords?: string;
  run(passage: ReaderPassage, text?: string): RunResult | Promise<RunResult>;
}

/** The host's actions: a list, or worked out for the passage (a review asks Rust where it fits). */
export type ReaderSelectionActions = ReaderSelectionAction[] | ((passage: ReaderPassage) => ReaderSelectionAction[] | Promise<ReaderSelectionAction[]>);

export interface ReaderSelectionMode {
  id: string;
  label: string;
  /** Placeholder of the filter field; without it there is none. */
  filter?: string;
  /** Shown when nothing is left (or there was nothing). */
  empty?: string;
  /** A quiet line under the heading ("1–9 not met · ⇧ met"). */
  hint?: string;
  /** The name of the closed group of `folded` actions ("Other fields: source only"). */
  folded?: string;
}

/** A host's mark in the page (see the header). */
export interface ReaderMark {
  id: string;
  page: number;
  rects: number[][];
  text: string;
  tone: SelectionTone;
  label: string;
}
export interface ReaderMarkMenu {
  title?: string;
  mode?: ReaderSelectionMode;
  actions: ReaderSelectionAction[];
}

export interface SelectionColor {
  id: string;
  label: string;
  rgb: string;
  pressed?: boolean;
  run(): void;
}
export interface SelectionTool {
  id: string;
  label: string;
  icon: GlyphName;
  title?: string;
  /** Shown with its label (else an icon button). */
  text?: boolean;
  danger?: boolean;
  run(): void;
}

interface Props {
  open: boolean;
  /** The passage's box in the window. */
  anchor: Box | null;
  /** The reader's own box: the menu stays inside it (beside a sidebar). */
  area?: () => Box | null | undefined;
  /** The passage, worked out when an action runs (reading mode locates it in the PDF then). */
  passage: () => ReaderPassage | null | Promise<ReaderPassage | null>;
  actions?: ReaderSelectionActions;
  mode?: ReaderSelectionMode;
  /** A heading over everything (a mark's "Not met: Population"). */
  title?: string;
  colors?: SelectionColor[];
  tools?: SelectionTool[];
  label?: string;
  /** Extra class names (the reader's old ones, which its smokes and styles know). */
  className?: string;
  /** The reader's own content after its tools (none by default). */
  children?: ReactNode;
  onClose(): void;
  /** A host action ran: the reader lets go of its selection. */
  onDone?(): void;
  portal?: HTMLElement | null;
}

interface Row {
  action: ReaderSelectionAction;
  targets: Array<{ id: string; label: string; key?: string; tone?: SelectionTone; quiet?: boolean; run: (p: ReaderPassage) => RunResult | Promise<RunResult> }>;
}

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

function Kbd({ spec }: { spec?: string }) {
  if (!spec) return null;
  return <kbd className="ksm-kbd">{keyLabel(spec)}</kbd>;
}

export function SelectionMenu(props: Props) {
  const { open, anchor, mode, colors = [], tools = [], title } = props;
  const root = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState({ row: 0, target: 0 });
  const [inputFor, setInputFor] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [follow, setFollow] = useState<{ data: ReaderFollowUp; anchor: Box } | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const [more, setMore] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const lastAnchor = useRef<Box | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  if (open && anchor) lastAnchor.current = anchor;

  // A new selection starts afresh (and ends a follow-up still showing).
  const anchorKey = anchor ? `${Math.round(anchor.left)}:${Math.round(anchor.top)}:${Math.round(anchor.width)}` : '';
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive({ row: 0, target: 0 });
    setInputFor(null);
    setInputText('');
    setFollow(null);
    setMore(false);
    setUnfolded(false);
  }, [open, anchorKey, mode?.id]);

  // Actions worked out for the passage: asked for once per selection.
  const given = props.actions;
  const [resolved, setResolved] = useState<ReaderSelectionAction[] | null>(null);
  useEffect(() => {
    if (!open || typeof given !== 'function') return;
    let live = true;
    setResolved(null);
    void Promise.resolve(propsRef.current.passage())
      .then(p => (p ? given(p) : []))
      .then(list => live && setResolved(list))
      .catch(() => live && setResolved([]));
    return () => {
      live = false;
    };
  }, [open, anchorKey, given]);
  const loading = typeof given === 'function' && resolved === null;
  const actions = useMemo(() => (typeof given === 'function' ? resolved ?? [] : given ?? []), [given, resolved]);

  const rows = useMemo<Row[]>(() => {
    const list = mode ? filterItems(actions, query) : actions;
    const primary = list.filter(a => !mode || (!a.secondary && !a.folded));
    const secondary = mode ? list.filter(a => a.secondary && !a.folded) : [];
    // Folded rows count once opened (or while filtering).
    const folded = mode && (unfolded || query) ? list.filter(a => a.folded) : [];
    return [...primary, ...secondary, ...folded].map(action => ({
      action,
      targets: [{ id: action.id, label: action.runLabel ?? action.label, key: action.key, tone: action.tone, run: (p: ReaderPassage) => action.run(p) }, ...(action.quick ?? []).map(q => ({ id: q.id, label: q.label, key: q.key, tone: q.tone, quiet: q.quiet, run: q.run }))],
    }));
  }, [actions, mode, query, unfolded]);
  const foldedCount = mode ? actions.filter(a => a.folded).length : 0;

  const visible = (open && !!anchor) || !!follow;

  const run = useCallback(async (fn: (p: ReaderPassage) => RunResult | Promise<RunResult>, row?: ReaderSelectionAction) => {
    if (row?.input && inputFor !== row.id) {
      setInputFor(row.id);
      setInputText('');
      return;
    }
    const passage = await propsRef.current.passage();
    if (!passage) return;
    const at = lastAnchor.current;
    const result = row?.input ? await row.run(passage, inputText) : await fn(passage);
    setInputFor(null);
    setInputText('');
    if (result && typeof result === 'object' && 'actions' in result && at) setFollow({ data: result, anchor: at });
    else setFollow(null);
    propsRef.current.onDone?.();
  }, [inputFor, inputText]);

  const closeAll = useCallback(() => {
    setFollow(null);
    setInputFor(null);
    propsRef.current.onClose();
  }, []);

  // Keys while it shows: Esc closes, Enter runs, the host's keys, arrows and Tab move; in a
  // mode, typing filters.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      const inside = !!el && e.target instanceof Node && el.contains(e.target);
      if (inputFor && inside && editable(e.target)) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (follow) {
        const hit = follow.data.actions.find(a => keyMatches(e, a.key)) ?? (e.key === 'Enter' ? follow.data.actions.find(a => a.primary) : undefined);
        if (hit) {
          stop();
          setFollow(null);
          hit.run();
          return;
        }
        if (e.key === 'Escape') {
          stop();
          setFollow(null);
          follow.data.actions.find(a => a.key === 'escape' || a.key === 'esc')?.run();
        }
        return;
      }
      if (e.key === 'Escape') {
        stop();
        if (query) setQuery('');
        else closeAll();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      // The host's keys ("3", "shift+3", "alt+enter") on a row's target, the active row's first.
      const activeRow = rows[Math.min(active.row, rows.length - 1)];
      for (const row of activeRow ? [activeRow, ...rows] : rows) {
        const t = row.targets.find(x => keyMatches(e, x.key));
        if (t && !(inside && editable(e.target) && /^[a-z0-9]$/i.test(e.key) && e.target === filterRef.current)) {
          stop();
          void run(t.run, t.id === row.action.id ? row.action : undefined);
          return;
        }
      }
      if (!mode) {
        if (!inside) return;
        const buttons = el ? [...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const key = e.key === 'Tab' ? (e.shiftKey ? 'ShiftTab' : 'Tab') : e.key;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'ShiftTab', 'Home', 'End'].includes(key)) {
          stop();
          buttons[moveIndex(at, buttons.length, key === 'Tab' ? 'ArrowRight' : key)]?.focus();
        }
        return;
      }
      if (e.altKey) return;
      const count = rows.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.key === 'Tab' && !inside)) {
        stop();
        const dir = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? 'ArrowUp' : 'ArrowDown';
        setActive(a => ({ row: moveIndex(a.row, count, dir), target: 0 }));
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (inside && e.target === filterRef.current && query) return;
        stop();
        setActive(a => ({ row: a.row, target: Math.max(0, Math.min((rows[a.row]?.targets.length ?? 1) - 1, a.target + (e.key === 'ArrowRight' ? 1 : -1))) }));
        return;
      }
      if (e.key === 'Enter') {
        if (inside && e.target instanceof HTMLButtonElement) return;
        const row = rows[Math.min(active.row, count - 1)];
        const t = row?.targets[active.target] ?? row?.targets[0];
        if (row && t) {
          stop();
          void run(t.run, t.id === row.action.id ? row.action : undefined);
        }
        return;
      }
      if (mode.filter && !(editable(e.target) && !inside)) {
        if (e.key === 'Backspace' && query && e.target !== filterRef.current) {
          stop();
          setQuery(q => q.slice(0, -1));
        } else if (e.key.length === 1 && e.target !== filterRef.current && /\S/.test(e.key)) {
          stop();
          setQuery(q => q + e.key);
          setActive({ row: 0, target: 0 });
          filterRef.current?.focus({ preventScroll: true });
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, follow, rows, mode, query, active, run, closeAll, inputFor]);

  // A follow-up goes when the pointer goes elsewhere.
  useEffect(() => {
    if (!follow) return;
    const down = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && root.current.contains(e.target)) return;
      setFollow(null);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [follow]);

  // Placed after it is measured, again whenever its content changes size.
  const where = follow?.anchor ?? (open ? anchor : null);
  const measure = useCallback(() => {
    const el = root.current;
    if (!el || !where) return;
    const area = clipArea(propsRef.current.area?.() ?? null, { width: window.innerWidth, height: window.innerHeight });
    const maxWidth = mode || follow ? 380 : 440;
    const width = Math.min(el.scrollWidth, maxWidth);
    const height = el.scrollHeight;
    const next = placeMenu(where, { width, height }, area, { maxWidth });
    setPlace(p => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight && p.maxWidth === next.maxWidth && p.side === next.side ? p : next));
  }, [where, mode, follow]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, visible]);
  // The active row stays in view.
  useEffect(() => {
    root.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!visible || !where) return null;
  const style: CSSProperties = place
    ? { left: place.left, top: place.top, maxWidth: place.maxWidth, maxHeight: place.maxHeight }
    : { left: -10000, top: 0, visibility: 'hidden' };

  const colorRow = (compact: boolean) =>
    colors.length > 0 || tools.length > 0 ? (
      <div className="ksm-generic" data-compact={compact || undefined} role="group" aria-label="Highlight and tools">
        {colors.map(c => (
          <button
            key={c.id}
            type="button"
            className={`ksm-swatch pdfjs-color-button color-${c.id}`}
            data-color={c.id}
            aria-label={c.label}
            title={c.label}
            aria-pressed={c.pressed ?? false}
            style={{ ['--ksm-swatch' as string]: `rgb(${c.rgb})` }}
            onClick={() => c.run()}
          />
        ))}
        {colors.length > 0 && tools.length > 0 && <span className="ksm-divider" aria-hidden="true" />}
        {tools.map(t => (
          <button key={t.id} type="button" className="ksm-tool" data-tool={t.id} data-text={t.text || undefined} data-danger={t.danger || undefined} aria-label={t.label} title={t.title ?? t.label} onClick={() => t.run()}>
            <Glyph name={t.icon} size={14} />
            {t.text && <span>{t.label}</span>}
          </button>
        ))}
        {props.children}
      </div>
    ) : null;

  let body: ReactNode;
  if (follow) {
    body = (
      <div className="ksm-follow" role="status" data-tone={follow.data.tone}>
        <span className="ksm-follow-message">
          <i className="ksm-dot" data-tone={follow.data.tone ?? 'accent'} aria-hidden="true" />
          {follow.data.message}
        </span>
        <span className="ksm-follow-actions">
          {follow.data.actions.map(a => (
            <button
              key={a.id}
              type="button"
              className="ksm-chip"
              data-primary={a.primary || undefined}
              data-action={a.id}
              onClick={() => {
                setFollow(null);
                a.run();
              }}
            >
              <span>{a.label}</span>
              <Kbd spec={a.key ?? (a.primary ? 'enter' : undefined)} />
            </button>
          ))}
        </span>
      </div>
    );
  } else if (mode) {
    const primaryRows = rows.filter(r => !r.action.secondary && !r.action.folded);
    const secondaryRows = rows.filter(r => r.action.secondary && !r.action.folded);
    const foldedRows = rows.filter(r => r.action.folded);
    const rowView = (row: Row, index: number) => {
      const a = row.action;
      const isActive = index === active.row;
      if (inputFor === a.id) {
        return (
          <div key={a.id} className="ksm-row ksm-input-row" data-active={isActive || undefined}>
            {a.icon && <Glyph name={a.icon} size={13} className="ksm-row-icon" />}
            <input
              autoFocus
              className="ksm-input"
              aria-label={a.label}
              placeholder={a.input?.placeholder}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter' && inputText.trim()) {
                  e.preventDefault();
                  void run(p => a.run(p, inputText), a);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setInputFor(null);
                }
              }}
            />
            <button type="button" className="ksm-chip" data-primary disabled={!inputText.trim()} onClick={() => void run(p => a.run(p, inputText), a)}>
              <span>Save</span>
              <Kbd spec="enter" />
            </button>
          </div>
        );
      }
      return (
        <div key={a.id} className="ksm-row" role="none" data-active={isActive || undefined} data-tone={a.tone} data-secondary={a.secondary || undefined} data-row={a.id}>
          <button
            type="button"
            role="menuitem"
            className="ksm-row-main"
            data-action={a.id}
            title={a.title ?? a.label}
            data-target-active={(isActive && active.target === 0) || undefined}
            onPointerEnter={() => setActive({ row: index, target: 0 })}
            onClick={() => void run(row.targets[0].run, a)}
          >
            {a.icon ? <Glyph name={a.icon} size={13} className="ksm-row-icon" /> : null}
            <span className="ksm-row-text">
              {a.prefix && <small className="ksm-row-prefix">{a.prefix}</small>}
              <span className="ksm-row-label">{a.label}</span>
              {a.detail && <small className="ksm-row-detail">{a.detail}</small>}
            </span>
            {a.aside && <span className="ksm-row-aside">{a.aside}</span>}
            {a.runLabel ? (
              <span className="ksm-pill" data-tone={a.tone}>
                {a.runLabel}
                <Kbd spec={a.key} />
              </span>
            ) : (
              <Kbd spec={a.key ?? (isActive && active.target === 0 ? 'enter' : undefined)} />
            )}
          </button>
          {row.targets.slice(1).map((t, i) => (t.quiet && !isActive ? null : (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className="ksm-pill ksm-quick"
              data-tone={t.tone}
              data-action={t.id}
              data-target-active={(isActive && active.target === i + 1) || undefined}
              aria-label={`${t.label}: ${a.label}`}
              title={`${t.label}: ${a.label}`}
              onClick={() => void run(t.run)}
            >
              {t.label}
              <Kbd spec={t.key} />
            </button>
          )))}
        </div>
      );
    };
    let index = 0;
    const groups = grouped(primaryRows.map(r => ({ ...r, group: r.action.group })));
    body = (
      <>
        <div className="ksm-head">
          <span className="ksm-mode">{title ?? mode.label}</span>
          {mode.filter && (
            <input
              ref={filterRef}
              className="ksm-filter"
              aria-label="Filter"
              placeholder={mode.filter}
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setActive({ row: 0, target: 0 });
              }}
            />
          )}
        </div>
        {mode.hint && !query && <p className="ksm-hint">{mode.hint}</p>}
        <div className="ksm-list" role="menu" aria-label={mode.label}>
          {loading && <p className="ksm-empty">Reading the passage…</p>}
          {!loading && primaryRows.length === 0 && <p className="ksm-empty">{query ? `Nothing matches “${query}”` : mode.empty ?? 'Nothing to choose'}</p>}
          {groups.map(g => (
            <div key={g.group || '_'} className="ksm-group" role="group" aria-label={g.group || undefined}>
              {g.group && groups.length > 1 && <h5 className="ksm-group-title">{g.group}</h5>}
              {g.items.map(r => rowView(r, index++))}
            </div>
          ))}
          {secondaryRows.length > 0 && (
            <div className="ksm-secondary" role="group" aria-label="More">
              {secondaryRows.map(r => rowView(r, index++))}
            </div>
          )}
          {foldedCount > 0 && (
            <div className="ksm-secondary ksm-folded" role="group" aria-label={mode.folded ?? 'More'}>
              {foldedRows.length > 0 ? (
                <>
                  <h5 className="ksm-group-title">{mode.folded ?? 'More'}</h5>
                  {foldedRows.map(r => rowView(r, index++))}
                </>
              ) : (
                <button type="button" className="ksm-unfold" aria-expanded={false} onClick={() => setUnfolded(true)}>
                  <Glyph name="chevronRight" size={11} />
                  <span>{mode.folded ?? 'More'}</span>
                  <span className="ksm-count">{foldedCount}</span>
                </button>
              )}
            </div>
          )}
        </div>
        {(colors.length > 0 || tools.length > 0) &&
          (more ? (
            colorRow(true)
          ) : (
            <button type="button" className="ksm-more" aria-expanded={false} onClick={() => setMore(true)}>
              <Glyph name="highlight" size={12} />
              <span>Highlight, copy, cite…</span>
            </button>
          ))}
      </>
    );
  } else {
    body = (
      <>
        {title && <div className="ksm-head"><span className="ksm-mode">{title}</span></div>}
        {colorRow(false)}
        {rows.length > 0 && (
          <div className="ksm-actions" role="group" aria-label="More actions">
            {rows.map(({ action: a, targets }) => (
              <button key={a.id} type="button" className="ksm-chip pdfjs-selection-host" data-action={a.id} data-tone={a.tone} title={a.title ?? a.label} onClick={() => void run(targets[0].run, a)}>
                {a.icon && <Glyph name={a.icon} size={13} />}
                <span>{a.label}</span>
                <Kbd spec={a.key} />
              </button>
            ))}
          </div>
        )}
      </>
    );
  }
  const node = (
    <div
      ref={root}
      className={`ksm ${props.className ?? ''}`}
      data-mode={follow ? 'follow' : mode ? mode.id : undefined}
      data-side={place?.side}
      role={mode && !follow ? 'dialog' : 'toolbar'}
      aria-label={props.label ?? (mode ? mode.label : 'Selection')}
      style={style}
      onPointerDown={e => {
        // Keep the selection: only fields take focus.
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onMouseDown={e => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      {body}
    </div>
  );
  const host = props.portal ?? (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.key-ui-root') ?? document.body : null);
  return host ? createPortal(node, host) : node;
}
