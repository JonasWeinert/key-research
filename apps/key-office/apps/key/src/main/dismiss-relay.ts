// A window's shell and its native views (PDF readers, web pages) are separate
// webContents: a press or scroll in one never reaches the others' DOM. This relays them, so a
// press anywhere in the window dismisses menus and popovers open in any other webContents, and
// scrolling elsewhere counts as scrolling away. Renderers receive "dismiss-overlays".
import { app, type BrowserWindow, type WebContents, type WebContentsView } from "electron";

export type DismissSignal = { reason: "press" } | { reason: "scroll"; dy: number } | { reason: "blur" };

/** Every webContents shown in the window: the shell first, then its child views. */
function contentsOf(window: BrowserWindow): WebContents[] {
  const children = window.contentView.children
    .map((view) => (view as WebContentsView).webContents as WebContents | undefined)
    .filter((contents): contents is WebContents => !!contents);
  return [window.webContents, ...children];
}

function send(window: BrowserWindow | undefined, from: WebContents | undefined, signal: DismissSignal) {
  if (!window || window.isDestroyed()) return;
  for (const contents of contentsOf(window)) {
    if (contents === from || contents.isDestroyed()) continue;
    contents.send("dismiss-overlays", signal);
  }
}

const WHEEL_STEP = 12;

/** Relays presses and wheel scrolls in `contents` to the other webContents of its window
 *  (looked up on each event: a view can move between windows). */
export function relayDismiss(contents: WebContents, windowOf: () => BrowserWindow | undefined) {
  let pending = 0;
  let timer: NodeJS.Timeout | undefined;
  contents.on("input-event", (_event, input) => {
    if (input.type === "mouseDown") send(windowOf(), contents, { reason: "press" });
    else if (input.type === "mouseWheel" || input.type === "gestureScrollUpdate") {
      // These events carry no deltas here: each counts as a step of WHEEL_STEP px, so a
      // mouse notch (two wheel events and an update) or a few trackpad frames close an
      // overlay elsewhere, and a single stray event doesn't. Batched, as a trackpad sends
      // a stream of them.
      const wheel = input as { deltaX?: number; deltaY?: number };
      pending += Math.abs(wheel.deltaY ?? 0) + Math.abs(wheel.deltaX ?? 0) || WHEEL_STEP;
      timer ??= setTimeout(() => {
        const dy = pending;
        pending = 0;
        timer = undefined;
        if (!contents.isDestroyed()) send(windowOf(), contents, { reason: "scroll", dy });
      }, 60);
    }
  });
}

/** Dismisses everything in the window when the app goes to the background, as macOS menus
 *  do. (Not on window blur: an open panel or sheet over the window takes focus too, and a
 *  menu that started it, like the workspace switcher's "Add workspace…", must survive it.)
 *  Smoke runs (KEY_SKIP_ONBOARDING) keep them unless KEY_DISMISS_ON_BLUR=1: other test
 *  apps take the foreground mid-step. */
export function dismissOnBlur(window: BrowserWindow) {
  if (process.env.KEY_SKIP_ONBOARDING === "1" && process.env.KEY_DISMISS_ON_BLUR !== "1") return;
  const resign = () => send(window, undefined, { reason: "blur" });
  app.on("did-resign-active", resign);
  window.once("closed", () => app.off("did-resign-active", resign));
}

/** A press on the window's own frame (its title bar and drag regions) reaches no DOM: moving
 *  the window counts as a press outside. */
export function dismissOnMove(window: BrowserWindow) {
  window.on("will-move", () => send(window, undefined, { reason: "press" }));
}
