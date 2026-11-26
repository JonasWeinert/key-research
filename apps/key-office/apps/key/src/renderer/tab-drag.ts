// Dragging a tab out of its group's strip, as plain data: no DOM, no React. The strip feeds it
// the geometry it measured and the pointer; it answers where the tab would land.
import type { GroupSide, Rect } from "../shared/tab-model";

/** Where a dragged tab lands: in a group's strip at `index`, or in a new group on `side` of a group. */
export type TabDrop =
  | { kind: "move"; tabId: string; groupId: string; index: number }
  | { kind: "split"; tabId: string; groupId: string; side: GroupSide };

/** A drop outside the dragged tab's own strip, with what to draw while it is offered. */
export interface DropTarget {
  /** Nothing to drop here (a group's own content away from its sides). */
  drop?: TabDrop;
  label: string;
  /** Over a group's content: the rectangle the tab will take (native views show still frames). */
  preview?: Rect;
  content?: boolean;
  /** Over another strip: where the tab will be inserted. */
  marker?: { x: number };
}

/** The strip as measured when the drag began: one span per tab, left to right. */
export interface StripGeometry {
  left: number;
  right: number;
  bottom: number;
  spans: { left: number; width: number }[];
  /** How many leading tabs are pinned. */
  pinned: number;
}

/** A press becomes a drag once the pointer travels this far. */
export const DRAG_THRESHOLD = 5;
/** Slack around the strip inside which the tab still reorders. */
const STRIP_SLACK = 8;

export type DragPhase =
  /** Pressed, not yet moved far enough to count as a drag. */
  | { mode: "pressed" }
  /** Sliding along its own strip; `slot` is where it would settle. */
  | { mode: "reorder"; slot: number; offset: number }
  /** Over another strip or a group's content. */
  | { mode: "away"; target?: DropTarget }
  /** Out of the window: it would open in a new one. */
  | { mode: "tear-off" };

export interface TabDrag {
  pointerId: number;
  tabId: string;
  groupId: string;
  /** The tab's index when pressed. */
  origin: number;
  start: { x: number; y: number };
  geometry: StripGeometry;
  /** The tab the group showed before the press, shown again while the drag is over content. */
  shownBefore?: string;
  phase: DragPhase;
}

export interface DragEnvironment {
  viewport: { width: number; height: number };
  /** The dragged tab is the window's only one: it has nowhere to go but its strip. */
  lone: boolean;
  canTearOff: boolean;
  locate?: (x: number, y: number) => DropTarget | undefined;
}

export function pressTab(init: Omit<TabDrag, "phase">): TabDrag {
  return { ...init, phase: { mode: "pressed" } };
}

/** The gap between neighbouring tabs, read off the measured spans. */
function gapOf(spans: StripGeometry["spans"]): number {
  if (spans.length < 2) return 0;
  return Math.max(0, spans[1].left - (spans[0].left + spans[0].width));
}

/** The slot a tab dragged by `offset` would settle in: its leading edge (the side it moves
 * towards) passes a neighbour once it crosses that neighbour's middle. Kept inside its pinned
 * or unpinned run. */
export function slotFor(geometry: StripGeometry, origin: number, offset: number): number {
  const { spans, pinned } = geometry;
  const self = spans[origin];
  if (!self) return origin;
  const middleOf = (span: { left: number; width: number }) => span.left + span.width / 2;
  let slot = origin;
  if (offset > 0) {
    const edge = self.left + self.width + offset;
    for (let i = origin + 1; i < spans.length && middleOf(spans[i]) <= edge; i++) slot = i;
  } else if (offset < 0) {
    const edge = self.left + offset;
    for (let i = origin - 1; i >= 0 && middleOf(spans[i]) >= edge; i--) slot = i;
  }
  const [low, high] = origin < pinned ? [0, pinned - 1] : [pinned, spans.length - 1];
  return Math.min(Math.max(slot, low), Math.max(low, high));
}

/** How far a dragged tab may travel without leaving its strip's run of tabs. */
function clampOffset(geometry: StripGeometry, origin: number, offset: number): number {
  const { spans } = geometry;
  const self = spans[origin];
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (!self || !first || !last) return 0;
  const min = first.left - self.left;
  const max = last.left + last.width - (self.left + self.width);
  return Math.min(Math.max(offset, min), Math.max(min, max));
}

/** The next phase for a pointer at (x, y). */
export function follow(drag: TabDrag, x: number, y: number, env: DragEnvironment): DragPhase {
  const dx = x - drag.start.x;
  if (drag.phase.mode === "pressed" && Math.hypot(dx, y - drag.start.y) < DRAG_THRESHOLD) return drag.phase;
  const { width, height } = env.viewport;
  if (x < 0 || y < 0 || x > width || y > height) {
    return env.canTearOff && !env.lone ? { mode: "tear-off" } : { mode: "away" };
  }
  const g = drag.geometry;
  const onStrip = y <= g.bottom + STRIP_SLACK && x >= g.left - STRIP_SLACK && x <= g.right + STRIP_SLACK;
  if (onStrip) {
    const offset = clampOffset(g, drag.origin, dx);
    return { mode: "reorder", offset, slot: slotFor(g, drag.origin, offset) };
  }
  return { mode: "away", target: env.locate?.(x, y) };
}

/** The horizontal shift a resting tab takes so the dragged tab's slot opens up. */
export function shiftFor(drag: TabDrag, index: number): number {
  const { phase, origin, geometry } = drag;
  if (phase.mode !== "reorder" || index === origin) return 0;
  const step = (geometry.spans[origin]?.width ?? 0) + gapOf(geometry.spans);
  if (origin < index && index <= phase.slot) return -step;
  if (phase.slot <= index && index < origin) return step;
  return 0;
}

/** What releasing now would do. */
export type DragOutcome =
  | { kind: "click" }
  | { kind: "cancel" }
  | { kind: "reorder"; index: number }
  | { kind: "drop"; drop: TabDrop }
  | { kind: "tear-off" };

export function release(drag: TabDrag): DragOutcome {
  const { phase } = drag;
  switch (phase.mode) {
    case "pressed":
      return { kind: "click" };
    case "reorder":
      return phase.slot === drag.origin ? { kind: "cancel" } : { kind: "reorder", index: phase.slot };
    case "tear-off":
      return { kind: "tear-off" };
    case "away":
      return phase.target?.drop ? { kind: "drop", drop: phase.target.drop } : { kind: "cancel" };
  }
}

export const isOverContent = (phase: DragPhase) => phase.mode === "away" && Boolean(phase.target?.content);

/** The hint shown beside the pointer. */
export function dragHint(drag: TabDrag): string {
  const { phase } = drag;
  switch (phase.mode) {
    case "pressed":
      return "";
    case "tear-off":
      return "Release to open in a new window";
    case "away":
      return phase.target?.label ?? "Drop on a tab bar, or at the side of a group to split";
    case "reorder":
      return phase.slot === drag.origin ? "Drag to reorder, or to another group" : "Release to reorder";
  }
}

/** `list` with the tab `id` moved to `index`. */
export function moveTo<T extends { id: string }>(list: T[], id: string, index: number): T[] {
  const from = list.findIndex((item) => item.id === id);
  if (from < 0) return list;
  const rest = list.filter((_, i) => i !== from);
  rest.splice(Math.min(Math.max(index, 0), rest.length), 0, list[from]);
  return rest;
}
