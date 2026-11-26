// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ZoteroImport } from "./ZoteroImport";
import type { ZoteroItem, ZoteroPreview } from "./library-api";
import { ago, blocker, choiceOf, filterItems, optionsOf, syncLine, DEFAULT_BRING } from "./zotero-sheet-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The design system is compiled with the classic JSX runtime under vitest.
(globalThis as { React?: typeof React }).React = React;

const PREVIEW: ZoteroPreview = {
  dataDir: "/Users/someone/Zotero",
  collections: [
    { key: "THESIS", name: "Thesis", parentKey: null, items: 2, total: 5 },
    { key: "CHAPTER", name: "Chapter 2", parentKey: "THESIS", items: 3, total: 3 },
    { key: "OTHER", name: "Other", parentKey: null, items: 4, total: 4 },
  ],
  library: { items: 1200, files: 300, notes: 80, annotations: 12 },
  selected: { items: 1200, files: 300, notes: 80, annotations: 12 },
  unfiled: 7,
};
const ITEMS: ZoteroItem[] = [
  { key: "A", title: "Health versus income", creators: "Palma", year: 2022, itemType: "journalArticle", hasFile: true, collections: [] },
  { key: "B", title: "A Book on Reading", creators: "Rossi & Bianchi", year: 2019, itemType: "book", hasFile: false, collections: [] },
];

