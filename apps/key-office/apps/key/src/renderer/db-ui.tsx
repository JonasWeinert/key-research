// Small pieces the database search screens share: an anchored popover, a menu of choices,
// counts written for people.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "./icons";

const numberFormat = new Intl.NumberFormat("en-GB");
/** 12,400 · about 1.2 million · — */
export function countText(n: number | null | undefined, exact = true) {
  if (n === undefined || n === null) return "—";
  const prefix = exact ? "" : "≈ ";
  if (n >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} million`;
  return prefix + numberFormat.format(n);
}
export const plural = (n: number, one: string, many = `${one}s`) => `${numberFormat.format(n)} ${n === 1 ? one : many}`;

/** A popover under (or above) an anchor that closes on an outside press, scrolling away or Escape. */
export function Popover({ anchor, onClose, children, className = "", label, width = 300 }: { anchor: DOMRect; onClose: () => void; children: ReactNode; className?: string; label: string; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, { refs: [box], onDismiss: onClose });
  const [style, setStyle] = useState<CSSProperties>({ left: anchor.left, top: anchor.bottom + 4, width, visibility: "hidden" });
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 0;
    const below = anchor.bottom + 4 + height < innerHeight - 8;
    setStyle({ left: Math.max(8, Math.min(anchor.left, innerWidth - width - 8)), top: below ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4), width });
  }, [anchor, width]);
  return createPortal(
    <div ref={box} className={`kx-menu-popover kx-db-popover ${className}`} role="dialog" aria-label={label} style={style}>
      {children}
    </div>,
    document.body,
  );
}

/** A button that opens a menu of choices to tick (document types, languages). */
export function ChoiceMenu({ label, choices, value, onChange, summary }: { label: string; choices: [string, string][]; value: string[]; onChange: (next: string[]) => void; summary?: string }) {
  const [anchor, setAnchor] = useState<DOMRect>();
  return (
    <>
      <button type="button" className="kx-db-filter" aria-haspopup="dialog" aria-expanded={!!anchor} data-active={value.length > 0 || undefined} onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget.getBoundingClientRect())}>
        <span>{value.length ? (summary ?? `${label}: ${value.length}`) : label}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)} label={label} width={220}>
          {choices.map(([id, text]) => {
            const on = value.includes(id);
            return (
              <button key={id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => onChange(on ? value.filter((v) => v !== id) : [...value, id])}>
                <span className="kx-db-check">{on && <Icon name="check" size={11} />}</span>
                {text}
              </button>
            );
          })}
          {value.length > 0 && (
            <>
              <hr />
              <button type="button" onClick={() => onChange([])}>
                <span className="kx-db-check" />
                Any
              </button>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

/** Copies text, saying so briefly on the button. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="kx-db-icon-button"
      title={done ? "Copied" : label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      <Icon name={done ? "check" : "copy"} size={12} />
    </button>
  );
}

/** Saves text as a file through the browser's download (Electron asks where). */
export function downloadText(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
