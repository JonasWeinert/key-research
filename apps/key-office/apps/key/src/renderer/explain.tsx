// Guidance, in layers: a Hint (one plain sentence that is always there), an Explain popover
// one click away (what it is, how to, an example, what leaves this Mac), an EmptyState for
// an empty view, and a FirstUseTip that points out an easy-to-miss feature once. Every text
// comes from help-content.ts by id. Styles in explain.css.
//
//   <Hint help="settings.services.intro" />
//   <Explain help="settings.services.api-key" />            an (i) button
//   <Explain help="settings.services.api-key" label />      "What is an API key?" as a link
//   <EmptyState help="empty.inbox" icon="inbox" action={{ label: "Add a feed…", onClick }} learnMore="feeds.what" />
//   <FirstUseTip help="tip.inbox-keys" anchor={ref} />      once, beside `anchor`
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon, type IconName } from "./icons";
import { HELP, type EmptyEntry, type EmptyId, type ExplainEntry, type ExplainId, type HintEntry, type HintId, type TermEntry, type TipEntry, type TipId } from "./help-content";
import "./menu.css";
import "./explain.css";

type Shell = { tabAction?: (action: string, payload?: unknown) => Promise<unknown>; automation?: boolean };
const shell = () => (window as unknown as { key?: Shell }).key;

/** Opens a help link in Key's browser; a sheet that shows help (Settings) closes on the event. */
export function openHelpLink(url: string) {
  void shell()?.tabAction?.("open-url", { url });
  window.dispatchEvent(new CustomEvent("key:help-navigated", { detail: { url } }));
}

/** One plain sentence under a control or a heading. Pass `id` to point aria-describedby at it. */
export function Hint({ help, id, className }: { help: HintId; id?: string; className?: string }) {
  return (
    <p className={`kx-hint ${className ?? ""}`} id={id}>
      {(HELP[help] as HintEntry).text}
    </p>
  );
}

/** An (i) button, or with `label` a "What is …?" link, that opens a compact explanation.
 *  The (i) is named "Explain" and described by the explainer's title ("Explain, button,
 *  What is library access?"), so it never shares a name with the control it explains. */
