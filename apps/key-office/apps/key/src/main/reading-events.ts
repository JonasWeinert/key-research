// What a library PDF's reader shows is passed on to the host, which keeps the reading status
// and history (key-store reading.rs): the first state of a reader opens the source, later
// ones report the page when it changes. The host decides what that means for the status.
type Invoke = <T>(command: string, args: Record<string, unknown>, workspaceId: string) => Promise<T>;

interface Seen {
  page: number;
  status?: string;
}
const seen = new Map<string, Seen>();

/** Reports a reader's view state; `changed` runs when the source's status moved. */
export function reportReading(invoke: Invoke, view: { id: string; workspaceId?: string; temp?: unknown; source?: { hash?: string } }, state: unknown, changed: () => void) {
  const hash = view.source?.hash ?? view.id.split(":").at(-1);
  const page = Number((state as { pageIndex?: unknown } | null)?.pageIndex);
  if (!view.workspaceId || view.temp || !hash || !view.id.startsWith("pdf:") || !Number.isFinite(page)) return;
  const before = seen.get(view.id);
  if (before && before.page === page) return;
  seen.set(view.id, { page, status: before?.status });
  const count = Number((state as { pageCount?: unknown } | null)?.pageCount);
  void invoke<{ status: string }>("store_reading_event", { id: hash, kind: before ? "page" : "open", page, pageCount: count > 0 ? count : null }, view.workspaceId)
    .then((reading) => {
      const now = seen.get(view.id);
      if (now && reading?.status && now.status !== reading.status) {
        now.status = reading.status;
        changed();
      }
    })
    .catch(() => {});
}

/** A reader closed: its next opening counts as opening again. */
export function forgetReading(viewId: string) {
  seen.delete(viewId);
}
