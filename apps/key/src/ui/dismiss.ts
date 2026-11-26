// One way for every transient overlay (menus, popovers, pickers, hover cards, suggestion
// lists) to go away, shared by the Electron shell and the PDF reader:
// - a press anywhere outside it, including in another webContents of the window (the main
//   process relays those as "dismiss-overlays"), or the window losing focus;
// - scrolling away: more than SCROLL_PX of wheel or scroll outside it, or its anchor
//   scrolling out of view. Scrolling inside it never closes it;
// - Escape closes the topmost one only, and gives focus back to what had it.
// Open overlays form a stack: a press inside a parent closes only the children above it.
// Menus swallow the press that dismisses them (as macOS does); passive overlays such as
// hover cards let it through.
import { useEffect, useRef, type RefObject } from "react";

export type DismissReason = "outside" | "scroll" | "escape" | "blur" | "external" | "switch";

export interface DismissLayer {
  /** True when `target` belongs to the overlay (its box, its trigger …). */
  contains(target: Node): boolean;
  close(reason: DismissReason): void;
  /** "menu" (default): the dismissing press is swallowed. "passive": it passes through. */
  kind?: "menu" | "passive";
  /** The element it hangs from; it closes when that scrolls out of view. */
  anchor?: () => Element | null | undefined;
  /** False when the overlay handles Escape itself (an editor's suggestion menu). */
  escape?: boolean;
  /** False to stay open while things scroll. */
  scroll?: boolean;
}

/** Scrolling this far outside an overlay closes it, so a trackpad twitch doesn't. */
export const SCROLL_PX = 32;

interface Entry {
  layer: DismissLayer;
  focus: Element | null;
  scrolled: number;
  baselines: Map<Element, number>;
}
const stack: Entry[] = [];
let installed = false;
let swallowUntil = 0;
let quietTimer: ReturnType<typeof setTimeout> | undefined;

const closeEntry = (entry: Entry, reason: DismissReason) => {
  const at = stack.indexOf(entry);
  if (at < 0) return;
  stack.splice(at, 1);
  entry.layer.close(reason);
};
/** Closes the layers above index `keep` (exclusive), topmost first. */
const closeAbove = (keep: number, reason: DismissReason) => {
  for (let i = stack.length - 1; i > keep; i--) if (stack[i]) closeEntry(stack[i], reason);
};
/** Index of the topmost layer the node is inside, or -1. */
const owner = (node: Node | null) => {
  if (!node) return -1;
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].layer.contains(node)) return i;
  return -1;
};

/** Counts scrolling outside the layers above `inside` toward closing them. */
const scrollAway = (inside: number, amount: number) => {
  for (let i = stack.length - 1; i > inside; i--) {
    const entry = stack[i];
    if (!entry || entry.layer.scroll === false) continue;
    entry.scrolled += amount;
    if (entry.scrolled > SCROLL_PX) closeEntry(entry, "scroll");
  }
  clearTimeout(quietTimer);
  // A pause resets the count: small separate nudges don't add up.
  quietTimer = setTimeout(() => stack.forEach((entry) => (entry.scrolled = 0)), 700);
};

