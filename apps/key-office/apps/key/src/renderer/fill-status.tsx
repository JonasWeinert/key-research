// The status bar's fill item: a run in progress (with its progress ring), paused, or done
// with proposals waiting for review; automatic fills of out-of-date values say so, and a
// recipe at its daily limit shows a quiet note. The main process pushes `fill-progress`; a
// click opens the review (FillSheet with the run).
import { useEffect, useState } from "react";
import type { Invoke } from "./library-api";
import type { StatusItem } from "../shared/status-items";
import type { RunSummary } from "./FillSheet";

interface Bridge {
  on(event: string, callback: (value: unknown) => void): () => void;
}
const bridge = () => (window as unknown as { key?: Bridge }).key;
interface Capped {
  recipeId: string;
  property: string;
  waiting: number;
}

export function useFillStatus(invoke: Invoke, workspaceId?: string): { item?: StatusItem; runId?: string } {
  const [runs, setRuns] = useState<Record<string, RunSummary & { again?: boolean; auto?: boolean }>>({});
  const [capped, setCapped] = useState<Capped[]>([]);
  useEffect(() => {
    setRuns({});
    setCapped([]);
    if (!workspaceId) return;
    void invoke<RunSummary[]>("fill_active", {}, workspaceId)
      .then((list) => setRuns(Object.fromEntries((list ?? []).map((r) => [r.id, r]))))
      .catch(() => {});
    const offProgress = bridge()?.on("fill-progress", (value) => {
      const v = value as { workspaceId?: string; run?: RunSummary; auto?: { capped?: Capped[] } };
      if (v?.workspaceId !== workspaceId) return;
      if (v.auto) return setCapped(v.auto.capped ?? []);
      if (!v.run?.id || v.run.sample) return;
      setRuns((all) => ({ ...all, [v.run!.id]: v.run! }));
    });
    // Proposals reviewed elsewhere (the sheet, a cell's popover): the counts follow.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const offChanged = bridge()?.on("library-changed", () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        setRuns((all) => {
          for (const id of Object.keys(all))
            void invoke<{ run: RunSummary }>("store_fill_run", { runId: id, limit: 1 }, workspaceId)
              .then((r) => setRuns((now) => (now[id] ? { ...now, [id]: { ...now[id], ...r.run } } : now)))
              .catch(() => setRuns(({ [id]: _gone, ...rest }) => rest));
          return all;
        });
      }, 300);
    });
    return () => {
      offProgress?.();
      offChanged?.();
      clearTimeout(pending);
    };
  }, [invoke, workspaceId]);
  const list = Object.values(runs);
  const running = list.find((r) => r.status === "running") ?? list.find((r) => r.status === "paused");
  const waiting = list.filter((r) => (r.counts?.proposed ?? 0) > 0);
  const run = running ?? waiting[0];
  if (!run) {
    const limit = capped.find((c) => c.waiting > 0);
    if (!limit) return {};
    return {
      item: {
        id: "fill",
        label: `${limit.property}: daily limit reached`,
        icon: "clock",
        title: `${limit.waiting} out-of-date ${limit.waiting === 1 ? "value waits" : "values wait"} until automatic fills of “${limit.property}” have room again. Raise the limit in the recipe (Fill with AI › Run).`,
        priority: 30,
        tone: "warning",
      },
    };
  }
  const property = run.recipe?.property ?? "property";
  const proposed = waiting.reduce((n, r) => n + (r.counts?.proposed ?? 0), 0);
  if (running)
    return {
      runId: running.id,
      item: {
        id: "fill",
        label: running.status === "paused" ? `${property}: paused` : `${running.again ? "Filling again" : "Filling"} ${property} ${running.done}/${running.total}`,
        progress: running.total ? running.done / running.total : undefined,
        title:
          running.status === "paused"
            ? "Fill paused. Click to resume or review."
            : running.again && running.auto
              ? "Filling out-of-date values again in the background. Values you edited are left alone. Click to see the run or undo it."
              : "Fill in progress. Click to review proposals, pause or cancel.",
        priority: 60,
        tone: running.status === "paused" ? "warning" : undefined,
      },
    };
  return {
    runId: run.id,
    item: { id: "fill", label: `${proposed} ${proposed === 1 ? "proposal" : "proposals"} to review`, icon: "sparkle", title: `Fill “${property}” finished. Click to review.`, priority: 60 },
  };
}
