// Notices at the top of a source's page: a retraction, withdrawal, expression of concern or
// correction (OpenAlex's flag and Crossref's notices, which carry the Retraction Watch
// data), with the notice's link and a per-source "Not a concern"; and the other versions
// of the work it is linked to (a preprint and its published version).
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { libraryChanged } from "./library-nav";
import type { Invoke, Source } from "./library-api";
import { NOTICE_LABEL, retractionOf } from "./library-hygiene";
import "./hygiene.css";
import { Explain } from "./explain";

const tabAction = (action: string, payload: unknown) => (window as unknown as { key: { tabAction(a: string, p?: unknown): Promise<unknown> } }).key.tabAction(action, payload);

export function RetractionNotice({ invoke, workspaceId, source, onChanged }: { invoke: Invoke; workspaceId: string; source: Source; onChanged: () => void }) {
  const flag = retractionOf(source);
  const kind = source.retractionKind;
  const notice = source.retractionNotice;
  const dismiss = (dismissed: boolean) =>
    void invoke("store_retraction_dismiss", { ids: [source.id], dismissed }, workspaceId).then(() => {
      onChanged();
      libraryChanged();
    });
  const link = notice && (
    <a href={`https://doi.org/${notice}`} target="_blank" rel="noreferrer">
      {NOTICE_LABEL[kind ?? ""] ?? "Notice"}
      {source.retractionDate ? ` (${source.retractionDate})` : ""}
    </a>
  );
  if (flag)
    return (
      <div className="kx-retracted" role="alert">
        <Icon name="warning" size={14} />
        {flag}
        <span>
          {kind ? "Crossref and Retraction Watch list a notice for this work. " : "OpenAlex lists this work as retracted. "}
          {link}
          {link ? ". " : ""}Check before citing it. <Explain help="retraction.what" label="What does this mean?" />
        </span>
        <button title="Not a concern for this source (stops flagging it)" onClick={() => dismiss(true)}>
          Dismiss
        </button>
      </div>
    );
  // A correction or erratum, or a dismissed flag: shown quietly.
  if (kind && notice && !source.retractionDismissed)
    return (
      <div className="kx-retracted" data-tone="info" role="note">
        <Icon name="info" size={14} />
        {NOTICE_LABEL[kind] ?? "Notice"}
        <span>This work has a published {NOTICE_LABEL[kind]?.toLowerCase() ?? "notice"}: {link}.</span>
      </div>
    );
  return null;
}

export function VersionsLine({ invoke, workspaceId, sourceId }: { invoke: Invoke; workspaceId: string; sourceId: string }) {
  const [versions, setVersions] = useState<Source[]>([]);
  useEffect(() => {
    let live = true;
    void invoke<Source[]>("store_versions", { id: sourceId }, workspaceId)
      .then((v) => live && setVersions(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, sourceId]);
  if (!versions.length) return null;
  return (
    <div className="kx-versions">
      <Icon name="layers" size={13} />
      <span>{versions.length === 1 ? "Other version:" : "Other versions:"}</span>
      {versions.map((v) => (
        <button key={v.id} onClick={() => void tabAction("open-source-page", { workspaceId, sourceId: v.id, title: v.title || "Untitled", read: false })}>
          {v.title || "Untitled"}
          {v.year ? ` (${v.year}${v.itemType === "preprint" ? ", preprint" : ""})` : ""}
        </button>
      ))}
    </div>
  );
}