const anchorHidden = (anchor: Element) => {
  if (!anchor.isConnected) return true;
  const rect = anchor.getBoundingClientRect();
  if (!rect.width && !rect.height) return true;
  for (let el = anchor.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) continue;
    const box = el.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right) return true;
  }
  return rect.bottom <= 0 || rect.top >= innerHeight;
};

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const swallow = (e: Event) => {
    if (performance.now() > swallowUntil) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type === "click") swallowUntil = 0;
    // The click follows pointerup straight away; then stop swallowing.
    if (e.type === "pointerup") swallowUntil = Math.min(swallowUntil, performance.now() + 60);
  };
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!stack.length) return;
      const inside = owner(e.target as Node);
      if (inside === stack.length - 1) return;
      const closing = stack.slice(inside + 1);
      closeAbove(inside, "outside");
      // A plain press that closed a menu does nothing else; a right-click still opens a menu there.
      if (e.button === 0 && closing.some((entry) => entry.layer.kind !== "passive")) {
        swallowUntil = performance.now() + 1000;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
  for (const type of ["mousedown", "pointerup", "mouseup", "click", "dblclick"]) window.addEventListener(type, swallow, true);
  window.addEventListener(
    "wheel",
    (e) => {
      if (!stack.length) return;
      scrollAway(owner(e.target as Node), Math.abs(e.deltaY) + Math.abs(e.deltaX));
    },
    { capture: true, passive: true },
  );
  // Scrolling by keyboard, scrollbar or code: count the distance, and watch the anchors.
  document.addEventListener(
    "scroll",
    (e) => {
      if (!stack.length) return;
      const target = e.target instanceof Element ? e.target : document.scrollingElement;
      if (!target) return;
      const inside = owner(target);
      for (let i = stack.length - 1; i > inside; i--) {
        const entry = stack[i];
        if (!entry || entry.layer.scroll === false) continue;
        const anchor = entry.layer.anchor?.();
        if (anchor && !anchor.contains(target) && anchorHidden(anchor)) {
          closeEntry(entry, "scroll");
          continue;
        }
        const top = target.scrollTop + target.scrollLeft;
        const base = entry.baselines.get(target);
        if (base === undefined) entry.baselines.set(target, top);
        else if (Math.abs(top - base) > SCROLL_PX) closeEntry(entry, "scroll");
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !stack.length || e.defaultPrevented) return;
      const top = stack[stack.length - 1];
      if (top.layer.escape === false) return;
      e.stopPropagation();
      e.preventDefault();
      const active = document.activeElement;
      closeEntry(top, "escape");
      // Focus goes back to the trigger, unless the user moved it somewhere else meanwhile.
      const back = top.focus ?? top.layer.anchor?.();
      if (back instanceof HTMLElement && back.isConnected && (!active || active === document.body || top.layer.contains(active) || !active.isConnected)) back.focus();
    },
    true,
  );
  // Presses, scrolls and focus loss in the window's other webContents (main/dismiss-relay.ts).
  const key = (window as unknown as { key?: { on?: (event: string, callback: (value: unknown) => void) => () => void } }).key;
  try {
    key?.on?.("dismiss-overlays", (value) => {
      const signal = value as { reason: string; dy?: number };
      if (signal.reason === "scroll") scrollAway(-1, signal.dy ?? SCROLL_PX + 1);
      else dismissAll(signal.reason === "blur" ? "blur" : "external");
    });
  } catch {
    // A host without the event (an older preload) only loses the cross-view relay.
  }
}

/** Registers an open overlay; returns a function that unregisters it (without closing it). */
export function openLayer(layer: DismissLayer): () => void {
  install();
  const focus = typeof document === "undefined" ? null : document.activeElement;
  const entry: Entry = { layer, focus: focus && focus !== document.body ? focus : null, scrolled: 0, baselines: new Map() };
  stack.push(entry);
  return () => {
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
  };
}

/** Closes every open overlay (switching tabs, a press elsewhere in the window …). */
export function dismissAll(reason: DismissReason = "external") {
  closeAbove(-1, reason);
}

/** How many overlays are open (for tests). */
export const openLayers = () => {
  install();
  return stack.length;
};

/** Makes `<details>` menus matching `selector` dismiss like any overlay: they register when
 *  opened and close by unsetting `open`. Call once per document. */
export function trackDetailsMenus(selector: string) {
  const open = new Map<HTMLDetailsElement, () => void>();
  document.addEventListener(
    "toggle",
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement) || !details.matches(selector)) return;
      if (details.open && !open.has(details)) {
        const summary = details.querySelector("summary");
        open.set(
          details,
          openLayer({
            contains: (target) => details.contains(target),
            close: () => {
              open.delete(details);
              details.open = false;
            },
            anchor: () => summary ?? details,
          }),
        );
      } else if (!details.open) {
        open.get(details)?.();
        open.delete(details);
      }
    },
    true,
  );
}

type ElementRef = RefObject<Element | null>;
export interface DismissOptions extends Omit<DismissLayer, "contains" | "close" | "anchor"> {
  /** The overlay and anything else that counts as inside it (its trigger button). */
  refs: ElementRef[];
  /** Also inside, for overlays whose parts have no common ref (matched by selector …). */
  inside?: (target: Node) => boolean;
  /** The element it hangs from, if not its first ref's trigger. */
  anchor?: ElementRef | (() => Element | null | undefined);
  onDismiss: (reason: DismissReason) => void;
}

/** Keeps an overlay registered while `open`. Options are read when an event happens, so
 *  callers may pass fresh closures each render. */
export function useDismiss(open: boolean, options: DismissOptions) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!open) return;
    return openLayer({
      contains: (target) => latest.current.refs.some((ref) => !!ref.current?.contains(target)) || !!latest.current.inside?.(target),
      close: (reason) => latest.current.onDismiss(reason),
      get kind() {
        return latest.current.kind;
      },
      get escape() {
        return latest.current.escape;
      },
      get scroll() {
        return latest.current.scroll;
      },
      anchor: () => {
        const anchor = latest.current.anchor;
        return typeof anchor === "function" ? anchor() : anchor?.current;
      },
    });
  }, [open]);
}

/** True when `node` (an element or text) sits inside an element matching `selector`. */
export const within = (node: Node, selector: string) => !!(node instanceof Element ? node : node.parentElement)?.closest(selector);
