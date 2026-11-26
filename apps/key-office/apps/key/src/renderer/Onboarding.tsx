// First-run welcome: four short steps (welcome, the library, Zotero, appearance), each with
// one primary action and a drawing of the app beside it. Every step can be skipped; nothing
// here is needed to start working. Styles in onboarding.css.
import { useState, type ReactNode } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { bridge, type AppInfo, type Invoke, type Theme, type WorkspaceSummary } from "./library-api";
import { ThemePicker } from "./Settings";
import { WORKSPACE_COLORS } from "./WorkspaceSwitcher";
import "./onboarding.css";
import "./models.css";

const STEPS = ["welcome", "library", "sources", "appearance"] as const;
type Step = (typeof STEPS)[number];

export default function Onboarding({
  invoke,
  workspaces,
  info,
  theme,
  onTheme,
  autoDownload = true,
  onAutoDownload,
  onFinish,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** Download on-device models when first needed (Settings › Search & indexing). */
  autoDownload?: boolean;
  onAutoDownload?: (value: boolean) => void;
  /** Called with the library to open, if any. */
  onFinish: (workspaceId?: string) => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [library, setLibrary] = useState<WorkspaceSummary | undefined>(workspaces[0]);
  const [imported, setImported] = useState<string>();
  const [importing, setImporting] = useState<"zotero" | "files">();
  const [error, setError] = useState("");
  const index = STEPS.indexOf(step);
  const last = index === STEPS.length - 1;
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]);
  const back = () => setStep(STEPS[Math.max(0, index - 1)]);
  const finish = () => onFinish(library?.id);
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
  const color = library?.color || WORKSPACE_COLORS[0];
  const setColor = (next: string) => {
    if (!library) return;
    setLibrary({ ...library, color: next });
    void invoke("workspace_set_appearance", { icon: library.icon ?? "", color: next }, library.id).catch(() => {});
  };
  const run = async (kind: "zotero" | "files", work: () => Promise<void>) => {
    setImporting(kind);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
    } finally {
      setImporting(undefined);
    }
  };

  return (
    <GlobalDrawer presentation="window" label="Welcome to Key" onClose={finish}>
      <div className="kx-onboarding" data-step={step} data-modal-view={step}>
        <div className="kx-onboarding-copy" key={step}>
          {step === "welcome" && (
            <Copy eyebrow="Welcome" title="Welcome to Key" lead="Collect, read and search your research in one calm place.">
              <ul className="kx-onboarding-points">
                <Point icon="layers">PDFs, references, web pages and notes in one library</Point>
                <Point icon="search">Search by words or by meaning, down to the passage</Point>
                <Point icon="lock">Everything runs and stays on this Mac</Point>
              </ul>
              <label className="kx-onboarding-models">
                <div>
                  <strong>Download on-device models when needed</strong>
                  <small>Search and PDF layout models (about 400 MB) come from Hugging Face the first time Key needs them, then stay on this Mac.</small>
                </div>
                <input type="checkbox" className="kx-switch" aria-label="Download on-device models when needed" checked={autoDownload} onChange={(e) => onAutoDownload?.(e.target.checked)} />
              </label>
            </Copy>
          )}
          {step === "library" && (
            <Copy eyebrow="Library" title="Your library" lead="A folder on this Mac. Files you add stay where they are.">
              {library && (
                <div className="kx-onboarding-card">
                  <span className="kx-onboarding-swatch" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                    {library.icon || <Icon name="books" size={15} />}
                  </span>
                  <div>
                    <strong>{library.name}</strong>
                    <small title={library.root}>{home(library.root)}</small>
                  </div>
                  <button
                    className="kx-settings-button"
                    onClick={async () => {
                      const added = await bridge().addWorkspace();
                      if (added) setLibrary(added);
                    }}
                  >
                    Change…
                  </button>
                </div>
              )}
              {library && (
                <div className="kx-onboarding-colors" role="radiogroup" aria-label="Library colour">
                  {WORKSPACE_COLORS.map((c) => (
                    <button key={c} role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} style={{ background: c }} onClick={() => setColor(c)} />
                  ))}
                </div>
              )}
            </Copy>
          )}
          {step === "sources" && (
            <Copy eyebrow="Sources" title="Bring in your sources" lead="Start from what you have, or begin empty and add later.">
              <div className="kx-onboarding-choices">
                <Choice
                  icon="zotero"
                  title="Import from Zotero"
                  detail={info.zoteroFound ? "Items, collections, notes and PDFs. Zotero is not changed." : "No Zotero library found on this Mac."}
                  busy={importing === "zotero"}
                  disabled={!info.zoteroFound || !!importing}
                  onClick={() =>
                    run("zotero", async () => {
                      const { workspace, report } = await bridge().importZotero();
                      setLibrary(workspace as WorkspaceSummary);
                      setImported(`${report.items?.toLocaleString() ?? "Your"} items imported into ${workspace.name}`);
                    })
                  }
                />
                <Choice
                  icon="doc"
                  title="Add files"
                  detail="PDFs, web pages, text, audio and images."
                  busy={importing === "files"}
                  disabled={!library || !!importing}
                  onClick={() =>
                    run("files", async () => {
                      if (!library) return;
                      const created = await bridge().addFiles(library.id);
                      if (created.length) setImported(`${created.length} ${created.length === 1 ? "source" : "sources"} added to ${library.name}`);
                    })
                  }
                />
              </div>
              {imported && (
                <p className="kx-onboarding-done" role="status">
                  <Icon name="check" size={12} /> {imported}
                </p>
              )}
              {error && <p className="kx-inline-error">{error}</p>}
              {info.zoteroFound && !imported && <p className="kx-onboarding-note">Keep it in sync with Zotero later, in Settings.</p>}
            </Copy>
          )}
          {step === "appearance" && (
            <Copy eyebrow="Appearance" title="Choose a look" lead="Change it any time in Settings.">
              <ThemePicker value={theme} onChange={onTheme} />
            </Copy>
          )}
        </div>
        <div className="kx-onboarding-visual" aria-hidden="true">
          {step === "sources" ? <ImportArt zotero={info.zoteroFound} /> : <AppArt step={step} name={library?.name ?? "Personal"} color={color} icon={library?.icon ?? undefined} />}
        </div>
        <footer className="kx-onboarding-footer">
          <div className="kx-onboarding-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <span key={s} data-active={i === index} data-done={i < index} />
            ))}
          </div>
          <div className="kx-onboarding-actions">
            {!last && (
              <button className="kx-onboarding-skip" onClick={finish}>
                Skip
              </button>
            )}
            {index > 0 && (
              <button className="kx-settings-button" onClick={back}>
                Back
              </button>
            )}
            <button className="kx-button-primary" autoFocus disabled={!!importing} onClick={last ? finish : next}>
              {step === "welcome" ? "Get started" : last ? "Start using Key" : "Continue"}
            </button>
          </div>
        </footer>
      </div>
    </GlobalDrawer>
  );
}

