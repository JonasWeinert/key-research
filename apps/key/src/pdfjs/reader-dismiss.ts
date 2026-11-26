// The reader's transient overlays (selection toolbar, link and citation cards) close like the
// shell's (ui/dismiss): on a press outside them (it passes through, so a new selection or a
// click on another citation still works), on scrolling the page away from them, on a press
// in another view of the window, and when the reader's tab is hidden. The reader keeps its
// own Escape, which also clears the selection.
import { dismissAll, useDismiss, within } from '../ui/dismiss';

if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) dismissAll('switch');
  });

/** Keeps the overlay matching `selector` registered while `open`. */
/** `scroll: false` keeps it open while things scroll (a card the user pinned). */
export function useReaderOverlay(open: boolean, selector: string, onDismiss: () => void, options: { scroll?: boolean } = {}) {
  useDismiss(open, {
    refs: [],
    inside: target => within(target, selector),
    kind: 'passive',
    escape: false,
    scroll: options.scroll,
    onDismiss,
  });
}
