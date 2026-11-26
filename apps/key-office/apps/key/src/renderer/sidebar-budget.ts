// How much of the sidebar the Library's collections take by default: at most half its height,
// so the workspace's own items stay in view. The list shows the rows that fit and a
// "Show more" row.

/** A tree row (28px) and the 1px between rows. */
export const ROW_PX = 29;

/** How many of `count` rows to show in `budget` px (undefined: all of them). Leaves room
 *  for the "Show more" row and always shows a few. */
export function rowsThatFit(budget: number | undefined, count: number, rowPx: number, reserved = 0): number | undefined {
  if (budget === undefined) return undefined;
  const fit = Math.floor((budget - reserved) / rowPx);
  if (count <= fit) return undefined;
  return Math.max(2, fit - 1);
}
