// The reader's floating toolbar steps aside while you read: scrolling down hides it, scrolling
// up, the pointer near the top, keyboard focus in it, or the top of the document bring it
// back. It stays while Find or a search result is open.
import { useEffect, useState, type RefObject } from "react";

/** How far the pointer may be from the top of the reader for the toolbar to come back. */
export const REVEAL_ZONE = 72;
/** Scroll distance that counts as a direction, so tremors and inertia tails don't flicker it. */
const SCROLL_INTENT = 6;
/** Near the top of the document the toolbar always shows. */
const TOP_ZONE = 32;

export type ChromeScroll = { away: boolean; lastTop: number | null };

/** Next state after the reading area scrolled to `top`. Pure, for tests. */
export function chromeAfterScroll(state: ChromeScroll, top: number): ChromeScroll {
  if (top <= TOP_ZONE) return { away: false, lastTop: top };
  if (state.lastTop === null) return { away: state.away, lastTop: top };
  const delta = top - state.lastTop;
  if (Math.abs(delta) < SCROLL_INTENT) return state;
  return { away: delta > 0, lastTop: top };
}

export function useFloatingChrome(
  surface: RefObject<HTMLElement | null>,
  chrome: RefObject<HTMLElement | null>,
  pinned: boolean,
  mounted: boolean,
) {
  const [away, setAway] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const element = surface.current;
    const bar = chrome.current;
    if (!mounted || !element) return;
    let state: ChromeScroll = { away: false, lastTop: null };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("pdfjs-scroll")) return;
      state = chromeAfterScroll(state, target.scrollTop);
      setAway(state.away);
    };
    const reveal = () => {
      if (!state.away) return;
      // Revealed by the pointer: the next scroll measures from here.
      state = { away: false, lastTop: state.lastTop };
      setAway(false);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.clientY - element.getBoundingClientRect().top <= REVEAL_ZONE) reveal();
    };
    const onFocusIn = () => {
      setFocused(true);
      reveal();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!bar?.contains(event.relatedTarget as Node | null)) setFocused(false);
    };
    element.addEventListener("scroll", onScroll, { capture: true, passive: true });
    element.addEventListener("pointermove", onPointerMove, { passive: true });
    bar?.addEventListener("focusin", onFocusIn);
    bar?.addEventListener("focusout", onFocusOut);
    return () => {
      element.removeEventListener("scroll", onScroll, { capture: true });
      element.removeEventListener("pointermove", onPointerMove);
      bar?.removeEventListener("focusin", onFocusIn);
      bar?.removeEventListener("focusout", onFocusOut);
    };
  }, [surface, chrome, mounted]);
  return away && !pinned && !focused;
}
