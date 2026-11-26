// Adding a work to the library from another source's context: its references or related
// works, a citation card in its PDF, a web result opened from it. A small chooser asks which
// collections (the origin source's by default, several allowed) unless "Don't ask again" was
// chosen; Settings › Libraries turns asking back on or picks the silent default.
//
// One entry point for every caller:
//   - in the shell renderer: `addFromSource(invoke, { workspaceId, sourceId }, work, anchor?)`
//   - in a native view (the PDF reader, a web page): `window.key.addFromSource({ origin, work })`
//     (preload → main `key:add-from-source` → the window's shell, which shows the chooser and
//     answers with the added source, or null when cancelled). `addFromSource` here does that
//     itself when no chooser host is mounted, so view code may import and call it too.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { bridge, type AppSettings, type Collection, type Invoke, type Source } from "./library-api";
import { libraryChanged } from "./library-nav";
import "./add-from-source.css";

/** What is added: whatever the context knows of the work. */
export interface AddWork {
  openalexId?: string | null;
  doi?: string | null;
  title?: string | null;
  year?: number | null;
  url?: string | null;
  byline?: string | null;
  container?: string | null;
}
/** Where it is added from: the source whose references, card or result it came from. */
export interface AddOrigin {
  workspaceId: string;
  sourceId?: string | null;
}
export type AddMode = AppSettings["addFromSource"];
export const ADD_MODES: [AddMode, string][] = [
  ["ask", "Ask which collections"],
  ["origin", "Same collections as the source"],
  ["library", "Library only, no collection"],
];

interface Choice {
  collections: string[];
  dontAsk: boolean;
}
interface Request {
  work: AddWork;
  collections: Collection[];
  selected: string[];
  originTitle?: string;
  anchor?: DOMRect;
  /** Asked from a native view: its picture stands in while the chooser is open. */
  remote: boolean;
  resolve: (choice: Choice | null) => void;
}
let host: ((request: Request) => void) | undefined;

type ViewBridge = { addFromSource?: (request: { origin: AddOrigin; work: AddWork }) => Promise<Source | null> };

/** Adds `work` to the origin's library, asking where when the setting says so. */
export async function addFromSource(invoke: Invoke, origin: AddOrigin, work: AddWork, anchor?: Element | null, remote = false): Promise<Source | null> {
  if (!host) {
    const viaMain = (window as unknown as { key?: ViewBridge }).key?.addFromSource;
    if (viaMain) return viaMain({ origin, work });
  }
  const { workspaceId } = origin;
  const [settings, collections, from] = await Promise.all([
    bridge()
      .appSettings()
      .then((r) => r.settings)
      .catch(() => undefined),
    invoke<Collection[]>("store_collections", {}, workspaceId).catch(() => [] as Collection[]),
    origin.sourceId ? invoke<Source | null>("store_source", { id: origin.sourceId }, workspaceId).catch(() => null) : Promise.resolve(null),
  ]);
  const defaults = (from?.collections ?? []).filter((id) => collections.some((c) => c.id === id));
  const mode: AddMode = settings?.addFromSource ?? "ask";
  let chosen = mode === "library" ? [] : defaults;
  if (mode === "ask" && host) {
    const ask = host;
    const choice = await new Promise<Choice | null>((resolve) =>
      ask({ work, collections, selected: defaults, originTitle: from?.title, anchor: anchor?.getBoundingClientRect(), remote, resolve }),
    );
    if (!choice) return null;
    chosen = choice.collections;
    if (choice.dontAsk) void bridge().setAppSettings({ addFromSource: "origin" });
  }
  const source = await insertWork(invoke, workspaceId, work, chosen);
  libraryChanged();
  const names = chosen.map((id) => collections.find((c) => c.id === id)?.name).filter(Boolean);
  toast(names.length ? `Added to ${names.length === 1 ? names[0] : `${names.length} collections`}` : "Added to the library");
  return source;
}

async function insertWork(invoke: Invoke, workspaceId: string, work: AddWork, collections: string[]) {
  let source: Source;
  if (work.openalexId) {
    source = await invoke<Source>("store_add_work", { openalexId: work.openalexId, title: work.title, doi: work.doi, year: work.year, collectionId: collections[0] ?? null }, workspaceId);
  } else {
    const web = !work.doi && !!work.url;
    source = await invoke<Source>(
      "store_create",
      {
        source: {
          kind: web ? "web" : "reference",
          itemType: web ? "webpage" : "article",
          title: work.title || work.doi || work.url || "",
          ...(work.doi ? { doi: work.doi } : {}),
          ...(work.year ? { year: work.year } : {}),
          ...(work.url ? { url: work.url } : {}),
          ...(work.container ? { containerTitle: work.container } : {}),
          collections,
          ...(web ? {} : { indexStatus: "skipped" }),
        },
      },
      workspaceId,
    );
    if (work.doi) await invoke("store_enrich", { ids: [source.id] }, workspaceId).catch(() => {});
  }
  // Already in the library, or added to the first collection only: file it in the rest.
  for (const id of collections.filter((c) => !source.collections.includes(c)))
    await invoke("store_membership", { collectionId: id, ids: [source.id], present: true }, workspaceId).catch(() => {});
  return source;
}

type Frame = { id: string; x: number; y: number; width: number; height: number; image: string };

