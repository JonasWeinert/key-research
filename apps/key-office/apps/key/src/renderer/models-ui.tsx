// On-device models (search, PDF layout): not shipped in the app, downloaded from Hugging Face
// when first needed and kept once per machine (the host's key-models). Settings shows each
// with its source, licence and state; the status bar shows a download in progress.
import { useState } from "react";
import { Icon } from "./icons";
import "./models.css";
import { bridge, type Invoke } from "./library-api";
import { Group, Row } from "./Settings";
import type { StatusItem } from "../shared/status-items";

export interface ModelInfo {
  id: string;
  name: string;
  title: string;
  purpose: string;
  repo: string;
  revision: string;
  cardUrl: string;
  license: string;
  licenseUrl: string;
  upstream: string;
  size: number;
  state: "missing" | "downloading" | "ready" | "failed" | string;
  received: number;
  total: number;
  error?: string | null;
  retryAt?: number | null;
  path?: string | null;
  diskBytes: number;
}
export interface ModelsListing {
  root: string;
  autoDownload: boolean;
  diskBytes: number;
  models: ModelInfo[];
}

export const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString()} MB`);
const percent = (m: ModelInfo) => (m.total ? Math.min(100, Math.floor((m.received / m.total) * 100)) : 0);

/** The status bar's item while a model downloads. */
export function modelsWorkItem(listing: ModelsListing | undefined): StatusItem | undefined {
  const active = listing?.models.find((m) => m.state === "downloading");
  if (!active) return undefined;
  return {
    id: "work",
    label: `${active.name} ${percent(active)}%`,
    progress: active.total ? active.received / active.total : 0,
    title: `Downloading ${active.title}: ${megabytes(active.received)} of ${megabytes(active.total)}`,
    priority: 90,
  };
}

function ModelState({ model, busy, onDownload, onRemove }: { model: ModelInfo; busy: boolean; onDownload: () => void; onRemove: () => void }) {
  if (model.state === "downloading")
    return (
      <span className="kx-models-progress" role="progressbar" aria-label={`${model.name} download`} aria-valuenow={percent(model)} aria-valuemin={0} aria-valuemax={100}>
        <span className="kx-meter" aria-hidden="true">
          <span style={{ width: `${percent(model)}%` }} />
        </span>
        <b>Downloading {percent(model)}%</b>
      </span>
    );
  if (model.state === "ready")
    return (
      <>
        <span className="kx-settings-ok">
          <Icon name="check" size={12} /> Ready
        </span>
        <button className="kx-settings-button" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </>
    );
  if (model.state === "failed")
    return (
      <>
        <span className="kx-models-failed">Failed</span>
        <button className="kx-settings-button" disabled={busy} onClick={onDownload}>
          Retry
        </button>
      </>
    );
  return (
    <>
      <span className="kx-settings-state">Not downloaded</span>
      <button className="kx-settings-button" disabled={busy} onClick={onDownload}>
        Download
      </button>
    </>
  );
}

/** Settings › Search & indexing: every model, the automatic-download switch, disk use and
 *  the air-gapped way in (a file downloaded by hand, checked against its hash). */
export function ModelsGroup({
  invoke,
  workspaceId,
  listing,
  autoDownload,
  onAutoDownload,
  accelerator,
  onChanged,
}: {
  invoke: Invoke;
  workspaceId?: string;
  listing?: ModelsListing;
  autoDownload: boolean;
  onAutoDownload: (value: boolean) => void;
  /** Where the search model runs (Metal, CPU…), once it has started. */
  accelerator?: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState("");
  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
    } finally {
      setBusy(undefined);
      onChanged();
    }
  };
  const addFromFile = () =>
    act("import", async () => {
      const path = await bridge().choosePath({ mode: "open", title: "Add model from file", filterName: "Models", extensions: ["onnx", "gguf", "json"], allowFolders: true });
      if (!path) return;
      const result = await invoke<{ added: string[] }>("store_model_import", { path }, workspaceId);
      const names = result.added.map((id) => listing?.models.find((m) => m.id === id)?.name ?? id);
      setMessage(`Added ${names.join(" and ")}.`);
    });
  const root = listing?.root ?? "";
  return (
    <Group
      title="On-device models"
      footer={
        message ||
        "Downloaded from Hugging Face once, when first needed, and checked against their published checksums. They run on this Mac; your sources and searches never leave it."
      }
    >
      {!listing && <Row label="Models" detail="Checking…" />}
      {listing?.models.map((model) => {
        const failed = model.state === "failed" && model.error;
        return (
          <div className="kx-settings-row kx-models-row" key={model.id} data-model={model.id} data-state={model.state}>
            <div>
              <span>{model.name}</span>
              <small>
                {model.purpose} {model.title}
                {model.id.startsWith("embeddinggemma") && accelerator && model.state === "ready" ? `, ${accelerator}` : ""} · {megabytes(model.size)}
              </small>
              <small className="kx-models-links">
                <a href={model.cardUrl} target="_blank" rel="noreferrer">
                  Source
                </a>
                <a href={model.upstream} target="_blank" rel="noreferrer">
                  Original model
                </a>
                <a href={model.licenseUrl} target="_blank" rel="noreferrer">
                  {model.license}
                </a>
              </small>
              {failed && <small className="kx-models-error">{model.error}</small>}
            </div>
            <div className="kx-settings-control">
              <ModelState
                model={model}
                busy={busy === model.id}
                onDownload={() => act(model.id, () => invoke("store_model_download", { id: model.id }, workspaceId))}
                onRemove={() => act(model.id, () => invoke("store_model_remove", { id: model.id }, workspaceId))}
              />
            </div>
          </div>
        );
      })}
      <Row label="Download automatically when needed" detail="Off: Key asks here first. Search by words and plain PDF text work without them.">
        <input type="checkbox" className="kx-switch" aria-label="Download models automatically when needed" checked={autoDownload} onChange={(e) => onAutoDownload(e.target.checked)} />
      </Row>
      <Row label="Disk use" path detail={listing ? `${megabytes(listing.diskBytes)} in ${root.replace(/^\/Users\/[^/]+/, "~")}` : ""}>
        <button className="kx-settings-button" disabled={busy === "import"} onClick={addFromFile}>
          Add model from file…
        </button>
        <button className="kx-settings-button" disabled={!root} onClick={() => void bridge().revealPath(root)}>
          Show in Finder
        </button>
      </Row>
    </Group>
  );
}
