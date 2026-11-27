// Ctrl-Tab across every webContents of a window. Key events are read in main
// (`before-input-event`), so the switcher works wherever focus is: the shell's DOM panes (notes,
// library), a PDF reader or a web page. The shell's renderer draws the overlay (TabSwitcher.tsx)
// from the "tab-switcher" events sent here; the state machine is shared/tab-switcher.ts.
//
// Keys are never cancelled here: a keyDown cancelled in `before-input-event` makes Chromium drop
// the key-ups that follow until the next keyDown, and the switcher must see Ctrl go up. Instead,
// as Ctrl-Tab goes down keyboard focus moves to the shell, whose renderer swallows the keys while
// a session runs (Blink ignores Tab with Ctrl held, so the page it came from does nothing with it).
import type { Input, WebContents } from "electron";
import { isSwitcherStart, startSwitcher, switcherKey, withoutTab, SWITCHER_SHOW_DELAY, type SwitcherSession } from "../shared/tab-switcher";

export type SwitcherEvent =
  | { phase: "start" }
  | { phase: "show" | "update"; order: string[]; selected: number; sticky: boolean; frames?: unknown[] }
  | { phase: "end" };

export interface SwitcherHost<W> {
  /** The window's tab ids, most recently used first. */
  order(w: W): string[];
  activate(w: W, tabId: string): void;
  close(w: W, tabId: string): Promise<unknown>;
  /** Gives keyboard focus back to what the window shows. */
  restoreFocus(w: W): void;
  /** Keys go to the shell during a session. */
  focusShell(w: W): void;
  send(w: W, event: SwitcherEvent): void;
  /** Still pictures of the native views shown now (captured as Ctrl-Tab goes down, so the
   * overlay shows at once), and hiding the views while it shows. */
  capture(w: W): Promise<unknown[]>;
  cover(w: W, covered: boolean): void;
}

interface Running {
  session: SwitcherSession;
  shown: boolean;
  /** Focus came from a native view and went to the shell for the session. */
  movedFocus: boolean;
  timer?: ReturnType<typeof setTimeout>;
  frames: Promise<unknown[]>;
}

export class TabSwitcher<W extends object> {
  private running = new Map<W, Running>();
  constructor(private host: SwitcherHost<W>) {}

  /** Watches a webContents' keys for the window it is shown in now (`shell`: the window's own page). */
  attach(contents: WebContents, windowOf: () => W | undefined, shell = false) {
    contents.on("before-input-event", (_event, input) => {
      const w = windowOf();
      if (w) this.input(w, input, shell);
    });
  }

  isOpen(w: W) {
    return this.running.has(w);
  }

  /** One key event, from the shell's page (`fromShell`) or a native view. */
  input(w: W, input: Input, fromShell = true) {
    const run = this.running.get(w);
    if (!run) {
      if (!isSwitcherStart(input)) return;
      const session = startSwitcher(this.host.order(w), { reverse: input.shift });
      if (!session) return;
      const next: Running = { session, shown: false, movedFocus: !fromShell, frames: this.host.capture(w).catch(() => []) };
      next.timer = setTimeout(() => void this.show(w), SWITCHER_SHOW_DELAY);
      this.running.set(w, next);
      this.host.send(w, { phase: "start" });
      if (!fromShell) this.host.focusShell(w);
      return;
    }
    const { session, effect } = switcherKey(run.session, input);
    run.session = session;
    switch (effect.kind) {
      case "move":
        return this.update(w, run);
      case "commit":
        this.end(w);
        return this.host.activate(w, effect.tabId);
      case "cancel":
      case "pass":
        return this.cancel(w);
      case "close":
        return void this.closeTab(w, effect.tabId);
    }
  }

  /** "Show all tabs" from the command palette: shows at once and waits for a pick. */
  open(w: W) {
    this.end(w);
    const session = startSwitcher(this.host.order(w), { sticky: true });
    if (!session) return;
    const run: Running = { session, shown: false, movedFocus: false, frames: this.host.capture(w).catch(() => []) };
    this.running.set(w, run);
    this.host.send(w, { phase: "start" });
    void this.show(w);
  }

  /** A row clicked. */
  pick(w: W, tabId: string) {
    if (!this.running.has(w)) return;
    this.end(w);
    this.host.activate(w, tabId);
  }

  select(w: W, index: number) {
    const run = this.running.get(w);
    if (!run || !Number.isInteger(index) || index < 0 || index >= run.session.order.length) return;
    run.session = { ...run.session, selected: index };
    this.update(w, run);
  }

  async closeTab(w: W, tabId: string) {
    await this.host.close(w, tabId);
    const run = this.running.get(w);
    if (!run) return;
    // The tab may have stayed open (unsaved changes kept); only drop it once it is gone.
    if (this.host.order(w).includes(tabId)) return;
    const session = withoutTab(run.session, tabId);
    if (!session) return this.cancel(w);
    run.session = session;
    this.update(w, run);
  }

  cancel(w: W) {
    const run = this.running.get(w);
    this.end(w);
    if (run?.shown || run?.movedFocus) this.host.restoreFocus(w);
  }

  /** Ends the session (without switching). */
  end(w: W) {
    const run = this.running.get(w);
    if (!run) return;
    clearTimeout(run.timer);
    this.running.delete(w);
    if (run.shown) this.host.cover(w, false);
    this.host.send(w, { phase: "end" });
  }

  private async show(w: W) {
    const run = this.running.get(w);
    if (!run || run.shown) return;
    const frames = await run.frames;
    if (this.running.get(w) !== run || run.shown) return;
    run.shown = true;
    this.host.send(w, { phase: "show", order: run.session.order, selected: run.session.selected, sticky: run.session.sticky, frames });
    this.host.cover(w, true);
    this.host.focusShell(w);
  }

  private update(w: W, run: Running) {
    if (run.shown) this.host.send(w, { phase: "update", order: run.session.order, selected: run.session.selected, sticky: run.session.sticky });
  }
}