/** Mounted once in the shell: shows the chooser, and answers requests from native views. */
export function AddFromSourceHost({ invoke }: { invoke: Invoke }) {
  const [request, setRequest] = useState<Request>();
  useEffect(() => {
    host = (next) => setRequest((current) => (current?.resolve(null), next));
    return () => {
      host = undefined;
    };
  }, []);
  useEffect(() => {
    const key = (window as unknown as { key?: { on?(e: string, cb: (v: unknown) => void): () => void; addFromSourceDone?(id: string, result: unknown): Promise<void> } }).key;
    return key?.on?.("add-from-source", (value) => {
      const { requestId, origin, work } = value as { requestId: string; origin: AddOrigin; work: AddWork };
      void addFromSource(invoke, origin, work, null, true)
        .then((source) => key.addFromSourceDone?.(requestId, { source }))
        .catch((e) => key.addFromSourceDone?.(requestId, { error: String(e).replace(/^Error: /, "") }));
    });
  }, [invoke]);
  if (!request) return null;
  return (
    <Chooser
      key={request.work.title ?? ""}
      request={request}
      onDone={(choice) => {
        request.resolve(choice);
        setRequest(undefined);
      }}
    />
  );
}

/** Collections in tree order with their depth. */
function treeOrder(collections: Collection[]) {
  const out: { c: Collection; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of collections.filter((x) => (x.parentId ?? null) === parent).sort((a, b) => a.position - b.position)) {
      out.push({ c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function Chooser({ request, onDone }: { request: Request; onDone: (choice: Choice | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(() => new Set(request.selected));
  const [dontAsk, setDontAsk] = useState(false);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => treeOrder(request.collections), [request.collections]);
  const shown = filter.trim() ? rows.filter((r) => r.c.name.toLowerCase().includes(filter.trim().toLowerCase())) : rows;
  useDismiss(true, { refs: [box], onDismiss: () => onDone(null), scroll: false });
  const [frames, setFrames] = useState<Frame[]>([]);
  useEffect(() => {
    if (!request.remote) return;
    const id = `add-from-source-${crypto.randomUUID()}`;
    let open = true;
    const tab = (window as unknown as { key?: { tabAction?(a: string, p?: unknown): Promise<unknown> } }).key?.tabAction;
    void (tab?.("global-overlay-open", { id }) as Promise<{ frames?: Frame[] }> | undefined)?.then((r) => open && setFrames(r?.frames ?? [])).catch(() => {});
    const off = bridge().on("global-overlay-frames", (value) => {
      const result = value as { id: string; frames: Frame[] };
      if (result.id === id) setFrames(result.frames);
    });
    return () => {
      open = false;
      off();
      void tab?.("global-overlay-close", { id })?.catch(() => {});
    };
  }, [request.remote]);
  // Beside the button that asked, inside the window; centred near the top otherwise.
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const a = request.anchor;
    if (!a) return setPlace({ left: Math.round((innerWidth - w) / 2), top: Math.max(56, Math.round(innerHeight * 0.18)) });
    const below = a.bottom + 6 + h < innerHeight - 8;
    setPlace({ left: Math.max(8, Math.min(a.left, innerWidth - w - 8)), top: below ? a.bottom + 6 : Math.max(8, a.top - h - 6) });
  }, [request.anchor]);
  useEffect(() => box.current?.querySelector<HTMLElement>(".kx-add-chooser-primary")?.focus(), []);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const finish = () => onDone({ collections: rows.map((r) => r.c.id).filter((id) => selected.has(id)), dontAsk });
  const title = request.work.title || request.work.doi || request.work.url || "This work";
  return createPortal(
    <>
      {frames.map((frame) => (
        <img key={frame.id} className="key-native-overlay-frame" alt="" draggable={false} src={frame.image} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} />
      ))}
      {!request.anchor && <div className="kx-add-chooser-scrim" aria-hidden="true" />}
      <div
        ref={box}
        className="kx-add-chooser"
        role="dialog"
        aria-label="Add to library"
        data-anchored={!!request.anchor}
        style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0 }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone(null);
          } else if (e.key === "Enter" && !(e.target as HTMLElement).matches("button")) {
            e.preventDefault();
            finish();
          }
        }}
      >
        <header>
          <strong>Add to library</strong>
          <span title={title}>{title}</span>
          {request.work.byline && <small>{[request.work.byline, request.work.year].filter(Boolean).join(" · ")}</small>}
        </header>
        {rows.length > 8 && (
          <input className="kx-add-chooser-filter" placeholder="Find a collection" aria-label="Find a collection" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        <div className="kx-add-chooser-list" role="group" aria-label="Collections">
          {rows.length === 0 && <p className="kx-add-chooser-empty">No collections yet. It goes into the library.</p>}
          {shown.map(({ c, depth }) => (
            <label key={c.id} style={{ paddingLeft: 8 + (filter ? 0 : depth) * 14 }} data-checked={selected.has(c.id)}>
              <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              <Icon name="folder" size={12} />
              <span>{c.name}</span>
              {request.selected.includes(c.id) && <small title={request.originTitle ? `Where “${request.originTitle}” is` : undefined}>Same as source</small>}
            </label>
          ))}
        </div>
        <p className="kx-add-chooser-hint">{selected.size ? `Into ${selected.size === 1 ? "1 collection" : `${selected.size} collections`}` : "Into the library, in no collection"}</p>
        <footer>
          <label className="kx-add-chooser-dontask" title="Then sources added like this go to the same collections as the source they came from. Settings › Libraries turns asking back on.">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            Don’t ask again
          </label>
          <span className="kx-spacer" />
          <button className="kx-add-chooser-cancel" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="kx-button-primary kx-add-chooser-primary" onClick={finish}>
            <Icon name="plus" size={12} /> Add
          </button>
        </footer>
      </div>
    </>,
    document.body,
  );
}
