// Small pieces the review screens share: buttons, a menu button, a status pill, a confirm sheet,
// keyword highlighting and a hook that loads with errors kept for the screen.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "../db-ui";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon, type IconName } from "../icons";
import { STATUS_LABEL, type StatusInfo } from "./review-api";

export function Btn({ children, icon, primary, danger, small, quiet, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; primary?: boolean; danger?: boolean; small?: boolean; quiet?: boolean }) {
  return (
    <button type="button" className="kx-rv-btn" data-primary={primary || undefined} data-danger={danger || undefined} data-small={small || undefined} data-quiet={quiet || undefined} {...rest}>
      {icon && <Icon name={icon} size={small ? 11 : 13} />}
      {children}
    </button>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  checked?: boolean;
}

/** A button that opens a menu of commands; `null` entries are separators. */
export function MenuButton({ label, icon = "more", items, title, children, width = 240 }: { label: string; icon?: IconName; items: (MenuItem | null)[]; title?: string; children?: ReactNode; width?: number }) {
  const [anchor, setAnchor] = useState<DOMRect>();
  return (
    <>
      <button type="button" className={children ? "kx-rv-btn" : "kx-rv-icon"} aria-label={label} title={title ?? label} aria-haspopup="menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget.getBoundingClientRect())}>
        {(!children || icon !== "more") && <Icon name={icon} size={children ? 13 : 15} />}
        {children}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)} label={label} width={width}>
          {items.map((item, i) =>
            item ? (
              <button
                key={`${item.label}-${i}`}
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                disabled={item.disabled}
                data-danger={item.danger || undefined}
                onClick={() => {
                  setAnchor(undefined);
                  item.run();
                }}
              >
                {item.checked !== undefined ? <span className="kx-db-check">{item.checked && <Icon name="check" size={11} />}</span> : item.icon && <Icon name={item.icon} size={13} />}
                <span>{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            ) : (
              <hr key={`sep-${i}`} />
            ),
          )}
        </Popover>
      )}
    </>
  );
}

const STATUS_TONE: Record<StatusInfo["name"], string> = {
  notEligible: "muted",
  notRetrieved: "warning",
  undecided: "muted",
  partial: "info",
  conflict: "warning",
  included: "green",
  excluded: "red",
  maybe: "amber",
};

export function StatusPill({ status, compact }: { status: StatusInfo; compact?: boolean }) {
  const label = status.name === "partial" && status.have != null ? `${status.have} of ${status.need}` : STATUS_LABEL[status.name];
  return (
    <span className="kx-rv-pill" data-tone={STATUS_TONE[status.name]} title={status.auto ? "Applied by a rule linked to metadata" : status.resolved ? "Resolved" : undefined}>
      {status.auto && !compact && <Icon name="function" size={10} />}
      {label}
    </span>
  );
}

/** A yes/no question in a sheet. */
export function Confirm({ title, body, confirm, danger, onConfirm, onClose, children }: { title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void | Promise<unknown>; onClose: () => void; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <GlobalDialog label={title} onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          Promise.resolve(onConfirm())
            .then(onClose)
            .catch((err) => setError(String(err?.message ?? err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{title}</h2>
        <div className="kx-rv-dialog-body">{body}</div>
        {children}
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary={!danger || undefined} data-danger={danger || undefined} disabled={busy} autoFocus>
            {confirm}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with the review's keywords marked (green for inclusion terms, red for exclusion terms). */
export function Highlighted({ text, include, exclude, query }: { text: string; include: string[]; exclude: string[]; query?: string }) {
  const terms = [
    ...include.filter(Boolean).map((t) => ({ t, kind: "include" })),
    ...exclude.filter(Boolean).map((t) => ({ t, kind: "exclude" })),
    ...(query ?? "")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => ({ t, kind: "query" })),
  ];
  if (!terms.length || !text) return <>{text}</>;
  // A trailing * is a stem: "random*" marks randomised, randomly …
  const pattern = new RegExp(`(${terms.map(({ t }) => (t.endsWith("*") ? `\\b${escape(t.slice(0, -1))}\\w*` : `\\b${escape(t)}\\b`)).join("|")})`, "gi");
  const kindOf = (part: string) =>
    terms.find(({ t }) => (t.endsWith("*") ? part.toLowerCase().startsWith(t.slice(0, -1).toLowerCase()) : part.toLowerCase() === t.toLowerCase()))?.kind;
  return (
    <>
      {text.split(pattern).map((part, i) => {
        const kind = i % 2 ? kindOf(part) : undefined;
        return kind ? (
          <mark key={i} className="kx-rv-mark" data-kind={kind}>
            {part}
          </mark>
        ) : (
          part
        );
      })}
    </>
  );
}

/** Loads with `load`, again when `deps` change or `reload()` is called. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const n = ++generation.current;
    setLoading(true);
    load()
      .then((v) => {
        if (n === generation.current) {
          setValue(v);
          setError("");
        }
      })
      .catch((e) => n === generation.current && setError(String(e?.message ?? e)))
      .finally(() => n === generation.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { value, error, loading, reload, setValue };
}

/** A short-lived message at the bottom of the review. */
export function useNotice() {
  const [notice, setNotice] = useState<{ text: string; tone?: "error" | "ok"; action?: { label: string; run: () => void } }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((text: string, tone?: "error" | "ok", action?: { label: string; run: () => void }) => {
    clearTimeout(timer.current);
    setNotice({ text, tone, action });
    timer.current = setTimeout(() => setNotice(undefined), tone === "error" ? 7000 : 4000);
  }, []);
  const view = notice ? (
    <div className="kx-rv-notice" role={notice.tone === "error" ? "alert" : "status"} data-tone={notice.tone} title="Click to close" onClick={(e) => e.target === e.currentTarget && setNotice(undefined)}>
      <span>{notice.text}</span>
      {notice.action && (
        <button
          type="button"
          onClick={() => {
            notice.action!.run();
            setNotice(undefined);
          }}
        >
          {notice.action.label}
        </button>
      )}
    </div>
  ) : null;
  const clear = useCallback(() => setNotice(undefined), []);
  return { show, view, clear };
}

export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error: /, "");

export function formatDate(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
export function formatTime(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A labelled settings row. */
export function Row({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="kx-rv-row" data-wide={wide || undefined}>
      <div className="kx-rv-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="kx-rv-row-control">{children}</div>
    </div>
  );
}

/** A segmented choice for a few options. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="kx-rv-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="kx-rv-toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span aria-hidden="true" />
    </label>
  );
}
