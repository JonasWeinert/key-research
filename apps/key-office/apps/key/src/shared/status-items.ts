/** The window's status bar: a slim strip along the bottom of every shell window.
 *
 * Left: the shell's own items (Zotero sync, background work, workspace). Right: items the
 * focused view contributes. A view replaces its whole list each time it sets it; an empty
 * list clears it. Items go away with the view.
 *
 * Native views (PDF reader, browser pages) use the preload bridge:
 *
 *   window.key.setStatusItems([{ id: "refs", label: "12 references", icon: "quote", title: "Show references" }]);
 *   const off = window.key.onStatusItem((id) => { if (id === "refs") openReferences(); });
 *
 * Shell (DOM) views call `useStatusItems(viewId, items, onInvoke)` from
 * renderer/status-bar.tsx. `icon` is an `IconName` from renderer/icons.tsx (unknown names
 * show no icon); `active` draws the item selected (a toggle that is on); `title` is the
 * tooltip; `text` makes it plain information ("2 items"), not a button; `progress` (0–1)
 * or `busy` draws a progress ring in place of the icon; `priority` (0–100, default 50)
 * decides what goes first when the bar is short of room;
 * `tone` draws a small status light in place of the icon ("ready" green, "idle" grey,
 * "warning" amber and "error" red, both tinting the label too) or, as "off", mutes the item: the lowest-priority items, the
 * shell's own included, are hidden until everything left fits on one line. A DOM view can
 * also hang a popover above an item (useStatusItems' `popover`); native views get clicks. */
export interface StatusItem {
  id: string;
  label: string;
  icon?: string;
  active?: boolean;
  title?: string;
  text?: boolean;
  progress?: number;
  busy?: boolean;
  priority?: number;
  tone?: StatusTone;
}
export type StatusTone = "ready" | "idle" | "warning" | "error" | "off";
const TONES: StatusTone[] = ["ready", "idle", "warning", "error", "off"];

/** The bar's height; native views end this far above the window's bottom. */
export const STATUS_BAR_HEIGHT = 24;
/** No view gets more of the bar than this. */
export const MAX_STATUS_ITEMS = 8;
export const DEFAULT_STATUS_PRIORITY = 50;

/** The ids to hide so the rest fits in `room` px: lowest priority first, later items first
 * among equals. `gap` is the space between two shown items. */
export function overflowingStatusItems(items: { id: string; width: number; priority?: number }[], room: number, gap = 0): Set<string> {
  const ranked = items.map((item, index) => ({ ...item, index })).sort((a, b) => (b.priority ?? DEFAULT_STATUS_PRIORITY) - (a.priority ?? DEFAULT_STATUS_PRIORITY) || a.index - b.index);
  const hidden = new Set<string>();
  let used = 0;
  for (const item of ranked) {
    const next = used + (used ? gap : 0) + item.width;
    if (hidden.size || next > room) hidden.add(item.id);
    else used = next;
  }
  return hidden;
}

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
      ...(item.text === true ? { text: true } : {}),
      ...(typeof item.progress === "number" && Number.isFinite(item.progress) ? { progress: Math.min(1, Math.max(0, item.progress)) } : {}),
      ...(item.busy === true ? { busy: true } : {}),
      ...(TONES.includes(item.tone as StatusTone) ? { tone: item.tone as StatusTone } : {}),
      ...(typeof item.priority === "number" && Number.isFinite(item.priority) ? { priority: Math.min(100, Math.max(0, Math.round(item.priority))) } : {}),
    });
    if (out.length >= MAX_STATUS_ITEMS) break;
  }
  return out;
}
