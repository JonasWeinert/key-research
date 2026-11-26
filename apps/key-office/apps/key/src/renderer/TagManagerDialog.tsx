// The library's "Manage tags" entry points open the tag manager.
import TagManager from "./TagManager";
import type { Invoke } from "./library-api";

export default function TagManagerDialog({ invoke, workspaceId, onClose, onSaved, focus }: { invoke: Invoke; workspaceId?: string; onClose: () => void; onSaved: () => void; focus?: string }) {
  if (!workspaceId) return null;
  return (
    <TagManager
      invoke={invoke}
      workspaceId={workspaceId}
      focus={focus}
      onClose={() => {
        onSaved();
        onClose();
      }}
    />
  );
}
