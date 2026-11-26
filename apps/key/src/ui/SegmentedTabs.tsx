// The app's one secondary tab bar (everything except the main window's tab strips): a
// rounded, translucent track whose tabs share its full width, with a sliding pill under the
// chosen one, Safari style. Past their minimum width the tabs scroll sideways, with faded
// edges, the wheel scrolling them and the chosen tab kept in view.
//
//   <SegmentedTabs
//     label="Panel sections"
//     value={section}
//     onChange={setSection}
//     tabs={[{ id: "details", label: "Details" }, { id: "refs", label: "References", badge: 42 }]}
//   />
//
// `tablist` semantics: arrow keys, Home and End move between tabs (choosing as they go).
// Give `panelId(id)` to point each tab at its panel (`aria-controls`).
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import './segmented-tabs.css';

export interface SegmentedTab<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** A count or mark after the label. */
  badge?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedTabsProps<T extends string = string> {
  label: string;
  tabs: SegmentedTab<T>[];
  value: T | undefined;
  onChange: (id: T) => void;
  /** `small` for dense headers (side panels, cards). */
  size?: 'regular' | 'small';
  /** Each tab's minimum width before the bar scrolls (px). */
  minTabWidth?: number;
  panelId?: (id: T) => string;
  className?: string;
  style?: CSSProperties;
}

export function SegmentedTabs<T extends string = string>({
  label,
  tabs,
  value,
  onChange,
  size = 'regular',
  minTabWidth,
  panelId,
  className,
  style,
}: SegmentedTabsProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const settled = useRef(false);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    setPill(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
  }, []);

  // Keep the chosen tab in view (only this bar scrolls, never its ancestors).
  useLayoutEffect(() => {
    const el = scroller.current;
    const active = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (el && active && el.scrollWidth > el.clientWidth) {
      const pad = 16;
      if (active.offsetLeft - pad < el.scrollLeft) el.scrollLeft = active.offsetLeft - pad;
      else if (active.offsetLeft + active.offsetWidth + pad > el.scrollLeft + el.clientWidth)
        el.scrollLeft = active.offsetLeft + active.offsetWidth + pad - el.clientWidth;
    }
    measure();
  }, [value, tabs.length, measure]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    const frame = requestAnimationFrame(() => (settled.current = true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measure, tabs.length]);

  // A vertical wheel scrolls the bar sideways while it overflows.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    const enabled = tabs.filter(t => !t.disabled);
    const at = enabled.findIndex(t => t.id === value);
    let next: SegmentedTab<T> | undefined;
    if (event.key === 'ArrowRight') next = enabled[(at + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled.at(-1);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next.id);
    const id = next.id;
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus());
  };

  return (
    <div
      className={`key-segmented${className ? ` ${className}` : ''}`}
      data-size={size}
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      style={minTabWidth ? ({ ...style, '--key-segmented-min': `${minTabWidth}px` } as CSSProperties) : style}
    >
      <div
        ref={scroller}
        className="key-segmented-track"
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onScroll={measure}
      >
        {pill && (
          <span
            className="key-segmented-pill"
            aria-hidden="true"
            data-animate={settled.current || undefined}
            style={{ transform: `translateX(${pill.left}px)`, width: pill.width }}
          />
        )}
        {tabs.map(tab => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={selected}
              aria-controls={panelId?.(tab.id)}
              tabIndex={selected || (value === undefined && tab === tabs[0]) ? 0 : -1}
              disabled={tab.disabled}
              title={tab.title}
              onClick={() => onChange(tab.id)}
            >
              {tab.icon}
              <span className="key-segmented-label">{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== null && tab.badge !== '' && (
                <small className="key-segmented-badge">{tab.badge}</small>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
