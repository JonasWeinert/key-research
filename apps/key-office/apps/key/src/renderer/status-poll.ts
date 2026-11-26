// One `store_status` poller per workspace, shared by every view that shows library or
// search-model status (Home, Sources, the status bar, the sidebar pill, Settings), instead
// of one timer each. It polls quickly only while something is moving, and not at all while
// the window is hidden (minimised or fully covered); it answers at once when shown again.
type Invoke = <T>(command: string, args?: Record<string, unknown>, workspaceId?: string) => Promise<T>;
export interface PolledStatus {
  busy?: boolean;
  counts?: { indexing?: number };
  references?: unknown;
  model?: { state?: string };
}
type Listener = (status: PolledStatus) => void;
interface Poller {
  listeners: Set<Listener>;
  invoke: Invoke;
  last?: PolledStatus;
  lastAt?: number;
  lastText?: string;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: boolean;
}
const pollers = new Map<string, Poller>();

/** Quick while indexing or downloading, gentle otherwise. */
export function nextDelay(status: PolledStatus | undefined) {
  if (!status) return 4000;
  if (status.model?.state === "downloading") return 700;
  if (status.busy || (status.counts?.indexing ?? 0) > 0 || status.references) return 900;
  if (status.model && status.model.state !== "ready") return 3000;
  return 4000;
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function schedule(id: string, poller: Poller, delay: number) {
  clearTimeout(poller.timer);
  if (hidden()) return;
  poller.timer = setTimeout(() => void poll(id, poller), delay);
}
async function poll(id: string, poller: Poller) {
  if (poller.inFlight || !poller.listeners.size) return;
  poller.inFlight = true;
  let next: PolledStatus | undefined;
  try {
    next = await poller.invoke<PolledStatus>("store_status", {}, id);
  } catch {}
  poller.inFlight = false;
  if (pollers.get(id) !== poller) return;
  if (next) {
    // Views re-render only when something changed (the shell would otherwise redraw every few seconds).
    const text = JSON.stringify(next);
    poller.lastAt = Date.now();
    if (text !== poller.lastText) {
      poller.last = next;
      poller.lastText = text;
      for (const listener of poller.listeners) listener(next);
    }
  }
  schedule(id, poller, nextDelay(next ?? poller.last));
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    for (const [id, poller] of pollers) {
      if (hidden()) clearTimeout(poller.timer);
      else void poll(id, poller);
    }
  });

/** Calls `listener` with each new status of `workspaceId` (and the latest one right away). */
export function subscribeStatus(invoke: Invoke, workspaceId: string, listener: Listener) {
  let poller = pollers.get(workspaceId);
  const fresh = !poller;
  if (!poller) pollers.set(workspaceId, (poller = { listeners: new Set(), invoke }));
  poller.listeners.add(listener);
  if (poller.last) listener(poller.last);
  // A view that appears gets a current answer, not one from up to four seconds ago.
  if (fresh || Date.now() - (poller.lastAt ?? 0) > 1000) void poll(workspaceId, poller);
  return () => {
    poller.listeners.delete(listener);
    if (!poller.listeners.size) {
      clearTimeout(poller.timer);
      pollers.delete(workspaceId);
    }
  };
}

/** Asks again now (after an import, a pause or anything that changes the status). */
export function refreshStatus(workspaceId: string) {
  const poller = pollers.get(workspaceId);
  if (poller) void poll(workspaceId, poller);
}
