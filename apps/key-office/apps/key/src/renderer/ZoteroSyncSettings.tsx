// Settings → Libraries → Zotero: import, and the sync through the Key Sync plugin with a
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
    <Group
      title="Zotero"
      footer="Key only reads from Zotero. Changes made in Zotero come to Key; edits you make in Key are kept, and where both changed, Key’s version stays and is listed here. Items that leave what Key syncs stay in Key."
    >
      <Row
        label="Import from Zotero"
        detail={
          info.zoteroFound
            ? `Library found at ${info.zoteroDir.replace(/^\/Users\/[^/]+/, "~")}. Import everything, chosen collections or chosen papers; importing again updates what came before.`
            : "No Zotero library found in your home folder."
        }
      >
        <button className="kx-settings-button" disabled={!info.zoteroFound} onClick={() => onOpen("import")}>
          {imported ? "Import again…" : "Import…"}
        </button>
      </Row>
      <Row
        label="Keep in sync with Zotero"
        detail={
          configured ? (
            <span className="kx-zotero-sync-line" data-state={sync?.paused ? "paused" : (sync?.connection ?? "ok")}>
              {`Syncing ${scope}${sync?.libraryName ? ` from ${sync.libraryName}` : ""}. ${syncLine(sync!, now)}`}
            </span>
          ) : (
            "Follows what you add, change and delete in Zotero, through the Key Sync plugin for Zotero."
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
        <Row label="Stop syncing" detail="Everything that came from Zotero stays in Key. You can set up the sync again at any time.">
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
        <Row label="Follow Zotero’s database" detail={imported ? `Checks Zotero’s database every half minute. Last run ${when}. Set up the plugin sync above to replace it.` : "Import your library first."}>
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
