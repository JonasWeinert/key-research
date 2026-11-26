// The status bar's fill item: a run in progress (with its progress ring), paused, or done
// with proposals waiting for review. The main process pushes `fill-progress`; a click opens
// the review (FillSheet with the run).
import { useEffect, useState } from "react";
import type { Invoke } from "./library-api";
import type { StatusItem } from "../shared/status-items";
import type { RunSummary } from "./FillSheet";

interface Bridge {
  on(event: string, callback: (value: unknown) => void): () => void;
}
const bridge = () => (window as unknown as { key?: Bridge }).key;

export function useFillStatus(invoke: Invoke, workspaceId?: string): { item?: StatusItem; runId?: string } {
  const [runs, setRuns] = useState<Record<string, RunSummary>>({});
  useEffect(() => {
    setRuns({});
    if (!workspaceId) return;
    void invoke<RunSummary[]>("fill_active", {}, workspaceId)
      .then((list) => setRuns(Object.fromEntries((list ?? []).map((r) => [r.id, r]))))
      .catch(() => {});
    return bridge()?.on("fill-progress", (value) => {
      const v = value as { workspaceId?: string; run?: RunSummary };
      if (v?.workspaceId !== workspaceId || !v.run?.id || v.run.sample) return;
      setRuns((all) => ({ ...all, [v.run!.id]: v.run! }));
    });
  }, [invoke, workspaceId]);
  const list = Object.values(runs);
  const running = list.find((r) => r.status === "running") ?? list.find((r) => r.status === "paused");
  const waiting = list.filter((r) => (r.counts?.proposed ?? 0) > 0);
  const run = running ?? waiting[0];
  if (!run) return {};
  const property = run.recipe?.property ?? "property";
  const proposed = waiting.reduce((n, r) => n + (r.counts?.proposed ?? 0), 0);
  if (running)
    return {
      runId: running.id,
      item: {
        id: "fill",
        label: running.status === "paused" ? `${property}: paused` : `Filling ${property} ${running.done}/${running.total}`,
        progress: running.total ? running.done / running.total : undefined,
        title: running.status === "paused" ? "Fill paused. Click to resume or review." : "Fill in progress. Click to review proposals, pause or cancel.",
        priority: 60,
        tone: running.status === "paused" ? "warning" : undefined,
      },
    };
  return {
    runId: run.id,
    item: { id: "fill", label: `${proposed} ${proposed === 1 ? "proposal" : "proposals"} to review`, icon: "sparkle", title: `Fill “${property}” finished. Click to review.`, priority: 60 },
  };
}
