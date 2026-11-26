// "How each database will run this": for every chosen database the query in its own syntax
// (copyable; an expert can replace it, marked Customised, with Reset), what it cannot express,
// and how many works it would find, in all and per concept. Counts are asked a moment after
// typing stops, and the previous request is cancelled, so typing never waits on the network.
import { useEffect, useRef, useState } from "react";
import { cleanQuery, newId, queryKey } from "./db-query";
import type { DbConnector, DbQuery, DbSearchApi, Estimate, Translation } from "./db-search-api";
import { CopyButton, countText } from "./db-ui";
import { Explain } from "./explain";
import { Icon } from "./icons";
import { openWebLink } from "./web-search";

export interface QueryPreview {
  translations: Record<string, Translation>;
  estimates: Record<string, Estimate>;
  /** Counts are on their way. */
  counting: boolean;
  error?: string;
}

/** Translations at once (they are local), counts after a pause; both follow the query. */
export function useQueryPreview(api: DbSearchApi | undefined, query: DbQuery, connectors: string[], overrides: Record<string, string>, delay = 600): QueryPreview {
  const [translations, setTranslations] = useState<Record<string, Translation>>({});
  const [estimates, setEstimates] = useState<Record<string, Estimate>>({});
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState<string>();
  const key = queryKey(query);
  const ids = connectors.join();
  const overridesKey = JSON.stringify(overrides);
  const request = useRef<string>(undefined);
  useEffect(() => {
    if (!api || !connectors.length) return setTranslations({});
    let live = true;
    const timer = setTimeout(() => {
      void api.translate(cleanQuery(query), connectors, overrides).then(
        (list) => live && (setTranslations(Object.fromEntries(list.map((t) => [t.connector, t]))), setError(undefined)),
        (e) => live && setError(String((e as Error)?.message ?? e)),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, ids, overridesKey]);
  useEffect(() => {
    if (!api || !connectors.length || !cleanQuery(query).concepts.length) {
      setEstimates({});
      setCounting(false);
      return;
    }
    setCounting(true);
    let live = true;
    const timer = setTimeout(() => {
      if (request.current) void api.cancelEstimate(request.current);
      const id = newId("est");
      request.current = id;
      void api
        .estimate(cleanQuery(query), connectors, id)
        .then(
          (list) => live && setEstimates(Object.fromEntries(list.map((e) => [e.connector, e]))),
          () => {},
        )
        .finally(() => {
          if (live && request.current === id) setCounting(false);
        });
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, ids]);
  useEffect(
    () => () => {
      if (request.current && api) void api.cancelEstimate(request.current);
    },
    [api],
  );
  return { translations, estimates, counting, error };
}

export function TranslationsPanel({
  connectors,
  query,
  preview,
  overrides,
  onOverride,
  onReportProblem,
}: {
  connectors: DbConnector[];
  query: DbQuery;
  preview: QueryPreview;
  overrides: Record<string, string>;
  onOverride: (connector: string, native: string | undefined) => void;
  onReportProblem?: (connector: DbConnector) => void;
}) {
  const concepts = cleanQuery(query).concepts;
  const total = connectors.reduce((sum, c) => sum + (preview.estimates[c.id]?.total ?? 0), 0);
  return (
    <section className="kx-db-how" aria-label="How each database will run this">
      <header className="kx-db-how-head">
        <h2>How each database will run this</h2>
        <Explain help="dbsearch.translation" />
        <span className="kx-spacer" />
        {preview.counting ? (
          <span className="kx-db-counting" role="status">
            <span className="kx-spinner" aria-hidden="true" /> Counting…
          </span>
        ) : (
          total > 0 && <span className="kx-db-how-total" title="Before duplicates between databases are removed">{countText(total)} in all</span>
        )}
      </header>
      {!connectors.length && <p className="kx-db-muted">Choose one or more databases to see how each would run the query.</p>}
      {preview.error && <p className="kx-inline-error">{preview.error}</p>}
      <ul className="kx-db-how-list">
        {connectors.map((c) => (
          <ConnectorTranslation
            key={c.id}
            connector={c}
            translation={preview.translations[c.id]}
            estimate={preview.estimates[c.id]}
            counting={preview.counting}
            conceptNames={concepts.map((k, i) => k.label || `Concept ${i + 1}`)}
            override={overrides[c.id]}
            onOverride={(native) => onOverride(c.id, native)}
            onReportProblem={onReportProblem && (() => onReportProblem(c))}
          />
        ))}
      </ul>
    </section>
  );
}

function ConnectorTranslation({
  connector: c,
  translation,
  estimate,
  counting,
  conceptNames,
  override,
  onOverride,
  onReportProblem,
}: {
  connector: DbConnector;
  translation?: Translation;
  estimate?: Estimate;
  counting: boolean;
  conceptNames: string[];
  override?: string;
  onOverride: (native: string | undefined) => void;
  onReportProblem?: () => void;
}) {
  const [editing, setEditing] = useState<string>();
  const native = override ?? translation?.native ?? "";
  const per = estimate?.perConcept ?? [];
  const known = per.filter((n): n is number => typeof n === "number");
  const narrowest = known.length > 1 ? per.indexOf(Math.min(...known)) : -1;
  const blocked = c.needsKey && !c.hasKey;
  const tooLong = translation?.maxLength !== undefined && native.length > translation.maxLength;
  return (
    <li className="kx-db-how-item" data-connector={c.id} data-manual={c.manual || undefined}>
      <div className="kx-db-how-row">
        <span className="kx-db-how-name">{c.name}</span>
        {override !== undefined && (
          <span className="kx-db-badge" data-tone="accent" title="You replaced Key's translation for this database">
            Customised
          </span>
        )}
        {c.manual && <span className="kx-db-badge" title="No API: Key opens its search with this query">Manual</span>}
        <span className="kx-spacer" />
        <span className="kx-db-how-count" data-stale={counting || undefined} aria-label={`Estimated works in ${c.name}`}>
          {blocked ? "Needs a key" : c.manual ? "Opens in browser" : estimate?.error ? "No count" : estimate ? countText(estimate.total, estimate.exact) : counting ? "…" : "—"}
        </span>
      </div>
      {per.length > 1 && !blocked && (
        <div className="kx-db-how-concepts" aria-label="Each concept alone">
          {per.map((n, i) => (
            <span key={i} data-narrowest={i === narrowest || undefined} title={i === narrowest ? "The narrowest concept: it limits the search most. Add synonyms here to find more." : undefined}>
              {conceptNames[i] ?? `Concept ${i + 1}`} <b>{countText(n, estimate?.exact)}</b>
            </span>
          ))}
        </div>
      )}
      {editing !== undefined ? (
        <div className="kx-db-how-edit">
          <textarea aria-label={`${c.name} query`} value={editing} spellCheck={false} autoFocus rows={Math.min(10, Math.max(3, Math.ceil(editing.length / 60)))} onChange={(e) => setEditing(e.target.value)} />
          <div className="kx-db-how-actions">
            <span className="kx-db-muted">Sent exactly as written; the blocks no longer change it.</span>
            <span className="kx-spacer" />
            <button type="button" className="kx-page-action" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
            <button type="button" className="kx-page-action kx-page-action-primary" onClick={() => (onOverride(editing.trim() ? editing : undefined), setEditing(undefined))}>
              Use this query
            </button>
          </div>
        </div>
      ) : (
        <div className="kx-db-how-native">
          <code className="kx-db-native" data-empty={!native || undefined}>
            {native || "Add terms to see the query"}
          </code>
          <div className="kx-db-how-tools">
            {native && <CopyButton text={native} label={`Copy the ${c.name} query`} />}
            <button type="button" className="kx-db-icon-button" aria-label={`Edit the ${c.name} query`} title="Edit this database's query by hand" disabled={!native} onClick={() => setEditing(native)}>
              <Icon name="pen" size={12} />
            </button>
            {override !== undefined && (
              <button type="button" className="kx-db-icon-button" aria-label="Reset to Key's translation" title="Reset to Key's translation" onClick={() => onOverride(undefined)}>
                <Icon name="undo" size={12} />
              </button>
            )}
            {c.manual && c.manualInfo?.url && (
              <button type="button" className="kx-db-icon-button" aria-label={`Open ${c.name}`} title={`Copy the query and open ${c.name}'s search`} onClick={() => (void navigator.clipboard.writeText(native), openWebLink(c.manualInfo!.url))}>
                <Icon name="external" size={12} />
              </button>
            )}
          </div>
        </div>
      )}
      {(translation?.warnings.length || tooLong || estimate?.error || c.health.state === "failing" || c.health.state === "outdated") && (
        <ul className="kx-db-warnings">
          {tooLong && <li>The query is longer than {c.name} accepts ({translation!.maxLength} characters): Key sends it in parts.</li>}
          {override === undefined && translation?.warnings.map((w) => <li key={w}>{w}</li>)}
          {estimate?.error && !blocked && !c.manual && <li>{estimate.error}</li>}
          {(c.health.state === "failing" || c.health.state === "outdated") && (
            <li>
              {c.health.state === "outdated" ? `${c.name} may have changed since Key's connector was written.` : `${c.name} failed the last ${c.health.failures} times.`}{" "}
              {onReportProblem && (
                <button type="button" className="kx-db-link" onClick={onReportProblem}>
                  Report problem
                </button>
              )}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
