// A modal's stable height (see modal.css). The frame is as tall as its content, capped by
// the window; within one view it only grows, so typing, filtering or a list filling in
// never makes it jump smaller. When the view changes (the `data-modal-view` attribute of
// an element inside it: a Settings section, a sheet's step) the height settles to the new
// content, animated.
import { useLayoutEffect, type RefObject } from "react";

const VIEW = "[data-modal-view]";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useStableModalSize(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let view: string | undefined;
    let held = 0;
    let frame = 0;
    let settling: ReturnType<typeof setTimeout> | undefined;
    const viewOf = () => el.querySelector(VIEW)?.getAttribute("data-modal-view") ?? "";
    const measure = () => {
      frame = 0;
      const next = viewOf();
      const first = view === undefined;
      const changed = !first && next !== view;
      const before = el.offsetHeight;
      const style = el.style;
      // Let the content (and the CSS floor and cap) decide, then hold that.
      style.transition = "none";
      style.height = "";
      style.bottom = "auto";
      const natural = el.offsetHeight;
      style.bottom = "";
      const target = first || changed ? natural : Math.max(held, natural);
      view = next;
      held = target;
      if (changed && Math.abs(before - target) > 1 && !reduced()) {
        style.height = `${before}px`;
        void el.offsetHeight;
        style.transition = "height 260ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        style.height = `${target}px`;
        clearTimeout(settling);
        settling = setTimeout(() => (style.transition = ""), 300);
      } else {
        style.height = `${target}px`;
        style.transition = "";
      }
      el.dataset.modalHeld = String(target);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // Content changes: nodes, text, and the attributes that switch views or reveal parts.
    const mutations = new MutationObserver(schedule);
    mutations.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-modal-view", "class", "hidden", "open", "aria-expanded", "data-step", "data-scope", "src"],
    });
    // Images and other replaced content settle their size late.
    const loads = () => schedule();
    el.addEventListener("load", loads, true);
    // A window resize reconsiders the cap; the held height is kept.
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settling);
      mutations.disconnect();
      el.removeEventListener("load", loads, true);
      window.removeEventListener("resize", schedule);
      el.style.height = "";
      el.style.transition = "";
    };
  }, [ref, enabled]);
}
