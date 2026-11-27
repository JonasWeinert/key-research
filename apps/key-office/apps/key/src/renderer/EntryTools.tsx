import FillSheet from "./FillSheet";
import {
  Button,
  Input,
  Textarea,
  Select,
  Surface,
} from "@key/design-system";
import { GlobalDrawer, GlobalDialog } from "./GlobalDrawer";
import { useEffect, useState, useRef } from "react";
import { openBibImport } from "./BiblioSheets";
import type { LibraryHomeProps } from "./LibraryHome";
type Invoke = LibraryHomeProps["invoke"];
export interface SourceEntry {
  id: string;
  kind: string;
  title: string;
  body: string;
  properties: Record<string, unknown>;
  revision: number;
  workspaceId?: string;
}
interface Props {
  invoke: Invoke;
  workspaceId?: string;
  projectId?: string;
  onClose: () => void;
  onSaved: () => void;
}
function highlight(text: string, query: string) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  return i < 0 ? (
    text
  ) : (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}
const types = [
  "web",
  "reference",
  "note",
  "image",
  "video",
  "audio",
  "dataset",
];
function Frame({
  title,
  onClose,
  children,
  embedded = false,
  className = "",
  drawer = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  embedded?: boolean;
  className?: string;
  drawer?: boolean;
}) {
  if (drawer)
    return (
      <GlobalDrawer onClose={onClose} presentation="sheet">
        <Frame title={title} onClose={onClose} className={className} embedded>
          {children}
        </Frame>
      </GlobalDrawer>
    );
  if (embedded && className.includes("key-agent-fill-dialog"))
    return (
      <section className={`key-shell-dialog ${className}`} aria-label={title}>
        <header style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>{title}</h2>
          <Button
            type="button"
            aria-label="Close agent settings"
            onClick={onClose}
          >
            ×
          </Button>
        </header>
        {children}
      </section>
    );
  if (embedded)
    return (
      <section className="key-record-editor key-entry-pane">
        <h2>{title}</h2>
        {children}
      </section>
    );
  return (
    <GlobalDialog label={title} onClose={onClose}>
      <section
        className={`key-shell-dialog ${className}`}
      >
        <header style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>{title}</h2>
          <Button onClick={onClose} aria-label="Close">
            ×
          </Button>
        </header>
        {children}
      </section>
    </GlobalDialog>
  );
}
export function AddEntryDialog(props: Props) {
  return <EntryDetails {...props} />;
}
const reservedEntryProperties = new Set([
  "sourceType",
  "url",
  "contentMode",
  "pdfHash",
  "authors",
  "year",
  "doi",
  "fullTextUrl",
  "metadataSource",
]);
export function EntryDetails({
  invoke,
  workspaceId,
  projectId,
  onClose,
  onSaved,
  entry,
  embedded = false,
  onState,
}: Props & {
  entry?: SourceEntry;
  embedded?: boolean;
  onState?: (dirty: boolean, title: string) => void;
}) {
  const [extras, setExtras] = useState<Record<string, unknown>>({});
  const [propertyName, setPropertyName] = useState("");
  const [propertyValue, setPropertyValue] = useState("");
  const [propertyType, setPropertyType] = useState("text");
  const [notice, setNotice] = useState("");
  const [lookup, setLookup] = useState<any>();
  const [authors, setAuthors] = useState(
    ((entry?.properties.authors as string[]) ?? []).join("; "),
  );
  const [year, setYear] = useState(String(entry?.properties.year ?? ""));
  const [loaded, setLoaded] = useState<SourceEntry | undefined>(
    entry?.body ? entry : undefined,
  );
  const [type, setType] = useState(
    String(entry?.properties.sourceType ?? "web"),
  );
  const [title, setTitle] = useState(entry?.title ?? "");
  const [url, setUrl] = useState(String(entry?.properties.url ?? ""));
  const [content, setContent] = useState(entry?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = workspaceId ?? entry?.workspaceId;
  const baseline = useRef<string | undefined>(undefined);
  const fields = JSON.stringify({
    title,
    url,
    type,
    content,
    authors,
    year,
    extras,
  });
  const stateCallback = useRef(onState);
  stateCallback.current = onState;
  useEffect(() => {
    stateCallback.current?.(
      baseline.current !== undefined && fields !== baseline.current,
      title,
    );
  }, [fields, loaded]);

  useEffect(() => {
    if (!entry) return;
    let live = true;
    void invoke<SourceEntry>("workspace_entry", { id: entry.id }, id)
      .then((r) => {
        if (live) {
          setExtras(
            Object.fromEntries(
              Object.entries(r.properties).filter(
                ([key]) => !reservedEntryProperties.has(key),
              ),
            ),
          );
          baseline.current = JSON.stringify({
            title: r.title,
            url: String(r.properties.url ?? ""),
            type: String(r.properties.sourceType),
            content: r.body,
            authors: ((r.properties.authors as string[]) ?? []).join("; "),
            year: String(r.properties.year ?? ""),
            extras: Object.fromEntries(
              Object.entries(r.properties).filter(
                ([key]) => !reservedEntryProperties.has(key),
              ),
            ),
          });
          setLoaded(r);
          setContent(r.body);
          setTitle(r.title);
          setUrl(String(r.properties.url ?? ""));
          setType(String(r.properties.sourceType));
          setAuthors(((r.properties.authors as string[]) ?? []).join("; "));
          setYear(String(r.properties.year ?? ""));
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, [entry?.id, id]);
  async function save() {
    if (year && !Number.isInteger(Number(year))) {
      setError("Enter a valid year");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await invoke<SourceEntry>(
        "workspace_save_entry",
        {
          id: entry?.id ?? null,
          sourceType: type,
          title,
          url:
            type === "reference" && /^10\.\d{4,9}\//.test(url.trim())
              ? "https://doi.org/" + url.trim()
              : url,
          content,
          properties: {
            ...Object.fromEntries(
              Object.entries(loaded?.properties ?? {}).filter(([key]) =>
                reservedEntryProperties.has(key),
              ),
            ),
            ...extras,
            authors: authors
              .split(";")
              .map((a) => a.trim())
              .filter(Boolean),
            year: year ? Number(year) : null,
            ...(lookup
              ? {
                  fullTextUrl: lookup.fullTextUrl ?? null,
                  metadataSource: lookup.source ?? null,
                  doi: lookup.doi ?? null,
                }
              : {}),
          },
          expectedRevision: loaded?.revision ?? null,
          projectId: projectId ?? null,
        },
        id,
      );
      baseline.current = fields;
      setLoaded(saved);
      onSaved();
      if (!embedded) onClose();
      else setNotice("Saved");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function lookupMetadata() {
    setBusy(true);
    setError("");
    try {
      setLookup(
        await invoke("scholarly_lookup_resource", { resource: url.trim() }, id),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame
      title={entry ? "Edit source" : "Add source"}
      onClose={onClose}
      embedded={embedded}
    >
      <p>Save source information and searchable text in this workspace.</p>
      {!id && <p role="alert">Choose a workspace before adding a source.</p>}
      <label>
        Source type
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
      </label>
      <label>
        Title
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={256}
        />
      </label>
      <label>
        Source URL
        <Input
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {type === "reference" && (
        <>
          <label>
            Authors separated by semicolons
            <Input
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
            />
          </label>
          <label>
            Year
            <Input
              type="number"
              step="1"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !url.trim()}
            onClick={() => void lookupMetadata()}
          >
            Look up metadata
          </Button>
          {lookup && (
            <Surface className="key-metadata-proposal">
              <h3>Review retrieved metadata</h3>
              <strong>{lookup.title}</strong>
              <p>
                {lookup.authors?.join("; ")} · {lookup.year ?? "Year unknown"}
              </p>
              <p>{lookup.abstractText?.slice(0, 1000)}</p>
              <small>Source: {lookup.source}</small>
              <Button
                onClick={() => {
                  if (lookup.title) setTitle(lookup.title);
                  if (lookup.authors?.length)
                    setAuthors(lookup.authors.join("; "));
                  if (lookup.year) setYear(String(lookup.year));
                  if (!content && lookup.abstractText)
                    setContent(lookup.abstractText);
                }}
              >
                Use reviewed metadata
              </Button>
            </Surface>
          )}
          {(lookup?.fullTextUrl || loaded?.properties.fullTextUrl) && (
            <Button
              disabled={busy || !entry?.id}
              onClick={() => {
                setBusy(true);
                void invoke(
                  "library_download_pdf",
                  {
                    url: lookup?.fullTextUrl ?? loaded?.properties.fullTextUrl,
                    entryId: entry?.id,
                  },
                  id,
                )
                  .then(async (info: any) => {
                    if (!loaded)
                      throw Error("Reload the reference to link this PDF");
                    const saved = await invoke<SourceEntry>(
                      "workspace_save_entry",
                      {
                        id: loaded.id,
                        sourceType: loaded.properties.sourceType,
                        title: loaded.title,
                        url: loaded.properties.url ?? "",
                        content: loaded.body,
                        properties: {
                          ...loaded.properties,
                          pdfHash: info.hash,
                        },
                        expectedRevision: loaded.revision,
                      },
                      id,
                    );
                    setLoaded(saved);
                    onSaved();
                    setNotice("PDF added and linked to this reference");
                    await (window as any).key.openSource({
                      ...info,
                      documentHash: info.hash,
                      workspaceId: id,
                    });
                  })
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              Get open-access PDF{!entry?.id ? " (save reference first)" : ""}
            </Button>
          )}
        </>
      )}
      <label>
        {type === "note" ? "Note" : "Supplied text or description"}
        <Textarea
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <p style={{ fontSize: 12 }}>
        URLs are saved without downloading pages. Media transcription, image
        recognition and automatic reference enrichment are not run. Text you
        provide is indexed for search.
      </p>
      <details>
        <summary>Custom properties</summary>
        {Object.entries(extras).map(([name, value]) => (
          <div key={name} style={{ display: "flex", gap: 8 }}>
            <span>
              {name}:{" "}
              {typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
            </span>
            <Button
              onClick={() =>
                setExtras((old) =>
                  Object.fromEntries(
                    Object.entries(old).filter(([key]) => key !== name),
                  ),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <label>
          Property name
          <Input
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
            maxLength={128}
          />
        </label>
        <label>
          Type
          <Select
            value={propertyType}
            onChange={(e) => setPropertyType(e.target.value)}
          >
            <option>text</option>
            <option>number</option>
            <option>boolean</option>
          </Select>
        </label>
        <label>
          Value
          <Input
            value={propertyValue}
            onChange={(e) => setPropertyValue(e.target.value)}
            maxLength={4096}
          />
        </label>
        <Button
          onClick={() => {
            const name = propertyName.trim();
            if (
              !name ||
              reservedEntryProperties.has(name) ||
              Object.keys(extras).length >= 64
            ) {
              setError(
                "Choose a custom property name; up to 64 properties are supported",
              );
              return;
            }
            if (
              (propertyType === "number" &&
                (!propertyValue.trim() ||
                  !Number.isFinite(Number(propertyValue)))) ||
              (propertyType === "boolean" &&
                !["true", "false"].includes(propertyValue))
            ) {
              setError("Enter a valid typed value");
              return;
            }
            setExtras((old) => ({
              ...old,
              [name]:
                propertyType === "number"
                  ? Number(propertyValue)
                  : propertyType === "boolean"
                    ? propertyValue === "true"
                    : propertyValue,
            }));
            setPropertyName("");
            setPropertyValue("");
          }}
        >
          Add or update property
        </Button>
        <p>Changes are saved with the source.</p>
      </details>
      {notice && <p role="status">{notice}</p>}
      {!entry && (
        <Button
          type="button"
          disabled={!id}
          onClick={() => {
            onClose();
            openBibImport({ workspaceId: id });
          }}
        >
          Import BibTeX, RIS or CSL-JSON…
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <Button
        data-save-record
        disabled={!id || busy || !title.trim() || (!!entry && !loaded)}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save source"}
      </Button>
    </Frame>
  );
}
export function EntriesList({
  invoke,
  workspaceId,
  projectId,
  onOpen,
  active = true,
  refreshKey = 0,
}: {
  invoke: Invoke;
  workspaceId?: string;
  projectId?: string;
  onOpen?: (entry: SourceEntry) => void;
  active?: boolean;
  refreshKey?: number;
}) {
  const request = useRef(0);
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [editing, setEditing] = useState<SourceEntry>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  async function load(offset = 0) {
    const seq = ++request.current;
    setBusy(true);
    try {
      const p = await invoke<{
        entries: SourceEntry[];
        total: number;
        nextOffset: number | null;
      }>(
        "workspace_entries",
        { projectId: projectId ?? null, query: submitted, offset, limit: 50 },
        workspaceId,
      );
      if (seq !== request.current) return;
      setEntries((old) => (offset ? [...old, ...p.entries] : p.entries));
      setNext(p.nextOffset);
      setTotal(p.total);
      setError("");
    } catch (e) {
      if (seq === request.current) setError(String(e));
    } finally {
      if (seq === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => setSubmitted(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      request.current++;
    };
  }, [workspaceId, projectId, submitted, revision, active, refreshKey]);
  const refresh = () => setRevision((r) => r + 1);
  return (
    <section aria-label="Other sources">
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2>
          Other sources <small>{total}</small>
        </h2>
        <Button disabled={!workspaceId} onClick={() => setAdding(true)}>
          Add source
        </Button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query);
        }}
      >
        <Input
          aria-label="Search other sources"
          placeholder="Search titles, URLs and supplied text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button>Search</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <table className="key-source-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Content</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.workspaceId}:${e.id}`}>
              <td>
                <Button
                  onClick={() => {
                    if (onOpen) onOpen(e);
                    else setEditing(e);
                  }}
                >
                  {highlight(e.title, submitted)}
                </Button>
              </td>
              <td>{String(e.properties.sourceType)}</td>
              <td>
                {e.properties.contentMode === "user-provided"
                  ? "Supplied text indexed"
                  : "Metadata indexed"}
              </td>
              <td>
                <Button onClick={() => (onOpen ? onOpen(e) : setEditing(e))}>
                  Edit
                </Button>
                {typeof e.properties.url === "string" && e.properties.url && (
                  <Button
                    onClick={() =>
                      void (window as any).key.tabAction("open-url", {
                        url: e.properties.url,
                      })
                    }
                  >
                    Open link ↗
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length && !busy && (
        <p>
          No sources yet. Add links, references, notes or media information.
        </p>
      )}
      {next !== null && (
        <Button disabled={busy} onClick={() => void load(next)}>
          Load more
        </Button>
      )}
      {adding && (
        <AddEntryDialog
          invoke={invoke}
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setAdding(false)}
          onSaved={refresh}
        />
      )}{" "}
      {editing && (
        <EntryDetails
          invoke={invoke}
          workspaceId={editing.workspaceId ?? workspaceId}
          projectId={projectId}
          entry={editing}
          onClose={() => setEditing(undefined)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
/** Fill a property with AI or a rule (FillSheet.tsx) for the given sources. */
export function AgentPropertyDialog({
  invoke,
  workspaceId,
  onClose,
  onSaved,
  hashes = [],
  propertyName = "",
}: Props & { hashes?: string[]; propertyName?: string; embedded?: boolean }) {
  if (!workspaceId) return null;
  return <FillSheet invoke={invoke} workspaceId={workspaceId} targets={hashes} propertyName={propertyName || undefined} onClose={onClose} onSaved={onSaved} />;
}