function Copy({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: string; children?: ReactNode }) {
  return (
    <>
      <span className="kx-onboarding-eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p className="kx-onboarding-lead">{lead}</p>
      <div className="kx-onboarding-content">{children}</div>
    </>
  );
}
function Point({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li>
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </li>
  );
}
function Choice({ icon, title, detail, busy, disabled, onClick }: { icon: IconName; title: string; detail: string; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="kx-onboarding-choice" disabled={disabled} onClick={onClick}>
      <span>
        <Icon name={icon} size={16} />
      </span>
      <div>
        <strong>{busy ? "Working…" : title}</strong>
        <small>{detail}</small>
      </div>
      {busy ? <span className="kx-onboarding-spinner" /> : <Icon name="chevronRight" size={11} />}
    </button>
  );
}

/** A small drawing of Key's window: the sidebar with the library, and search results. It is
 *  drawn with the app's own tokens, so it follows the appearance chosen beside it. */
function AppArt({ step, name, color, icon }: { step: Step; name: string; color: string; icon?: string }) {
  const rows: [string, string, string][] = [
    ["Sleep and memory consolidation", "…replay during slow-wave sleep ", "strengthens recent memories"],
    ["Hippocampal replay in rodents", "…sequences that ", "strengthen recent memories"],
    ["Napping and recall in adults", "…a short nap ", "improves recall the next day"],
  ];
  return (
    <div className="kx-art-window" data-step={step}>
      <div className="kx-art-sidebar">
        <div className="kx-art-lights">
          <i />
          <i />
          <i />
        </div>
        <div className="kx-art-library">
          <span style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>{icon || <Icon name="books" size={10} />}</span>
          <b>{name}</b>
        </div>
        <div className="kx-art-nav" data-active>
          <Icon name="books" size={10} /> Sources
        </div>
        <div className="kx-art-nav">
          <Icon name="note" size={10} /> Notes
        </div>
        <div className="kx-art-nav">
          <Icon name="quote" size={10} /> Highlights
        </div>
        <div className="kx-art-nav">
          <Icon name="tag" size={10} /> Tags
        </div>
      </div>
      <div className="kx-art-main">
        <div className="kx-art-search">
          <Icon name="search" size={10} />
          <span>how does sleep help memory</span>
        </div>
        {rows.map(([title, before, hit]) => (
          <div className="kx-art-row" key={title}>
            <span className="kx-art-doc">
              <Icon name="doc" size={10} />
            </span>
            <div>
              <b>{title}</b>
              <span>
                {before}
                <mark>{hit}</mark>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Zotero's library coming across into Key. */
function ImportArt({ zotero }: { zotero: boolean }) {
  return (
    <div className="kx-art-import">
      <div className="kx-art-app" data-app="zotero">
        <span>
          <Icon name={zotero ? "zotero" : "folder"} size={22} />
        </span>
        <b>{zotero ? "Zotero" : "Files"}</b>
        <i />
        <i />
        <i />
      </div>
      <div className="kx-art-flow">
        <span />
        <span />
        <span />
        <Icon name="arrowRight" size={14} />
      </div>
      <div className="kx-art-app" data-app="key">
        <span>
          <Icon name="books" size={22} />
        </span>
        <b>Key</b>
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
