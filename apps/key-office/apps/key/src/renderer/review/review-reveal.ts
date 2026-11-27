// A review opened at a record and passage (a review mark kept as a highlight on a library copy,
// clicked in the library's reader or on the source's page): main sends "review-reveal"; the
// review page goes to the record's stage, screening shows the record, its reader the passage.
export type Reveal = { reviewId: string; recordId: string; stage?: string; page?: number; quote?: string; markId?: string };

let pending: Reveal | undefined;
const listeners = new Set<() => void>();

export function setReveal(r: Reveal) {
  pending = r;
  for (const l of listeners) l();
}

/** The record to show for this review (taken once); the passage stays for the reader. */
export function takeReveal(reviewId: string): Reveal | undefined {
  if (pending?.reviewId !== reviewId || !pending.recordId) return undefined;
  const r = pending;
  pending = { ...r, recordId: "" };
  passage = r;
  return r;
}

let passage: Reveal | undefined;
/** The passage to bring into view once the record's full text is open (taken once). */
export function takePassage(recordId: string): Reveal | undefined {
  if (passage?.recordId !== recordId) return undefined;
  const p = passage;
  passage = undefined;
  return p;
}

export function onReveal(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