let root: Root | undefined;
let installed = false;
let host: HTMLElement | undefined;
const bridge = {
  workspaces: vi.fn(async () => [{ id: "zw", name: "Zotero", root: "/Users/someone/Key/Zotero" }]),
  zoteroWorkspace: vi.fn(async () => ({ id: "zw", name: "Zotero", root: "/Users/someone/Key/Zotero" })),
  importZotero: vi.fn(),
  zoteroPlugin: vi.fn(async (action?: string) => {
    if (!action) return { file: "/App/key-sync.xpi" };
    if (action === "install") installed = true;
    const install = { running: true, profile: "/P", installedVersion: null, bundledVersion: "1.0.1" };
    return { file: "/App/key-sync.xpi", install: { ...install, state: action === "install" || installed ? "pending" : "not-installed" } };
  }),
  revealPath: vi.fn(async () => {}),
};
beforeEach(() => {
  installed = false;
  (window as unknown as { key: typeof bridge }).key = bridge;
  for (const f of Object.values(bridge)) f.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

async function render(invoke: (command: string, args?: Record<string, unknown>, ws?: string) => Promise<unknown>, props: Partial<React.ComponentProps<typeof ZoteroImport>> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ZoteroImport invoke={invoke as never} workspaceId="w1" onClose={() => {}} onDone={() => {}} {...props} />);
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return host;
}

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(() => new Promise((r) => setTimeout(r, 200)));
};
const button = (view: HTMLElement, text: string) => [...view.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const tab = (view: HTMLElement, text: string) => [...view.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes(text));
const radio = (view: HTMLElement, text: string) => [...view.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes(text));
const type = async (input: Element | null, value: string) => {
  const el = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const preview = (args?: Record<string, unknown>) => {
  const collections = args?.collectionKeys as string[] | undefined;
  const items = args?.itemKeys as string[] | undefined;
  if (!collections && !items) return PREVIEW;
  return { ...PREVIEW, selected: { items: (collections?.length ?? 0) * 2 + (items?.length ?? 0), files: args?.attachments ? 1 : 0, notes: 0, annotations: 0 } };
};

describe("Zotero sheet", () => {
  it("starts with the choice between importing once and keeping in sync", async () => {
    const view = await render(async (command, args) => (command === "store_zotero_preview" ? preview(args) : null));
    expect(view.querySelector("h2")?.textContent).toBe("Bring in your Zotero library");
    expect(radio(view, "Import once")?.getAttribute("aria-checked")).toBe("true");
    await click(radio(view, "Keep in sync"));
    expect(radio(view, "Keep in sync")?.getAttribute("aria-checked")).toBe("true");
    await click(button(view, "Back") ?? button(view, "Continue"));
    expect(view.querySelector("h2")?.textContent).toBe("Keep in sync with Zotero");
    await click(button(view, "Back"));
    expect(view.querySelector("h2")?.textContent).toBe("Bring in your Zotero library");
  });

  it("imports everything, chosen collections or chosen papers, with counts", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_zotero_preview") return preview(args);
      if (command === "store_zotero_items") return ITEMS;
      throw Error(command);
    });
    const view = await render(invoke);
    await click(button(view, "Continue"));
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("1,200 items · 300 files · 80 notes · 12 annotations");
    expect(view.textContent).toContain("~/Zotero");

    await click(tab(view, "Collections"));
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("Choose at least one collection");
    expect((view.querySelector(".key-property-primary") as HTMLButtonElement).disabled).toBe(true);
    const rows = () => [...view.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent);
    expect(rows()).toEqual(["Other4", "Thesis5"]);
    // Choosing a collection chooses the one inside it.
    await click(view.querySelector('input[aria-label="Thesis"]'));
    expect(invoke).toHaveBeenLastCalledWith("store_zotero_preview", expect.objectContaining({ collectionKeys: ["THESIS", "CHAPTER"], attachments: true }), "w1");
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("4 items · 1 file");
    await click(view.querySelector('[aria-label="Expand Thesis"]'));
    await click(view.querySelector('input[aria-label="Chapter 2"]'));
    const thesis = view.querySelector('input[aria-label="Thesis"]') as HTMLInputElement;
    expect([thesis.checked, thesis.indeterminate]).toEqual([true, false]);

    // Papers: a searchable list.
    await click(tab(view, "Papers"));
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("Choose at least one paper");
    expect([...view.querySelectorAll(".kx-zotero-paper")].length).toBe(2);
    await type(view.querySelector('input[aria-label="Search papers"]'), "rossi 2019");
    expect([...view.querySelectorAll(".kx-zotero-paper .kx-zotero-name")].map((e) => e.textContent)).toEqual(["A Book on Reading"]);
    await click(view.querySelector('input[aria-label="A Book on Reading"]'));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(invoke).toHaveBeenLastCalledWith("store_zotero_preview", expect.objectContaining({ itemKeys: ["B"] }), "w1");
    expect(invoke.mock.lastCall?.[1]).not.toHaveProperty("collectionKeys");
    expect((view.querySelector(".key-property-primary") as HTMLButtonElement).disabled).toBe(false);

    bridge.importZotero.mockResolvedValueOnce({ workspace: { id: "zw", name: "Zotero", root: "/x/Zotero" }, report: { items: 1, added: 1, conflictCount: 0, conflicts: [] } });
    await click(view.querySelector(".key-property-primary"));
    expect(bridge.importZotero).toHaveBeenCalledWith(expect.objectContaining({ itemKeys: ["B"] }));
    expect(view.textContent).toContain("Imported into “Zotero”");
  });

  it("explains how to install the plugin, then starts syncing once Zotero answers", async () => {
    let connection = "plugin-missing";
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_zotero_preview") return preview(args);
      if (command === "store_zotero_plugin_probe")
        return connection === "ok"
          ? { connection, zoteroVersion: "9.0.6", pluginVersion: "1.0.0", libraries: [{ libraryID: 1, name: "My Library", type: "user" }], defaultLibraryID: 1, tokenSource: "found" }
          : { connection, libraries: [] };
      if (command === "store_zotero_plugin_configure") return { configured: true };
      if (command === "store_zotero_plugin_sync") return { ran: true, connection: "ok", report: { items: 3, added: 3, conflictCount: 0, conflicts: [] } };
      if (command === "store_zotero_progress") return null;
      throw Error(command);
    });
    const onDone = vi.fn();
    const view = await render(invoke, { initialMode: "sync", onDone });
    expect(view.textContent).toContain("Install the Key Sync plugin in Zotero");
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("Zotero needs the Key Sync plugin");
    expect((view.querySelector(".key-property-primary") as HTMLButtonElement).disabled).toBe(true);
    await click(button(view, "Show plugin file"));
    expect(bridge.revealPath).toHaveBeenCalledWith("/App/key-sync.xpi");
    // One click puts the plugin into Zotero's profile; Zotero needs a restart to load it.
    await click(button(view, "Install in Zotero"));
    expect(bridge.zoteroPlugin).toHaveBeenCalledWith("install");
    expect(view.textContent).toContain("Restart Zotero to finish");
    expect(button(view, "Restart Zotero")).toBeTruthy();
    // The probe asks the Zotero workspace's host, where a saved pairing lives.
    expect(invoke).toHaveBeenCalledWith("store_zotero_plugin_probe", {}, "zw");

    connection = "ok";
    await click(button(view, "Check again"));
    expect(view.textContent).toContain("Connected to Zotero 9.0.6");
    await click(tab(view, "Collections"));
    await click(view.querySelector('input[aria-label="Other"]'));
    await click(view.querySelector(".key-property-primary"));
    expect(invoke).toHaveBeenCalledWith("store_zotero_plugin_configure", expect.objectContaining({ options: expect.objectContaining({ collectionKeys: ["OTHER"] }), libraryID: 1 }), "zw");
    expect(invoke).toHaveBeenCalledWith("store_zotero_plugin_sync", { force: true }, "zw");
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: "zw" }), expect.objectContaining({ added: 3 }), "sync");
    expect(view.textContent).toContain("is in sync with Zotero");
  });

  it("asks for the pairing code when Zotero refuses the saved one", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_zotero_preview") return preview(args);
      if (command === "store_zotero_plugin_probe") return args?.token === "abc" ? { connection: "ok", libraries: [], tokenSource: "given" } : { connection: "unpaired", libraries: [] };
      throw Error(command);
    });
    const view = await render(invoke, { initialMode: "sync" });
    expect(view.textContent).toContain("Pair Key with Zotero");
    await type(view.querySelector('input[aria-label="Pairing code"]'), "abc");
    await click(button(view, "Pair"));
    expect(invoke).toHaveBeenCalledWith("store_zotero_plugin_probe", { token: "abc" }, "zw");
    expect(view.textContent).toContain("Connected to Zotero");
  });

  it("opens a saved sync on its scope to change it", async () => {
    const view = await render(async (command, args) => (command === "store_zotero_preview" ? preview(args) : command === "store_zotero_plugin_probe" ? { connection: "ok", libraries: [] } : null), {
      initialMode: "sync",
      current: { collectionKeys: ["OTHER"], attachments: false, notes: true, annotations: true, mirrorCollections: true },
    });
    expect(view.querySelector("h2")?.textContent).toBe("Change what Key syncs");
    expect(tab(view, "Collections")?.getAttribute("aria-selected")).toBe("true");
    expect((view.querySelector('input[aria-label="Other"]') as HTMLInputElement).checked).toBe(true);
    expect((view.querySelector('input[aria-label="PDFs and other files"]') as HTMLInputElement).checked).toBe(false);
    expect(button(view, "Save and sync")).toBeTruthy();
  });

  it("shows why the library cannot be read", async () => {
    const view = await render(async () => {
      throw Error("No Zotero library found. Choose its data folder (it contains zotero.sqlite).");
    });
    expect(view.querySelector(".kx-inline-error")?.textContent).toContain("No Zotero library found");
  });
});

