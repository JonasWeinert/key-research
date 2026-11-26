// Settings → Zotero: import, and the sync through the Key Sync plugin with a
// quiet status (last synced, "Zotero is not running"), pause, change and stop.
import { useEffect, useState } from "react";
import { bridge, type AppInfo, type AppSettings, type Invoke, type WorkspaceSummary, type ZoteroOptions, type ZoteroStatus, type ZoteroSyncStatus } from "./library-api";
import { Group, Row } from "./Settings";
import { Conflicts } from "./ZoteroImport";
import { syncLine, type Mode } from "./zotero-sheet-model";

import { zoteroWorkspaceOf } from "./zotero-workspace";
export { zoteroWorkspaceOf };

export function ZoteroSettings({
  invoke,
  workspaces,
  info,
  settings,
  onSettings,
  onOpen,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  /** Opens the Zotero sheet: at the start, or on a mode's second step. */
  onOpen: (mode?: Mode, current?: ZoteroOptions | null) => void;
}) {
  const workspace = zoteroWorkspaceOf(workspaces);
  const [status, setStatus] = useState<ZoteroStatus>();
  const [sync, setSync] = useState<ZoteroSyncStatus>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = async () => {
    if (!workspace) return;
    const [s, p] = await Promise.all([
      invoke<ZoteroStatus>("store_zotero_status", {}, workspace.id).catch(() => undefined),
      invoke<ZoteroSyncStatus>("store_zotero_plugin_status", {}, workspace.id).catch(() => undefined),
    ]);
    setStatus(s);
    setSync(p);
    setNow(Date.now());
  };
  useEffect(() => {
    if (!workspace) return;
    let stopped = false;
    const tick = () => void (!stopped && load());
    tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspace?.id]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await load();
      // The status bar's Zotero item follows.
      window.dispatchEvent(new CustomEvent("key:zotero-changed"));
    } finally {
      setBusy(false);
    }
  };
  const configure = (args: Record<string, unknown>) => invoke("store_zotero_plugin_configure", args, workspace!.id);
  const syncNow = () => act(() => invoke("store_zotero_plugin_sync", { force: true }, workspace!.id));

  const imported = !!status?.at;
  const report = status?.report;
  const when = status?.at ? new Date(status.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  const configured = !!sync?.configured;
  const scope = sync?.options?.itemKeys
    ? `${sync.options.itemKeys.length.toLocaleString()} chosen papers`
    : sync?.options?.collectionKeys
      ? `${sync.options.collectionKeys.length.toLocaleString()} collections`
      : "the whole library";
  return (
    <Group title="Zotero" help="zotero.import-vs-sync" intro="settings.zotero.intro" footer="Key only reads from Zotero. Where both changed an item, Key’s version stays and is listed here.">
      <Row
        label="Import from Zotero"
        detail={
          info.zoteroFound
            ? `${info.zoteroDir.replace(/^\/Users\/[^/]+/, "~")} · everything, collections or chosen papers`
            : "No Zotero library found on this Mac. Install Zotero and open it once, then come back."
        }
      >
        <button className="kx-settings-button" disabled={!info.zoteroFound} onClick={() => onOpen("import")}>
          {imported ? "Import again…" : "Import…"}
        </button>
      </Row>
      <Row
        label="Keep in sync with Zotero"
        help="zotero.plugin"
        detail={
          configured ? (
            <span className="kx-zotero-sync-line" data-state={sync?.paused ? "paused" : (sync?.connection ?? "ok")}>
              {`Syncing ${scope}${sync?.libraryName ? ` from ${sync.libraryName}` : ""}. ${syncLine(sync!, now)}`}
            </span>
          ) : (
            "Follows what you change in Zotero from now on, through the small Key Sync plugin Key installs for you."
          )
        }
      >
        {configured ? (
          <>
            {!sync!.paused && (
              <button className="kx-settings-button" disabled={busy} onClick={() => void syncNow()}>
                {busy ? "Syncing…" : "Sync now"}
              </button>
            )}
            <button className="kx-settings-button" disabled={busy} onClick={() => void act(() => configure({ paused: !sync!.paused }))}>
              {sync!.paused ? "Resume" : "Pause"}
            </button>
            <button className="kx-settings-button" disabled={busy} onClick={() => onOpen("sync", sync!.options)}>
              Change…
            </button>
          </>
        ) : (
          <button className="kx-settings-button" disabled={!info.zoteroFound} onClick={() => onOpen("sync")}>
            Set up…
          </button>
        )}
      </Row>
      {configured && (
        <Row label="Stop syncing" detail="What came from Zotero stays in Key.">
          <button
            className="kx-settings-button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Stop keeping this library in sync with Zotero? What came from Zotero stays in Key.")) void act(() => configure({ remove: true }).then(() => bridge().zoteroPlugin?.("wake")));
            }}
          >
            Stop syncing
          </button>
        </Row>
      )}
      {/* The older sync that read Zotero's database, for libraries that still use it. */}
      {!configured && settings.zoteroSync && (
        <Row label="Follow Zotero’s database" detail={imported ? `Older sync, every half minute · last run ${when}` : "Import your library first"}>
          <input type="checkbox" className="kx-switch" aria-label="Follow Zotero’s database" checked={settings.zoteroSync} onChange={(e) => onSettings({ zoteroSync: e.target.checked })} />
        </Row>
      )}
      {!!(sync?.report?.conflictCount || report?.conflictCount) && (
        <div className="kx-settings-row kx-settings-row-wide">
          <Conflicts report={(sync?.report?.conflictCount ? sync.report : report)!} />
        </div>
      )}
    </Group>
  );
}
