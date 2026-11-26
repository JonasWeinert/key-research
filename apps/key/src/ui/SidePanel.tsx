// A side panel with sections: a header with a segmented switch between them (or the one
// section's title), the host's own actions (pop out, close …) at its trailing end, and the
// active section below. Optionally resizable from its leading edge. It remembers the chosen
// section and its width under `storageKey`.
//
//   <SidePanel
//     label="Reader panel"
//     storageKey="key.reader.panel"
//     sections={[
//       { id: "details", title: "Details", render: () => <Details />, keepMounted: true },
//       { id: "references", title: "References", badge: 42, render: () => <References /> },
//     ]}
//     actions={<button onClick={close}>…</button>}
//     resizable={{ min: 260, max: 560, initial: 340 }}
//   />
//
// Pass `active`/`onActiveChange` to control the section from outside (another view, the
// status bar); left out, the panel keeps it itself. Sections are a plain list, so a host adds
// one by adding an entry.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SegmentedTabs } from './SegmentedTabs';
import './side-panel.css';

export interface SidePanelSection {
  id: string;
  title: string;
  icon?: ReactNode;
  /** A count or mark beside the title in the switch. */
  badge?: ReactNode;
  render: () => ReactNode;
  /** Stays rendered (hidden) while another section shows, keeping its state. */
  keepMounted?: boolean;
  disabled?: boolean;
}

export interface SidePanelProps {
  label: string;
  sections: SidePanelSection[];
  active?: string;
  onActiveChange?: (id: string) => void;
  /** Where the chosen section and width are remembered (localStorage). */
  storageKey?: string;
  /** Buttons at the header's trailing end. */
  actions?: ReactNode;
  /** A drag handle on the leading edge; the width is remembered under `storageKey`. */
  resizable?: { min: number; max: number; initial: number };
  className?: string;
  style?: CSSProperties;
}

const read = (key: string | undefined) => {
  if (!key) return undefined;
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const write = (key: string | undefined, value: string) => {
  if (!key) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage off: the panel just forgets.
  }
};

/** The section a panel remembered under `storageKey`, for hosts that keep it themselves. */
export function rememberedSection(storageKey: string, fallback: string) {
  return read(`${storageKey}.section`) ?? fallback;
}
export function rememberSection(storageKey: string, id: string) {
  write(`${storageKey}.section`, id);
}

export function SidePanel({ label, sections, active, onActiveChange, storageKey, actions, resizable, className, style }: SidePanelProps) {
  const [own, setOwn] = useState(() => read(storageKey && `${storageKey}.section`));
  const shown = sections.find(s => s.id === (active ?? own) && !s.disabled) ?? sections.find(s => !s.disabled) ?? sections[0];
  const choose = (id: string) => {
    if (storageKey) rememberSection(storageKey, id);
    if (active === undefined) setOwn(id);
    onActiveChange?.(id);
  };
  const [width, setWidth] = useState(() => {
    if (!resizable) return undefined;
    const saved = Number(read(storageKey && `${storageKey}.width`));
    return Number.isFinite(saved) && saved > 0 ? Math.min(resizable.max, Math.max(resizable.min, saved)) : resizable.initial;
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = useCallback((value: number) => (resizable ? Math.min(resizable.max, Math.max(resizable.min, value)) : value), [resizable]);
  useEffect(() => {
    if (width !== undefined) write(storageKey && `${storageKey}.width`, String(Math.round(width)));
  }, [storageKey, width]);
  return (
    <aside
      className={`key-side-panel${className ? ` ${className}` : ''}`}
      aria-label={label}
      style={width !== undefined ? { ...style, width } : style}
    >
      {resizable && (
        <div
          className="key-side-panel-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label.toLowerCase()}`}
          aria-valuemin={resizable.min}
          aria-valuemax={resizable.max}
          aria-valuenow={Math.round(width ?? resizable.initial)}
          tabIndex={0}
          onPointerDown={event => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, width: width ?? resizable.initial };
          }}
          onPointerMove={event => {
            if (drag.current) setWidth(clamp(drag.current.width + drag.current.x - event.clientX));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onDoubleClick={() => setWidth(resizable.initial)}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setWidth(current => clamp((current ?? resizable.initial) + (event.key === 'ArrowLeft' ? 16 : -16)));
          }}
        />
      )}
      <header className="key-side-panel-head">
        {sections.length > 1 ? (
          <SegmentedTabs
            className="key-side-panel-switch"
            size="small"
            label={label}
            value={shown?.id}
            onChange={choose}
            tabs={sections.map(section => ({ id: section.id, label: section.title, icon: section.icon, badge: section.badge, disabled: section.disabled }))}
          />
        ) : (
          <strong className="key-side-panel-title">
            {shown?.icon}
            {shown?.title}
            {shown?.badge !== undefined && shown?.badge !== null && <small className="key-side-panel-badge">{shown.badge}</small>}
          </strong>
        )}
        {actions && <span className="key-side-panel-actions">{actions}</span>}
      </header>
      {sections.map(section =>
        section.id === shown?.id || section.keepMounted ? (
          <div
            key={section.id}
            className="key-side-panel-body"
            role={sections.length > 1 ? 'tabpanel' : undefined}
            data-section={section.id}
            hidden={section.id !== shown?.id}
          >
            {section.id === shown?.id || section.keepMounted ? section.render() : null}
          </div>
        ) : null,
      )}
    </aside>
  );
}
