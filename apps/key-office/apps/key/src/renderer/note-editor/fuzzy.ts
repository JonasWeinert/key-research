/** Subsequence match; higher is better, -1 when the query does not match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  const word = t.indexOf(` ${q}`);
  if (word >= 0) return 800 - word;
  const sub = t.indexOf(q);
  if (sub >= 0) return 600 - sub;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, last + 1);
    if (at < 0) return -1;
    score += at === last + 1 ? 6 : 1;
    last = at;
  }
  return score;
}
