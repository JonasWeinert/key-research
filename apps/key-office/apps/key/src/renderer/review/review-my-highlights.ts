// The user's own highlights on a record's full text as the review's reader has them (the
// library's on a library copy, the review's own on a file kept with the review): the Marks
// list's "My highlights". Kept apart from the reader so the list does not load it.
import { useSyncExternalStore } from "react";

export type MyHighlight = { id: string; text: string; comment?: string; page: number; color?: string };
const mine = new Map<string, MyHighlight[]>();
const listeners = new Set<() => void>();
const EMPTY: MyHighlight[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setMyHighlights(recordId: string, annotations: any[]) {
  mine.set(
    recordId,
    annotations
      .filter((a) => !String(a?.id ?? "").startsWith("review-mark:") && (a?.text || a?.comment))
      .map((a) => ({ id: String(a.id), text: String(a.text ?? ""), comment: a.comment || undefined, page: Number(a.range?.start?.page ?? -1), color: a.color })),
  );
  for (const l of listeners) l();
}

export function useMyHighlights(recordId: string | undefined): MyHighlight[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => (recordId ? (mine.get(recordId) ?? EMPTY) : EMPTY),
  );
}
