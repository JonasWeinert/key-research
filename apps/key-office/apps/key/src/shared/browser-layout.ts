import type { Rect } from "./tab-model";

/** The slim bar above a browser tab's page: back, forward, the site. */
export const WEB_BAR_HEIGHT = 30;
/** Where a browser tab's page sits in its group's body: below the bar. */
export function webPageRect<R extends Rect>(body: R): R {
  const bar = Math.min(WEB_BAR_HEIGHT, body.height);
  return { ...body, y: body.y + bar, height: body.height - bar };
}
