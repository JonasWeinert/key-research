import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { dismissAll } from "@key-reader/ui/dismiss";
import { Drawer } from "./motion/Drawer";
import "./global-drawer.css";
import "./modal.css";
type Entry = {
  id: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  presentation?: "drawer" | "dialog" | "sheet" | "window";
  label?: string;
};
let current: Entry | null = null;
const listeners = new Set<() => void>();
const publish = (entry: Entry | null) => {
  current = entry;
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
/** Opens a modal over the whole window (one at a time); the shell behind goes inert and dims.
 *  `sheet` hangs from the title bar, `dialog` sits centred, `window` is a large centred
 *  sheet (Settings), `drawer` slides in from the left. Sizing is shared (modal.css,
 *  modal-size.ts): the frame fits its content up to the window less a margin and scrolls
 *  inside past that; it holds its height while the content changes within one view. Mark
 *  views with `data-modal-view="<name>"` on an element inside so the height may settle
 *  (animated) when switching between them; set `--kx-modal-width` / `--kx-modal-min-height`
 *  on the modal for a wider or taller one.
 *
 *    <GlobalDrawer presentation="sheet" label="Manage tags" onClose={close}>
 *      <div className="my-sheet" data-modal-view={step}>…</div>
 *    </GlobalDrawer>
 */
export function GlobalDrawer({
  children,
  onClose,
  busy,
  presentation = "drawer",
  label = "Property details",
}: {
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  presentation?: "drawer" | "dialog" | "sheet" | "window";
  label?: string;
}) {
  const id = useId();
  useLayoutEffect(() => {
    // A modal opening over the window (from a menu or shortcut, with no press to close them)
    // closes the menus and popovers behind it: they would otherwise take its Escape.
    if (!current) dismissAll("switch");
    publish({ id, children, onClose, busy, presentation, label });
  });
  useLayoutEffect(
    () => () => {
      if (current?.id === id) publish(null);
    },
    [id],
  );
  return null;
}
export function GlobalDialog(props: {
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  label: string;
}) {
  return <GlobalDrawer {...props} presentation="dialog" />;
}
type Frame = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  image: string;
};
const bridge = () => (window as any).key;
export function GlobalDrawerHost() {
  const entry = useSyncExternalStore(subscribe, () => current);
  const [ready, setReady] = useState(false),
    [frames, setFrames] = useState<Frame[]>([]);
  const lease = useRef<string | undefined>(undefined),
    savedFocus = useRef<HTMLElement | null>(null),
    last = useRef<Entry | null>(null);
  if (entry) last.current = entry;
  const release = () => {
    const id = lease.current;
    if (current || !id) return;
    lease.current = undefined;
    setReady(false);
    setFrames([]);
    last.current = null;
    void bridge().tabAction("global-overlay-close", { id });
    const body = document.querySelector<HTMLElement>(".key-shell-body");
    if (body) body.inert = false;
    savedFocus.current?.isConnected && savedFocus.current.focus();
  };
  useEffect(() => {
    if (!entry || lease.current) return;
    const id = crypto.randomUUID();
    lease.current = id;
    savedFocus.current = document.activeElement as HTMLElement;
    void bridge()
      .tabAction("global-overlay-open", { id })
      .then((result: { frames: Frame[] }) => {
        if (lease.current !== id) return;
        setFrames(result.frames);
        setReady(true);
        if (!current) {
          lease.current = undefined;
          setReady(false);
          setFrames([]);
          void bridge().tabAction("global-overlay-close", { id });
        }
      })
      .catch(() => {
        if (lease.current !== id) return;
        void bridge()
          .tabAction("global-overlay-close", { id })
          .catch(() => {});
        lease.current = undefined;
        setFrames([]);
        setReady(false);
        current?.onClose();
      });
  }, [entry?.id]);
  useEffect(() => {
    // The modal covers the whole window, so all of the shell behind it goes inert.
    const behind = Array.from(
      document.querySelectorAll<HTMLElement>(".key-shell-body, .key-sidebar-slot, .kx-tabs"),
    );
    behind.forEach((el) => (el.inert = ready));
    document.documentElement.classList.toggle("kx-modal-open", ready);
    return () => {
      behind.forEach((el) => (el.inert = false));
      document.documentElement.classList.remove("kx-modal-open");
    };
  }, [ready]);
  useEffect(
    () =>
      bridge().on(
        "global-overlay-frames",
        (result: { id: string; frames: Frame[] }) => {
          if (result.id === lease.current) setFrames(result.frames);
        },
      ),
    [],
  );
  useEffect(
    () => () => {
      const id = lease.current;
      lease.current = undefined;
      if (id) void bridge().tabAction("global-overlay-close", { id });
    },
    [],
  );
  return createPortal(
    <>
      {ready &&
        frames.map((frame) => (
          <img
            key={frame.id}
            className="key-native-overlay-frame"
            alt=""
            draggable={false}
            src={frame.image}
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
            }}
          />
        ))}
      <Drawer
        presentation={(entry || last.current)?.presentation}
        label={(entry || last.current)?.label}
        open={ready && !!entry}
        onClose={() => {
          if (!current?.busy) current?.onClose();
        }}
        onExitComplete={release}
      >
        {(entry || last.current)?.children}
      </Drawer>
    </>,
    document.body,
  );
}
