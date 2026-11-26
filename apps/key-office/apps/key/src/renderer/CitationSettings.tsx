// Settings › Citations: the style and language every citation, bibliography and quote uses,
// a live preview, and installing or removing CSL styles. Formatting is the host's (cite.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Row } from "./Settings";
import { Icon } from "./icons";
import type { AppSettings, Invoke } from "./library-api";
import { installStyle, listStyles, removeStyle, renderCitations, type StyleList, type StyleSummary } from "./cite";
import "./cite-settings.css";

const FORMAT_LABEL: Record<StyleSummary["format"], string> = {
  "author-date": "Author–date",
  author: "Author",
  numeric: "Numeric",
  label: "Label",
  note: "Notes",
};

/** The sample the preview formats (not in any library). */
const SAMPLE = {
  id: "key-preview",
  kind: "reference",
  itemType: "article",
  title: "Utility of a deep-learning algorithm to guide novices to acquire echocardiograms for limited diagnostic use",
  creators: [
    { family: "Narang", given: "Akhil", role: "author" },
    { family: "Bae", given: "Richard", role: "author" },
    { family: "Hong", given: "Ha", role: "author" },
  ],
  year: 2021,
  containerTitle: "JAMA Cardiology",
  volume: "6",
  issue: "6",
  pages: "624-632",
  doi: "10.1001/jamacardio.2021.0185",
};