export function Explain({ help, label, className }: { help: ExplainId; label?: boolean | string; className?: string }) {
  const entry = HELP[help] as ExplainEntry;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const text = typeof label === "string" ? label : entry.title;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${label ? "kx-explain-link" : "kx-explain-trigger"} ${className ?? ""}`}
        aria-label={label ? undefined : "Explain"}
        aria-description={label ? undefined : entry.title}
        title={label ? undefined : entry.title}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        data-help={help}
        onClick={(e) => {
          e.stopPropagation();
          // macOS does not focus a clicked button; Escape gives focus back to it.
          e.currentTarget.focus({ preventScroll: true });
          setOpen((v) => !v);
        }}
      >
        <Icon name="info" size={label ? 11 : 12} aria-hidden="true" />
        {label && <span>{text}</span>}
      </button>
      {open && <ExplainPopover id={popoverId} entry={entry} help={help} anchor={trigger} onClose={() => setOpen(false)} />}
    </>
  );
}

function ExplainPopover({ id, entry, help, anchor, onClose }: { id: string; entry: ExplainEntry; help: string; anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number }>();
  const titleId = `${id}-title`;
  useLayoutEffect(() => {
    const position = () => {
      const box = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!box || !el) return;
      const margin = 8;
      const width = el.offsetWidth;
      const height = el.scrollHeight;
      const below = window.innerHeight - box.bottom - margin - 6;
      const above = box.top - margin - 6;
      const down = height <= below || below >= above;
      const maxHeight = Math.max(120, down ? below : above);
      const top = down ? box.bottom + 6 : Math.max(margin, box.top - 6 - Math.min(height, maxHeight));
      setPlace({ left: Math.max(margin, Math.min(box.left - 12, window.innerWidth - width - margin)), top, maxHeight });
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [anchor]);
  // Focus moves in once it is placed (a hidden element takes no focus), so screen readers
  // read it; the dismiss layer gives focus back to the trigger on Escape.
  const placed = !!place;
  useEffect(() => {
    if (placed) ref.current?.focus({ preventScroll: true });
  }, [placed]);
  useDismiss(placed, { refs: [ref, anchor], anchor, onDismiss: onClose });
  return createPortal(
    <div
      ref={ref}
      id={id}
      className="kx-explain-popover"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-help={help}
      style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { visibility: "hidden" }}
    >
      <header>
        <h4 id={titleId}>{entry.title}</h4>
        <button type="button" className="kx-explain-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={9} />
        </button>
      </header>
      {entry.body.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {entry.steps && (
        <>
          <h5>How to</h5>
          <ol>
            {entry.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {entry.example && (
        <>
          <h5>Example</h5>
          <pre className="kx-explain-example">{entry.example}</pre>
        </>
      )}
      {entry.links?.map((link) => (
        <button
          key={link.url}
          type="button"
          className="kx-explain-open"
          onClick={() => {
            onClose();
            openHelpLink(link.url);
          }}
        >
          {link.label}
          <Icon name="arrowRight" size={10} />
        </button>
      ))}
      {entry.privacy && (
        <p className="kx-explain-privacy">
          <Icon name="lock" size={11} aria-hidden="true" />
          <span>
            <strong>What leaves this Mac: </strong>
            {entry.privacy}
          </span>
        </p>
      )}
    </div>,
    document.body,
  );
}

/** An empty view: what this place is, what to do, the action that does it. */
export function EmptyState({
  help,
  icon,
  action,
  secondary,
  learnMore,
  compact,
  className,
}: {
  help: EmptyId;
  icon: IconName;
  action?: { label: string; onClick: () => void; icon?: IconName };
  secondary?: ReactNode;
  learnMore?: ExplainId;
  compact?: boolean;
  className?: string;
}) {
  const entry = HELP[help] as EmptyEntry;
  return (
    <div className={`kx-empty-state ${className ?? ""}`} data-compact={compact || undefined} data-help={help}>
      <span className="kx-empty-state-icon" aria-hidden="true">
        <Icon name={icon} size={compact ? 18 : 22} />
      </span>
      <h2>{entry.title}</h2>
      <p>{entry.what}</p>
      <p className="kx-empty-state-todo">{entry.todo}</p>
      {(action || secondary || learnMore) && (
        <div className="kx-empty-state-actions">
          {action && (
            <button type="button" className="kx-button-primary" onClick={action.onClick}>
              {action.icon && <Icon name={action.icon} size={12} />}
              {action.label}
            </button>
          )}
          {secondary}
          {learnMore && <Explain help={learnMore} label="Learn more" />}
        </div>
      )}
    </div>
  );
}

// ── First-use tips ────────────────────────────────────────────────────────────────────────
// Which tips were seen, remembered for the whole app in its settings (main keeps them, so
// they survive a cleared profile storage and every view agrees; views hear `tips-changed`).
// Local storage is only this view's quick copy until the settings answer. Automated runs
// see none unless asked.
const TIPS_KEY = "key.tips";
interface TipsState {
  seen: string[];
  off: boolean;
}
let tipsCache: TipsState | undefined;
const tipListeners = new Set<() => void>();
function readTips(): TipsState {
  if (tipsCache) return tipsCache;
  try {
    const raw = JSON.parse(localStorage.getItem(TIPS_KEY) || "{}") as Partial<TipsState>;
    tipsCache = { seen: Array.isArray(raw.seen) ? raw.seen.filter((s) => typeof s === "string") : [], off: raw.off === true };
  } catch {
    tipsCache = { seen: [], off: false };
  }
  return tipsCache;
}
type TipsBridge = {
  appSettings?: () => Promise<{ settings?: { tips?: TipsState } } | undefined>;
  setAppSettings?: (patch: { tips: TipsState }) => Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => () => void;
};
const tipsBridge = () => (typeof window === "undefined" ? undefined : (window as unknown as { key?: TipsBridge }).key);
function keepTips(next: TipsState) {
  tipsCache = next;
  try {
    localStorage.setItem(TIPS_KEY, JSON.stringify(next));
  } catch {
    /* only the quick copy */
  }
  tipListeners.forEach((fn) => fn());
}
function writeTips(next: TipsState) {
  keepTips(next);
  void tipsBridge()?.setAppSettings?.({ tips: next })?.catch(() => {});
}
// The app's settings are the record: take them (with anything this view saw meanwhile).
const loadTips = () => {
  const bridge = tipsBridge();
  if (!bridge?.appSettings) return;
  void bridge
    .appSettings()
    .then((settings) => {
      const stored = settings?.settings?.tips;
      if (!stored) return;
      const local = readTips();
      const seen = [...new Set([...stored.seen, ...local.seen])];
      const merged = { seen, off: stored.off };
      keepTips(merged);
      if (seen.length !== stored.seen.length) writeTips(merged);
    })
    .catch(() => {});
  bridge.on?.("tips-changed", (value) => {
    const next = value as TipsState | undefined;
    if (next && Array.isArray(next.seen)) keepTips({ seen: next.seen, off: next.off === true });
  });
};
if (typeof window !== "undefined") loadTips();
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== TIPS_KEY) return;
    tipsCache = undefined;
    tipListeners.forEach((fn) => fn());
  });
const subscribeTips = (fn: () => void) => {
  tipListeners.add(fn);
  return () => void tipListeners.delete(fn);
};
export const useTips = () => useSyncExternalStore(subscribeTips, readTips);
export const markTipSeen = (id: TipId) => {
  const state = readTips();
  if (!state.seen.includes(id)) writeTips({ ...state, seen: [...state.seen, id] });
};
/** Settings › General: show tips at all, and show the seen ones again. */
export const setTipsShown = (shown: boolean) => writeTips({ ...readTips(), off: !shown });
export const resetTips = () => writeTips({ seen: [], off: false });

// One tip on screen at a time: the first to ask holds it.
let showing: string | null = null;

/** A coach mark beside `anchor` (a ref or a selector), shown once per feature until dismissed.
 *  It never blocks: it sits beside the feature, and using the feature also dismisses it. */
export function FirstUseTip({ help, anchor, when = true, side = "below", delay = 900 }: { help: TipId; anchor: RefObject<Element | null> | string; when?: boolean; side?: "below" | "above" | "right"; delay?: number }) {
  const tips = useTips();
  const entry = HELP[help] as TipEntry;
  const eligible = when && !tips.off && !tips.seen.includes(help) && !shell()?.automation;
  const [ready, setReady] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number; side: string }>();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const target = () => (typeof anchor === "string" ? document.querySelector(anchor) : anchor.current);
  useEffect(() => {
    if (!eligible) return;
    const timer = setTimeout(() => {
      if (showing && showing !== help) return;
      showing = help;
      setReady(true);
    }, delay);
    return () => {
      clearTimeout(timer);
      if (showing === help) showing = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, help]);
  const dismiss = () => {
    markTipSeen(help);
    if (showing === help) showing = null;
  };
  // Using the feature counts as having seen the tip.
  useEffect(() => {
    if (!ready) return;
    const el = target();
    if (!el) return;
    el.addEventListener("pointerdown", dismiss);
    return () => el.removeEventListener("pointerdown", dismiss);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useLayoutEffect(() => {
    if (!ready) return;
    const position = () => {
      const el = target();
      const card = ref.current;
      const box = el?.getBoundingClientRect();
      if (!box || !card || !el?.isConnected || (!box.width && !box.height) || box.bottom < 0 || box.top > window.innerHeight) return setPlace(undefined);
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const m = 8;
      let s = side;
      if (s === "below" && box.bottom + 10 + h > window.innerHeight - m) s = "above";
      if (s === "above" && box.top - 10 - h < m) s = "below";
      if (s === "right" && box.right + 10 + w > window.innerWidth - m) s = "below";
      const left = s === "right" ? box.right + 10 : Math.max(m, Math.min(box.left + box.width / 2 - w / 2, window.innerWidth - w - m));
      const top = s === "right" ? Math.max(m, box.top + box.height / 2 - h / 2) : s === "below" ? box.bottom + 10 : box.top - 10 - h;
      const arrow = s === "right" ? box.top + box.height / 2 - top : box.left + box.width / 2 - left;
      setPlace({ left, top, arrow: Math.max(12, Math.min(arrow, (s === "right" ? h : w) - 12)), side: s });
    };
    position();
    const timer = setInterval(position, 500);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, side]);
  if (!eligible || !ready) return null;
  return createPortal(
    <div
      ref={ref}
      className="kx-tip"
      role="note"
      aria-labelledby={titleId}
      data-tip={help}
      data-side={place?.side}
      style={place ? { left: place.left, top: place.top, ["--kx-tip-arrow" as string]: `${place.arrow}px` } : { visibility: "hidden", left: 0, top: 0 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <Icon name="sparkle" size={12} aria-hidden="true" />
      <div>
        <strong id={titleId}>{entry.title}</strong>
        <p>{entry.body}</p>
      </div>
      <button type="button" className="kx-tip-done" onClick={dismiss}>
        Got it
      </button>
    </div>,
    document.body,
  );
}

/** Settings › General › Glossary: every term, in a list that opens one at a time. */
export function Glossary() {
  const terms = Object.entries(HELP).filter((e): e is [string, TermEntry] => e[1].kind === "term");
  return (
    <dl className="kx-glossary">
      {terms.map(([id, t]) => (
        <div key={id} data-help={id}>
          <dt>{t.term}</dt>
          <dd>{t.text}</dd>
        </div>
      ))}
    </dl>
  );
}