describe("Zotero sheet model", () => {
  it("turns a choice into options and back", () => {
    const choice = { scope: "papers" as const, collections: new Set(["C"]), papers: new Set(["P1", "P2"]), bring: DEFAULT_BRING };
    expect(optionsOf(choice)).toEqual({ ...DEFAULT_BRING, itemKeys: ["P1", "P2"] });
    expect(optionsOf({ ...choice, scope: "collections" })).toEqual({ ...DEFAULT_BRING, collectionKeys: ["C"] });
    expect(optionsOf({ ...choice, scope: "library" })).toEqual(DEFAULT_BRING);
    const back = choiceOf({ ...DEFAULT_BRING, itemKeys: ["P1"] });
    expect([back.scope, [...back.papers]]).toEqual(["papers", ["P1"]]);
    expect(choiceOf(null).scope).toBe("library");
  });

  it("knows what still blocks each mode", () => {
    const choice = choiceOf(null);
    expect(blocker("import", choice)).toBeNull();
    expect(blocker("sync", choice, "not-running")).toBe("Zotero needs the Key Sync plugin");
    expect(blocker("sync", choice, "ok")).toBeNull();
    expect(blocker("sync", { ...choice, scope: "papers" }, "ok")).toBe("Choose at least one paper");
  });

  it("searches papers by every word and writes a quiet status", () => {
    expect(filterItems(ITEMS, "palma income").map((i) => i.key)).toEqual(["A"]);
    expect(filterItems(ITEMS, "  ").length).toBe(2);
    const now = 10_000_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(syncLine({ configured: true, paused: false, connection: "ok", checkedAt: now - 1000 }, now)).toBe("Up to date, checked just now.");
    expect(syncLine({ configured: true, paused: false, connection: "not-running", syncedAt: now - 3 * 3600_000 }, now)).toBe("Zotero is not running. Key catches up when it is. Last synced 3 hours ago.");
    expect(syncLine({ configured: true, paused: true }, now)).toContain("Paused");
  });
});
