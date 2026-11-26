/** The window's status bar: a slim strip along the bottom of every shell window.
 *
 * Left: the shell's own items (Zotero sync, background work, workspace). Right: items the
 * focused view contributes. A view replaces its whole list each time it sets it; an empty
 * list clears it. Items go away with the view.
 *
 * Native views (PDF reader, office editors, browser pages) use the preload bridge:
 *
 *   window.key.setStatusItems([{ id: "refs", label: "12 references", icon: "quote", title: "Show references" }]);
 *   const off = window.key.onStatusItem((id) => { if (id === "refs") openReferences(); });
 *
 * Shell (DOM) views call `useStatusItems(viewId, items, onInvoke)` from
 * renderer/status-bar.tsx. `icon` is an `IconName` from renderer/icons.tsx (unknown names
 * show no icon); `active` draws the item selected (a toggle that is on); `title` is the
 * tooltip. Items without an `onStatusItem` listener are shown as plain text. */
export interface StatusItem {
  id: string;
  label: string;
  icon?: string;
  active?: boolean;
  title?: string;
}

/** The bar's height; native views end this far above the window's bottom. */
export const STATUS_BAR_HEIGHT = 24;
/** No view gets more of the bar than this. */
export const MAX_STATUS_ITEMS = 8;

export function sanitizeStatusItems(value: unknown): StatusItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: StatusItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.slice(0, 80) : "";
    const label = typeof item.label === "string" ? item.label.slice(0, 80) : "";
    if (!id || seen.has(id) || (!label && typeof item.icon !== "string")) continue;
    seen.add(id);
    out.push({
      id,
      label,
      ...(typeof item.icon === "string" ? { icon: item.icon.slice(0, 40) } : {}),
      ...(item.active === true ? { active: true } : {}),
      ...(typeof item.title === "string" ? { title: item.title.slice(0, 200) } : {}),
    });
    if (out.length >= MAX_STATUS_ITEMS) break;
  }
  return out;
}
