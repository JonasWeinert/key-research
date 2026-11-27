// Web search engines in search results (the popup's Web pill and the Search tab): which engine
// answered, which failed before it, and a menu to ask a particular engine for this query.
// The engines, their order and fallback are set in Key Settings › Web & browser › Web search
// engines (WebSearchSettings.tsx); the host's "web" chain asks them (web_search/mod.rs).
import { useRef, useState } from "react";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "./icons";
import { CHAIN_ID, type WebSearchState } from "./web-search";
import "./web-engines.css";

const labelOf = (web: WebSearchState, id?: string) => (id ? (web.infos.find((p) => p.id === id)?.label ?? id) : undefined);

/** "via Tavily ▾": who answered, and the engine to ask for this query. */
export function EnginePicker({ web }: { web: WebSearchState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, { refs: [ref], anchor: ref, onDismiss: () => setOpen(false) });
  const chain = web.providers.find((p) => p.info.id === CHAIN_ID);
  if (!chain || !web.engines.length) return null;
  const answered = labelOf(web, chain.answeredBy);
  const failed = chain.failed ?? [];
  const title = failed.length ? failed.map((f) => f.message).join("\n") : undefined;
  const pick = (id?: string) => {
    setOpen(false);
    web.pickEngine(id);
  };
  return (
    <div className="kx-menu kx-engine-picker" ref={ref}>
      <button
        type="button"
        className="kx-engine-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Web search engine for this search"
        title={title}
        data-fallback={failed.length ? true : undefined}
        onClick={() => setOpen(!open)}
      >
        {failed.length > 0 && <Icon name="warning" size={10} />}
        <span>{chain.status === "loading" ? `Asking ${labelOf(web, web.engine) ?? web.engines[0].label}…` : answered ? `via ${answered}` : web.engine ? labelOf(web, web.engine) : "Web engines"}</span>
        <Icon name="chevronDown" size={9} />
      </button>
      {open && (
        <div className="kx-menu-popover kx-engine-menu" role="menu" aria-label="Ask this engine">
          <p className="kx-menu-hint">Ask this engine</p>
          <button type="button" role="menuitemradio" aria-checked={!web.engine} onClick={() => pick(undefined)}>
            <span className="kx-engine-check">{!web.engine && <Icon name="check" size={11} />}</span>
            <span>In Settings’ order</span>
          </button>
          {web.engines.map((e) => (
            <button key={e.id} type="button" role="menuitemradio" aria-checked={web.engine === e.id} onClick={() => pick(e.id)}>
              <span className="kx-engine-check">{web.engine === e.id && <Icon name="check" size={11} />}</span>
              <span>{e.label}</span>
            </button>
          ))}
          {failed.length > 0 && (
            <p className="kx-menu-hint kx-engine-failed">
              {failed.map((f) => f.message).join(" · ")}
              {answered ? ` · ${answered} answered instead.` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