export default function CitationSettings({
  invoke,
  workspaceId,
  settings,
  onSettings,
}: {
  invoke: Invoke;
  workspaceId?: string;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [list, setList] = useState<StyleList>();
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{ citation: string; reference: string }>();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const style = settings.citationStyle || "apa";
  const locale = settings.citationLocale || "en-US";

  const loads = useRef(0);
  const load = () => {
    if (!workspaceId) return;
    // Only the latest list counts (an earlier one can arrive after an install's).
    const n = ++loads.current;
    void listStyles(invoke, workspaceId)
      .then((l) => n === loads.current && setList(l))
      .catch((e) => setError(String(e).replace(/^Error: /, "")));
  };
  useEffect(load, [invoke, workspaceId]);

  // The preview follows the choice (asked for explicitly: the settings file may lag behind).
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void renderCitations(invoke, workspaceId, {
      style,
      locale,
      sources: [SAMPLE],
      citations: [{ items: [{ id: SAMPLE.id, locator: "626" }] }],
      bibliography: true,
    })
      .then((out) => live && setPreview({ citation: out.citations[0]?.html ?? "", reference: out.bibliography?.entries[0]?.html ?? "" }))
      .catch(() => live && setPreview(undefined));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, style, locale, list]);

  // Without the shipped styles the host renders with its basic one, whatever was chosen.
  const current = list?.styles.find((s) => s.id === style) ?? (list?.data?.available === false ? list.styles.find((s) => s.id === list.style) : undefined);
  const installed = list?.styles.filter((s) => !s.bundled) ?? [];
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (list?.styles ?? []).filter((s) => {
      const hay = `${s.title} ${s.shortTitle ?? ""} ${s.id} ${FORMAT_LABEL[s.format]} ${s.fields.join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [list, query]);

  const choose = (id: string) => {
    onSettings({ citationStyle: id });
    setPicking(false);
    setQuery("");
  };
  const install = async (from: { xml: string } | { url: string }, label: string) => {
    setBusy(label);
    setError("");
    try {
      const added = await installStyle(invoke, workspaceId, from);
      load();
      setAddress("");
      onSettings({ citationStyle: added.id });
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy("");
    }
  };

  if (!workspaceId) {
    return (
      <Group title="Citation style">
        <Row label="Open a library first" detail="Citations are formatted by a library's engine." />
      </Group>
    );
  }
  const missing = list?.data && !list.data.available ? list.data : undefined;
  return (
    <>
      {missing && (
        <Group title="Citation data">
          <div className="kx-settings-row kx-cite-missing" role="alert">
            <Icon name="warning" size={16} />
            <div>
              <span>Citation styles not found</span>
              <small>
                Key’s styles and languages are missing{missing.dir ? " from the app’s resources" : ""}, so citations use a basic author–date
                style in English. Reinstall Key to restore them.
              </small>
              {missing.dir && (
                <small className="kx-settings-path" title={missing.dir}>
                  {missing.dir}
                </small>
              )}
            </div>
          </div>
        </Group>
      )}
      <Group title="Citation style" footer="Used for copied references and in-text citations (⌘⇧C, ⌘⇧A), quotes from the reader, notes and bibliographies.">
        <Row label="Style" detail={current ? `${FORMAT_LABEL[current.format]}${current.bundled ? "" : " · installed"}` : undefined}>
          <button className="kx-settings-button kx-cite-current" aria-expanded={picking} aria-label="Citation style" onClick={() => setPicking(!picking)}>
            <span>{current?.title ?? style}</span>
            <Icon name="chevronUpDown" size={10} />
          </button>
        </Row>
        {picking && (
          <div className="kx-settings-row kx-settings-row-wide kx-cite-picker">
            <label className="kx-cite-search">
              <Icon name="search" size={12} />
              <input
                autoFocus
                type="search"
                placeholder={`Search ${list?.styles.length ?? ""} styles`}
                aria-label="Search citation styles"
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setPicking(false);
                  } else if (e.key === "Enter" && shown[0]) choose(shown[0].id);
                }}
              />
            </label>
            <div className="kx-cite-list" role="listbox" aria-label="Citation styles">
              {shown.map((s) => (
                <button key={s.id} role="option" aria-selected={s.id === style} data-style={s.id} onClick={() => choose(s.id)}>
                  <span className="kx-cite-check">{s.id === style && <Icon name="check" size={11} />}</span>
                  <span className="kx-cite-title">{s.title}</span>
                  {!s.bundled && <span className="kx-cite-tag">Installed</span>}
                  <span className="kx-cite-format">{FORMAT_LABEL[s.format]}</span>
                </button>
              ))}
              {!shown.length && <p className="kx-cite-empty">No styles match. Add one from the CSL repository below.</p>}
            </div>
          </div>
        )}
        <Row label="Language" detail="Terms, dates and punctuation (“et al.”, “p.”, month names).">
          <select className="kx-settings-select" aria-label="Citation language" value={locale} onChange={(e) => onSettings({ citationLocale: e.target.value })}>
            {(list?.locales ?? [{ code: locale, name: locale }]).map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </Row>
        <div className="kx-settings-row kx-settings-row-wide kx-cite-preview" aria-label="Citation preview">
          <small>In the text</small>
          <p data-preview="citation" dangerouslySetInnerHTML={{ __html: preview?.citation || "…" }} />
          <small>In the bibliography</small>
          <p data-preview="reference" dangerouslySetInnerHTML={{ __html: preview?.reference || "…" }} />
        </div>
      </Group>
      <Group
        title="Installed styles"
        footer={
          <>
            Any CSL style works: a <code>.csl</code> file, or a style’s id or address from the{" "}
            <a href="https://www.zotero.org/styles" target="_blank" rel="noreferrer">
              style repository
            </a>
            . Styles are shared by every library.
          </>
        }
      >
        {installed.map((s) => (
          <Row key={s.id} label={s.title} detail={s.parent ? `${FORMAT_LABEL[s.format]} · based on ${s.parent}` : FORMAT_LABEL[s.format]}>
            <button
              className="kx-settings-button"
              aria-label={`Remove ${s.title}`}
              onClick={() =>
                void removeStyle(invoke, workspaceId, s.id).then(() => {
                  if (style === s.id) onSettings({ citationStyle: "apa" });
                  load();
                })
              }
            >
              Remove
            </button>
          </Row>
        ))}
        <Row label="From the style repository" detail="A style id such as “apa-no-ampersand”, or its zotero.org/styles address.">
          <input
            className="kx-settings-select"
            aria-label="Style id or address"
            placeholder="Style id or address"
            value={address}
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && address.trim() && void install({ url: address.trim() }, "repository")}
          />
          <button className="kx-settings-button" disabled={!address.trim() || !!busy} onClick={() => void install({ url: address.trim() }, "repository")}>
            {busy === "repository" ? "Adding…" : "Add"}
          </button>
        </Row>
        <div className="kx-settings-row kx-settings-row-action">
          <button className="kx-settings-link" disabled={!!busy} onClick={() => file.current?.click()}>
            <Icon name="plus" size={11} />
            {busy === "file" ? "Installing…" : "Install style file…"}
          </button>
          <input
            ref={file}
            type="file"
            accept=".csl,.xml,application/xml,text/xml"
            hidden
            aria-label="Style file"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = "";
              if (chosen) void chosen.text().then((xml) => install({ xml }, "file"));
            }}
          />
        </div>
      </Group>
      {error && (
        <p className="kx-settings-footnote kx-cite-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
