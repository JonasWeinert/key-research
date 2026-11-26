import { describe, expect, it } from "vitest";
import { zoteroItem } from "./status-bar";
import type { ZoteroSyncStatus } from "./library-api";

const now = Date.parse("2026-11-26T12:00:00Z");
const sync = (patch: Partial<ZoteroSyncStatus>): ZoteroSyncStatus => ({ configured: true, paused: false, items: 12, connection: "ok", syncedAt: now - 5 * 60_000, ...patch });

describe("the status bar's Zotero item", () => {
  it("tells each state apart", () => {
    expect(zoteroItem(undefined, false, now)).toMatchObject({ label: "Set up Zotero", tone: "off" });
    expect(zoteroItem(sync({}), false, now)).toMatchObject({ label: "Zotero · 5 minutes ago", tone: "ready" });
    expect(zoteroItem(sync({}), true, now)).toMatchObject({ label: "Syncing Zotero…", busy: true });
    expect(zoteroItem(sync({ connection: "not-running" }), false, now)).toMatchObject({ label: "Zotero closed", tone: "idle" });
    expect(zoteroItem(sync({ connection: "plugin-missing" }), false, now)).toMatchObject({ tone: "warning" });
    expect(zoteroItem(sync({ connection: "unpaired" }), false, now)).toMatchObject({ tone: "warning" });
    expect(zoteroItem(sync({ connection: "error", message: "Boom" }), false, now)).toMatchObject({ label: "Zotero sync failed", tone: "error" });
    expect(zoteroItem(sync({ paused: true }), false, now)).toMatchObject({ label: "Zotero paused", tone: "off" });
  });
  it("puts the details in the tooltip", () => {
    const title = zoteroItem(sync({ libraryName: "My Library", zoteroVersion: "9.0.6", pluginVersion: "1.2" }), false, now).title!;
    expect(title).toContain("Library: My Library");
    expect(title).toContain("12 items synced");
    expect(title).toContain("Last synced 5 minutes ago");
    expect(title).toContain("Zotero 9.0.6 · Key Sync 1.2");
  });
});
