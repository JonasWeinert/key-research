// Settings → Services & API keys → Database connectors: which connectors the database search
// uses (built in, or a downloaded update), whether that update is signed, and a manual check.
// Signing is postponed: an unsigned update is accepted and said to be unsigned here.
import { useCallback, useEffect, useState } from "react";
import type { Invoke } from "./library-api";
import { Group, Row } from "./Settings";

interface ConnectorsStatus {
  sequence: number;
  origin: "baseline" | "update";
  activatedAt?: number | null;
  lastCheckAt?: number | null;
  lastResult?: string | null;
  lastError?: string | null;
  updatesConfigured: boolean;
  connectors: number;
  signed?: boolean | null;
  signingKey?: string | null;
  signatureRequired?: boolean;
}

const day = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export default function DatabaseConnectorsSettings({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [status, setStatus] = useState<ConnectorsStatus>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const load = useCallback(() => {
    if (!workspaceId) return;
    void invoke<ConnectorsStatus>("db_connectors_status", {}, workspaceId)
      .then(setStatus)
      .catch(() => setStatus(undefined));
  }, [invoke, workspaceId]);
  useEffect(load, [load]);
  if (!status) return null;
  const check = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const r = await invoke<{ state: string; changed: string[]; error?: string }>("db_connectors_check", { force: true }, workspaceId);
      setNote(
        r.state === "updated"
          ? `Updated ${r.changed.length} connector${r.changed.length === 1 ? "" : "s"}.`
          : r.state === "failed"
            ? `Couldn’t update: ${r.error ?? "unknown error"}`
            : r.state === "unconfigured"
              ? "Updates are not set up in this build."
              : "The connectors are up to date.",
      );
    } catch (e) {
      setNote(`Couldn’t check: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      load();
    }
  };
  const updated = status.origin === "update";
  const checked = status.lastCheckAt ? `Last checked ${day(status.lastCheckAt)}${status.lastResult === "failed" && status.lastError ? `: ${status.lastError}` : ""}` : status.updatesConfigured ? "Checked at most once a day, or now." : "Not set up in this build.";
  return (
    <Group title="Database connectors" help="settings.services.connectors">
      <Row label="In use" detail={updated ? `Update ${status.sequence}, installed ${day(status.activatedAt)}` : `The ${status.connectors} built into Key`}>
        <span className="kx-settings-badge" data-testid="connectors-signature">
          {updated ? (status.signed ? "Signed" : "Unsigned") : "Built in"}
        </span>
      </Row>
      {updated && (
        <Row
          label="Signature"
          detail={status.signed ? `Signed by key ${status.signingKey ?? ""}; Key checked the signature before installing it.` : "Not signed yet. Key checked each file against the update’s list, but cannot confirm who published it."}
        />
      )}
      <Row label="Updates" detail={note ?? checked}>
        <button className="kx-settings-button" disabled={busy || !status.updatesConfigured} onClick={() => void check()}>
          {busy ? "Checking…" : "Check now"}
        </button>
      </Row>
    </Group>
  );
}
