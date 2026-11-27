import type { Rect } from "./tab-model";

/** The slim bar above a browser tab's page: back, forward, the site. */
export const WEB_BAR_HEIGHT = 30;
/** The banner below the bar while a tab is Find PDF's publisher page (FindPdfBanner). */
export const FIND_PDF_BANNER_HEIGHT = 60;
/** Where a browser tab's page sits in its group's body: below the bar (and a banner). */
export function webPageRect<R extends Rect>(body: R, banner = 0): R {
  const bar = Math.min(WEB_BAR_HEIGHT + banner, body.height);
  return { ...body, y: body.y + bar, height: body.height - bar };
}
